import {
  B2_COMMAND_KINDS,
  B2_COMMAND_SCHEMA_VERSION,
  B2_TRUTH_PREDICATE_CATALOG_VERSION,
  SOURCE_CHUNKING_VERSION,
  SOURCE_CHUNK_MAX_SCALARS,
  SOURCE_NORMALIZATION_VERSION,
  canonicalJsonStringify,
  unicodeScalarLength,
  type B2AuthorizedDomainCommand,
  type B2CanonicalCommandIdentityInput,
  type B2ClaimVersionRef,
  type B2CommandKind,
  type B2CommandPayloadMap,
  type B2CommandResultMap,
  type B2ConflictVersionRef,
  type B2SubjectVersionRef,
  type ClaimSourceSpanCandidate,
  type Confidence,
  type ConfidenceLoweringRequest
} from "@throughline/core-types";
import { createHash } from "node:crypto";
import { parsePredicateAssertion } from "./predicate-registry.js";
import { parseTruthLifecycleReason } from "./reasons.js";
import {
  exactObject,
  failContract,
  requireEnum,
  requireIdempotencyKey,
  requireLiteral,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireSha256,
  requireString,
  requireTimestamp,
  requireUuidV7
} from "./validation.js";

const CONFIDENCES = ["confirmed", "strong", "weak", "unknown"] as const;

export class B2CommandValidationError extends Error {
  constructor() {
    super("B2 command request is invalid");
    this.name = "B2CommandValidationError";
  }
}

export class B2CommandInvariantError extends Error {
  constructor() {
    super("B2 command result is invalid");
    this.name = "B2CommandInvariantError";
  }
}

export function parseB2Command(input: unknown): B2AuthorizedDomainCommand {
  try {
    const command = exactObject(input, [
      "kind",
      "idempotencyKey",
      "predicateCatalogVersion",
      "payload"
    ]);
    const kind = requireEnum(command.kind, B2_COMMAND_KINDS);
    const metadata = {
      kind,
      idempotencyKey: requireIdempotencyKey(command.idempotencyKey),
      predicateCatalogVersion: requireLiteral(
        command.predicateCatalogVersion,
        B2_TRUTH_PREDICATE_CATALOG_VERSION
      )
    };
    switch (kind) {
      case "claim.create":
        return { ...metadata, kind, payload: parseCreateClaim(command.payload) };
      case "fact.accept":
        return { ...metadata, kind, payload: parseAcceptFact(command.payload) };
      case "fact.contest":
        return { ...metadata, kind, payload: parseContestFact(command.payload) };
      case "fact.uphold":
        return { ...metadata, kind, payload: parseUpholdFact(command.payload) };
      case "fact.supersede":
        return { ...metadata, kind, payload: parseSupersedeFact(command.payload) };
      case "fact.revoke":
        return { ...metadata, kind, payload: parseRevokeFact(command.payload) };
      case "fact.emergency_contest":
        return { ...metadata, kind, payload: parseEmergencyContest(command.payload) };
      case "fact.emergency_revoke":
        return { ...metadata, kind, payload: parseEmergencyRevoke(command.payload) };
      case "derived_view.regenerate":
        return { ...metadata, kind, payload: parseRegenerateDerivedView(command.payload) };
    }
  } catch {
    throw new B2CommandValidationError();
  }
}

export function canonicalB2CommandIdentity(input: unknown): B2CanonicalCommandIdentityInput {
  const command = parseB2Command(input);
  return {
    recipe: "truth-ledger-command-identity.v1",
    commandSchemaVersion: B2_COMMAND_SCHEMA_VERSION,
    predicateCatalogVersion: command.predicateCatalogVersion,
    kind: command.kind,
    payload: command.payload
  } as B2CanonicalCommandIdentityInput;
}

export function serializeB2Command(input: unknown): string {
  return canonicalJsonStringify(parseB2Command(input));
}

export function serializeB2CommandIdentity(input: unknown): string {
  return canonicalJsonStringify(canonicalB2CommandIdentity(input));
}

export function hashB2CommandIdentity(input: unknown): string {
  return createHash("sha256").update(serializeB2CommandIdentity(input), "utf8").digest("hex");
}

export function parseB2CommandResult<K extends B2CommandKind>(
  kind: K,
  input: unknown
): B2CommandResultMap[K] {
  try {
    return parseResult(kind, input) as B2CommandResultMap[K];
  } catch {
    throw new B2CommandInvariantError();
  }
}

export function serializeB2CommandResult<K extends B2CommandKind>(kind: K, input: unknown): string {
  return canonicalJsonStringify(parseB2CommandResult(kind, input));
}

function parseCreateClaim(input: unknown): B2CommandPayloadMap["claim.create"] {
  const value = exactObject(
    input,
    ["subject", "predicate", "valueJson", "normalizedText", "confidence", "evidence"],
    ["validFrom", "validTo", "observedAt"]
  );
  const subject = parseSubject(value.subject);
  const assertion = parsePredicateAssertion({
    predicate: value.predicate,
    subjectKind: subject.type,
    canonicalValue: value.valueJson,
    normalizedText: value.normalizedText
  });
  const validFrom = value.validFrom === undefined ? undefined : requireTimestamp(value.validFrom);
  const validTo = value.validTo === undefined ? undefined : requireTimestamp(value.validTo);
  if (
    validFrom !== undefined &&
    validTo !== undefined &&
    Date.parse(validTo) < Date.parse(validFrom)
  ) {
    return failContract();
  }
  return {
    subject,
    predicate: assertion.predicate,
    valueJson: assertion.canonicalValue,
    normalizedText: assertion.normalizedText,
    confidence: parseConfidence(value.confidence),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
    ...(value.observedAt === undefined ? {} : { observedAt: requireTimestamp(value.observedAt) }),
    evidence: parseEvidence(value.evidence)
  };
}

function parseAcceptFact(input: unknown): B2CommandPayloadMap["fact.accept"] {
  const value = exactObject(
    input,
    ["subject", "claims", "expectedCurrentFactId", "acceptanceScope"],
    ["confidenceLowering"]
  );
  const subject = parseSubject(value.subject);
  const acceptanceScope = requireEnum(value.acceptanceScope, ["engagement", "initiative"] as const);
  if (
    (subject.type === "activity" && acceptanceScope !== "engagement") ||
    (subject.type === "initiative" && acceptanceScope !== "initiative")
  ) {
    return failContract();
  }
  return {
    subject,
    claims: parseSortedClaimRefs(value.claims),
    expectedCurrentFactId: requireLiteral(value.expectedCurrentFactId, null),
    acceptanceScope,
    ...(value.confidenceLowering === undefined
      ? {}
      : { confidenceLowering: parseConfidenceLowering(value.confidenceLowering) })
  };
}

function parseContestFact(input: unknown): B2CommandPayloadMap["fact.contest"] {
  const value = exactObject(input, ["factId", "expectedFactVersion", "competingClaim", "reason"]);
  return {
    factId: requireUuidV7(value.factId),
    expectedFactVersion: requirePositiveInteger(value.expectedFactVersion),
    competingClaim: parseClaimRef(value.competingClaim),
    reason: parseTruthLifecycleReason("contest", value.reason)
  };
}

function parseUpholdFact(input: unknown): B2CommandPayloadMap["fact.uphold"] {
  const value = exactObject(input, [
    "factId",
    "expectedFactVersion",
    "conflict",
    "challengerClaim",
    "reason"
  ]);
  return {
    factId: requireUuidV7(value.factId),
    expectedFactVersion: requirePositiveInteger(value.expectedFactVersion),
    conflict: parseConflictRef(value.conflict),
    challengerClaim: parseClaimRef(value.challengerClaim),
    reason: parseTruthLifecycleReason("uphold", value.reason)
  };
}

function parseSupersedeFact(input: unknown): B2CommandPayloadMap["fact.supersede"] {
  const value = exactObject(
    input,
    ["factId", "expectedFactVersion", "subject", "replacementClaims", "reason"],
    ["conflict", "confidenceLowering"]
  );
  return {
    factId: requireUuidV7(value.factId),
    expectedFactVersion: requirePositiveInteger(value.expectedFactVersion),
    subject: parseSubject(value.subject),
    replacementClaims: parseSortedClaimRefs(value.replacementClaims),
    ...(value.conflict === undefined ? {} : { conflict: parseConflictRef(value.conflict) }),
    reason: parseTruthLifecycleReason("supersede", value.reason),
    ...(value.confidenceLowering === undefined
      ? {}
      : { confidenceLowering: parseConfidenceLowering(value.confidenceLowering) })
  };
}

function parseRevokeFact(input: unknown): B2CommandPayloadMap["fact.revoke"] {
  const value = exactObject(input, ["factId", "expectedFactVersion", "reason"]);
  return {
    factId: requireUuidV7(value.factId),
    expectedFactVersion: requirePositiveInteger(value.expectedFactVersion),
    reason: parseTruthLifecycleReason("revoke", value.reason)
  };
}

function parseEmergencyContest(input: unknown): B2CommandPayloadMap["fact.emergency_contest"] {
  const value = exactObject(input, ["factId", "expectedFactVersion", "competingClaim", "reason"]);
  return {
    factId: requireUuidV7(value.factId),
    expectedFactVersion: requirePositiveInteger(value.expectedFactVersion),
    competingClaim: parseClaimRef(value.competingClaim),
    reason: parseTruthLifecycleReason("emergency", value.reason)
  };
}

function parseEmergencyRevoke(input: unknown): B2CommandPayloadMap["fact.emergency_revoke"] {
  const value = exactObject(input, ["factId", "expectedFactVersion", "reason"]);
  return {
    factId: requireUuidV7(value.factId),
    expectedFactVersion: requirePositiveInteger(value.expectedFactVersion),
    reason: parseTruthLifecycleReason("emergency", value.reason)
  };
}

function parseRegenerateDerivedView(
  input: unknown
): B2CommandPayloadMap["derived_view.regenerate"] {
  const value = exactObject(input, [
    "target",
    "viewType",
    "renderer",
    "expectedAudienceFingerprint",
    "expectedInputRevisionHash"
  ]);
  const target = exactObject(value.target, ["type", "id", "expectedVersion"]);
  const renderer = exactObject(value.renderer, ["id", "version"]);
  return {
    target: {
      type: requireLiteral(target.type, "initiative"),
      id: requireUuidV7(target.id),
      expectedVersion: requirePositiveInteger(target.expectedVersion)
    },
    viewType: requireLiteral(value.viewType, "initiative_summary"),
    renderer: {
      id: requireLiteral(renderer.id, "truth-ledger.cited-current-truth"),
      version: requireLiteral(renderer.version, "v1")
    },
    expectedAudienceFingerprint: requireSha256(value.expectedAudienceFingerprint),
    expectedInputRevisionHash: requireSha256(value.expectedInputRevisionHash)
  };
}

function parseSubject(input: unknown): B2SubjectVersionRef {
  const value = exactObject(input, ["type", "id", "expectedVersion"]);
  return {
    type: requireEnum(value.type, ["activity", "initiative"] as const),
    id: requireUuidV7(value.id),
    expectedVersion: requirePositiveInteger(value.expectedVersion)
  };
}

function parseClaimRef(input: unknown): B2ClaimVersionRef {
  const value = exactObject(input, ["claimId", "expectedVersion"]);
  return {
    claimId: requireUuidV7(value.claimId),
    expectedVersion: requirePositiveInteger(value.expectedVersion)
  };
}

function parseSortedClaimRefs(input: unknown): B2ClaimVersionRef[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) return failContract();
  const refs = input.map(parseClaimRef);
  for (let index = 1; index < refs.length; index += 1) {
    if (refs[index - 1]!.claimId >= refs[index]!.claimId) return failContract();
  }
  return refs;
}

function parseConflictRef(input: unknown): B2ConflictVersionRef {
  const value = exactObject(input, ["conflictId", "expectedVersion"]);
  return {
    conflictId: requireUuidV7(value.conflictId),
    expectedVersion: requirePositiveInteger(value.expectedVersion)
  };
}

function parseConfidence(input: unknown): Confidence {
  return requireEnum(input, CONFIDENCES);
}

function parseConfidenceLowering(input: unknown): ConfidenceLoweringRequest {
  const value = exactObject(input, ["confidence", "reason"]);
  return {
    confidence: parseConfidence(value.confidence),
    reason: parseTruthLifecycleReason("confidence_lowering", value.reason)
  };
}

function parseEvidence(input: unknown): ClaimSourceSpanCandidate {
  const value = exactObject(input, [
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
  const startOffset = requireNonNegativeInteger(value.startOffset);
  const endOffset = requirePositiveInteger(value.endOffset);
  const excerpt = requireString(value.excerpt);
  if (
    endOffset <= startOffset ||
    endOffset - startOffset > SOURCE_CHUNK_MAX_SCALARS ||
    unicodeScalarLength(excerpt) < 1 ||
    unicodeScalarLength(excerpt) > SOURCE_CHUNK_MAX_SCALARS
  ) {
    return failContract();
  }
  return {
    sourceArtifactId: requireUuidV7(value.sourceArtifactId),
    sourceChunkId: requireUuidV7(value.sourceChunkId),
    expectedSourceVersion: requirePositiveInteger(value.expectedSourceVersion),
    expectedChunkVersion: requireLiteral(value.expectedChunkVersion, 1),
    normalizationVersion: requireLiteral(value.normalizationVersion, SOURCE_NORMALIZATION_VERSION),
    chunkingVersion: requireLiteral(value.chunkingVersion, SOURCE_CHUNKING_VERSION),
    startOffset,
    endOffset,
    excerpt,
    sourceContentHash: requireSha256(value.sourceContentHash),
    sourceNormalizedContentHash: requireSha256(value.sourceNormalizedContentHash),
    chunkContentHash: requireSha256(value.chunkContentHash),
    excerptHash: requireSha256(value.excerptHash)
  };
}

function parseResult(kind: B2CommandKind, input: unknown): B2CommandResultMap[B2CommandKind] {
  switch (kind) {
    case "claim.create": {
      const value = exactObject(input, ["claimId", "version", "status"]);
      return {
        claimId: requireUuidV7(value.claimId),
        version: requireLiteral(value.version, 1),
        status: requireLiteral(value.status, "proposed")
      };
    }
    case "fact.accept": {
      const value = exactObject(input, ["factId", "version", "status", "acceptedClaimIds"]);
      return {
        factId: requireUuidV7(value.factId),
        version: requireLiteral(value.version, 1),
        status: requireLiteral(value.status, "current"),
        acceptedClaimIds: parseSortedUuidArray(value.acceptedClaimIds)
      };
    }
    case "fact.contest": {
      const value = exactObject(input, [
        "factId",
        "version",
        "status",
        "conflictId",
        "conflictVersion",
        "competingClaimId",
        "competingClaimVersion",
        "competingClaimStatus"
      ]);
      return {
        factId: requireUuidV7(value.factId),
        version: requirePositiveInteger(value.version),
        status: requireLiteral(value.status, "contested"),
        conflictId: requireUuidV7(value.conflictId),
        conflictVersion: requireLiteral(value.conflictVersion, 1),
        competingClaimId: requireUuidV7(value.competingClaimId),
        competingClaimVersion: requirePositiveInteger(value.competingClaimVersion),
        competingClaimStatus: requireLiteral(value.competingClaimStatus, "conflicted")
      };
    }
    case "fact.uphold": {
      const value = exactObject(input, [
        "factId",
        "version",
        "status",
        "conflictId",
        "conflictVersion",
        "conflictStatus",
        "challengerClaimId",
        "challengerClaimVersion",
        "challengerClaimStatus"
      ]);
      return {
        factId: requireUuidV7(value.factId),
        version: requirePositiveInteger(value.version),
        status: requireLiteral(value.status, "current"),
        conflictId: requireUuidV7(value.conflictId),
        conflictVersion: requirePositiveInteger(value.conflictVersion),
        conflictStatus: requireLiteral(value.conflictStatus, "upheld"),
        challengerClaimId: requireUuidV7(value.challengerClaimId),
        challengerClaimVersion: requirePositiveInteger(value.challengerClaimVersion),
        challengerClaimStatus: requireLiteral(value.challengerClaimStatus, "rejected")
      };
    }
    case "fact.supersede": {
      const value = exactObject(input, [
        "factId",
        "version",
        "status",
        "replacementFactId",
        "replacementFactVersion",
        "replacementFactStatus"
      ]);
      return {
        factId: requireUuidV7(value.factId),
        version: requirePositiveInteger(value.version),
        status: requireLiteral(value.status, "superseded"),
        replacementFactId: requireUuidV7(value.replacementFactId),
        replacementFactVersion: requireLiteral(value.replacementFactVersion, 1),
        replacementFactStatus: requireLiteral(value.replacementFactStatus, "current")
      };
    }
    case "fact.revoke": {
      const value = exactObject(input, ["factId", "version", "status"]);
      return {
        factId: requireUuidV7(value.factId),
        version: requirePositiveInteger(value.version),
        status: requireLiteral(value.status, "revoked")
      };
    }
    case "fact.emergency_contest": {
      const value = exactObject(input, [
        "factId",
        "version",
        "status",
        "conflictId",
        "conflictVersion",
        "competingClaimId",
        "competingClaimVersion",
        "competingClaimStatus",
        "emergency"
      ]);
      return {
        factId: requireUuidV7(value.factId),
        version: requirePositiveInteger(value.version),
        status: requireLiteral(value.status, "contested"),
        conflictId: requireUuidV7(value.conflictId),
        conflictVersion: requireLiteral(value.conflictVersion, 1),
        competingClaimId: requireUuidV7(value.competingClaimId),
        competingClaimVersion: requirePositiveInteger(value.competingClaimVersion),
        competingClaimStatus: requireLiteral(value.competingClaimStatus, "conflicted"),
        emergency: requireLiteral(value.emergency, true)
      };
    }
    case "fact.emergency_revoke": {
      const value = exactObject(input, ["factId", "version", "status", "emergency"]);
      return {
        factId: requireUuidV7(value.factId),
        version: requirePositiveInteger(value.version),
        status: requireLiteral(value.status, "revoked"),
        emergency: requireLiteral(value.emergency, true)
      };
    }
    case "derived_view.regenerate": {
      const value = exactObject(input, [
        "derivedViewSnapshotId",
        "viewType",
        "audienceFingerprint",
        "inputRevisionHash",
        "generatedAt"
      ]);
      return {
        derivedViewSnapshotId: requireUuidV7(value.derivedViewSnapshotId),
        viewType: requireLiteral(value.viewType, "initiative_summary"),
        audienceFingerprint: requireSha256(value.audienceFingerprint),
        inputRevisionHash: requireSha256(value.inputRevisionHash),
        generatedAt: requireTimestamp(value.generatedAt)
      };
    }
    default:
      return failContract();
  }
}

function parseSortedUuidArray(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) return failContract();
  const values = input.map(requireUuidV7);
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) return failContract();
  }
  return values;
}
