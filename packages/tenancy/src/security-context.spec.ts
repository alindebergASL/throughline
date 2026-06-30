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

  it("rejects expired contexts", () => {
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
