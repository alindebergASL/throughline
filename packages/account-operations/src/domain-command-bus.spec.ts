import type {
  RelationshipAuthorityBatchingAuthorizationService,
  TransactionAwareAuthorizationService
} from "@throughline/authorization";
import { ContentInvariantError, ContentRepository } from "@throughline/content";
import type { SecurityContext } from "@throughline/core-types";
import { DomainCommandRepository, type PgPool, type PgPoolClient } from "@throughline/db";
import { WorkGraphRepository } from "@throughline/work-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountOperationsDomainCommandBus, B1AuthorizationError } from "./domain-command-bus.js";
import { B1CommandInvariantError } from "./command-schemas.js";

const tenantId = "70000000-0000-7000-8000-000000000001";
const workspaceId = "70000000-0000-7000-8000-000000000002";
const spaceId = "70000000-0000-7000-8000-000000000003";
const sourceId = "70000000-0000-7000-8000-000000000004";
const activityId = "70000000-0000-7000-8000-000000000005";
const relationshipId = "70000000-0000-7000-8000-000000000006";
const endpointSpaceId = "70000000-0000-7000-8000-000000000010";

describe.sequential("AccountOperationsDomainCommandBus authorization ordering", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reserves Relationship end only after unlocked preauthorization, protected materialization, and global authority locks", async () => {
    const events: string[] = [];
    const { pool } = transactionPool();
    const allowed = {
      allowed: true,
      reasonCode: "test",
      policyVersion: "default-v1"
    } as const;
    const authorization: RelationshipAuthorityBatchingAuthorizationService = {
      can: vi.fn(async () => allowed),
      canInTransaction: vi.fn(async () => allowed),
      preauthorizeRelationshipEndInTransaction: vi.fn(async () => {
        events.push("relationship-preauthorization");
        return allowed;
      }),
      lockAndReauthorizeRelationshipAuthorityInTransaction: vi.fn(async (_context, requests) => {
        events.push("global-authority-lock-and-reauthorization");
        expect(requests).toEqual([
          { action: "relationship.end", resource: { type: "relationship", id: relationshipId } },
          { action: "space.read", resource: { type: "space", id: spaceId } },
          {
            action: "person.read",
            resource: { type: "person", id: "70000000-0000-7000-8000-000000000009" },
            personUseSite: { type: "relationship", id: relationshipId }
          },
          { action: "space.read", resource: { type: "space", id: endpointSpaceId } }
        ]);
        return allowed;
      })
    };
    vi.spyOn(WorkGraphRepository.prototype, "getRelationshipScope").mockImplementation(async () => {
      events.push("relationship-scope");
      return { id: relationshipId, spaceId };
    });
    vi.spyOn(WorkGraphRepository.prototype, "getRelationship").mockImplementation(
      async (_tenantId, _workspaceId, requestedRelationshipId, lock) => {
        expect(requestedRelationshipId).toBe(relationshipId);
        expect(lock).toBe(true);
        events.push("relationship-lock-and-materialization");
        return {
          id: relationshipId,
          tenantId,
          workspaceId,
          spaceId,
          subject: { type: "person", id: "70000000-0000-7000-8000-000000000009" },
          predicate: "account.owner",
          object: { type: "space", id: endpointSpaceId },
          version: 1
        };
      }
    );
    const stop = new Error("ordering proof complete");
    vi.spyOn(DomainCommandRepository.prototype, "reserve").mockImplementation(async () => {
      events.push("command-reservation");
      throw stop;
    });

    const execution = new AccountOperationsDomainCommandBus(pool, authorization).execute(
      {
        kind: "relationship.end",
        idempotencyKey: "relationship-end-order",
        payload: {
          relationshipId,
          expectedVersion: 1,
          validTo: "2026-07-19T19:00:00.000Z"
        }
      },
      context()
    );

    await expect(execution).rejects.toBe(stop);
    expect(events).toEqual([
      "relationship-scope",
      "relationship-preauthorization",
      "relationship-lock-and-materialization",
      "global-authority-lock-and-reauthorization",
      "command-reservation"
    ]);
  });

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

  it.each([
    [
      "correction",
      {
        kind: "source.correct",
        idempotencyKey: "source-correction-oracle",
        payload: {
          predecessorSourceArtifactId: sourceId,
          sourceType: "human",
          text: "Unavailable correction."
        }
      }
    ],
    [
      "tombstone",
      {
        kind: "source.tombstone",
        idempotencyKey: "source-tombstone-oracle",
        payload: {
          sourceArtifactId: sourceId,
          expectedVersion: 1,
          deletionReasonCategory: "retention",
          deletionPolicyRef: "policy:test"
        }
      }
    ]
  ] as const)(
    "returns an identical non-disclosing error and clean rollback for missing and denied %s",
    async (_case, command) => {
      const missing = await unavailableSourceExecution(command, "missing");
      const denied = await unavailableSourceExecution(command, "denied");

      expect(missing.error).toBeInstanceOf(B1AuthorizationError);
      expect(denied.error).toBeInstanceOf(B1AuthorizationError);
      expect({
        constructor: missing.error.constructor,
        name: missing.error.name,
        message: missing.error.message
      }).toEqual({
        constructor: denied.error.constructor,
        name: denied.error.name,
        message: denied.error.message
      });
      expect(missing.error).toMatchObject({
        name: "B1AuthorizationError",
        message: "B1 resource is unavailable"
      });
      for (const execution of [missing, denied]) {
        expect(execution.materializationCalls).toBe(0);
        expect(execution.mutationCalls).toBe(0);
        expect(execution.rolledBack).toBe(true);
        expect(execution.settingsCleared).toBe(true);
        expect(execution.releasedCleanly).toBe(true);
      }
    }
  );

  it("does not normalize a Source scope database failure as an authorization denial", async () => {
    const systemFailure = new Error("database connection failed");
    const { pool, client } = transactionPool();
    vi.spyOn(ContentRepository.prototype, "getSourceScope").mockRejectedValue(systemFailure);

    await expect(
      new AccountOperationsDomainCommandBus(pool, orderedAuthorization([])).execute(
        {
          kind: "source.correct",
          idempotencyKey: "source-scope-system-failure",
          payload: {
            predecessorSourceArtifactId: sourceId,
            sourceType: "human",
            text: "System failure must surface."
          }
        },
        context()
      )
    ).rejects.toBe(systemFailure);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenLastCalledWith(false);
  });

  it.each(["source.correct", "source.tombstone"] as const)(
    "maps only the dedicated lifecycle SQLSTATE and generic message for %s",
    async (kind) => {
      const exact = Object.assign(new Error("Source lifecycle transition is unavailable"), {
        code: "TLB21"
      });
      const { pool } = transactionPool();
      vi.spyOn(ContentRepository.prototype, "getSourceScope").mockResolvedValue({
        id: sourceId,
        spaceId
      });
      if (kind === "source.correct") {
        vi.spyOn(
          ContentRepository.prototype,
          "resolveSourceActivityLinkForCorrection"
        ).mockRejectedValue(exact);
      } else {
        vi.spyOn(ContentRepository.prototype, "lockSource").mockRejectedValue(exact);
      }

      const command =
        kind === "source.correct"
          ? {
              kind,
              idempotencyKey: "exact-lifecycle-correction",
              payload: {
                predecessorSourceArtifactId: sourceId,
                sourceType: "human" as const,
                text: "Rejected correction."
              }
            }
          : {
              kind,
              idempotencyKey: "exact-lifecycle-tombstone",
              payload: {
                sourceArtifactId: sourceId,
                expectedVersion: 1 as const,
                deletionReasonCategory: "retention",
                deletionPolicyRef: "policy:test"
              }
            };

      await expect(
        new AccountOperationsDomainCommandBus(pool, orderedAuthorization([])).execute(
          command,
          context()
        )
      ).rejects.toBeInstanceOf(B1CommandInvariantError);
    }
  );

  it.each([
    Object.assign(new Error("Source lifecycle transition is unavailable"), { code: "P0001" }),
    Object.assign(new Error("Different database failure"), { code: "TLB21" }),
    new Error("Source lifecycle transition is unavailable")
  ])("does not map a partial lifecycle database-error match", async (databaseError) => {
    const { pool } = transactionPool();
    vi.spyOn(ContentRepository.prototype, "getSourceScope").mockResolvedValue({
      id: sourceId,
      spaceId
    });
    vi.spyOn(
      ContentRepository.prototype,
      "resolveSourceActivityLinkForCorrection"
    ).mockRejectedValue(databaseError);

    await expect(
      new AccountOperationsDomainCommandBus(pool, orderedAuthorization([])).execute(
        {
          kind: "source.correct",
          idempotencyKey: "partial-lifecycle-error",
          payload: {
            predecessorSourceArtifactId: sourceId,
            sourceType: "human",
            text: "Database error must surface."
          }
        },
        context()
      )
    ).rejects.toBe(databaseError);
  });
});

async function unavailableSourceExecution(
  command:
    | {
        readonly kind: "source.correct";
        readonly idempotencyKey: string;
        readonly payload: {
          readonly predecessorSourceArtifactId: string;
          readonly sourceType: "human";
          readonly text: string;
        };
      }
    | {
        readonly kind: "source.tombstone";
        readonly idempotencyKey: string;
        readonly payload: {
          readonly sourceArtifactId: string;
          readonly expectedVersion: 1;
          readonly deletionReasonCategory: string;
          readonly deletionPolicyRef: string;
        };
      },
  mode: "missing" | "denied"
): Promise<{
  error: Error;
  materializationCalls: number;
  mutationCalls: number;
  rolledBack: boolean;
  settingsCleared: boolean;
  releasedCleanly: boolean;
}> {
  const { pool, client } = transactionPool();
  vi.spyOn(ContentRepository.prototype, "getSourceScope").mockImplementation(async () => {
    if (mode === "missing") throw new ContentInvariantError("Source is unavailable");
    return { id: sourceId, spaceId };
  });
  const materialization = [
    vi.spyOn(ContentRepository.prototype, "resolveSourceActivityLinkForCorrection"),
    vi.spyOn(ContentRepository.prototype, "lockCurrentSourceForCorrection"),
    vi.spyOn(ContentRepository.prototype, "lockSource"),
    vi.spyOn(WorkGraphRepository.prototype, "lockActivityForSourceCapture")
  ];
  const mutations = [
    vi.spyOn(ContentRepository.prototype, "persistSource"),
    vi.spyOn(ContentRepository.prototype, "tombstoneSource")
  ];
  let error: unknown;
  try {
    await new AccountOperationsDomainCommandBus(
      pool,
      mode === "denied" ? deniedAuthorization([]) : orderedAuthorization([])
    ).execute(command, context());
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error)) throw new Error("Expected Source execution to fail");
  const result = {
    error,
    materializationCalls: materialization.reduce((count, spy) => count + spy.mock.calls.length, 0),
    mutationCalls: mutations.reduce((count, spy) => count + spy.mock.calls.length, 0),
    rolledBack: vi.mocked(client.query).mock.calls.some(([sql]) => sql === "ROLLBACK"),
    settingsCleared: vi
      .mocked(client.query)
      .mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("AS settings_cleared")),
    releasedCleanly: vi.mocked(client.release).mock.calls.at(-1)?.[0] === false
  };
  vi.restoreAllMocks();
  return result;
}

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
    if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED" || sql === "COMMIT" || sql === "ROLLBACK")
      return { rows: [] };
    if (sql.startsWith("SELECT ")) return { rows: [] };
    throw new Error(`Unexpected transaction query: ${sql}`);
  });
  const client = { query, release: vi.fn() } as unknown as PgPoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as PgPool;
  return { pool, client };
}
