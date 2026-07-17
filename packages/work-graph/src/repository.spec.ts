import type { TenantDbTransaction } from "@throughline/db";
import { describe, expect, it, vi } from "vitest";
import { WorkGraphRepository } from "./repository.js";

const tenantId = "70000000-0000-7000-8000-000000000001";
const workspaceId = "70000000-0000-7000-8000-000000000002";
const initiativeId = "70000000-0000-7000-8000-000000000003";
const initiativeSpaceId = "70000000-0000-7000-8000-000000000004";
const readableOrganizationId = "70000000-0000-7000-8000-000000000005";

describe("WorkGraphRepository authorized projections", () => {
  it("filters Initiative Organization associations in SQL and yields null for a hidden primary", async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM work.initiatives")) {
        return {
          rows: [
            {
              id: initiativeId,
              space_id: initiativeSpaceId,
              title: "Initiative",
              status: "active",
              target_outcome: null,
              target_date: null,
              owner_person_id: null,
              profile_id: "ai-solutions",
              profile_version: "v1",
              version: 1
            }
          ]
        };
      }
      if (sql.includes("FROM work.initiative_organizations")) {
        expect(sql).toContain("organization_id = ANY($4::uuid[])");
        expect(values?.[3]).toEqual([readableOrganizationId]);
        return {
          rows: [{ organization_id: readableOrganizationId, association_role: "supporting" }]
        };
      }
      if (sql.includes("FROM work.initiative_people")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = new WorkGraphRepository({ query } as unknown as TenantDbTransaction);

    await expect(
      repository.getInitiative(tenantId, workspaceId, initiativeId, {
        organizationIds: [readableOrganizationId]
      })
    ).resolves.toMatchObject({
      organizationIds: [readableOrganizationId],
      primaryOrganizationId: null
    });
  });

  it("ends a relationship only when every persisted grant requirement is still current", async () => {
    const grantId = "70000000-0000-7000-8000-000000000006";
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      expect(sql).toContain("WITH authority AS");
      expect(sql).toContain("UPDATE work.relationships");
      expect(sql).toContain("NOT EXISTS (");
      expect(sql).toContain("FROM unnest($8::uuid[], $9::uuid[])");
      expect(sql).toContain("grant_record.id = requirement.grant_id");
      expect(sql).toContain("grant_record.resource_id = requirement.resource_id");
      expect(sql).toContain("grant_record.subject_id = $7");
      expect(sql).toContain("grant_record.subject_id = $6");
      expect(values?.slice(7)).toEqual([[grantId], [initiativeSpaceId]]);
      return { rows: [{ authorized: false, space_id: null, version: null }] };
    });
    const repository = new WorkGraphRepository({ query } as unknown as TenantDbTransaction);

    await expect(
      repository.endRelationship({
        tenantId,
        workspaceId,
        relationshipId: initiativeId,
        expectedVersion: 1,
        validTo: "2026-07-17T00:00:00.000Z",
        actorUserId: "70000000-0000-7000-8000-000000000007",
        actorMembershipId: "70000000-0000-7000-8000-000000000008",
        authorityRequirements: [{ grantId, resourceId: initiativeSpaceId }]
      })
    ).resolves.toEqual({ authorized: false });
  });
});
