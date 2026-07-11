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

describe("foundation.relay.publish exact authorization", () => {
  const relayContext = (overrides: Partial<SecurityContext> = {}): SecurityContext => ({
    ...createDevSecurityContext("tenant-a-service"),
    servicePrincipalId: devFixtures.relayServicePrincipalA,
    requestedSpaceIds: [devFixtures.restrictedSpaceA],
    ...overrides
  });

  function relayExecutor(
    overrides: {
      tenantStatus?: string;
      workspaceStatus?: string;
      policyStatus?: string;
      purpose?: string;
      principalStatus?: string;
      spaceActive?: boolean;
      grant?: { relation: string; source: string } | undefined;
    } = {}
  ) {
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM identity.tenants")) {
          return { rows: [{ status: overrides.tenantStatus ?? "active" }] };
        }
        if (sql.includes("FROM identity.workspaces")) {
          return { rows: [{ status: overrides.workspaceStatus ?? "active" }] };
        }
        if (sql.includes("FROM identity.policy_versions")) {
          return { rows: [{ status: overrides.policyStatus ?? "active" }] };
        }
        if (sql.includes("FROM identity.service_principals")) {
          return {
            rows: [
              {
                purpose: overrides.purpose ?? "system",
                status: overrides.principalStatus ?? "active"
              }
            ]
          };
        }
        if (sql.includes("FROM access.spaces")) {
          return {
            rows: overrides.spaceActive === false ? [] : [{ id: devFixtures.restrictedSpaceA }]
          };
        }
        if (sql.includes("FROM access.access_relationships")) {
          return {
            rows:
              overrides.grant === undefined
                ? [{ id: "grant" }]
                : overrides.grant.relation === "manager" && overrides.grant.source === "direct"
                  ? [{ id: "grant" }]
                  : []
          };
        }
        throw new Error(`Unexpected relay authorization query: ${sql}`);
      })
    } as unknown as TenantQueryExecutor;
    return { queries, tx };
  }

  it("allows exactly one active system relay principal with a direct manager grant", async () => {
    const { queries, tx } = relayExecutor();
    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      relayContext(),
      "foundation.relay.publish",
      { type: "space", id: devFixtures.restrictedSpaceA },
      tx as never
    );

    expect(decision).toMatchObject({
      allowed: true,
      reasonCode: "foundation_relay_direct_manager"
    });
    expect(queries).toHaveLength(6);
    expect(queries.every((sql) => !/\bFOR\s+(?:SHARE|UPDATE)\b/i.test(sql))).toBe(true);
  });

  it.each([
    ["missing scope", { requestedSpaceIds: [] }, {}, "foundation_space_scope_mismatch"],
    [
      "wrong scope",
      { requestedSpaceIds: [devFixtures.rootSpaceA] },
      {},
      "foundation_space_scope_mismatch"
    ],
    [
      "human actor",
      {
        servicePrincipalId: undefined,
        actorUserId: devFixtures.userA,
        actorMembershipId: devFixtures.membershipAOwner
      },
      {},
      "foundation_relay_service_principal_required"
    ],
    [
      "agent actor",
      { servicePrincipalId: undefined, agentPrincipalId: devFixtures.agentPrincipalA },
      {},
      "foundation_relay_service_principal_required"
    ],
    ["inactive tenant", {}, { tenantStatus: "suspended" }, "tenant_not_active"],
    ["inactive workspace", {}, { workspaceStatus: "archived" }, "workspace_not_active"],
    ["inactive policy", {}, { policyStatus: "retired" }, "policy_version_not_active"],
    ["disabled principal", {}, { principalStatus: "disabled" }, "relay_principal_not_active"],
    ["wrong purpose", {}, { purpose: "worker" }, "relay_principal_wrong_purpose"],
    ["inactive Space", {}, { spaceActive: false }, "space_not_found"],
    [
      "non-manager grant",
      {},
      { grant: { relation: "contributor", source: "direct" } },
      "relay_direct_manager_required"
    ],
    [
      "non-direct grant",
      {},
      { grant: { relation: "manager", source: "inherited" } },
      "relay_direct_manager_required"
    ]
  ] as const)("denies %s", async (_name, contextOverrides, dbOverrides, reasonCode) => {
    const { tx } = relayExecutor(dbOverrides);
    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      relayContext({ ...contextOverrides } as Partial<SecurityContext>),
      "foundation.relay.publish",
      { type: "space", id: devFixtures.restrictedSpaceA },
      tx as never
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode });
  });

  it("default-denies the same relay principal for every existing non-relay action", async () => {
    const { tx } = relayExecutor();
    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      relayContext(),
      "space.read",
      { type: "space", id: devFixtures.restrictedSpaceA },
      tx as never
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "principal_default_denied" });
  });
});

describe("foundation.worker.consume exact authorization", () => {
  const workerId = "70000000-0000-7000-8000-000000000051";
  const referenceId = "70000000-0000-7000-8000-000000000031";
  const jobId = "70000000-0000-7000-8000-000000000021";
  const delegatorUserId = "70000000-0000-7000-8000-000000000081";
  const delegatorMembershipId = "70000000-0000-7000-8000-000000000083";

  const workerContext = (overrides: Partial<SecurityContext> = {}): SecurityContext => ({
    ...createDevSecurityContext("tenant-a-service"),
    servicePrincipalId: workerId,
    delegatedByUserId: delegatorUserId,
    delegatedByMembershipId: delegatorMembershipId,
    requestedSpaceIds: [devFixtures.restrictedSpaceA],
    ...overrides
  });

  type WorkerBinding = {
    referenceId: string;
    jobId: string;
    workerServicePrincipalId: string;
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    policyVersionId: string;
    delegatingUserId: string;
    delegatingMembershipId: string;
  };

  const binding = (overrides: Partial<WorkerBinding> = {}): WorkerBinding => ({
    referenceId,
    jobId,
    workerServicePrincipalId: workerId,
    tenantId: devFixtures.tenantA,
    workspaceId: devFixtures.workspaceA,
    spaceId: devFixtures.restrictedSpaceA,
    policyVersionId: "default-v1",
    delegatingUserId: delegatorUserId,
    delegatingMembershipId: delegatorMembershipId,
    ...overrides
  });

  function workerExecutor(
    overrides: Partial<{
      tenantStatus: string;
      workspaceStatus: string;
      policyStatus: string;
      purpose: string;
      workerStatus: string;
      userStatus: string;
      membershipStatus: string;
      membershipRole: "owner" | "admin" | "member" | "viewer";
      spaceActive: boolean;
      workerGrant: { relation: string; source: string } | null;
      delegatorGrant: boolean;
      referenceStatus: string;
      referenceRevokedAt: Date | null;
      referenceExpiresAt: Date;
    }> = {}
  ) {
    const queries: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const tx = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("FROM ops.security_context_references")) {
          return {
            rows: [
              {
                referenceId,
                status: overrides.referenceStatus ?? "active",
                revokedAt: overrides.referenceRevokedAt ?? null,
                expiresAt: overrides.referenceExpiresAt ?? new Date("2099-01-01T00:00:00.000Z"),
                tenantId: devFixtures.tenantA,
                workspaceId: devFixtures.workspaceA,
                spaceId: devFixtures.restrictedSpaceA,
                jobId,
                workerServicePrincipalId: workerId,
                policyVersionId: "default-v1",
                delegatingUserId: delegatorUserId,
                delegatingMembershipId: delegatorMembershipId
              }
            ]
          };
        }
        if (sql.includes("FROM identity.tenants")) {
          return { rows: [{ status: overrides.tenantStatus ?? "active" }] };
        }
        if (sql.includes("FROM identity.workspaces")) {
          return { rows: [{ status: overrides.workspaceStatus ?? "active" }] };
        }
        if (sql.includes("FROM identity.policy_versions")) {
          return { rows: [{ status: overrides.policyStatus ?? "active" }] };
        }
        if (sql.includes("FROM identity.service_principals")) {
          return {
            rows: [
              {
                purpose: overrides.purpose ?? "worker",
                status: overrides.workerStatus ?? "active"
              }
            ]
          };
        }
        if (sql.includes("FROM identity.users")) {
          return { rows: [{ status: overrides.userStatus ?? "active" }] };
        }
        if (sql.includes("FROM identity.memberships")) {
          return {
            rows: [
              {
                status: overrides.membershipStatus ?? "active",
                role: overrides.membershipRole ?? "member"
              }
            ]
          };
        }
        if (sql.includes("FROM access.spaces")) {
          return { rows: overrides.spaceActive === false ? [] : [{ id: binding().spaceId }] };
        }
        if (sql.includes("FROM access.access_relationships")) {
          if (sql.includes("subject_type = 'service_principal'")) {
            const grant =
              overrides.workerGrant === undefined
                ? { relation: "contributor", source: "direct" }
                : overrides.workerGrant;
            return { rows: grant ? [grant] : [] };
          }
          return { rows: overrides.delegatorGrant === false ? [] : [{ id: "delegator-grant" }] };
        }
        throw new Error(`Unexpected worker authorization query: ${sql}`);
      })
    } as unknown as TenantQueryExecutor;
    return { queries, tx };
  }

  const workerAuthorizationService = new PostgresAuthorizationService({} as PgPool) as unknown as {
    canInTransaction(
      context: SecurityContext,
      action: string,
      resource: { type: "space"; id: string },
      tx: TenantQueryExecutor,
      options: { workerBinding: WorkerBinding }
    ): Promise<{ allowed: boolean; reasonCode: string; evaluatedRelationships?: string[] }>;
  };

  const authorizeWorker = (
    context: SecurityContext,
    workerBinding: WorkerBinding,
    tx: TenantQueryExecutor
  ) =>
    workerAuthorizationService.canInTransaction(
      context,
      "foundation.worker.consume",
      { type: "space", id: workerBinding.spaceId },
      tx,
      { workerBinding }
    );

  it("allows only the exact active worker and delegator pair with direct contributor authority", async () => {
    const { queries, tx } = workerExecutor();

    await expect(authorizeWorker(workerContext(), binding(), tx)).resolves.toMatchObject({
      allowed: true,
      reasonCode: "foundation_worker_direct_contributor",
      evaluatedRelationships: ["worker_direct_contributor", "delegator_current_space_access"]
    });

    expect(queries.map(({ sql }) => sql.match(/FROM\s+([a-z_.]+)/)?.[1])).toEqual([
      "ops.security_context_references",
      "identity.tenants",
      "identity.workspaces",
      "identity.policy_versions",
      "identity.service_principals",
      "identity.users",
      "identity.memberships",
      "access.spaces",
      "access.access_relationships",
      "access.access_relationships"
    ]);
    expect(queries.every(({ sql }) => /FOR UPDATE/.test(sql))).toBe(true);

    const [
      reference,
      tenant,
      workspace,
      policy,
      worker,
      user,
      membership,
      space,
      workerGrant,
      delegatorGrant
    ] = queries;
    expect(reference?.sql).toMatch(
      /id = \$1[\s\S]*job_id = \$2[\s\S]*tenant_id = \$3[\s\S]*workspace_id = \$4[\s\S]*space_id = \$5[\s\S]*worker_service_principal_id = \$6[\s\S]*policy_version_id = \$7[\s\S]*delegating_user_id = \$8[\s\S]*delegating_membership_id = \$9[\s\S]*status = 'active'[\s\S]*revoked_at IS NULL[\s\S]*expires_at > clock_timestamp\(\)/
    );
    expect(reference?.values).toEqual([
      referenceId,
      jobId,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      workerId,
      "default-v1",
      delegatorUserId,
      delegatorMembershipId
    ]);
    expect(tenant?.sql).toMatch(/id = \$1[\s\S]*status = 'active'/);
    expect(workspace?.sql).toMatch(/id = \$1[\s\S]*tenant_id = \$2[\s\S]*status = 'active'/);
    expect(policy?.sql).toMatch(
      /id = \$1[\s\S]*tenant_id = \$2[\s\S]*workspace_id = \$3[\s\S]*status = 'active'/
    );
    expect(worker?.sql).toMatch(
      /id = \$1[\s\S]*tenant_id = \$2[\s\S]*workspace_id = \$3[\s\S]*purpose = 'worker'[\s\S]*status = 'active'/
    );
    expect(user?.sql).toMatch(/id = \$1[\s\S]*status = 'active'/);
    expect(membership?.sql).toMatch(
      /id = \$1[\s\S]*user_id = \$2[\s\S]*tenant_id = \$3[\s\S]*workspace_id = \$4[\s\S]*status = 'active'/
    );
    expect(space?.sql).toMatch(
      /id = \$1[\s\S]*tenant_id = \$2[\s\S]*workspace_id = \$3[\s\S]*archived_at IS NULL/
    );
    expect(workerGrant?.sql).toMatch(
      /subject_type = 'service_principal'[\s\S]*subject_id = \$1[\s\S]*relation = 'contributor'[\s\S]*resource_type = 'space'[\s\S]*resource_id = \$2[\s\S]*source = 'direct'/
    );
    expect(delegatorGrant?.sql).toMatch(
      /subject_type IN \('membership', 'user'\)[\s\S]*subject_id IN \(\$1, \$2\)[\s\S]*relation IN \('owner', 'manager', 'contributor', 'viewer'\)[\s\S]*resource_type = 'space'[\s\S]*resource_id = \$3[\s\S]*source = 'direct'/
    );
  });

  it.each([
    ["manager", { workerGrant: { relation: "manager", source: "direct" } }],
    ["viewer", { workerGrant: { relation: "viewer", source: "direct" } }],
    ["inherited", { workerGrant: { relation: "contributor", source: "inherited" } }],
    ["system", { workerGrant: { relation: "contributor", source: "system" } }],
    ["missing", { workerGrant: null }]
  ] as const)("denies a %s worker grant", async (_name, overrides) => {
    const { tx } = workerExecutor(overrides);
    await expect(authorizeWorker(workerContext(), binding(), tx)).resolves.toMatchObject({
      allowed: false,
      reasonCode: "worker_direct_contributor_required"
    });
  });

  it.each([
    ["suspended tenant", { tenantStatus: "suspended" }, "tenant_not_active"],
    ["deleted tenant", { tenantStatus: "deleted" }, "tenant_not_active"],
    ["archived workspace", { workspaceStatus: "archived" }, "workspace_not_active"],
    ["retired policy", { policyStatus: "retired" }, "policy_version_not_active"],
    ["wrong purpose", { purpose: "system" }, "worker_principal_wrong_purpose"],
    ["disabled worker", { workerStatus: "disabled" }, "worker_principal_not_active"],
    ["disabled delegator", { userStatus: "disabled" }, "delegator_user_not_active"],
    ["suspended membership", { membershipStatus: "suspended" }, "delegator_membership_not_active"],
    ["archived Space", { spaceActive: false }, "space_not_found"],
    ["removed delegator authority", { delegatorGrant: false }, "delegator_space_access_denied"],
    ["revoked reference", { referenceStatus: "revoked" }, "context_reference_not_active"],
    [
      "revocation timestamp",
      { referenceRevokedAt: new Date("2026-01-01T00:00:00.000Z") },
      "context_reference_not_active"
    ],
    [
      "database-expired reference",
      { referenceExpiresAt: new Date("2000-01-01T00:00:00.000Z") },
      "context_reference_not_active"
    ]
  ] as const)("denies %s", async (_name, overrides, reasonCode) => {
    const { tx } = workerExecutor(overrides);
    await expect(authorizeWorker(workerContext(), binding(), tx)).resolves.toMatchObject({
      allowed: false,
      reasonCode
    });
  });

  it.each([
    ["principal", { servicePrincipalId: devFixtures.servicePrincipalA }, {}],
    ["context delegator", { delegatedByUserId: devFixtures.userB }, {}],
    ["reference", {}, { referenceId: "70000000-0000-7000-8000-000000000039" }],
    ["job", {}, { jobId: "70000000-0000-7000-8000-000000000029" }],
    ["worker", {}, { workerServicePrincipalId: devFixtures.servicePrincipalA }],
    ["tenant", {}, { tenantId: devFixtures.tenantB }],
    ["workspace", {}, { workspaceId: devFixtures.workspaceB }],
    ["Space", {}, { spaceId: devFixtures.rootSpaceB }],
    ["policy", {}, { policyVersionId: "other-v1" }],
    ["delegator", {}, { delegatingMembershipId: devFixtures.membershipAViewer }]
  ] as const)(
    "denies a mismatched %s binding after only the exact reference lock",
    async (_name, ctx, ref) => {
      const { queries, tx } = workerExecutor();
      await expect(
        authorizeWorker(workerContext(ctx as Partial<SecurityContext>), binding(ref), tx)
      ).resolves.toMatchObject({
        allowed: false,
        reasonCode: "foundation_worker_binding_mismatch"
      });
      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toMatch(/FROM ops\.security_context_references[\s\S]*FOR UPDATE/);
    }
  );

  it.each(["owner", "admin"] as const)(
    "preserves active %s delegator authority without requiring a direct Space relationship",
    async (membershipRole) => {
      const { queries, tx } = workerExecutor({ membershipRole, delegatorGrant: false });
      await expect(authorizeWorker(workerContext(), binding(), tx)).resolves.toMatchObject({
        allowed: true
      });
      expect(
        queries.filter(({ sql }) => sql.includes("FROM access.access_relationships"))
      ).toHaveLength(1);
    }
  );

  it("does not treat snapshot role or Space hints as authority", async () => {
    const { tx } = workerExecutor({ workerGrant: null, delegatorGrant: false });
    await expect(
      authorizeWorker(
        workerContext({ roleHints: ["owner", "contributor"], membershipIds: ["snapshot"] }),
        binding(),
        tx
      )
    ).resolves.toMatchObject({ allowed: false });
  });

  it("preserves the service-principal default deny for every action except worker consume", async () => {
    const { tx } = workerExecutor();
    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      workerContext(),
      "space.read",
      { type: "space", id: devFixtures.restrictedSpaceA },
      tx as never
    );
    expect(decision).toMatchObject({ allowed: false, reasonCode: "principal_default_denied" });
  });
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
