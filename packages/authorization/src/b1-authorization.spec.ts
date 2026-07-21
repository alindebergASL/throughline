import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import type { TenantQueryExecutor } from "@throughline/db";
import { describe, expect, it, vi } from "vitest";
import { PostgresAuthorizationService } from "./authorization-service.js";

function executor(
  options: {
    role?: "owner" | "admin" | "member" | "viewer";
    resource?: {
      space_id: string;
      access_class: "public" | "workspace" | "restricted" | "confidential";
    };
    personUseSite?: boolean;
    contributor?: boolean;
  } = {}
) {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    void _values;
    if (sql.includes("FROM identity.policy_versions")) return { rows: [{ id: "default-v1" }] };
    if (sql.includes("FROM identity.memberships m")) {
      return {
        rows: [
          { role: options.role ?? "owner", membership_status: "active", user_status: "active" }
        ]
      };
    }
    if (sql.includes("FROM content.source_artifacts source")) {
      return { rows: options.resource ? [options.resource] : [] };
    }
    if (sql.includes("FROM content.content_items resource")) {
      return { rows: options.resource ? [options.resource] : [] };
    }
    if (sql.includes("FROM work.activities resource") && sql.includes("JOIN identity.people")) {
      return {
        rows: options.personUseSite
          ? [options.resource ?? { space_id: devFixtures.rootSpaceA, access_class: "workspace" }]
          : []
      };
    }
    if (sql.includes("FROM work.activities resource")) {
      return { rows: options.resource ? [options.resource] : [] };
    }
    if (sql.includes("SELECT access_class FROM access.spaces")) {
      return { rows: [{ access_class: options.resource?.access_class ?? "workspace" }] };
    }
    if (sql.includes("WITH RECURSIVE target AS")) {
      return {
        rows: [
          {
            is_root: false,
            target_restricted: false,
            direct_grant_ids: ["70000000-0000-7000-8000-000000000091"],
            direct_grant_space_ids: [options.resource?.space_id ?? devFixtures.rootSpaceA],
            inherited_grant_ids: [],
            inherited_grant_space_ids: []
          }
        ]
      };
    }
    if (sql.includes("SELECT id") && sql.includes("FROM access.spaces")) {
      return { rows: [{ id: options.resource?.space_id ?? devFixtures.rootSpaceA }] };
    }
    if (sql.includes("SELECT grant_record.id") && sql.includes("grant_record")) {
      return {
        rows: options.contributor
          ? [
              {
                id: "70000000-0000-7000-8000-000000000092",
                resource_id: options.resource?.space_id ?? devFixtures.rootSpaceA
              }
            ]
          : []
      };
    }
    throw new Error(`Unexpected B1 authorization query: ${sql}`);
  });
  return { query, tx: { query } as unknown as TenantQueryExecutor };
}

describe("central B1 authorization", () => {
  it("allows contributor-or-higher activity creation only through live Space authority", async () => {
    const { tx } = executor({
      role: "member",
      contributor: true,
      resource: { space_id: devFixtures.rootSpaceA, access_class: "workspace" }
    });
    const service = new PostgresAuthorizationService({} as never);
    const decision = await service.canInTransaction(
      createDevSecurityContext("tenant-a-owner"),
      "activity.create",
      { type: "space", id: devFixtures.rootSpaceA },
      tx as never
    );
    expect(decision).toMatchObject({ allowed: true, reasonCode: "b1_contributor_authority" });
  });

  it("applies the source/Space access-class maximum without leaking whether a source exists", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const context = createDevSecurityContext("tenant-a-owner");
    const confidential = executor({
      resource: { space_id: devFixtures.rootSpaceA, access_class: "confidential" }
    });
    const missing = executor();
    const denied = await service.canInTransaction(
      context,
      "source.read",
      { type: "source", id: devFixtures.personA },
      confidential.tx as never
    );
    const absent = await service.canInTransaction(
      context,
      "source.read",
      { type: "source", id: devFixtures.personA },
      missing.tx as never
    );
    expect(denied).toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
    expect(absent).toEqual(denied);
  });

  it.each(["content.read", "content.revise"] as const)(
    "enforces the content-item access ceiling for %s even when the governing Space is readable",
    async (action) => {
      const service = new PostgresAuthorizationService({} as never);
      const harness = executor({
        resource: { space_id: devFixtures.rootSpaceA, access_class: "confidential" }
      });
      await expect(
        service.canInTransaction(
          createDevSecurityContext("tenant-a-owner"),
          action,
          { type: "content_item", id: devFixtures.personA },
          harness.tx as never
        )
      ).resolves.toMatchObject({
        allowed: false,
        reasonCode: "b1_resource_not_available"
      });
      const scopeSql = harness.query.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes("FROM content.content_items resource"));
      expect(scopeSql).toContain("CASE resource.access_class");
      expect(scopeSql).toContain("CASE space.access_class");
    }
  );

  it("authorizes an exact origin item, revision, and Space without selecting revision bytes", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor({
      resource: { space_id: devFixtures.rootSpaceA, access_class: "confidential" }
    });
    await expect(
      service.canInTransaction(
        createDevSecurityContext("tenant-a-owner"),
        "content.read",
        { type: "content_item", id: devFixtures.personA },
        harness.tx as never,
        { contentRevision: 3, requiredSpaceId: devFixtures.rootSpaceA }
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
    const [sql, values] = harness.query.mock.calls.find(([candidate]) =>
      candidate.includes("JOIN content.content_revisions revision")
    )!;
    expect(sql).toContain("revision.revision_number = $4");
    expect(sql).toContain("resource.space_id = $5");
    expect(sql).toContain("CASE revision.access_class");
    expect(sql).not.toMatch(/revision\.body|body_encoding|octet_length/i);
    expect(values).toEqual([
      expect.any(String),
      expect.any(String),
      devFixtures.personA,
      3,
      devFixtures.rootSpaceA
    ]);
  });

  it("uses the validated requested classification as the creation ceiling", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const harness = executor({
      resource: { space_id: devFixtures.rootSpaceA, access_class: "workspace" }
    });
    await expect(
      service.canInTransaction(
        createDevSecurityContext("tenant-a-owner"),
        "source.capture",
        { type: "space", id: devFixtures.rootSpaceA },
        harness.tx as never,
        { requestedAccessClass: "confidential" }
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
  });

  it("does not let Activity read authority substitute for source.capture contribution", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const context = createDevSecurityContext("tenant-a-viewer");
    const readableOnly = executor({
      role: "viewer",
      contributor: false,
      resource: { space_id: devFixtures.rootSpaceA, access_class: "workspace" }
    });
    await expect(
      service.canInTransaction(
        context,
        "activity.read",
        { type: "activity", id: devFixtures.rootSpaceA },
        readableOnly.tx as never
      )
    ).resolves.toMatchObject({ allowed: true, reasonCode: "b1_resource_read" });
    await expect(
      service.canInTransaction(
        context,
        "source.capture",
        { type: "space", id: devFixtures.rootSpaceA },
        readableOnly.tx as never
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
  });

  it("requires an exact associated use-site for the allowlisted safe Person projection", async () => {
    const service = new PostgresAuthorizationService({} as never);
    const context = createDevSecurityContext("tenant-a-owner");
    const allowed = executor({ personUseSite: true });
    const denied = executor({ personUseSite: false });
    await expect(
      service.canInTransaction(
        context,
        "person.read",
        { type: "person", id: devFixtures.externalPersonA },
        allowed.tx as never,
        { personUseSite: { type: "activity", id: devFixtures.rootSpaceA } }
      )
    ).resolves.toMatchObject({ allowed: true, reasonCode: "person_use_site_read" });
    await expect(
      service.canInTransaction(
        context,
        "person.read",
        { type: "person", id: devFixtures.externalPersonA },
        denied.tx as never,
        { personUseSite: { type: "activity", id: devFixtures.rootSpaceA } }
      )
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });
  });

  it.each(["tenant-a-service", "tenant-a-agent"] as const)(
    "keeps every B1 action default-denied for %s",
    async (identity) => {
      const service = new PostgresAuthorizationService({} as never);
      const { tx } = executor();
      await expect(
        service.canInTransaction(
          createDevSecurityContext(identity),
          "organization.read",
          { type: "organization", id: devFixtures.rootSpaceA },
          tx as never
        )
      ).resolves.toMatchObject({ allowed: false, reasonCode: "principal_default_denied" });
    }
  );
});
