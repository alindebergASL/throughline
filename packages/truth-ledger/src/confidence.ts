import type {
  Confidence,
  ConfidenceLoweringRequest,
  ConfidenceLoweringReason
} from "@throughline/core-types";
import { parseTruthLifecycleReason } from "./reasons.js";
import { failContract, requireUuidV7 } from "./validation.js";

export const ACCEPTED_FACT_CONFIDENCE_RULE = "strongest-selected-valid-claim.v1" as const;

const CONFIDENCE_RANK = {
  unknown: 0,
  weak: 1,
  strong: 2,
  confirmed: 3
} as const satisfies Record<Confidence, number>;

export interface SelectedClaimConfidence {
  claimId: string;
  confidence: Confidence;
  valid: boolean;
}

export interface AcceptedFactConfidenceResult {
  readonly rule: typeof ACCEPTED_FACT_CONFIDENCE_RULE;
  readonly confidence: Confidence;
  readonly strongestSupportingConfidence: Confidence;
  readonly strongestSupportingClaimIds: readonly string[];
  readonly selectedValidClaimIds: readonly string[];
  readonly excludedInvalidClaimIds: readonly string[];
  readonly validSupportCount: number;
  readonly countBoostApplied: false;
  readonly humanLowered: boolean;
  readonly lowering?: Readonly<{
    from: Confidence;
    to: Confidence;
    reason: ConfidenceLoweringReason;
  }>;
}

export interface RecordedConfidenceSupportAssessment {
  readonly rule: "recorded-confidence-support-assessment.v1";
  readonly recordedConfidence: Confidence;
  readonly strongestActiveSupport: Confidence | null;
  readonly disposition: "sustained" | "review_required";
  readonly recomputedStoredConfidence: false;
  readonly activeValidClaimIds: readonly string[];
}

export function calculateAcceptedFactConfidence(input: {
  selectedClaims: readonly SelectedClaimConfidence[];
  requestedLowering?: ConfidenceLoweringRequest;
}): AcceptedFactConfidenceResult {
  const claims = validateClaims(input.selectedClaims);
  const validClaims = claims.filter(({ valid }) => valid);
  if (validClaims.length === 0) return failContract();

  const strongestRank = Math.max(
    ...validClaims.map(({ confidence }) => CONFIDENCE_RANK[confidence])
  );
  const strongestSupportingConfidence = confidenceAtRank(strongestRank);
  const strongestSupportingClaimIds = validClaims
    .filter(({ confidence }) => confidence === strongestSupportingConfidence)
    .map(({ claimId }) => claimId)
    .sort();
  const selectedValidClaimIds = validClaims.map(({ claimId }) => claimId).sort();
  const excludedInvalidClaimIds = claims
    .filter(({ valid }) => !valid)
    .map(({ claimId }) => claimId)
    .sort();

  if (input.requestedLowering === undefined) {
    return Object.freeze({
      rule: ACCEPTED_FACT_CONFIDENCE_RULE,
      confidence: strongestSupportingConfidence,
      strongestSupportingConfidence,
      strongestSupportingClaimIds: Object.freeze(strongestSupportingClaimIds),
      selectedValidClaimIds: Object.freeze(selectedValidClaimIds),
      excludedInvalidClaimIds: Object.freeze(excludedInvalidClaimIds),
      validSupportCount: validClaims.length,
      countBoostApplied: false,
      humanLowered: false
    });
  }

  const requested = input.requestedLowering;
  if (!Object.hasOwn(CONFIDENCE_RANK, requested.confidence)) return failContract();
  if (CONFIDENCE_RANK[requested.confidence] >= strongestRank) return failContract();
  const reason = parseTruthLifecycleReason("confidence_lowering", requested.reason);
  return Object.freeze({
    rule: ACCEPTED_FACT_CONFIDENCE_RULE,
    confidence: requested.confidence,
    strongestSupportingConfidence,
    strongestSupportingClaimIds: Object.freeze(strongestSupportingClaimIds),
    selectedValidClaimIds: Object.freeze(selectedValidClaimIds),
    excludedInvalidClaimIds: Object.freeze(excludedInvalidClaimIds),
    validSupportCount: validClaims.length,
    countBoostApplied: false,
    humanLowered: true,
    lowering: Object.freeze({
      from: strongestSupportingConfidence,
      to: requested.confidence,
      reason: Object.freeze(reason)
    })
  });
}

export function assessRecordedConfidenceSupport(input: {
  recordedConfidence: Confidence;
  activeClaims: readonly SelectedClaimConfidence[];
}): RecordedConfidenceSupportAssessment {
  if (!Object.hasOwn(CONFIDENCE_RANK, input.recordedConfidence)) return failContract();
  const active = validateClaims(input.activeClaims, true).filter(({ valid }) => valid);
  const strongestActiveSupport =
    active.length === 0
      ? null
      : confidenceAtRank(Math.max(...active.map(({ confidence }) => CONFIDENCE_RANK[confidence])));
  const sustained =
    strongestActiveSupport !== null &&
    CONFIDENCE_RANK[strongestActiveSupport] >= CONFIDENCE_RANK[input.recordedConfidence];
  return Object.freeze({
    rule: "recorded-confidence-support-assessment.v1",
    recordedConfidence: input.recordedConfidence,
    strongestActiveSupport,
    disposition: sustained ? "sustained" : "review_required",
    recomputedStoredConfidence: false,
    activeValidClaimIds: Object.freeze(active.map(({ claimId }) => claimId).sort())
  });
}

function validateClaims(
  claims: readonly SelectedClaimConfidence[],
  allowEmpty = false
): readonly SelectedClaimConfidence[] {
  if (!Array.isArray(claims) || (!allowEmpty && claims.length === 0) || claims.length > 100) {
    return failContract();
  }
  const seen = new Set<string>();
  return claims.map((claim) => {
    const claimId = requireUuidV7(claim.claimId);
    if (
      seen.has(claimId) ||
      !Object.hasOwn(CONFIDENCE_RANK, claim.confidence) ||
      typeof claim.valid !== "boolean"
    ) {
      return failContract();
    }
    seen.add(claimId);
    return { claimId, confidence: claim.confidence, valid: claim.valid };
  });
}

function confidenceAtRank(rank: number): Confidence {
  switch (rank) {
    case 0:
      return "unknown";
    case 1:
      return "weak";
    case 2:
      return "strong";
    case 3:
      return "confirmed";
    default:
      return failContract();
  }
}
