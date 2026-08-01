import { describe, expect, it } from "vitest";
import {
  TRUSTED_OBJECTIVE_DEMO_DATABASE,
  demoDatabaseUrl,
  parseDemoAdminUrl
} from "./trusted-objective-demo-config.js";

describe("trusted-objective disposable demo database boundary", () => {
  it("accepts only a loopback admin connection outside the fixed demo database", () => {
    const admin = parseDemoAdminUrl(
      "postgres://throughline:local-password@127.0.0.1:5432/throughline"
    );
    expect(demoDatabaseUrl(admin)).toBe(
      `postgres://throughline:local-password@127.0.0.1:5432/${TRUSTED_OBJECTIVE_DEMO_DATABASE}`
    );
  });

  it("accepts the bracketed IPv6 loopback hostname returned by WHATWG URL", () => {
    const admin = parseDemoAdminUrl("postgres://throughline:local-password@[::1]:5432/throughline");

    expect(admin.hostname).toBe("[::1]");
    expect(demoDatabaseUrl(admin)).toBe(
      `postgres://throughline:local-password@[::1]:5432/${TRUSTED_OBJECTIVE_DEMO_DATABASE}`
    );
  });

  it.each([
    undefined,
    "postgres://throughline:password@database.example/throughline",
    "postgres://throughline_app:password@localhost/throughline",
    "postgres://throughline:password@localhost/throughline_demo",
    "https://localhost/throughline"
  ])("rejects unsafe admin target %s", (value) => {
    expect(() => parseDemoAdminUrl(value)).toThrow();
  });
});
