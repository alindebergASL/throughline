import { randomBytes } from "node:crypto";
import type { SecurityContext } from "../../../packages/core-types/src/index.js";
import {
  createAsyncContextReferenceCodec,
  type AsyncContextReferenceClaims,
  type AsyncContextReferenceCodec
} from "../../../packages/tenancy/src/async-context-reference.js";
import { describe, expect, it, vi } from "vitest";
import { createAgentWorkerContext } from "./worker-context.js";

describe("createAgentWorkerContext", () => {
  it("preserves request and trace identifiers from the API boundary", () => {
    expect(
      createAgentWorkerContext({
        requestId: "req_from_api",
        traceId: "trace_from_api"
      })
    ).toEqual({
      worker: "agent-worker",
      requestId: "req_from_api",
      traceId: "trace_from_api"
    });
  });

  it("generates request and trace identifiers when no input is provided", () => {
    const context = createAgentWorkerContext();

    expect(context.worker).toBe("agent-worker");
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

type BootstrapReference = {
  id: string;
  jobId: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  workerServicePrincipalId: string;
  delegatingUserId: string;
  delegatingMembershipId: string;
  policyVersionId: string;
  contextSnapshot: SecurityContext;
  issuedAt: string;
  expiresAt: string;
  status: string;
  revokedAt: string | null;
  signingKeyId: string;
};

type RehydrateInput = {
  body: string;
  messageAttributes?: Readonly<Record<string, unknown>>;
  codec: AsyncContextReferenceCodec;
  targetWorkerServicePrincipalId: string;
  targetPolicyVersionId: string;
  bootstrapReference: (claims: AsyncContextReferenceClaims) => Promise<BootstrapReference | null>;
  clock: () => Date;
  logger?: {
    debug: (...values: unknown[]) => void;
    info: (...values: unknown[]) => void;
    warn: (...values: unknown[]) => void;
    error: (...values: unknown[]) => void;
  };
};

type RehydrateResult = {
  securityContext: SecurityContext;
  metadata: {
    eventId: string;
    jobId: string;
    requestId: string;
    traceparent: string;
    tracestate?: string;
  };
};

async function rehydrate(input: RehydrateInput): Promise<RehydrateResult> {
  const modulePath = "./worker-context.js";
  const loaded = (await import(modulePath)) as {
    rehydrateFoundationWorkerContext?: (value: RehydrateInput) => Promise<RehydrateResult>;
  };
  if (typeof loaded.rehydrateFoundationWorkerContext !== "function") {
    throw new Error("Task 7 requires rehydrateFoundationWorkerContext");
  }
  return loaded.rehydrateFoundationWorkerContext(input);
}

const instant = new Date("2026-07-10T20:00:00.000Z");
const signingKey = randomBytes(32);
const otherKey = randomBytes(32);
const ids = {
  event: "70000000-0000-7000-8000-000000000011",
  job: "70000000-0000-7000-8000-000000000021",
  reference: "70000000-0000-7000-8000-000000000031",
  tenant: "11111111-1111-4111-8111-111111111111",
  workspace: "11111111-1111-4111-8111-111111111112",
  space: "11111111-1111-4111-8111-111111111113",
  otherTenant: "22222222-2222-4222-8222-222222222221",
  otherWorkspace: "22222222-2222-4222-8222-222222222222",
  otherSpace: "22222222-2222-4222-8222-222222222223",
  worker: "70000000-0000-7000-8000-000000000051",
  otherWorker: "70000000-0000-7000-8000-000000000052",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  membership: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"
} as const;

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function codec(options: { clock?: () => Date; keyId?: string; key?: Uint8Array } = {}) {
  const keyId = options.keyId ?? "task7-key";
  return createAsyncContextReferenceCodec({
    verificationKeys: new Map([[keyId, options.key ?? signingKey]]),
    activeKeyId: keyId,
    clock: options.clock ?? (() => instant)
  });
}

function issuedToken(
  signer = codec(),
  overrides: Partial<{
    referenceId: string;
    jobId: string;
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    workerServicePrincipalId: string;
    policyVersionId: string;
    ttlSeconds: number;
  }> = {}
) {
  return signer.issue({
    referenceId: ids.reference,
    jobId: ids.job,
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    spaceId: ids.space,
    workerServicePrincipalId: ids.worker,
    policyVersionId: "default-v1",
    ttlSeconds: 600,
    ...overrides
  });
}

function envelope(contextReference = issuedToken().token, overrides: Record<string, unknown> = {}) {
  return {
    version: "v1",
    eventId: ids.event,
    jobId: ids.job,
    scope: {
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space
    },
    contextReference,
    requestId: "request-from-queue",
    traceparent,
    tracestate: "vendor=value",
    ...overrides
  };
}

function snapshot(overrides: Partial<SecurityContext> = {}): SecurityContext {
  return {
    requestId: "persisted-request",
    traceId: "persisted-trace",
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    actorUserId: ids.user,
    actorMembershipId: ids.membership,
    requestedSpaceIds: [ids.space],
    membershipIds: [ids.membership],
    roleHints: ["member"],
    dataClassCeiling: "restricted",
    policyVersion: "default-v1",
    issuedAt: instant.toISOString(),
    expiresAt: new Date(instant.getTime() + 600_000).toISOString(),
    ...overrides
  };
}

function reference(overrides: Partial<BootstrapReference> = {}): BootstrapReference {
  return {
    id: ids.reference,
    jobId: ids.job,
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    spaceId: ids.space,
    workerServicePrincipalId: ids.worker,
    delegatingUserId: ids.user,
    delegatingMembershipId: ids.membership,
    policyVersionId: "default-v1",
    contextSnapshot: snapshot(),
    issuedAt: instant.toISOString(),
    expiresAt: new Date(instant.getTime() + 600_000).toISOString(),
    status: "active",
    revokedAt: null,
    signingKeyId: "task7-key",
    ...overrides
  };
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function input(overrides: Partial<RehydrateInput> = {}): RehydrateInput {
  return {
    body: JSON.stringify(envelope()),
    codec: codec(),
    targetWorkerServicePrincipalId: ids.worker,
    targetPolicyVersionId: "default-v1",
    bootstrapReference: vi.fn(async () => reference()),
    clock: () => instant,
    logger: logger(),
    ...overrides
  };
}

describe("Foundation worker context rehydration RED contract", () => {
  it("uses the real AsyncContextReferenceCodec and verifies before bootstrap access", async () => {
    const order: string[] = [];
    const realCodec = codec();
    const verify = vi.fn<AsyncContextReferenceCodec["verify"]>((...args) => {
      order.push("verify");
      return realCodec.verify(...args);
    });
    const observableCodec: AsyncContextReferenceCodec = {
      issue: (...args) => realCodec.issue(...args),
      verify
    };
    const bootstrapReference = vi.fn(async () => {
      order.push("bootstrap");
      return reference();
    });

    await expect(
      rehydrate(input({ codec: observableCodec, bootstrapReference }))
    ).resolves.toMatchObject({
      securityContext: {
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
        servicePrincipalId: ids.worker,
        delegatedByUserId: ids.user,
        delegatedByMembershipId: ids.membership,
        requestedSpaceIds: [ids.space],
        policyVersion: "default-v1"
      }
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(order).toEqual(["verify", "bootstrap"]);
  });

  it.each([
    ["extra key", { ...envelope(), authority: "owner" }],
    [
      "missing key",
      (() => {
        const value: Partial<ReturnType<typeof envelope>> = { ...envelope() };
        delete value.requestId;
        return value;
      })()
    ],
    ["unknown version", { ...envelope(), version: "v2" }],
    ["non-string event", { ...envelope(), eventId: 7 }],
    ["non-string token", { ...envelope(), contextReference: [] }],
    ["wrong scope shape", { ...envelope(), scope: { ...envelope().scope, extra: true } }],
    ["invalid traceparent", { ...envelope(), traceparent: "trace-from-user" }],
    [
      "zero W3C trace identifier",
      { ...envelope(), traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" }
    ],
    ["invalid tracestate type", { ...envelope(), tracestate: 7 }],
    ["invalid W3C tracestate grammar", { ...envelope(), tracestate: "vendor value" }]
  ])("rejects an envelope with %s before bootstrap", async (_case, value) => {
    const bootstrapReference = vi.fn();
    await expect(
      rehydrate(input({ body: JSON.stringify(value), bootstrapReference }))
    ).rejects.toMatchObject({ code: "invalid_envelope" });
    expect(bootstrapReference).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-object JSON", "[]"],
    ["oversized body", JSON.stringify({ ...envelope(), requestId: "x".repeat(4_097) })]
  ])("rejects %s within a bounded parse surface", async (_case, body) => {
    const bootstrapReference = vi.fn();
    await expect(rehydrate(input({ body, bootstrapReference }))).rejects.toMatchObject({
      code: "invalid_envelope"
    });
    expect(bootstrapReference).not.toHaveBeenCalled();
  });

  it.each(["forged", "unknown-key", "expired", "oversized"] as const)(
    "denies a %s real token before bootstrap access",
    async (kind) => {
      let now = instant;
      const verifier = codec({ clock: () => now });
      let token = issuedToken(verifier, { ttlSeconds: 1 }).token;
      if (kind === "forged") token = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      if (kind === "unknown-key") {
        token = issuedToken(codec({ keyId: "removed-key", key: otherKey })).token;
      }
      if (kind === "expired") now = new Date(instant.getTime() + 1_000);
      if (kind === "oversized") token = "x".repeat(2_049);
      const bootstrapReference = vi.fn();

      await expect(
        rehydrate(
          input({
            body: JSON.stringify(envelope(token)),
            codec: verifier,
            bootstrapReference,
            clock: () => now
          })
        )
      ).rejects.toMatchObject({ code: "context_reference_denied" });
      expect(bootstrapReference).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["job", { jobId: "70000000-0000-7000-8000-000000000022" }],
    ["tenant", { scope: { ...envelope().scope, tenantId: ids.otherTenant } }],
    ["workspace", { scope: { ...envelope().scope, workspaceId: ids.otherWorkspace } }],
    ["Space", { scope: { ...envelope().scope, spaceId: ids.otherSpace } }]
  ])("binds the signature to the exact envelope %s", async (_case, override) => {
    const bootstrapReference = vi.fn();
    await expect(
      rehydrate(
        input({ body: JSON.stringify(envelope(issuedToken().token, override)), bootstrapReference })
      )
    ).rejects.toMatchObject({ code: "context_reference_denied" });
    expect(bootstrapReference).not.toHaveBeenCalled();
  });

  it.each([
    ["target worker", { targetWorkerServicePrincipalId: ids.otherWorker }],
    ["target policy", { targetPolicyVersionId: "retired-v1" }]
  ])("binds the signed token to the injected %s", async (_case, override) => {
    const bootstrapReference = vi.fn();
    await expect(rehydrate(input({ ...override, bootstrapReference }))).rejects.toMatchObject({
      code: "context_reference_denied"
    });
    expect(bootstrapReference).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown reference", null],
    ["wrong reference", reference({ id: "70000000-0000-7000-8000-000000000032" })],
    ["wrong job", reference({ jobId: "70000000-0000-7000-8000-000000000022" })],
    ["cross-tenant", reference({ tenantId: ids.otherTenant })],
    ["cross-workspace", reference({ workspaceId: ids.otherWorkspace })],
    ["cross-Space", reference({ spaceId: ids.otherSpace })],
    ["wrong worker", reference({ workerServicePrincipalId: ids.otherWorker })],
    ["wrong policy", reference({ policyVersionId: "retired-v1" })],
    ["revoked status", reference({ status: "revoked" })],
    ["revocation timestamp", reference({ revokedAt: instant.toISOString() })],
    ["expired row", reference({ expiresAt: instant.toISOString() })],
    ["wrong signing key", reference({ signingKeyId: "removed-key" })],
    [
      "snapshot tenant mismatch",
      reference({ contextSnapshot: snapshot({ tenantId: ids.otherTenant }) })
    ],
    [
      "snapshot workspace mismatch",
      reference({ contextSnapshot: snapshot({ workspaceId: ids.otherWorkspace }) })
    ],
    [
      "snapshot target-Space mismatch",
      reference({ contextSnapshot: snapshot({ requestedSpaceIds: [ids.otherSpace] }) })
    ],
    [
      "snapshot policy mismatch",
      reference({ contextSnapshot: snapshot({ policyVersion: "retired-v1" }) })
    ]
  ])("denies a bootstrap result with %s", async (_case, stored) => {
    await expect(
      rehydrate(input({ bootstrapReference: vi.fn(async () => stored) }))
    ).rejects.toMatchObject({ code: "context_reference_denied" });
  });

  it("accepts broader snapshot Space hints only when they contain the signed Space, then reconstructs the exact signed Space", async () => {
    const unsafeSnapshot = snapshot({
      roleHints: ["owner", "system"],
      membershipIds: [ids.membership, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5"],
      requestedSpaceIds: [ids.space, ids.otherSpace]
    });

    const result = await rehydrate(
      input({
        bootstrapReference: vi.fn(async () => reference({ contextSnapshot: unsafeSnapshot }))
      })
    );

    expect(result.securityContext.roleHints).toEqual([]);
    expect(result.securityContext.membershipIds).toEqual([]);
    expect(result.securityContext.requestedSpaceIds).toEqual([ids.space]);
    expect(result.securityContext).not.toHaveProperty("actorUserId");
    expect(result.securityContext).not.toHaveProperty("actorMembershipId");
  });

  it("preserves the validated persisted dataClassCeiling and never broadens it to confidential", async () => {
    const result = await rehydrate(
      input({
        bootstrapReference: vi.fn(async () =>
          reference({ contextSnapshot: snapshot({ dataClassCeiling: "workspace" }) })
        )
      })
    );

    expect(result.securityContext.dataClassCeiling).toBe("workspace");
    expect(result.securityContext.dataClassCeiling).not.toBe("confidential");
  });

  it("keeps queue request/trace metadata out of authority construction", async () => {
    const result = await rehydrate(
      input({
        messageAttributes: {
          eventId: "untrusted-event-metadata",
          requestId: "untrusted-request-metadata",
          traceparent: "untrusted-trace-metadata",
          workerServicePrincipalId: ids.otherWorker,
          roleHints: ["owner"],
          dataClassCeiling: "confidential"
        }
      })
    );

    expect(result.metadata).toEqual({
      eventId: ids.event,
      jobId: ids.job,
      requestId: "request-from-queue",
      traceparent,
      tracestate: "vendor=value"
    });
    expect(result.securityContext).toMatchObject({
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      servicePrincipalId: ids.worker,
      requestedSpaceIds: [ids.space],
      dataClassCeiling: "restricted"
    });
  });

  it("returns and logs only safe denial data without the raw token or SecurityContext", async () => {
    const unsafeRole = "RAW_SECURITY_CONTEXT_MARKER";
    const rawToken = issuedToken().token;
    const capturedLogger = logger();
    let error: unknown;
    try {
      await rehydrate(
        input({
          body: JSON.stringify(envelope(rawToken)),
          bootstrapReference: vi.fn(async () =>
            reference({
              status: "revoked",
              contextSnapshot: snapshot({ roleHints: [unsafeRole] })
            })
          ),
          logger: capturedLogger
        })
      );
    } catch (caught) {
      error = caught;
    }

    const renderedError = `${String(error)} ${JSON.stringify(error)}`;
    const renderedLogs = JSON.stringify(
      Object.values(capturedLogger).flatMap((entry) => entry.mock.calls)
    );
    expect(renderedError).toContain("context_reference_denied");
    expect(renderedError).not.toContain(rawToken);
    expect(renderedError).not.toContain(unsafeRole);
    expect(renderedError).not.toMatch(/roleHints|membershipIds|requestedSpaceIds/);
    expect(renderedLogs).not.toContain(rawToken);
    expect(renderedLogs).not.toContain(unsafeRole);
    expect(renderedLogs).not.toMatch(/roleHints|membershipIds|requestedSpaceIds/);
  });
});
