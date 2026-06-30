import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { withTenantTransaction } from "./transaction.js";

const ownerUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const appUrl =
  process.env.TEST_APP_DATABASE_URL ??
  ownerUrl?.replace("throughline:throughline_dev@", "throughline_app:throughline_app_dev@");
const maybeDescribe = ownerUrl && appUrl ? describe : describe.skip;

maybeDescribe("Wave A2 database RLS security", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });

  beforeAll(async () => {
    await applyMigrations(ownerPool, { reset: true });
    await seedWaveA2DeterministicData(ownerPool);
  });

  afterAll(async () => {
    await appPool.end();
    await ownerPool.end();
  });

  it("creates an app role without BYPASSRLS", async () => {
    const result = await ownerPool.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'throughline_app'"
    );

    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  it("denies tenant B rows through the app role under tenant A context", async () => {
    const context = createDevSecurityContext("tenant-a-owner");

    const visibleSpaces = await withTenantTransaction({ pool: appPool, context }, (tx) =>
      tx.query<{ id: string }>("SELECT id FROM access.spaces ORDER BY id")
    );

    expect(visibleSpaces.rows.map((row: { id: string }) => row.id).sort()).toEqual(
      [devFixtures.restrictedSpaceA, devFixtures.rootSpaceA].sort()
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
