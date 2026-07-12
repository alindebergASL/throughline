import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createAsyncContextReferenceCodec } from "@throughline/tenancy";
import { describe, expect, it } from "vitest";
import { parseFoundationWorkerRuntimeEnvironment } from "./main.js";

const activeKey = Buffer.alloc(32, 11).toString("base64");
const priorKey = Buffer.alloc(32, 12).toString("base64");
const instant = new Date("2030-07-11T00:00:00.000Z");
const claims = {
  tenantId: "70000000-0000-7000-8000-000000000001",
  workspaceId: "70000000-0000-7000-8000-000000000002",
  spaceId: "70000000-0000-7000-8000-000000000003",
  workerServicePrincipalId: "70000000-0000-7000-8000-000000000051",
  policyVersionId: "default-v1",
  ttlSeconds: 600
} as const;

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    TEST_WORKER_DATABASE_URL:
      "postgres://throughline_worker@127.0.0.1:5432/throughline_foundation_test",
    FOUNDATION_SQS_ENDPOINT: "http://127.0.0.1:4566",
    FOUNDATION_SQS_QUEUE_URL:
      "http://127.0.0.1:4566/000000000000/throughline-foundation-test-source",
    FOUNDATION_WORKER_SERVICE_PRINCIPAL_ID: "70000000-0000-7000-8000-000000000051",
    FOUNDATION_POLICY_VERSION_ID: "default-v1",
    FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({
      current_key: activeKey,
      prior_key: priorKey
    }),
    FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "current_key",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    ...overrides
  };
}

describe("Foundation worker executable verification-key rotation contract", () => {
  it("treats the CI HMAC bytes as test-only and rejects them in production", () => {
    const ciDummyKey = Buffer.alloc(32, 7).toString("base64");
    const configured = environment({
      FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({ ci_test_key: ciDummyKey }),
      FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "ci_test_key"
    });
    expect(() =>
      parseFoundationWorkerRuntimeEnvironment({ ...configured, NODE_ENV: "production" } as never)
    ).toThrow("production context key configuration is invalid");
    expect(() =>
      parseFoundationWorkerRuntimeEnvironment({ ...configured, NODE_ENV: "test" } as never)
    ).not.toThrow();
  });

  it("uses only the same active-key plus strict verification-map variables as test:foundation", () => {
    const parsed = parseFoundationWorkerRuntimeEnvironment(environment()) as unknown as {
      contextKeys: { activeKeyId: string; verificationKeys: ReadonlyMap<string, Uint8Array> };
    };
    expect(parsed.contextKeys.activeKeyId).toBe("current_key");
    expect([...parsed.contextKeys.verificationKeys.keys()]).toEqual(["current_key", "prior_key"]);
    expect(parsed).not.toHaveProperty("FOUNDATION_CONTEXT_SIGNING_KEY_ID");
    expect(parsed).not.toHaveProperty("FOUNDATION_CONTEXT_SIGNING_KEY_BASE64");
  });

  it("composes the executable runtime from the gate variables without singular signing-key fallback", async () => {
    const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
    expect(source).toContain("FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON");
    expect(source).toContain("FOUNDATION_CONTEXT_ACTIVE_KEY_ID");
    expect(source).not.toContain("FOUNDATION_CONTEXT_SIGNING_KEY_ID");
    expect(source).not.toContain("FOUNDATION_CONTEXT_SIGNING_KEY_BASE64");
    expect(source).toMatch(/verificationKeys:\s*(?:new Map|contextKeys\.verificationKeys)/);
    expect(source).toMatch(/activeKeyId:\s*(?:environment\.)?contextKeys\.activeKeyId/);
  });

  it("accepts active and retained-prior tokens, then rejects unknown and removed keys", () => {
    const parsed = parseFoundationWorkerRuntimeEnvironment(environment());
    const verifier = createAsyncContextReferenceCodec({
      verificationKeys: parsed.contextKeys.verificationKeys,
      activeKeyId: parsed.contextKeys.activeKeyId,
      clock: () => instant
    });
    const active = verifier.issue(claims);
    expect(verifier.verify(active.token).signingKeyId).toBe("current_key");

    const priorIssuer = createAsyncContextReferenceCodec({
      verificationKeys: new Map([["prior_key", Buffer.from(priorKey, "base64")]]),
      activeKeyId: "prior_key",
      clock: () => instant
    });
    const prior = priorIssuer.issue(claims);
    expect(verifier.verify(prior.token).signingKeyId).toBe("prior_key");

    const unknownIssuer = createAsyncContextReferenceCodec({
      verificationKeys: new Map([["unknown_key", Buffer.alloc(32, 13)]]),
      activeKeyId: "unknown_key",
      clock: () => instant
    });
    expect(() => verifier.verify(unknownIssuer.issue(claims).token)).toThrow();

    const withoutPrior = parseFoundationWorkerRuntimeEnvironment(
      environment({
        FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({ current_key: activeKey })
      })
    );
    const removedKeyVerifier = createAsyncContextReferenceCodec({
      verificationKeys: withoutPrior.contextKeys.verificationKeys,
      activeKeyId: withoutPrior.contextKeys.activeKeyId,
      clock: () => instant
    });
    expect(() => removedKeyVerifier.verify(prior.token)).toThrow();
  });

  it.each([
    [
      "malformed map",
      { FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: "not-json" },
      /verification key map.*invalid/i
    ],
    [
      "short key",
      {
        FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({
          current_key: Buffer.alloc(31, 1).toString("base64")
        })
      },
      /verification key.*invalid/i
    ],
    [
      "unknown active key",
      { FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "missing_key" },
      /active verification key.*not (?:found|present)/i
    ]
  ] as const)(
    "rejects a %s without leaking configured values",
    (_name, overrides, expectedMessage) => {
      const supplied = environment(overrides);
      let failure: unknown;
      try {
        parseFoundationWorkerRuntimeEnvironment(supplied);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const rendered = String(failure);
      expect(rendered).toMatch(expectedMessage);
      expect(rendered).not.toContain(supplied.FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON);
      expect(rendered).not.toContain(supplied.FOUNDATION_CONTEXT_ACTIVE_KEY_ID);
    }
  );
});
