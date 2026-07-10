import { describe, expect, it } from "vitest";
import { createDevSecurityContext, resolveDevIdentityFromHeaders } from "./dev-identity.js";
import { parseSecurityContext } from "./security-context.js";

describe("SecurityContext validation", () => {
  it("rejects contexts with no principal", () => {
    const context = createDevSecurityContext("tenant-a-owner");
    const withoutPrincipal: Record<string, unknown> = { ...context };
    delete withoutPrincipal.actorUserId;
    delete withoutPrincipal.actorMembershipId;

    expect(() => parseSecurityContext(withoutPrincipal)).toThrow(/exactly one/);
  });

  it.each([
    ["actorUserId", "actorMembershipId"],
    ["actorMembershipId", "actorUserId"]
  ] as const)("rejects a user principal missing %s", (missingField, presentField) => {
    const context = createDevSecurityContext("tenant-a-owner");
    const partialPrincipal: Record<string, unknown> = { ...context };
    delete partialPrincipal[missingField];

    expect(partialPrincipal[presentField]).toBeDefined();
    expect(() => parseSecurityContext(partialPrincipal)).toThrow(
      /requires both actorUserId and actorMembershipId/
    );
  });

  it.each([
    ["user and service", { servicePrincipalId: "11111111-1111-4111-8111-111111111116" }],
    ["user and agent", { agentPrincipalId: "11111111-1111-4111-8111-111111111117" }],
    [
      "service and agent",
      {
        servicePrincipalId: "11111111-1111-4111-8111-111111111116",
        agentPrincipalId: "11111111-1111-4111-8111-111111111117"
      }
    ]
  ])("rejects mixed %s principal variants", (_name, principalFields) => {
    const userContext = createDevSecurityContext("tenant-a-owner");
    const context =
      "servicePrincipalId" in principalFields && "agentPrincipalId" in principalFields
        ? {
            ...userContext,
            actorUserId: undefined,
            actorMembershipId: undefined,
            ...principalFields
          }
        : { ...userContext, ...principalFields };

    expect(() => parseSecurityContext(context)).toThrow(/exactly one/);
  });

  it("rejects a partial user principal even when another variant is complete", () => {
    const context = { ...createDevSecurityContext("tenant-a-service") } as Record<string, unknown>;
    context.actorUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

    expect(() => parseSecurityContext(context)).toThrow(
      /requires both actorUserId and actorMembershipId/
    );
  });

  it("preserves delegation metadata without treating it as another actor principal", () => {
    const context = createDevSecurityContext("tenant-a-service");

    expect(
      parseSecurityContext({
        ...context,
        delegatedByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        delegatedByMembershipId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"
      })
    ).toMatchObject({ servicePrincipalId: context.servicePrincipalId });
  });

  it("rejects contexts with a non-positive lifetime", () => {
    const context = createDevSecurityContext("tenant-a-owner");

    expect(() =>
      parseSecurityContext({
        ...context,
        expiresAt: context.issuedAt
      })
    ).toThrow(/expiresAt/);
  });

  it("does not accept public headers as authorization authority", () => {
    process.env.AUTH_ADAPTER = "dev";
    process.env.NODE_ENV = "test";

    expect(() =>
      resolveDevIdentityFromHeaders({
        "x-throughline-dev-identity": "tenant-a-owner",
        "x-throughline-tenant-id": "11111111-1111-4111-8111-111111111111"
      })
    ).toThrow(/not accepted/);
  });
});
