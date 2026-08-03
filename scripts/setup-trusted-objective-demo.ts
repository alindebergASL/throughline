import {
  applyMigrations,
  createPgPool,
  provisionProductRelayDirectManagerAccess,
  seedWaveA2DeterministicData,
  withTenantTransaction
} from "../packages/db/src/index.ts";
import { createDevSecurityContext, devFixtures } from "../packages/tenancy/src/index.ts";
import {
  TRUSTED_OBJECTIVE_DEMO_DATABASE,
  demoDatabaseUrl,
  parseDemoAdminUrl,
  trustedObjectiveDemoFixtures as demo
} from "./trusted-objective-demo-config.ts";

async function main(): Promise<void> {
  if (!process.argv.includes("--reset")) {
    throw new Error("Refusing to reset demo data without the explicit --reset flag");
  }
  const adminUrl = parseDemoAdminUrl(process.env.DEMO_ADMIN_DATABASE_URL);
  const appPassword = process.env.DEMO_APP_ROLE_PASSWORD;
  if (!appPassword || appPassword.length < 12 || /[\r\n\0]/u.test(appPassword)) {
    throw new Error("DEMO_APP_ROLE_PASSWORD must contain at least 12 safe characters");
  }

  const adminPool = createPgPool(adminUrl.toString());
  try {
    await adminPool.query(
      `DROP DATABASE IF EXISTS ${TRUSTED_OBJECTIVE_DEMO_DATABASE} WITH (FORCE)`
    );
    await adminPool.query(`CREATE DATABASE ${TRUSTED_OBJECTIVE_DEMO_DATABASE}`);
  } finally {
    await adminPool.end();
  }

  const ownerPool = createPgPool(demoDatabaseUrl(adminUrl));
  try {
    await applyMigrations(ownerPool);
    const roleClient = await ownerPool.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('throughline.demo_app_password', $1, true)", [
        appPassword
      ]);
      await roleClient.query(`
        DO $demo_role$
        BEGIN
          EXECUTE format(
            'ALTER ROLE throughline_app LOGIN NOBYPASSRLS PASSWORD %L',
            current_setting('throughline.demo_app_password')
          );
        END
        $demo_role$
      `);
      await roleClient.query("COMMIT");
    } catch (error) {
      await roleClient.query("ROLLBACK");
      throw error;
    } finally {
      roleClient.release();
    }
    await seedWaveA2DeterministicData(ownerPool);
    await seedPrerequisites(ownerPool);
  } finally {
    await ownerPool.end();
  }

  console.log("Trusted-objective demo is ready.");
  console.log(
    `Initiative URL: http://localhost:3000/organizations/initiatives/${demo.initiativeId}`
  );
  console.log(
    "Owner API: AUTH_ADAPTER=dev TRUSTED_OBJECTIVE_DEMO_PERSONA=owner pnpm --filter @throughline/api dev"
  );
  console.log(
    "Web server (no persona authority): THROUGHLINE_API_ORIGIN=http://127.0.0.1:3001 pnpm --filter @throughline/web dev"
  );
  console.log(
    "Unavailable validation: restart the API with TRUSTED_OBJECTIVE_DEMO_PERSONA=unavailable; use the unchanged web server configuration"
  );
  console.log(
    `API DATABASE_URL template: postgres://throughline_app:<DEMO_APP_ROLE_PASSWORD>@${adminUrl.hostname}:${adminUrl.port || "5432"}/${TRUSTED_OBJECTIVE_DEMO_DATABASE}`
  );
  console.log("No SourceArtifact, Claim, or AcceptedFact was seeded.");
}

async function seedPrerequisites(ownerPool: ReturnType<typeof createPgPool>): Promise<void> {
  const context = {
    ...createDevSecurityContext("tenant-a-owner"),
    requestedSpaceIds: [demo.initiativeSpaceId]
  };
  await withTenantTransaction({ pool: ownerPool, context }, async (tx) => {
    await tx.query(
      `INSERT INTO access.spaces (
         id, tenant_id, workspace_id, parent_space_id, kind, name, slug,
         access_class, inheritance_mode
       ) VALUES
         ($1,$2,$3,$4,'organization','Northstar County Services','northstar-county-services','workspace','inherit'),
         ($5,$2,$3,$1,'initiative','Resident Service Response','resident-service-response','workspace','inherit')`,
      [
        demo.organizationSpaceId,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.rootSpaceA,
        demo.initiativeSpaceId
      ]
    );
    await tx.query(
      `INSERT INTO work.organizations (
         id, tenant_id, workspace_id, space_id, name, normalized_name, status
       ) VALUES ($1,$2,$3,$4,'Northstar County Services','northstar county services','active')`,
      [demo.organizationId, devFixtures.tenantA, devFixtures.workspaceA, demo.organizationSpaceId]
    );
    await tx.query(
      `INSERT INTO work.organization_domains (
         tenant_id, workspace_id, space_id, organization_id, domain
       ) VALUES ($1,$2,$3,$4,'northstar.example')`,
      [devFixtures.tenantA, devFixtures.workspaceA, demo.organizationSpaceId, demo.organizationId]
    );
    await tx.query(
      `INSERT INTO work.initiatives (
         id, tenant_id, workspace_id, space_id, title, type_key, stage_key, health,
         owner_person_id, profile_id, profile_version
       ) VALUES (
         $1,$2,$3,$4,'Resident Service Response','application','workshop','active',
         $5,'ai-solutions','1.0.0'
       )`,
      [
        demo.initiativeId,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        demo.initiativeSpaceId,
        devFixtures.personA
      ]
    );
    await tx.query(
      `INSERT INTO work.initiative_organizations (
         tenant_id, workspace_id, space_id, initiative_id, organization_id, association_role
       ) VALUES ($1,$2,$3,$4,$5,'primary')`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        demo.initiativeSpaceId,
        demo.initiativeId,
        demo.organizationId
      ]
    );
    await tx.query(
      `INSERT INTO work.activities (
         id, tenant_id, workspace_id, space_id, subtype, profile_template_key,
         title, status, occurred_at, owner_person_id, governing_initiative_id
       ) VALUES (
         $1,$2,$3,$4,'discovery','discovery','Resident services discovery','completed',
         '2026-06-18T14:00:00Z',$5,$6
       )`,
      [
        demo.activityId,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        demo.initiativeSpaceId,
        devFixtures.personA,
        demo.initiativeId
      ]
    );
    await tx.query(
      `INSERT INTO work.activity_organizations (
         tenant_id, workspace_id, space_id, activity_id, organization_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        demo.initiativeSpaceId,
        demo.activityId,
        demo.organizationId
      ]
    );
    await tx.query(
      `INSERT INTO work.activity_initiatives (
         tenant_id, workspace_id, space_id, activity_id, initiative_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        demo.initiativeSpaceId,
        demo.activityId,
        demo.initiativeId
      ]
    );
    await provisionProductRelayDirectManagerAccess(tx, {
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: demo.initiativeSpaceId
    });
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo setup failed");
  process.exitCode = 1;
});
