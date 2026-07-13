import { createHash } from "node:crypto";
import type { AuthorizationDecision, ResourceRef, SecurityContext } from "@throughline/core-types";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PgPool, PgPoolClient } from "./client.js";
import { consumeFoundationWorkerJob } from "./worker-transaction.js";

type WorkerAuthorization = {
  canInTransaction(
    context: SecurityContext,
    action: "foundation.worker.consume",
    resource: ResourceRef,
    tx: { query: PgPoolClient["query"] },
    options: {
      workerBinding: {
        referenceId: string;
        jobId: string;
        workerServicePrincipalId: string;
        tenantId: string;
        workspaceId: string;
        spaceId: string;
        policyVersionId: string;
        delegatingUserId: string;
        delegatingMembershipId: string;
      };
    }
  ): Promise<AuthorizationDecision>;
};

type FoundationWorkerJobInput = {
  context: SecurityContext;
  jobId: string;
  contextReferenceId: string;
  idempotencyRecordId?: string;
};

type Deadline = {
  absoluteDeadlineMs: number;
  now(): number;
};

type ExpectedConsume = (options: {
  pool: PgPool;
  authorization: WorkerAuthorization;
  input: FoundationWorkerJobInput;
  signal?: AbortSignal;
  deadline: Deadline;
}) => ReturnType<typeof consumeFoundationWorkerJob>;

const ids = {
  tenant: "11111111-1111-4111-8111-111111111111",
  workspace: "11111111-1111-4111-8111-111111111112",
  space: "11111111-1111-4111-8111-111111111113",
  job: "70000000-0000-7000-8000-000000000021",
  reference: "70000000-0000-7000-8000-000000000031",
  worker: "70000000-0000-7000-8000-000000000051",
  user: "70000000-0000-7000-8000-000000000081",
  membership: "70000000-0000-7000-8000-000000000083",
  aggregate: "70000000-0000-7000-8000-000000000001",
  idempotency: "70000000-0000-7000-8000-000000000061"
} as const;

const fixedHandlerKey = "foundation.worker.consume.v1";
const fixedDeadline: Deadline = { absoluteDeadlineMs: 10_000, now: () => 1_000 };
const contextIssuedAt = new Date(Date.now() - 60_000).toISOString();
const contextExpiresAt = new Date(Date.now() + 14 * 60_000).toISOString();

function context(overrides: Partial<SecurityContext> = {}): SecurityContext {
  return {
    requestId: "task-7-request",
    traceId: "task-7-trace",
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    servicePrincipalId: ids.worker,
    delegatedByUserId: ids.user,
    delegatedByMembershipId: ids.membership,
    requestedSpaceIds: [ids.space],
    membershipIds: [ids.membership],
    roleHints: ["snapshot-only"],
    dataClassCeiling: "restricted",
    policyVersion: "default-v1",
    issuedAt: contextIssuedAt,
    expiresAt: contextExpiresAt,
    ...overrides
  };
}

function input(overrides: Partial<FoundationWorkerJobInput> = {}): FoundationWorkerJobInput {
  return {
    context: context(),
    jobId: ids.job,
    contextReferenceId: ids.reference,
    idempotencyRecordId: ids.idempotency,
    ...overrides
  };
}

function deterministicEffectHash(aggregateId: string, committedVersion: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        handlerKey: fixedHandlerKey,
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
        spaceId: ids.space,
        jobId: ids.job,
        contextReferenceId: ids.reference,
        aggregateId,
        loadedAggregateVersion: committedVersion - 1,
        committedAggregateVersion: committedVersion
      })
    )
    .digest("hex");
}

type QueryCall = [string, readonly unknown[] | undefined];

function successfulHarness(
  options: {
    duplicate?: boolean;
    authorizationDecision?: Partial<AuthorizationDecision>;
  } = {}
) {
  const timeline: string[] = [];
  const backendPid = 4321;
  const effectHash = deterministicEffectHash(ids.aggregate, 2);
  const query = vi.fn(
    async (
      sql: string,
      values?: readonly unknown[]
    ): Promise<{ rows: unknown[]; rowCount?: number }> => {
      void values;
      timeline.push(sql);
      if (sql === 'SELECT current_user AS "currentUser"') {
        return { rows: [{ currentUser: "throughline_worker" }], rowCount: 1 };
      }
      if (sql.includes("pg_backend_pid()")) {
        return {
          rows: [{ currentUser: "throughline_worker", backendPid }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM ops.foundation_test_aggregates")) {
        return {
          rows: [
            options.duplicate
              ? {
                  id: ids.aggregate,
                  pendingJobId: null,
                  lastEffectJobId: ids.job,
                  effectCount: 1,
                  aggregateVersion: 2
                }
              : {
                  id: ids.aggregate,
                  pendingJobId: ids.job,
                  lastEffectJobId: null,
                  effectCount: 0,
                  aggregateVersion: 1
                }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("FROM ops.idempotency_records")) {
        if (options.duplicate) {
          return {
            rows: [
              {
                id: ids.idempotency,
                tenantId: ids.tenant,
                workspaceId: ids.workspace,
                spaceId: ids.space,
                jobId: ids.job,
                contextReferenceId: ids.reference,
                handlerKey: fixedHandlerKey,
                aggregateId: ids.aggregate,
                aggregateVersion: options.duplicate ? 2 : 1,
                effectHash
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("INSERT INTO ops.idempotency_records")) {
        return { rows: [{ id: ids.idempotency }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ops.foundation_test_aggregates")) {
        return { rows: [{ aggregateVersion: 2, effectCount: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  );
  const release = vi.fn();
  const client = { query, release } as unknown as PgPoolClient;
  const cancelQuery = vi.fn(
    async (sql: string): Promise<{ rows: unknown[]; rowCount?: number }> =>
      sql.includes("pg_backend_pid()")
        ? {
            rows: [{ currentUser: "throughline_worker", backendPid: backendPid + 1 }],
            rowCount: 1
          }
        : { rows: [{ cancelled: true }], rowCount: 1 }
  );
  const cancelRelease = vi.fn();
  const cancelClient = { query: cancelQuery, release: cancelRelease } as unknown as PgPoolClient;
  const connect = vi.fn().mockResolvedValueOnce(client).mockResolvedValue(cancelClient);
  const pool = { connect } as unknown as PgPool;
  const canInTransaction = vi.fn(async (): Promise<AuthorizationDecision> => {
    timeline.push("AUTHORIZATION:foundation.worker.consume");
    return {
      allowed: true,
      reasonCode: "foundation_worker_direct_contributor",
      policyVersion: "default-v1",
      ...options.authorizationDecision
    };
  });
  const authorization = { canInTransaction } as WorkerAuthorization;
  return {
    authorization,
    backendPid,
    canInTransaction,
    cancelClient,
    cancelQuery,
    cancelRelease,
    client,
    connect,
    pool,
    query,
    release,
    timeline
  };
}

function calls(query: ReturnType<typeof vi.fn>): QueryCall[] {
  return query.mock.calls as unknown as QueryCall[];
}

function consume(
  harness: ReturnType<typeof successfulHarness>,
  overrides: {
    input?: FoundationWorkerJobInput;
    signal?: AbortSignal;
    deadline?: Deadline;
  } = {}
) {
  const expectedConsume = consumeFoundationWorkerJob as unknown as ExpectedConsume;
  return expectedConsume({
    pool: harness.pool,
    authorization: harness.authorization,
    input: overrides.input ?? input(),
    deadline: overrides.deadline ?? fixedDeadline,
    ...(overrides.signal ? { signal: overrides.signal } : {})
  });
}

describe("fixed Foundation worker transaction", () => {
  it("exports only the fixed transaction options and fixed worker input surface", () => {
    type Options = Parameters<typeof consumeFoundationWorkerJob>[0];
    expectTypeOf<keyof Options>().toEqualTypeOf<
      "pool" | "authorization" | "input" | "signal" | "deadline"
    >();
    expectTypeOf<Options["deadline"]>().toEqualTypeOf<Deadline>();
    expectTypeOf<keyof Options["input"]>().toEqualTypeOf<
      "context" | "jobId" | "contextReferenceId" | "idempotencyRecordId"
    >();
  });

  it("asserts the exact worker role and captures the transaction backend PID at start", async () => {
    const harness = successfulHarness();

    await consume(harness);

    expect(calls(harness.query).slice(0, 2)).toEqual([
      ["BEGIN", undefined],
      ['SELECT current_user AS "currentUser", pg_backend_pid()::integer AS "backendPid"', undefined]
    ]);
    expect(harness.connect).toHaveBeenCalledTimes(2);
  });

  it("sets exact positive transaction-local statement and lock budgets before blocking work", async () => {
    const harness = successfulHarness();

    await consume(harness, {
      deadline: { absoluteDeadlineMs: 10_000, now: () => 1_000 }
    });

    const allCalls = calls(harness.query);
    const blockingIndexes = allCalls
      .map(([sql], index) => ({ sql, index }))
      .filter(({ sql }) => /foundation_test_aggregates|idempotency_records|COMMIT/.test(sql));
    for (const { index, sql } of blockingIndexes) {
      const statementBudget = allCalls[index - 2];
      const lockBudget = allCalls[index - 1];
      expect(statementBudget, sql).toEqual([
        "SELECT pg_catalog.set_config($1, $2, true)",
        ["statement_timeout", "8000ms"]
      ]);
      expect(lockBudget, sql).toEqual([
        "SELECT pg_catalog.set_config($1, $2, true)",
        ["lock_timeout", "7750ms"]
      ]);
    }
    expect(blockingIndexes.length).toBeGreaterThan(4);
  });

  it("accepts only rehydrated context, job/reference identity, and optional idempotency metadata", async () => {
    const harness = successfulHarness();
    const workerInput = input();

    await expect(consume(harness, { input: workerInput })).resolves.toEqual({
      status: "applied",
      aggregateId: ids.aggregate,
      aggregateVersion: 2,
      effectCount: 1
    });

    expect(Object.keys(workerInput).sort()).toEqual([
      "context",
      "contextReferenceId",
      "idempotencyRecordId",
      "jobId"
    ]);
    expect(workerInput).not.toHaveProperty("aggregateId");
    expect(workerInput).not.toHaveProperty("expectedAggregateVersion");
    expect(workerInput).not.toHaveProperty("committedAggregateVersion");
    expect(workerInput).not.toHaveProperty("handlerKey");
    expect(workerInput).not.toHaveProperty("effectHash");
    expect(calls(harness.query).at(-1)?.[0]).toBe("COMMIT");
  });

  it("uses one narrow centralized authorization call before aggregate access and never reads the outbox", async () => {
    const harness = successfulHarness();
    await consume(harness);

    expect(harness.canInTransaction).toHaveBeenCalledOnce();
    expect(harness.canInTransaction).toHaveBeenCalledWith(
      input().context,
      "foundation.worker.consume",
      { type: "space", id: ids.space },
      expect.objectContaining({ query: expect.any(Function) }),
      {
        workerBinding: {
          referenceId: ids.reference,
          jobId: ids.job,
          workerServicePrincipalId: ids.worker,
          tenantId: ids.tenant,
          workspaceId: ids.workspace,
          spaceId: ids.space,
          policyVersionId: "default-v1",
          delegatingUserId: ids.user,
          delegatingMembershipId: ids.membership
        }
      }
    );
    const aggregateIndex = harness.timeline.findIndex((entry) =>
      entry.includes("FROM ops.foundation_test_aggregates")
    );
    expect(harness.timeline.indexOf("AUTHORIZATION:foundation.worker.consume")).toBeLessThan(
      aggregateIndex
    );
    const repositorySql = calls(harness.query)
      .map(([sql]) => sql)
      .join("\n");
    expect(repositorySql).not.toMatch(/FROM (?:identity|access)\./);
    const referenceQueries = calls(harness.query).filter(([sql]) =>
      sql.includes("ops.security_context_references")
    );
    expect(referenceQueries).toHaveLength(1);
    expect(referenceQueries[0]?.[0]).toMatch(
      /^UPDATE ops\.foundation_test_aggregates[\s\S]*EXISTS \([\s\S]*FROM ops\.security_context_references/
    );
    expect(repositorySql).not.toContain("ops.outbox_events");
  });

  it("classifies exactly one aggregate by exact scope and current or prior job", async () => {
    const harness = successfulHarness();
    await consume(harness);

    const aggregateRead = calls(harness.query).find(([sql]) =>
      sql.includes("FROM ops.foundation_test_aggregates")
    );
    expect(aggregateRead?.[0]).toMatch(
      /tenant_id = \$1[\s\S]*workspace_id = \$2[\s\S]*space_id = \$3[\s\S]*\(pending_job_id = \$4 OR last_effect_job_id = \$4\)/
    );
    expect(aggregateRead?.[0]).not.toMatch(/FOR UPDATE/);
    expect(aggregateRead?.[1]).toEqual([ids.tenant, ids.workspace, ids.space, ids.job]);
  });

  it("locks only the exact pending aggregate and loaded version before either write", async () => {
    const harness = successfulHarness();
    await consume(harness);

    const aggregateReads = calls(harness.query).filter(([sql]) =>
      sql.includes("FROM ops.foundation_test_aggregates")
    );
    expect(aggregateReads).toHaveLength(2);
    expect(aggregateReads[1]?.[0]).toMatch(
      /tenant_id = \$1[\s\S]*workspace_id = \$2[\s\S]*space_id = \$3[\s\S]*id = \$4[\s\S]*pending_job_id = \$5[\s\S]*aggregate_version = \$6[\s\S]*FOR UPDATE/
    );
    expect(aggregateReads[1]?.[1]).toEqual([
      ids.tenant,
      ids.workspace,
      ids.space,
      ids.aggregate,
      ids.job,
      1
    ]);
    const pendingLockIndex = calls(harness.query).findIndex(([sql]) =>
      /FROM ops\.foundation_test_aggregates[\s\S]*FOR UPDATE/.test(sql)
    );
    const idempotencyInsertIndex = calls(harness.query).findIndex(([sql]) =>
      sql.startsWith("INSERT INTO ops.idempotency_records")
    );
    expect(pendingLockIndex).toBeLessThan(idempotencyInsertIndex);
  });

  it.each([
    ["missing", []],
    [
      "ambiguous",
      [
        { id: ids.aggregate, aggregateVersion: 1 },
        { id: "70000000-0000-7000-8000-000000000002", aggregateVersion: 1 }
      ]
    ]
  ])("rejects a %s scoped aggregate result", async (_case, rows) => {
    const harness = successfulHarness();
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM ops.foundation_test_aggregates")) {
        return { rows, rowCount: rows.length };
      }
      return base!(sql, values);
    });
    await expect(consume(harness)).rejects.toMatchObject({
      code: "WORKER_AGGREGATE_CARDINALITY"
    });
  });

  it("sets fixed handler/aggregate/version/hash bindings only after aggregate discovery", async () => {
    const harness = successfulHarness();
    await consume(harness);
    const allCalls = calls(harness.query);
    const settings = allCalls
      .filter(([, values]) => String(values?.[0]).startsWith("app."))
      .map(([, values]) => [values?.[0], values?.[1]]);
    expect(settings).toEqual([
      ["app.tenant_id", ids.tenant],
      ["app.workspace_id", ids.workspace],
      ["app.space_id", ids.space],
      ["app.job_id", ids.job],
      ["app.context_reference_id", ids.reference],
      ["app.worker_principal_id", ids.worker],
      ["app.policy_version", "default-v1"],
      ["app.user_id", ids.user],
      ["app.membership_id", ids.membership],
      ["app.handler_key", fixedHandlerKey],
      ["app.aggregate_id", ids.aggregate],
      ["app.aggregate_version", "2"],
      ["app.effect_hash", deterministicEffectHash(ids.aggregate, 2)]
    ]);
    const pendingLockIndex = allCalls.findIndex(([sql]) =>
      /FROM ops\.foundation_test_aggregates[\s\S]*FOR UPDATE/.test(sql)
    );
    for (const setting of [
      "app.handler_key",
      "app.aggregate_id",
      "app.aggregate_version",
      "app.effect_hash"
    ]) {
      expect(
        allCalls.findIndex(([, values]) => values?.[0] === setting),
        setting
      ).toBeGreaterThan(pendingLockIndex);
    }
  });

  it("parameterizes all discovered/fixed data in actual production queries", async () => {
    const harness = successfulHarness();
    await consume(harness);
    const allCalls = calls(harness.query);
    const data = [
      ids.tenant,
      ids.workspace,
      ids.space,
      ids.job,
      ids.reference,
      ids.worker,
      ids.user,
      ids.membership,
      ids.aggregate,
      ids.idempotency,
      fixedHandlerKey,
      deterministicEffectHash(ids.aggregate, 2)
    ];
    for (const value of data) {
      expect(
        allCalls.some(([, values]) => values?.includes(value)),
        value
      ).toBe(true);
      expect(
        allCalls.every(([sql]) => !sql.includes(value)),
        value
      ).toBe(true);
    }
  });

  it("uses a final exact guarded mutation with database time", async () => {
    const harness = successfulHarness();
    await consume(harness);
    const mutation = calls(harness.query).find(([sql]) =>
      sql.startsWith("UPDATE ops.foundation_test_aggregates")
    );
    expect(mutation?.[0]).toMatch(/pending_job_id = NULL/);
    expect(mutation?.[0]).toMatch(/last_effect_job_id = \$/);
    expect(mutation?.[0]).toMatch(/effect_count = effect_count \+ 1/);
    expect(mutation?.[0]).toMatch(/aggregate_version = aggregate_version \+ 1/);
    expect(mutation?.[0]).toMatch(/updated_at = clock_timestamp\(\)/);
    expect(mutation?.[0]).toMatch(
      /WHERE[\s\S]*tenant_id = \$[\s\S]*workspace_id = \$[\s\S]*space_id = \$[\s\S]*id = \$[\s\S]*pending_job_id = \$[\s\S]*aggregate_version = \$[\s\S]*EXISTS \([\s\S]*FROM ops\.security_context_references[\s\S]*id = \$[\s\S]*job_id = \$[\s\S]*worker_service_principal_id = \$[\s\S]*policy_version_id = \$[\s\S]*delegating_user_id = \$[\s\S]*delegating_membership_id = \$[\s\S]*status = 'active'[\s\S]*revoked_at IS NULL[\s\S]*expires_at > clock_timestamp\(\)/
    );
  });

  it("confirms duplicates only against the discovered aggregate and exact fixed metadata", async () => {
    const harness = successfulHarness({ duplicate: true });
    await expect(consume(harness)).resolves.toEqual({
      status: "confirmed_duplicate",
      aggregateId: ids.aggregate,
      aggregateVersion: 2,
      effectCount: 1
    });
    const read = calls(harness.query).find(([sql]) => sql.includes("FROM ops.idempotency_records"));
    expect(read?.[0]).toMatch(
      /tenant_id = \$[\s\S]*workspace_id = \$[\s\S]*space_id = \$[\s\S]*job_id = \$[\s\S]*context_reference_id = \$[\s\S]*handler_key = \$[\s\S]*aggregate_id = \$[\s\S]*aggregate_version = \$[\s\S]*effect_hash = \$/
    );
    expect(read?.[1]).toEqual(
      expect.arrayContaining([
        fixedHandlerKey,
        ids.aggregate,
        2,
        deterministicEffectHash(ids.aggregate, 2)
      ])
    );
  });

  it.each([
    ["handler", { handlerKey: "wrong" }],
    ["aggregate", { aggregateId: "70000000-0000-7000-8000-000000000009" }],
    ["version", { aggregateVersion: 3 }],
    ["hash", { effectHash: "b".repeat(64) }]
  ] as const)("rejects a committed duplicate with mismatched fixed %s", async (_case, mismatch) => {
    const harness = successfulHarness({ duplicate: true });
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      const result = await base!(sql, values);
      if (sql.includes("FROM ops.idempotency_records") && result.rows[0]) {
        return { ...result, rows: [{ ...(result.rows[0] as object), ...mismatch }] };
      }
      return result;
    });
    await expect(consume(harness)).rejects.toMatchObject({ code: "WORKER_DUPLICATE_MISMATCH" });
  });

  it("rolls back both writes when failure follows the idempotency insert", async () => {
    const harness = successfulHarness();
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith("UPDATE ops.foundation_test_aggregates")) {
        throw Object.assign(new Error("forced mutation failure"), { code: "40001" });
      }
      return base!(sql, values);
    });
    await expect(consume(harness)).rejects.toBeDefined();
    expect(calls(harness.query).at(-1)?.[0]).toBe("ROLLBACK");
  });

  it.each([
    ["owner", [{ currentUser: "postgres" }]],
    ["app", [{ currentUser: "throughline_app" }]],
    ["relay", [{ currentUser: "throughline_relay" }]],
    ["missing", []],
    ["duplicate", [{ currentUser: "throughline_worker" }, { currentUser: "throughline_worker" }]],
    ["malformed", [{}]]
  ])("rejects %s role assertion results before bindings or authorization", async (_case, rows) => {
    const harness = successfulHarness();
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (
        sql === 'SELECT current_user AS "currentUser", pg_backend_pid()::integer AS "backendPid"'
      ) {
        return { rows, rowCount: rows.length };
      }
      return base!(sql, values);
    });
    await expect(consume(harness)).rejects.toMatchObject({ code: "WORKER_ROLE_ASSERTION_FAILED" });
    expect(calls(harness.query).map(([sql]) => sql)).toEqual([
      "BEGIN",
      'SELECT current_user AS "currentUser", pg_backend_pid()::integer AS "backendPid"',
      "ROLLBACK"
    ]);
    expect(harness.canInTransaction).not.toHaveBeenCalled();
  });

  it("rolls back an ordinary database error and releases only after a clean rollback", async () => {
    const harness = successfulHarness();
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM ops.foundation_test_aggregates")) throw new Error("lookup failed");
      return base!(sql, values);
    });
    await expect(consume(harness)).rejects.toBeDefined();
    expect(calls(harness.query).at(-1)?.[0]).toBe("ROLLBACK");
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledWith();
  });

  it("destroys the connection when rollback cannot establish a clean transaction", async () => {
    const harness = successfulHarness();
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM ops.foundation_test_aggregates")) throw new Error("lookup failed");
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return base!(sql, values);
    });
    await expect(consume(harness)).rejects.toBeDefined();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    const replacement = await harness.pool.connect();
    const replacementIdentity = await replacement.query<{ backendPid: number }>(
      'SELECT pg_backend_pid()::integer AS "backendPid"'
    );
    expect(replacementIdentity.rows[0]?.backendPid).not.toBe(harness.backendPid);
  });

  it("does not issue ROLLBACK when BEGIN itself fails", async () => {
    const harness = successfulHarness();
    harness.query.mockRejectedValueOnce(new Error("begin failed"));

    await expect(consume(harness)).rejects.toBeDefined();

    expect(calls(harness.query).map(([sql]) => sql)).toEqual(["BEGIN"]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("cancels the exact backend, waits for statement settlement, then rolls back", async () => {
    const harness = successfulHarness();
    const controller = new AbortController();
    const base = harness.query.getMockImplementation();
    let settleBlockedStatement!: () => void;
    const blockedStatement = new Promise<void>((resolve) => {
      settleBlockedStatement = resolve;
    });
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (/FROM ops\.foundation_test_aggregates[\s\S]*FOR UPDATE/.test(sql)) {
        await blockedStatement;
        throw Object.assign(new Error("canceling statement due to user request"), {
          code: "57014"
        });
      }
      return base!(sql, values);
    });

    const result = consume(harness, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(
        calls(harness.query).some(([sql]) =>
          /FROM ops\.foundation_test_aggregates[\s\S]*FOR UPDATE/.test(sql)
        )
      ).toBe(true);
    });
    controller.abort();
    await vi.waitFor(() =>
      expect(
        calls(harness.cancelQuery).filter(([sql]) => sql.includes("pg_cancel_backend"))
      ).toHaveLength(1)
    );
    expect(harness.cancelQuery).toHaveBeenCalledWith("SELECT pg_catalog.pg_cancel_backend($1)", [
      harness.backendPid
    ]);
    expect(calls(harness.query).map(([sql]) => sql)).not.toContain("ROLLBACK");

    settleBlockedStatement();
    await expect(result).rejects.toMatchObject({ code: "WORKER_ABORTED" });
    const timeline = [
      ...calls(harness.query).map(([sql]) => sql),
      ...calls(harness.cancelQuery).map(([sql]) => sql)
    ];
    expect(timeline).toContain("ROLLBACK");
    expect(harness.cancelRelease).toHaveBeenCalledWith();
  });

  it("latches an abort that races with statement completion and never commits", async () => {
    const harness = successfulHarness();
    const controller = new AbortController();
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith("UPDATE ops.foundation_test_aggregates")) {
        controller.abort();
        return { rows: [{ aggregateVersion: 2, effectCount: 1 }], rowCount: 1 };
      }
      return base!(sql, values);
    });

    await expect(consume(harness, { signal: controller.signal })).rejects.toMatchObject({
      code: "WORKER_ABORTED"
    });
    expect(calls(harness.query).map(([sql]) => sql)).not.toContain("COMMIT");
    expect(calls(harness.query).at(-1)?.[0]).toBe("ROLLBACK");
    expect(harness.cancelQuery).toHaveBeenCalledWith("SELECT pg_catalog.pg_cancel_backend($1)", [
      harness.backendPid
    ]);
  });

  it("aborts during operational work and never releases an uncertain connection as reusable", async () => {
    const harness = successfulHarness();
    const controller = new AbortController();
    const base = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM ops.foundation_test_aggregates")) {
        controller.abort();
        throw Object.assign(new Error("connection terminated"), { code: "57P01" });
      }
      if (sql === "ROLLBACK") throw new Error("connection is closed");
      return base!(sql, values);
    });
    await expect(consume(harness, { signal: controller.signal })).rejects.toBeDefined();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
