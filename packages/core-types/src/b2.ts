import type { Confidence, SecurityContext } from "./index.js";

export const B2_COMMAND_SCHEMA_VERSION = 1 as const;
export const B2_TRUTH_PREDICATE_CATALOG_VERSION = "truth-predicate-catalog.v1" as const;

export const B2_TRUTH_PREDICATES = Object.freeze([
  "activity.outcome",
  "initiative.primary_objective"
] as const);
export type B2TruthPredicate = (typeof B2_TRUTH_PREDICATES)[number];

export const B2_COMMAND_KINDS = Object.freeze([
  "claim.propose",
  "fact.accept",
  "fact.contest",
  "fact.uphold",
  "fact.supersede",
  "fact.revoke",
  "fact.emergency_contest",
  "fact.emergency_revoke",
  "derived_view.regenerate"
] as const);
export type B2CommandKind = (typeof B2_COMMAND_KINDS)[number];

export const CONTEST_REASON_CODES = Object.freeze([
  "conflicting_evidence",
  "material_disagreement"
] as const);
export const UPHOLD_REASON_CODES = Object.freeze([
  "challenger_not_supported",
  "challenger_outdated",
  "current_fact_confirmed"
] as const);
export const SUPERSEDE_REASON_CODES = Object.freeze([
  "newer_evidence",
  "accepted_value_changed",
  "corrected_source_revalidated"
] as const);
export const REVOKE_REASON_CODES = Object.freeze([
  "no_longer_true",
  "support_invalidated",
  "entered_in_error"
] as const);
export const EMERGENCY_REASON_CODES = Object.freeze([
  "legal_or_compliance_risk",
  "safety_risk",
  "security_incident",
  "material_truth_risk"
] as const);
export const CONFIDENCE_LOWERING_REASON_CODES = Object.freeze([
  "conservative_human_judgment",
  "evidence_quality",
  "residual_uncertainty"
] as const);

export interface B2Reason<Code extends string> {
  readonly code: Code;
  readonly rationale: string;
}

export type ContestReason = B2Reason<(typeof CONTEST_REASON_CODES)[number]>;
export type UpholdReason = B2Reason<(typeof UPHOLD_REASON_CODES)[number]>;
export type SupersedeReason = B2Reason<(typeof SUPERSEDE_REASON_CODES)[number]>;
export type RevokeReason = B2Reason<(typeof REVOKE_REASON_CODES)[number]>;
export type EmergencyReason = B2Reason<(typeof EMERGENCY_REASON_CODES)[number]>;
export type ConfidenceLoweringReason = B2Reason<(typeof CONFIDENCE_LOWERING_REASON_CODES)[number]>;

export interface SourceCorrectionReason {
  readonly code: "source_corrected";
  readonly predecessorSourceArtifactId: string;
  readonly successorSourceArtifactId: string;
}

export interface SourceRevalidationReason {
  readonly code: "source_revalidated";
  readonly predecessorClaimId: string;
  readonly successorClaimId: string;
  readonly rationale: string;
}

export interface SourceTombstoneReason {
  readonly code: "source_tombstoned";
  readonly deletionReasonCategory: string;
  readonly deletionPolicyRef: string;
  readonly hashDisposition: "retained" | "erased";
}

export interface SourceErasureReason {
  readonly code: "lawful_erasure";
  readonly deletionReasonCategory: string;
  readonly deletionPolicyRef: string;
  readonly hashDisposition: "erased";
}

export interface ConfidenceLoweringRequest {
  confidence: Confidence;
  reason: ConfidenceLoweringReason;
}

export interface B2CommandMetadata {
  idempotencyKey: string;
  predicateCatalogVersion: typeof B2_TRUTH_PREDICATE_CATALOG_VERSION;
}

export interface B2SubjectVersionRef {
  type: "activity" | "initiative";
  id: string;
  expectedVersion: number;
}

export interface B2ClaimVersionRef {
  claimId: string;
  expectedVersion: number;
}

export interface B2ConflictVersionRef {
  conflictId: string;
  expectedVersion: number;
}

export interface ClaimSourceSpanCandidate {
  sourceArtifactId: string;
  sourceChunkId: string;
  expectedSourceVersion: number;
  expectedChunkVersion: 1;
  normalizationVersion: "source-normalization.v1";
  chunkingVersion: "source-chunking.v1";
  startOffset: number;
  endOffset: number;
  excerpt: string;
  sourceContentHash: string;
  sourceNormalizedContentHash: string;
  chunkContentHash: string;
  excerptHash: string;
}

export interface ProposeClaimPayload {
  subject: B2SubjectVersionRef;
  predicate: B2TruthPredicate;
  valueJson: string;
  normalizedText: string;
  confidence: Confidence;
  validFrom?: string;
  validTo?: string;
  observedAt?: string;
  evidence: ClaimSourceSpanCandidate;
}

export interface AcceptFactPayload {
  subject: B2SubjectVersionRef;
  claims: B2ClaimVersionRef[];
  expectedCurrentFactId: null;
  acceptanceScope: "engagement" | "initiative";
  confidenceLowering?: ConfidenceLoweringRequest;
}

export interface ContestFactPayload {
  factId: string;
  expectedFactVersion: number;
  competingClaim: B2ClaimVersionRef;
  reason: ContestReason;
}

export interface UpholdFactPayload {
  factId: string;
  expectedFactVersion: number;
  conflict: B2ConflictVersionRef;
  challengerClaim: B2ClaimVersionRef;
  reason: UpholdReason;
}

export interface SupersedeFactPayload {
  factId: string;
  expectedFactVersion: number;
  subject: B2SubjectVersionRef;
  replacementClaims: B2ClaimVersionRef[];
  conflict?: B2ConflictVersionRef;
  reason: SupersedeReason;
  confidenceLowering?: ConfidenceLoweringRequest;
}

export interface RevokeFactPayload {
  factId: string;
  expectedFactVersion: number;
  reason: RevokeReason;
}

export interface EmergencyContestFactPayload {
  factId: string;
  expectedFactVersion: number;
  competingClaim: B2ClaimVersionRef;
  reason: EmergencyReason;
}

export interface EmergencyRevokeFactPayload {
  factId: string;
  expectedFactVersion: number;
  reason: EmergencyReason;
}

export interface RegenerateDerivedViewPayload {
  target: {
    type: "initiative";
    id: string;
    expectedVersion: number;
  };
  viewType: "initiative_summary";
  renderer: {
    id: "truth-ledger.cited-current-truth";
    version: "v1";
  };
  expectedAudienceFingerprint: string;
  expectedInputRevisionHash: string;
}

export interface B2CommandPayloadMap {
  "claim.propose": ProposeClaimPayload;
  "fact.accept": AcceptFactPayload;
  "fact.contest": ContestFactPayload;
  "fact.uphold": UpholdFactPayload;
  "fact.supersede": SupersedeFactPayload;
  "fact.revoke": RevokeFactPayload;
  "fact.emergency_contest": EmergencyContestFactPayload;
  "fact.emergency_revoke": EmergencyRevokeFactPayload;
  "derived_view.regenerate": RegenerateDerivedViewPayload;
}

export type B2AuthorizedDomainCommand<K extends B2CommandKind = B2CommandKind> = {
  [P in K]: B2CommandMetadata & { kind: P; payload: B2CommandPayloadMap[P] };
}[K];

export interface B2CommandResultMap {
  "claim.propose": { claimId: string; version: 1; status: "proposed" };
  "fact.accept": {
    factId: string;
    version: 1;
    status: "current";
    acceptedClaimIds: string[];
  };
  "fact.contest": {
    factId: string;
    version: number;
    status: "contested";
    conflictId: string;
    conflictVersion: 1;
    competingClaimId: string;
    competingClaimVersion: number;
    competingClaimStatus: "conflicted";
  };
  "fact.uphold": {
    factId: string;
    version: number;
    status: "current";
    conflictId: string;
    conflictVersion: number;
    conflictStatus: "upheld";
    challengerClaimId: string;
    challengerClaimVersion: number;
    challengerClaimStatus: "rejected";
  };
  "fact.supersede": {
    factId: string;
    version: number;
    status: "superseded";
    replacementFactId: string;
    replacementFactVersion: 1;
    replacementFactStatus: "current";
  };
  "fact.revoke": { factId: string; version: number; status: "revoked" };
  "fact.emergency_contest": {
    factId: string;
    version: number;
    status: "contested";
    conflictId: string;
    conflictVersion: 1;
    competingClaimId: string;
    competingClaimVersion: number;
    competingClaimStatus: "conflicted";
    emergency: true;
  };
  "fact.emergency_revoke": {
    factId: string;
    version: number;
    status: "revoked";
    emergency: true;
  };
  "derived_view.regenerate": {
    derivedViewSnapshotId: string;
    viewType: "initiative_summary";
    audienceFingerprint: string;
    inputRevisionHash: string;
    generatedAt: string;
  };
}

export type B2CanonicalCommandIdentityInput<K extends B2CommandKind = B2CommandKind> = {
  [P in K]: {
    recipe: "truth-ledger-command-identity.v1";
    commandSchemaVersion: typeof B2_COMMAND_SCHEMA_VERSION;
    predicateCatalogVersion: typeof B2_TRUTH_PREDICATE_CATALOG_VERSION;
    kind: P;
    payload: B2CommandPayloadMap[P];
  };
}[K];

export interface B2DomainCommandBus {
  execute<K extends B2CommandKind>(
    command: B2AuthorizedDomainCommand<K>,
    context: SecurityContext
  ): Promise<B2CommandResultMap[K]>;
}
