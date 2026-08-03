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
    ["127.0.0.1", "localhost"],
    ["127.0.0.2", "127.0.0.1:3001"],
    ["::1", "[::1]:3001"],
    ["::ffff:127.0.0.1", "localhost:3001"],
    ["::ffff:127.12.34.56", "127.12.34.56"],
    ["127.0.0.1", "[::ffff:7f00:1]:3001"]
  ])("accepts loopback socket %s with loopback Host %s", (remoteAddress, host) => {
    configure("owner");
    const request = activate(new TrustedObjectiveGuard(), { host }, remoteAddress);
    expect(request.trustedObjectiveContext?.tenantId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it.each([
    ["application/json"],
    ["Application/JSON; Charset=UTF-8"],
    ['application/json; charset="utf-8"']
  ])("accepts POST with trusted JSON content type %s", (contentType) => {
    configure("owner");
    const request = activate(
      new TrustedObjectiveGuard(),
      { "content-type": contentType },
      "127.0.0.1",
      true,
      "POST"
    );
    expect(request.trustedObjectiveContext).toBeDefined();
  });

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])(
    "rejects POST with untrusted content type %s generically",
    (contentType) => {
      configure("owner");
      const headers = contentType === undefined ? {} : { "content-type": contentType };
      expect(() =>
        activate(new TrustedObjectiveGuard(), headers, "127.0.0.1", true, "POST")
      ).toThrowError(new UnauthorizedException("Authentication is unavailable"));
    }
  );

  it.each([
    [null, "localhost"],
    ["", "localhost"],
    ["192.168.1.4", "localhost"],
    ["203.0.113.9", "localhost"],
    ["127.0.0.1", undefined],
    ["127.0.0.1", "api.internal"],
    ["127.0.0.1", "192.168.1.4:3001"],
    ["127.0.0.1", "localhost.evil.example"],
    ["127.0.0.1", "localhost,api.internal"]
  ])("rejects off-boundary socket=%s Host=%s generically", (remoteAddress, host) => {
    configure("owner");
    const headers = host === undefined ? {} : { host };
    expect(() =>
      activate(new TrustedObjectiveGuard(), headers, remoteAddress, host !== undefined)
    ).toThrowError(new UnauthorizedException("Authentication is unavailable"));
  });

  it.each([
    { "x-throughline-dev-identity": "tenant-a-owner" },
    { "x-throughline-dev-identity": "tenant-b-viewer" },
    { "x-throughline-tenant-id": "11111111-1111-4111-8111-111111111111" },
    { "x-forwarded-for": "127.0.0.1" },
    { forwarded: "for=127.0.0.1;host=localhost" },
    { role: "owner" }
  ])("rejects caller authority headers generically: %o", (headers) => {
    configure("owner");
    const guard = new TrustedObjectiveGuard();
    expect(() => activate(guard, headers)).toThrowError(
      new UnauthorizedException("Authentication is unavailable")
    );
  });

  it.each([
    [{ "x-request-id": "contains space" }],
    [{ "x-request-id": "x".repeat(201) }],
    [{ "x-trace-id": "not-a-trace-id" }],
    [{ "x-trace-id": "0".repeat(33) }]
  ])("rejects unsafe correlation metadata generically: %o", (headers) => {
    configure("owner");
    expect(() => activate(new TrustedObjectiveGuard(), headers)).toThrowError(
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
  headers: TrustedObjectiveRequest["headers"],
  remoteAddress: string | null | undefined = "127.0.0.1",
  supplyDefaultHost = true,
  method = "GET"
): TrustedObjectiveRequest {
  const requestHeaders =
    supplyDefaultHost && !Object.keys(headers).some((key) => key.toLowerCase() === "host")
      ? { ...headers, host: "localhost" }
      : headers;
  const request: TrustedObjectiveRequest = {
    headers: requestHeaders,
    method,
    ...(remoteAddress === null ? {} : { socket: { remoteAddress } })
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request })
  } as ExecutionContext;
  expect(guard.canActivate(context)).toBe(true);
  return request;
}
