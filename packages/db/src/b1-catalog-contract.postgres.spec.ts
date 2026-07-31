import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations as applyRepositoryMigrations } from "./migrations.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const authoritative = process.env.B1_AUTHORITATIVE_GATE === "1";
const maybeDescribe = ownerUrl || authoritative ? describe.sequential : describe.skip;
const b1MigrationIds = [
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql"
] as const;
const migrationIds = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql",
  ...b1MigrationIds
] as const;

function applyMigrations(pool: pg.Pool, options: { reset?: boolean; through?: string } = {}) {
  return applyRepositoryMigrations(pool, {
    ...options,
    through: options.through ?? migrationIds.at(-1)!
  });
}

maybeDescribe("B1 fail-closed migration catalog contract", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });

  beforeAll(async () => {
    if (!ownerUrl) throw new Error("TEST_DATABASE_URL is required by the authoritative B1 gate");
    await applyMigrations(ownerPool, { reset: true });
  }, 60_000);

  afterAll(async () => {
    await ownerPool.end();
  });

  async function reset(): Promise<void> {
    await applyMigrations(ownerPool, { reset: true });
  }

  async function expectScratchCatalogClean(): Promise<void> {
    const scratch = await ownerPool.query<{
      schema_count: string;
      persistent_relation_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM pg_namespace
          WHERE nspname LIKE 'b1_contract_%') AS schema_count,
         (SELECT count(*)::text
          FROM pg_class relation_record
          JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
          WHERE namespace_record.nspname NOT LIKE 'pg_temp_%'
            AND relation_record.relname LIKE 'b1_contract_%') AS persistent_relation_count`
    );
    expect(scratch.rows[0]).toEqual({ schema_count: "0", persistent_relation_count: "0" });
  }

  async function expectJournaledCatalogRejected(mutation: string): Promise<void> {
    try {
      await ownerPool.query(mutation);
      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        /catalog|B1|journal|capability|authority|does not exist|Unexpected rewrite rule/i
      );
      const journal = await ownerPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM throughline_migrations.journal
         WHERE id = ANY($1::text[])`,
        [b1MigrationIds]
      );
      expect(journal.rows[0]?.count).toBe("3");
    } finally {
      await reset();
    }
  }

  for (const [checkpoint, expectedCount] of [
    [b1MigrationIds[0], 4],
    [b1MigrationIds[1], 5]
  ] as const) {
    it(`accepts the exact ${checkpoint.slice(0, 4)} journal checkpoint`, async () => {
      try {
        const initial = await applyMigrations(ownerPool, { reset: true, through: checkpoint });
        expect(initial.applied).toEqual(migrationIds.slice(0, expectedCount));
        const reapplied = await applyMigrations(ownerPool, { through: checkpoint });
        expect(reapplied).toEqual({
          applied: [],
          skipped: [...migrationIds.slice(0, expectedCount)]
        });
        await expectScratchCatalogClean();
      } finally {
        await reset();
      }
    }, 60_000);
  }

  it("accepts exact 0006/full reapplication without persistent scratch or search_path drift", async () => {
    await reset();
    const before = await ownerPool.query<{ search_path: string }>(
      "SELECT current_setting('search_path') AS search_path"
    );
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...migrationIds]
    });
    const after = await ownerPool.query<{ search_path: string }>(
      "SELECT current_setting('search_path') AS search_path"
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await expectScratchCatalogClean();
  }, 60_000);

  it("rejects unknown IDs and checksum drift before selecting a migration range", async () => {
    await ownerPool.query(
      `INSERT INTO throughline_migrations.journal (id, checksum)
       VALUES ('9999_unreviewed.sql', repeat('0', 64))`
    );
    await expect(
      applyMigrations(ownerPool, { through: "0003_b1_0_canonical_product_outbox.sql" })
    ).rejects.toThrow("Unexpected migration journal id 9999_unreviewed.sql");
    await reset();

    await ownerPool.query(
      `UPDATE throughline_migrations.journal SET checksum = repeat('f', 64)
       WHERE id = '0006_b1_command_integrity.sql'`
    );
    await expect(
      applyMigrations(ownerPool, { through: "0003_b1_0_canonical_product_outbox.sql" })
    ).rejects.toThrow("Migration checksum mismatch for 0006_b1_command_integrity.sql");
    await reset();
  }, 60_000);

  it("fails closed on missing, gapped, reordered, and physically duplicated journal rows", async () => {
    await ownerPool.query(
      "DELETE FROM throughline_migrations.journal WHERE id = '0002_foundation_closure_async_isolation.sql'"
    );
    await expect(
      applyMigrations(ownerPool, { through: "0001_wave_a2_identity_access_rls.sql" })
    ).rejects.toThrow(
      "Migration journal is not an exact contiguous prefix of the known migration catalog"
    );
    await reset();

    await ownerPool.query(
      "DELETE FROM throughline_migrations.journal WHERE id = '0006_b1_command_integrity.sql'"
    );
    await expect(applyMigrations(ownerPool)).rejects.toThrow(/catalog|B1|journal|capability/i);
    await reset();

    await ownerPool.query(
      "DELETE FROM throughline_migrations.journal WHERE id = '0005_b1_content_sources.sql'"
    );
    await expect(applyMigrations(ownerPool)).rejects.toThrow(
      "Migration journal is not an exact contiguous prefix of the known migration catalog"
    );
    await reset();

    await ownerPool.query(`UPDATE throughline_migrations.journal
      SET applied_at = CASE id
        WHEN '0004_b1_work_graph.sql' THEN clock_timestamp() + interval '2 minutes'
        WHEN '0005_b1_content_sources.sql' THEN clock_timestamp() + interval '1 minute'
        WHEN '0006_b1_command_integrity.sql' THEN clock_timestamp() + interval '3 minutes'
        ELSE applied_at END`);
    await expect(applyMigrations(ownerPool)).rejects.toThrow(
      "Migration journal order does not match the fixed migration order"
    );
    await reset();

    const checksum = await ownerPool.query<{ checksum: string }>(
      "SELECT checksum FROM throughline_migrations.journal WHERE id = $1",
      [b1MigrationIds[0]]
    );
    await expect(
      ownerPool.query("INSERT INTO throughline_migrations.journal (id, checksum) VALUES ($1, $2)", [
        b1MigrationIds[0],
        checksum.rows[0]!.checksum
      ])
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  }, 180_000);

  for (const migrationId of b1MigrationIds) {
    it(`refuses exact but unjournaled installed state for ${migrationId}`, async () => {
      await applyMigrations(ownerPool, { reset: true, through: migrationId });
      await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
        migrationId
      ]);
      await expect(applyMigrations(ownerPool, { through: migrationId })).rejects.toThrow(
        /catalog|B1|journal|Unjournaled/i
      );
      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );
      expect(journal.rows[0]?.count).toBe("0");
      await reset();
    }, 60_000);
  }

  it("rejects missing and extra migration-owned tables", async () => {
    await expectJournaledCatalogRejected("DROP TABLE work.organization_domains CASCADE");
    await expectJournaledCatalogRejected("CREATE TABLE work.unreviewed_successor_object (id uuid)");
  }, 60_000);

  it("rejects every unexpected work/content pg_class kind, including ACL-bearing sequences", async () => {
    for (const mutation of [
      `CREATE SEQUENCE work.unreviewed_sequence;
       GRANT USAGE ON SEQUENCE work.unreviewed_sequence TO PUBLIC;
       GRANT SELECT ON SEQUENCE work.unreviewed_sequence TO throughline_worker`,
      "CREATE VIEW content.unreviewed_view AS SELECT id FROM content.content_items",
      "CREATE MATERIALIZED VIEW work.unreviewed_materialized AS SELECT id FROM work.organizations",
      "CREATE TYPE content.unreviewed_composite AS (id uuid, note text)",
      `CREATE TABLE work.unreviewed_partitioned (id uuid NOT NULL)
       PARTITION BY HASH (id)`
    ]) {
      await expectJournaledCatalogRejected(mutation);
    }
  }, 180_000);

  it("rejects column type/default/not-null/generated drift", async () => {
    await expectJournaledCatalogRejected(`
      ALTER TABLE work.organizations ALTER COLUMN name TYPE varchar(300);
      ALTER TABLE work.organizations ALTER COLUMN version DROP NOT NULL;
      ALTER TABLE work.organizations ALTER COLUMN version SET DEFAULT 2;
      ALTER TABLE work.organizations ADD COLUMN generated_probe integer
        GENERATED ALWAYS AS (version + 1) STORED
    `);
  }, 60_000);

  it("rejects malformed or extra constraints and indexes", async () => {
    await expectJournaledCatalogRejected(`
      ALTER TABLE work.organizations DROP CONSTRAINT organizations_status_check;
      ALTER TABLE work.organizations ADD CONSTRAINT organizations_status_check
        CHECK (status IN ('active', 'archived', 'unreviewed'))
    `);
    await expectJournaledCatalogRejected(`
      DROP INDEX work.organizations_space_idx;
      CREATE INDEX organizations_space_idx ON work.organizations (tenant_id)
    `);
  }, 60_000);

  it("rejects the complete extra domain-command constraint inventory", async () => {
    for (const mutation of [
      `ALTER TABLE ops.domain_command_records
       ADD CONSTRAINT command_records_unreviewed_check CHECK (length(state) > 0)`,
      `ALTER TABLE ops.domain_command_records
       ADD CONSTRAINT command_records_unreviewed_unique UNIQUE (id, state)`,
      `ALTER TABLE ops.domain_command_records
       ADD CONSTRAINT command_records_unreviewed_fk FOREIGN KEY (id)
       REFERENCES ops.domain_command_records(id)`,
      `ALTER TABLE ops.domain_command_records
       ADD CONSTRAINT command_records_unreviewed_exclusion
       EXCLUDE USING gist (tstzrange(created_at, updated_at, '[]') WITH &&)`
    ]) {
      await expectJournaledCatalogRejected(mutation);
    }
  }, 180_000);

  it("rejects differently named, disabled, or altered domain-command triggers and rules", async () => {
    await expectJournaledCatalogRejected(`
      CREATE FUNCTION ops.unreviewed_command_trigger() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
        BEGIN RETURN NEW; END
        $function$;
      CREATE TRIGGER command_records_unreviewed_trigger
        BEFORE INSERT ON ops.domain_command_records
        FOR EACH ROW EXECUTE FUNCTION ops.unreviewed_command_trigger()
    `);
    await expectJournaledCatalogRejected(
      "ALTER TABLE ops.domain_command_records DISABLE TRIGGER domain_command_records_transition_guard"
    );
    await expectJournaledCatalogRejected(
      "ALTER TABLE ops.domain_command_records ENABLE REPLICA TRIGGER domain_command_records_transition_guard"
    );
    await expectJournaledCatalogRejected(
      "ALTER FUNCTION ops.enforce_domain_command_transition() SECURITY DEFINER"
    );
    await expectJournaledCatalogRejected(`
      CREATE RULE command_records_unreviewed_rule AS
        ON INSERT TO ops.domain_command_records DO INSTEAD NOTHING
    `);
  }, 180_000);

  it("validates exact B1 foreign keys through a transaction-local scratch catalog", async () => {
    await applyMigrations(ownerPool);
    await expectScratchCatalogClean();

    await ownerPool.query(`
      DO $mutation$
      DECLARE foreign_key_name name;
      BEGIN
        SELECT constraint_record.conname INTO STRICT foreign_key_name
        FROM pg_constraint constraint_record
        WHERE constraint_record.conrelid = 'work.organization_domains'::regclass
          AND constraint_record.contype = 'f';
        EXECUTE format(
          'ALTER TABLE work.organization_domains DROP CONSTRAINT %I',
          foreign_key_name
        );
      END
      $mutation$;
      ALTER TABLE work.organization_domains
        ADD CONSTRAINT organization_domains_wrong_scope_fk
        FOREIGN KEY (tenant_id, workspace_id, organization_id)
        REFERENCES work.organizations(tenant_id, workspace_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    `);
    await expect(applyMigrations(ownerPool)).rejects.toThrow(/catalog|B1/i);
    await expectScratchCatalogClean();
    await reset();
  }, 60_000);

  it("rejects policy role/command/permissiveness/USING/WITH CHECK drift", async () => {
    await expectJournaledCatalogRejected(`
      DROP POLICY activities_app_source_capture_lock ON work.activities;
      CREATE POLICY activities_app_source_capture_lock ON work.activities
        AS RESTRICTIVE FOR UPDATE TO throughline_worker
        USING (true) WITH CHECK (true)
    `);
  }, 60_000);

  it("rejects a required Activity table or column grant being removed", async () => {
    for (const mutation of [
      "REVOKE SELECT ON work.activities FROM throughline_app",
      "REVOKE INSERT ON work.activities FROM throughline_app",
      "REVOKE UPDATE (id) ON work.activities FROM throughline_app"
    ]) {
      await expectJournaledCatalogRejected(mutation);
    }
  }, 180_000);

  it("rejects table UPDATE and UPDATE on any Activity column except id", async () => {
    await expectJournaledCatalogRejected("GRANT UPDATE ON work.activities TO throughline_app");
    await expectJournaledCatalogRejected(
      "GRANT UPDATE (title) ON work.activities TO throughline_app"
    );
  }, 120_000);

  it("rejects every forbidden Activity table privilege and unexpected column SELECT", async () => {
    for (const mutation of [
      "GRANT DELETE ON work.activities TO throughline_app",
      "GRANT TRUNCATE ON work.activities TO throughline_app",
      "GRANT REFERENCES ON work.activities TO throughline_app",
      "GRANT TRIGGER ON work.activities TO throughline_app",
      "GRANT SELECT (id) ON work.activities TO throughline_app"
    ]) {
      await expectJournaledCatalogRejected(mutation);
    }
  }, 180_000);

  it("rejects PUBLIC, rogue-role, recursive-inheritance, and grant-option paths", async () => {
    for (const mutation of [
      "GRANT SELECT ON work.activities TO PUBLIC",
      "GRANT SELECT ON work.activities TO throughline_worker",
      "GRANT SELECT ON work.activities TO throughline_app WITH GRANT OPTION",
      `GRANT throughline_app TO throughline_worker;
       GRANT throughline_worker TO throughline_relay`
    ]) {
      await expectJournaledCatalogRejected(mutation);
    }
  }, 180_000);

  it("accepts semantic ACL equality after revoke/regrant storage ordering changes", async () => {
    await reset();
    await ownerPool.query(`
      REVOKE SELECT, INSERT ON work.activities FROM throughline_app;
      REVOKE UPDATE (id) ON work.activities FROM throughline_app;
      GRANT UPDATE (id) ON work.activities TO throughline_app;
      GRANT INSERT ON work.activities TO throughline_app;
      GRANT SELECT ON work.activities TO throughline_app
    `);
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...migrationIds]
    });
    await expectScratchCatalogClean();
    await reset();
  }, 60_000);

  it("enforces the 0006 integrity SELECT boundary on both sides of its journal row", async () => {
    await applyMigrations(ownerPool, { reset: true, through: b1MigrationIds[1] });
    await ownerPool.query("GRANT SELECT ON work.activities TO throughline_b1_0_integrity");
    await expect(applyMigrations(ownerPool)).rejects.toThrow(/catalog|B1|journal|capability/i);
    await reset();

    await ownerPool.query("REVOKE SELECT ON work.activities FROM throughline_b1_0_integrity");
    await expect(applyMigrations(ownerPool)).rejects.toThrow(/catalog|B1|journal|capability/i);
    await reset();
  }, 60_000);

  it("rejects predecessor PUBLIC, rogue, grant-option, unexpected-column, and alternate-grantor ACLs", async () => {
    for (const mutation of [
      "GRANT SELECT ON access.spaces TO PUBLIC",
      "GRANT SELECT ON ops.audit_events TO throughline_worker",
      "GRANT SELECT ON access.spaces TO throughline_app WITH GRANT OPTION",
      "GRANT SELECT (parent_space_id) ON access.spaces TO throughline_product_relay",
      `GRANT SELECT ON access.spaces TO throughline_app WITH GRANT OPTION;
       SET ROLE throughline_app;
       GRANT SELECT ON access.spaces TO throughline_worker;
       RESET ROLE`
    ]) {
      await expectJournaledCatalogRejected(mutation);
    }
  }, 180_000);

  it("rejects inherited predecessor authority and completely restores role membership", async () => {
    try {
      await ownerPool.query("GRANT throughline_app TO throughline_worker");
      await expect(applyMigrations(ownerPool)).rejects.toThrow(/catalog|B1|capability|role/i);
    } finally {
      await ownerPool.query("REVOKE throughline_app FROM throughline_worker");
      await reset();
    }
  }, 60_000);

  it("accepts predecessor ACL tuple equality after storage ordering changes", async () => {
    await reset();
    await ownerPool.query(`
      REVOKE SELECT, INSERT ON ops.audit_events FROM throughline_app;
      GRANT INSERT ON ops.audit_events TO throughline_app;
      GRANT SELECT ON ops.audit_events TO throughline_app
    `);
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: [...migrationIds]
    });
    await expectScratchCatalogClean();
    await reset();
  }, 60_000);

  it("rejects trigger and rewrite-rule drift", async () => {
    await expectJournaledCatalogRejected(
      "DROP TRIGGER activity_attendees_append_only ON work.activity_attendees"
    );
    await expectJournaledCatalogRejected(`
      CREATE RULE organizations_unreviewed_rewrite AS
        ON INSERT TO work.organizations DO INSTEAD NOTHING
    `);
  }, 60_000);

  it("rejects function source/overload/owner/ACL/security/volatility/search_path drift", async () => {
    await expectJournaledCatalogRejected(`
      ALTER FUNCTION work.canonical_domain(text) OWNER TO throughline_app;
      ALTER FUNCTION work.canonical_domain(text) SECURITY DEFINER;
      ALTER FUNCTION work.canonical_domain(text) STABLE;
      ALTER FUNCTION work.canonical_domain(text) SET search_path = public;
      GRANT EXECUTE ON FUNCTION work.canonical_domain(text) TO PUBLIC;
      GRANT EXECUTE ON FUNCTION work.canonical_domain(text) TO throughline_worker WITH GRANT OPTION;
      CREATE FUNCTION work.canonical_domain(text, text) RETURNS boolean
        LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT true'
    `);
  }, 60_000);

  it("rejects table/schema ownership and RLS/forced-RLS security drift", async () => {
    await expectJournaledCatalogRejected(`
      ALTER TABLE work.organizations OWNER TO throughline_app;
      ALTER SCHEMA work OWNER TO throughline_app;
      ALTER TABLE work.organizations NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE work.organizations DISABLE ROW LEVEL SECURITY
    `);
  }, 60_000);

  it("rejects renamed or dropped Activity id rather than following its ACL attnum", async () => {
    await expectJournaledCatalogRejected(
      "ALTER TABLE work.activities RENAME COLUMN id TO activity_id"
    );
    await expectJournaledCatalogRejected("ALTER TABLE work.activities DROP COLUMN id CASCADE");
  }, 60_000);

  it("rejects protected role attributes and broad integrity capabilities", async () => {
    await expectJournaledCatalogRejected(`
      ALTER ROLE throughline_app LOGIN BYPASSRLS;
      GRANT EXECUTE ON FUNCTION ops.current_tenant_id() TO throughline_b1_0_integrity
    `);
  }, 60_000);

  it("rolls back a newly applying B1 migration when its fixed postcondition is violated", async () => {
    await applyMigrations(ownerPool, {
      reset: true,
      through: "0003_b1_0_canonical_product_outbox.sql"
    });
    await ownerPool.query("ALTER ROLE throughline_app LOGIN");
    await expect(applyMigrations(ownerPool)).rejects.toThrow("protected B1 role attributes");
    const state = await ownerPool.query<{ journaled: string; work_schema: string | null }>(
      `SELECT
         (SELECT count(*)::text FROM throughline_migrations.journal
          WHERE id = '0004_b1_work_graph.sql') AS journaled,
         to_regnamespace('work')::text AS work_schema`
    );
    expect(state.rows[0]).toEqual({ journaled: "0", work_schema: null });
    await ownerPool.query("ALTER ROLE throughline_app NOLOGIN");
    await reset();
  }, 60_000);
});
