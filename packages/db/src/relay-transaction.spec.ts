import type { AuthorizationDecision, SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgPool, PgPoolClient } from "./client.js";
import {
  FOUNDATION_OUTBOX_AGGREGATE_TYPE,
  FOUNDATION_OUTBOX_EVENT_TYPE,
  RelayOutboxRepository,
  type DeepReadonly,
  type RelayPublicationRequest
} from "./relay-transaction.js";

const context = (): SecurityContext => ({
  ...createDevSecurityContext("tenant-a-service"),
  servicePrincipalId: devFixtures.relayServicePrincipalA,
  requestedSpaceIds: [devFixtures.restrictedSpaceA]
});

function fixturePool(options: { roleRows?: object[]; claimRows?: object[] } = {}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(values === undefined ? { sql } : { sql, values });
      if (sql === "SELECT current_user AS current_user") {
        return { rows: options.roleRows ?? [{ current_user: "throughline_relay" }] };
      }
      if (sql.includes("WITH eligible")) return { rows: options.claimRows ?? [] };
      if (sql.includes("FROM ops.outbox_events") && sql.includes("FOR UPDATE")) {
        return { rows: options.claimRows ?? [] };
      }
      if (sql.includes("UPDATE ops.outbox_events")) return { rows: [{ id: values?.[0] }] };
      if (sql.includes("AS settings_cleared")) return { rows: [{ settings_cleared: true }] };
      return { rows: [] };
    }),
    release: vi.fn()
  } as unknown as PgPoolClient;
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as PgPool,
    client,
    queries
  };
}

function roleQueryFailurePool(error: Error) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql === "SELECT current_user AS current_user") throw error;
      return { rows: [] };
    }),
    release: vi.fn()
  } as unknown as PgPoolClient;
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as PgPool,
    queries
  };
}

const allow = (): AuthorizationDecision => ({
  allowed: true,
  reasonCode: "foundation_relay_direct_manager",
  policyVersion: "default-v1"
});

function claimedRow(override: Record<string, unknown> = {}) {
  return {
    event_id: crypto.randomUUID(),
    event_type: "foundation.proof.created.v1",
    tenant_id: devFixtures.tenantA,
    workspace_id: devFixtures.workspaceA,
    space_id: devFixtures.restrictedSpaceA,
    aggregate_type: "foundation_test_aggregate",
    aggregate_id: crypto.randomUUID(),
    aggregate_version: 1,
    causation_id: crypto.randomUUID(),
    request_id: "request-1",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: null,
    job_id: crypto.randomUUID(),
    context_reference_id: crypto.randomUUID(),
    signed_context_reference: "tlctx.v1.hs256.test.opaque.signature",
    claimed_by: "relay-a",
    publication_attempt: 1,
    claim_token: Buffer.alloc(32, 3).toString("base64url"),
    ...override
  };
}

describe("RelayOutboxRepository fixed scoped surface", () => {
  it("contains no template interpolation in repository SQL source", () => {
    const repositorySource = readFileSync(
      new URL("./relay-transaction.ts", import.meta.url),
      "utf8"
    );
    const sqlTemplates = [
      ...repositorySource.matchAll(/tx\.query(?:<[^>]+>)?\(\s*`([\s\S]*?)`/g)
    ].map(([, sql]) => sql);

    expect(sqlTemplates).toHaveLength(4);
    expect(sqlTemplates.every((sql) => !sql?.includes("${"))).toBe(true);
  });

  it("asserts the dedicated role and claims with SKIP LOCKED without treating scheduling as authorization", async () => {
    const { pool, queries } = fixturePool();
    const authorization = { canInTransaction: vi.fn(async () => allow()) };
    const repository = new RelayOutboxRepository(pool, authorization as never);

    await repository.claimNext(context(), { claimedBy: "relay-a", leaseSeconds: 30 });

    expect(
      queries.findIndex(({ sql }) => sql === "SELECT current_user AS current_user")
    ).toBeLessThan(queries.findIndex(({ sql }) => sql.includes("WITH eligible")));
    expect(authorization.canInTransaction).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => /FOR UPDATE SKIP LOCKED/.test(sql))).toBe(true);
    expect(queries.some(({ sql }) => /relay_service_principal_id = \$\d+/.test(sql))).toBe(true);
    const claimQuery = queries.find(({ sql }) => sql.includes("WITH eligible"));
    const claimSql = claimQuery?.sql ?? "";
    const [eligibilitySql, finalUpdateSql] = claimSql.split("UPDATE ops.outbox_events event");
    expect(claimSql).not.toContain("${");
    expect(claimSql.match(/event_type = \$8/g)).toHaveLength(2);
    expect(claimSql.match(/aggregate_type = \$9/g)).toHaveLength(2);
    expect(claimQuery?.values).toEqual([
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      devFixtures.relayServicePrincipalA,
      "relay-a",
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      30,
      FOUNDATION_OUTBOX_EVENT_TYPE,
      FOUNDATION_OUTBOX_AGGREGATE_TYPE
    ]);
    expect(eligibilitySql).toMatch(/tenant_id = \$1/);
    expect(eligibilitySql).toMatch(/workspace_id = \$2/);
    expect(eligibilitySql).toMatch(/space_id = \$3/);
    expect(eligibilitySql).toMatch(/relay_service_principal_id = \$4/);
    expect(eligibilitySql).toMatch(/event_type = \$8/);
    expect(eligibilitySql).toMatch(/aggregate_type = \$9/);
    expect(finalUpdateSql).toMatch(/event\.id = eligible\.id/);
    expect(finalUpdateSql).toMatch(/event\.tenant_id = \$1/);
    expect(finalUpdateSql).toMatch(/event\.workspace_id = \$2/);
    expect(finalUpdateSql).toMatch(/event\.space_id = \$3/);
    expect(finalUpdateSql).toMatch(/event\.relay_service_principal_id = \$4/);
    expect(finalUpdateSql).toMatch(/event\.event_type = \$8/);
    expect(finalUpdateSql).toMatch(/event\.aggregate_type = \$9/);
  });

  it.each([
    ["missing role row", []],
    [
      "duplicate role rows",
      [{ current_user: "throughline_relay" }, { current_user: "throughline_relay" }]
    ],
    ["malformed role row", [{ current_user: 7 }]],
    ["application role", [{ current_user: "throughline_app" }]],
    ["owner role", [{ current_user: "postgres" }]],
    ["worker role", [{ current_user: "throughline_worker" }]]
  ])(
    "rejects %s without authorizing, claiming, or leaking connection details",
    async (_name, roleRows) => {
      const { pool, queries } = fixturePool({ roleRows });
      const authorization = { canInTransaction: vi.fn(async () => allow()) };
      const repository = new RelayOutboxRepository(pool, authorization as never);
      await expect(
        repository.claimNext(context(), { claimedBy: "relay-a", leaseSeconds: 30 })
      ).rejects.toThrow("Dedicated relay database role is required");
      expect(authorization.canInTransaction).not.toHaveBeenCalled();
      expect(queries.some(({ sql }) => sql.includes("ops.outbox_events"))).toBe(false);
    }
  );

  it("wraps a role-query driver failure without leaking driver, DSN, context, or payload detail", async () => {
    const sensitive =
      "connection refused postgres://relay:secret@db.internal/throughline tenant payload trace";
    const { pool, queries } = roleQueryFailurePool(new Error(sensitive));
    const authorization = { canInTransaction: vi.fn(async () => allow()) };
    const repository = new RelayOutboxRepository(pool, authorization as never);

    let caught: unknown;
    try {
      await repository.claimNext(context(), { claimedBy: "relay-a", leaseSeconds: 30 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new Error("Dedicated relay database role is required"));
    expect(String(caught)).not.toContain(sensitive);
    expect(authorization.canInTransaction).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("ops.outbox_events"))).toBe(false);
  });

  it.each([
    ["event type", { event_type: "foundation.other.created.v1" }],
    ["aggregate type", { aggregate_type: "other_aggregate" }]
  ])(
    "rejects a final locked row whose %s escaped the exact SQL predicate",
    async (_name, override) => {
      const row = claimedRow(override);
      const { pool } = fixturePool({ claimRows: [row] });
      const repository = new RelayOutboxRepository(pool, {
        canInTransaction: vi.fn(async () => allow())
      } as never);
      const publisher = { publish: vi.fn() };

      await expect(
        repository.publishClaimed(
          context(),
          {
            eventId: row.event_id,
            claimedBy: row.claimed_by,
            publicationAttempt: row.publication_attempt,
            claimToken: row.claim_token
          } as never,
          publisher as never
        )
      ).rejects.toThrow("Claimed outbox event is outside the exact Foundation relay type");
      expect(publisher.publish).not.toHaveBeenCalled();
    }
  );

  it("rejects incomplete and multiple-Space contexts before acquiring a connection", async () => {
    const { pool } = fixturePool();
    const repository = new RelayOutboxRepository(pool, { canInTransaction: vi.fn() } as never);
    await expect(
      repository.claimNext(
        { ...context(), requestedSpaceIds: [] },
        { claimedBy: "x", leaseSeconds: 30 }
      )
    ).rejects.toThrow(/one exact requested Space/);
    await expect(
      repository.claimNext(
        { ...context(), requestedSpaceIds: [devFixtures.rootSpaceA, devFixtures.restrictedSpaceA] },
        { claimedBy: "x", leaseSeconds: 30 }
      )
    ).rejects.toThrow(/one exact requested Space/);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("claim acquisition remains scheduling-only even when live authorization would deny", async () => {
    const { pool, queries } = fixturePool();
    const repository = new RelayOutboxRepository(pool, {
      canInTransaction: vi.fn(async () => ({ ...allow(), allowed: false, reasonCode: "denied" }))
    } as never);
    await expect(
      repository.claimNext(context(), { claimedBy: "x", leaseSeconds: 30 })
    ).resolves.toBeUndefined();
    expect(queries.some(({ sql }) => sql.includes("WITH eligible"))).toBe(true);
    expect(repository).toBeDefined();
  });

  it("locks the exact token-bound row, authorizes, publishes, and marks in one transaction", async () => {
    const row = claimedRow();
    const { pool, queries } = fixturePool({ claimRows: [row] });
    const authorization = { canInTransaction: vi.fn(async () => allow()) };
    const repository = new RelayOutboxRepository(pool, authorization as never);
    const claim = {
      eventId: row.event_id,
      claimedBy: row.claimed_by,
      publicationAttempt: row.publication_attempt,
      claimToken: row.claim_token,
      envelope: { eventId: "caller-tampered-event" }
    } as never;
    const publisher = {
      publish: vi.fn(async (request: DeepReadonly<RelayPublicationRequest>) => {
        expect(request).toBeDefined();
        return { messageId: "sqs-message" };
      })
    };
    await repository.publishClaimed(context(), claim, publisher);
    const updates = queries.filter(({ sql }) => sql.includes("UPDATE ops.outbox_events"));
    expect(updates).toHaveLength(1);
    expect(authorization.canInTransaction).toHaveBeenCalledOnce();
    expect(publisher.publish).toHaveBeenCalledOnce();
    expect(updates[0]?.sql).toMatch(/claim_token = \$10/);
    expect(updates[0]?.sql).toContain("published_message_id");
    const publishedRequest = publisher.publish.mock.calls[0]?.[0];
    expect(Object.isFrozen(publishedRequest)).toBe(true);
    expect(Object.isFrozen(publishedRequest?.envelope)).toBe(true);
    expect(publishedRequest?.envelope.eventId).toBe(row.event_id);
  });

  it.each([
    ["ambiguous COMMIT confirmed by fresh database truth", true, "published"],
    ["accepted send followed by marker failure remains unresolved", false, "unresolved"]
  ] as const)("%s", async (_name, commitTruth, expectedStatus) => {
    const row = claimedRow();
    const claim = {
      eventId: row.event_id,
      claimedBy: row.claimed_by,
      publicationAttempt: row.publication_attempt,
      claimToken: row.claim_token
    } as never;
    let firstCommit = true;
    const primary = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "COMMIT" && firstCommit) {
          firstCommit = false;
          if (commitTruth) throw new Error("simulated ambiguous commit result");
          return { rows: [] };
        }
        if (sql === "SELECT current_user AS current_user") {
          return { rows: [{ current_user: "throughline_relay" }] };
        }
        if (sql.includes("FROM ops.outbox_events") && sql.includes("FOR UPDATE")) {
          return { rows: [row] };
        }
        if (sql.includes("UPDATE ops.outbox_events")) {
          if (!commitTruth) throw new Error("injected failure before mark");
          return { rows: [{ id: values?.[0] }] };
        }
        if (sql.includes("AS settings_cleared")) return { rows: [{ settings_cleared: true }] };
        return { rows: [] };
      }),
      release: vi.fn()
    } as unknown as PgPoolClient;
    const verifier = {
      query: vi.fn(async (sql: string) => {
        if (sql === "SELECT current_user AS current_user") {
          return { rows: [{ current_user: "throughline_relay" }] };
        }
        if (sql.includes("SELECT id") && sql.includes("published_message_id")) {
          return { rows: commitTruth ? [{ id: row.event_id }] : [] };
        }
        if (sql.includes("AS settings_cleared")) return { rows: [{ settings_cleared: true }] };
        return { rows: [] };
      }),
      release: vi.fn()
    } as unknown as PgPoolClient;
    const clients = [primary, verifier];
    const pool = {
      connect: vi.fn(async () => {
        const client = clients.shift();
        if (!client) throw new Error("unexpected connection");
        return client;
      })
    } as unknown as PgPool;
    const repository = new RelayOutboxRepository(pool, {
      canInTransaction: vi.fn(async () => allow())
    });

    await expect(
      repository.publishClaimed(context(), claim, {
        publish: async () => ({ messageId: "stable-message-id" })
      })
    ).resolves.toMatchObject({ status: expectedStatus, messageId: "stable-message-id" });
    expect(verifier.query).toHaveBeenCalledWith(
      expect.stringContaining("published_message_id = $11"),
      expect.arrayContaining([row.event_id, "stable-message-id"])
    );
  });

  it("final authorization denial prevents publisher invocation and the marker", async () => {
    const row = claimedRow();
    const { pool, queries } = fixturePool({ claimRows: [row] });
    const authorization = {
      canInTransaction: vi.fn(async () => ({ ...allow(), allowed: false, reasonCode: "denied" }))
    };
    const repository = new RelayOutboxRepository(pool, authorization as never);
    const publisher = { publish: vi.fn() };
    await expect(
      repository.publishClaimed(
        context(),
        {
          eventId: row.event_id,
          claimedBy: row.claimed_by,
          publicationAttempt: row.publication_attempt,
          claimToken: row.claim_token
        } as never,
        publisher as never
      )
    ).rejects.toThrow("Relay publication is not authorized");
    expect(authorization.canInTransaction).toHaveBeenCalledOnce();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => sql.includes("UPDATE ops.outbox_events"))).toBe(false);
  });
});
