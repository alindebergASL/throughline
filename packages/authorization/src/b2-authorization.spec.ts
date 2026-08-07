import type { TenantQueryExecutor } from "@throughline/db";
import type { SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PostgresAuthorizationService } from "./authorization-service.js";

const subjectId = "70000000-0000-7000-8000-000000000081";
const claimId = "70000000-0000-7000-8000-000000000082";
const factId = "70000000-0000-7000-8000-000000000083";
const initiativeId = "70000000-0000-7000-8000-000000000084";
const directGrantId = "70000000-0000-7000-8000-000000000085";
const inheritedGrantId = "70000000-0000-7000-8000-000000000086";

const lifecycleCases = [
  {
    action: "fact.supersede" as const,
    subjectType: "activity" as const,
    subjectId,
    predicate: "activity.outcome",
    reasonCode: "b2_activity_owner"
  },
  {
    action: "fact.revoke" as const,
    subjectType: "activity" as const,
    subjectId,
    predicate: "activity.outcome",
    reasonCode: "b2_activity_owner"
  },
  {
    action: "fact.supersede" as const,
    subjectType: "initiative" as const,
    subjectId: initiativeId,
    predicate: "initiative.primary_objective",
    reasonCode: "b2_initiative_owner"
  },
  {
    action: "fact.revoke" as const,
    subjectType: "initiative" as const,
    subjectId: initiativeId,
    predicate: "initiative.primary_objective",
    reasonCode: "b2_initiative_owner"
  }
] as const;

describe("central B2 Slice 1 authorization", () => {
  it("allows a live contributor to propose a Claim without treating them as subject owner", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor({
      role: "admin",
      subjectOwnerPersonId: devFixtures.personBInTenantA
    });

    await expect(
      service.canInTransaction(
        createDevSecurityContext("tenant-a-owner"),
        "claim.create",
        { type: "activity", id: subjectId },
        harness.tx as never,
        { lockAuthority: true }
      )
    ).resolves.toMatchObject({ allowed: true, reasonCode: "b2_live_contributor" });
    expect(harness.query.mock.calls.some(([sql]) => sql.includes("FOR SHARE"))).toBe(true);
  });

  it("requires the exact active Activity or Initiative owner for fact.accept", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const exactOwner = executor({ subjectOwnerPersonId: devFixtures.personA });
    const workspaceAdmin = executor({
      role: "admin",
      subjectOwnerPersonId: devFixtures.personBInTenantA
    });
    const context = createDevSecurityContext("tenant-a-owner");

    await expect(
      service.canInTransaction(
        context,
        "fact.accept",
        { type: "activity", id: subjectId },
        exactOwner.tx as never,
        { lockAuthority: true }
      )
    ).resolves.toMatchObject({ allowed: true, reasonCode: "b2_activity_owner" });
    await expect(
      service.canInTransaction(
        context,
        "fact.accept",
        { type: "activity", id: subjectId },
        workspaceAdmin.tx as never,
        { lockAuthority: true }
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
  });

  it.each(lifecycleCases)(
    "authorizes $action for the exact current $subjectType Fact owner",
    async ({ action, subjectType, subjectId: lifecycleSubjectId, predicate, reasonCode }) => {
      const service = new PostgresAuthorizationService({} as never);
      const harness = executor({
        factSubjectType: subjectType,
        factSubjectId: lifecycleSubjectId,
        factPredicate: predicate
      });

      await expect(
        service.canInTransaction(
          lifecycleContext(),
          action,
          { type: "fact", id: factId },
          harness.tx,
          { lockAuthority: true }
        )
      ).resolves.toMatchObject({ allowed: true, reasonCode });

      const factCallIndex = harness.query.mock.calls.findIndex(([sql]) =>
        sql.includes("FROM truth.accepted_facts fact")
      );
      const subjectTable = subjectType === "activity" ? "work.activities" : "work.initiatives";
      const subjectCallIndex = harness.query.mock.calls.findIndex(
        ([sql]) =>
          sql.includes(`FROM ${subjectTable} subject`) && sql.includes("subject.space_id = $4")
      );
      expect(factCallIndex).toBeGreaterThanOrEqual(0);
      expect(subjectCallIndex).toBeGreaterThan(factCallIndex);

      const [factSql, factParameters] = harness.query.mock.calls[factCallIndex]!;
      expect(factParameters).toEqual([devFixtures.tenantA, devFixtures.workspaceA, factId]);
      expect(factSql).toContain("fact.status = 'current'");
      expect(factSql).toContain("fact.version = 1");
      expect(factSql).toContain("fact.subject_type = 'activity'");
      expect(factSql).toContain("fact.predicate = 'activity.outcome'");
      expect(factSql).toContain("fact.subject_type = 'initiative'");
      expect(factSql).toContain("fact.predicate = 'initiative.primary_objective'");
      expect(factSql).toContain("space.archived_at IS NULL");
      expect(factSql).toMatch(/FOR SHARE OF fact, space\b/u);
      expect(factSql).not.toMatch(/FOR SHARE OF fact\s*$/u);

      const [subjectSql, subjectParameters] = harness.query.mock.calls[subjectCallIndex]!;
      expect(subjectParameters).toEqual([
        devFixtures.tenantA,
        devFixtures.workspaceA,
        lifecycleSubjectId,
        devFixtures.rootSpaceA
      ]);
      expect(subjectSql).toContain("FOR SHARE OF subject");
      expect(subjectSql).not.toContain("FOR SHARE OF space");
      expect(lifecycleQueryTrace(harness.query)).toEqual([
        "policy",
        "membership-user",
        "fact-space",
        `${subjectType}-subject`,
        "current-space"
      ]);
      expectReadOnlySql(harness.query);
    }
  );

  it("locks and revalidates the exact direct Space grant for a lower-role Fact owner", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor({
      role: "viewer",
      membershipId: devFixtures.membershipAViewer,
      membershipUserId: devFixtures.userB,
      membershipPersonId: devFixtures.personBInTenantA,
      factSpaceId: devFixtures.restrictedSpaceA,
      subjectSpaceId: devFixtures.restrictedSpaceA,
      subjectOwnerPersonId: devFixtures.personBInTenantA,
      directGrantId,
      directGrantSpaceId: devFixtures.restrictedSpaceA
    });

    await expect(
      service.canInTransaction(
        lifecycleContext({
          identity: "tenant-a-viewer",
          requestedSpaceIds: [devFixtures.restrictedSpaceA]
        }),
        "fact.supersede",
        { type: "fact", id: factId },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual({
      allowed: true,
      reasonCode: "b2_activity_owner",
      policyVersion: "default-v1",
      evaluatedRelationships: [`space_grant:${directGrantId}:${devFixtures.restrictedSpaceA}`]
    });

    expect(lifecycleQueryTrace(harness.query)).toEqual([
      "policy",
      "membership-user",
      "fact-space",
      "activity-subject",
      "current-space",
      "space-grant-path",
      "grant-lock"
    ]);
    const [grantSql, grantParameters] = queryCalls(harness.query, "grant-lock")[0]!;
    expect(grantSql).toContain("LIMIT 1 FOR SHARE");
    expect(grantParameters).toEqual([
      devFixtures.tenantA,
      devFixtures.workspaceA,
      directGrantId,
      devFixtures.restrictedSpaceA,
      devFixtures.membershipAViewer,
      devFixtures.userB
    ]);
    expectReadOnlySql(harness.query);
  });

  it("locks and revalidates the exact inherited Space path and grant for a lower-role Fact owner", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor({
      role: "viewer",
      membershipId: devFixtures.membershipAViewer,
      membershipUserId: devFixtures.userB,
      membershipPersonId: devFixtures.personBInTenantA,
      factSpaceId: devFixtures.restrictedSpaceA,
      subjectSpaceId: devFixtures.restrictedSpaceA,
      subjectOwnerPersonId: devFixtures.personBInTenantA,
      inheritedGrantId,
      inheritedGrantSpaceId: devFixtures.rootSpaceA,
      inheritedPath: [
        {
          id: devFixtures.restrictedSpaceA,
          parent_space_id: devFixtures.rootSpaceA,
          kind: "initiative",
          access_class: "restricted",
          inheritance_mode: "inherit",
          depth: 0
        },
        {
          id: devFixtures.rootSpaceA,
          parent_space_id: null,
          kind: "workspace_root",
          access_class: "workspace",
          inheritance_mode: "inherit",
          depth: 1
        }
      ]
    });

    await expect(
      service.canInTransaction(
        lifecycleContext({
          identity: "tenant-a-viewer",
          requestedSpaceIds: [devFixtures.restrictedSpaceA]
        }),
        "fact.revoke",
        { type: "fact", id: factId },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual({
      allowed: true,
      reasonCode: "b2_activity_owner",
      policyVersion: "default-v1",
      evaluatedRelationships: [`space_grant:${inheritedGrantId}:${devFixtures.rootSpaceA}`]
    });

    expect(lifecycleQueryTrace(harness.query)).toEqual([
      "policy",
      "membership-user",
      "fact-space",
      "activity-subject",
      "current-space",
      "space-grant-path",
      "inherited-path",
      "inherited-path-lock",
      "inherited-path",
      "grant-lock"
    ]);
    const pathCalls = queryCalls(harness.query, "inherited-path");
    expect(pathCalls).toHaveLength(2);
    for (const [, parameters] of pathCalls) {
      expect(parameters).toEqual([
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.restrictedSpaceA
      ]);
    }
    const [pathLockSql, pathLockParameters] = queryCalls(harness.query, "inherited-path-lock")[0]!;
    expect(pathLockSql).toContain("ORDER BY space_row.id");
    expect(pathLockSql).toContain("FOR SHARE OF space_row");
    expect(pathLockParameters).toEqual([
      devFixtures.tenantA,
      devFixtures.workspaceA,
      [devFixtures.restrictedSpaceA, devFixtures.rootSpaceA].sort()
    ]);
    const [grantSql, grantParameters] = queryCalls(harness.query, "grant-lock")[0]!;
    expect(grantSql).toContain("LIMIT 1 FOR SHARE");
    expect(grantParameters).toEqual([
      devFixtures.tenantA,
      devFixtures.workspaceA,
      inheritedGrantId,
      devFixtures.rootSpaceA,
      devFixtures.membershipAViewer,
      devFixtures.userB
    ]);
    expectReadOnlySql(harness.query);
  });

  it.each(["fact.supersede", "fact.revoke"] as const)(
    "requires a Fact ResourceRef for %s and preserves fact.accept's subject resource contract",
    async (action) => {
      const service = new PostgresAuthorizationService({} as never);
      const lifecycleHarness = executor();

      await expect(
        service.canInTransaction(
          lifecycleContext(),
          action,
          { type: "activity", id: subjectId },
          lifecycleHarness.tx,
          { lockAuthority: true }
        )
      ).resolves.toEqual(genericTargetDenial());
      expect(
        lifecycleHarness.query.mock.calls.some(([sql]) =>
          sql.includes("FROM truth.accepted_facts fact")
        )
      ).toBe(false);

      await expect(
        service.canInTransaction(
          createDevSecurityContext("tenant-a-owner"),
          "fact.accept",
          { type: "activity", id: subjectId },
          executor().tx,
          { lockAuthority: true }
        )
      ).resolves.toMatchObject({ allowed: true, reasonCode: "b2_activity_owner" });
    }
  );

  it.each([
    { name: "a nonexistent Fact", options: { factPresent: false } },
    { name: "a Fact in another tenant", options: { factTenantId: devFixtures.tenantB } },
    {
      name: "a Fact in another workspace",
      options: { factWorkspaceId: devFixtures.workspaceB }
    },
    { name: "a non-current Fact", options: { factStatus: "superseded" as const } },
    { name: "a non-version-1 Fact", options: { factVersion: 2 } },
    {
      name: "an invalid subject type",
      options: { factSubjectType: "organization" as const }
    },
    {
      name: "a wrong Activity predicate",
      options: { factPredicate: "initiative.primary_objective" }
    },
    {
      name: "a wrong Initiative predicate",
      options: {
        factSubjectType: "initiative" as const,
        factSubjectId: initiativeId,
        factPredicate: "activity.outcome"
      }
    },
    { name: "an archived Space", options: { spaceArchived: true } },
    { name: "a missing subject", options: { subjectPresent: false } },
    {
      name: "a subject in another Space",
      options: { subjectSpaceId: devFixtures.restrictedSpaceA }
    },
    {
      name: "a subject in another tenant",
      options: { subjectTenantId: devFixtures.tenantB }
    },
    {
      name: "a subject in another workspace",
      options: { subjectWorkspaceId: devFixtures.workspaceB }
    },
    {
      name: "a non-owner Workspace admin",
      options: { role: "admin" as const, subjectOwnerPersonId: devFixtures.personBInTenantA }
    }
  ])("fails closed without disclosing $name", async ({ options }) => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor(options);

    await expect(
      service.canInTransaction(
        lifecycleContext(),
        "fact.supersede",
        { type: "fact", id: factId },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual(genericTargetDenial());
    expectReadOnlySql(harness.query);
  });

  it.each([
    { name: "no requested Space", requestedSpaceIds: [] },
    {
      name: "multiple requested Spaces",
      requestedSpaceIds: [devFixtures.rootSpaceA, devFixtures.restrictedSpaceA]
    },
    { name: "the wrong requested Space", requestedSpaceIds: [devFixtures.restrictedSpaceA] }
  ])("requires exactly the derived Fact Space: $name", async ({ requestedSpaceIds }) => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor();

    await expect(
      service.canInTransaction(
        lifecycleContext({ requestedSpaceIds }),
        "fact.revoke",
        { type: "fact", id: factId },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual(genericTargetDenial());
    expect(
      harness.query.mock.calls.some(
        ([sql]) =>
          sql.includes("FROM work.activities subject") && sql.includes("subject.space_id = $4")
      )
    ).toBe(false);
    expectReadOnlySql(harness.query);
  });

  it.each([
    {
      name: "the Fact/support class exceeds the actor ceiling",
      options: { factAccessClass: "confidential" as const, spaceAccessClass: "public" as const }
    },
    {
      name: "the current Space class exceeds the actor ceiling",
      options: { factAccessClass: "public" as const, spaceAccessClass: "confidential" as const }
    }
  ])("stops at the Fact query when $name", async ({ options }) => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor(options);
    const missingFactHarness = executor({ factPresent: false });

    await expect(
      service.canInTransaction(
        lifecycleContext({ dataClassCeiling: "restricted" }),
        "fact.supersede",
        { type: "fact", id: factId },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual(genericTargetDenial());
    await expect(
      service.canInTransaction(
        lifecycleContext({ dataClassCeiling: "restricted" }),
        "fact.supersede",
        { type: "fact", id: factId },
        missingFactHarness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual(genericTargetDenial());
    expect(lifecycleQueryTrace(harness.query)).toEqual(["policy", "membership-user", "fact-space"]);
    expect(targetQueryTrace(harness.query)).toEqual(targetQueryTrace(missingFactHarness.query));
    expectReadOnlySql(harness.query);
  });

  it("does not let a forged ResourceRef.spaceId redirect lifecycle resolution or parameters", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor();

    await expect(
      service.canInTransaction(
        lifecycleContext({ requestedSpaceIds: [devFixtures.restrictedSpaceA] }),
        "fact.supersede",
        { type: "fact", id: factId, spaceId: devFixtures.restrictedSpaceA },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual(genericTargetDenial());

    expect(lifecycleQueryTrace(harness.query)).toEqual(["policy", "membership-user", "fact-space"]);
    expect(queryCalls(harness.query, "fact-space")[0]![1]).toEqual([
      devFixtures.tenantA,
      devFixtures.workspaceA,
      factId
    ]);
    expect(JSON.stringify(harness.query.mock.calls)).not.toContain(devFixtures.restrictedSpaceA);
    expectReadOnlySql(harness.query);
  });

  it.each([
    { name: "an inactive policy", options: { policyStatus: "inactive" as const } },
    { name: "a policy from another tenant", options: { policyTenantId: devFixtures.tenantB } },
    {
      name: "a policy from another workspace",
      options: { policyWorkspaceId: devFixtures.workspaceB }
    }
  ])("stops before the Fact for $name", async ({ options }) => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor(options);

    await expect(
      service.canInTransaction(
        lifecycleContext(),
        "fact.revoke",
        { type: "fact", id: factId },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "policy_version_not_active" });
    expect(lifecycleQueryTrace(harness.query)).toEqual(["policy"]);
    const [policySql, policyParameters] = queryCalls(harness.query, "policy")[0]!;
    expect(policySql).toContain("id = $1");
    expect(policySql).toContain("tenant_id = $2");
    expect(policySql).toContain("workspace_id = $3");
    expect(policySql).toContain("status = 'active'");
    expect(policySql).toContain("FOR SHARE");
    expect(policyParameters).toEqual(["default-v1", devFixtures.tenantA, devFixtures.workspaceA]);
    expectReadOnlySql(harness.query);
  });

  it("denies an unscoped Space grant even when the actor is the current subject owner", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const context = lifecycleContext({
      identity: "tenant-a-viewer",
      requestedSpaceIds: [devFixtures.restrictedSpaceA]
    });
    const harness = executor({
      membershipId: devFixtures.membershipAViewer,
      membershipUserId: devFixtures.userB,
      membershipPersonId: devFixtures.personBInTenantA,
      role: "viewer",
      factSpaceId: devFixtures.restrictedSpaceA,
      subjectSpaceId: devFixtures.restrictedSpaceA,
      subjectOwnerPersonId: devFixtures.personBInTenantA,
      spaceReadable: false
    });

    await expect(
      service.canInTransaction(context, "fact.revoke", { type: "fact", id: factId }, harness.tx, {
        lockAuthority: true
      })
    ).resolves.toEqual(genericTargetDenial());
    expectReadOnlySql(harness.query);
  });

  it.each([
    {
      name: "a missing display Person",
      context: lifecycleContextWithoutDisplayPerson(),
      options: {}
    },
    {
      name: "a forged display Person",
      context: lifecycleContext({ actorDisplayPersonId: devFixtures.personBInTenantA }),
      options: {}
    },
    {
      name: "a display Person not linked to the active Membership",
      context: lifecycleContext(),
      options: { membershipPersonId: devFixtures.personBInTenantA }
    }
  ])("fails closed for $name", async ({ context, options }) => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor(options);
    await expect(
      service.canInTransaction(
        context,
        "fact.supersede",
        { type: "fact", id: factId },
        harness.tx,
        { lockAuthority: true }
      )
    ).resolves.toEqual(genericTargetDenial());
    expect(lifecycleQueryTrace(harness.query)).toEqual(["policy", "membership-user"]);
    expect(queryCalls(harness.query, "fact-space")).toHaveLength(0);
    expectReadOnlySql(harness.query);
  });

  it.each([
    {
      name: "a missing Membership",
      context: lifecycleContext(),
      options: { membershipPresent: false },
      reasonCode: "membership_not_active"
    },
    {
      name: "a forged actor User",
      context: lifecycleContext({ actorUserId: devFixtures.userB }),
      options: {},
      reasonCode: "membership_not_active"
    },
    {
      name: "a suspended Membership",
      context: lifecycleContext(),
      options: { membershipStatus: "suspended" as const },
      reasonCode: "principal_not_active"
    },
    {
      name: "a disabled User",
      context: lifecycleContext(),
      options: { userStatus: "disabled" as const },
      reasonCode: "principal_not_active"
    }
  ])("retains the established early denial for $name", async ({ context, options, reasonCode }) => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor(options);
    await expect(
      service.canInTransaction(context, "fact.revoke", { type: "fact", id: factId }, harness.tx, {
        lockAuthority: true
      })
    ).resolves.toMatchObject({ allowed: false, reasonCode });
    expectReadOnlySql(harness.query);
  });

  it.each(["tenant-a-service", "tenant-a-agent"] as const)(
    "default-denies %s lifecycle execution before target lookup",
    async (identity) => {
      const service = new PostgresAuthorizationService({} as never);
      const harness = executor();
      await expect(
        service.canInTransaction(
          createDevSecurityContext(identity),
          "fact.supersede",
          { type: "fact", id: factId },
          harness.tx,
          { lockAuthority: true }
        )
      ).resolves.toMatchObject({ allowed: false, reasonCode: "principal_default_denied" });
      expect(
        harness.query.mock.calls.some(([sql]) => sql.includes("FROM truth.accepted_facts fact"))
      ).toBe(false);
      expectReadOnlySql(harness.query);
    }
  );

  it.each(["tenant-a-service", "tenant-a-agent"] as const)(
    "default-denies durable truth access for %s",
    async (identity) => {
      const service = new PostgresAuthorizationService({} as never);
      await expect(
        service.canInTransaction(
          createDevSecurityContext(identity),
          "claim.read",
          { type: "claim", id: claimId },
          executor().tx as never
        )
      ).resolves.toMatchObject({ allowed: false, reasonCode: "principal_default_denied" });
    }
  );

  it("authorizes Fact reads through the same Space and data-class path as Claim reads", async () => {
    const service = new PostgresAuthorizationService({} as never);
    await expect(
      service.canInTransaction(
        createDevSecurityContext("tenant-a-owner"),
        "fact.read",
        { type: "fact", id: claimId },
        executor().tx as never
      )
    ).resolves.toMatchObject({ allowed: true, reasonCode: "b1_resource_read" });
  });

  it("limits objective proposal recovery to the original proposer and current Initiative owner", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const context = createDevSecurityContext("tenant-a-owner");
    const proposer = executor({
      proposalOwnerPersonId: devFixtures.personBInTenantA,
      proposalCreatedByUserId: devFixtures.userA,
      proposalCreatedByMembershipId: devFixtures.membershipAOwner
    });
    const ownerNotProposer = executor({
      proposalOwnerPersonId: devFixtures.personA,
      proposalCreatedByUserId: devFixtures.userB,
      proposalCreatedByMembershipId: devFixtures.membershipBViewer
    });
    const neither = executor({
      proposalOwnerPersonId: devFixtures.personBInTenantA,
      proposalCreatedByUserId: devFixtures.userB,
      proposalCreatedByMembershipId: devFixtures.membershipBViewer
    });

    for (const action of [
      "initiative.primary_objective.proposal.rework",
      "initiative.primary_objective.proposal.withdraw"
    ] as const) {
      await expect(
        service.canInTransaction(context, action, { type: "claim", id: claimId }, proposer.tx, {
          lockAuthority: true
        })
      ).resolves.toMatchObject({ allowed: true });
    }
    await expect(
      service.canInTransaction(
        context,
        "initiative.primary_objective.proposal.reject",
        { type: "claim", id: claimId },
        ownerNotProposer.tx,
        { lockAuthority: true }
      )
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      service.canInTransaction(
        context,
        "initiative.primary_objective.proposal.rework",
        { type: "claim", id: claimId },
        ownerNotProposer.tx,
        { lockAuthority: true }
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
    await expect(
      service.canInTransaction(
        context,
        "initiative.primary_objective.proposal.withdraw",
        { type: "claim", id: claimId },
        neither.tx,
        { lockAuthority: true }
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
    expect(neither.query.mock.calls.every(([sql]) => /^SELECT|^WITH/u.test(sql.trim()))).toBe(true);
  });

  it("rejects data-modifying CTEs in the lifecycle read-only SQL guard", () => {
    expect(() =>
      assertReadOnlySqlText(
        "WITH changed AS (DELETE FROM truth.accepted_facts RETURNING id) SELECT id FROM changed"
      )
    ).toThrow(/DELETE/u);
  });

  it("keeps the lifecycle authorization block free of command/repository imports and write SQL", () => {
    const source = readFileSync(new URL("./authorization-service.ts", import.meta.url), "utf8");
    const imports = source.slice(0, source.indexOf("type MembershipRole"));
    expect(imports).not.toMatch(/from\s+["'][^"']*(?:command(?:-bus)?|repositor)[^"']*["']/iu);

    const lifecycleStart = source.indexOf("async function factLifecycleMutationDecision(");
    const lifecycleEnd = source.indexOf(
      "async function objectiveProposalMutationDecision(",
      lifecycleStart
    );
    expect(lifecycleStart).toBeGreaterThanOrEqual(0);
    expect(lifecycleEnd).toBeGreaterThan(lifecycleStart);
    const lifecycleBlock = source.slice(lifecycleStart, lifecycleEnd);
    expect(lifecycleBlock).not.toMatch(dataModifyingSqlToken);
  });
});

function executor(
  options: {
    role?: "owner" | "admin" | "member" | "viewer";
    subjectOwnerPersonId?: string;
    accessClass?: "public" | "workspace" | "restricted" | "confidential";
    present?: boolean;
    membershipPresent?: boolean;
    membershipId?: string;
    membershipUserId?: string;
    membershipPersonId?: string;
    membershipStatus?: "invited" | "active" | "suspended";
    userStatus?: "active" | "disabled";
    policyTenantId?: string;
    policyWorkspaceId?: string;
    policyStatus?: "active" | "inactive";
    factPresent?: boolean;
    factTenantId?: string;
    factWorkspaceId?: string;
    factSpaceId?: string;
    factSubjectType?: "activity" | "initiative" | "organization";
    factSubjectId?: string;
    factPredicate?: string;
    factStatus?: "current" | "superseded" | "revoked";
    factVersion?: number;
    factAccessClass?: "public" | "workspace" | "restricted" | "confidential";
    spaceAccessClass?: "public" | "workspace" | "restricted" | "confidential";
    spaceArchived?: boolean;
    spaceReadable?: boolean;
    directGrantId?: string;
    directGrantSpaceId?: string;
    inheritedGrantId?: string;
    inheritedGrantSpaceId?: string;
    inheritedPath?: Array<{
      id: string;
      parent_space_id: string | null;
      kind: string;
      access_class: "public" | "workspace" | "restricted" | "confidential";
      inheritance_mode: "inherit" | "restricted";
      depth: number;
    }>;
    subjectPresent?: boolean;
    subjectTenantId?: string;
    subjectWorkspaceId?: string;
    subjectSpaceId?: string;
    proposalOwnerPersonId?: string;
    proposalCreatedByUserId?: string;
    proposalCreatedByMembershipId?: string;
  } = {}
) {
  const present = options.present ?? true;
  const accessClass = options.accessClass ?? "workspace";
  const membershipId = options.membershipId ?? devFixtures.membershipAOwner;
  const membershipUserId = options.membershipUserId ?? devFixtures.userA;
  const membershipPersonId = options.membershipPersonId ?? devFixtures.personA;
  const factTenantId = options.factTenantId ?? devFixtures.tenantA;
  const factWorkspaceId = options.factWorkspaceId ?? devFixtures.workspaceA;
  const factSpaceId = options.factSpaceId ?? devFixtures.rootSpaceA;
  const factSubjectType = options.factSubjectType ?? "activity";
  const factSubjectId = options.factSubjectId ?? subjectId;
  const factPredicate = options.factPredicate ?? "activity.outcome";
  const factStatus = options.factStatus ?? "current";
  const factVersion = options.factVersion ?? 1;
  const factAccessClass = options.factAccessClass ?? accessClass;
  const spaceAccessClass = options.spaceAccessClass ?? accessClass;
  const subjectTenantId = options.subjectTenantId ?? devFixtures.tenantA;
  const subjectWorkspaceId = options.subjectWorkspaceId ?? devFixtures.workspaceA;
  const subjectSpaceId = options.subjectSpaceId ?? factSpaceId;
  const query = vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
    if (sql.includes("FROM identity.policy_versions")) {
      const exactPolicy = parametersEqual(parameters, [
        "default-v1",
        options.policyTenantId ?? devFixtures.tenantA,
        options.policyWorkspaceId ?? devFixtures.workspaceA
      ]);
      return {
        rows:
          exactPolicy && (options.policyStatus ?? "active") === "active"
            ? [{ id: "default-v1" }]
            : []
      };
    }
    if (sql.includes("FROM identity.memberships m")) {
      const exactIdentity = parametersEqual(parameters, [
        membershipId,
        membershipUserId,
        devFixtures.tenantA,
        devFixtures.workspaceA
      ]);
      return {
        rows:
          (options.membershipPresent ?? true) && exactIdentity
            ? [
                {
                  membership_id: membershipId,
                  user_id: membershipUserId,
                  person_id: membershipPersonId,
                  role: options.role ?? "owner",
                  membership_status: options.membershipStatus ?? "active",
                  user_status: options.userStatus ?? "active"
                }
              ]
            : []
      };
    }
    if (sql.includes("FROM truth.accepted_facts fact")) {
      assertLifecycleFactQuery(sql, parameters);
      const canonicalPair =
        (factSubjectType === "activity" && factPredicate === "activity.outcome") ||
        (factSubjectType === "initiative" && factPredicate === "initiative.primary_objective");
      const exactFactScope = parametersEqual(parameters, [factTenantId, factWorkspaceId, factId]);
      return {
        rows:
          (options.factPresent ?? true) &&
          exactFactScope &&
          factTenantId === devFixtures.tenantA &&
          factWorkspaceId === devFixtures.workspaceA &&
          factStatus === "current" &&
          factVersion === 1 &&
          canonicalPair &&
          !(options.spaceArchived ?? false)
            ? [
                {
                  space_id: factSpaceId,
                  subject_type: factSubjectType,
                  subject_id: factSubjectId,
                  predicate: factPredicate,
                  access_class: maxAccessClass(factAccessClass, spaceAccessClass)
                }
              ]
            : []
      };
    }
    if (sql.includes("FROM work.activities subject")) {
      if (sql.includes("subject.space_id = $4")) {
        assertLifecycleSubjectQuery(sql, parameters, "activity");
        const exactSubjectScope = parametersEqual(parameters, [
          subjectTenantId,
          subjectWorkspaceId,
          factSubjectId,
          subjectSpaceId
        ]);
        return {
          rows:
            (options.subjectPresent ?? true) &&
            factSubjectType === "activity" &&
            exactSubjectScope &&
            subjectTenantId === devFixtures.tenantA &&
            subjectWorkspaceId === devFixtures.workspaceA &&
            subjectSpaceId === factSpaceId
              ? [{ owner_person_id: options.subjectOwnerPersonId ?? devFixtures.personA }]
              : []
        };
      }
      return {
        rows: present
          ? [
              {
                space_id: devFixtures.rootSpaceA,
                owner_person_id: options.subjectOwnerPersonId ?? devFixtures.personA,
                access_class: accessClass
              }
            ]
          : []
      };
    }
    if (sql.includes("FROM work.initiatives subject") && sql.includes("subject.space_id = $4")) {
      assertLifecycleSubjectQuery(sql, parameters, "initiative");
      const exactSubjectScope = parametersEqual(parameters, [
        subjectTenantId,
        subjectWorkspaceId,
        factSubjectId,
        subjectSpaceId
      ]);
      return {
        rows:
          (options.subjectPresent ?? true) &&
          factSubjectType === "initiative" &&
          exactSubjectScope &&
          subjectTenantId === devFixtures.tenantA &&
          subjectWorkspaceId === devFixtures.workspaceA &&
          subjectSpaceId === factSpaceId
            ? [{ owner_person_id: options.subjectOwnerPersonId ?? devFixtures.personA }]
            : []
      };
    }
    if (sql.includes("WITH RECURSIVE target AS")) {
      return {
        rows: [
          {
            is_root: factSpaceId === devFixtures.rootSpaceA,
            target_restricted: !(options.spaceReadable ?? true),
            direct_grant_ids: options.directGrantId ? [options.directGrantId] : [],
            direct_grant_space_ids: options.directGrantSpaceId ? [options.directGrantSpaceId] : [],
            inherited_grant_ids: options.inheritedGrantId ? [options.inheritedGrantId] : [],
            inherited_grant_space_ids: options.inheritedGrantSpaceId
              ? [options.inheritedGrantSpaceId]
              : []
          }
        ]
      };
    }
    if (sql.includes("WITH RECURSIVE authority_path AS")) {
      return { rows: options.inheritedPath ?? [] };
    }
    if (
      sql.includes("FROM access.spaces space_row") &&
      sql.includes("space_row.id = ANY($3::uuid[])")
    ) {
      const requestedIds = parameters[2];
      const pathIds = (options.inheritedPath ?? []).map(({ id }) => id).sort();
      return {
        rows: parametersEqual(requestedIds as readonly unknown[], pathIds)
          ? pathIds.map((id) => ({ id }))
          : []
      };
    }
    if (sql.includes("SELECT id, resource_id FROM access.access_relationships")) {
      const grantId = options.directGrantId ?? options.inheritedGrantId;
      const grantSpaceId = options.directGrantSpaceId ?? options.inheritedGrantSpaceId;
      const exactGrant = parametersEqual(parameters, [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        grantId,
        grantSpaceId,
        membershipId,
        membershipUserId
      ]);
      return { rows: exactGrant ? [{ id: grantId, resource_id: grantSpaceId }] : [] };
    }
    if (sql.includes("SELECT id") && sql.includes("FROM access.spaces")) {
      const requestedSpaceId = parameters[0];
      const exactSpaceScope =
        requestedSpaceId === factSpaceId &&
        parameters[1] === devFixtures.tenantA &&
        parameters[2] === devFixtures.workspaceA;
      return {
        rows:
          present && exactSpaceScope && !(options.spaceArchived ?? false)
            ? [{ id: factSpaceId }]
            : []
      };
    }
    if (sql.includes("FROM truth.claims claim") && sql.includes("JOIN work.initiatives")) {
      return {
        rows: present
          ? [
              {
                space_id: devFixtures.rootSpaceA,
                access_class: accessClass,
                owner_person_id: options.proposalOwnerPersonId ?? devFixtures.personA,
                created_by_user_id: options.proposalCreatedByUserId ?? devFixtures.userA,
                created_by_membership_id:
                  options.proposalCreatedByMembershipId ?? devFixtures.membershipAOwner
              }
            ]
          : []
      };
    }
    if (
      sql.includes("FROM truth.claims resource") ||
      sql.includes("FROM truth.accepted_facts resource")
    ) {
      return {
        rows: present ? [{ space_id: devFixtures.rootSpaceA, access_class: accessClass }] : []
      };
    }
    throw new Error(`Unexpected B2 Slice 1 authorization query: ${sql}`);
  });
  return { query, tx: { query } as unknown as TenantQueryExecutor };
}

function lifecycleContext(
  overrides: Partial<SecurityContext> & {
    identity?: "tenant-a-owner" | "tenant-a-viewer";
  } = {}
): SecurityContext {
  const { identity = "tenant-a-owner", ...contextOverrides } = overrides;
  return {
    ...createDevSecurityContext(identity),
    requestedSpaceIds: [devFixtures.rootSpaceA],
    ...contextOverrides
  };
}

function lifecycleContextWithoutDisplayPerson(): SecurityContext {
  const context = lifecycleContext();
  delete context.actorDisplayPersonId;
  return context;
}

function genericTargetDenial() {
  return {
    allowed: false,
    reasonCode: "b1_resource_not_available",
    policyVersion: "default-v1"
  };
}

function parametersEqual(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertLifecycleFactQuery(sql: string, parameters: readonly unknown[]): void {
  const requiredFragments = [
    "fact.tenant_id = $1",
    "fact.workspace_id = $2",
    "fact.id = $3",
    "fact.status = 'current'",
    "fact.version = 1",
    "fact.subject_type = 'activity'",
    "fact.predicate = 'activity.outcome'",
    "fact.subject_type = 'initiative'",
    "fact.predicate = 'initiative.primary_objective'",
    "space.tenant_id = fact.tenant_id",
    "space.workspace_id = fact.workspace_id",
    "space.id = fact.space_id",
    "space.archived_at IS NULL",
    "space.access_class",
    "fact.access_class"
  ];
  for (const fragment of requiredFragments) {
    if (!sql.includes(fragment)) throw new Error(`Lifecycle Fact query omitted: ${fragment}`);
  }
  if (!parametersEqual(parameters, [devFixtures.tenantA, devFixtures.workspaceA, factId])) {
    throw new Error(
      `Lifecycle Fact query used unexpected parameters: ${JSON.stringify(parameters)}`
    );
  }
}

function assertLifecycleSubjectQuery(
  sql: string,
  parameters: readonly unknown[],
  subjectType: "activity" | "initiative"
): void {
  const requiredFragments = [
    "subject.tenant_id = $1",
    "subject.workspace_id = $2",
    "subject.id = $3",
    "subject.space_id = $4"
  ];
  for (const fragment of requiredFragments) {
    if (!sql.includes(fragment)) throw new Error(`Lifecycle subject query omitted: ${fragment}`);
  }
  if (parameters.length !== 4) {
    throw new Error(`${subjectType} lifecycle query used ${parameters.length} parameters`);
  }
}

function maxAccessClass(
  left: "public" | "workspace" | "restricted" | "confidential",
  right: "public" | "workspace" | "restricted" | "confidential"
) {
  const rank = { public: 0, workspace: 1, restricted: 2, confidential: 3 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function lifecycleQueryTrace(query: ReturnType<typeof vi.fn>): string[] {
  return query.mock.calls.map(([sql]) => queryKind(sql));
}

function targetQueryTrace(query: ReturnType<typeof vi.fn>): Array<[string, readonly unknown[]]> {
  const membershipIndex = lifecycleQueryTrace(query).indexOf("membership-user");
  return query.mock.calls
    .slice(membershipIndex + 1)
    .map(([sql, parameters = []]) => [normalizeSql(sql), parameters]);
}

function queryCalls(
  query: ReturnType<typeof vi.fn>,
  kind: string
): Array<[string, readonly unknown[]]> {
  return query.mock.calls
    .filter(([sql]) => queryKind(sql) === kind)
    .map(([sql, parameters = []]) => [sql, parameters]);
}

function queryKind(sql: string): string {
  if (sql.includes("FROM identity.policy_versions")) return "policy";
  if (sql.includes("FROM identity.memberships m")) return "membership-user";
  if (sql.includes("FROM truth.accepted_facts fact")) return "fact-space";
  if (sql.includes("FROM work.activities subject") && sql.includes("subject.space_id = $4")) {
    return "activity-subject";
  }
  if (sql.includes("FROM work.initiatives subject") && sql.includes("subject.space_id = $4")) {
    return "initiative-subject";
  }
  if (sql.includes("WITH RECURSIVE target AS")) return "space-grant-path";
  if (sql.includes("WITH RECURSIVE authority_path AS")) return "inherited-path";
  if (sql.includes("space_row.id = ANY($3::uuid[])")) return "inherited-path-lock";
  if (sql.includes("SELECT id, resource_id FROM access.access_relationships")) {
    return "grant-lock";
  }
  if (sql.includes("SELECT id") && sql.includes("FROM access.spaces")) return "current-space";
  return "other";
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

const dataModifyingSqlToken =
  /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|CALL|DO)\b/iu;

function assertReadOnlySqlText(sql: string): void {
  const firstToken = sql
    .trim()
    .match(/^([A-Z]+)/iu)?.[1]
    ?.toUpperCase();
  if (firstToken !== "SELECT" && firstToken !== "WITH") {
    throw new Error(
      `Lifecycle authorization SQL must be read-only; found ${firstToken ?? "no token"}`
    );
  }
  const modifyingToken = sql.match(dataModifyingSqlToken)?.[0];
  if (modifyingToken) {
    throw new Error(`Lifecycle authorization SQL contains data-modifying token ${modifyingToken}`);
  }
}

function expectReadOnlySql(query: ReturnType<typeof vi.fn>): void {
  expect(query.mock.calls.length).toBeGreaterThan(0);
  for (const [sql] of query.mock.calls) {
    assertReadOnlySqlText(sql);
  }
}
