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

describe("B1 transaction-aware human authority locks", () => {
  const sourceId = "70000000-0000-7000-8000-000000000081";
  const relationshipId = "70000000-0000-7000-8000-000000000082";
  const personId = "70000000-0000-7000-8000-000000000083";
  const spaceId = "70000000-0000-7000-8000-000000000084";
  const readGrantId = "70000000-0000-7000-8000-000000000085";
  const mutationGrantId = "70000000-0000-7000-8000-000000000086";

  it.each(["source.correct", "source.tombstone"] as const)(
    "locks the active governing Space for owner/admin %s authority",
    async (action) => {
      const { tx, queries } = b1LockExecutor("owner");
      const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
        createDevSecurityContext("tenant-a-owner"),
        action,
        { type: "source", id: sourceId },
        tx,
        { lockAuthority: true }
      );

      expect(decision.allowed).toBe(true);
      const policy = queries.findIndex((sql) => sql.includes("FROM identity.policy_versions"));
      const membership = queries.findIndex((sql) => sql.includes("FROM identity.memberships"));
      const space = queries.findIndex((sql) => isActiveSpaceLock(sql));
      expect([policy, membership, space]).toEqual([0, 1, expect.any(Number)]);
      expect(space).toBeGreaterThan(membership);
      expect(queries[policy]).toMatch(/status = 'active'[\s\S]*FOR SHARE/);
      expect(queries[membership]).toMatch(/FOR SHARE OF m, u/);
      expect(queries[space]).toMatch(/archived_at IS NULL[\s\S]*FOR SHARE/);
    }
  );

  it("preauthorizes Relationship end without taking any human-authority lock", async () => {
    const { tx, queries } = b1LockExecutor("member");
    const decision = await new PostgresAuthorizationService(
      {} as PgPool
    ).preauthorizeRelationshipEndInTransaction(
      createDevSecurityContext("tenant-a-viewer"),
      { type: "relationship", id: relationshipId },
      tx
    );

    expect(decision.allowed).toBe(true);
    expect(queries).not.toHaveLength(0);
    expect(queries.every((sql) => !/FOR SHARE/.test(sql))).toBe(true);
  });

  it("locks policy, actor membership/user/role, Space, read grant, and contributor grant in order", async () => {
    const { tx, queries } = b1LockExecutor("member");
    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      createDevSecurityContext("tenant-a-viewer"),
      "relationship.end",
      { type: "relationship", id: relationshipId },
      tx,
      { lockAuthority: true }
    );

    expect(decision.allowed).toBe(true);
    const policy = queries.findIndex((sql) => sql.includes("FROM identity.policy_versions"));
    const membership = queries.findIndex((sql) => sql.includes("FROM identity.memberships"));
    const space = queries.findIndex((sql) => isActiveSpaceLock(sql));
    const readGrant = queries.findIndex((sql) =>
      sql.includes("SELECT id, resource_id FROM access.access_relationships")
    );
    const contributorGrant = queries.findIndex(
      (sql) => sql.includes("SELECT grant_record.id") && sql.includes("relation IN")
    );
    expect(policy).toBeLessThan(membership);
    expect(membership).toBeLessThan(space);
    expect(space).toBeLessThan(readGrant);
    expect(readGrant).toBeLessThan(contributorGrant);
    expect(queries[readGrant]).toMatch(/FOR SHARE/);
    expect(queries[contributorGrant]).toMatch(/ORDER BY grant_record\.id[\s\S]*FOR SHARE/);
    expect(decision.evaluatedRelationships).toEqual([
      `space_grant:${readGrantId}:${spaceId}`,
      `space_grant:${mutationGrantId}:${spaceId}`
    ]);
  });

  it("propagates lockAuthority through a Relationship Person endpoint read and locks its grant", async () => {
    const { tx, queries } = b1LockExecutor("member");
    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      createDevSecurityContext("tenant-a-viewer"),
      "person.read",
      { type: "person", id: personId },
      tx,
      {
        personUseSite: { type: "relationship", id: relationshipId },
        lockAuthority: true
      }
    );

    expect(decision.allowed).toBe(true);
    const space = queries.findIndex((sql) => isActiveSpaceLock(sql));
    const grant = queries.findIndex((sql) =>
      sql.includes("SELECT id, resource_id FROM access.access_relationships")
    );
    expect(space).toBeGreaterThan(
      queries.findIndex((sql) => sql.includes("FROM work.relationships resource"))
    );
    expect(space).toBeLessThan(grant);
    expect(queries[grant]).toMatch(/FOR SHARE/);
    expect(decision.evaluatedRelationships).toEqual([`space_grant:${readGrantId}:${spaceId}`]);
  });

  it("locks and revalidates every active inherited-Space path row before accepting the grant", async () => {
    const targetSpaceId = "70000000-0000-7000-8000-000000000087";
    const intermediateSpaceId = "70000000-0000-7000-8000-000000000088";
    const ancestorSpaceId = "70000000-0000-7000-8000-000000000089";
    const inheritedGrantId = "70000000-0000-7000-8000-000000000090";
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM identity.policy_versions")) return { rows: [{ id: "default-v1" }] };
        if (sql.includes("FROM identity.memberships")) {
          return {
            rows: [{ role: "member", membership_status: "active", user_status: "active" }]
          };
        }
        if (sql.includes("FROM work.organizations resource")) {
          return { rows: [{ space_id: targetSpaceId, access_class: "restricted" }] };
        }
        if (isActiveSpaceLock(sql)) return { rows: [{ id: targetSpaceId }] };
        if (sql.includes("WITH RECURSIVE target AS")) {
          return {
            rows: [
              {
                is_root: false,
                target_restricted: false,
                direct_grant_ids: [],
                direct_grant_space_ids: [],
                inherited_grant_ids: [inheritedGrantId],
                inherited_grant_space_ids: [ancestorSpaceId]
              }
            ]
          };
        }
        if (sql.includes("WITH RECURSIVE authority_path AS")) {
          return {
            rows: [
              {
                id: targetSpaceId,
                parent_space_id: intermediateSpaceId,
                inheritance_mode: "inherit",
                depth: 0
              },
              {
                id: intermediateSpaceId,
                parent_space_id: ancestorSpaceId,
                inheritance_mode: "inherit",
                depth: 1
              },
              {
                id: ancestorSpaceId,
                parent_space_id: null,
                inheritance_mode: "inherit",
                depth: 2
              }
            ]
          };
        }
        if (sql.includes("FOR SHARE OF space_row")) {
          return {
            rows: [{ id: ancestorSpaceId }, { id: intermediateSpaceId }, { id: targetSpaceId }]
          };
        }
        if (sql.includes("SELECT id, resource_id FROM access.access_relationships")) {
          return { rows: [{ id: inheritedGrantId, resource_id: ancestorSpaceId }] };
        }
        throw new Error(`Unexpected inherited authority query: ${sql}`);
      })
    } as unknown as TenantQueryExecutor;

    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      createDevSecurityContext("tenant-a-viewer"),
      "organization.read",
      { type: "organization", id: relationshipId },
      tx,
      { lockAuthority: true }
    );

    expect(decision.allowed).toBe(true);
    const pathRead = queries.findIndex((sql) => sql.includes("WITH RECURSIVE authority_path AS"));
    const pathLock = queries.findIndex((sql) => sql.includes("FOR SHARE OF space_row"));
    const grantLock = queries.findIndex((sql) =>
      sql.includes("SELECT id, resource_id FROM access.access_relationships")
    );
    const pathRevalidation = queries
      .map((sql) => sql.includes("WITH RECURSIVE authority_path AS"))
      .lastIndexOf(true);
    expect(pathRead).toBeGreaterThanOrEqual(0);
    expect(pathLock).toBeGreaterThan(pathRead);
    expect(pathRevalidation).toBeGreaterThan(pathLock);
    expect(grantLock).toBeGreaterThan(pathRevalidation);
    expect(queries[pathLock]).toMatch(/ORDER BY space_row\.id[\s\S]*FOR SHARE OF space_row/);
    expect(decision.evaluatedRelationships).toEqual([
      `space_grant:${inheritedGrantId}:${ancestorSpaceId}`
    ]);
  });

  it("discovers Relationship authority without locks, then deduplicates and globally orders every Space, path, and grant", async () => {
    const governingSpaceId = "70000000-0000-7000-8000-000000000098";
    const inheritedTargetSpaceId = "70000000-0000-7000-8000-000000000094";
    const inheritedIntermediateSpaceId = "70000000-0000-7000-8000-000000000093";
    const inheritedAncestorSpaceId = "70000000-0000-7000-8000-000000000091";
    const directEndpointSpaceId = "70000000-0000-7000-8000-000000000096";
    const governingGrantId = "70000000-0000-7000-8000-000000000099";
    const inheritedGrantId = "70000000-0000-7000-8000-000000000095";
    const directEndpointGrantId = "70000000-0000-7000-8000-000000000097";
    const organizationId = "70000000-0000-7000-8000-000000000092";
    const requests = [
      {
        action: "relationship.end",
        resource: { type: "relationship", id: relationshipId }
      },
      {
        action: "organization.read",
        resource: { type: "organization", id: organizationId }
      },
      {
        action: "space.read",
        resource: { type: "space", id: directEndpointSpaceId }
      },
      {
        action: "person.read",
        resource: { type: "person", id: personId },
        personUseSite: { type: "relationship", id: relationshipId }
      },
      {
        action: "space.read",
        resource: { type: "space", id: governingSpaceId }
      }
    ] as const;
    const runs: Array<{
      queries: Array<{ sql: string; values: readonly unknown[] | undefined }>;
      decision: Awaited<
        ReturnType<
          RelationshipAuthorityBatchTestService["lockAndReauthorizeRelationshipAuthorityInTransaction"]
        >
      >;
    }> = [];

    for (const orderedRequests of [requests, [...requests].reverse()] as const) {
      const queries: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
      const spaces = new Map([
        [
          governingSpaceId,
          authoritySpaceRow(governingSpaceId, devFixtures.rootSpaceA, "restricted")
        ],
        [
          inheritedTargetSpaceId,
          authoritySpaceRow(inheritedTargetSpaceId, inheritedIntermediateSpaceId, "inherit")
        ],
        [
          inheritedIntermediateSpaceId,
          authoritySpaceRow(inheritedIntermediateSpaceId, inheritedAncestorSpaceId, "inherit")
        ],
        [
          inheritedAncestorSpaceId,
          authoritySpaceRow(inheritedAncestorSpaceId, devFixtures.rootSpaceA, "inherit")
        ],
        [
          directEndpointSpaceId,
          authoritySpaceRow(directEndpointSpaceId, devFixtures.rootSpaceA, "restricted")
        ]
      ]);
      const grants = new Map([
        [governingGrantId, authorityGrantRow(governingGrantId, governingSpaceId, "contributor")],
        [inheritedGrantId, authorityGrantRow(inheritedGrantId, inheritedAncestorSpaceId, "viewer")],
        [
          directEndpointGrantId,
          authorityGrantRow(directEndpointGrantId, directEndpointSpaceId, "viewer")
        ]
      ]);
      const tx = {
        query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
          queries.push({ sql, values });
          if (sql.includes("FROM identity.policy_versions")) {
            return { rows: [{ id: "default-v1", status: "active" }] };
          }
          if (sql.includes("FROM identity.memberships")) {
            return {
              rows: [
                {
                  membership_id: devFixtures.membershipAViewer,
                  user_id: devFixtures.userB,
                  person_id: devFixtures.personBInTenantA,
                  role: "member",
                  membership_status: "active",
                  user_status: "active"
                }
              ]
            };
          }
          if (sql.includes("/* relationship_authority_global_spaces */")) {
            const ids = values?.[2] as string[];
            return { rows: ids.map((id) => spaces.get(id)!) };
          }
          if (sql.includes("/* relationship_authority_global_grants */")) {
            const ids = values?.[2] as string[];
            return { rows: ids.map((id) => grants.get(id)!) };
          }
          if (sql.includes("FROM work.organizations resource")) {
            return { rows: [{ space_id: inheritedTargetSpaceId, access_class: "restricted" }] };
          }
          if (sql.includes("FROM work.relationships resource")) {
            return { rows: [{ space_id: governingSpaceId, access_class: "restricted" }] };
          }
          if (sql.includes("/* relationship_authority_space */")) {
            return { rows: [spaces.get(values?.[2] as string)!] };
          }
          if (sql.includes("WITH RECURSIVE target AS")) {
            const targetSpaceId = values?.[0];
            if (targetSpaceId === inheritedTargetSpaceId) {
              return {
                rows: [
                  {
                    is_root: false,
                    target_restricted: false,
                    direct_grant_ids: [],
                    direct_grant_space_ids: [],
                    inherited_grant_ids: [inheritedGrantId],
                    inherited_grant_space_ids: [inheritedAncestorSpaceId]
                  }
                ]
              };
            }
            const grantId =
              targetSpaceId === governingSpaceId ? governingGrantId : directEndpointGrantId;
            return {
              rows: [
                {
                  is_root: false,
                  target_restricted: true,
                  direct_grant_ids: [grantId],
                  direct_grant_space_ids: [targetSpaceId],
                  inherited_grant_ids: [],
                  inherited_grant_space_ids: []
                }
              ]
            };
          }
          if (sql.includes("WITH RECURSIVE authority_path AS")) {
            return {
              rows: [
                { ...spaces.get(inheritedTargetSpaceId)!, depth: 0 },
                { ...spaces.get(inheritedIntermediateSpaceId)!, depth: 1 },
                { ...spaces.get(inheritedAncestorSpaceId)!, depth: 2 }
              ]
            };
          }
          if (sql.includes("/* relationship_authority_grant */")) {
            return { rows: [grants.get(values?.[2] as string)!] };
          }
          if (sql.includes("SELECT grant_record.id") && sql.includes("relation IN")) {
            return { rows: [grants.get(governingGrantId)!] };
          }
          throw new Error(`Unexpected Relationship authority batch query: ${sql}`);
        })
      } as unknown as TenantQueryExecutor;
      const service = new PostgresAuthorizationService(
        {} as PgPool
      ) as unknown as RelationshipAuthorityBatchTestService;
      const decision = await service.lockAndReauthorizeRelationshipAuthorityInTransaction(
        createDevSecurityContext("tenant-a-viewer"),
        orderedRequests,
        tx
      );
      runs.push({ queries, decision });
    }

    const expectedSpaceIds = [
      inheritedAncestorSpaceId,
      inheritedIntermediateSpaceId,
      inheritedTargetSpaceId,
      directEndpointSpaceId,
      governingSpaceId
    ];
    const expectedGrantIds = [inheritedGrantId, directEndpointGrantId, governingGrantId];
    for (const { queries, decision } of runs) {
      expect(decision.allowed).toBe(true);
      const firstLock = queries.findIndex(({ sql }) => /FOR SHARE/.test(sql));
      expect(firstLock).toBeGreaterThan(0);
      expect(queries.slice(0, firstLock).every(({ sql }) => !/FOR SHARE/.test(sql))).toBe(true);
      const lockQueries = queries.filter(({ sql }) => /FOR SHARE/.test(sql));
      expect(lockQueries).toHaveLength(4);
      expect(lockQueries[0]!.sql).toContain("FROM identity.policy_versions");
      expect(lockQueries[1]!.sql).toContain("FROM identity.memberships");
      expect(lockQueries[2]!.sql).toMatch(
        /relationship_authority_global_spaces[\s\S]*ORDER BY space_row\.id[\s\S]*FOR SHARE/
      );
      expect(lockQueries[2]!.values?.[2]).toEqual(expectedSpaceIds);
      expect(lockQueries[3]!.sql).toMatch(
        /relationship_authority_global_grants[\s\S]*ORDER BY grant_record\.id[\s\S]*FOR SHARE/
      );
      expect(lockQueries[3]!.values?.[2]).toEqual(expectedGrantIds);
      expect(decision.evaluatedRelationships).toEqual([
        `space_grant:${inheritedGrantId}:${inheritedAncestorSpaceId}`,
        `space_grant:${directEndpointGrantId}:${directEndpointSpaceId}`,
        `space_grant:${governingGrantId}:${governingSpaceId}`
      ]);
    }
    expect(
      runs.map(({ queries }) =>
        queries
          .filter(({ sql }) => /relationship_authority_global_(?:spaces|grants)/.test(sql))
          .map(({ values }) => values?.[2])
      )
    ).toEqual([
      [expectedSpaceIds, expectedGrantIds],
      [expectedSpaceIds, expectedGrantIds]
    ]);
  });

  it("fails closed when the Relationship grant token set changes before locked reauthorization", async () => {
    const governingSpaceId = "70000000-0000-7000-8000-000000000091";
    const governingGrantId = "70000000-0000-7000-8000-000000000092";
    const space = authoritySpaceRow(governingSpaceId, devFixtures.rootSpaceA, "restricted");
    const grant = authorityGrantRow(governingGrantId, governingSpaceId, "contributor");
    const queries: string[] = [];
    let accessReads = 0;
    const tx = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM identity.policy_versions")) {
          return { rows: [{ id: "default-v1", status: "active" }] };
        }
        if (sql.includes("FROM identity.memberships")) {
          return {
            rows: [
              {
                membership_id: devFixtures.membershipAViewer,
                user_id: devFixtures.userB,
                person_id: devFixtures.personBInTenantA,
                role: "member",
                membership_status: "active",
                user_status: "active"
              }
            ]
          };
        }
        if (sql.includes("relationship_authority_global_spaces")) return { rows: [space] };
        if (sql.includes("relationship_authority_global_grants")) return { rows: [grant] };
        if (sql.includes("FROM work.relationships resource")) {
          return { rows: [{ space_id: governingSpaceId, access_class: "restricted" }] };
        }
        if (sql.includes("relationship_authority_space")) return { rows: [space] };
        if (sql.includes("WITH RECURSIVE target AS")) {
          accessReads += 1;
          return {
            rows: [
              {
                is_root: false,
                target_restricted: true,
                direct_grant_ids: accessReads === 1 ? [governingGrantId] : [],
                direct_grant_space_ids: accessReads === 1 ? [governingSpaceId] : [],
                inherited_grant_ids: [],
                inherited_grant_space_ids: []
              }
            ]
          };
        }
        if (sql.includes("relationship_authority_grant")) return { rows: [grant] };
        if (sql.includes("SELECT grant_record.id") && sql.includes("relation IN")) {
          return { rows: [grant] };
        }
        throw new Error(`Unexpected changed-token authority query: ${sql}`);
      })
    } as unknown as TenantQueryExecutor;

    const decision = await new PostgresAuthorizationService(
      {} as PgPool
    ).lockAndReauthorizeRelationshipAuthorityInTransaction(
      createDevSecurityContext("tenant-a-viewer"),
      [
        {
          action: "relationship.end",
          resource: { type: "relationship", id: relationshipId }
        }
      ],
      tx
    );

    expect(decision).toMatchObject({
      allowed: false,
      reasonCode: "b1_resource_not_available"
    });
    const grantLock = queries.findIndex((sql) =>
      sql.includes("relationship_authority_global_grants")
    );
    const lockedReauthorization = queries
      .map((sql) => sql.includes("WITH RECURSIVE target AS"))
      .lastIndexOf(true);
    expect(grantLock).toBeGreaterThanOrEqual(0);
    expect(lockedReauthorization).toBeGreaterThan(grantLock);
    expect(accessReads).toBe(2);
  });

  function b1LockExecutor(role: "owner" | "member"): {
    tx: TenantQueryExecutor;
    queries: string[];
  } {
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM identity.policy_versions")) return { rows: [{ id: "default-v1" }] };
        if (sql.includes("FROM identity.memberships")) {
          return {
            rows: [{ role, membership_status: "active", user_status: "active" }]
          };
        }
        if (sql.includes("FROM content.source_artifacts")) {
          return { rows: [{ space_id: spaceId, access_class: "restricted" }] };
        }
        if (sql.includes("FROM work.relationships resource")) {
          return { rows: [{ space_id: spaceId, access_class: "restricted" }] };
        }
        if (isActiveSpaceLock(sql)) return { rows: [{ id: spaceId }] };
        if (sql.includes("WITH RECURSIVE target AS")) {
          return {
            rows: [
              {
                is_root: false,
                target_restricted: true,
                direct_grant_ids: [readGrantId],
                direct_grant_space_ids: [spaceId],
                inherited_grant_ids: [],
                inherited_grant_space_ids: []
              }
            ]
          };
        }
        if (sql.includes("SELECT id, resource_id FROM access.access_relationships")) {
          return { rows: [{ id: readGrantId, resource_id: spaceId }] };
        }
        if (sql.includes("SELECT grant_record.id") && sql.includes("relation IN")) {
          return { rows: [{ id: mutationGrantId, resource_id: spaceId }] };
        }
        throw new Error(`Unexpected B1 authority query: ${sql}`);
      })
    } as unknown as TenantQueryExecutor;
    return { tx, queries };
  }

  function isActiveSpaceLock(sql: string): boolean {
    return (
      sql.includes("SELECT id") &&
      sql.includes("FROM access.spaces") &&
      sql.includes("archived_at IS NULL") &&
      sql.includes("FOR SHARE")
    );
  }
});

type RelationshipAuthorityBatchTestService = {
  lockAndReauthorizeRelationshipAuthorityInTransaction(
    context: SecurityContext,
    requests: readonly unknown[],
    tx: TenantQueryExecutor
  ): Promise<{
    allowed: boolean;
    reasonCode: string;
    policyVersion: string;
    evaluatedRelationships?: string[];
  }>;
};

function authoritySpaceRow(
  id: string,
  parentSpaceId: string,
  inheritanceMode: "inherit" | "restricted"
) {
  return {
    id,
    parent_space_id: parentSpaceId,
    kind: "knowledge",
    access_class: "restricted",
    inheritance_mode: inheritanceMode
  };
}

function authorityGrantRow(id: string, resourceId: string, relation: "contributor" | "viewer") {
  return {
    id,
    resource_id: resourceId,
    resource_type: "space",
    subject_type: "membership",
    subject_id: devFixtures.membershipAViewer,
    relation
  };
}

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
    expect(queries.every((sql) => /\bFOR\s+(?:SHARE|KEY\s+SHARE|UPDATE)\b/i.test(sql))).toBe(true);
    expect(queries.join("\n")).not.toMatch(/\bNOT\s+EXISTS\b/i);
    expect(
      queries.map((sql) => sql.match(/FROM\s+((?:identity|access)\.[a-z_]+)/i)?.[1]?.toLowerCase())
    ).toEqual([
      "identity.tenants",
      "identity.workspaces",
      "identity.policy_versions",
      "identity.service_principals",
      "access.spaces",
      "access.access_relationships"
    ]);
    expect(queries[0]).toMatch(/id = \$1[\s\S]*FOR SHARE/);
    expect(queries[1]).toMatch(/id = \$1 AND tenant_id = \$2[\s\S]*FOR SHARE/);
    expect(queries[2]).toMatch(
      /id = \$1 AND tenant_id = \$2 AND workspace_id = \$3[\s\S]*FOR SHARE/
    );
    expect(queries[3]).toMatch(
      /id = \$1 AND tenant_id = \$2 AND workspace_id = \$3[\s\S]*FOR SHARE/
    );
    expect(queries[4]).toMatch(
      /id = \$1 AND tenant_id = \$2 AND workspace_id = \$3 AND archived_at IS NULL[\s\S]*FOR SHARE/
    );
    expect(queries[5]).toMatch(
      /tenant_id = \$1[\s\S]*workspace_id = \$2[\s\S]*subject_type = 'service_principal'[\s\S]*subject_id = \$3[\s\S]*relation = 'manager'[\s\S]*resource_type = 'space'[\s\S]*resource_id = \$4[\s\S]*source = 'direct'[\s\S]*FOR SHARE/
    );
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

describe("product_outbox.relay.publish exact authorization", () => {
  const productPrincipalId = "70000000-0000-7000-8000-000000000061";
  const context = (overrides: Partial<SecurityContext> = {}): SecurityContext => ({
    ...createDevSecurityContext("tenant-a-service"),
    servicePrincipalId: productPrincipalId,
    requestedSpaceIds: [devFixtures.restrictedSpaceA],
    ...overrides
  });

  function executor(deniedTable?: string) {
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        const table = sql.match(/FROM\s+((?:identity|access)\.[a-z_]+)/)?.[1];
        if (table === deniedTable) return { rows: [] };
        if (table === "identity.tenants") return { rows: [{ status: "active" }] };
        if (table === "identity.workspaces") return { rows: [{ status: "active" }] };
        if (table === "identity.policy_versions") return { rows: [{ status: "active" }] };
        if (table === "identity.service_principals") {
          return { rows: [{ purpose: "product_notification_relay", status: "active" }] };
        }
        if (table === "access.spaces") return { rows: [{ id: devFixtures.restrictedSpaceA }] };
        if (table === "access.access_relationships") return { rows: [{ id: "direct-manager" }] };
        throw new Error(`Unexpected product relay authorization query: ${sql}`);
      })
    } as unknown as TenantQueryExecutor;
    return { queries, tx };
  }

  it("locks every live authority input in the exact required order", async () => {
    const { queries, tx } = executor();
    const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      context(),
      "product_outbox.relay.publish",
      { type: "space", id: devFixtures.restrictedSpaceA },
      tx as never
    );
    expect(decision).toMatchObject({
      allowed: true,
      reasonCode: "product_relay_direct_manager"
    });
    expect(queries.map((sql) => sql.match(/FROM\s+((?:identity|access)\.[a-z_]+)/)?.[1])).toEqual([
      "identity.tenants",
      "identity.workspaces",
      "identity.policy_versions",
      "identity.service_principals",
      "access.spaces",
      "access.access_relationships"
    ]);
    expect(queries.every((sql) => /FOR UPDATE/.test(sql))).toBe(true);
    expect(queries[3]).toMatch(/purpose = 'product_notification_relay'/);
    expect(queries[5]).toMatch(
      /subject_type = 'service_principal'[\s\S]*relation = 'manager'[\s\S]*source = 'direct'/
    );
  });

  it.each([
    ["tenant", "identity.tenants", "tenant_not_active"],
    ["workspace", "identity.workspaces", "workspace_not_active"],
    ["policy", "identity.policy_versions", "policy_version_not_active"],
    ["principal", "identity.service_principals", "product_relay_principal_not_active"],
    ["Space", "access.spaces", "space_not_found"],
    ["direct manager", "access.access_relationships", "product_relay_direct_manager_required"]
  ] as const)("denies a missing or revoked %s before send", async (_name, table, reasonCode) => {
    const { tx } = executor(table);
    await expect(
      new PostgresAuthorizationService({} as PgPool).canInTransaction(
        context(),
        "product_outbox.relay.publish",
        { type: "space", id: devFixtures.restrictedSpaceA },
        tx as never
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode });
  });

  it("denies human, agent, delegated, and wrong-Space principal confusion before any lock", async () => {
    for (const overrides of [
      {
        servicePrincipalId: undefined,
        actorUserId: devFixtures.userA,
        actorMembershipId: devFixtures.membershipAOwner
      },
      { servicePrincipalId: undefined, agentPrincipalId: devFixtures.agentPrincipalA },
      {
        delegatedByUserId: devFixtures.userA,
        delegatedByMembershipId: devFixtures.membershipAOwner
      }
    ] as Array<Partial<SecurityContext>>) {
      const { queries, tx } = executor();
      const decision = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
        context(overrides),
        "product_outbox.relay.publish",
        { type: "space", id: devFixtures.restrictedSpaceA },
        tx as never
      );
      expect(decision.allowed).toBe(false);
      expect(queries).toEqual([]);
    }
    const { queries, tx } = executor();
    const wrongSpace = await new PostgresAuthorizationService({} as PgPool).canInTransaction(
      context(),
      "product_outbox.relay.publish",
      { type: "space", id: devFixtures.rootSpaceA },
      tx as never
    );
    expect(wrongSpace).toMatchObject({
      allowed: false,
      reasonCode: "product_relay_space_scope_mismatch"
    });
    expect(queries).toEqual([]);
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
