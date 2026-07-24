import {
  maxAccessClass,
  type AccessClass,
  type B2_TRUTH_PREDICATE_CATALOG_VERSION,
  type B2TruthPredicate,
  type Confidence,
  type ConfidenceLoweringRequest,
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
  calculateAcceptedFactConfidence,
  type AcceptedFactConfidenceResult,
  type RecordedConfidenceSupportAssessment
} from "./confidence.js";
import { resolvePredicateDefinition, type TruthSubjectKind } from "./predicate-registry.js";
import { isVerifiedClaimSourceSpan, type VerifiedClaimSourceSpan } from "./source-span.js";
import {
  failContract,
  requireEnum,
  requirePositiveInteger,
  requireSafeReference,
  requireTimestamp,
  requireUuidV7
} from "./validation.js";

export const CLAIM_STATUSES = Object.freeze([
  "proposed",
  "accepted",
  "rejected",
  "conflicted",
  "superseded"
] as const);
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const ACCEPTED_FACT_STATUSES = Object.freeze([
  "current",
  "contested",
  "superseded",
  "revoked"
] as const);
export type AcceptedFactStatus = (typeof ACCEPTED_FACT_STATUSES)[number];

export interface Claim {
  readonly id: string;
  readonly version: number;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly spaceId: string;
  readonly subjectType: TruthSubjectKind;
  readonly subjectId: string;
  readonly predicate: B2TruthPredicate;
  readonly valueJson: string;
  readonly normalizedText: string;
  readonly sourceSpan: VerifiedClaimSourceSpan;
  readonly assertedByType: "person";
  readonly assertedById: string;
  readonly confidence: Confidence;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly observedAt?: string;
  readonly status: ClaimStatus;
  readonly conflictGroupId?: string;
  readonly accessClass: AccessClass;
  readonly createdAt: string;
}

const acceptedFactBrand = Symbol("AcceptedFact");
const constructedAcceptedFacts = new WeakSet<object>();

export type AcceptedFact = Readonly<{
  id: string;
  version: number;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  subjectType: TruthSubjectKind;
  subjectId: string;
  predicate: B2TruthPredicate;
  valueJson: string;
  normalizedText: string;
  supportingClaimIds: readonly string[];
  confidence: Confidence;
  confidenceDecision: AcceptedFactConfidenceResult;
  validFrom?: string;
  validTo?: string;
  recordedAt: string;
  status: AcceptedFactStatus;
  supersedesFactId?: string;
  accessClass: AccessClass;
  acceptedByUserId: string;
  acceptedByMembershipId: string;
  acceptanceScope: "engagement" | "initiative";
  authorityBasis: "activity_owner" | "initiative_owner";
  policyVersion: string;
  createdAt: string;
  readonly [acceptedFactBrand]: true;
}>;

export type NewlyAcceptedFact = AcceptedFact &
  Readonly<{
    version: 1;
    status: "current";
  }>;

export interface AcceptedFactConstructionInput {
  readonly id: string;
  readonly claims: readonly Claim[];
  readonly subjectAccessClass: AccessClass;
  readonly explicitPolicyAccessClass: AccessClass;
  readonly acceptedByUserId: string;
  readonly acceptedByMembershipId: string;
  readonly acceptanceScope: "engagement" | "initiative";
  readonly authorityBasis: "activity_owner" | "initiative_owner";
  readonly policyVersion: string;
  readonly recordedAt: string;
  readonly createdAt: string;
  readonly supersedesFactId?: string;
  readonly confidenceLowering?: ConfidenceLoweringRequest;
}

/** Package-internal trusted construction boundary; intentionally omitted from the root export. */
export function constructAcceptedFactAtTrustedBoundary(
  input: AcceptedFactConstructionInput
): NewlyAcceptedFact {
  if (!Array.isArray(input.claims) || input.claims.length === 0 || input.claims.length > 100) {
    return failContract();
  }
  const claims = [...input.claims];
  const factId = requireUuidV7(input.id);
  const supersedesFactId =
    input.supersedesFactId === undefined ? undefined : requireUuidV7(input.supersedesFactId);
  if (supersedesFactId === factId) return failContract();
  const first = claims[0]!;
  const definition = resolvePredicateDefinition(first.predicate, first.subjectType);
  definition.valueSchema.parse(first.valueJson);
  definition.valueSchema.parse(first.normalizedText);
  if (!definition.equals(first.valueJson, first.normalizedText)) return failContract();

  const seen = new Set<string>();
  for (const claim of claims) {
    const claimId = requireUuidV7(claim.id);
    requirePositiveInteger(claim.version);
    requireUuidV7(claim.tenantId);
    requireUuidV7(claim.workspaceId);
    requireUuidV7(claim.spaceId);
    requireUuidV7(claim.subjectId);
    requireUuidV7(claim.assertedById);
    requireTimestamp(claim.createdAt);
    requireEnum(claim.accessClass, ["public", "workspace", "restricted", "confidential"] as const);
    requireEnum(claim.status, CLAIM_STATUSES);
    if (
      seen.has(claimId) ||
      !isVerifiedClaimSourceSpan(claim.sourceSpan) ||
      !["proposed", "conflicted"].includes(claim.status) ||
      claim.assertedByType !== "person" ||
      claim.tenantId !== first.tenantId ||
      claim.workspaceId !== first.workspaceId ||
      claim.spaceId !== first.spaceId ||
      claim.subjectType !== first.subjectType ||
      claim.subjectId !== first.subjectId ||
      claim.predicate !== first.predicate ||
      !definition.equals(claim.valueJson, first.valueJson) ||
      !definition.equals(claim.normalizedText, first.normalizedText) ||
      claim.validFrom !== first.validFrom ||
      claim.validTo !== first.validTo ||
      claim.sourceSpan.subject.type !== claim.subjectType ||
      claim.sourceSpan.subject.id !== claim.subjectId ||
      claim.sourceSpan.tenantId !== claim.tenantId ||
      claim.sourceSpan.workspaceId !== claim.workspaceId ||
      claim.sourceSpan.spaceId !== claim.spaceId
    ) {
      return failContract();
    }
    if (claim.validFrom !== undefined) requireTimestamp(claim.validFrom);
    if (claim.validTo !== undefined) requireTimestamp(claim.validTo);
    if (claim.observedAt !== undefined) requireTimestamp(claim.observedAt);
    if (claim.conflictGroupId !== undefined) requireUuidV7(claim.conflictGroupId);
    seen.add(claimId);
  }
  if (
    first.validFrom !== undefined &&
    first.validTo !== undefined &&
    Date.parse(first.validTo) < Date.parse(first.validFrom)
  ) {
    return failContract();
  }

  const acceptanceScope = requireEnum(input.acceptanceScope, ["engagement", "initiative"] as const);
  const authorityBasis = requireEnum(input.authorityBasis, [
    "activity_owner",
    "initiative_owner"
  ] as const);
  if (
    (first.subjectType === "activity" &&
      (acceptanceScope !== "engagement" || authorityBasis !== "activity_owner")) ||
    (first.subjectType === "initiative" &&
      (acceptanceScope !== "initiative" || authorityBasis !== "initiative_owner"))
  ) {
    return failContract();
  }

  const confidenceDecision = calculateAcceptedFactConfidence({
    selectedClaims: claims.map(({ id, confidence }) => ({ claimId: id, confidence, valid: true })),
    ...(input.confidenceLowering === undefined
      ? {}
      : { requestedLowering: input.confidenceLowering })
  });
  const supportingClaimIds = claims.map(({ id }) => id).sort();
  const accessClass = maxAccessClass(
    requireEnum(input.subjectAccessClass, [
      "public",
      "workspace",
      "restricted",
      "confidential"
    ] as const),
    requireEnum(input.explicitPolicyAccessClass, [
      "public",
      "workspace",
      "restricted",
      "confidential"
    ] as const),
    ...claims.flatMap(({ accessClass: claimClass, sourceSpan }) => [
      claimClass,
      sourceSpan.effectiveAccessClass
    ])
  );
  const fact = {
    id: factId,
    version: 1 as const,
    tenantId: requireUuidV7(first.tenantId),
    workspaceId: requireUuidV7(first.workspaceId),
    spaceId: requireUuidV7(first.spaceId),
    subjectType: first.subjectType,
    subjectId: requireUuidV7(first.subjectId),
    predicate: first.predicate,
    valueJson: first.valueJson,
    normalizedText: first.normalizedText,
    supportingClaimIds: Object.freeze(supportingClaimIds),
    confidence: confidenceDecision.confidence,
    confidenceDecision,
    ...(first.validFrom === undefined ? {} : { validFrom: requireTimestamp(first.validFrom) }),
    ...(first.validTo === undefined ? {} : { validTo: requireTimestamp(first.validTo) }),
    recordedAt: requireTimestamp(input.recordedAt),
    status: "current" as const,
    ...(supersedesFactId === undefined ? {} : { supersedesFactId }),
    accessClass,
    acceptedByUserId: requireUuidV7(input.acceptedByUserId),
    acceptedByMembershipId: requireUuidV7(input.acceptedByMembershipId),
    acceptanceScope,
    authorityBasis,
    policyVersion: requireSafeReference(input.policyVersion),
    createdAt: requireTimestamp(input.createdAt)
  };
  Object.defineProperty(fact, acceptedFactBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false
  });
  constructedAcceptedFacts.add(fact);
  return Object.freeze(fact) as NewlyAcceptedFact;
}

export function isAcceptedFact(value: unknown): value is AcceptedFact {
  return typeof value === "object" && value !== null && constructedAcceptedFacts.has(value);
}

interface LifecycleAuthorityEvidenceBase {
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly policyVersion: string;
  readonly commandId: string;
  readonly recordedAt: string;
}

export interface RoutineLifecycleAuthorityEvidence extends LifecycleAuthorityEvidenceBase {
  readonly authorityBasis: "activity_owner" | "initiative_owner";
}

export interface EmergencyLifecycleAuthorityEvidence extends LifecycleAuthorityEvidenceBase {
  readonly authorityBasis: "workspace_owner_emergency";
}

export type LifecycleAuthorityEvidence =
  | RoutineLifecycleAuthorityEvidence
  | EmergencyLifecycleAuthorityEvidence;

export type FactLifecycleEvidence = Readonly<
  | {
      kind: "fact.accepted";
      factId: string;
      supportingClaimIds: readonly string[];
      toStatus: "current";
      confidenceDecision: AcceptedFactConfidenceResult;
      authority: RoutineLifecycleAuthorityEvidence;
    }
  | {
      kind: "fact.contested";
      factId: string;
      challengerClaimId: string;
      conflictId: string;
      fromStatus: "current";
      toStatus: "contested";
      reason: ContestReason;
      authority: RoutineLifecycleAuthorityEvidence;
    }
  | {
      kind: "fact.upheld";
      factId: string;
      challengerClaimId: string;
      conflictId: string;
      fromStatus: "contested";
      toStatus: "current";
      reason: UpholdReason;
      authority: RoutineLifecycleAuthorityEvidence;
    }
  | {
      kind: "fact.superseded";
      factId: string;
      replacementFactId: string;
      conflictId?: string;
      fromStatus: "current" | "contested";
      toStatus: "superseded";
      reason: SupersedeReason;
      authority: RoutineLifecycleAuthorityEvidence;
    }
  | {
      kind: "fact.revoked";
      factId: string;
      conflictId?: string;
      fromStatus: "current" | "contested";
      toStatus: "revoked";
      reason: RevokeReason;
      authority: RoutineLifecycleAuthorityEvidence;
    }
  | {
      kind: "fact.emergency_contested";
      factId: string;
      challengerClaimId: string;
      conflictId: string;
      fromStatus: "current";
      toStatus: "contested";
      reason: EmergencyReason;
      authority: EmergencyLifecycleAuthorityEvidence;
    }
  | {
      kind: "fact.emergency_revoked";
      factId: string;
      conflictId?: string;
      fromStatus: "current" | "contested";
      toStatus: "revoked";
      reason: EmergencyReason;
      authority: EmergencyLifecycleAuthorityEvidence;
    }
  | {
      kind: "fact.source_support_corrected";
      factId: string;
      affectedClaimIds: readonly string[];
      fromStatus: "current";
      toStatus: "contested";
      reason: SourceCorrectionReason;
      commandId: string;
      recordedAt: string;
    }
  | {
      kind: "fact.source_support_tombstoned";
      factId: string;
      affectedClaimIds: readonly string[];
      fromStatus: "current" | "contested";
      toStatus: "revoked";
      reason: SourceTombstoneReason;
      commandId: string;
      recordedAt: string;
    }
  | {
      kind: "fact.source_support_erased";
      factId: string;
      affectedClaimIds: readonly string[];
      fromStatus: "current" | "contested";
      toStatus: "revoked";
      reason: SourceErasureReason;
      commandId: string;
      recordedAt: string;
    }
>;

export type SourceLifecycleEvidence = Readonly<
  | { kind: "source.corrected"; reason: SourceCorrectionReason }
  | { kind: "source.revalidated"; reason: SourceRevalidationReason }
  | { kind: "source.tombstoned"; reason: SourceTombstoneReason }
  | { kind: "source.erased"; reason: SourceErasureReason }
>;

type ReviewRequiredSupportAssessment = RecordedConfidenceSupportAssessment &
  Readonly<{
    disposition: "review_required";
    recomputedStoredConfidence: false;
  }>;

export type SourceReconciliationEvidence = Readonly<
  | {
      kind: "fact.source_correction_review_required";
      factId: string;
      removedClaimIds: readonly string[];
      fromStatus: "current";
      toStatus: "contested";
      reason: SourceCorrectionReason;
      commandId: string;
      recordedAt: string;
    }
  | {
      kind: "fact.source_support_review_required";
      factId: string;
      fromStatus: "current";
      toStatus: "contested";
      reviewReason: "support_invalidated";
      reviewReasonAdded: false;
      supportAssessment: ReviewRequiredSupportAssessment;
      commandId: string;
      recordedAt: string;
    }
  | {
      kind: "fact.source_support_review_required";
      factId: string;
      fromStatus: "contested";
      toStatus: "contested";
      reviewReason: "support_invalidated";
      reviewReasonAdded: true;
      supportAssessment: ReviewRequiredSupportAssessment;
      commandId: string;
      recordedAt: string;
    }
  | {
      kind: "fact.source_support_removed_independent_support";
      factId: string;
      removedClaimIds: readonly string[];
      survivingClaimIds: readonly string[];
      status: "current" | "contested";
      recordedConfidenceSustained: true;
      accessClassChange: "unchanged" | "tightened";
      reason: SourceCorrectionReason | SourceTombstoneReason | SourceErasureReason;
      commandId: string;
      recordedAt: string;
    }
  | {
      kind: "fact.source_revalidated_by_supersession";
      factId: string;
      replacementFactId: string;
      predecessorClaimId: string;
      successorClaimId: string;
      reason: SourceRevalidationReason;
      commandId: string;
      recordedAt: string;
    }
  | {
      kind: "fact.source_removal_revoked";
      factId: string;
      removedClaimIds: readonly string[];
      fromStatus: "current" | "contested";
      toStatus: "revoked";
      payloadRedacted: boolean;
      reason: SourceTombstoneReason | SourceErasureReason;
      commandId: string;
      recordedAt: string;
    }
>;

export interface FactConflictEvidence {
  readonly id: string;
  readonly version: number;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly spaceId: string;
  readonly factId: string;
  readonly challengerClaimId: string;
  readonly status: "open" | "upheld" | "superseded" | "revoked";
  readonly openedByCommandId: string;
  readonly resolvedByCommandId?: string;
  readonly lifecycle: readonly FactLifecycleEvidence[];
}

interface DeterministicTruthViewFactInputBase {
  readonly factId: string;
  readonly subjectType: TruthSubjectKind;
  readonly subjectId: string;
  readonly predicate: B2TruthPredicate;
  readonly canonicalValue: string;
  readonly normalizedText: string;
  readonly confidence: Confidence;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesFactId?: string;
  readonly accessClass: AccessClass;
  readonly supportingClaimIds: readonly string[];
}

export type DeterministicTruthViewReviewState = Readonly<
  | {
      kind: "none";
    }
  | {
      kind: "visible_claim_conflict";
      audienceFilteredConflictIds: readonly [string, ...string[]];
    }
  | {
      kind: "source_support_review";
      reason: "source_corrected" | "support_invalidated";
    }
>;

/** Audience-projected state only; raw Fact lifecycle versions and hidden conflicts are excluded. */
export type DeterministicTruthViewFactInput = Readonly<
  | (DeterministicTruthViewFactInputBase & {
      status: "current";
      reviewState: Extract<DeterministicTruthViewReviewState, { kind: "none" }>;
    })
  | (DeterministicTruthViewFactInputBase & {
      status: "contested";
      reviewState: Exclude<DeterministicTruthViewReviewState, { kind: "none" }>;
    })
>;

export interface DeterministicTruthViewClaimInput {
  readonly claimId: string;
  readonly version: number;
  readonly status: ClaimStatus;
  readonly confidence: Confidence;
  readonly canonicalValue: string;
  readonly normalizedText: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly accessClass: AccessClass;
  readonly verifiedSourceSpan: VerifiedClaimSourceSpan;
  readonly visibleToAudience: true;
}

export interface DeterministicTruthViewConflictInput {
  readonly conflictId: string;
  readonly version: number;
  readonly status: "open";
  readonly factId: string;
  readonly challengerClaimId: string;
  readonly visibleToAudience: true;
}

export interface DeterministicTruthViewInput {
  readonly recipe: "truth-ledger-input-revision.v1";
  readonly predicateCatalogVersion: typeof B2_TRUTH_PREDICATE_CATALOG_VERSION;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly spaceId: string;
  readonly target: { readonly type: "initiative"; readonly id: string; readonly version: number };
  readonly viewType: "initiative_summary";
  readonly renderer: {
    readonly id: "truth-ledger.cited-current-truth";
    readonly version: "v1";
  };
  readonly workspaceProfile: { readonly id: string; readonly version: number };
  readonly policyVersion: string;
  readonly audienceFingerprint: string;
  readonly facts: readonly DeterministicTruthViewFactInput[];
  readonly audienceFilteredClaims: readonly DeterministicTruthViewClaimInput[];
  readonly audienceFilteredConflicts: readonly DeterministicTruthViewConflictInput[];
  readonly verifiedSourceSpans: readonly VerifiedClaimSourceSpan[];
}

export interface VerifiedDerivedCitation {
  readonly label: string;
  readonly factId?: string;
  readonly claimId?: string;
  readonly sourceArtifactId: string;
  readonly sourceChunkId: string;
  readonly sourceVersion: number;
  readonly chunkVersion: 1;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly excerpt: string;
  readonly sourceContentHash: string;
  readonly sourceNormalizedContentHash: string;
  readonly chunkContentHash: string;
  readonly excerptHash: string;
}

declare const audienceFilteredConflictIdsBrand: unique symbol;

/** Conflict identifiers admitted only after audience filtering; plain or raw ID arrays are invalid. */
export type AudienceFilteredConflictIds = readonly string[] & {
  readonly [audienceFilteredConflictIdsBrand]: true;
};

/** Stored shape only; PR 1 defines no renderer or persistence implementation. */
export interface DerivedViewSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly spaceId: string;
  readonly target: { readonly type: "initiative"; readonly id: string; readonly version: number };
  readonly viewType: "initiative_summary";
  readonly audienceFingerprint: string;
  readonly inputFactIds: readonly string[];
  readonly inputSourceIds: readonly string[];
  readonly inputRevisionHash: string;
  readonly content: string;
  readonly citations: readonly VerifiedDerivedCitation[];
  readonly unresolvedConflictIds: AudienceFilteredConflictIds;
  readonly accessClass: AccessClass;
  readonly policyVersion: string;
  readonly modelProvider: "deterministic";
  readonly modelId: "none";
  readonly skillId: "truth-ledger.cited-current-truth";
  readonly skillVersion: "v1";
  readonly generatedAt: string;
  readonly staleAt?: string;
}
