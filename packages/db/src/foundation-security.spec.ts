import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createAsyncContextReferenceCodec,
  devFixtures,
  DEV_POLICY_VERSION
} from "@throughline/tenancy";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { provisionTestAppRole, provisionTestFoundationRoles } from "./test-database.js";
import { bootstrapWorkerContextReference } from "./worker-bootstrap.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const relayUrl = process.env.TEST_RELAY_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const maybeDescribe =
  ownerUrl && appUrl && relayUrl && workerUrl ? describe.sequential : describe.skip;

const migrationIds = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql"
];

const ids = {
  aggregateA: "70000000-0000-7000-8000-000000000001",
  aggregateB: "70000000-0000-7000-8000-000000000002",
  eventA: "70000000-0000-7000-8000-000000000011",
  eventB: "70000000-0000-7000-8000-000000000012",
  jobA: "70000000-0000-7000-8000-000000000021",
  jobB: "70000000-0000-7000-8000-000000000022",
  referenceA: "70000000-0000-7000-8000-000000000031",
  referenceB: "70000000-0000-7000-8000-000000000032",
  relayA: "70000000-0000-7000-8000-000000000041",
  relayB: "70000000-0000-7000-8000-000000000042",
  workerA: "70000000-0000-7000-8000-000000000051",
  workerB: "70000000-0000-7000-8000-000000000052"
} as const;

const bootstrapSigningKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const contextCredentialMarker = `request-${ids.jobA}`;

maybeDescribe("Foundation operational schema security", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  const relayPool = new pg.Pool({ connectionString: relayUrl });
  const workerPool = new pg.Pool({ connectionString: workerUrl });

  beforeAll(async () => {
    assertDistinctRuntimeDsns(ownerUrl!, appUrl!, relayUrl!, workerUrl!);
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestFoundationRoles(ownerPool, relayUrl!, workerUrl!);
    await seedWaveA2DeterministicData(ownerPool);
    await seedFoundationRows(ownerPool);
  });

  afterAll(async () => {
    await workerPool.end();
    await relayPool.end();
    await appPool.end();
    await ownerPool.end();
  });

  it("applies 0001 then 0002, repeats unchanged migrations, and records true checksums", async () => {
    const journal = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    );

    expect(journal.rows.map(({ id }) => id)).toEqual(migrationIds);
    for (const row of journal.rows) {
      const sql = await readFile(new URL(`../migrations/${row.id}`, import.meta.url), "utf8");
      expect(row.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
    }
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: migrationIds
    });
  });

  it("resets deterministically to NOLOGIN NOBYPASSRLS roles before disposable test provisioning", async () => {
    await applyMigrations(ownerPool, { reset: true });
    const roles = await ownerPool.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      password_is_null: boolean;
    }>(`
      SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole,
             rolinherit, rolreplication,
             rolpassword IS NULL AS password_is_null
      FROM pg_authid
      WHERE rolname IN ('throughline_relay', 'throughline_worker')
      ORDER BY rolname
    `);
    expect(roles.rows).toEqual([
      {
        rolname: "throughline_relay",
        rolcanlogin: false,
        rolbypassrls: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        password_is_null: true
      },
      {
        rolname: "throughline_worker",
        rolcanlogin: false,
        rolbypassrls: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        password_is_null: true
      }
    ]);

    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestFoundationRoles(ownerPool, relayUrl!, workerUrl!);
    await seedWaveA2DeterministicData(ownerPool);
    await seedFoundationRows(ownerPool);
  });

  it("connects runtime pools only as their disposable least-privilege roles", async () => {
    for (const [pool, expectedUser] of [
      [relayPool, "throughline_relay"],
      [workerPool, "throughline_worker"]
    ] as const) {
      const identity = await pool.query<{
        current_user: string;
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(`
        SELECT current_user, rolbypassrls, rolsuper
        FROM pg_roles
        WHERE rolname = current_user
      `);
      expect(identity.rows[0]).toEqual({
        current_user: expectedUser,
        rolbypassrls: false,
        rolsuper: false
      });
    }

    const elevatedMemberships = await ownerPool.query<{ member_name: string }>(`
      SELECT member.rolname AS member_name
      FROM pg_auth_members AS membership
      JOIN pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname IN ('throughline_relay', 'throughline_worker')
    `);
    const ownedRelations = await ownerPool.query<{ owner_name: string }>(`
      SELECT DISTINCT pg_get_userbyid(relation.relowner) AS owner_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('identity', 'access', 'ops')
        AND pg_get_userbyid(relation.relowner) IN ('throughline_relay', 'throughline_worker')
    `);
    expect(elevatedMemberships.rows).toEqual([]);
    expect(ownedRelations.rows).toEqual([]);
  });

  it("enables and forces RLS on all four operational tables", async () => {
    const result = await ownerPool.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relation.relname AS table_name, relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops'
        AND relation.relname IN (
          'foundation_test_aggregates', 'outbox_events',
          'security_context_references', 'idempotency_records'
        )
      ORDER BY relation.relname
    `);
    expect(result.rows).toEqual(
      [
        "foundation_test_aggregates",
        "idempotency_records",
        "outbox_events",
        "security_context_references"
      ].map((table_name) => ({ table_name, relrowsecurity: true, relforcerowsecurity: true }))
    );
  });

  it("declares the required exact-scope and idempotency unique keys", async () => {
    const definitions = await ownerPool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'ops.foundation_test_aggregates'::regclass,
        'ops.outbox_events'::regclass,
        'ops.security_context_references'::regclass,
        'ops.idempotency_records'::regclass
      )
      ORDER BY conname
    `);
    const joined = definitions.rows.map(({ definition }) => definition).join("\n");
    expect(joined).toContain("UNIQUE (tenant_id, workspace_id, space_id, id)");
    expect(joined).toContain("UNIQUE (tenant_id, workspace_id, space_id, job_id)");
    expect(joined).toContain("UNIQUE (tenant_id, workspace_id, space_id, job_id, handler_key)");
    expect(joined).toContain(
      "FOREIGN KEY (context_reference_id, job_id, tenant_id, workspace_id, space_id)"
    );
  });

  it("shows no operational rows to the app role without transaction-local scope", async () => {
    const counts = await appPool.query<{ relation_name: string; row_count: number }>(`
      SELECT 'foundation_test_aggregates' AS relation_name, count(*)::integer AS row_count
      FROM ops.foundation_test_aggregates
      UNION ALL SELECT 'outbox_events', count(*)::integer FROM ops.outbox_events
      UNION ALL SELECT 'security_context_references', count(*)::integer FROM ops.security_context_references
      UNION ALL SELECT 'idempotency_records', count(*)::integer FROM ops.idempotency_records
      ORDER BY relation_name
    `);
    expect(counts.rows).toEqual(
      [
        "foundation_test_aggregates",
        "idempotency_records",
        "outbox_events",
        "security_context_references"
      ].map((relation_name) => ({ relation_name, row_count: 0 }))
    );
  });

  it("denies app writes to every operational table across tenant/workspace/Space scope", async () => {
    const crossScope = [devFixtures.tenantB, devFixtures.workspaceB, devFixtures.rootSpaceB];
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.foundation_test_aggregates
         (id, tenant_id, workspace_id, space_id, proof_key)
       VALUES ($1, $2, $3, $4, 'cross-scope-denied')`,
      [crypto.randomUUID(), ...crossScope]
    );
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.security_context_references
         (id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
          delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
          issued_at, expires_at, signing_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}',
               clock_timestamp(), clock_timestamp() + interval '10 minutes', 'test-key')`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        ...crossScope,
        ids.workerB,
        devFixtures.userB,
        devFixtures.membershipBViewer,
        DEV_POLICY_VERSION
      ]
    );
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.outbox_events
         (id, event_type, tenant_id, workspace_id, space_id, aggregate_type, aggregate_id,
          aggregate_version, causation_id, request_id, traceparent, job_id,
          relay_service_principal_id, context_reference_id, signed_context_reference)
       VALUES ($1, 'foundation.proof.requested', $2, $3, $4, 'foundation_test_aggregate',
               $5, 1, $6, 'cross-scope', '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
               $6, $7, $8, 'opaque-test-token')`,
      [crypto.randomUUID(), ...crossScope, ids.aggregateB, ids.jobB, ids.relayB, ids.referenceB]
    );
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.idempotency_records
         (id, tenant_id, workspace_id, space_id, job_id, handler_key, context_reference_id,
          aggregate_id, aggregate_version, effect_hash)
       VALUES ($1, $2, $3, $4, $5, 'cross-scope', $6, $7, 1, $8)`,
      [crypto.randomUUID(), ...crossScope, ids.jobB, ids.referenceB, ids.aggregateB, "0".repeat(64)]
    );
  });

  it("binds relay visibility to one exact scope and relay service principal", async () => {
    expect(await scopedRelayEventIds(relayPool, {})).toEqual([]);
    expect(
      await scopedRelayEventIds(relayPool, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        servicePrincipalId: ids.relayA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([ids.eventA]);
    expect(
      await scopedRelayEventIds(relayPool, {
        tenantId: devFixtures.tenantB,
        workspaceId: devFixtures.workspaceB,
        spaceId: devFixtures.rootSpaceB,
        servicePrincipalId: ids.relayA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([]);
  });

  it("gives relay exact column grants and prevents immutable event mutation", async () => {
    const privileges = await ownerPool.query<{ privilege_type: string; column_name: string }>(`
      SELECT privilege_type, column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'throughline_relay'
        AND table_schema = 'ops'
        AND table_name = 'outbox_events'
      ORDER BY privilege_type, column_name
    `);
    expect(
      privileges.rows
        .filter(({ privilege_type }) => privilege_type === "UPDATE")
        .map(({ column_name }) => column_name)
    ).toEqual([
      "claim_expires_at",
      "claimed_at",
      "claimed_by",
      "last_retry_code",
      "next_attempt_at",
      "publication_attempts",
      "published_at",
      "published_message_id",
      "terminal_failed_at",
      "terminal_failure_code"
    ]);
    await expect(
      relayPool.query("UPDATE ops.outbox_events SET event_type = 'forbidden'")
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      relayPool.query("INSERT INTO ops.outbox_events (id) VALUES ($1)", [crypto.randomUUID()])
    ).rejects.toMatchObject({ code: "42501" });
    await expect(relayPool.query("DELETE FROM ops.outbox_events")).rejects.toMatchObject({
      code: "42501"
    });
  });

  it("allows relay claim metadata updates only inside its exact transaction-local scope", async () => {
    const client = await relayPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        servicePrincipalId: ids.relayA,
        policyVersion: DEV_POLICY_VERSION
      });
      const claimed = await client.query<{ id: string }>(
        `UPDATE ops.outbox_events
         SET publication_attempts = publication_attempts + 1,
             claimed_at = clock_timestamp(),
             claimed_by = 'relay-test',
             claim_expires_at = clock_timestamp() + interval '30 seconds'
         RETURNING id`
      );
      expect(claimed.rows).toEqual([{ id: ids.eventA }]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("denies relay product/identity reads beyond exact authority columns", async () => {
    await expect(relayPool.query("SELECT primary_email FROM identity.users")).rejects.toMatchObject(
      { code: "42501" }
    );
    await expect(relayPool.query("SELECT display_name FROM identity.people")).rejects.toMatchObject(
      {
        code: "42501"
      }
    );
    await expect(
      relayPool.query("SELECT proof_key FROM ops.foundation_test_aggregates")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("binds worker bootstrap lookup to exact signed-claim settings", async () => {
    expect(await scopedWorkerReferenceIds(workerPool, {})).toEqual([]);
    expect(
      await scopedWorkerReferenceIds(workerPool, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([ids.referenceA]);
    expect(
      await scopedWorkerReferenceIds(workerPool, {
        tenantId: devFixtures.tenantB,
        workspaceId: devFixtures.workspaceB,
        spaceId: devFixtures.rootSpaceB,
        jobId: ids.jobB,
        referenceId: ids.referenceB,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([]);
  });

  it("fails closed through the fixed bootstrap for missing, wrong, forged, cross-tenant, unknown, revoked, and expired bindings", async () => {
    const codec = createAsyncContextReferenceCodec({
      verificationKeys: new Map([["test-key", bootstrapSigningKey]]),
      activeKeyId: "test-key",
      clock: () => new Date()
    });
    const baseClaims = {
      referenceId: ids.referenceA,
      jobId: ids.jobA,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.rootSpaceA,
      workerServicePrincipalId: ids.workerA,
      policyVersionId: DEV_POLICY_VERSION
    } as const;
    const { token } = codec.issue({ ...baseClaims, ttlSeconds: 600 });
    const expected = {
      jobId: baseClaims.jobId,
      tenantId: baseClaims.tenantId,
      workspaceId: baseClaims.workspaceId,
      spaceId: baseClaims.spaceId,
      workerServicePrincipalId: baseClaims.workerServicePrincipalId,
      policyVersionId: baseClaims.policyVersionId
    };

    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token, codec, expected })
    ).resolves.toMatchObject({ id: ids.referenceA });

    for (const [pool, connectionString] of [
      [ownerPool, ownerUrl!],
      [appPool, appUrl!]
    ] as const) {
      let error: unknown;
      try {
        await bootstrapWorkerContextReference({ pool, token, codec, expected });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "WorkerContextBootstrapError",
        message: "Worker context bootstrap failed"
      });
      const rendered = `${String(error)} ${JSON.stringify(error)}`;
      expect(rendered).not.toContain(token);
      expect(rendered).not.toContain(bootstrapSigningKey.toString("utf8"));
      expect(rendered).not.toContain(contextCredentialMarker);
      expect(rendered).not.toContain(connectionString);
    }
    expect(
      await scopedWorkerReferenceIds(workerPool, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([]);

    const wrongWorker = codec.issue({
      ...baseClaims,
      workerServicePrincipalId: ids.workerB,
      ttlSeconds: 600
    });
    await expect(
      bootstrapWorkerContextReference({
        pool: workerPool,
        token: wrongWorker.token,
        codec,
        expected: { ...expected, workerServicePrincipalId: ids.workerB }
      })
    ).resolves.toBeNull();

    const tokenParts = token.split(".");
    const payload = JSON.parse(
      Buffer.from(tokenParts[4]!, "base64url").toString("utf8")
    ) as unknown[];
    payload[3] = devFixtures.tenantB;
    tokenParts[4] = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    await expect(
      bootstrapWorkerContextReference({
        pool: workerPool,
        token: tokenParts.join("."),
        codec,
        expected
      })
    ).resolves.toBeNull();

    const crossTenant = codec.issue({
      ...baseClaims,
      tenantId: devFixtures.tenantB,
      workspaceId: devFixtures.workspaceB,
      spaceId: devFixtures.rootSpaceB,
      ttlSeconds: 600
    });
    await expect(
      bootstrapWorkerContextReference({
        pool: workerPool,
        token: crossTenant.token,
        codec,
        expected: {
          ...expected,
          tenantId: devFixtures.tenantB,
          workspaceId: devFixtures.workspaceB,
          spaceId: devFixtures.rootSpaceB
        }
      })
    ).resolves.toBeNull();

    const unknown = codec.issue({
      ...baseClaims,
      referenceId: "70000000-0000-7000-8000-000000000039",
      ttlSeconds: 600
    });
    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token: unknown.token, codec, expected })
    ).resolves.toBeNull();

    await ownerPool.query(
      `UPDATE ops.security_context_references
       SET status = 'revoked', revoked_at = clock_timestamp(), revocation_reason = 'test'
       WHERE id = $1`,
      [ids.referenceA]
    );
    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token, codec, expected })
    ).resolves.toBeNull();
    await ownerPool.query(
      `UPDATE ops.security_context_references
       SET status = 'active', revoked_at = NULL, revocation_reason = NULL,
           issued_at = clock_timestamp() - interval '20 minutes',
           expires_at = clock_timestamp() - interval '5 minutes'
       WHERE id = $1`,
      [ids.referenceA]
    );
    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token, codec, expected })
    ).resolves.toBeNull();
    await ownerPool.query(
      `UPDATE ops.security_context_references
       SET issued_at = clock_timestamp(), expires_at = clock_timestamp() + interval '15 minutes'
       WHERE id = $1`,
      [ids.referenceA]
    );
  });

  it("prevents worker access to outbox and unrelated identity/domain surfaces", async () => {
    await expect(workerPool.query("SELECT id FROM ops.outbox_events")).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      workerPool.query("SELECT primary_email FROM identity.users")
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerPool.query("DELETE FROM ops.foundation_test_aggregates")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("allows worker proof/idempotency writes only for the exact bound job and reference", async () => {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      });
      const updated = await client.query<{ id: string }>(
        `UPDATE ops.foundation_test_aggregates
         SET effect_count = effect_count + 1,
             last_effect_job_id = $1,
             aggregate_version = aggregate_version + 1,
             updated_at = clock_timestamp()
         RETURNING id`,
        [ids.jobA]
      );
      expect(updated.rows).toEqual([{ id: ids.aggregateA }]);
      await expect(
        client.query(
          `INSERT INTO ops.idempotency_records
             (id, tenant_id, workspace_id, space_id, job_id, handler_key,
              context_reference_id, aggregate_id, aggregate_version, effect_hash)
           VALUES ($1, $2, $3, $4, $5, 'foundation-proof', $6, $7, 2, $8)`,
          [
            crypto.randomUUID(),
            devFixtures.tenantA,
            devFixtures.workspaceA,
            devFixtures.rootSpaceA,
            ids.jobA,
            ids.referenceA,
            ids.aggregateA,
            "0".repeat(64)
          ]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rolls migration 0002 back with its journal record", async () => {
    const migrationId = migrationIds[1]!;
    await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
      migrationId
    ]);
    await ownerPool.query("DROP POLICY outbox_events_app_scope ON ops.outbox_events");

    try {
      await ownerPool.query(`
        CREATE FUNCTION throughline_migrations.reject_foundation_journal_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
          IF NEW.id = '0002_foundation_closure_async_isolation.sql' THEN
            RAISE EXCEPTION 'intentional Foundation journal failure';
          END IF;
          RETURN NEW;
        END
        $trigger$
      `);
      await ownerPool.query(`
        CREATE TRIGGER reject_foundation_journal_insert
        BEFORE INSERT ON throughline_migrations.journal
        FOR EACH ROW
        EXECUTE FUNCTION throughline_migrations.reject_foundation_journal_insert()
      `);

      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        "intentional Foundation journal failure"
      );
      const rolledBack = await ownerPool.query<{ journal_count: string; policy_count: string }>(`
        SELECT
          (SELECT count(*)::text FROM throughline_migrations.journal WHERE id = '${migrationId}')
            AS journal_count,
          (SELECT count(*)::text FROM pg_policies
           WHERE schemaname = 'ops' AND tablename = 'outbox_events'
             AND policyname = 'outbox_events_app_scope') AS policy_count
      `);
      expect(rolledBack.rows[0]).toEqual({ journal_count: "0", policy_count: "0" });
    } finally {
      await ownerPool.query(
        "DROP TRIGGER IF EXISTS reject_foundation_journal_insert ON throughline_migrations.journal"
      );
      await ownerPool.query(
        "DROP FUNCTION IF EXISTS throughline_migrations.reject_foundation_journal_insert()"
      );
      await applyMigrations(ownerPool);
    }
  });
});

function assertDistinctRuntimeDsns(
  owner: string,
  app: string,
  relay: string,
  worker: string
): void {
  const users = [owner, app, relay, worker].map((value) =>
    decodeURIComponent(new URL(value).username)
  );
  expect(new Set(users).size).toBe(4);
  expect(users.slice(1)).toEqual(["throughline_app", "throughline_relay", "throughline_worker"]);
}

async function seedFoundationRows(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO identity.service_principals (id, tenant_id, workspace_id, name, purpose, status)
     VALUES
       ($1, $2, $3, 'Relay A', 'system', 'active'), ($4, $5, $6, 'Relay B', 'system', 'active'),
       ($7, $2, $3, 'Worker A', 'worker', 'active'), ($8, $5, $6, 'Worker B', 'worker', 'active')`,
    [
      ids.relayA,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      ids.relayB,
      devFixtures.tenantB,
      devFixtures.workspaceB,
      ids.workerA,
      ids.workerB
    ]
  );
  await pool.query(
    `INSERT INTO access.access_relationships
       (tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
     VALUES
       ($1, $2, 'service_principal', $3, 'manager', 'space', $4, 'direct'),
       ($5, $6, 'service_principal', $7, 'manager', 'space', $8, 'direct'),
       ($1, $2, 'service_principal', $9, 'contributor', 'space', $4, 'direct'),
       ($5, $6, 'service_principal', $10, 'contributor', 'space', $8, 'direct')`,
    [
      devFixtures.tenantA,
      devFixtures.workspaceA,
      ids.relayA,
      devFixtures.rootSpaceA,
      devFixtures.tenantB,
      devFixtures.workspaceB,
      ids.relayB,
      devFixtures.rootSpaceB,
      ids.workerA,
      ids.workerB
    ]
  );
  for (const fixture of [
    {
      tenant: devFixtures.tenantA,
      workspace: devFixtures.workspaceA,
      space: devFixtures.rootSpaceA,
      aggregate: ids.aggregateA,
      event: ids.eventA,
      job: ids.jobA,
      reference: ids.referenceA,
      relay: ids.relayA,
      worker: ids.workerA,
      user: devFixtures.userA,
      membership: devFixtures.membershipAOwner
    },
    {
      tenant: devFixtures.tenantB,
      workspace: devFixtures.workspaceB,
      space: devFixtures.rootSpaceB,
      aggregate: ids.aggregateB,
      event: ids.eventB,
      job: ids.jobB,
      reference: ids.referenceB,
      relay: ids.relayB,
      worker: ids.workerB,
      user: devFixtures.userB,
      membership: devFixtures.membershipBViewer
    }
  ]) {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 15 * 60 * 1_000);
    const contextSnapshot = {
      requestId: `request-${fixture.job}`,
      traceId: `trace-${fixture.job}`,
      tenantId: fixture.tenant,
      workspaceId: fixture.workspace,
      actorUserId: fixture.user,
      actorMembershipId: fixture.membership,
      requestedSpaceIds: [fixture.space],
      membershipIds: [fixture.membership],
      roleHints: ["owner"],
      dataClassCeiling: "workspace",
      policyVersion: DEV_POLICY_VERSION,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    await pool.query(
      `INSERT INTO ops.security_context_references
        (id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
         delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
         issued_at, expires_at, status, signing_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active','test-key')`,
      [
        fixture.reference,
        fixture.job,
        fixture.tenant,
        fixture.workspace,
        fixture.space,
        fixture.worker,
        fixture.user,
        fixture.membership,
        DEV_POLICY_VERSION,
        contextSnapshot,
        issuedAt,
        expiresAt
      ]
    );
    await pool.query(
      `INSERT INTO ops.foundation_test_aggregates
         (id, tenant_id, workspace_id, space_id, proof_key, pending_job_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        fixture.aggregate,
        fixture.tenant,
        fixture.workspace,
        fixture.space,
        `proof-${fixture.job}`,
        fixture.job
      ]
    );
    await pool.query(
      `INSERT INTO ops.outbox_events
        (id,event_type,tenant_id,workspace_id,space_id,aggregate_type,aggregate_id,aggregate_version,
         causation_id,request_id,traceparent,job_id,relay_service_principal_id,
         context_reference_id,signed_context_reference)
       VALUES ($1,'foundation.proof.requested',$2,$3,$4,'foundation_test_aggregate',$5,1,
         $6,'request-test','00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',$6,$7,$8,'opaque-test-token')`,
      [
        fixture.event,
        fixture.tenant,
        fixture.workspace,
        fixture.space,
        fixture.aggregate,
        fixture.job,
        fixture.relay,
        fixture.reference
      ]
    );
  }
}

type ScopeSettings = {
  tenantId?: string;
  workspaceId?: string;
  spaceId?: string;
  servicePrincipalId?: string;
  policyVersion?: string;
  jobId?: string;
  referenceId?: string;
  workerPrincipalId?: string;
};

async function setLocal(client: pg.PoolClient, settings: ScopeSettings): Promise<void> {
  const pairs: Array<[string, string | undefined]> = [
    ["app.tenant_id", settings.tenantId],
    ["app.workspace_id", settings.workspaceId],
    ["app.space_id", settings.spaceId],
    ["app.service_principal_id", settings.servicePrincipalId],
    ["app.policy_version", settings.policyVersion],
    ["app.job_id", settings.jobId],
    ["app.context_reference_id", settings.referenceId],
    ["app.worker_principal_id", settings.workerPrincipalId]
  ];
  for (const [name, value] of pairs)
    await client.query("SELECT set_config($1, $2, true)", [name, value ?? ""]);
}

async function scopedRelayEventIds(pool: pg.Pool, settings: ScopeSettings): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    const result = await client.query<{ id: string }>(
      "SELECT id FROM ops.outbox_events ORDER BY id"
    );
    await client.query("ROLLBACK");
    return result.rows.map(({ id }) => id);
  } finally {
    client.release();
  }
}

async function scopedWorkerReferenceIds(pool: pg.Pool, settings: ScopeSettings): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    const result = await client.query<{ id: string }>(
      "SELECT id FROM ops.security_context_references ORDER BY id"
    );
    await client.query("ROLLBACK");
    return result.rows.map(({ id }) => id);
  } finally {
    client.release();
  }
}

async function expectAppInsertDenied(
  pool: pg.Pool,
  statement: string,
  values: unknown[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, {
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.rootSpaceA
    });
    await expect(client.query(statement, values)).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}
