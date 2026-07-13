import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "tlctx.v1.hs256";
const TOKEN_MAX_BYTES = 2 * 1_024;
const PAYLOAD_MAX_BYTES = 1_024;
const MAC_BYTES = 32;
const MINIMUM_KEY_BYTES = 32;
const MAXIMUM_TTL_SECONDS = 900;
const MAXIMUM_FUTURE_ISSUED_AT_SECONDS = 30;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type AsyncContextReferenceErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_CLAIMS"
  | "INVALID_LIFETIME"
  | "TOKEN_TOO_LARGE"
  | "MALFORMED_TOKEN"
  | "UNKNOWN_KEY"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_MAC"
  | "ISSUED_IN_FUTURE"
  | "EXPIRED"
  | "BINDING_MISMATCH";

export class AsyncContextReferenceError extends Error {
  readonly code: AsyncContextReferenceErrorCode;

  constructor(code: AsyncContextReferenceErrorCode) {
    super(safeMessage(code));
    this.name = "AsyncContextReferenceError";
    this.code = code;
  }
}

export interface AsyncContextReferenceBindings {
  referenceId: string;
  jobId: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  workerServicePrincipalId: string;
  policyVersionId: string;
}

export interface AsyncContextReferenceClaims extends AsyncContextReferenceBindings {
  issuedAt: number;
  expiresAt: number;
  signingKeyId: string;
}

export interface IssueAsyncContextReferenceInput extends Omit<
  AsyncContextReferenceBindings,
  "referenceId" | "jobId"
> {
  referenceId?: string;
  jobId?: string;
  ttlSeconds: number;
}

export type ExpectedAsyncContextReferenceBindings = Partial<AsyncContextReferenceBindings>;

export interface AsyncContextReferenceCodec {
  issue(input: IssueAsyncContextReferenceInput): {
    token: string;
    claims: AsyncContextReferenceClaims;
  };
  verify(
    token: string,
    expected?: ExpectedAsyncContextReferenceBindings
  ): AsyncContextReferenceClaims;
}

export interface AsyncContextReferenceCodecOptions {
  verificationKeys: ReadonlyMap<string, Uint8Array>;
  activeKeyId: string;
  clock: () => Date;
  uuidV7?: () => string;
}

export function createAsyncContextReferenceCodec(
  options: AsyncContextReferenceCodecOptions
): AsyncContextReferenceCodec {
  const keys = copyAndValidateKeys(options.verificationKeys, options.activeKeyId);
  const activeKeyId = options.activeKeyId;
  const clock = options.clock;
  const uuidV7 = options.uuidV7 ?? (() => generateUuidV7(clock()));

  return Object.freeze({
    issue(input: IssueAsyncContextReferenceInput) {
      const now = unixSeconds(clock());
      validateTtl(input.ttlSeconds);
      const bindings: AsyncContextReferenceBindings = {
        referenceId: input.referenceId ?? uuidV7(),
        jobId: input.jobId ?? uuidV7(),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        workerServicePrincipalId: input.workerServicePrincipalId,
        policyVersionId: input.policyVersionId
      };
      validateBindings(bindings);
      const claims: AsyncContextReferenceClaims = Object.freeze({
        ...bindings,
        issuedAt: now,
        expiresAt: now + input.ttlSeconds,
        signingKeyId: activeKeyId
      });
      const payload = serializePayload(claims);
      const prefix = `${TOKEN_PREFIX}.${activeKeyId}.${payload}`;
      const mac = createHmac("sha256", keys.get(activeKeyId)!)
        .update(prefix, "ascii")
        .digest("base64url");

      return Object.freeze({ token: `${prefix}.${mac}`, claims });
    },

    verify(token: string, expected: ExpectedAsyncContextReferenceBindings = {}) {
      if (typeof token !== "string") throw new AsyncContextReferenceError("MALFORMED_TOKEN");
      if (Buffer.byteLength(token, "utf8") > TOKEN_MAX_BYTES) {
        throw new AsyncContextReferenceError("TOKEN_TOO_LARGE");
      }

      const segments = token.split(".");
      if (
        segments.length !== 6 ||
        segments[0] !== "tlctx" ||
        segments[1] !== "v1" ||
        segments[2] !== "hs256"
      ) {
        throw new AsyncContextReferenceError("MALFORMED_TOKEN");
      }
      const kid = segments[3]!;
      if (!KID_PATTERN.test(kid)) throw new AsyncContextReferenceError("MALFORMED_TOKEN");
      const key = keys.get(kid);
      if (!key) throw new AsyncContextReferenceError("UNKNOWN_KEY");

      const payloadSegment = segments[4]!;
      const macSegment = segments[5]!;
      const payloadBytes = decodeCanonicalBase64url(payloadSegment, "payload");
      if (payloadBytes.length > PAYLOAD_MAX_BYTES) {
        throw new AsyncContextReferenceError("PAYLOAD_TOO_LARGE");
      }
      const suppliedMac = decodeCanonicalBase64url(macSegment, "mac");
      if (suppliedMac.length !== MAC_BYTES) {
        throw new AsyncContextReferenceError("MALFORMED_TOKEN");
      }

      const prefix = segments.slice(0, 5).join(".");
      const expectedMac = createHmac("sha256", key).update(prefix, "ascii").digest();
      if (!timingSafeEqual(suppliedMac, expectedMac)) {
        throw new AsyncContextReferenceError("INVALID_MAC");
      }

      const parsed = parseCanonicalPayload(payloadBytes);
      const claims = payloadToClaims(parsed, kid);
      const now = unixSeconds(clock());
      if (claims.issuedAt > now + MAXIMUM_FUTURE_ISSUED_AT_SECONDS) {
        throw new AsyncContextReferenceError("ISSUED_IN_FUTURE");
      }
      if (now >= claims.expiresAt) throw new AsyncContextReferenceError("EXPIRED");
      assertExpectedBindings(claims, expected);
      return claims;
    }
  });
}

export function generateUuidV7(now = new Date()): string {
  const milliseconds = now.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
    throw new AsyncContextReferenceError("INVALID_CLAIMS");
  }
  const bytes = Buffer.allocUnsafe(16);
  let remaining = milliseconds;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  const entropy = randomBytes(10);
  bytes[6] = 0x70 | (entropy[0]! & 0x0f);
  bytes[7] = entropy[1]!;
  bytes[8] = 0x80 | (entropy[2]! & 0x3f);
  entropy.copy(bytes, 9, 3, 10);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function copyAndValidateKeys(
  source: ReadonlyMap<string, Uint8Array>,
  activeKeyId: string
): ReadonlyMap<string, Buffer> {
  if (!(source instanceof Map) || source.size === 0 || !KID_PATTERN.test(activeKeyId)) {
    throw new AsyncContextReferenceError("INVALID_CONFIGURATION");
  }
  const copy = new Map<string, Buffer>();
  for (const [kid, material] of source) {
    if (!KID_PATTERN.test(kid) || !(material instanceof Uint8Array)) {
      throw new AsyncContextReferenceError("INVALID_CONFIGURATION");
    }
    const key = Buffer.from(material);
    if (key.length < MINIMUM_KEY_BYTES) {
      throw new AsyncContextReferenceError("INVALID_CONFIGURATION");
    }
    copy.set(kid, key);
  }
  if (!copy.has(activeKeyId)) throw new AsyncContextReferenceError("INVALID_CONFIGURATION");
  return copy;
}

function serializePayload(claims: AsyncContextReferenceClaims): string {
  const json = JSON.stringify([
    "v1",
    claims.referenceId,
    claims.jobId,
    claims.tenantId,
    claims.workspaceId,
    claims.spaceId,
    claims.workerServicePrincipalId,
    claims.policyVersionId,
    claims.issuedAt,
    claims.expiresAt
  ]);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length > PAYLOAD_MAX_BYTES) {
    throw new AsyncContextReferenceError("PAYLOAD_TOO_LARGE");
  }
  return bytes.toString("base64url");
}

function decodeCanonicalBase64url(value: string, kind: "payload" | "mac"): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw new AsyncContextReferenceError("MALFORMED_TOKEN");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new AsyncContextReferenceError("MALFORMED_TOKEN");
  }
  if (kind === "payload" && decoded.length > PAYLOAD_MAX_BYTES) {
    throw new AsyncContextReferenceError("PAYLOAD_TOO_LARGE");
  }
  return decoded;
}

function parseCanonicalPayload(bytes: Buffer): unknown {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new AsyncContextReferenceError("MALFORMED_TOKEN");
  }
  if (JSON.stringify(parsed) !== text) throw new AsyncContextReferenceError("MALFORMED_TOKEN");
  return parsed;
}

function payloadToClaims(payload: unknown, kid: string): AsyncContextReferenceClaims {
  if (!Array.isArray(payload) || payload.length !== 10) {
    throw new AsyncContextReferenceError("INVALID_CLAIMS");
  }
  const [
    version,
    referenceId,
    jobId,
    tenantId,
    workspaceId,
    spaceId,
    workerId,
    policyId,
    iat,
    exp
  ] = payload;
  if (
    version !== "v1" ||
    typeof referenceId !== "string" ||
    typeof jobId !== "string" ||
    typeof tenantId !== "string" ||
    typeof workspaceId !== "string" ||
    typeof spaceId !== "string" ||
    typeof workerId !== "string" ||
    typeof policyId !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    throw new AsyncContextReferenceError("INVALID_CLAIMS");
  }
  const bindings = {
    referenceId,
    jobId,
    tenantId,
    workspaceId,
    spaceId,
    workerServicePrincipalId: workerId,
    policyVersionId: policyId
  };
  validateBindings(bindings);
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || iat <= 0 || exp <= 0) {
    throw new AsyncContextReferenceError("INVALID_CLAIMS");
  }
  validateTtl(exp - iat);
  return Object.freeze({ ...bindings, issuedAt: iat, expiresAt: exp, signingKeyId: kid });
}

function validateBindings(bindings: AsyncContextReferenceBindings): void {
  if (
    !UUID_V7_PATTERN.test(bindings.referenceId) ||
    !UUID_V7_PATTERN.test(bindings.jobId) ||
    !UUID_PATTERN.test(bindings.tenantId) ||
    !UUID_PATTERN.test(bindings.workspaceId) ||
    !UUID_PATTERN.test(bindings.spaceId) ||
    !UUID_PATTERN.test(bindings.workerServicePrincipalId) ||
    !POLICY_VERSION_PATTERN.test(bindings.policyVersionId)
  ) {
    throw new AsyncContextReferenceError("INVALID_CLAIMS");
  }
}

function validateTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAXIMUM_TTL_SECONDS) {
    throw new AsyncContextReferenceError("INVALID_LIFETIME");
  }
}

function assertExpectedBindings(
  claims: AsyncContextReferenceClaims,
  expected: ExpectedAsyncContextReferenceBindings
): void {
  for (const field of [
    "referenceId",
    "jobId",
    "tenantId",
    "workspaceId",
    "spaceId",
    "workerServicePrincipalId",
    "policyVersionId"
  ] as const) {
    if (expected[field] !== undefined && expected[field] !== claims[field]) {
      throw new AsyncContextReferenceError("BINDING_MISMATCH");
    }
  }
}

function unixSeconds(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new AsyncContextReferenceError("INVALID_CONFIGURATION");
  return Math.floor(milliseconds / 1_000);
}

function safeMessage(code: AsyncContextReferenceErrorCode): string {
  switch (code) {
    case "INVALID_CONFIGURATION":
      return "Invalid async context reference configuration";
    case "TOKEN_TOO_LARGE":
      return "Async context reference exceeds the size limit";
    case "PAYLOAD_TOO_LARGE":
      return "Async context reference payload exceeds the size limit";
    case "UNKNOWN_KEY":
      return "Async context reference key is unavailable";
    case "INVALID_MAC":
      return "Async context reference authentication failed";
    case "ISSUED_IN_FUTURE":
      return "Async context reference is not yet valid";
    case "EXPIRED":
      return "Async context reference has expired";
    case "BINDING_MISMATCH":
      return "Async context reference binding mismatch";
    case "INVALID_LIFETIME":
      return "Invalid async context reference lifetime";
    case "INVALID_CLAIMS":
      return "Invalid async context reference claims";
    case "MALFORMED_TOKEN":
      return "Malformed async context reference";
  }
}
