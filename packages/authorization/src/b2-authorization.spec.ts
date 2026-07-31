import type { TenantQueryExecutor } from "@throughline/db";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import { PostgresAuthorizationService } from "./authorization-service.js";

const subjectId = "70000000-0000-7000-8000-000000000081";
const claimId = "70000000-0000-7000-8000-000000000082";

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
});

function executor(
  options: {
    role?: "owner" | "admin" | "member" | "viewer";
    subjectOwnerPersonId?: string;
    accessClass?: "public" | "workspace" | "restricted" | "confidential";
    present?: boolean;
  } = {}
) {
  const present = options.present ?? true;
  const accessClass = options.accessClass ?? "workspace";
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM identity.policy_versions")) return { rows: [{ id: "default-v1" }] };
    if (sql.includes("FROM identity.memberships m")) {
      return {
        rows: [
          {
            membership_id: devFixtures.membershipAOwner,
            user_id: devFixtures.userA,
            person_id: devFixtures.personA,
            role: options.role ?? "owner",
            membership_status: "active",
            user_status: "active"
          }
        ]
      };
    }
    if (sql.includes("FROM work.activities subject")) {
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
    if (sql.includes("WITH RECURSIVE target AS")) {
      return {
        rows: [
          {
            is_root: true,
            target_restricted: false,
            direct_grant_ids: [],
            direct_grant_space_ids: [],
            inherited_grant_ids: [],
            inherited_grant_space_ids: []
          }
        ]
      };
    }
    if (sql.includes("SELECT id") && sql.includes("FROM access.spaces")) {
      return { rows: present ? [{ id: devFixtures.rootSpaceA }] : [] };
    }
    if (sql.includes("FROM truth.claims resource")) {
      return {
        rows: present ? [{ space_id: devFixtures.rootSpaceA, access_class: accessClass }] : []
      };
    }
    throw new Error(`Unexpected B2 Slice 1 authorization query: ${sql}`);
  });
  return { query, tx: { query } as unknown as TenantQueryExecutor };
}
