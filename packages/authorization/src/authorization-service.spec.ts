import type { SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuthorizationService } from "./authorization-service.js";
import {
  applyMigrations,
  createPgPool,
  seedWaveA2DeterministicData,
  type PgPool
} from "@throughline/db";

const ownerUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const appUrl =
  process.env.TEST_APP_DATABASE_URL ??
  ownerUrl?.replace("throughline:throughline_dev@", "throughline_app:throughline_app_dev@");
const maybeDescribe = ownerUrl && appUrl ? describe : describe.skip;

describe("AuthorizationService principal defaults", () => {
  it("denies service principals by default without consulting live authority hints", async () => {
    const service = new PostgresAuthorizationService({} as PgPool);
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

  it("denies agent principals by default", async () => {
    const service = new PostgresAuthorizationService({} as PgPool);
    const decision = await service.can(createDevSecurityContext("tenant-a-agent"), "space.read", {
      type: "space",
      id: devFixtures.rootSpaceA
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("principal_default_denied");
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
    appPool = createPgPool(appUrl);
    service = new PostgresAuthorizationService(appPool);

    await applyMigrations(ownerPool, { reset: true });
    await seedWaveA2DeterministicData(ownerPool);
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
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

  it("denies restricted child Space reads to same-workspace viewers without direct grants", async () => {
    const decision = await service.can(createDevSecurityContext("tenant-a-viewer"), "space.read", {
      type: "space",
      id: devFixtures.restrictedSpaceA
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("space_access_denied");
  });

  it("denies stale contexts after live membership suspension", async () => {
    const context = createDevSecurityContext("tenant-a-owner");
    await ownerPool.query("UPDATE identity.memberships SET status = 'suspended' WHERE id = $1", [
      devFixtures.membershipAOwner
    ]);

    const decision = await service.can(context, "workspace.manage_members", {
      type: "workspace",
      id: devFixtures.workspaceA
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("principal_not_active");
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
