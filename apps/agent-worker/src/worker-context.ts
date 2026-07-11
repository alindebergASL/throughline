import {
  createRequestTraceContext,
  toWorkerTraceEnvelope,
  withPropagatedSpan,
  type RequestTraceContext,
  type RequestTraceContextInput
} from "@throughline/observability";
import type { SecurityContext } from "@throughline/core-types";
import type { AsyncContextReferenceClaims, AsyncContextReferenceCodec } from "@throughline/tenancy";
import { parseSecurityContext } from "@throughline/tenancy";

export interface WorkerBootstrapContext extends RequestTraceContext {
  worker: "agent-worker";
}

export function createAgentWorkerContext(
  input: RequestTraceContextInput = {}
): WorkerBootstrapContext {
  const traceContext = toWorkerTraceEnvelope(createRequestTraceContext(input));
  return {
    worker: "agent-worker",
    requestId: traceContext.requestId,
    traceId: traceContext.traceId
  };
}

const MAX_BODY_BYTES = 4_096;
const MAX_REQUEST_ID_BYTES = 256;
const MAX_TRACESTATE_BYTES = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_KEY_PATTERN =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/;

export type FoundationWorkerContextErrorCode = "invalid_envelope" | "context_reference_denied";

export class FoundationWorkerContextError extends Error {
  readonly code: FoundationWorkerContextErrorCode;

  constructor(code: FoundationWorkerContextErrorCode) {
    super(code);
    this.name = "FoundationWorkerContextError";
    this.code = code;
  }
}

export interface FoundationQueueEnvelope {
  version: "v1";
  eventId: string;
  jobId: string;
  scope: {
    tenantId: string;
    workspaceId: string;
    spaceId: string;
  };
  contextReference: string;
  requestId: string;
  traceparent: string;
  tracestate?: string;
}

interface BootstrapReference {
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
  issuedAt: Date | string;
  expiresAt: Date | string;
  status: string;
  revokedAt?: Date | string | null;
  signingKeyId: string;
}

export interface RehydrateFoundationWorkerContextInput {
  body: string;
  messageAttributes?: Readonly<Record<string, unknown>>;
  codec: AsyncContextReferenceCodec;
  targetWorkerServicePrincipalId: string;
  targetPolicyVersionId: string;
  bootstrapReference: (claims: AsyncContextReferenceClaims) => Promise<BootstrapReference | null>;
  clock: () => Date;
  logger?: SafeLogger;
  signal?: AbortSignal;
}

export interface RehydratedFoundationWorkerContext {
  securityContext: SecurityContext;
  metadata: {
    eventId: string;
    jobId: string;
    contextReferenceId: string;
    requestId: string;
    traceparent: string;
    tracestate?: string;
  };
}

interface SafeLogger {
  debug: (...values: unknown[]) => void;
  info: (...values: unknown[]) => void;
  warn: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
}

export async function rehydrateFoundationWorkerContext(
  input: RehydrateFoundationWorkerContextInput
): Promise<RehydratedFoundationWorkerContext> {
  const envelope = parseEnvelope(input.body);
  assertNotAborted(input.signal);
  let claims: AsyncContextReferenceClaims;
  try {
    claims = input.codec.verify(envelope.contextReference, {
      jobId: envelope.jobId,
      tenantId: envelope.scope.tenantId,
      workspaceId: envelope.scope.workspaceId,
      spaceId: envelope.scope.spaceId,
      workerServicePrincipalId: input.targetWorkerServicePrincipalId,
      policyVersionId: input.targetPolicyVersionId
    });
  } catch {
    throw denied(input.logger);
  }

  let stored: BootstrapReference | null;
  try {
    stored = await input.bootstrapReference(claims);
  } catch {
    throw denied(input.logger);
  }
  assertNotAborted(input.signal);
  const now = input.clock();
  if (!isValidStoredReference(stored, claims, now)) {
    throw denied(input.logger);
  }

  const snapshot = parseSecurityContext(stored.contextSnapshot);
  return withPropagatedSpan(
    {
      name: "foundation.worker.receive",
      parentCarrier: {
        traceparent: envelope.traceparent,
        ...(envelope.tracestate === undefined ? {} : { tracestate: envelope.tracestate })
      },
      attributes: {
        "throughline.request.id": envelope.requestId,
        "throughline.job.id": claims.jobId,
        "throughline.tenant.id": claims.tenantId,
        "throughline.workspace.id": claims.workspaceId,
        "throughline.space.id": claims.spaceId
      }
    },
    ({ carrier }) => {
      const securityContext: SecurityContext = {
        requestId: envelope.requestId,
        traceId: carrier.traceparent.slice(3, 35),
        tenantId: claims.tenantId,
        workspaceId: claims.workspaceId,
        servicePrincipalId: claims.workerServicePrincipalId,
        delegatedByUserId: stored.delegatingUserId,
        delegatedByMembershipId: stored.delegatingMembershipId,
        requestedSpaceIds: [claims.spaceId],
        membershipIds: [],
        roleHints: [],
        dataClassCeiling: snapshot.dataClassCeiling,
        policyVersion: claims.policyVersionId,
        issuedAt: toIsoString(stored.issuedAt),
        expiresAt: toIsoString(stored.expiresAt)
      };

      const metadata = {
        eventId: envelope.eventId,
        jobId: envelope.jobId,
        requestId: envelope.requestId,
        traceparent: carrier.traceparent,
        ...(carrier.tracestate === undefined ? {} : { tracestate: carrier.tracestate })
      };
      Object.defineProperty(metadata, "contextReferenceId", {
        value: claims.referenceId,
        enumerable: false,
        writable: false
      });
      return {
        securityContext,
        metadata: metadata as RehydratedFoundationWorkerContext["metadata"]
      };
    }
  );
}

function parseEnvelope(body: string): FoundationQueueEnvelope {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new FoundationWorkerContextError("invalid_envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new FoundationWorkerContextError("invalid_envelope");
  }
  if (!isPlainRecord(parsed)) throw new FoundationWorkerContextError("invalid_envelope");
  const requiredKeys = [
    "version",
    "eventId",
    "jobId",
    "scope",
    "contextReference",
    "requestId",
    "traceparent"
  ];
  const keys = Object.keys(parsed);
  if (
    !requiredKeys.every((key) => Object.hasOwn(parsed, key)) ||
    keys.some((key) => !requiredKeys.includes(key) && key !== "tracestate") ||
    keys.length !== requiredKeys.length + (Object.hasOwn(parsed, "tracestate") ? 1 : 0) ||
    parsed.version !== "v1" ||
    !isUuid(parsed.eventId) ||
    !isUuid(parsed.jobId) ||
    !isPlainRecord(parsed.scope) ||
    !hasExactKeys(parsed.scope, ["tenantId", "workspaceId", "spaceId"]) ||
    !isUuid(parsed.scope.tenantId) ||
    !isUuid(parsed.scope.workspaceId) ||
    !isUuid(parsed.scope.spaceId) ||
    !isBoundedString(parsed.contextReference, 1, MAX_BODY_BYTES) ||
    !isBoundedString(parsed.requestId, 1, MAX_REQUEST_ID_BYTES) ||
    !isTraceparent(parsed.traceparent) ||
    (Object.hasOwn(parsed, "tracestate") && !isTracestate(parsed.tracestate))
  ) {
    throw new FoundationWorkerContextError("invalid_envelope");
  }
  return parsed as unknown as FoundationQueueEnvelope;
}

function isValidStoredReference(
  stored: BootstrapReference | null,
  claims: AsyncContextReferenceClaims,
  now: Date
): stored is BootstrapReference {
  if (!stored || !Number.isFinite(now.getTime())) return false;
  const issuedAt = toMilliseconds(stored.issuedAt);
  const expiresAt = toMilliseconds(stored.expiresAt);
  const snapshot = stored.contextSnapshot;
  let validatedSnapshot: SecurityContext;
  try {
    validatedSnapshot = parseSecurityContext(snapshot);
  } catch {
    return false;
  }
  return (
    stored.id === claims.referenceId &&
    stored.jobId === claims.jobId &&
    stored.tenantId === claims.tenantId &&
    stored.workspaceId === claims.workspaceId &&
    stored.spaceId === claims.spaceId &&
    stored.workerServicePrincipalId === claims.workerServicePrincipalId &&
    stored.policyVersionId === claims.policyVersionId &&
    stored.signingKeyId === claims.signingKeyId &&
    stored.status === "active" &&
    (stored.revokedAt === undefined || stored.revokedAt === null) &&
    isUuid(stored.delegatingUserId) &&
    isUuid(stored.delegatingMembershipId) &&
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    issuedAt === claims.issuedAt * 1_000 &&
    expiresAt === claims.expiresAt * 1_000 &&
    issuedAt <= now.getTime() &&
    expiresAt > now.getTime() &&
    validatedSnapshot.tenantId === claims.tenantId &&
    validatedSnapshot.workspaceId === claims.workspaceId &&
    validatedSnapshot.policyVersion === claims.policyVersionId &&
    validatedSnapshot.actorUserId === stored.delegatingUserId &&
    validatedSnapshot.actorMembershipId === stored.delegatingMembershipId &&
    validatedSnapshot.servicePrincipalId === undefined &&
    validatedSnapshot.agentPrincipalId === undefined &&
    validatedSnapshot.requestedSpaceIds.includes(claims.spaceId) &&
    Date.parse(validatedSnapshot.issuedAt) === issuedAt &&
    Date.parse(validatedSnapshot.expiresAt) === expiresAt &&
    ["public", "workspace", "restricted", "confidential"].includes(
      validatedSnapshot.dataClassCeiling
    )
  );
}

function denied(logger?: SafeLogger): FoundationWorkerContextError {
  logger?.warn("context_reference_denied");
  return new FoundationWorkerContextError("context_reference_denied");
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isBoundedString(value: unknown, minimum: number, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function isTraceparent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TRACEPARENT_PATTERN.exec(value);
  return Boolean(
    match && match[1] !== "00000000000000000000000000000000" && match[2] !== "0000000000000000"
  );
}

function isTracestate(value: unknown): value is string {
  if (!isBoundedString(value, 1, MAX_TRACESTATE_BYTES)) return false;
  const members = value.split(",");
  if (members.length > 32) return false;
  const keys = new Set<string>();
  return members.every((rawMember) => {
    const member = rawMember.trim();
    const separator = member.indexOf("=");
    if (separator <= 0 || separator !== member.lastIndexOf("=")) return false;
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (
      !TRACESTATE_KEY_PATTERN.test(key) ||
      keys.has(key) ||
      memberValue.length === 0 ||
      memberValue.length > 256 ||
      memberValue.endsWith(" ") ||
      !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]+$/.test(memberValue)
    ) {
      return false;
    }
    keys.add(key);
    return true;
  });
}

function toMilliseconds(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function toIsoString(value: Date | string): string {
  return new Date(toMilliseconds(value)).toISOString();
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FoundationWorkerContextError("context_reference_denied");
}
