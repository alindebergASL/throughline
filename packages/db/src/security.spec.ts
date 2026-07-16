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
  "0003_b1_0_canonical_product_outbox.sql"
];
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
  });

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
  });

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

  it("adopts a parent-equivalent schema with the named constraint and no journal", async () => {
    let adoptionCompleted = false;

    await setExistingAppLoginWithTestCredential(ownerPool, appUrl!);
    await ownerPool.query("DROP SCHEMA throughline_migrations CASCADE");

    try {
      const startingState = await ownerPool.query<{
        constraint_count: string;
        journal_relation: string | null;
      }>(
        `
        SELECT
          (
            SELECT count(*)::text
            FROM pg_constraint
            WHERE conname = 'workspaces_default_space_fk'
              AND conrelid = to_regclass('identity.workspaces')
          ) AS constraint_count,
          to_regclass('throughline_migrations.journal')::text AS journal_relation
        `
      );

      expect(startingState.rows[0]).toEqual({
        constraint_count: "1",
        journal_relation: null
      });

      const adopted = await applyMigrations(ownerPool);
      const repeated = await applyMigrations(ownerPool);
      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal"
      );
      const hardenedRole = await readAppRoleState(ownerPool);

      expect(adopted).toEqual({ applied: migrationIds, skipped: [] });
      expect(repeated).toEqual({ applied: [], skipped: migrationIds });
      expect(journal.rows[0]?.count).toBe(String(migrationIds.length));
      expect(hardenedRole).toMatchObject({
        rolcanlogin: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolsuper: false,
        password_is_null: true
      });
      adoptionCompleted = true;
    } finally {
      if (!adoptionCompleted) {
        await applyMigrations(ownerPool, { reset: true });
      }
    }
  });

  it("adopts a parent-equivalent schema when the owner search path includes the parent schemas", async () => {
    const parentSchemaOwnerPool = new pg.Pool({
      connectionString: ownerUrl,
      max: 1,
      options: "-c search_path=access,identity,public"
    });

    try {
      const configuredConnection = await parentSchemaOwnerPool.query<{
        effective_schemas: string[];
        search_path: string;
      }>(`
        SELECT
          current_schemas(false)::text[] AS effective_schemas,
          current_setting('search_path') AS search_path
      `);

      expect(
        configuredConnection.rows[0]?.search_path.split(",").map((schema) => schema.trim())
      ).toEqual(["access", "identity", "public"]);
      expect(configuredConnection.rows[0]?.effective_schemas).toEqual([
        "access",
        "identity",
        "public"
      ]);

      await ownerPool.query("DROP SCHEMA throughline_migrations CASCADE");

      const startingState = await parentSchemaOwnerPool.query<{
        constraint_count: string;
        journal_relation: string | null;
        referenced_schema: string | null;
      }>(`
        SELECT
          (
            SELECT count(*)::text
            FROM pg_constraint
            WHERE conname = 'workspaces_default_space_fk'
              AND conrelid = to_regclass('identity.workspaces')
              AND contype = 'f'
              AND condeferrable
              AND condeferred
          ) AS constraint_count,
          (
            SELECT target_namespace.nspname
            FROM pg_constraint AS constraint_record
            JOIN pg_class AS target_relation
              ON target_relation.oid = constraint_record.confrelid
            JOIN pg_namespace AS target_namespace
              ON target_namespace.oid = target_relation.relnamespace
            WHERE constraint_record.conname = 'workspaces_default_space_fk'
              AND constraint_record.conrelid = to_regclass('identity.workspaces')
          ) AS referenced_schema,
          to_regclass('throughline_migrations.journal')::text AS journal_relation
      `);

      expect(startingState.rows[0]).toEqual({
        constraint_count: "1",
        journal_relation: null,
        referenced_schema: "access"
      });

      const adopted = await applyMigrations(parentSchemaOwnerPool);
      const repeated = await applyMigrations(parentSchemaOwnerPool);
      const journal = await parentSchemaOwnerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );

      expect(adopted).toEqual({ applied: migrationIds, skipped: [] });
      expect(repeated).toEqual({ applied: [], skipped: migrationIds });
      expect(journal.rows[0]?.count).toBe("1");
    } finally {
      try {
        await applyMigrations(ownerPool);
      } finally {
        await parentSchemaOwnerPool.end();
      }
    }
  });

  it("fails closed when the named adoption constraint has an unexpected definition", async () => {
    await ownerPool.query("DELETE FROM throughline_migrations.journal");
    await ownerPool.query(
      "ALTER TABLE identity.workspaces DROP CONSTRAINT workspaces_default_space_fk"
    );
    await ownerPool.query(`
      ALTER TABLE identity.workspaces
      ADD CONSTRAINT workspaces_default_space_fk
      CHECK (default_space_id IS NULL)
    `);

    try {
      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        "Existing constraint workspaces_default_space_fk does not match the expected definition"
      );

      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );
      expect(journal.rows[0]?.count).toBe("0");
    } finally {
      await ownerPool.query(
        "ALTER TABLE identity.workspaces DROP CONSTRAINT IF EXISTS workspaces_default_space_fk"
      );
      await applyMigrations(ownerPool);
    }
  });

  it("fails closed when paired missing columns shrink the expected adoption constraint", async () => {
    try {
      await ownerPool.query("DELETE FROM throughline_migrations.journal");
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
        .soft(applyMigrations(ownerPool))
        .rejects.toThrow(
          "Existing constraint workspaces_default_space_fk does not match the expected definition"
        );

      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );
      expect.soft(journal.rows[0]?.count).toBe("0");
    } finally {
      try {
        await ownerPool.query("DELETE FROM throughline_migrations.journal");
      } finally {
        try {
          await ownerPool.query(
            "ALTER TABLE identity.workspaces DROP CONSTRAINT IF EXISTS workspaces_default_space_fk"
          );
        } finally {
          try {
            await ownerPool.query(
              "ALTER TABLE access.spaces DROP CONSTRAINT IF EXISTS spaces_tenant_workspace_adoption_unique"
            );
          } finally {
            try {
              await ownerPool.query(`
                DO $cleanup$
                BEGIN
                  IF EXISTS (
                    SELECT 1
                    FROM pg_attribute
                    WHERE attrelid = to_regclass('identity.workspaces')
                      AND attname = 'default_space_id_adoption_omitted'
                      AND attnum > 0
                      AND NOT attisdropped
                  ) THEN
                    ALTER TABLE identity.workspaces
                      RENAME COLUMN default_space_id_adoption_omitted TO default_space_id;
                  END IF;
                END
                $cleanup$
              `);
            } finally {
              try {
                await ownerPool.query(`
                  DO $cleanup$
                  BEGIN
                    IF EXISTS (
                      SELECT 1
                      FROM pg_attribute
                      WHERE attrelid = to_regclass('access.spaces')
                        AND attname = 'id_adoption_omitted'
                        AND attnum > 0
                        AND NOT attisdropped
                    ) THEN
                      ALTER TABLE access.spaces
                        RENAME COLUMN id_adoption_omitted TO id;
                    END IF;
                  END
                  $cleanup$
                `);
              } finally {
                await applyMigrations(ownerPool);
              }
            }
          }
        }
      }
    }
  });

  it("rolls migration SQL back when the journal insert fails", async () => {
    await ownerPool.query("DELETE FROM throughline_migrations.journal");
    await ownerPool.query("DROP POLICY tenants_current_tenant ON identity.tenants");

    try {
      await ownerPool.query(`
        CREATE FUNCTION throughline_migrations.reject_journal_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
          RAISE EXCEPTION 'intentional migration journal insert failure';
        END
        $trigger$
      `);
      await ownerPool.query(`
        CREATE TRIGGER reject_journal_insert
        BEFORE INSERT ON throughline_migrations.journal
        FOR EACH ROW
        EXECUTE FUNCTION throughline_migrations.reject_journal_insert()
      `);

      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        "intentional migration journal insert failure"
      );

      const rolledBack = await ownerPool.query<{
        journal_count: string;
        policy_count: string;
      }>(
        `
        SELECT
          (SELECT count(*)::text FROM throughline_migrations.journal) AS journal_count,
          (
            SELECT count(*)::text
            FROM pg_policies
            WHERE schemaname = 'identity'
              AND tablename = 'tenants'
              AND policyname = 'tenants_current_tenant'
          ) AS policy_count
        `
      );

      expect(rolledBack.rows[0]).toEqual({
        journal_count: "0",
        policy_count: "0"
      });
    } finally {
      await ownerPool.query(
        "DROP TRIGGER IF EXISTS reject_journal_insert ON throughline_migrations.journal"
      );
      await ownerPool.query(
        "DROP FUNCTION IF EXISTS throughline_migrations.reject_journal_insert()"
      );
      await applyMigrations(ownerPool);
    }
  });

  it("serializes concurrent migration callers into one apply and one skip", async () => {
    await ownerPool.query("DELETE FROM throughline_migrations.journal");

    try {
      const runs = await Promise.all([applyMigrations(ownerPool), applyMigrations(ownerPool)]);
      const journal = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
        [migrationId]
      );

      expect(runs).toEqual(
        expect.arrayContaining([
          { applied: migrationIds, skipped: [] },
          { applied: [], skipped: migrationIds }
        ])
      );
      expect(runs).toHaveLength(2);
      expect(journal.rows[0]?.count).toBe("1");
    } finally {
      await applyMigrations(ownerPool);
    }
  });

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
  });

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
