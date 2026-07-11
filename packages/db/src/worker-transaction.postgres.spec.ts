import type { SecurityContext } from "@throughline/core-types";
import { devFixtures, DEV_POLICY_VERSION } from "@throughline/tenancy";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresAuthorizationService } from "../../authorization/src/authorization-service.js";
import { applyMigrations } from "./migrations.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { provisionTestAppRole, provisionTestFoundationRoles } from "./test-database.js";
import {
  consumeFoundationWorkerJob,
  type FoundationWorkerAuthorization
} from "./worker-transaction.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const relayUrl = process.env.TEST_RELAY_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const maybeDescribe =
  ownerUrl && appUrl && relayUrl && workerUrl ? describe.sequential : describe.skip;

const ids = {
  aggregate: "71000000-0000-7000-8000-000000000001",
  job: "71000000-0000-7000-8000-000000000021",
  reference: "71000000-0000-7000-8000-000000000031",
  worker: "71000000-0000-7000-8000-000000000051",
  workerGrant: "71000000-0000-7000-8000-000000000071",
  delegatorGrant: "71000000-0000-7000-8000-000000000072",
  delegatorUser: "71000000-0000-7000-8000-000000000081",
  delegatorPerson: "71000000-0000-7000-8000-000000000082",
  delegatorMembership: "71000000-0000-7000-8000-000000000083",
  idempotency: "71000000-0000-7000-8000-000000000061"
} as const;

type WorkerInput = {
  context: SecurityContext;
  jobId: string;
  contextReferenceId: string;
  idempotencyRecordId?: string;
};

type Consume = (options: {
  pool: pg.Pool;
  authorization: FoundationWorkerAuthorization;
  input: WorkerInput;
  signal?: AbortSignal;
  deadline?: { absoluteDeadlineMs: number; now(): number };
}) => Promise<{ status: "applied" | "confirmed_duplicate" }>;

type AuthorityCase = {
  name: string;
  change: (client: pg.PoolClient) => Promise<unknown>;
};

maybeDescribe("Foundation worker live-authorization PostgreSQL barriers", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const workerPool = new pg.Pool({ connectionString: workerUrl });
  const authorization = new PostgresAuthorizationService(
    workerPool
  ) as unknown as FoundationWorkerAuthorization;
  const consumeImplementation = consumeFoundationWorkerJob as Consume;
  const consume: Consume = (options) =>
    consumeImplementation({
      ...options,
      deadline: options.deadline ?? realDeadline()
    });

  beforeAll(async () => {
    assertDistinctRoleDsns(ownerUrl!, appUrl!, relayUrl!, workerUrl!);
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestFoundationRoles(ownerPool, relayUrl!, workerUrl!);
    await seedWaveA2DeterministicData(ownerPool);
  });

  beforeEach(async () => {
    await resetWorkerFixture(ownerPool);
  });

  afterAll(async () => {
    await workerPool.end();
    await ownerPool.end();
  });

  const authorityCases: AuthorityCase[] = [
    {
      name: "Tenant suspension",
      change: (client) =>
        client.query("UPDATE identity.tenants SET status = 'suspended' WHERE id = $1", [
          devFixtures.tenantA
        ])
    },
    {
      name: "Tenant deletion",
      change: (client) =>
        client.query("UPDATE identity.tenants SET status = 'deleted' WHERE id = $1", [
          devFixtures.tenantA
        ])
    },
    {
      name: "Workspace archival",
      change: (client) =>
        client.query("UPDATE identity.workspaces SET status = 'archived' WHERE id = $1", [
          devFixtures.workspaceA
        ])
    },
    {
      name: "reference revocation",
      change: (client) =>
        client.query(
          "UPDATE ops.security_context_references SET status = 'revoked', revoked_at = clock_timestamp(), revocation_reason = 'barrier' WHERE id = $1",
          [ids.reference]
        )
    },
    {
      name: "policy retirement",
      change: (client) =>
        client.query(
          "UPDATE identity.policy_versions SET status = 'retired' WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
          [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
        )
    },
    {
      name: "worker disablement",
      change: (client) =>
        client.query("UPDATE identity.service_principals SET status = 'disabled' WHERE id = $1", [
          ids.worker
        ])
    },
    {
      name: "delegator user disablement",
      change: (client) =>
        client.query("UPDATE identity.users SET status = 'disabled' WHERE id = $1", [
          ids.delegatorUser
        ])
    },
    {
      name: "delegator membership suspension",
      change: (client) =>
        client.query("UPDATE identity.memberships SET status = 'suspended' WHERE id = $1", [
          ids.delegatorMembership
        ])
    },
    {
      name: "Space archival",
      change: (client) =>
        client.query("UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1", [
          devFixtures.restrictedSpaceA
        ])
    },
    {
      name: "removed worker contributor grant",
      change: (client) =>
        client.query("DELETE FROM access.access_relationships WHERE id = $1", [ids.workerGrant])
    },
    {
      name: "removed delegator restricted-Space authority",
      change: (client) =>
        client.query("DELETE FROM access.access_relationships WHERE id = $1", [ids.delegatorGrant])
    }
  ];

  it.each(authorityCases)(
    "$name wins before worker start and produces zero effect",
    async (testCase) => {
      const authority = await ownerPool.connect();
      try {
        await authority.query("BEGIN");
        await testCase.change(authority);
        await authority.query("COMMIT");
      } finally {
        authority.release();
      }

      await expect(
        consume({ pool: workerPool, authorization, input: workerInput() })
      ).rejects.toBeDefined();
      await expectAggregate(ownerPool, { effectCount: 0, pendingJobId: ids.job });
      await expectIdempotencyCount(ownerPool, 0);
    }
  );

  it.each(authorityCases)(
    "worker locks first for $name, commits the effect, then the authority change commits",
    async (testCase) => {
      const blocker = await ownerPool.connect();
      const authority = await ownerPool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM ops.foundation_test_aggregates WHERE id = $1 FOR UPDATE",
          [ids.aggregate]
        );

        const worker = consume({ pool: workerPool, authorization, input: workerInput() });
        await waitForWorkerAggregateLock(ownerPool);

        await authority.query("BEGIN");
        const authorityChange = testCase.change(authority);
        await expectStillBlocked(authorityChange);

        await blocker.query("COMMIT");
        await expect(worker).resolves.toMatchObject({ status: "applied" });
        await authorityChange;
        await authority.query("COMMIT");
      } finally {
        await safeRollback(blocker);
        await safeRollback(authority);
        blocker.release();
        authority.release();
      }

      await expectAggregate(ownerPool, { effectCount: 1, pendingJobId: null });
      await expectIdempotencyCount(ownerPool, 1);
    }
  );

  it("expiry after transaction start but before final mutation wins and leaves neither write", async () => {
    await ownerPool.query(
      "UPDATE ops.security_context_references SET expires_at = clock_timestamp() + interval '300 milliseconds' WHERE id = $1",
      [ids.reference]
    );
    const blocker = await ownerPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM ops.foundation_test_aggregates WHERE id = $1 FOR UPDATE",
        [ids.aggregate]
      );
      const worker = consume({ pool: workerPool, authorization, input: workerInput() });
      await waitForWorkerAggregateLock(ownerPool);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await blocker.query("COMMIT");
      await expect(worker).rejects.toBeDefined();
    } finally {
      await safeRollback(blocker);
      blocker.release();
    }
    await expectAggregate(ownerPool, { effectCount: 0, pendingJobId: ids.job });
    await expectIdempotencyCount(ownerPool, 0);
  });

  it("worker commits before a later expiry and duplicate/concurrent duplicate delivery produces one effect", async () => {
    await ownerPool.query(
      "UPDATE ops.security_context_references SET expires_at = clock_timestamp() + interval '5 seconds' WHERE id = $1",
      [ids.reference]
    );
    const results = await Promise.all([
      consume({ pool: workerPool, authorization, input: workerInput() }),
      consume({ pool: workerPool, authorization, input: workerInput() })
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["applied", "confirmed_duplicate"]);
    await expectAggregate(ownerPool, { effectCount: 1, pendingJobId: null });
    await expectIdempotencyCount(ownerPool, 1);
  });

  it("rolls back an idempotency insert when the final aggregate mutation is forced to fail", async () => {
    await ownerPool.query(
      "UPDATE ops.foundation_test_aggregates SET effect_count = 2147483647 WHERE id = $1",
      [ids.aggregate]
    );
    await expect(
      consume({ pool: workerPool, authorization, input: workerInput() })
    ).rejects.toBeDefined();
    await expectAggregate(ownerPool, { effectCount: 2147483647, pendingJobId: ids.job });
    await expectIdempotencyCount(ownerPool, 0);
  });

  it("resets transaction-local statement and lock timeouts after commit and rollback", async () => {
    await consume({
      pool: workerPool,
      authorization,
      input: workerInput(),
      deadline: realDeadline()
    });
    await expectWorkerPoolTimeoutsReset(workerPool);

    await resetWorkerFixture(ownerPool);
    const deniedAuthorization = {
      canInTransaction: async () => ({ allowed: false, reasonCode: "TEST_DENIAL" })
    } as unknown as FoundationWorkerAuthorization;
    await expect(
      consume({
        pool: workerPool,
        authorization: deniedAuthorization,
        input: workerInput(),
        deadline: realDeadline()
      })
    ).rejects.toBeDefined();
    await expectWorkerPoolTimeoutsReset(workerPool);
  });

  it("quarantines a real client after rollback failure and replaces its backend PID", async () => {
    const isolatedPool = new pg.Pool({ connectionString: workerUrl, max: 2 });
    let checkout = 0;
    let failedRollbackPid: number | undefined;
    const wrappedPool = {
      connect: async () => {
        const client = await isolatedPool.connect();
        checkout += 1;
        if (checkout !== 1) return client;
        failedRollbackPid = (
          await client.query<{ pid: number }>('SELECT pg_backend_pid()::integer AS "pid"')
        ).rows[0]!.pid;
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return async (sql: string, values?: readonly unknown[]) => {
                if (sql === "ROLLBACK") throw new Error("injected rollback failure");
                return values ? target.query(sql, [...values]) : target.query(sql);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    } as unknown as pg.Pool;
    const deniedAuthorization = {
      canInTransaction: async () => ({ allowed: false, reasonCode: "TEST_DENIAL" })
    } as unknown as FoundationWorkerAuthorization;

    try {
      await expect(
        consume({
          pool: wrappedPool,
          authorization: deniedAuthorization,
          input: workerInput(),
          deadline: realDeadline()
        })
      ).rejects.toBeDefined();
      expect(failedRollbackPid).toBeDefined();

      const first = await isolatedPool.connect();
      const second = await isolatedPool.connect();
      try {
        const replacementPids = await Promise.all(
          [first, second].map(
            async (client) =>
              (await client.query<{ pid: number }>('SELECT pg_backend_pid()::integer AS "pid"'))
                .rows[0]!.pid
          )
        );
        expect(replacementPids).not.toContain(failedRollbackPid);
        expect(new Set(replacementPids).size).toBe(2);
      } finally {
        first.release();
        second.release();
      }
    } finally {
      await isolatedPool.end();
    }
  });

  it("cancels the exact lock-waiting backend by the fixed deadline and safely reuses it", async () => {
    const blocker = await ownerPool.connect();
    const controller = new AbortController();
    let targetPid: number | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM ops.foundation_test_aggregates WHERE id = $1 FOR UPDATE",
        [ids.aggregate]
      );
      const blockerIdentity = await blocker.query<{ pid: number }>(
        'SELECT pg_backend_pid()::integer AS "pid"'
      );

      const startedAt = performance.now();
      const worker = consume({
        pool: workerPool,
        authorization,
        input: workerInput(),
        signal: controller.signal,
        deadline: { absoluteDeadlineMs: 20_000, now: () => performance.now() - startedAt }
      });
      targetPid = await waitForExactWorkerLockWait(ownerPool, blockerIdentity.rows[0]!.pid);
      controller.abort();

      const outcome = await Promise.race([
        worker.then(
          () => "committed",
          (error: unknown) => error
        ),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000))
      ]);
      expect(outcome).not.toBe("timeout");
      expect(outcome).not.toBe("committed");
      await expectBackendHasNoTransactionOrLocks(ownerPool, targetPid);
      await expectAggregate(ownerPool, { effectCount: 0, pendingJobId: ids.job });
      await expectIdempotencyCount(ownerPool, 0);

      const reusableClients: pg.PoolClient[] = [];
      try {
        const existingConnectionCount = workerPool.totalCount;
        for (let index = 0; index < existingConnectionCount; index += 1) {
          reusableClients.push(await workerPool.connect());
        }
        let reusedTarget = false;
        for (const reusable of reusableClients) {
          const identity = await reusable.query<{ pid: number; alive: number }>(
            'SELECT pg_backend_pid()::integer AS "pid", 1::integer AS alive'
          );
          if (identity.rows[0]?.pid === targetPid) {
            expect(identity.rows[0]?.alive).toBe(1);
            reusedTarget = true;
          }
        }
        expect(reusedTarget).toBe(true);
      } finally {
        for (const reusable of reusableClients) reusable.release();
      }
    } finally {
      controller.abort();
      await safeRollback(blocker);
      blocker.release();
    }
  });
});

function workerInput(): WorkerInput {
  return {
    context: workerContext(),
    jobId: ids.job,
    contextReferenceId: ids.reference,
    idempotencyRecordId: ids.idempotency
  };
}

function workerContext(now = new Date()): SecurityContext {
  return {
    requestId: "task-7-request",
    traceId: "task-7-trace",
    tenantId: devFixtures.tenantA,
    workspaceId: devFixtures.workspaceA,
    servicePrincipalId: ids.worker,
    delegatedByUserId: ids.delegatorUser,
    delegatedByMembershipId: ids.delegatorMembership,
    requestedSpaceIds: [devFixtures.restrictedSpaceA],
    membershipIds: [ids.delegatorMembership],
    roleHints: ["member"],
    dataClassCeiling: "restricted",
    policyVersion: DEV_POLICY_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 900_000).toISOString()
  };
}

async function resetWorkerFixture(pool: pg.Pool): Promise<void> {
  await pool.query("DELETE FROM ops.idempotency_records WHERE aggregate_id = $1", [ids.aggregate]);
  await pool.query("DELETE FROM ops.security_context_references WHERE id = $1", [ids.reference]);
  await pool.query("DELETE FROM ops.foundation_test_aggregates WHERE id = $1", [ids.aggregate]);
  await pool.query("DELETE FROM access.access_relationships WHERE id IN ($1, $2)", [
    ids.workerGrant,
    ids.delegatorGrant
  ]);
  await pool.query("DELETE FROM identity.service_principals WHERE id = $1", [ids.worker]);
  await pool.query("DELETE FROM identity.memberships WHERE id = $1", [ids.delegatorMembership]);
  await pool.query("DELETE FROM identity.people WHERE id = $1", [ids.delegatorPerson]);
  await pool.query("DELETE FROM identity.users WHERE id = $1", [ids.delegatorUser]);
  await pool.query("UPDATE identity.tenants SET status = 'active' WHERE id = $1", [
    devFixtures.tenantA
  ]);
  await pool.query("UPDATE identity.workspaces SET status = 'active' WHERE id = $1", [
    devFixtures.workspaceA
  ]);
  await pool.query(
    "UPDATE identity.policy_versions SET status = 'active' WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
    [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
  );
  await pool.query("UPDATE access.spaces SET archived_at = NULL WHERE id = $1", [
    devFixtures.restrictedSpaceA
  ]);
  await pool.query(
    `INSERT INTO identity.users (id, auth_provider, auth_subject, primary_email, status)
     VALUES ($1, 'dev', 'task-7-member', 'task-7-member@example.com', 'active')`,
    [ids.delegatorUser]
  );
  await pool.query(
    `INSERT INTO identity.people
       (id, tenant_id, workspace_id, display_name, primary_email, is_internal)
     VALUES ($1,$2,$3,'Task 7 Member','task-7-member@example.com',true)`,
    [ids.delegatorPerson, devFixtures.tenantA, devFixtures.workspaceA]
  );
  await pool.query(
    `INSERT INTO identity.memberships
       (id, tenant_id, workspace_id, user_id, person_id, role, status)
     VALUES ($1,$2,$3,$4,$5,'member','active')`,
    [
      ids.delegatorMembership,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      ids.delegatorUser,
      ids.delegatorPerson
    ]
  );
  await pool.query(
    "INSERT INTO identity.service_principals (id, tenant_id, workspace_id, name, purpose, status) VALUES ($1,$2,$3,'Task 7 Worker','worker','active')",
    [ids.worker, devFixtures.tenantA, devFixtures.workspaceA]
  );
  await pool.query(
    `INSERT INTO access.access_relationships
       (id, tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
     VALUES
       ($1,$3,$4,'service_principal',$5,'contributor','space',$6,'direct'),
       ($2,$3,$4,'membership',$7,'contributor','space',$6,'direct')`,
    [
      ids.workerGrant,
      ids.delegatorGrant,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      ids.worker,
      devFixtures.restrictedSpaceA,
      ids.delegatorMembership
    ]
  );
  const issuedAt = new Date();
  await pool.query(
    `INSERT INTO ops.security_context_references
      (id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
       delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
       issued_at, expires_at, status, signing_key_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active','test-key')`,
    [
      ids.reference,
      ids.job,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      ids.worker,
      ids.delegatorUser,
      ids.delegatorMembership,
      DEV_POLICY_VERSION,
      {
        requestId: "task-7-request",
        traceId: "task-7-trace",
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        servicePrincipalId: ids.worker,
        delegatedByUserId: ids.delegatorUser,
        delegatedByMembershipId: ids.delegatorMembership,
        requestedSpaceIds: [devFixtures.restrictedSpaceA],
        membershipIds: [ids.delegatorMembership],
        roleHints: ["member"],
        dataClassCeiling: "restricted",
        policyVersion: DEV_POLICY_VERSION,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 900_000).toISOString()
      },
      issuedAt,
      new Date(issuedAt.getTime() + 900_000)
    ]
  );
  await pool.query(
    `INSERT INTO ops.foundation_test_aggregates
       (id, tenant_id, workspace_id, space_id, proof_key, pending_job_id)
     VALUES ($1,$2,$3,$4,'task-7-proof',$5)`,
    [
      ids.aggregate,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      ids.job
    ]
  );
}

async function waitForWorkerAggregateLock(pool: pg.Pool): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE usename = 'throughline_worker'
          AND wait_event_type = 'Lock'
          AND state = 'active'
      ) AS blocked
    `);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("worker did not reach the owner-held aggregate lock");
}

async function waitForExactWorkerLockWait(pool: pg.Pool, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid::integer AS pid
       FROM pg_stat_activity
       WHERE usename = 'throughline_worker'
         AND state = 'active'
         AND wait_event_type = 'Lock'
         AND query LIKE '%foundation_test_aggregates%FOR UPDATE%'
         AND $1 = ANY(pg_blocking_pids(pid))
       ORDER BY backend_start DESC`,
      [blockerPid]
    );
    if (result.rows.length === 1) return result.rows[0]!.pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("worker did not reach the exact aggregate lock wait");
}

async function expectBackendHasNoTransactionOrLocks(pool: pg.Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{
      state: string | null;
      waitEventType: string | null;
      lockCount: number;
    }>(
      `SELECT activity.state,
              activity.wait_event_type AS "waitEventType",
              count(locks.*)::integer AS "lockCount"
       FROM (SELECT $1::integer AS pid) target
       LEFT JOIN pg_stat_activity activity ON activity.pid = target.pid
       LEFT JOIN pg_locks locks ON locks.pid = target.pid
       GROUP BY activity.state, activity.wait_event_type`,
      [pid]
    );
    const row = result.rows[0];
    if (
      row &&
      row.waitEventType !== "Lock" &&
      row.state !== "idle in transaction" &&
      row.lockCount === 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${pid} retained a wait, transaction, or lock after abort`);
}

function realDeadline(): { absoluteDeadlineMs: number; now(): number } {
  const startedAt = performance.now();
  return {
    absoluteDeadlineMs: 20_000,
    now: () => performance.now() - startedAt
  };
}

async function expectWorkerPoolTimeoutsReset(pool: pg.Pool): Promise<void> {
  const connectionCount = Math.max(pool.totalCount, 2);
  const clients: pg.PoolClient[] = [];
  try {
    for (let index = 0; index < connectionCount; index += 1) {
      clients.push(await pool.connect());
    }
    for (const client of clients) {
      const settings = await client.query<{
        statementTimeout: string;
        lockTimeout: string;
      }>(
        `SELECT current_setting('statement_timeout') AS "statementTimeout",
                current_setting('lock_timeout') AS "lockTimeout"`
      );
      expect(settings.rows[0]).toEqual({ statementTimeout: "0", lockTimeout: "0" });
    }
  } finally {
    for (const client of clients) client.release();
  }
}

async function expectStillBlocked(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => "completed",
      () => "rejected"
    ),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100))
  ]);
  expect(outcome).toBe("blocked");
}

async function expectAggregate(
  pool: pg.Pool,
  expected: { effectCount: number; pendingJobId: string | null }
): Promise<void> {
  const result = await pool.query<{ effectCount: number; pendingJobId: string | null }>(
    'SELECT effect_count AS "effectCount", pending_job_id AS "pendingJobId" FROM ops.foundation_test_aggregates WHERE id = $1',
    [ids.aggregate]
  );
  expect(result.rows).toEqual([expected]);
}

async function expectIdempotencyCount(pool: pg.Pool, expected: number): Promise<void> {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM ops.idempotency_records WHERE aggregate_id = $1",
    [ids.aggregate]
  );
  expect(result.rows[0]?.count).toBe(expected);
}

async function safeRollback(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Cleanup only; assertions exercise transaction behavior above.
  }
}

function assertDistinctRoleDsns(owner: string, app: string, relay: string, worker: string): void {
  const users = [owner, app, relay, worker].map((value) =>
    decodeURIComponent(new URL(value).username)
  );
  expect(users).toEqual([
    expect.not.stringMatching(/^throughline_(?:app|relay|worker)$/),
    "throughline_app",
    "throughline_relay",
    "throughline_worker"
  ]);
  expect(new Set(users).size).toBe(4);
}
