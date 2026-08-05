import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { applyMigrations, type MigrationRunResult } from "./migrations.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { provisionTestAppRole } from "./test-database.js";
import { withTenantTransaction } from "./transaction.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const maybeDescribe = ownerUrl && appUrl ? describe.sequential : describe.skip;
const migrationId = "0001_wave_a2_identity_access_rls.sql";
const migrationIds = [
  migrationId,
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql",
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql",
  "0007_b2_slice1_truth_storage.sql",
  "0008_b2_slice1_command_integrity.sql",
  "0009_b2_source_truth_lifecycle_interlock.sql",
  "0010_b2_trusted_objective_initiative_lock.sql",
  "0011_b2_primary_objective_proposal_recovery.sql"
];
const foundationMigrationId = migrationIds[1]!;
const exactPrefixError =
  "Migration journal is not an exact contiguous prefix of the known migration catalog";
const migrationUrl = new URL("../migrations/0001_wave_a2_identity_access_rls.sql", import.meta.url);

interface AppRoleState {
  rolcanlogin: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolsuper: boolean;
  password_is_null: boolean;
}

interface JournalRow {
  id: string;
  checksum: string;
  applied_at: Date | null;
}

interface CleanMigrationState {
  journal: Array<Pick<JournalRow, "id" | "checksum">>;
  tenantCount: string;
}

interface MigrationCatalogState {
  journal: JournalRow[];
  catalog: Array<{
    object_type: string;
    object_identity: string;
    definition: string;
  }>;
}

maybeDescribe("Wave A2 database RLS security", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  let firstResetRun: MigrationRunResult;
  let firstResetState: CleanMigrationState;

  afterAll(async () => {
    await appPool.end();
    await ownerPool.end();
  });

  it("disables and clears an existing app login before test-only provisioning", async () => {
    await applyMigrations(ownerPool, { reset: true });
    await setExistingAppLoginWithTestCredential(ownerPool, appUrl!);

    const legacyRole = await readAppRoleState(ownerPool);
    expect(legacyRole).toMatchObject({
      rolcanlogin: true,
      password_is_null: false
    });

    await ownerPool.query(
      `
      INSERT INTO identity.tenants (slug, name, status, default_access_class)
      VALUES ('migration-reset-sentinel', 'Migration reset sentinel', 'active', 'workspace')
      `
    );

    firstResetRun = await applyMigrations(ownerPool, { reset: true });
    firstResetState = await readCleanMigrationState(ownerPool);

    const hardenedRole = await readAppRoleState(ownerPool);
    expect(hardenedRole).toMatchObject({
      rolcanlogin: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolsuper: false,
      password_is_null: true
    });

    await provisionTestAppRole(ownerPool, appUrl!);

    const provisionedRole = await readAppRoleState(ownerPool);
    expect(provisionedRole).toMatchObject({
      rolcanlogin: true,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolsuper: false,
      password_is_null: testAppUrlHasNoPassword(appUrl!)
    });

    const provisionedAppPool = new pg.Pool({ connectionString: appUrl });
    try {
      const connection = await provisionedAppPool.query<{
        current_user: string;
        rolbypassrls: boolean;
      }>(
        `
        SELECT current_user, rolbypassrls
        FROM pg_roles
        WHERE rolname = current_user
        `
      );

      expect(connection.rows[0]).toEqual({
        current_user: "throughline_app",
        rolbypassrls: false
      });
    } finally {
      await provisionedAppPool.end();
    }

    await ownerPool.query(
      `
      INSERT INTO identity.tenants (slug, name, status, default_access_class)
      VALUES ('second-reset-sentinel', 'Second reset sentinel', 'active', 'workspace')
      `
    );
  }, 60_000);

  it("produces the same deterministic clean migration state on two resets", async () => {
    const secondResetRun = await applyMigrations(ownerPool, { reset: true });
    const secondResetState = await readCleanMigrationState(ownerPool);

    expect(firstResetRun).toEqual({ applied: migrationIds, skipped: [] });
    expect(secondResetRun).toEqual(firstResetRun);
    expect(firstResetState).toEqual({
      journal: migrationIds.map((id) => ({
        id,
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/)
      })),
      tenantCount: "0"
    });
    expect(secondResetState).toEqual(firstResetState);
  }, 60_000);

  it("records the exact migration id, true SHA-256 checksum, and applied timestamp", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const expectedChecksum = createHash("sha256").update(sql).digest("hex");
    const journal = await ownerPool.query<JournalRow>(
      `
      SELECT id, checksum, applied_at
      FROM throughline_migrations.journal
      ORDER BY id
      `
    );

    expect(journal.rows).toHaveLength(migrationIds.length);
    expect(journal.rows[0]).toMatchObject({ id: migrationId, checksum: expectedChecksum });
    expect(journal.rows.every(({ applied_at }) => applied_at !== null)).toBe(true);
  });

  it("fails closed without catalog or journal mutation when 0001 is missing before successors", async () => {
    try {
      await expectGappedJournalRejectedWithoutMutation(migrationId);
    } finally {
      await applyMigrations(ownerPool, { reset: true });
    }
  }, 60_000);

  it("fails closed without catalog or journal mutation when 0002 is missing before successors", async () => {
    try {
      await expectGappedJournalRejectedWithoutMutation(foundationMigrationId);
    } finally {
      await applyMigrations(ownerPool, { reset: true });
    }
  }, 60_000);

  async function expectGappedJournalRejectedWithoutMutation(missingId: string): Promise<void> {
    await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [missingId]);
    const before = await readMigrationJournalAndCatalogState(ownerPool);

    expect(before.journal.map((row) => row.id)).toEqual(
      migrationIds.filter((id) => id !== missingId)
    );
    await expect(applyMigrations(ownerPool, { through: migrationId })).rejects.toThrow(
      exactPrefixError
    );

    const after = await readMigrationJournalAndCatalogState(ownerPool);
    expect(after).toEqual(before);
  }

  it("fails closed when the named adoption constraint has an unexpected definition", async () => {
    try {
      await applyMigrations(ownerPool, { reset: true, through: migrationId });
      await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
        migrationId
      ]);
      await ownerPool.query(
        "ALTER TABLE identity.workspaces DROP CONSTRAINT workspaces_default_space_fk"
      );
      await ownerPool.query(`
        ALTER TABLE identity.workspaces
        ADD CONSTRAINT workspaces_default_space_fk
        CHECK (default_space_id IS NULL)
      `);

      await expect(applyMigrations(ownerPool, { through: migrationId })).rejects.toThrow(
        "Existing constraint workspaces_default_space_fk does not match the expected definition"
      );

      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );
      expect(journal.rows[0]?.count).toBe("0");
    } finally {
      await applyMigrations(ownerPool, { reset: true });
    }
  }, 60_000);

  it("fails closed when paired missing columns shrink the expected adoption constraint", async () => {
    try {
      await applyMigrations(ownerPool, { reset: true, through: migrationId });
      await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
        migrationId
      ]);
      await ownerPool.query(
        "ALTER TABLE identity.workspaces DROP CONSTRAINT workspaces_default_space_fk"
      );
      await ownerPool.query(
        "ALTER TABLE identity.workspaces RENAME COLUMN default_space_id TO default_space_id_adoption_omitted"
      );
      await ownerPool.query("ALTER TABLE access.spaces RENAME COLUMN id TO id_adoption_omitted");
      await ownerPool.query(`
        ALTER TABLE access.spaces
        ADD CONSTRAINT spaces_tenant_workspace_adoption_unique
        UNIQUE (tenant_id, workspace_id)
      `);
      await ownerPool.query(`
        ALTER TABLE identity.workspaces
        ADD CONSTRAINT workspaces_default_space_fk
        FOREIGN KEY (tenant_id, id) REFERENCES access.spaces(tenant_id, workspace_id)
        MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION
        DEFERRABLE INITIALLY DEFERRED
      `);

      await expect
        .soft(applyMigrations(ownerPool, { through: migrationId }))
        .rejects.toThrow(
          "Existing constraint workspaces_default_space_fk does not match the expected definition"
        );

      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );
      expect.soft(journal.rows[0]?.count).toBe("0");
    } finally {
      await applyMigrations(ownerPool, { reset: true });
    }
  }, 60_000);

  it("rolls migration SQL back when the journal insert fails", async () => {
    try {
      await applyMigrations(ownerPool, { reset: true, through: migrationId });
      await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
        migrationId
      ]);
      await ownerPool.query("DROP POLICY tenants_current_tenant ON identity.tenants");
      const insertFailingPool = rejectMigrationJournalInsert(ownerPool);

      await expect(applyMigrations(insertFailingPool, { through: migrationId })).rejects.toThrow(
        "intentional migration journal insert failure"
      );

      const rolledBack = await ownerPool.query<{
        journal_count: string;
        policy_count: string;
      }>(
        `
        SELECT
          (SELECT count(*)::text FROM throughline_migrations.journal WHERE id = $1) AS journal_count,
          (
            SELECT count(*)::text
            FROM pg_policies
            WHERE schemaname = 'identity'
              AND tablename = 'tenants'
              AND policyname = 'tenants_current_tenant'
          ) AS policy_count
        `,
        [migrationId]
      );

      expect(rolledBack.rows[0]).toEqual({
        journal_count: "0",
        policy_count: "0"
      });
    } finally {
      await applyMigrations(ownerPool, { reset: true });
    }
  }, 60_000);

  it("serializes concurrent migration callers into one apply and one skip", async () => {
    try {
      await applyMigrations(ownerPool, { reset: true, through: migrationId });
      await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
        migrationId
      ]);
      const runs = await Promise.all([
        applyMigrations(ownerPool, { through: migrationId }),
        applyMigrations(ownerPool, { through: migrationId })
      ]);
      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );

      expect(runs).toEqual(
        expect.arrayContaining([
          { applied: [migrationId], skipped: [] },
          { applied: [], skipped: [migrationId] }
        ])
      );
      expect(runs).toHaveLength(2);
      expect(journal.rows[0]?.count).toBe("1");
    } finally {
      await applyMigrations(ownerPool, { reset: true });
    }
  }, 60_000);

  it("restores the explicit test app login and deterministic RLS fixtures", async () => {
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl!);
    await seedWaveA2DeterministicData(ownerPool);

    const connection = await appPool.query<{
      current_user: string;
      rolbypassrls: boolean;
    }>(
      `
      SELECT current_user, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
      `
    );

    expect(connection.rows[0]).toEqual({
      current_user: "throughline_app",
      rolbypassrls: false
    });
  }, 60_000);

  it("fails closed if an applied migration filename has a different checksum", async () => {
    const recorded = await ownerPool.query<{ checksum: string }>(
      "SELECT checksum FROM throughline_migrations.journal WHERE id = $1",
      [migrationId]
    );
    const originalChecksum = recorded.rows[0]?.checksum;
    expect(originalChecksum).toBeDefined();

    await ownerPool.query("UPDATE throughline_migrations.journal SET checksum = $1 WHERE id = $2", [
      "0".repeat(64),
      migrationId
    ]);

    try {
      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        `Migration checksum mismatch for ${migrationId}`
      );
    } finally {
      await ownerPool.query(
        "UPDATE throughline_migrations.journal SET checksum = $1 WHERE id = $2",
        [originalChecksum, migrationId]
      );
    }
  });

  it("enables and forces RLS on the exact protected table catalog", async () => {
    const protectedRelations = await ownerPool.query<{
      relation_name: string;
      relforcerowsecurity: boolean;
      relrowsecurity: boolean;
    }>(`
      SELECT
        namespace.nspname || '.' || relation.relname AS relation_name,
        relation.relrowsecurity,
        relation.relforcerowsecurity
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE (namespace.nspname, relation.relname) IN (
        ('identity', 'tenants'),
        ('identity', 'workspaces'),
        ('identity', 'users'),
        ('identity', 'people'),
        ('identity', 'memberships'),
        ('identity', 'service_principals'),
        ('identity', 'agent_principals'),
        ('identity', 'policy_versions'),
        ('access', 'spaces'),
        ('access', 'access_relationships')
      )
      ORDER BY relation_name
    `);

    expect(protectedRelations.rows).toEqual(
      [
        "access.access_relationships",
        "access.spaces",
        "identity.agent_principals",
        "identity.memberships",
        "identity.people",
        "identity.policy_versions",
        "identity.service_principals",
        "identity.tenants",
        "identity.users",
        "identity.workspaces"
      ].map((relationName) => ({
        relation_name: relationName,
        relforcerowsecurity: true,
        relrowsecurity: true
      }))
    );
  });

  it("defaults to no tenant context and no protected rows through the app role", async () => {
    const client = await appPool.connect();

    try {
      const context = await client.query<{
        tenant_id: string | null;
        workspace_id: string | null;
      }>(`
        SELECT
          NULLIF(current_setting('app.tenant_id', true), '') AS tenant_id,
          NULLIF(current_setting('app.workspace_id', true), '') AS workspace_id
      `);
      const protectedCounts = await client.query<{
        relation_name: string;
        row_count: number;
      }>(`
        SELECT 'access.access_relationships' AS relation_name, count(*)::integer AS row_count
        FROM access.access_relationships
        UNION ALL
        SELECT 'access.spaces', count(*)::integer FROM access.spaces
        UNION ALL
        SELECT 'identity.agent_principals', count(*)::integer FROM identity.agent_principals
        UNION ALL
        SELECT 'identity.memberships', count(*)::integer FROM identity.memberships
        UNION ALL
        SELECT 'identity.people', count(*)::integer FROM identity.people
        UNION ALL
        SELECT 'identity.policy_versions', count(*)::integer FROM identity.policy_versions
        UNION ALL
        SELECT 'identity.service_principals', count(*)::integer FROM identity.service_principals
        UNION ALL
        SELECT 'identity.tenants', count(*)::integer FROM identity.tenants
        UNION ALL
        SELECT 'identity.users', count(*)::integer FROM identity.users
        UNION ALL
        SELECT 'identity.workspaces', count(*)::integer FROM identity.workspaces
        ORDER BY relation_name
      `);

      expect(context.rows[0]).toEqual({ tenant_id: null, workspace_id: null });
      expect(protectedCounts.rows).toEqual(
        [
          "access.access_relationships",
          "access.spaces",
          "identity.agent_principals",
          "identity.memberships",
          "identity.people",
          "identity.policy_versions",
          "identity.service_principals",
          "identity.tenants",
          "identity.users",
          "identity.workspaces"
        ].map((relationName) => ({ relation_name: relationName, row_count: 0 }))
      );
    } finally {
      client.release();
    }
  });

  it("rejects a tenant B Space insert under tenant A context without persisting it", async () => {
    const mismatchedSpaceId = "33333333-3333-4333-8333-333333333331";
    const context = createDevSecurityContext("tenant-a-owner");

    await ownerPool.query("DELETE FROM access.spaces WHERE id = $1", [mismatchedSpaceId]);

    try {
      let insertError: unknown;
      try {
        await withTenantTransaction({ pool: appPool, context }, async (tx) => {
          await tx.query(
            `
            INSERT INTO access.spaces
              (id, tenant_id, workspace_id, kind, name, slug, access_class, inheritance_mode)
            VALUES ($1, $2, $3, 'knowledge', 'Mismatched RLS write',
              'mismatched-rls-write', 'restricted', 'restricted')
            `,
            [mismatchedSpaceId, devFixtures.tenantB, devFixtures.workspaceB]
          );
        });
      } catch (error) {
        insertError = error;
      }

      expect.soft(insertError).toMatchObject({ code: "42501" });

      const persisted = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM access.spaces WHERE id = $1",
        [mismatchedSpaceId]
      );
      expect(persisted.rows[0]?.count).toBe("0");
    } finally {
      await ownerPool.query("DELETE FROM access.spaces WHERE id = $1", [mismatchedSpaceId]);
    }
  });

  it("denies tenant B rows through the app role under tenant A context", async () => {
    const context = createDevSecurityContext("tenant-a-owner");

    const visibleSpaces = await withTenantTransaction({ pool: appPool, context }, (tx) =>
      tx.query<{ id: string }>("SELECT id FROM access.spaces ORDER BY id")
    );

    expect(visibleSpaces.rows.map((row: { id: string }) => row.id).sort()).toEqual(
      [
        devFixtures.restrictedChildSpaceA,
        devFixtures.restrictedSpaceA,
        devFixtures.rootSpaceA
      ].sort()
    );
    expect(visibleSpaces.rows).not.toContainEqual({ id: devFixtures.rootSpaceB });
  });

  it("allows identity.users self-read only in A2", async () => {
    const context = createDevSecurityContext("tenant-a-owner");

    const users = await withTenantTransaction({ pool: appPool, context }, (tx) =>
      tx.query<{ id: string }>("SELECT id FROM identity.users ORDER BY id")
    );

    expect(users.rows).toEqual([{ id: devFixtures.userA }]);
  });

  it("does not leak SET LOCAL context across pooled transactions", async () => {
    const context = createDevSecurityContext("tenant-a-owner");

    await withTenantTransaction({ pool: appPool, context }, (tx) =>
      tx.query("SELECT current_setting('app.tenant_id', true) AS tenant_id")
    );

    const outside = await appPool.query<{ tenant_id: string | null }>(
      "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant_id"
    );
    expect(outside.rows[0]?.tenant_id ?? null).toBeNull();
  });

  it("prevents team subjects in access relationships until Teams exists", async () => {
    await expect(
      ownerPool.query(
        `
        INSERT INTO access.access_relationships
          (tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
        VALUES ($1, $2, 'team', $3, 'viewer', 'space', $4, 'direct')
        `,
        [
          devFixtures.tenantA,
          devFixtures.workspaceA,
          devFixtures.membershipAOwner,
          devFixtures.rootSpaceA
        ]
      )
    ).rejects.toThrow();
  });
});

async function readAppRoleState(pool: pg.Pool): Promise<AppRoleState> {
  const result = await pool.query<AppRoleState>(
    `
    SELECT
      rolcanlogin,
      rolbypassrls,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolsuper,
      rolpassword IS NULL AS password_is_null
    FROM pg_authid
    WHERE rolname = 'throughline_app'
    `
  );

  if (!result.rows[0]) {
    throw new Error("throughline_app role is missing");
  }

  return result.rows[0];
}

async function readCleanMigrationState(pool: pg.Pool): Promise<CleanMigrationState> {
  const [journal, tenants] = await Promise.all([
    pool.query<Pick<JournalRow, "id" | "checksum">>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    ),
    pool.query<{ count: string }>("SELECT count(*)::text AS count FROM identity.tenants")
  ]);

  return {
    journal: journal.rows,
    tenantCount: tenants.rows[0]?.count ?? "missing"
  };
}

async function readMigrationJournalAndCatalogState(pool: pg.Pool): Promise<MigrationCatalogState> {
  const [journal, catalog] = await Promise.all([
    pool.query<JournalRow>(
      "SELECT id, checksum, applied_at FROM throughline_migrations.journal ORDER BY id"
    ),
    pool.query<MigrationCatalogState["catalog"][number]>(
      `WITH migrated_schemas AS (
        SELECT namespace_record.oid, namespace_record.nspname,
               namespace_record.nspowner, namespace_record.nspacl
        FROM pg_namespace namespace_record
         WHERE namespace_record.nspname = ANY($1::text[])
       ), catalog AS (
         SELECT 'schema'::text AS object_type,
                namespace_record.oid::text || ':' || namespace_record.nspname AS object_identity,
                concat_ws('|', pg_get_userbyid(namespace_record.nspowner),
                  COALESCE(namespace_record.nspacl::text, '<null>')) AS definition
         FROM migrated_schemas namespace_record
         UNION ALL
         SELECT 'relation', relation_record.oid::text || ':' || namespace_record.nspname ||
                  '.' || relation_record.relname,
                concat_ws('|', relation_record.relkind::text,
                  relation_record.relpersistence::text,
                  pg_get_userbyid(relation_record.relowner),
                  relation_record.relrowsecurity::text,
                  relation_record.relforcerowsecurity::text,
                  COALESCE(relation_record.relacl::text, '<null>'),
                  COALESCE(relation_record.reloptions::text, '<null>'))
         FROM pg_class relation_record
         JOIN migrated_schemas namespace_record
           ON namespace_record.oid = relation_record.relnamespace
         UNION ALL
         SELECT 'column', relation_record.oid::text || ':' || namespace_record.nspname ||
                  '.' || relation_record.relname || ':' || attribute_record.attnum::text || ':' ||
                  attribute_record.attname,
                concat_ws('|',
                  format_type(attribute_record.atttypid, attribute_record.atttypmod),
                  attribute_record.attnotnull::text,
                  attribute_record.attidentity::text,
                  attribute_record.attgenerated::text,
                  COALESCE(attribute_record.attacl::text, '<null>'),
                  COALESCE(pg_get_expr(default_record.adbin, default_record.adrelid), '<null>'))
         FROM pg_attribute attribute_record
         JOIN pg_class relation_record ON relation_record.oid = attribute_record.attrelid
         JOIN migrated_schemas namespace_record
           ON namespace_record.oid = relation_record.relnamespace
         LEFT JOIN pg_attrdef default_record
           ON default_record.adrelid = attribute_record.attrelid
          AND default_record.adnum = attribute_record.attnum
         WHERE attribute_record.attnum > 0 AND NOT attribute_record.attisdropped
         UNION ALL
         SELECT 'constraint', constraint_record.oid::text || ':' ||
                  namespace_record.nspname || '.' || relation_record.relname || ':' ||
                  constraint_record.conname,
                concat_ws('|', constraint_record.contype::text,
                  constraint_record.condeferrable::text,
                  constraint_record.condeferred::text,
                  constraint_record.convalidated::text,
                  pg_get_constraintdef(constraint_record.oid, false))
         FROM pg_constraint constraint_record
         JOIN pg_class relation_record ON relation_record.oid = constraint_record.conrelid
         JOIN migrated_schemas namespace_record
           ON namespace_record.oid = relation_record.relnamespace
         UNION ALL
         SELECT 'index', index_relation.oid::text || ':' || namespace_record.nspname || '.' ||
                  index_relation.relname,
                pg_get_indexdef(index_record.indexrelid, 0, false)
         FROM pg_index index_record
         JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
         JOIN pg_class table_relation ON table_relation.oid = index_record.indrelid
         JOIN migrated_schemas namespace_record
           ON namespace_record.oid = table_relation.relnamespace
         UNION ALL
         SELECT 'function', procedure_record.oid::text || ':' || namespace_record.nspname || '.' ||
                  procedure_record.proname || '(' ||
                  pg_get_function_identity_arguments(procedure_record.oid) || ')',
                concat_ws('|', pg_get_userbyid(procedure_record.proowner),
                  procedure_record.prokind::text,
                  procedure_record.provolatile::text,
                  procedure_record.prosecdef::text,
                  COALESCE(procedure_record.proconfig::text, '<null>'),
                  COALESCE(procedure_record.proacl::text, '<null>'),
                  pg_get_function_result(procedure_record.oid), procedure_record.prosrc)
         FROM pg_proc procedure_record
         JOIN migrated_schemas namespace_record
           ON namespace_record.oid = procedure_record.pronamespace
         UNION ALL
         SELECT 'policy', policy_record.oid::text || ':' || namespace_record.nspname || '.' ||
                  relation_record.relname || ':' || policy_record.polname,
                concat_ws('|', policy_record.polcmd::text, policy_record.polpermissive::text,
                  array_to_string(ARRAY(
                    SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END
                    FROM unnest(policy_record.polroles) role_oid ORDER BY 1
                  ), ','),
                  COALESCE(pg_get_expr(policy_record.polqual, policy_record.polrelid), '<null>'),
                  COALESCE(pg_get_expr(policy_record.polwithcheck, policy_record.polrelid), '<null>'))
         FROM pg_policy policy_record
         JOIN pg_class relation_record ON relation_record.oid = policy_record.polrelid
         JOIN migrated_schemas namespace_record
           ON namespace_record.oid = relation_record.relnamespace
         UNION ALL
         SELECT 'trigger', trigger_record.oid::text || ':' || namespace_record.nspname || '.' ||
                  relation_record.relname || ':' || trigger_record.tgname,
                concat_ws('|', trigger_record.tgenabled::text, trigger_record.tgisinternal::text,
                  pg_get_triggerdef(trigger_record.oid, false))
         FROM pg_trigger trigger_record
         JOIN pg_class relation_record ON relation_record.oid = trigger_record.tgrelid
         JOIN migrated_schemas namespace_record
           ON namespace_record.oid = relation_record.relnamespace
         UNION ALL
         SELECT 'role', role_record.oid::text || ':' || role_record.rolname,
                concat_ws('|', role_record.rolcanlogin::text, role_record.rolsuper::text,
                  role_record.rolcreatedb::text, role_record.rolcreaterole::text,
                  role_record.rolinherit::text, role_record.rolreplication::text,
                  role_record.rolbypassrls::text, role_record.rolconnlimit::text,
                  COALESCE(role_record.rolvaliduntil::text, '<null>'),
                  COALESCE(role_record.rolconfig::text, '<null>'))
         FROM pg_roles role_record
         WHERE role_record.rolname LIKE 'throughline\\_%' ESCAPE '\\'
       )
       SELECT object_type, object_identity, definition
       FROM catalog
       ORDER BY object_type, object_identity`,
      [["throughline_migrations", "identity", "access", "ops", "work", "content"]]
    )
  ]);

  return { journal: journal.rows, catalog: catalog.rows };
}

function rejectMigrationJournalInsert(pool: pg.Pool): pg.Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return (...args: unknown[]) => {
              const statement = args[0];
              const sql =
                typeof statement === "string"
                  ? statement
                  : statement && typeof statement === "object" && "text" in statement
                    ? String(statement.text)
                    : "";
              if (/INSERT INTO throughline_migrations\.journal/.test(sql)) {
                throw new Error("intentional migration journal insert failure");
              }
              return Reflect.apply(target.query, target, args);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  } as unknown as pg.Pool;
}

async function setExistingAppLoginWithTestCredential(
  pool: pg.Pool,
  testAppDatabaseUrl: string
): Promise<void> {
  const parsedUrl = new URL(testAppDatabaseUrl);
  const passwordFromUrl = decodeURIComponent(parsedUrl.password);
  const testCredential = passwordFromUrl || randomBytes(32).toString("base64url");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('throughline.test_legacy_role_password', $1, true)", [
      testCredential
    ]);
    await client.query(`
      DO $test$
      BEGIN
        EXECUTE format(
          'ALTER ROLE throughline_app LOGIN NOBYPASSRLS PASSWORD %L',
          current_setting('throughline.test_legacy_role_password')
        );
      END
      $test$
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function testAppUrlHasNoPassword(testAppDatabaseUrl: string): boolean {
  return new URL(testAppDatabaseUrl).password === "";
}
