import {
  CONFIDENCE_LOWERING_REASON_CODES,
  CONTEST_REASON_CODES,
  EMERGENCY_REASON_CODES,
  REVOKE_REASON_CODES,
  SUPERSEDE_REASON_CODES,
  UPHOLD_REASON_CODES,
  type ConfidenceLoweringReason,
  type ContestReason,
  type EmergencyReason,
  type RevokeReason,
  type SourceCorrectionReason,
  type SourceErasureReason,
  type SourceRevalidationReason,
  type SourceTombstoneReason,
  type SupersedeReason,
  type UpholdReason
} from "@throughline/core-types";
import {
  exactObject,
  failContract,
  requireCanonicalRationale,
  requireEnum,
  requireLiteral,
  requireSafeReference,
  requireUuidV7
} from "./validation.js";

export interface TruthLifecycleReasonMap {
  contest: ContestReason;
  uphold: UpholdReason;
  supersede: SupersedeReason;
  revoke: RevokeReason;
  emergency: EmergencyReason;
  source_correction: SourceCorrectionReason;
  source_revalidation: SourceRevalidationReason;
  source_tombstone: SourceTombstoneReason;
  lawful_erasure: SourceErasureReason;
  confidence_lowering: ConfidenceLoweringReason;
}

export type TruthLifecycleReasonKind = keyof TruthLifecycleReasonMap;

export function parseTruthLifecycleReason<K extends TruthLifecycleReasonKind>(
  kind: K,
  input: unknown
): TruthLifecycleReasonMap[K] {
  switch (kind) {
    case "contest":
      return parseHumanReason(input, CONTEST_REASON_CODES) as TruthLifecycleReasonMap[K];
    case "uphold":
      return parseHumanReason(input, UPHOLD_REASON_CODES) as TruthLifecycleReasonMap[K];
    case "supersede":
      return parseHumanReason(input, SUPERSEDE_REASON_CODES) as TruthLifecycleReasonMap[K];
    case "revoke":
      return parseHumanReason(input, REVOKE_REASON_CODES) as TruthLifecycleReasonMap[K];
    case "emergency":
      return parseHumanReason(input, EMERGENCY_REASON_CODES) as TruthLifecycleReasonMap[K];
    case "confidence_lowering":
      return parseHumanReason(
        input,
        CONFIDENCE_LOWERING_REASON_CODES
      ) as TruthLifecycleReasonMap[K];
    case "source_correction": {
      const value = exactObject(input, [
        "code",
        "predecessorSourceArtifactId",
        "successorSourceArtifactId"
      ]);
      const predecessorSourceArtifactId = requireUuidV7(value.predecessorSourceArtifactId);
      const successorSourceArtifactId = requireUuidV7(value.successorSourceArtifactId);
      if (predecessorSourceArtifactId === successorSourceArtifactId) return failContract();
      return Object.freeze({
        code: requireLiteral(value.code, "source_corrected"),
        predecessorSourceArtifactId,
        successorSourceArtifactId
      }) as TruthLifecycleReasonMap[K];
    }
    case "source_revalidation": {
      const value = exactObject(input, [
        "code",
        "predecessorClaimId",
        "successorClaimId",
        "rationale"
      ]);
      const predecessorClaimId = requireUuidV7(value.predecessorClaimId);
      const successorClaimId = requireUuidV7(value.successorClaimId);
      if (predecessorClaimId === successorClaimId) return failContract();
      return Object.freeze({
        code: requireLiteral(value.code, "source_revalidated"),
        predecessorClaimId,
        successorClaimId,
        rationale: requireCanonicalRationale(value.rationale)
      }) as TruthLifecycleReasonMap[K];
    }
    case "source_tombstone": {
      const value = exactObject(input, [
        "code",
        "deletionReasonCategory",
        "deletionPolicyRef",
        "hashDisposition"
      ]);
      return Object.freeze({
        code: requireLiteral(value.code, "source_tombstoned"),
        deletionReasonCategory: requireSafeReference(value.deletionReasonCategory),
        deletionPolicyRef: requireSafeReference(value.deletionPolicyRef),
        hashDisposition: requireEnum(value.hashDisposition, ["retained", "erased"] as const)
      }) as TruthLifecycleReasonMap[K];
    }
    case "lawful_erasure": {
      const value = exactObject(input, [
        "code",
        "deletionReasonCategory",
        "deletionPolicyRef",
        "hashDisposition"
      ]);
      return Object.freeze({
        code: requireLiteral(value.code, "lawful_erasure"),
        deletionReasonCategory: requireSafeReference(value.deletionReasonCategory),
        deletionPolicyRef: requireSafeReference(value.deletionPolicyRef),
        hashDisposition: requireLiteral(value.hashDisposition, "erased")
      }) as TruthLifecycleReasonMap[K];
    }
    default:
      return failContract();
  }
}

function parseHumanReason<const Codes extends readonly string[]>(
  input: unknown,
  codes: Codes
): { code: Codes[number]; rationale: string } {
  const value = exactObject(input, ["code", "rationale"]);
  return Object.freeze({
    code: requireEnum(value.code, codes),
    rationale: requireCanonicalRationale(value.rationale)
  });
}
