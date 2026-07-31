import {
  SOURCE_CHUNKING_VERSION,
  SOURCE_CHUNK_MAX_SCALARS,
  SOURCE_NORMALIZATION_VERSION,
  SourceTextPrimitiveError,
  UnicodeScalarOffsetError,
  maxAccessClass,
  normalizeStoredSourceText,
  sliceUnicodeScalarSpan,
  unicodeScalarLength,
  type AccessClass,
  type B2SubjectVersionRef,
  type ClaimSourceSpanCandidate
} from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import { createHash } from "node:crypto";
import {
  exactObject,
  requireEnum,
  requireLiteral,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireSha256,
  requireString,
  requireUuidV7,
  TruthContractValidationError
} from "./validation.js";

const verifiedClaimSourceSpanBrand = Symbol("VerifiedClaimSourceSpan");
const admittedVerifiedSpans = new WeakSet<object>();
const CANONICAL_UUID_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AuthorizedClaimSourceChunkSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly spaceId: string;
  readonly sourceArtifactId: string;
  readonly version: 1;
  readonly normalizationVersion: typeof SOURCE_NORMALIZATION_VERSION;
  readonly chunkingVersion: typeof SOURCE_CHUNKING_VERSION;
  readonly chunkIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly normalizedText: string;
  readonly contentHash: string;
  readonly accessClass: AccessClass;
}

export interface AuthorizedClaimEvidenceSnapshot {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly spaceId: string;
  readonly subject: {
    readonly type: "activity" | "initiative";
    readonly id: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly spaceId: string;
    readonly version: number;
    readonly accessClass: AccessClass;
  };
  readonly sourceActivityLink: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly spaceId: string;
    readonly sourceArtifactId: string;
    readonly activityId: string;
    readonly governingInitiativeId: string | null;
  };
  readonly source: {
    readonly id: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly spaceId: string;
    readonly version: number;
    readonly immutableText: string | null;
    readonly contentHash: string | null;
    readonly normalizedContentHash: string | null;
    readonly normalizationVersion: typeof SOURCE_NORMALIZATION_VERSION;
    readonly chunkingVersion: typeof SOURCE_CHUNKING_VERSION;
    readonly accessClass: AccessClass;
    readonly deletedAt: string | null;
    readonly successorSourceArtifactId: string | null;
  };
  readonly chunks: readonly AuthorizedClaimSourceChunkSnapshot[];
  readonly explicitPolicyAccessClass: AccessClass;
}

export interface AuthorizedClaimEvidenceSnapshotLookup {
  readonly transaction: TenantDbTransaction;
  getAuthorizedClaimEvidenceSnapshot(input: {
    tenantId: string;
    workspaceId: string;
    subjectType: "activity" | "initiative";
    subjectId: string;
    sourceArtifactId: string;
    sourceChunkId: string;
  }): Promise<AuthorizedClaimEvidenceSnapshot | null>;
}

const transactionScopedLookupBrand = Symbol("TransactionScopedClaimEvidenceSnapshotLookup");

export type TransactionScopedClaimEvidenceSnapshotLookup = Readonly<{
  transaction: TenantDbTransaction;
  getAuthorizedClaimEvidenceSnapshot: AuthorizedClaimEvidenceSnapshotLookup["getAuthorizedClaimEvidenceSnapshot"];
  [transactionScopedLookupBrand]: true;
}>;

/**
 * Explicitly binds authoritative evidence reads to the transaction that owns the truth mutation.
 * Admission rejects a lookup whose transaction identity differs from the mutation transaction.
 */
export function bindClaimEvidenceSnapshotLookupToTransaction(
  transaction: TenantDbTransaction,
  lookup: AuthorizedClaimEvidenceSnapshotLookup
): TransactionScopedClaimEvidenceSnapshotLookup {
  if (lookup.transaction !== transaction) {
    throw new VerifiedClaimSourceSpanOperationalError(
      new Error("Claim evidence lookup is detached from the mutation transaction")
    );
  }
  const scoped = {
    transaction,
    getAuthorizedClaimEvidenceSnapshot: lookup.getAuthorizedClaimEvidenceSnapshot.bind(lookup)
  };
  Object.defineProperty(scoped, transactionScopedLookupBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(scoped) as TransactionScopedClaimEvidenceSnapshotLookup;
}

export type VerifiedClaimSourceSpan = Readonly<{
  subject: Readonly<{ type: "activity" | "initiative"; id: string; version: number }>;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  sourceArtifactId: string;
  sourceChunkId: string;
  sourceVersion: number;
  chunkVersion: 1;
  normalizationVersion: typeof SOURCE_NORMALIZATION_VERSION;
  chunkingVersion: typeof SOURCE_CHUNKING_VERSION;
  startOffset: number;
  endOffset: number;
  excerpt: string;
  sourceContentHash: string;
  sourceNormalizedContentHash: string;
  chunkContentHash: string;
  excerptHash: string;
  effectiveAccessClass: AccessClass;
  readonly [verifiedClaimSourceSpanBrand]: true;
}>;

export class VerifiedClaimSourceSpanError extends Error {
  constructor() {
    super("Claim evidence is unavailable or invalid");
    this.name = "VerifiedClaimSourceSpanError";
  }
}

export class VerifiedClaimSourceSpanOperationalError extends Error {
  constructor(cause: unknown) {
    super("Trusted claim evidence lookup or verification failed", { cause });
    this.name = "VerifiedClaimSourceSpanOperationalError";
  }
}

export class VerifiedClaimSourceSpanAdmission {
  constructor(
    private readonly transaction: TenantDbTransaction,
    private readonly snapshots: TransactionScopedClaimEvidenceSnapshotLookup,
    private readonly authorizedScope: { readonly tenantId: string; readonly workspaceId: string }
  ) {
    if (snapshots.transaction !== transaction || snapshots[transactionScopedLookupBrand] !== true) {
      throw new VerifiedClaimSourceSpanOperationalError(
        new Error("Claim evidence lookup is detached from the mutation transaction")
      );
    }
  }

  async admit(input: unknown): Promise<VerifiedClaimSourceSpan> {
    let candidate: ReturnType<typeof parseAdmissionCandidate>;
    try {
      candidate = parseAdmissionCandidate(input);
    } catch (cause) {
      if (cause instanceof TruthContractValidationError) {
        throw new VerifiedClaimSourceSpanError();
      }
      throw new VerifiedClaimSourceSpanOperationalError(cause);
    }

    let tenantId: string;
    let workspaceId: string;
    try {
      tenantId = requireCanonicalUuidReference(this.authorizedScope.tenantId);
      workspaceId = requireCanonicalUuidReference(this.authorizedScope.workspaceId);
    } catch (cause) {
      throw new VerifiedClaimSourceSpanOperationalError(cause);
    }

    let snapshot: AuthorizedClaimEvidenceSnapshot | null;
    try {
      snapshot = await this.snapshots.getAuthorizedClaimEvidenceSnapshot({
        tenantId,
        workspaceId,
        subjectType: candidate.subject.type,
        subjectId: candidate.subject.id,
        sourceArtifactId: candidate.evidence.sourceArtifactId,
        sourceChunkId: candidate.evidence.sourceChunkId
      });
    } catch (cause) {
      throw new VerifiedClaimSourceSpanOperationalError(cause);
    }

    try {
      if (!snapshot) throw new VerifiedClaimSourceSpanError();
      return verifySnapshot(
        snapshot,
        { tenantId, workspaceId },
        candidate.subject,
        candidate.evidence
      );
    } catch (cause) {
      if (
        cause instanceof VerifiedClaimSourceSpanError ||
        cause instanceof TruthContractValidationError ||
        cause instanceof SourceTextPrimitiveError ||
        cause instanceof UnicodeScalarOffsetError
      ) {
        throw new VerifiedClaimSourceSpanError();
      }
      throw new VerifiedClaimSourceSpanOperationalError(cause);
    }
  }
}

export function isVerifiedClaimSourceSpan(value: unknown): value is VerifiedClaimSourceSpan {
  return typeof value === "object" && value !== null && admittedVerifiedSpans.has(value);
}

function parseAdmissionCandidate(input: unknown): {
  subject: B2SubjectVersionRef;
  evidence: ClaimSourceSpanCandidate;
} {
  const value = exactObject(input, ["subject", "evidence"]);
  const subject = exactObject(value.subject, ["type", "id", "expectedVersion"]);
  const evidence = exactObject(value.evidence, [
    "sourceArtifactId",
    "sourceChunkId",
    "expectedSourceVersion",
    "expectedChunkVersion",
    "normalizationVersion",
    "chunkingVersion",
    "startOffset",
    "endOffset",
    "excerpt",
    "sourceContentHash",
    "sourceNormalizedContentHash",
    "chunkContentHash",
    "excerptHash"
  ]);
  return {
    subject: {
      type: requireEnum(subject.type, ["activity", "initiative"] as const),
      id: requireUuidV7(subject.id),
      expectedVersion: requirePositiveInteger(subject.expectedVersion)
    },
    evidence: {
      sourceArtifactId: requireUuidV7(evidence.sourceArtifactId),
      sourceChunkId: requireUuidV7(evidence.sourceChunkId),
      expectedSourceVersion: requirePositiveInteger(evidence.expectedSourceVersion),
      expectedChunkVersion: requireLiteral(evidence.expectedChunkVersion, 1),
      normalizationVersion: requireLiteral(
        evidence.normalizationVersion,
        SOURCE_NORMALIZATION_VERSION
      ),
      chunkingVersion: requireLiteral(evidence.chunkingVersion, SOURCE_CHUNKING_VERSION),
      startOffset: requireNonNegativeInteger(evidence.startOffset),
      endOffset: requirePositiveInteger(evidence.endOffset),
      excerpt: requireString(evidence.excerpt),
      sourceContentHash: requireSha256(evidence.sourceContentHash),
      sourceNormalizedContentHash: requireSha256(evidence.sourceNormalizedContentHash),
      chunkContentHash: requireSha256(evidence.chunkContentHash),
      excerptHash: requireSha256(evidence.excerptHash)
    }
  };
}

function verifySnapshot(
  snapshot: AuthorizedClaimEvidenceSnapshot,
  authorizedScope: { readonly tenantId: string; readonly workspaceId: string },
  subject: B2SubjectVersionRef,
  candidate: ClaimSourceSpanCandidate
): VerifiedClaimSourceSpan {
  const scopeIds = [snapshot.tenantId, snapshot.workspaceId, snapshot.spaceId].map(
    requireCanonicalUuidReference
  );
  const [tenantId, workspaceId, spaceId] = scopeIds as [string, string, string];
  const source = snapshot.source;
  const link = snapshot.sourceActivityLink;
  const projectedSubject = snapshot.subject;
  requireUuidV7(projectedSubject.id);
  requireCanonicalUuidReference(projectedSubject.tenantId);
  requireCanonicalUuidReference(projectedSubject.workspaceId);
  requireCanonicalUuidReference(projectedSubject.spaceId);
  requireCanonicalUuidReference(link.tenantId);
  requireCanonicalUuidReference(link.workspaceId);
  requireCanonicalUuidReference(link.spaceId);
  requireUuidV7(link.sourceArtifactId);
  requireUuidV7(link.activityId);
  if (link.governingInitiativeId !== null) requireUuidV7(link.governingInitiativeId);
  requireUuidV7(source.id);
  requireCanonicalUuidReference(source.tenantId);
  requireCanonicalUuidReference(source.workspaceId);
  requireCanonicalUuidReference(source.spaceId);

  if (
    tenantId !== authorizedScope.tenantId ||
    workspaceId !== authorizedScope.workspaceId ||
    projectedSubject.type !== subject.type ||
    projectedSubject.id !== subject.id ||
    projectedSubject.version !== subject.expectedVersion ||
    projectedSubject.tenantId !== tenantId ||
    projectedSubject.workspaceId !== workspaceId ||
    projectedSubject.spaceId !== spaceId ||
    link.tenantId !== tenantId ||
    link.workspaceId !== workspaceId ||
    link.spaceId !== spaceId ||
    link.sourceArtifactId !== candidate.sourceArtifactId ||
    source.id !== candidate.sourceArtifactId ||
    source.tenantId !== tenantId ||
    source.workspaceId !== workspaceId ||
    source.spaceId !== spaceId ||
    source.version !== candidate.expectedSourceVersion ||
    source.deletedAt !== null ||
    source.successorSourceArtifactId !== null ||
    source.immutableText === null ||
    source.contentHash === null ||
    source.normalizedContentHash === null ||
    source.normalizationVersion !== SOURCE_NORMALIZATION_VERSION ||
    source.chunkingVersion !== SOURCE_CHUNKING_VERSION ||
    candidate.normalizationVersion !== SOURCE_NORMALIZATION_VERSION ||
    candidate.chunkingVersion !== SOURCE_CHUNKING_VERSION ||
    (subject.type === "activity" && link.activityId !== subject.id) ||
    (subject.type === "initiative" && link.governingInitiativeId !== subject.id)
  ) {
    throw new VerifiedClaimSourceSpanError();
  }

  const chunks = [...snapshot.chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (chunks.length === 0) throw new VerifiedClaimSourceSpanError();
  let expectedGlobalStart = 0;
  let selected: AuthorizedClaimSourceChunkSnapshot | undefined;
  const seenChunkIds = new Set<string>();
  for (const [index, chunk] of chunks.entries()) {
    const scalarLength = unicodeScalarLength(chunk.normalizedText);
    const chunkId = requireUuidV7(chunk.id);
    requireCanonicalUuidReference(chunk.tenantId);
    requireCanonicalUuidReference(chunk.workspaceId);
    requireCanonicalUuidReference(chunk.spaceId);
    requireUuidV7(chunk.sourceArtifactId);
    if (
      seenChunkIds.has(chunkId) ||
      chunk.tenantId !== tenantId ||
      chunk.workspaceId !== workspaceId ||
      chunk.spaceId !== spaceId ||
      chunk.sourceArtifactId !== source.id ||
      chunk.version !== 1 ||
      chunk.normalizationVersion !== SOURCE_NORMALIZATION_VERSION ||
      chunk.chunkingVersion !== SOURCE_CHUNKING_VERSION ||
      chunk.chunkIndex !== index ||
      chunk.startOffset !== expectedGlobalStart ||
      chunk.endOffset !== chunk.startOffset + scalarLength ||
      scalarLength < 1 ||
      scalarLength > SOURCE_CHUNK_MAX_SCALARS ||
      sha256Utf8(chunk.normalizedText) !== chunk.contentHash
    ) {
      throw new VerifiedClaimSourceSpanError();
    }
    seenChunkIds.add(chunkId);
    requireAccessClass(chunk.accessClass);
    expectedGlobalStart = chunk.endOffset;
    if (chunk.id === candidate.sourceChunkId) selected = chunk;
  }
  if (!selected) throw new VerifiedClaimSourceSpanError();

  const normalizedText = chunks.map(({ normalizedText: text }) => text).join("");
  if (normalizeStoredSourceText(source.immutableText) !== normalizedText) {
    throw new VerifiedClaimSourceSpanError();
  }
  const rawHash = sha256Utf8(source.immutableText);
  if (source.contentHash !== rawHash) {
    throw new VerifiedClaimSourceSpanError();
  }
  const normalizedHash = sha256Utf8(normalizedText);
  const excerpt = sliceUnicodeScalarSpan(
    selected.normalizedText,
    candidate.startOffset,
    candidate.endOffset
  );
  const excerptHash = sha256Utf8(excerpt);
  if (
    candidate.expectedChunkVersion !== selected.version ||
    candidate.sourceContentHash !== source.contentHash ||
    candidate.sourceContentHash !== rawHash ||
    candidate.sourceNormalizedContentHash !== source.normalizedContentHash ||
    candidate.sourceNormalizedContentHash !== normalizedHash ||
    candidate.chunkContentHash !== selected.contentHash ||
    candidate.chunkContentHash !== sha256Utf8(selected.normalizedText) ||
    candidate.excerpt !== excerpt ||
    candidate.excerptHash !== excerptHash ||
    unicodeScalarLength(excerpt) > SOURCE_CHUNK_MAX_SCALARS
  ) {
    throw new VerifiedClaimSourceSpanError();
  }

  const effectiveAccessClass = maxAccessClass(
    requireAccessClass(source.accessClass),
    requireAccessClass(selected.accessClass),
    requireAccessClass(projectedSubject.accessClass),
    requireAccessClass(snapshot.explicitPolicyAccessClass)
  );
  const verified = {
    subject: Object.freeze({
      type: subject.type,
      id: subject.id,
      version: subject.expectedVersion
    }),
    tenantId,
    workspaceId,
    spaceId,
    sourceArtifactId: source.id,
    sourceChunkId: selected.id,
    sourceVersion: source.version,
    chunkVersion: selected.version,
    normalizationVersion: SOURCE_NORMALIZATION_VERSION,
    chunkingVersion: SOURCE_CHUNKING_VERSION,
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    excerpt,
    sourceContentHash: rawHash,
    sourceNormalizedContentHash: normalizedHash,
    chunkContentHash: selected.contentHash,
    excerptHash,
    effectiveAccessClass
  };
  Object.defineProperty(verified, verifiedClaimSourceSpanBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false
  });
  admittedVerifiedSpans.add(verified);
  return Object.freeze(verified) as VerifiedClaimSourceSpan;
}

function requireAccessClass(input: unknown): AccessClass {
  return requireEnum(input, ["public", "workspace", "restricted", "confidential"] as const);
}

function requireCanonicalUuidReference(input: unknown): string {
  if (typeof input !== "string" || !CANONICAL_UUID_REFERENCE_PATTERN.test(input)) {
    throw new TruthContractValidationError();
  }
  return input;
}

function sha256Utf8(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
