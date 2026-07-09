import type { SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuthorizationService } from "./authorization-service.js";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  seedWaveA2DeterministicData,
  type PgPool
} from "@throughline/db";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const maybeDescribe = ownerUrl && appUrl ? describe : describe.skip;

maybeDescribe("AuthorizationService database decisions", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let service: PostgresAuthorizationService;

  beforeAll(async () => {
    if (!ownerUrl || !appUrl) {
      throw new Error(
        "TEST_DATABASE_URL and TEST_APP_DATABASE_URL are required for database decisions"
      );
    }

    ownerPool = createPgPool(ownerUrl);
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl);
    appPool = createPgPool(appUrl);
    service = new PostgresAuthorizationService(appPool);
    await seedWaveA2DeterministicData(ownerPool);
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it("checks the live active policy before default-denying a service principal", async () => {
    const decision = await service.can(
      createDevSecurityContext("tenant-a-service"),
      "workspace.read",
      {
        type: "workspace",
        id: devFixtures.workspaceA
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("principal_default_denied");
  });

  it("checks the live active policy before default-denying an agent principal", async () => {
    const decision = await service.can(createDevSecurityContext("tenant-a-agent"), "space.read", {
      type: "space",
      id: devFixtures.rootSpaceA
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("principal_default_denied");
  });

  it("fails closed when the context policy version does not exist", async () => {
    const decision = await service.can(
      {
        ...createDevSecurityContext("tenant-a-service"),
        policyVersion: "missing-v1"
      },
      "workspace.read",
      {
        type: "workspace",
        id: devFixtures.workspaceA
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("policy_version_not_active");
  });

  it("fails closed when the context policy version is retired", async () => {
    await ownerPool.query(
      `
      INSERT INTO identity.policy_versions
        (id, tenant_id, workspace_id, status, description)
      VALUES ('retired-v1', $1, $2, 'retired', 'Retired policy regression fixture')
      ON CONFLICT (tenant_id, workspace_id, id)
      DO UPDATE SET status = 'retired'
      `,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );

    const decision = await service.can(
      {
        ...createDevSecurityContext("tenant-a-owner"),
        policyVersion: "retired-v1"
      },
      "workspace.read",
      {
        type: "workspace",
        id: devFixtures.workspaceA
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("policy_version_not_active");
  });

  it("allows an active owner to read a restricted Space in their workspace", async () => {
    const decision = await service.can(createDevSecurityContext("tenant-a-owner"), "space.read", {
      type: "space",
      id: devFixtures.restrictedSpaceA
    });

    expect(decision.allowed).toBe(true);
  });

  it("denies cross-tenant Space reads without leaking title/count details", async () => {
    const decision = await service.can(createDevSecurityContext("tenant-b-viewer"), "space.read", {
      type: "space",
      id: devFixtures.restrictedSpaceA
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("space_not_found");
  });

  it("denies tenant.read when the target tenant is outside the current context", async () => {
    const decision = await service.can(createDevSecurityContext("tenant-a-owner"), "tenant.read", {
      type: "tenant",
      id: devFixtures.tenantB
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("wrong_tenant");
  });

  it("denies workspace.manage_members when the target workspace is outside the current context", async () => {
    const decision = await service.can(
      createDevSecurityContext("tenant-a-owner"),
      "workspace.manage_members",
      {
        type: "workspace",
        id: devFixtures.workspaceB
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("wrong_workspace");
  });

  it("denies restricted child Space reads to same-workspace viewers without direct grants", async () => {
    const decision = await service.can(createDevSecurityContext("tenant-a-viewer"), "space.read", {
      type: "space",
      id: devFixtures.restrictedSpaceA
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("space_access_denied");
  });

  it("does not let root grants inherit through a restricted ancestor", async () => {
    await ownerPool.query(
      `
      INSERT INTO access.access_relationships
        (tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
      VALUES ($1, $2, 'membership', $3, 'viewer', 'space', $4, 'direct')
      `,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        devFixtures.rootSpaceA
      ]
    );

    const decision = await service.can(createDevSecurityContext("tenant-a-viewer"), "space.read", {
      type: "space",
      id: devFixtures.restrictedChildSpaceA
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("space_access_denied");
  });

  it("lets a grant at the restricted boundary inherit to an inheriting child", async () => {
    await ownerPool.query(
      `
      INSERT INTO access.access_relationships
        (tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
      VALUES ($1, $2, 'membership', $3, 'viewer', 'space', $4, 'direct')
      `,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        devFixtures.restrictedSpaceA
      ]
    );

    const decision = await service.can(createDevSecurityContext("tenant-a-viewer"), "space.read", {
      type: "space",
      id: devFixtures.restrictedChildSpaceA
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe("inherited_space_grant");
  });

  it("lets a direct child grant read the child under a restricted ancestor", async () => {
    await ownerPool.query(
      `
      INSERT INTO access.access_relationships
        (tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
      VALUES ($1, $2, 'membership', $3, 'viewer', 'space', $4, 'direct')
      `,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        devFixtures.restrictedChildSpaceA
      ]
    );

    const decision = await service.can(createDevSecurityContext("tenant-a-viewer"), "space.read", {
      type: "space",
      id: devFixtures.restrictedChildSpaceA
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe("direct_space_grant");
  });

  it("denies stale contexts after live membership suspension", async () => {
    const context = createDevSecurityContext("tenant-a-owner");
    await ownerPool.query("UPDATE identity.memberships SET status = 'suspended' WHERE id = $1", [
      devFixtures.membershipAOwner
    ]);

    try {
      const decision = await service.can(context, "workspace.manage_members", {
        type: "workspace",
        id: devFixtures.workspaceA
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("principal_not_active");
    } finally {
      await ownerPool.query("UPDATE identity.memberships SET status = 'active' WHERE id = $1", [
        devFixtures.membershipAOwner
      ]);
    }
  });

  it("does not let Person records authorize actions", async () => {
    const context: Record<string, unknown> = {
      ...createDevSecurityContext("tenant-a-owner"),
      actorDisplayPersonId: devFixtures.externalPersonA
    };
    delete context.actorUserId;
    delete context.actorMembershipId;

    const decision = await service.can(
      context as unknown as SecurityContext,
      "workspace.manage_members",
      {
        type: "workspace",
        id: devFixtures.workspaceA
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("invalid_context");
  });
});
