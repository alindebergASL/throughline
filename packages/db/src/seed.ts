import { devFixtures, DEV_POLICY_VERSION } from "@throughline/tenancy";
import type { PgPool } from "./client.js";

export async function seedWaveA2DeterministicData(pool: PgPool): Promise<void> {
  await pool.query(
    `
    INSERT INTO identity.tenants (id, slug, name, status, default_access_class)
    VALUES
      ($1, 'tenant-a', 'Tenant A', 'active', 'workspace'),
      ($2, 'tenant-b', 'Tenant B', 'active', 'workspace')
    ON CONFLICT (id) DO NOTHING
    `,
    [devFixtures.tenantA, devFixtures.tenantB]
  );

  await pool.query(
    `
    INSERT INTO identity.workspaces
      (id, tenant_id, slug, name, status, profile_id, profile_version, default_access_class)
    VALUES
      ($1, $2, 'workspace-a', 'Workspace A', 'active', 'ai-solutions', 'v1', 'workspace'),
      ($3, $4, 'workspace-b', 'Workspace B', 'active', 'ai-solutions', 'v1', 'workspace')
    ON CONFLICT (id) DO NOTHING
    `,
    [devFixtures.workspaceA, devFixtures.tenantA, devFixtures.workspaceB, devFixtures.tenantB]
  );

  await pool.query(
    `
    INSERT INTO identity.users (id, auth_provider, auth_subject, primary_email, status)
    VALUES
      ($1, 'dev', 'tenant-a-owner', 'owner-a@example.com', 'active'),
      ($2, 'dev', 'tenant-b-viewer', 'viewer-b@example.com', 'active')
    ON CONFLICT (id) DO NOTHING
    `,
    [devFixtures.userA, devFixtures.userB]
  );

  await pool.query(
    `
    INSERT INTO identity.people (id, tenant_id, workspace_id, display_name, primary_email, is_internal)
    VALUES
      ($1, $2, $3, 'Owner A', 'owner-a@example.com', true),
      ($4, $5, $6, 'Viewer B', 'viewer-b@example.com', true),
      ($7, $2, $3, 'External Contact A', 'external-a@example.com', false),
      ($8, $2, $3, 'Viewer B in Tenant A', 'viewer-b@example.com', true)
    ON CONFLICT (id) DO NOTHING
    `,
    [
      devFixtures.personA,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.personB,
      devFixtures.tenantB,
      devFixtures.workspaceB,
      devFixtures.externalPersonA,
      devFixtures.personBInTenantA
    ]
  );

  await pool.query(
    `
    INSERT INTO identity.memberships (id, tenant_id, workspace_id, user_id, person_id, role, status)
    VALUES
      ($1, $2, $3, $4, $5, 'owner', 'active'),
      ($6, $7, $8, $9, $10, 'viewer', 'active'),
      ($11, $2, $3, $9, $12, 'viewer', 'active')
    ON CONFLICT (id) DO NOTHING
    `,
    [
      devFixtures.membershipAOwner,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.userA,
      devFixtures.personA,
      devFixtures.membershipBViewer,
      devFixtures.tenantB,
      devFixtures.workspaceB,
      devFixtures.userB,
      devFixtures.personB,
      devFixtures.membershipAViewer,
      devFixtures.personBInTenantA
    ]
  );

  await pool.query(
    `
    INSERT INTO identity.service_principals (id, tenant_id, workspace_id, name, purpose, status)
    VALUES ($1, $2, $3, 'Worker A', 'worker', 'active')
    ON CONFLICT (id) DO NOTHING
    `,
    [devFixtures.servicePrincipalA, devFixtures.tenantA, devFixtures.workspaceA]
  );

  await pool.query(
    `
    INSERT INTO identity.agent_principals (id, tenant_id, workspace_id, name, runtime_policy_id, status)
    VALUES ($1, $2, $3, 'Agent A', 'a2-placeholder', 'active')
    ON CONFLICT (id) DO NOTHING
    `,
    [devFixtures.agentPrincipalA, devFixtures.tenantA, devFixtures.workspaceA]
  );

  await pool.query(
    `
    INSERT INTO access.spaces
      (id, tenant_id, workspace_id, parent_space_id, kind, name, slug, access_class, inheritance_mode)
    VALUES
      ($1, $2, $3, NULL, 'workspace_root', 'Workspace A Root', 'root', 'workspace', 'inherit'),
      ($4, $2, $3, $1, 'knowledge', 'Tenant A Restricted', 'restricted', 'restricted', 'restricted'),
      ($5, $2, $3, $4, 'knowledge', 'Tenant A Restricted Child', 'restricted-child', 'restricted', 'inherit'),
      ($6, $7, $8, NULL, 'workspace_root', 'Workspace B Root', 'root', 'workspace', 'inherit')
    ON CONFLICT (id) DO NOTHING
    `,
    [
      devFixtures.rootSpaceA,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      devFixtures.restrictedChildSpaceA,
      devFixtures.rootSpaceB,
      devFixtures.tenantB,
      devFixtures.workspaceB
    ]
  );

  await pool.query(
    `
    UPDATE identity.workspaces
    SET default_space_id = CASE
      WHEN id = $1 THEN $2::uuid
      WHEN id = $3 THEN $4::uuid
      ELSE default_space_id
    END
    WHERE id IN ($1, $3)
    `,
    [devFixtures.workspaceA, devFixtures.rootSpaceA, devFixtures.workspaceB, devFixtures.rootSpaceB]
  );

  await pool.query(
    `
    INSERT INTO identity.policy_versions (id, tenant_id, workspace_id, status, description)
    VALUES
      ($1, $2, $3, 'active', 'Wave A2 deterministic test policy'),
      ($1, $4, $5, 'active', 'Wave A2 deterministic test policy')
    ON CONFLICT (tenant_id, workspace_id, id) DO NOTHING
    `,
    [
      DEV_POLICY_VERSION,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.tenantB,
      devFixtures.workspaceB
    ]
  );
}
