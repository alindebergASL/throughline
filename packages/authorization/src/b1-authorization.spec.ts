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
  const query = vi.fn(async (sql: string) => {
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
            has_direct_grant: true,
            has_inherited_grant: false
          }
        ]
      };
    }
    if (sql.includes("SELECT id") && sql.includes("FROM access.spaces")) {
      return { rows: [{ id: options.resource?.space_id ?? devFixtures.rootSpaceA }] };
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("grant_record")) {
      return { rows: [{ allowed: options.contributor ?? false }] };
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
