import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations.js";
import { provisionTestAppRole } from "./test-database.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const authoritative = process.env.B2_AUTHORITATIVE_GATE === "1";
const maybeDescribe =
  ownerUrl && appUrl ? describe.sequential : authoritative ? describe : describe.skip;
const allMigrationIds = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql",
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql",
  "0007_b2_slice1_truth_storage.sql",
  "0008_b2_slice1_command_integrity.sql"
] as const;
const truthTables = [
  "accepted_facts",
  "claims",
  "fact_claims",
  "fact_lifecycle_events",
  "verified_evidence_spans"
] as const;

maybeDescribe("Wave B2 PostgreSQL catalog contract", () => {
  if (!ownerUrl || !appUrl) {
    it("requires local PostgreSQL DSNs in the authoritative gate", () => {
      throw new Error("TEST_DATABASE_URL and TEST_APP_DATABASE_URL are required by the B2 gate");
    });
    return;
  }
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  const eventValidator = "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)" as const;
  const auditValidator = "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)" as const;
  const commandValidator =
    "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)" as const;
  const atomicityFunction = "ops.require_b2_slice1_command_atomicity()" as const;

  const expectExactCommandFunctionPrivileges = async () => {
    const privileges = await ownerPool.query<{
      identity: string;
      grantee: string;
      privilege: string;
      grantable: boolean;
    }>(
      `SELECT procedure.oid::regprocedure::text AS identity,
              CASE
                WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl_record.grantee)
              END AS grantee,
              acl_record.privilege_type AS privilege,
              acl_record.is_grantable AS grantable
         FROM pg_proc procedure
         CROSS JOIN LATERAL aclexplode(COALESCE(
           procedure.proacl, acldefault('f', procedure.proowner)
         )) acl_record
        WHERE procedure.oid = ANY($1::regprocedure[])
          AND acl_record.grantee <> procedure.proowner
        ORDER BY procedure.oid::regprocedure::text, grantee, privilege, grantable`,
      [[auditValidator, eventValidator, commandValidator, atomicityFunction]]
    );
    expect(privileges.rows).toEqual([
      {
        identity: auditValidator,
        grantee: "throughline_app",
        privilege: "EXECUTE",
        grantable: false
      },
      {
        identity: eventValidator,
        grantee: "throughline_app",
        privilege: "EXECUTE",
        grantable: false
      },
      {
        identity: eventValidator,
        grantee: "throughline_product_relay",
        privilege: "EXECUTE",
        grantable: false
      },
      {
        identity: commandValidator,
        grantee: "throughline_app",
        privilege: "EXECUTE",
        grantable: false
      }
    ]);
  };

  beforeAll(async () => {
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl);
  }, 60_000);
  afterAll(async () => {
    await appPool.end();
    await ownerPool.end();
  });

  it("accepts and reapplies the exact post-0007 staged B2 checkpoint", async () => {
    try {
      const initial = await applyMigrations(ownerPool, {
        reset: true,
        through: "0007_b2_slice1_truth_storage.sql"
      });
      expect(initial.applied).toEqual(allMigrationIds.slice(0, 7));
      await expect(
        applyMigrations(ownerPool, { through: "0007_b2_slice1_truth_storage.sql" })
      ).resolves.toEqual({
        applied: [],
        skipped: [...allMigrationIds.slice(0, 7)]
      });
    } finally {
      await applyMigrations(ownerPool, { reset: true });
      await provisionTestAppRole(ownerPool, appUrl);
    }
  }, 60_000);

  it("boots fresh and reapplies the exact post-0008 eight-migration checkpoint", async () => {
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });
    const journal = await ownerPool.query<{ id: string }>(
      "SELECT id FROM throughline_migrations.journal ORDER BY id"
    );
    expect(journal.rows.map(({ id }) => id)).toEqual(allMigrationIds);
    await expectExactCommandFunctionPrivileges();
  });

  it("rejects post-0008 qualified trigger condition, function, and deferrability drift", async () => {
    const expectTriggerContractRejected = async (mutation: string) => {
      try {
        await ownerPool.query(mutation);
        await expect(applyMigrations(ownerPool)).rejects.toThrow(
          "Installed B1 catalog does not match exact domain command user-trigger inventory"
        );
      } finally {
        await applyMigrations(ownerPool, { reset: true });
        await provisionTestAppRole(ownerPool, appUrl);
      }
    };

    const qualifiedTriggers = await ownerPool.query<{ name: string; definition: string }>(
      `SELECT trigger_record.tgname AS name,
              pg_get_triggerdef(trigger_record.oid, false) AS definition
       FROM pg_trigger trigger_record
       WHERE trigger_record.tgrelid = 'ops.domain_command_records'::regclass
         AND trigger_record.tgname = ANY($1::text[])
       ORDER BY trigger_record.tgname`,
      [
        [
          "domain_command_records_b1_atomicity_deferred",
          "domain_command_records_b2_slice1_atomicity_deferred"
        ]
      ]
    );
    expect(qualifiedTriggers.rows.map(({ name }) => name)).toEqual([
      "domain_command_records_b1_atomicity_deferred",
      "domain_command_records_b2_slice1_atomicity_deferred"
    ]);
    expect(qualifiedTriggers.rows.every(({ definition }) => definition.includes(" WHEN "))).toBe(
      true
    );

    await expectTriggerContractRejected(`
      DROP TRIGGER domain_command_records_b1_atomicity_deferred
        ON ops.domain_command_records;
      CREATE CONSTRAINT TRIGGER domain_command_records_b1_atomicity_deferred
        AFTER INSERT OR UPDATE ON ops.domain_command_records
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        WHEN (NEW.command_kind IN ('organization.create.v1'))
        EXECUTE FUNCTION ops.require_b1_command_atomicity()
    `);
    await expectTriggerContractRejected(`
      DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
        ON ops.domain_command_records;
      CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
        AFTER INSERT OR UPDATE ON ops.domain_command_records
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        WHEN (NEW.command_kind IN ('claim.create.v1','fact.accept.v1'))
        EXECUTE FUNCTION ops.require_b1_command_atomicity()
    `);
    await expectTriggerContractRejected(`
      DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
        ON ops.domain_command_records;
      CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
        AFTER INSERT OR UPDATE ON ops.domain_command_records
        NOT DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW
        WHEN (NEW.command_kind IN ('claim.create.v1','fact.accept.v1'))
        EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity()
    `);
  }, 120_000);

  it("upgrades an exact B1 database through B2 without rewriting its journal", async () => {
    await applyMigrations(ownerPool, { reset: true, through: "0006_b1_command_integrity.sql" });
    const before = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    );
    const upgraded = await applyMigrations(ownerPool);
    expect(upgraded.applied).toEqual([
      "0007_b2_slice1_truth_storage.sql",
      "0008_b2_slice1_command_integrity.sql"
    ]);
    const after = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id LIMIT 6"
    );
    expect(after.rows).toEqual(before.rows);
    await expectExactCommandFunctionPrivileges();
    await provisionTestAppRole(ownerPool, appUrl);
  });

  it("allows only app writes and product-relay outbox checks to execute B2 validators", async () => {
    const claimId = "0190a000-0000-7000-8000-000000000321";
    const evidenceSpanId = "0190a000-0000-7000-8000-000000000322";
    const payload = JSON.stringify({ claimId, evidenceSpanId });
    const appExecution = await appPool.query<{
      event_valid: boolean;
      audit_valid: boolean;
      command_valid: boolean;
    }>(
      `SELECT
         ops.b2_slice1_event_payload_valid(
           'claim.proposed', 1, $1::uuid, $2::jsonb
         ) AS event_valid,
         ops.b2_slice1_audit_detail_valid(
           'claim.create', 'claim', 1, $1::uuid, $2::jsonb
         ) AS audit_valid,
         ops.product_command_record_valid(
           'claim.create.v1', 1, 'reserved', NULL, NULL, NULL
         ) AS command_valid`,
      [claimId, payload]
    );
    expect(appExecution.rows[0]).toEqual({
      event_valid: true,
      audit_valid: true,
      command_valid: true
    });

    const executeAsRole = async (role: string, statement: string) => {
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        return await client.query(statement, [claimId, payload]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.b2_slice1_event_payload_valid(
           'claim.proposed', 1, $1::uuid, $2::jsonb
         ) AS valid`
      )
    ).resolves.toMatchObject({ rows: [{ valid: true }] });
    for (const role of ["throughline_relay", "throughline_worker"]) {
      await expect(
        executeAsRole(
          role,
          `SELECT ops.b2_slice1_event_payload_valid(
             'claim.proposed', 1, $1::uuid, $2::jsonb
           )`
        )
      ).rejects.toThrow(/permission denied for function b2_slice1_event_payload_valid/);
    }
    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.b2_slice1_audit_detail_valid(
           'claim.create', 'claim', 1, $1::uuid, $2::jsonb
         )`
      )
    ).rejects.toThrow(/permission denied for function b2_slice1_audit_detail_valid/);
    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.product_command_record_valid(
           'claim.create.v1', 1, 'reserved', NULL, NULL, NULL
         )`
      )
    ).rejects.toThrow(/permission denied for function product_command_record_valid/);

    await expectExactCommandFunctionPrivileges();
  });

  it("forces RLS for every truth table and gives no raw truth access to worker/relay", async () => {
    const rls = await ownerPool.query<{
      name: string;
      enabled: boolean;
      forced: boolean;
    }>(
      `SELECT relation.relname AS name, relation.relrowsecurity AS enabled,
              relation.relforcerowsecurity AS forced
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'truth' AND relation.relkind = 'r'
       ORDER BY relation.relname`
    );
    expect(rls.rows.map(({ name }) => name)).toEqual(truthTables);
    expect(rls.rows.every(({ enabled, forced }) => enabled && forced)).toBe(true);

    const policies = await ownerPool.query<{
      table_name: string;
      operation: string;
      using_expression: string | null;
      check_expression: string | null;
    }>(
      `SELECT tablename AS table_name, cmd AS operation, qual AS using_expression,
              with_check AS check_expression
       FROM pg_policies
       WHERE schemaname = 'truth' AND roles = '{throughline_app}'
       ORDER BY tablename, cmd`
    );
    for (const table of truthTables) {
      const select = policies.rows.find(
        (policy) => policy.table_name === table && policy.operation === "SELECT"
      );
      const insert = policies.rows.find(
        (policy) => policy.table_name === table && policy.operation === "INSERT"
      );
      expect(select?.using_expression, `${table} SELECT ceiling`).toContain(
        "access.can_read_space"
      );
      expect(insert?.check_expression, `${table} INSERT ceiling`).toContain(
        "access.can_read_space"
      );
      expect(insert?.check_expression, `${table} INSERT current Space`).toContain(
        "space_id = ops.current_space_id()"
      );
    }

    const raw = await ownerPool.query<{
      relay: boolean;
      worker: boolean;
      product_relay: boolean;
    }>(
      `SELECT has_table_privilege(
                'throughline_relay','truth.accepted_facts','SELECT'
              ) AS relay,
              has_table_privilege(
                'throughline_worker','truth.accepted_facts','SELECT'
              ) AS worker,
              has_table_privilege(
                'throughline_product_relay','truth.claims','SELECT'
              ) AS product_relay`
    );
    expect(raw.rows[0]).toEqual({ relay: false, worker: false, product_relay: false });
  });

  it("accepts the clean PUBLIC ACLs and rejects a deliberate PUBLIC truth-table grant", async () => {
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });

    await ownerPool.query("GRANT SELECT ON truth.claims TO PUBLIC");
    try {
      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        "B2 Slice 1 truth role isolation drifted"
      );
    } finally {
      await ownerPool.query("REVOKE SELECT ON truth.claims FROM PUBLIC");
    }

    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });
  });

  it("denies an app-role raw mutation without a transaction-scoped tenant and Space", async () => {
    await expect(
      appPool.query(
        `INSERT INTO truth.accepted_facts (
        id, tenant_id, workspace_id, space_id, subject_type, subject_id,
        predicate_catalog_version, predicate,
        value_json, value_hash, normalized_text, confidence, recorded_at, status, access_class,
        accepted_by_user_id, accepted_by_membership_id, acceptance_scope, authority_basis,
        acceptance_policy_version, last_causation_command_id
      ) VALUES (
        '0190a000-0000-7000-8000-000000000091','0190a000-0000-7000-8000-000000000092',
        '0190a000-0000-7000-8000-000000000093','0190a000-0000-7000-8000-000000000094',
        'activity','0190a000-0000-7000-8000-000000000095',
        'truth-predicate-catalog.v1','activity.outcome',
        '"forged"'::jsonb,repeat('a',64),'forged','confirmed',clock_timestamp(),'current','workspace',
        '0190a000-0000-7000-8000-000000000096','0190a000-0000-7000-8000-000000000097',
        'engagement','activity_owner','default-v1',
        '0190a000-0000-7000-8000-000000000098'
      )`
      )
    ).rejects.toThrow();
  });
});
