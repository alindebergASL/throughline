import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import { ContentRepository } from "@throughline/content";
import type { SecurityContext } from "@throughline/core-types";
import { DomainCommandRepository, type PgPool, type PgPoolClient } from "@throughline/db";
import { WorkGraphRepository } from "@throughline/work-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountOperationsDomainCommandBus } from "./domain-command-bus.js";

const tenantId = "70000000-0000-7000-8000-000000000001";
const workspaceId = "70000000-0000-7000-8000-000000000002";
const spaceId = "70000000-0000-7000-8000-000000000003";
const sourceId = "70000000-0000-7000-8000-000000000004";
const activityId = "70000000-0000-7000-8000-000000000005";

describe.sequential("AccountOperationsDomainCommandBus Source authorization ordering", () => {
  afterEach(() => vi.restoreAllMocks());

  it("authorizes correction read and action before Source links, Activity, or Source state", async () => {
    const events: string[] = [];
    const { pool } = transactionPool();
    const authorization = orderedAuthorization(events);
    vi.spyOn(ContentRepository.prototype, "getSourceScope").mockImplementation(async () => {
      events.push("source-scope");
      return { id: sourceId, spaceId };
    });
    vi.spyOn(
      ContentRepository.prototype,
      "resolveSourceActivityLinkForCorrection"
    ).mockImplementation(async () => {
      events.push("activity-link");
      return { spaceId, activityId };
    });
    vi.spyOn(WorkGraphRepository.prototype, "lockActivityForSourceCapture").mockImplementation(
      async () => {
        events.push("activity-lock-and-projection");
        return { id: activityId, spaceId } as never;
      }
    );
    vi.spyOn(DomainCommandRepository.prototype, "reserve").mockImplementation(async (input) => {
      events.push("command-reservation");
      return { status: "reserved", commandId: input.id };
    });
    vi.spyOn(ContentRepository.prototype, "lockCurrentSourceForCorrection").mockImplementation(
      async () => {
        events.push("source-terminal-lock-and-metadata");
        return sourceProjection();
      }
    );
    vi.spyOn(
      ContentRepository.prototype,
      "revalidateSourceActivityLinkForCorrection"
    ).mockImplementation(async () => {
      events.push("activity-link-revalidation");
    });
    const stop = new Error("ordering proof complete");
    vi.spyOn(WorkGraphRepository.prototype, "getSpace").mockImplementation(async () => {
      events.push("space-materialization");
      throw stop;
    });

    const execution = new AccountOperationsDomainCommandBus(pool, authorization).execute(
      {
        kind: "source.correct",
        idempotencyKey: "source-correction-order",
        payload: {
          predecessorSourceArtifactId: sourceId,
          sourceType: "human",
          text: "Corrected source text."
        }
      },
      context()
    );

    await expect(execution).rejects.toBe(stop);
    expect(events).toEqual([
      "source-scope",
      `authorize:source.read:source:${sourceId}:locked`,
      `authorize:source.correct:source:${sourceId}:locked`,
      "activity-link",
      "activity-lock-and-projection",
      "command-reservation",
      "source-terminal-lock-and-metadata",
      "activity-link-revalidation",
      `authorize:source.read:source:${sourceId}:locked`,
      `authorize:source.correct:source:${sourceId}:locked`,
      "space-materialization"
    ]);
  });

  it("authorizes tombstone read and action before locking or materializing the full Source", async () => {
    const events: string[] = [];
    const { pool } = transactionPool();
    const authorization = orderedAuthorization(events);
    vi.spyOn(ContentRepository.prototype, "getSourceScope").mockImplementation(async () => {
      events.push("source-scope");
      return { id: sourceId, spaceId };
    });
    vi.spyOn(ContentRepository.prototype, "lockSource").mockImplementation(async () => {
      events.push("source-lock-text-chunks-and-metadata");
      return sourceProjection();
    });
    const stop = new Error("ordering proof complete");
    vi.spyOn(DomainCommandRepository.prototype, "reserve").mockImplementation(async () => {
      events.push("command-reservation");
      throw stop;
    });

    const execution = new AccountOperationsDomainCommandBus(pool, authorization).execute(
      {
        kind: "source.tombstone",
        idempotencyKey: "source-tombstone-order",
        payload: {
          sourceArtifactId: sourceId,
          expectedVersion: 1,
          deletionReasonCategory: "retention",
          deletionPolicyRef: "policy:test"
        }
      },
      context()
    );

    await expect(execution).rejects.toBe(stop);
    expect(events).toEqual([
      "source-scope",
      `authorize:source.read:source:${sourceId}:locked`,
      `authorize:source.tombstone:source:${sourceId}:locked`,
      "source-lock-text-chunks-and-metadata",
      `authorize:source.read:source:${sourceId}:locked`,
      `authorize:source.tombstone:source:${sourceId}:locked`,
      "command-reservation"
    ]);
  });

  it("denies correction before Source links, Activity, or Source state and rolls back cleanly", async () => {
    const events: string[] = [];
    const { pool, client } = transactionPool();
    vi.spyOn(ContentRepository.prototype, "getSourceScope").mockImplementation(async () => {
      events.push("source-scope");
      return { id: sourceId, spaceId };
    });
    const activityLink = vi.spyOn(
      ContentRepository.prototype,
      "resolveSourceActivityLinkForCorrection"
    );
    const activityLock = vi.spyOn(WorkGraphRepository.prototype, "lockActivityForSourceCapture");
    const sourceLock = vi.spyOn(ContentRepository.prototype, "lockCurrentSourceForCorrection");

    await expect(
      new AccountOperationsDomainCommandBus(pool, deniedAuthorization(events)).execute(
        {
          kind: "source.correct",
          idempotencyKey: "source-correction-denied-before-materialization",
          payload: {
            predecessorSourceArtifactId: sourceId,
            sourceType: "human",
            text: "Denied correction."
          }
        },
        context()
      )
    ).rejects.toMatchObject({
      name: "B1AuthorizationError",
      message: "B1 resource is unavailable"
    });

    expect(events).toEqual([
      "source-scope",
      `authorize:source.read:source:${sourceId}:locked:denied`
    ]);
    expect(activityLink).not.toHaveBeenCalled();
    expect(activityLock).not.toHaveBeenCalled();
    expect(sourceLock).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("AS settings_cleared"));
    expect(client.release).toHaveBeenLastCalledWith(false);
  });

  it("denies tombstone before full Source materialization and rolls back cleanly", async () => {
    const events: string[] = [];
    const { pool, client } = transactionPool();
    vi.spyOn(ContentRepository.prototype, "getSourceScope").mockImplementation(async () => {
      events.push("source-scope");
      return { id: sourceId, spaceId };
    });
    const sourceLock = vi.spyOn(ContentRepository.prototype, "lockSource");

    await expect(
      new AccountOperationsDomainCommandBus(pool, deniedAuthorization(events)).execute(
        {
          kind: "source.tombstone",
          idempotencyKey: "source-tombstone-denied-before-materialization",
          payload: {
            sourceArtifactId: sourceId,
            expectedVersion: 1,
            deletionReasonCategory: "retention",
            deletionPolicyRef: "policy:test"
          }
        },
        context()
      )
    ).rejects.toMatchObject({
      name: "B1AuthorizationError",
      message: "B1 resource is unavailable"
    });

    expect(events).toEqual([
      "source-scope",
      `authorize:source.read:source:${sourceId}:locked:denied`
    ]);
    expect(sourceLock).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("AS settings_cleared"));
    expect(client.release).toHaveBeenLastCalledWith(false);
  });
});

function context(): SecurityContext {
  return {
    requestId: "source-command-order",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    tenantId,
    workspaceId,
    actorUserId: "70000000-0000-7000-8000-000000000007",
    actorMembershipId: "70000000-0000-7000-8000-000000000008",
    actorDisplayPersonId: "70000000-0000-7000-8000-000000000009",
    requestedSpaceIds: [spaceId],
    membershipIds: ["70000000-0000-7000-8000-000000000008"],
    roleHints: ["owner"],
    dataClassCeiling: "confidential",
    policyVersion: "default-v1",
    issuedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2099-07-17T00:00:00.000Z"
  };
}

function sourceProjection() {
  return {
    id: sourceId,
    tenantId,
    workspaceId,
    spaceId,
    sourceType: "human" as const,
    trustClass: "untrusted_user_content" as const,
    hashRetentionPolicy: "retain" as const,
    accessClass: "restricted" as const,
    version: 1,
    chunks: []
  };
}

function orderedAuthorization(events: string[]): TransactionAwareAuthorizationService {
  return {
    can: vi.fn(async () => ({
      allowed: true,
      reasonCode: "test",
      policyVersion: "default-v1"
    })),
    canInTransaction: vi.fn(async (_context, action, resource, _tx, options) => {
      events.push(
        `authorize:${action}:${resource.type}:${resource.id}:${options?.lockAuthority === true ? "locked" : "unlocked"}`
      );
      return {
        allowed: true,
        reasonCode: "test",
        policyVersion: "default-v1"
      };
    })
  };
}

function deniedAuthorization(events: string[]): TransactionAwareAuthorizationService {
  return {
    can: vi.fn(async () => ({
      allowed: false,
      reasonCode: "b1_resource_not_available",
      policyVersion: "default-v1"
    })),
    canInTransaction: vi.fn(async (_context, action, resource, _tx, options) => {
      events.push(
        `authorize:${action}:${resource.type}:${resource.id}:${options?.lockAuthority === true ? "locked" : "unlocked"}:denied`
      );
      return {
        allowed: false,
        reasonCode: "b1_resource_not_available",
        policyVersion: "default-v1"
      };
    })
  };
}

function transactionPool(): { pool: PgPool; client: PgPoolClient } {
  const query = vi.fn(async (sql: string) => {
    if (sql === "SELECT current_user AS current_user") {
      return { rows: [{ current_user: "throughline_app" }] };
    }
    if (sql.includes("AS settings_cleared")) return { rows: [{ settings_cleared: true }] };
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.startsWith("SELECT ")) return { rows: [] };
    throw new Error(`Unexpected transaction query: ${sql}`);
  });
  const client = { query, release: vi.fn() } as unknown as PgPoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as PgPool;
  return { pool, client };
}
