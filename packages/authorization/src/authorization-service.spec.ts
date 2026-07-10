import type { SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresAuthorizationService } from "./authorization-service.js";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  seedWaveA2DeterministicData,
  type PgPool
} from "@throughline/db";
import type { TenantQueryExecutor } from "@throughline/db";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const maybeDescribe = ownerUrl && appUrl ? describe : describe.skip;

describe("AuthorizationService context boundary", () => {
  it("denies an elapsed SecurityContext without acquiring a database connection", async () => {
    const connect = vi.fn();
    const service = new PostgresAuthorizationService({ connect } as unknown as PgPool);
    const context = createDevSecurityContext("tenant-a-owner", {
      now: new Date("2000-01-01T00:00:00.000Z")
    });

    const decision = await service.can(context, "workspace.read", {
      type: "workspace",
      id: devFixtures.workspaceA
    });

    expect(decision).toMatchObject({
      allowed: false,
      reasonCode: "context_expired",
      explanation: "SecurityContext has expired"
    });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("foundation.proof.create exact authorization", () => {
  function executor(role: "owner" | "admin" | "member" = "owner", hasSpace = true) {
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM identity.tenants")) return { rows: [{ status: "active" }] };
        if (sql.includes("FROM identity.workspaces")) return { rows: [{ status: "active" }] };
        if (sql.includes("FROM identity.policy_versions")) return { rows: [{ status: "active" }] };
        if (sql.includes("FROM identity.memberships")) {
          return {
            rows: [{ role, membership_status: "active", user_status: "active" }]
          };
        }
        if (sql.includes("FROM access.spaces")) {
          return { rows: hasSpace ? [{ id: devFixtures.restrictedSpaceA }] : [] };
        }
        throw new Error(`Unexpected authorization query: ${sql}`);
      })
    } as unknown as TenantQueryExecutor;
    return { queries, tx };
  }

  it.each(["owner", "admin"] as const)(
    "allows an active %s only through the shared current Space-read decision",
    async (role) => {
      const { queries, tx } = executor(role);
      const service = new PostgresAuthorizationService({} as PgPool);
      const context = {
        ...createDevSecurityContext("tenant-a-owner"),
        requestedSpaceIds: [devFixtures.restrictedSpaceA]
      };

      const decision = await service.canInTransaction(
        context,
        "foundation.proof.create",
        { type: "space", id: devFixtures.restrictedSpaceA },
        tx as never
      );

      expect(decision).toMatchObject({
        allowed: true,
        reasonCode: "foundation_owner_or_admin_space_authorized",
        evaluatedRelationships: ["workspace_admin_space_read"]
      });
      expect(queries.filter((sql) => sql.includes("FROM access.spaces"))).toHaveLength(1);
      expect(queries.every((sql) => /FOR SHARE/.test(sql))).toBe(true);
    }
  );

  it.each([
    ["wrong", devFixtures.restrictedSpaceA, devFixtures.rootSpaceA, false],
    ["cross-workspace", devFixtures.rootSpaceB, devFixtures.rootSpaceB, true],
    ["archived", devFixtures.restrictedSpaceA, devFixtures.restrictedSpaceA, true]
  ] as const)(
    "denies %s Space scope without accepting an unlocked or stale target",
    async (_case, resourceId, requestedSpaceId, reachesLockedLookup) => {
      const { queries, tx } = executor("owner", false);
      const service = new PostgresAuthorizationService({} as PgPool);
      const context = {
        ...createDevSecurityContext("tenant-a-owner"),
        requestedSpaceIds: [requestedSpaceId]
      };
      const decision = await service.canInTransaction(
        context,
        "foundation.proof.create",
        { type: "space", id: resourceId },
        tx as never
      );

      expect(decision.allowed).toBe(false);
      if (reachesLockedLookup) {
        expect(decision.reasonCode).toBe("space_not_found");
        expect(queries.at(-1)).toMatch(
          /FROM access\.spaces[\s\S]*archived_at IS NULL[\s\S]*FOR SHARE/
        );
      } else {
        expect(decision.reasonCode).toBe("foundation_space_scope_mismatch");
        expect(queries).toEqual([]);
      }
    }
  );

  it("keeps lower roles closed before the shared Space decision", async () => {
    const { queries, tx } = executor("member");
    const service = new PostgresAuthorizationService({} as PgPool);
    const context = {
      ...createDevSecurityContext("tenant-a-owner"),
      requestedSpaceIds: [devFixtures.restrictedSpaceA]
    };
    const decision = await service.canInTransaction(
      context,
      "foundation.proof.create",
      { type: "space", id: devFixtures.restrictedSpaceA },
      tx as never
    );

    expect(decision).toMatchObject({ allowed: false, reasonCode: "role_denied" });
    expect(queries.some((sql) => sql.includes("FROM access.spaces"))).toBe(false);
  });

  it.each(["tenant-a-service", "tenant-a-agent"] as const)(
    "keeps the exact action closed to %s",
    async (identity) => {
      const { queries, tx } = executor();
      const service = new PostgresAuthorizationService({} as PgPool);
      const context = {
        ...createDevSecurityContext(identity),
        requestedSpaceIds: [devFixtures.restrictedSpaceA]
      };
      const decision = await service.canInTransaction(
        context,
        "foundation.proof.create",
        { type: "space", id: devFixtures.restrictedSpaceA },
        tx as never
      );

      expect(decision).toMatchObject({
        allowed: false,
        reasonCode: "foundation_human_actor_required"
      });
      expect(queries).toEqual([]);
    }
  );
});

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
