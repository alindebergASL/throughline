import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrustedObjectiveGuard, type TrustedObjectiveRequest } from "./trusted-objective.guard.js";

afterEach(() => vi.unstubAllEnvs());

describe("TrustedObjectiveGuard", () => {
  it.each([
    ["owner", "11111111-1111-4111-8111-111111111111"],
    ["unavailable", "22222222-2222-4222-8222-222222222222"]
  ])(
    "captures exact startup persona %s and preserves correlation metadata",
    (persona, tenantId) => {
      configure(persona);
      const guard = new TrustedObjectiveGuard();
      vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", persona === "owner" ? "unavailable" : "owner");
      const request = activate(guard, {
        "x-request-id": "correlation-only",
        "x-trace-id": "0123456789abcdef0123456789abcdef"
      });

      expect(request.trustedObjectiveContext).toMatchObject({
        tenantId,
        requestId: "correlation-only",
        traceId: "0123456789abcdef0123456789abcdef"
      });
    }
  );

  it.each([
    { "x-throughline-dev-identity": "tenant-a-owner" },
    { "x-throughline-dev-identity": "tenant-b-viewer" },
    { "x-throughline-tenant-id": "11111111-1111-4111-8111-111111111111" },
    { role: "owner" }
  ])("rejects caller authority headers generically: %o", (headers) => {
    configure("owner");
    const guard = new TrustedObjectiveGuard();
    expect(() => activate(guard, headers)).toThrowError(
      new UnauthorizedException("Authentication is unavailable")
    );
  });

  it.each([
    [undefined, "dev", "test"],
    ["", "dev", "test"],
    ["OWNER", "dev", "test"],
    [" owner ", "dev", "test"],
    ["admin", "dev", "test"],
    ["owner", "workos", "test"],
    ["owner", "dev", "production"]
  ])(
    "fails closed for startup config persona=%s adapter=%s environment=%s",
    (persona, adapter, environment) => {
      vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", persona);
      vi.stubEnv("AUTH_ADAPTER", adapter);
      vi.stubEnv("NODE_ENV", environment);
      const guard = new TrustedObjectiveGuard();
      expect(() => activate(guard, {})).toThrowError(
        new UnauthorizedException("Authentication is unavailable")
      );
    }
  );
});

function configure(persona: string): void {
  vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", persona);
  vi.stubEnv("AUTH_ADAPTER", "dev");
  vi.stubEnv("NODE_ENV", "test");
}

function activate(
  guard: TrustedObjectiveGuard,
  headers: TrustedObjectiveRequest["headers"]
): TrustedObjectiveRequest {
  const request: TrustedObjectiveRequest = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request })
  } as ExecutionContext;
  expect(guard.canActivate(context)).toBe(true);
  return request;
}
