import type { TenantDbTransaction } from "@throughline/db";
import { describe, expect, it, vi } from "vitest";
import { WorkGraphRepository } from "./repository.js";
import {
  deriveRelationshipGoverningSpace,
  normalizeOrganizationDomain,
  normalizeOrganizationDomains,
  resolveActivityGoverningParent,
  validateActivityTime,
  validateInitiativeAssociations,
  type RelationshipEndpoint
} from "./work-graph.js";

describe("work graph invariants", () => {
  it("normalizes IDNA domains and rejects duplicate or non-host input", () => {
    expect(normalizeOrganizationDomain("BÜCHER.example.")).toBe("xn--bcher-kva.example");
    expect(normalizeOrganizationDomains(["z.example", "A.example"])).toEqual([
      "a.example",
      "z.example"
    ]);
    expect(() => normalizeOrganizationDomains(["EXAMPLE.com", "example.com"])).toThrow();
    expect(() => normalizeOrganizationDomain("https://example.com/path")).toThrow();
  });

  it("requires exactly one primary Initiative organization", () => {
    expect(() =>
      validateInitiativeAssociations({ organizationIds: ["one"], primaryOrganizationId: "one" })
    ).not.toThrow();
    expect(() =>
      validateInitiativeAssociations({ organizationIds: ["one"], primaryOrganizationId: "two" })
    ).toThrow();
  });

  it("uses an explicit governing parent and never array order", () => {
    expect(
      resolveActivityGoverningParent({
        initiativeIds: ["secondary", "governing"],
        organizationIds: ["organization"],
        governingInitiativeId: "governing"
      })
    ).toEqual({ type: "initiative", id: "governing" });
    expect(() =>
      resolveActivityGoverningParent({
        initiativeIds: ["first"],
        organizationIds: [],
        governingInitiativeId: "missing"
      })
    ).toThrow();
    expect(() =>
      resolveActivityGoverningParent({ initiativeIds: ["first"], organizationIds: ["one"] })
    ).toThrow();
    expect(() => validateActivityTime({ startsAt: "2026-01-02", endsAt: "2026-01-01" })).toThrow();
  });
});

describe("Activity source-capture lock", () => {
  it("uses one fixed four-scope SHARE lock and sequences the current projection reads", async () => {
    const tenantId = "70000000-0000-7000-8000-000000000001";
    const workspaceId = "70000000-0000-7000-8000-000000000002";
    const spaceId = "70000000-0000-7000-8000-000000000003";
    const activityId = "70000000-0000-7000-8000-000000000004";
    let activeQueries = 0;
    let maximumActiveQueries = 0;
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      activeQueries += 1;
      maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
      await Promise.resolve();
      activeQueries -= 1;
      if (sql.includes("FROM work.activities activity")) {
        expect(values).toEqual([tenantId, workspaceId, spaceId, activityId]);
        return {
          rows: [
            {
              id: activityId,
              space_id: spaceId,
              subtype: "ai_workshop",
              profile_template_key: "ai_workshop",
              title: "Workshop",
              status: "captured",
              occurred_at: null,
              starts_at: null,
              ends_at: null,
              owner_person_id: "70000000-0000-7000-8000-000000000005",
              governing_initiative_id: "70000000-0000-7000-8000-000000000006",
              governing_organization_id: null,
              version: 1
            }
          ]
        };
      }
      if (sql.includes("work.activity_organizations")) {
        return { rows: [{ organization_id: "70000000-0000-7000-8000-000000000007" }] };
      }
      if (sql.includes("work.activity_initiatives")) {
        return { rows: [{ initiative_id: "70000000-0000-7000-8000-000000000006" }] };
      }
      if (sql.includes("work.activity_attendees")) {
        return { rows: [{ person_id: "70000000-0000-7000-8000-000000000008" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = new WorkGraphRepository({ query } as unknown as TenantDbTransaction);

    await expect(
      repository.lockActivityForSourceCapture(tenantId, workspaceId, spaceId, activityId)
    ).resolves.toMatchObject({ id: activityId, spaceId, status: "captured" });

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/JOIN access\.spaces governing_space/);
    expect(statements[0]).toMatch(/activity\.tenant_id = \$1/);
    expect(statements[0]).toMatch(/activity\.workspace_id = \$2/);
    expect(statements[0]).toMatch(/activity\.space_id = \$3/);
    expect(statements[0]).toMatch(/activity\.id = \$4/);
    expect(statements[0]).toContain("governing_space.archived_at IS NULL");
    expect(statements[0]).toContain("activity.status IN");
    expect(statements[0]).toContain("FOR SHARE OF activity");
    expect(maximumActiveQueries).toBe(1);
  });

  it("materializes only caller-authorized Activity associations", async () => {
    const visibleOrganization = "70000000-0000-7000-8000-000000000011";
    const hiddenOrganization = "70000000-0000-7000-8000-000000000012";
    const visibleInitiative = "70000000-0000-7000-8000-000000000013";
    const hiddenInitiative = "70000000-0000-7000-8000-000000000014";
    const visiblePerson = "70000000-0000-7000-8000-000000000015";
    const hiddenPerson = "70000000-0000-7000-8000-000000000016";
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM work.activities WHERE")) {
        return {
          rows: [
            {
              id: "70000000-0000-7000-8000-000000000010",
              space_id: "70000000-0000-7000-8000-000000000009",
              subtype: "ai_workshop",
              profile_template_key: "ai_workshop",
              title: "Mixed-space workshop",
              status: "captured",
              occurred_at: null,
              starts_at: null,
              ends_at: null,
              owner_person_id: hiddenPerson,
              governing_initiative_id: hiddenInitiative,
              governing_organization_id: null,
              version: 1
            }
          ]
        };
      }
      if (sql.includes("work.activity_organizations")) {
        expect(values?.[3]).toEqual([visibleOrganization]);
        return { rows: [{ organization_id: visibleOrganization }] };
      }
      if (sql.includes("work.activity_initiatives")) {
        expect(values?.[3]).toEqual([visibleInitiative]);
        return { rows: [{ initiative_id: visibleInitiative }] };
      }
      if (sql.includes("work.activity_attendees")) {
        expect(values?.[3]).toEqual([visiblePerson]);
        return { rows: [{ person_id: visiblePerson }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = new WorkGraphRepository({ query } as unknown as TenantDbTransaction);

    const projected = await repository.getActivity(
      "tenant",
      "workspace",
      "70000000-0000-7000-8000-000000000010",
      {
        organizationIds: [visibleOrganization],
        initiativeIds: [visibleInitiative],
        personIds: [visiblePerson]
      }
    );

    expect(projected.organizationIds).toEqual([visibleOrganization]);
    expect(projected.initiativeIds).toEqual([visibleInitiative]);
    expect(projected.attendeePersonIds).toEqual([visiblePerson]);
    expect(projected).not.toHaveProperty("ownerPersonId");
    expect(projected).not.toHaveProperty("governingInitiativeId");
    expect(JSON.stringify(projected)).not.toContain(hiddenOrganization);
    expect(JSON.stringify(projected)).not.toContain(hiddenInitiative);
    expect(JSON.stringify(projected)).not.toContain(hiddenPerson);
  });

  it("keeps getActivity as a plain read", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM work.activities WHERE")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = new WorkGraphRepository({ query } as unknown as TenantDbTransaction);
    await expect(
      repository.getActivity("tenant", "workspace", "activity", {
        organizationIds: [],
        initiativeIds: [],
        personIds: []
      })
    ).rejects.toThrow("unavailable");
    expect(query.mock.calls[0]?.[0]).not.toMatch(/FOR (?:UPDATE|SHARE)/);
  });
});

describe("relationship direction and governing Space", () => {
  const records = new Map<
    string,
    {
      tenantId: string;
      workspaceId: string;
      spaceId?: string;
      accessClass: "workspace" | "restricted";
    }
  >([
    ["person:p1", { tenantId: "t", workspaceId: "w", accessClass: "workspace" }],
    ["person:p2", { tenantId: "t", workspaceId: "w", accessClass: "workspace" }],
    [
      "organization:o1",
      { tenantId: "t", workspaceId: "w", spaceId: "org-space", accessClass: "restricted" }
    ],
    [
      "space:context",
      { tenantId: "t", workspaceId: "w", spaceId: "context", accessClass: "workspace" }
    ]
  ]);
  const resolve = (endpoint: RelationshipEndpoint) =>
    records.get(`${endpoint.type}:${endpoint.id}`);

  it("falls back from a Person subject to the Organization object Space", () => {
    expect(
      deriveRelationshipGoverningSpace({
        tenantId: "t",
        workspaceId: "w",
        subject: { type: "person", id: "p1" },
        predicate: "account_owner_for",
        object: { type: "organization", id: "o1" },
        resolve
      })
    ).toEqual({ spaceId: "org-space", accessClass: "restricted" });
  });

  it("uses an explicit Space-bearing context before subject and object", () => {
    expect(
      deriveRelationshipGoverningSpace({
        tenantId: "t",
        workspaceId: "w",
        subject: { type: "organization", id: "o1" },
        predicate: "works_with",
        object: { type: "person", id: "p1" },
        context: { type: "space", id: "context" },
        resolve
      })
    ).toEqual({ spaceId: "context", accessClass: "restricted" });
  });

  it("rejects Person-only and reflexive relationships without a bearing context", () => {
    expect(() =>
      deriveRelationshipGoverningSpace({
        tenantId: "t",
        workspaceId: "w",
        subject: { type: "person", id: "p1" },
        predicate: "works_with",
        object: { type: "person", id: "p2" },
        resolve
      })
    ).toThrow();
    expect(() =>
      deriveRelationshipGoverningSpace({
        tenantId: "t",
        workspaceId: "w",
        subject: { type: "person", id: "p1" },
        predicate: "works_with",
        object: { type: "person", id: "p1" },
        context: { type: "space", id: "context" },
        resolve
      })
    ).toThrow();
  });
});
