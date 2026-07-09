import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, type MigrationRunResult } from "./migrations.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { provisionTestAppRole } from "./test-database.js";
import { withTenantTransaction } from "./transaction.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const maybeDescribe = ownerUrl && appUrl ? describe : describe.skip;

maybeDescribe("Wave A2 database RLS security", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  let cleanMigrationRun: MigrationRunResult;
  let repeatedMigrationRun: MigrationRunResult;

  beforeAll(async () => {
    cleanMigrationRun = await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl!);
    repeatedMigrationRun = await applyMigrations(ownerPool);
    await seedWaveA2DeterministicData(ownerPool);
  });

  afterAll(async () => {
    await appPool.end();
    await ownerPool.end();
  });

  it("applies migration 0001 cleanly once and treats a repeated apply as a no-op", async () => {
    const migrationId = "0001_wave_a2_identity_access_rls.sql";
    const journal = await ownerPool.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM throughline_migrations.journal
      WHERE id = $1
      `,
      [migrationId]
    );

    expect(cleanMigrationRun).toEqual({ applied: [migrationId], skipped: [] });
    expect(repeatedMigrationRun).toEqual({ applied: [], skipped: [migrationId] });
    expect(journal.rows[0]?.count).toBe("1");
  });

  it("fails closed if an applied migration filename has a different checksum", async () => {
    const migrationId = "0001_wave_a2_identity_access_rls.sql";
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

  it("connects through the app pool as throughline_app without BYPASSRLS", async () => {
    const result = await appPool.query<{ current_user: string; rolbypassrls: boolean }>(
      `
      SELECT current_user, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
      `
    );

    expect(result.rows[0]?.current_user).toBe("throughline_app");
    expect(result.rows[0]?.rolbypassrls).toBe(false);
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
