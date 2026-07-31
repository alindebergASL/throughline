import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations.js";
import { seedWaveA2DeterministicData } from "./seed.js";
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
  "0008_b2_slice1_command_integrity.sql",
  "0009_b2_source_truth_lifecycle_interlock.sql"
] as const;
const truthTables = ["accepted_facts", "claims", "fact_claims", "verified_evidence_spans"] as const;

maybeDescribe("Wave B2 PostgreSQL catalog contract", () => {
  if (!ownerUrl || !appUrl) {
    it("requires local PostgreSQL DSNs in the authoritative gate", () => {
      throw new Error("TEST_DATABASE_URL and TEST_APP_DATABASE_URL are required by the B2 gate");
    });
    return;
  }
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
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

  const resetToLatest = () => applyMigrations(ownerPool, { reset: true });

  const restoreProductionAppRole = () =>
    ownerPool.query(`
      DO $restore$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'throughline_app') THEN
          ALTER ROLE throughline_app
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOBYPASSRLS PASSWORD NULL;
        END IF;
      END
      $restore$
    `);

  const withTestAppPool = async <T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> => {
    await provisionTestAppRole(ownerPool, appUrl);
    const appPool = new pg.Pool({ connectionString: appUrl });
    try {
      return await run(appPool);
    } finally {
      try {
        await appPool.end();
      } finally {
        await restoreProductionAppRole();
      }
    }
  };

  const executeAsRole = async (role: string, statement: string, values: unknown[] = []) => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      return await client.query(statement, values);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  afterAll(async () => {
    try {
      await restoreProductionAppRole();
    } finally {
      await ownerPool.end();
    }
  });

  it("accepts and reapplies the exact post-0007 staged B2 checkpoint", async () => {
    try {
      const initial = await applyMigrations(ownerPool, {
        reset: true,
        through: "0007_b2_slice1_truth_storage.sql"
      });
      expect(initial.applied).toEqual(allMigrationIds.slice(0, 7));
      const phaseOneCapability = await ownerPool.query<{
        schema_usage: boolean;
        table_select: boolean;
      }>(
        `SELECT
           has_schema_privilege(
             'throughline_b1_0_integrity','truth','USAGE'
           ) AS schema_usage,
           has_table_privilege(
             'throughline_b1_0_integrity','truth.accepted_facts','SELECT'
           ) AS table_select`
      );
      expect(phaseOneCapability.rows[0]).toEqual({
        schema_usage: false,
        table_select: false
      });
      await expect(
        applyMigrations(ownerPool, { through: "0007_b2_slice1_truth_storage.sql" })
      ).resolves.toEqual({
        applied: [],
        skipped: [...allMigrationIds.slice(0, 7)]
      });
    } finally {
      await resetToLatest();
    }
  }, 60_000);

  it("boots fresh and reapplies the exact post-0009 nine-migration checkpoint", async () => {
    await resetToLatest();
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });
    const journal = await ownerPool.query<{ id: string }>(
      "SELECT id FROM throughline_migrations.journal ORDER BY id"
    );
    expect(journal.rows.map(({ id }) => id)).toEqual(allMigrationIds);
    await expectExactCommandFunctionPrivileges();
  }, 60_000);

  it("rejects post-0009 trigger, function-source, and deferrability drift", async () => {
    await resetToLatest();
    const expectCatalogContractRejected = async (mutation: string, expectedDiagnostic: string) => {
      try {
        await ownerPool.query(mutation);
        await expect(applyMigrations(ownerPool)).rejects.toThrow(expectedDiagnostic);
      } finally {
        await resetToLatest();
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

    await expectCatalogContractRejected(
      `
        DROP TRIGGER domain_command_records_b1_atomicity_deferred
          ON ops.domain_command_records;
        CREATE CONSTRAINT TRIGGER domain_command_records_b1_atomicity_deferred
          AFTER INSERT OR UPDATE ON ops.domain_command_records
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          WHEN (NEW.command_kind IN ('organization.create.v1'))
          EXECUTE FUNCTION ops.require_b1_command_atomicity()
      `,
      "Installed B1 catalog does not match exact domain command user-trigger inventory"
    );
    await expectCatalogContractRejected(
      `
        DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          ON ops.domain_command_records;
        CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          AFTER INSERT OR UPDATE ON ops.domain_command_records
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          WHEN (NEW.command_kind IN ('claim.create.v1','fact.accept.v1'))
          EXECUTE FUNCTION ops.require_b1_command_atomicity()
      `,
      "Installed B1 catalog does not match exact domain command user-trigger inventory"
    );
    await expectCatalogContractRejected(
      `
        DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          ON ops.domain_command_records;
        CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          AFTER INSERT OR UPDATE ON ops.domain_command_records
          NOT DEFERRABLE INITIALLY IMMEDIATE
          FOR EACH ROW
          WHEN (NEW.command_kind IN ('claim.create.v1','fact.accept.v1'))
          EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity()
      `,
      "Installed B1 catalog does not match exact domain command constraint inventory"
    );
    await expectCatalogContractRejected(
      `
        CREATE OR REPLACE FUNCTION ops.require_b2_slice1_command_atomicity()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $function$
        BEGIN
          RETURN NULL;
        END
        $function$
      `,
      "B2 Slice 1 command function ownership or execution shape drifted"
    );
    await expectCatalogContractRejected(
      `
        CREATE OR REPLACE FUNCTION truth.validate_fact_support()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $function$
        DECLARE
          selected_fact_id uuid;
        BEGIN
          selected_fact_id := CASE TG_TABLE_NAME
            WHEN 'accepted_facts' THEN NEW.id
            ELSE NEW.fact_id
          END;
          RETURN NEW;
        END
        $function$
      `,
      "B2 Slice 1 truth function execution shape or source drifted"
    );
  }, 120_000);

  it("upgrades an exact B1 database through B2 without rewriting its journal", async () => {
    await applyMigrations(ownerPool, { reset: true, through: "0006_b1_command_integrity.sql" });
    const before = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    );
    const upgraded = await applyMigrations(ownerPool);
    expect(upgraded.applied).toEqual([
      "0007_b2_slice1_truth_storage.sql",
      "0008_b2_slice1_command_integrity.sql",
      "0009_b2_source_truth_lifecycle_interlock.sql"
    ]);
    const after = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id LIMIT 6"
    );
    expect(after.rows).toEqual(before.rows);
    await expectExactCommandFunctionPrivileges();
  }, 120_000);

  it("upgrades valid populated exact-0008 truth into canonical text without changing history", async () => {
    await applyMigrations(ownerPool, {
      reset: true,
      through: "0008_b2_slice1_command_integrity.sql"
    });
    await insertExact0008TruthFixture(ownerPool);
    await expectExact0008ReferencesValid(ownerPool);
    const beforeCounts = await exact0008RowCounts(ownerPool);
    expect(beforeCounts).toEqual({
      evidence: "1",
      claims: "1",
      facts: "1",
      support: "1"
    });
    const legacyValues = await ownerPool.query<{
      relation: string;
      semantic_value: string;
      json_type: string;
      hash_matches_v1_json: boolean;
    }>(
      `SELECT 'claim' AS relation, value_json #>> '{}' AS semantic_value,
              jsonb_typeof(value_json) AS json_type,
              value_hash = encode(
                public.digest(convert_to(value_json::text, 'UTF8'), 'sha256'
              ), 'hex') AS hash_matches_v1_json
         FROM truth.claims
       UNION ALL
       SELECT 'fact', value_json #>> '{}', jsonb_typeof(value_json),
              value_hash = encode(
                public.digest(convert_to(value_json::text, 'UTF8'), 'sha256'
              ), 'hex')
         FROM truth.accepted_facts
       ORDER BY relation`
    );
    expect(legacyValues.rows).toEqual([
      {
        relation: "claim",
        semantic_value: "Adopted canonical value",
        json_type: "string",
        hash_matches_v1_json: true
      },
      {
        relation: "fact",
        semantic_value: "Adopted canonical value",
        json_type: "string",
        hash_matches_v1_json: true
      }
    ]);
    const beforeJournal = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    );

    await expect(applyMigrations(ownerPool)).resolves.toMatchObject({
      applied: ["0009_b2_source_truth_lifecycle_interlock.sql"]
    });

    const values = await ownerPool.query<{
      relation: string;
      canonical_value_text: string;
      hash_matches: boolean;
    }>(
      `SELECT 'claim' AS relation, canonical_value_text,
              value_hash = encode(
                public.digest(convert_to(canonical_value_text, 'UTF8'), 'sha256'
              ), 'hex') AS hash_matches
         FROM truth.claims
       UNION ALL
       SELECT 'fact', canonical_value_text,
              value_hash = encode(
                public.digest(convert_to(canonical_value_text, 'UTF8'), 'sha256'
              ), 'hex')
         FROM truth.accepted_facts
       ORDER BY relation`
    );
    expect(values.rows).toEqual([
      { relation: "claim", canonical_value_text: "Adopted canonical value", hash_matches: true },
      { relation: "fact", canonical_value_text: "Adopted canonical value", hash_matches: true }
    ]);
    expect(await exact0008RowCounts(ownerPool)).toEqual(beforeCounts);
    const afterJournal = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal WHERE id <> $1 ORDER BY id",
      ["0009_b2_source_truth_lifecycle_interlock.sql"]
    );
    expect(afterJournal.rows).toEqual(beforeJournal.rows);
  }, 120_000);

  it("executes the additive Fact-support validator from both shared trigger relations", async () => {
    try {
      await applyMigrations(ownerPool, {
        reset: true,
        through: "0008_b2_slice1_command_integrity.sql"
      });
      await insertExact0008TruthFixture(ownerPool);
      await applyMigrations(ownerPool);

      const factClient = await ownerPool.connect();
      try {
        await factClient.query("BEGIN");
        await factClient.query(
          "ALTER TABLE truth.accepted_facts DISABLE TRIGGER accepted_facts_command_guard"
        );
        await factClient.query(
          "ALTER TABLE truth.accepted_facts DISABLE TRIGGER accepted_facts_insert_guard"
        );
        await factClient.query(
          `INSERT INTO truth.accepted_facts (
             id, tenant_id, workspace_id, space_id, subject_type, subject_id,
             predicate_catalog_version, predicate, canonical_value_text, value_hash,
             normalized_text, confidence, confidence_rule, strongest_supporting_confidence,
             human_lowered, confidence_lowering_reason_code, confidence_lowering_rationale,
             valid_from, valid_to, recorded_at, status, access_class,
             accepted_by_user_id, accepted_by_membership_id, acceptance_scope,
             authority_basis, acceptance_policy_version, last_causation_command_id,
             created_at, updated_at, version
           )
           SELECT $1, tenant_id, workspace_id, space_id, subject_type, $2,
                  predicate_catalog_version, predicate, canonical_value_text, value_hash,
                  normalized_text, confidence, confidence_rule, strongest_supporting_confidence,
                  human_lowered, confidence_lowering_reason_code, confidence_lowering_rationale,
                  valid_from, valid_to, recorded_at, status, access_class,
                  accepted_by_user_id, accepted_by_membership_id, acceptance_scope,
                  authority_basis, acceptance_policy_version, last_causation_command_id,
                  created_at, updated_at, version
             FROM truth.accepted_facts
            WHERE id = $3`,
          [
            "0190a000-0000-7000-8000-000000000411",
            "0190a000-0000-7000-8000-000000000412",
            adoptionIds.fact
          ]
        );
        const unsupportedFactError = await factClient
          .query("SET CONSTRAINTS truth.accepted_facts_support_deferred IMMEDIATE")
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(unsupportedFactError).toMatchObject({
          code: "P0001",
          message: "accepted fact support is invalid"
        });
      } finally {
        await factClient.query("ROLLBACK");
        factClient.release();
      }

      const supportClient = await ownerPool.connect();
      try {
        await supportClient.query("BEGIN");
        await supportClient.query("ALTER TABLE truth.claims DISABLE TRIGGER claims_command_guard");
        await supportClient.query("ALTER TABLE truth.claims DISABLE TRIGGER claims_insert_guard");
        await supportClient.query(
          "ALTER TABLE truth.fact_claims DISABLE TRIGGER fact_claims_command_guard"
        );
        await supportClient.query(
          `INSERT INTO truth.claims (
             id, tenant_id, workspace_id, space_id, subject_type, subject_id,
             predicate_catalog_version, predicate, canonical_value_text, value_hash,
             normalized_text, verified_evidence_span_id, asserted_by_type, asserted_by_id,
             confidence, valid_from, valid_to, observed_at, status, access_class,
             created_by_user_id, created_by_membership_id, causation_command_id,
             created_at, updated_at, version
           )
           SELECT $1, tenant_id, workspace_id, space_id, subject_type, subject_id,
                  predicate_catalog_version, predicate, canonical_value_text, value_hash,
                  normalized_text, verified_evidence_span_id, asserted_by_type, asserted_by_id,
                  confidence, valid_from, valid_to, observed_at, status, access_class,
                  created_by_user_id, created_by_membership_id, causation_command_id,
                  created_at, updated_at, version
             FROM truth.claims
            WHERE id = $2`,
          ["0190a000-0000-7000-8000-000000000413", adoptionIds.claim]
        );
        await supportClient.query(
          `INSERT INTO truth.fact_claims (
             tenant_id, workspace_id, space_id, fact_id, claim_id
           ) VALUES ($1,$2,$3,$4,$5)`,
          [
            adoptionIds.tenant,
            adoptionIds.workspace,
            adoptionIds.space,
            adoptionIds.fact,
            "0190a000-0000-7000-8000-000000000413"
          ]
        );
        await expect(
          supportClient.query("SET CONSTRAINTS truth.fact_claims_support_deferred IMMEDIATE")
        ).resolves.toBeDefined();
      } finally {
        await supportClient.query("ROLLBACK");
        supportClient.release();
      }
    } finally {
      await resetToLatest();
    }
  }, 120_000);

  it.each([
    ["corrected source", "correction"],
    ["retained-hash tombstone", "retained"],
    ["erased-hash tombstone", "erased"],
    ["missing referenced chunk", "missing_chunk"]
  ] as const)(
    "atomically rejects exact-0008 adoption with a %s",
    async (_label, mutation) => {
      await applyMigrations(ownerPool, {
        reset: true,
        through: "0008_b2_slice1_command_integrity.sql"
      });
      await insertExact0008TruthFixture(ownerPool);
      await mutateExact0008Evidence(ownerPool, mutation);
      await expectExact0008ReferencesValid(ownerPool);
      const before = await exact0008Digest(ownerPool);

      const adoptionError = await applyMigrations(ownerPool).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(adoptionError).toMatchObject({
        code: "P0001",
        message: "Existing truth evidence cannot adopt the B2 lifecycle interlock"
      });

      expect(await exact0008Digest(ownerPool)).toBe(before);
      const state = await ownerPool.query<{
        journal: string | null;
        canonical_column: string | null;
        lifecycle_function: string | null;
        lifecycle_triggers: string;
      }>(
        `SELECT
         (SELECT id FROM throughline_migrations.journal
           WHERE id = '0009_b2_source_truth_lifecycle_interlock.sql') AS journal,
         (SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'truth' AND table_name = 'claims'
             AND column_name = 'canonical_value_text') AS canonical_column,
         to_regprocedure('ops.enforce_b2_source_truth_lifecycle_interlock()')::text
           AS lifecycle_function,
         (SELECT count(*)::text FROM pg_trigger
           WHERE tgname LIKE '%_z_b2_%_interlock') AS lifecycle_triggers`
      );
      expect(state.rows[0]).toEqual({
        journal: null,
        canonical_column: null,
        lifecycle_function: null,
        lifecycle_triggers: "0"
      });
    },
    120_000
  );

  it("allows only app writes and product-relay outbox checks to execute B2 validators", async () => {
    await resetToLatest();
    const claimId = "0190a000-0000-7000-8000-000000000321";
    const evidenceSpanId = "0190a000-0000-7000-8000-000000000322";
    const payload = JSON.stringify({ claimId, evidenceSpanId });
    const appExecution = await withTestAppPool((appPool) =>
      appPool.query<{
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
      )
    );
    expect(appExecution.rows[0]).toEqual({
      event_valid: true,
      audit_valid: true,
      command_valid: true
    });
    const restoredAppRole = await ownerPool.query<{ login: boolean }>(
      "SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = 'throughline_app'"
    );
    expect(restoredAppRole.rows).toEqual([{ login: false }]);
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });

    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.b2_slice1_event_payload_valid(
           'claim.proposed', 1, $1::uuid, $2::jsonb
         ) AS valid`,
        [claimId, payload]
      )
    ).resolves.toMatchObject({ rows: [{ valid: true }] });
    for (const role of ["throughline_relay", "throughline_worker"]) {
      await expect(
        executeAsRole(
          role,
          `SELECT ops.b2_slice1_event_payload_valid(
             'claim.proposed', 1, $1::uuid, $2::jsonb
           )`,
          [claimId, payload]
        )
      ).rejects.toThrow(/permission denied for function b2_slice1_event_payload_valid/);
    }
    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.b2_slice1_audit_detail_valid(
           'claim.create', 'claim', 1, $1::uuid, $2::jsonb
         )`,
        [claimId, payload]
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
  }, 60_000);

  it("forces RLS for every truth table and gives no raw truth access to worker/relay", async () => {
    await resetToLatest();
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

    const integrity = await ownerPool.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT table_name,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'SELECT'
              ) AS can_select,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'INSERT'
              ) AS can_insert,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'UPDATE'
              ) AS can_update,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'DELETE'
              ) AS can_delete
         FROM unnest($1::text[]) table_name
        ORDER BY table_name`,
      [[...truthTables]]
    );
    expect(integrity.rows).toEqual(
      [...truthTables].sort().map((table_name) => ({
        table_name,
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false
      }))
    );

    const excluded = await ownerPool.query<{
      lifecycle_table: string | null;
      reconciliation_function: string | null;
      source_truth_triggers: string;
    }>(
      `SELECT
         to_regclass('truth.fact_lifecycle_events')::text AS lifecycle_table,
         to_regprocedure('truth.reconcile_source_retention()')::text
           AS reconciliation_function,
         (SELECT count(*)::text
            FROM pg_trigger trigger_record
            JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
            JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
           WHERE trigger_record.tgrelid = 'content.source_artifacts'::regclass
             AND NOT trigger_record.tgisinternal
             AND namespace.nspname = 'truth') AS source_truth_triggers`
    );
    expect(excluded.rows[0]).toEqual({
      lifecycle_table: null,
      reconciliation_function: null,
      source_truth_triggers: "0"
    });
  }, 60_000);

  it("pins the lifecycle interlock owner, safe search path, direct ACLs, and exact triggers", async () => {
    await resetToLatest();
    const identity = "ops.enforce_b2_source_truth_lifecycle_interlock()";
    const shape = await ownerPool.query<{
      owner: string;
      security_definer: boolean;
      configuration: string[];
      public_execute: boolean;
      app_execute: boolean;
    }>(
      `SELECT pg_get_userbyid(procedure.proowner) AS owner,
              procedure.prosecdef AS security_definer,
              COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration,
              EXISTS (
                SELECT 1
                  FROM aclexplode(COALESCE(
                    procedure.proacl, acldefault('f', procedure.proowner)
                  )) acl
                 WHERE acl.grantee = 0
                   AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_function_privilege('throughline_app', procedure.oid, 'EXECUTE') AS app_execute
         FROM pg_proc procedure
        WHERE procedure.oid = $1::regprocedure`,
      [identity]
    );
    expect(shape.rows).toEqual([
      {
        owner: "throughline_b1_0_integrity",
        security_definer: true,
        configuration: ["search_path=pg_catalog"],
        public_execute: false,
        app_execute: false
      }
    ]);

    const serializationSources = await ownerPool.query<{ identity: string; source: string }>(
      `SELECT procedure.oid::regprocedure::text AS identity,
              procedure.prosrc AS source
         FROM pg_proc procedure
        WHERE procedure.oid = ANY($1::regprocedure[])
        ORDER BY procedure.oid::regprocedure::text`,
      [[identity, "truth.verify_evidence_snapshot()"]]
    );
    expect(
      serializationSources.rows.map(({ identity: functionIdentity }) => functionIdentity)
    ).toEqual([identity, "truth.verify_evidence_snapshot()"]);
    const installedLocks = serializationSources.rows.map(
      ({ source }) =>
        source.match(/PERFORM pg_catalog\.pg_advisory_xact_lock\([\s\S]*?\n {2}\);/)?.[0]
    );
    expect(installedLocks[0]).toContain("'throughline:b2:source-truth:'");
    expect(installedLocks[1]).toBe(installedLocks[0]);
    expect(serializationSources.rows[0]!.source.indexOf(installedLocks[0]!)).toBeLessThan(
      serializationSources.rows[0]!.source.indexOf("EXISTS (")
    );
    expect(serializationSources.rows[1]!.source.indexOf(installedLocks[1]!)).toBeLessThan(
      serializationSources.rows[1]!.source.indexOf("SELECT source.version")
    );

    const triggers = await ownerPool.query<{ name: string; relation: string }>(
      `SELECT trigger_record.tgname AS name,
              trigger_record.tgrelid::regclass::text AS relation
         FROM pg_trigger trigger_record
        WHERE trigger_record.tgfoid = $1::regprocedure
          AND NOT trigger_record.tgisinternal
        ORDER BY trigger_record.tgname`,
      [identity]
    );
    expect(triggers.rows).toEqual([
      {
        name: "source_artifacts_z_b2_correction_interlock",
        relation: "content.source_artifacts"
      },
      {
        name: "source_artifacts_z_b2_tombstone_interlock",
        relation: "content.source_artifacts"
      },
      {
        name: "source_chunks_z_b2_delete_interlock",
        relation: "content.source_chunks"
      }
    ]);
  }, 60_000);

  it("accepts the clean PUBLIC ACLs and rejects a deliberate PUBLIC truth-table grant", async () => {
    await resetToLatest();
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });

    await ownerPool.query("GRANT SELECT ON truth.claims TO PUBLIC");
    try {
      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        "B2 Slice 1 truth table authority drifted"
      );
    } finally {
      await ownerPool.query("REVOKE SELECT ON truth.claims FROM PUBLIC");
    }

    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });
  }, 60_000);

  it("denies an app-role raw mutation without a transaction-scoped tenant and Space", async () => {
    await resetToLatest();
    await expect(
      executeAsRole(
        "throughline_app",
        `INSERT INTO truth.accepted_facts (
        id, tenant_id, workspace_id, space_id, subject_type, subject_id,
        predicate_catalog_version, predicate,
        canonical_value_text, value_hash, normalized_text, confidence,
        confidence_rule, strongest_supporting_confidence, human_lowered,
        recorded_at, status, access_class,
        accepted_by_user_id, accepted_by_membership_id, acceptance_scope, authority_basis,
        acceptance_policy_version, last_causation_command_id
      ) VALUES (
        '0190a000-0000-7000-8000-000000000091','0190a000-0000-7000-8000-000000000092',
        '0190a000-0000-7000-8000-000000000093','0190a000-0000-7000-8000-000000000094',
        'activity','0190a000-0000-7000-8000-000000000095',
        'truth-predicate-catalog.v1','activity.outcome',
        'forged',repeat('a',64),'forged','confirmed',
        'strongest-selected-valid-claim.v1','confirmed',false,
        clock_timestamp(),'current','workspace',
        '0190a000-0000-7000-8000-000000000096','0190a000-0000-7000-8000-000000000097',
        'engagement','activity_owner','default-v1',
        '0190a000-0000-7000-8000-000000000098'
      )`
      )
    ).rejects.toThrow();
  }, 60_000);
});

const adoptionIds = {
  source: "0190a000-0000-7000-8000-000000000401",
  chunk: "0190a000-0000-7000-8000-000000000402",
  command: "0190a000-0000-7000-8000-000000000403",
  factCommand: "0190a000-0000-7000-8000-000000000409",
  evidence: "0190a000-0000-7000-8000-000000000404",
  claim: "0190a000-0000-7000-8000-000000000405",
  fact: "0190a000-0000-7000-8000-000000000406",
  successor: "0190a000-0000-7000-8000-000000000407",
  tenant: "11111111-1111-4111-8111-111111111111",
  workspace: "11111111-1111-4111-8111-111111111112",
  space: "11111111-1111-4111-8111-111111111113",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  membership: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
  person: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  subject: "0190a000-0000-7000-8000-000000000408",
  organization: "0190a000-0000-7000-8000-000000000410"
} as const;

async function insertExact0008TruthFixture(pool: pg.Pool): Promise<void> {
  await seedWaveA2DeterministicData(pool);
  const client = await pool.connect();
  const text = "Adopted canonical value";
  const sourceText = "Adopted evidence";
  try {
    await client.query("BEGIN");
    for (const relation of [
      "work.organizations",
      "work.activities",
      "work.activity_sources",
      "content.source_artifacts",
      "content.source_chunks",
      "ops.domain_command_records",
      "truth.verified_evidence_spans",
      "truth.claims",
      "truth.accepted_facts",
      "truth.fact_claims"
    ]) {
      await client.query(`ALTER TABLE ${relation} DISABLE TRIGGER USER`);
    }
    await client.query(
      `INSERT INTO work.organizations (
         id, tenant_id, workspace_id, space_id, name, normalized_name, status
       ) VALUES ($1,$2,$3,$4,'Adoption Organization','adoption organization','active')`,
      [adoptionIds.organization, adoptionIds.tenant, adoptionIds.workspace, adoptionIds.space]
    );
    await client.query(
      `INSERT INTO work.activities (
         id, tenant_id, workspace_id, space_id, subtype, profile_template_key,
         title, status, owner_person_id, governing_organization_id
       ) VALUES (
         $1,$2,$3,$4,'meeting','meeting','Adoption Activity','captured',$5,$6
       )`,
      [
        adoptionIds.subject,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.person,
        adoptionIds.organization
      ]
    );
    await client.query(
      `INSERT INTO content.source_artifacts (
         id, tenant_id, workspace_id, space_id, source_type, trust_class,
         immutable_text, content_hash, normalization_version, chunking_version,
         normalized_content_hash, hash_retention_policy, captured_by_user_id,
         captured_by_membership_id, access_class, source_snapshot_policy, version
       ) VALUES (
         $1,$2,$3,$4,'note','untrusted_user_content',$5,
         encode(public.digest(convert_to($5, 'UTF8'), 'sha256'), 'hex'),
         'source-normalization.v1','source-chunking.v1',
         encode(public.digest(convert_to($5, 'UTF8'), 'sha256'), 'hex'),
         'retain',$6,$7,'workspace','full_snapshot',1
       )`,
      [
        adoptionIds.source,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        sourceText,
        adoptionIds.user,
        adoptionIds.membership
      ]
    );
    await client.query(
      `INSERT INTO content.source_chunks (
         id, tenant_id, workspace_id, space_id, source_artifact_id,
         normalization_version, chunking_version, chunk_index,
         start_offset, end_offset, normalized_text, content_hash, access_class
       ) VALUES (
         $1,$2,$3,$4,$6,'source-normalization.v1','source-chunking.v1',
         0,0,char_length($5),$5,
         encode(public.digest(convert_to($5, 'UTF8'), 'sha256'), 'hex'),'workspace'
       )`,
      [
        adoptionIds.chunk,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        sourceText,
        adoptionIds.source
      ]
    );
    await client.query(
      `INSERT INTO work.activity_sources (
         tenant_id, workspace_id, space_id, activity_id, source_artifact_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        adoptionIds.source
      ]
    );
    await client.query(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash, state,
         actor_user_id, actor_membership_id, policy_version_id, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,'claim.create.v1',1,'exact-0008-adoption',repeat('a',64),'reserved',
         $5,$6,'default-v1','exact-0008-adoption',
         '00-00000000000000000000000000000001-0000000000000001-01'
       ), (
         $7,$2,$3,$4,'fact.accept.v1',1,'exact-0008-fact',repeat('b',64),'reserved',
         $5,$6,'default-v1','exact-0008-fact',
         '00-00000000000000000000000000000002-0000000000000002-01'
       )`,
      [
        adoptionIds.command,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.factCommand
      ]
    );
    await client.query(
      `INSERT INTO truth.verified_evidence_spans (
         id, tenant_id, workspace_id, space_id, source_artifact_id, source_chunk_id,
         source_version, chunk_version, normalization_version, chunking_version,
         source_start_offset, source_end_offset, source_excerpt,
         source_content_hash, source_normalized_content_hash, chunk_content_hash,
         excerpt_hash, access_class, created_by_user_id, created_by_membership_id,
         causation_command_id
       ) SELECT
         $1,$2,$3,$4,$5,$6,1,1,'source-normalization.v1','source-chunking.v1',
         0,char_length(source.immutable_text),source.immutable_text,
         source.content_hash,source.normalized_content_hash,chunk.content_hash,
         encode(public.digest(convert_to(source.immutable_text, 'UTF8'), 'sha256'), 'hex'),
         'workspace',$7,$8,$9
       FROM content.source_artifacts source
       JOIN content.source_chunks chunk ON chunk.source_artifact_id = source.id
       WHERE source.id = $5 AND chunk.id = $6`,
      [
        adoptionIds.evidence,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.source,
        adoptionIds.chunk,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.command
      ]
    );
    await client.query(
      `INSERT INTO truth.claims (
         id,tenant_id,workspace_id,space_id,subject_type,subject_id,
         predicate_catalog_version,predicate,value_json,value_hash,normalized_text,
         verified_evidence_span_id,asserted_by_type,asserted_by_id,confidence,status,
         access_class,created_by_user_id,created_by_membership_id,causation_command_id,version
       ) VALUES (
         $1,$2,$3,$4,'activity',$5,'truth-predicate-catalog.v1','activity.outcome',
         to_jsonb($6::text),encode(public.digest(convert_to(to_jsonb($6::text)::text,'UTF8'),'sha256'),'hex'),
         $6,$7,'person',$8,'strong','accepted','workspace',$9,$10,$11,2
       )`,
      [
        adoptionIds.claim,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        text,
        adoptionIds.evidence,
        adoptionIds.person,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.command
      ]
    );
    await client.query(
      `INSERT INTO truth.accepted_facts (
         id,tenant_id,workspace_id,space_id,subject_type,subject_id,
         predicate_catalog_version,predicate,value_json,value_hash,normalized_text,
         confidence,confidence_rule,strongest_supporting_confidence,human_lowered,
         recorded_at,status,access_class,accepted_by_user_id,accepted_by_membership_id,
         acceptance_scope,authority_basis,acceptance_policy_version,last_causation_command_id
       ) VALUES (
         $1,$2,$3,$4,'activity',$5,'truth-predicate-catalog.v1','activity.outcome',
         to_jsonb($6::text),encode(public.digest(convert_to(to_jsonb($6::text)::text,'UTF8'),'sha256'),'hex'),
         $6,'strong','strongest-selected-valid-claim.v1','strong',false,clock_timestamp(),
         'current','workspace',$7,$8,'engagement','activity_owner','default-v1',$9
       )`,
      [
        adoptionIds.fact,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        text,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.factCommand
      ]
    );
    await client.query(
      `INSERT INTO truth.fact_claims (
         tenant_id,workspace_id,space_id,fact_id,claim_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.fact,
        adoptionIds.claim
      ]
    );
    for (const relation of [
      "truth.fact_claims",
      "truth.accepted_facts",
      "truth.claims",
      "truth.verified_evidence_spans",
      "ops.domain_command_records",
      "content.source_chunks",
      "content.source_artifacts",
      "work.activity_sources",
      "work.activities",
      "work.organizations"
    ]) {
      await client.query(`ALTER TABLE ${relation} ENABLE TRIGGER USER`);
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function mutateExact0008Evidence(
  pool: pg.Pool,
  mutation: "correction" | "retained" | "erased" | "missing_chunk"
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    if (mutation === "missing_chunk") {
      await client.query("DELETE FROM content.source_chunks WHERE id = $1", [adoptionIds.chunk]);
    } else if (mutation === "correction") {
      await client.query(
        `INSERT INTO content.source_artifacts (
           id,tenant_id,workspace_id,space_id,source_type,trust_class,immutable_text,
           content_hash,normalization_version,chunking_version,normalized_content_hash,
           hash_retention_policy,supersedes_source_id,captured_by_user_id,
           captured_by_membership_id,access_class,source_snapshot_policy,version
         ) SELECT
           $1,tenant_id,workspace_id,space_id,source_type,trust_class,'Corrected evidence',
           encode(public.digest(convert_to('Corrected evidence','UTF8'),'sha256'),'hex'),
           normalization_version,chunking_version,
           encode(public.digest(convert_to('Corrected evidence','UTF8'),'sha256'),'hex'),
           hash_retention_policy,id,captured_by_user_id,captured_by_membership_id,
           access_class,source_snapshot_policy,1
         FROM content.source_artifacts WHERE id = $2`,
        [adoptionIds.successor, adoptionIds.source]
      );
    } else {
      const erased = mutation === "erased";
      await client.query(
        `UPDATE content.source_artifacts
            SET immutable_text = NULL,
                content_hash = CASE WHEN $2 THEN NULL ELSE content_hash END,
                normalized_content_hash = CASE WHEN $2 THEN NULL ELSE normalized_content_hash END,
                hash_retention_policy = CASE WHEN $2 THEN 'erase_on_tombstone' ELSE 'retain' END,
                deleted_at = clock_timestamp(), deletion_reason = 'retention',
                deletion_policy_ref = 'policy:adoption',
                hash_disposition = CASE WHEN $2 THEN 'erased' ELSE 'retained' END,
                version = 2, updated_at = clock_timestamp()
          WHERE id = $1`,
        [adoptionIds.source, erased]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function exact0008Digest(pool: pg.Pool): Promise<string> {
  const relations = [
    "content.source_artifacts",
    "content.source_chunks",
    "truth.verified_evidence_spans",
    "truth.claims",
    "truth.accepted_facts",
    "truth.fact_claims"
  ];
  const rows = [];
  for (const relation of relations) {
    const result = await pool.query(
      `SELECT to_jsonb(row_data) AS row FROM ${relation} row_data ORDER BY to_jsonb(row_data)::text`
    );
    rows.push([relation, result.rows]);
  }
  return JSON.stringify(rows);
}

async function exact0008RowCounts(pool: pg.Pool): Promise<{
  evidence: string;
  claims: string;
  facts: string;
  support: string;
}> {
  const result = await pool.query<{
    evidence: string;
    claims: string;
    facts: string;
    support: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM truth.verified_evidence_spans) AS evidence,
       (SELECT count(*)::text FROM truth.claims) AS claims,
       (SELECT count(*)::text FROM truth.accepted_facts) AS facts,
       (SELECT count(*)::text FROM truth.fact_claims) AS support`
  );
  return result.rows[0]!;
}

async function expectExact0008ReferencesValid(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const result = await client.query<{ invalid_references: string }>(
      `SELECT (
         (SELECT count(*) FROM content.source_artifacts source
           LEFT JOIN identity.workspaces workspace
             ON (workspace.tenant_id, workspace.id) =
                (source.tenant_id, source.workspace_id)
           LEFT JOIN access.spaces space
             ON (space.tenant_id, space.workspace_id, space.id) =
                (source.tenant_id, source.workspace_id, source.space_id)
           LEFT JOIN identity.users actor ON actor.id = source.captured_by_user_id
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (source.tenant_id, source.workspace_id,
                 source.captured_by_membership_id, source.captured_by_user_id)
           LEFT JOIN content.source_artifacts predecessor
             ON (predecessor.tenant_id, predecessor.workspace_id, predecessor.space_id,
                 predecessor.id) =
                (source.tenant_id, source.workspace_id, source.space_id,
                 source.supersedes_source_id)
          WHERE workspace.id IS NULL OR space.id IS NULL OR actor.id IS NULL
             OR membership.id IS NULL
             OR (source.supersedes_source_id IS NOT NULL AND predecessor.id IS NULL))
         +
         (SELECT count(*) FROM content.source_chunks chunk
           LEFT JOIN content.source_artifacts source
             ON (source.tenant_id, source.workspace_id, source.space_id, source.id) =
                (chunk.tenant_id, chunk.workspace_id, chunk.space_id,
                 chunk.source_artifact_id)
          WHERE source.id IS NULL)
         +
         (SELECT count(*) FROM truth.verified_evidence_spans evidence
           LEFT JOIN content.source_artifacts source
             ON (source.tenant_id, source.workspace_id, source.space_id, source.id) =
                (evidence.tenant_id, evidence.workspace_id, evidence.space_id,
                 evidence.source_artifact_id)
           LEFT JOIN identity.users actor ON actor.id = evidence.created_by_user_id
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (evidence.tenant_id, evidence.workspace_id,
                 evidence.created_by_membership_id, evidence.created_by_user_id)
           LEFT JOIN ops.domain_command_records command
             ON (command.tenant_id, command.workspace_id, command.id) =
                (evidence.tenant_id, evidence.workspace_id, evidence.causation_command_id)
          WHERE source.id IS NULL OR actor.id IS NULL OR membership.id IS NULL
             OR command.id IS NULL)
         +
         (SELECT count(*) FROM truth.claims claim
           LEFT JOIN truth.verified_evidence_spans evidence
             ON (evidence.tenant_id, evidence.workspace_id, evidence.space_id, evidence.id) =
                (claim.tenant_id, claim.workspace_id, claim.space_id,
                 claim.verified_evidence_span_id)
           LEFT JOIN identity.people person
             ON (person.tenant_id, person.workspace_id, person.id) =
                (claim.tenant_id, claim.workspace_id, claim.asserted_by_id)
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (claim.tenant_id, claim.workspace_id, claim.created_by_membership_id,
                 claim.created_by_user_id)
           LEFT JOIN ops.domain_command_records command
             ON (command.tenant_id, command.workspace_id, command.id) =
                (claim.tenant_id, claim.workspace_id, claim.causation_command_id)
          WHERE evidence.id IS NULL OR person.id IS NULL OR membership.id IS NULL
             OR command.id IS NULL)
         +
         (SELECT count(*) FROM truth.accepted_facts fact
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (fact.tenant_id, fact.workspace_id, fact.accepted_by_membership_id,
                 fact.accepted_by_user_id)
           LEFT JOIN identity.policy_versions policy
             ON (policy.tenant_id, policy.workspace_id, policy.id) =
                (fact.tenant_id, fact.workspace_id, fact.acceptance_policy_version)
           LEFT JOIN ops.domain_command_records command
             ON (command.tenant_id, command.workspace_id, command.id) =
                (fact.tenant_id, fact.workspace_id, fact.last_causation_command_id)
          WHERE membership.id IS NULL OR policy.id IS NULL OR command.id IS NULL)
         +
         (SELECT count(*) FROM truth.fact_claims support
           LEFT JOIN truth.accepted_facts fact
             ON (fact.tenant_id, fact.workspace_id, fact.space_id, fact.id) =
                (support.tenant_id, support.workspace_id, support.space_id, support.fact_id)
           LEFT JOIN truth.claims claim
             ON (claim.tenant_id, claim.workspace_id, claim.space_id, claim.id) =
                (support.tenant_id, support.workspace_id, support.space_id, support.claim_id)
          WHERE fact.id IS NULL OR claim.id IS NULL)
         +
         (SELECT count(*) FROM work.activity_sources link
           LEFT JOIN work.activities activity
             ON (activity.tenant_id, activity.workspace_id, activity.space_id, activity.id) =
                (link.tenant_id, link.workspace_id, link.space_id, link.activity_id)
           LEFT JOIN content.source_artifacts source
             ON (source.tenant_id, source.workspace_id, source.space_id, source.id) =
                (link.tenant_id, link.workspace_id, link.space_id, link.source_artifact_id)
          WHERE activity.id IS NULL OR source.id IS NULL)
       )::text AS invalid_references`
    );
    expect(result.rows).toEqual([{ invalid_references: "0" }]);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
