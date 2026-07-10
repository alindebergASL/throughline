import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FoundationQueueEnvelope } from "@throughline/core-types";
import { describe, expect, it } from "vitest";
import {
  AsyncContextReferenceError,
  createAsyncContextReferenceCodec,
  generateUuidV7
} from "./async-context-reference.js";

const nowSeconds = 1_784_851_200;
const activeKey = Buffer.from("signing-material-must-stay-secret!", "utf8");
const priorKey = Buffer.from("prior-material-must-stay-secret!!", "utf8");

const ids = {
  referenceId: "70000000-0000-7000-8000-000000000031",
  jobId: "70000000-0000-7000-8000-000000000021",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "11111111-1111-4111-8111-111111111112",
  spaceId: "11111111-1111-4111-8111-111111111113",
  workerServicePrincipalId: "70000000-0000-7000-8000-000000000051",
  policyVersionId: "default-v1"
} as const;

function codec(overrides: Partial<Parameters<typeof createAsyncContextReferenceCodec>[0]> = {}) {
  return createAsyncContextReferenceCodec({
    verificationKeys: new Map([
      ["active_2026", activeKey],
      ["prior-2026", priorKey]
    ]),
    activeKeyId: "active_2026",
    clock: () => new Date(nowSeconds * 1_000),
    ...overrides
  });
}

function issue(overrides: Partial<typeof ids & { ttlSeconds: number }> = {}) {
  return codec().issue({ ...ids, ttlSeconds: 600, ...overrides });
}

function encodeRaw(payload: unknown, options: { kid?: string; key?: Uint8Array } = {}): string {
  const kid = options.kid ?? "active_2026";
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const prefix = `tlctx.v1.hs256.${kid}.${payloadSegment}`;
  const mac = createHmac("sha256", options.key ?? activeKey)
    .update(prefix, "ascii")
    .digest("base64url");
  return `${prefix}.${mac}`;
}

function payloadOf(token: string): unknown {
  return JSON.parse(Buffer.from(token.split(".")[4]!, "base64url").toString("utf8"));
}

describe("signed async context references", () => {
  it("emits the exact six-segment contract and canonical fixed-order ten-element payload", () => {
    const issued = issue();
    const segments = issued.token.split(".");

    expect(segments).toHaveLength(6);
    expect(segments.slice(0, 4)).toEqual(["tlctx", "v1", "hs256", "active_2026"]);
    expect(payloadOf(issued.token)).toEqual([
      "v1",
      ids.referenceId,
      ids.jobId,
      ids.tenantId,
      ids.workspaceId,
      ids.spaceId,
      ids.workerServicePrincipalId,
      ids.policyVersionId,
      nowSeconds,
      nowSeconds + 600
    ]);

    const canonicalJson = JSON.stringify(payloadOf(issued.token));
    expect(Buffer.from(segments[4]!, "base64url").toString("utf8")).toBe(canonicalJson);
    expect(canonicalJson).not.toMatch(/\s/);
    expect(segments[4]).not.toContain("=");
    expect(segments[5]).not.toContain("=");
  });

  it("uses HMAC-SHA-256 over the exact ASCII prefix and a 32-byte MAC", () => {
    const { token } = issue();
    const segments = token.split(".");
    const prefix = segments.slice(0, 5).join(".");
    const expectedMac = createHmac("sha256", activeKey).update(prefix, "ascii").digest();

    expect(Buffer.from(segments[5]!, "base64url")).toEqual(expectedMac);
    expect(expectedMac).toHaveLength(32);
  });

  it("uses constant-time comparison only after enforcing the exact 32-byte MAC length", async () => {
    const source = await readFile(new URL("./async-context-reference.ts", import.meta.url), "utf8");
    expect(source).toContain("suppliedMac.length !== MAC_BYTES");
    expect(source).toContain("timingSafeEqual(suppliedMac, expectedMac)");
  });

  it("copies the injected key map and supports explicit prior-key rotation", () => {
    const mutableKey = Buffer.from(priorKey);
    const keys = new Map<string, Uint8Array>([["prior-2026", mutableKey]]);
    const priorCodec = createAsyncContextReferenceCodec({
      verificationKeys: keys,
      activeKeyId: "prior-2026",
      clock: () => new Date(nowSeconds * 1_000)
    });
    const token = priorCodec.issue({ ...ids, ttlSeconds: 600 }).token;

    mutableKey.fill(0);
    keys.delete("prior-2026");
    expect(priorCodec.verify(token)).toMatchObject(ids);
    expect(codec().verify(token)).toMatchObject(ids);
    expect(() =>
      codec({ verificationKeys: new Map([["active_2026", activeKey]]) }).verify(token)
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_KEY" }));
  });

  it.each([
    ["empty map", new Map<string, Uint8Array>(), "active_2026"],
    ["unknown active key", new Map([["known", activeKey]]), "missing"],
    ["short key", new Map([["active_2026", Buffer.alloc(31)]]), "active_2026"],
    ["invalid configured kid", new Map([["bad.key", activeKey]]), "bad.key"],
    ["long configured kid", new Map([["x".repeat(33), activeKey]]), "x".repeat(33)]
  ])("rejects %s configuration", (_case, verificationKeys, activeKeyId) => {
    expect(() =>
      createAsyncContextReferenceCodec({
        verificationKeys,
        activeKeyId,
        clock: () => new Date(nowSeconds * 1_000)
      })
    ).toThrow(AsyncContextReferenceError);
  });

  it("generates application-owned UUIDv7 reference and job claims with an injected source", () => {
    const generated = [
      "70000000-0000-7000-8000-000000000071",
      "70000000-0000-7000-8000-000000000072"
    ];
    const generatedCodec = codec({ uuidV7: () => generated.shift()! });
    const issued = generatedCodec.issue({
      tenantId: ids.tenantId,
      workspaceId: ids.workspaceId,
      spaceId: ids.spaceId,
      workerServicePrincipalId: ids.workerServicePrincipalId,
      policyVersionId: ids.policyVersionId,
      ttlSeconds: 600
    });

    expect(issued.claims.referenceId).toBe("70000000-0000-7000-8000-000000000071");
    expect(issued.claims.jobId).toBe("70000000-0000-7000-8000-000000000072");
    expect(generateUuidV7(new Date(nowSeconds * 1_000))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["over ceiling", 901],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY]
  ])("rejects a %s token TTL", (_case, ttlSeconds) => {
    expect(() => issue({ ttlSeconds })).toThrowError(
      expect.objectContaining({ code: "INVALID_LIFETIME" })
    );
  });

  it("accepts exactly 900 seconds and rejects expiry with no grace", () => {
    const issued = issue({ ttlSeconds: 900 });
    expect(codec().verify(issued.token).expiresAt).toBe(nowSeconds + 900);
    expect(() =>
      codec({ clock: () => new Date((nowSeconds + 900) * 1_000) }).verify(issued.token)
    ).toThrowError(expect.objectContaining({ code: "EXPIRED" }));
  });

  it("allows issued-at at most 30 seconds in the future", () => {
    const payload = [
      "v1",
      ids.referenceId,
      ids.jobId,
      ids.tenantId,
      ids.workspaceId,
      ids.spaceId,
      ids.workerServicePrincipalId,
      ids.policyVersionId,
      nowSeconds + 30,
      nowSeconds + 31
    ];
    expect(codec().verify(encodeRaw(payload)).issuedAt).toBe(nowSeconds + 30);
    payload[8] = nowSeconds + 31;
    payload[9] = nowSeconds + 32;
    expect(() => codec().verify(encodeRaw(payload))).toThrowError(
      expect.objectContaining({ code: "ISSUED_IN_FUTURE" })
    );
  });

  it.each([
    ["too many", "tlctx.v1.hs256.active_2026.a.b.extra"],
    ["too few", "tlctx.v1.hs256.active_2026.a"],
    ["format", "other.v1.hs256.active_2026.a.b"],
    ["version", "tlctx.v2.hs256.active_2026.a.b"],
    ["algorithm", "tlctx.v1.none.active_2026.a.b"],
    ["empty kid", "tlctx.v1.hs256..a.b"],
    ["kid punctuation", "tlctx.v1.hs256.bad$key.a.b"],
    ["kid too long", `tlctx.v1.hs256.${"x".repeat(33)}.a.b`]
  ])("rejects malformed %s segments", (_case, token) => {
    expect(() => codec().verify(token)).toThrow(AsyncContextReferenceError);
  });

  it("rejects unknown and removed key IDs", () => {
    const token = issue().token.replace(".active_2026.", ".removed-key.");
    expect(() => codec().verify(token)).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_KEY" })
    );
  });

  it("caps the complete token at 2 KiB before decoding and decoded payload at 1 KiB", () => {
    expect(() => codec().verify("x".repeat(2_049))).toThrowError(
      expect.objectContaining({ code: "TOKEN_TOO_LARGE" })
    );

    const oversizedPayload = [
      "v1",
      ids.referenceId,
      ids.jobId,
      ids.tenantId,
      ids.workspaceId,
      ids.spaceId,
      ids.workerServicePrincipalId,
      "p".repeat(820),
      nowSeconds,
      nowSeconds + 1
    ];
    const token = encodeRaw(oversizedPayload);
    expect(token.length).toBeLessThanOrEqual(2_048);
    expect(() => codec().verify(token)).toThrowError(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" })
    );
  });

  it.each([
    ["non-json", "eA"],
    ["padded base64url", Buffer.from("[]").toString("base64url") + "="],
    ["standard base64", "+w"],
    ["empty payload", ""],
    ["empty mac", ""],
    ["short mac", Buffer.alloc(31).toString("base64url")],
    ["long mac", Buffer.alloc(33).toString("base64url")],
    ["padded mac", Buffer.alloc(32).toString("base64url") + "="]
  ])("rejects malformed %s encoding", (_case, segment) => {
    const valid = issue().token.split(".");
    if (_case.includes("mac")) valid[5] = segment;
    else valid[4] = segment;
    expect(() => codec().verify(valid.join("."))).toThrow(AsyncContextReferenceError);
  });

  it.each([
    ["not an array", { value: "v1" }],
    ["missing item", ["v1", ids.referenceId]],
    [
      "extra item",
      [
        "v1",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        nowSeconds,
        nowSeconds + 1,
        "extra"
      ]
    ],
    [
      "payload version",
      [
        "v2",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        nowSeconds,
        nowSeconds + 1
      ]
    ],
    [
      "wrong type",
      [
        "v1",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        String(nowSeconds),
        nowSeconds + 1
      ]
    ],
    [
      "non-integer timestamp",
      [
        "v1",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        nowSeconds + 0.5,
        nowSeconds + 1
      ]
    ],
    [
      "invalid UUID",
      [
        "v1",
        "not-a-uuid",
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        nowSeconds,
        nowSeconds + 1
      ]
    ],
    [
      "non-v7 reference",
      [
        "v1",
        ids.tenantId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        nowSeconds,
        nowSeconds + 1
      ]
    ],
    [
      "empty policy",
      [
        "v1",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        "",
        nowSeconds,
        nowSeconds + 1
      ]
    ],
    [
      "non-positive timestamp",
      [
        "v1",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        0,
        1
      ]
    ],
    [
      "expiry before issue",
      [
        "v1",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        nowSeconds,
        nowSeconds - 1
      ]
    ],
    [
      "overlong lifetime",
      [
        "v1",
        ids.referenceId,
        ids.jobId,
        ids.tenantId,
        ids.workspaceId,
        ids.spaceId,
        ids.workerServicePrincipalId,
        ids.policyVersionId,
        nowSeconds,
        nowSeconds + 901
      ]
    ]
  ])("rejects malformed payload: %s", (_case, payload) => {
    expect(() => codec().verify(encodeRaw(payload))).toThrow(AsyncContextReferenceError);
  });

  it("rejects forged MACs and exact scope/job/worker/policy mismatches", () => {
    const issued = issue();
    const forged = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;
    expect(() => codec().verify(forged)).toThrowError(
      expect.objectContaining({ code: "INVALID_MAC" })
    );

    for (const [field, value] of [
      ["tenantId", "22222222-2222-4222-8222-222222222222"],
      ["workspaceId", "22222222-2222-4222-8222-222222222223"],
      ["spaceId", "22222222-2222-4222-8222-222222222224"],
      ["jobId", "70000000-0000-7000-8000-000000000022"],
      ["workerServicePrincipalId", "70000000-0000-7000-8000-000000000052"],
      ["policyVersionId", "other-v1"]
    ] as const) {
      expect(() => codec().verify(issued.token, { ...ids, [field]: value })).toThrowError(
        expect.objectContaining({ code: "BINDING_MISMATCH" })
      );
    }
  });

  it("does not expose token, SecurityContext, or key material in failures", () => {
    const { token } = issue();
    const secret = activeKey.toString("utf8");
    let error: unknown;
    try {
      codec().verify(`${token.slice(0, -1)}A`);
    } catch (caught) {
      error = caught;
    }
    const rendered = JSON.stringify(error);
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("requestedSpaceIds");
    expect(rendered).not.toContain("roleHints");
  });

  it("keeps queue/log/trace-facing values free of SecurityContext bodies and signing material", () => {
    const issued = issue();
    const envelope: FoundationQueueEnvelope = {
      version: "v1",
      eventId: "70000000-0000-7000-8000-000000000011",
      jobId: issued.claims.jobId,
      scope: {
        tenantId: issued.claims.tenantId,
        workspaceId: issued.claims.workspaceId,
        spaceId: issued.claims.spaceId
      },
      contextReference: issued.token,
      requestId: "request-safe",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
    };
    const rendered = JSON.stringify({ envelope, claims: issued.claims });

    expect(rendered).not.toContain(activeKey.toString("utf8"));
    expect(rendered).not.toContain("actorUserId");
    expect(rendered).not.toContain("actorMembershipId");
    expect(rendered).not.toContain("requestedSpaceIds");
    expect(rendered).not.toContain("membershipIds");
    expect(rendered).not.toContain("roleHints");
    expect(Object.keys(issued.claims)).toEqual([
      "referenceId",
      "jobId",
      "tenantId",
      "workspaceId",
      "spaceId",
      "workerServicePrincipalId",
      "policyVersionId",
      "issuedAt",
      "expiresAt",
      "signingKeyId"
    ]);
  });
});
