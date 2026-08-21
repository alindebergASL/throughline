export interface TrustedObjectiveState {
  state: "empty" | "captured" | "proposed" | "accepted" | "revoked";
  proposalGenerationAnchor: string;
  sourceRevisionAnchor: string | null;
  initiative: {
    title: string;
    organizationName: string;
    engagementTitle: string;
    version: number;
    effectiveVisibility: "Public" | "Workspace" | "Restricted" | "Confidential";
    requiredAcceptanceAuthority: "Initiative owner";
    canAccept: boolean;
  };
  source: null | { title: string; note: string; capturedAt: string };
  proposal: null | {
    objective: string;
    exactExcerpt: string;
    sourceTitle: string;
    status: "Proposed, not accepted.";
    claimId: string;
    version: number;
    supportConfirmed: boolean;
    canRework: boolean;
    canWithdraw: boolean;
    canReject: boolean;
  };
  lastProposalRecovery: null | {
    claimId: string;
    recoveryId: string;
    disposition: "withdrawn" | "rejected";
    reasonCode: ProposalRecoveryReason;
  };
  reworkLineage: Array<{
    predecessorClaimId: string;
    successorClaimId: string;
    disposition: "reworked";
    reasonCode: "reworked";
    reworkedAt: string;
  }>;
  acceptedMemory: null | {
    factId: string;
    version: number;
    objective: string;
    status: "Accepted";
    exactExcerpt: string;
    sourceTitle: string;
    whyBelieved: string;
    transition: "Proposed → Accepted";
    acceptedBy: string;
    acceptedAt: string;
    effectiveVisibility: "Public" | "Workspace" | "Restricted" | "Confidential";
    canRevoke: boolean;
  };
  replacementReview: null | {
    status: "Replacement proposed, not accepted.";
    currentFactId: string;
    currentFactVersion: number;
    replacementClaimId: string;
    replacementClaimVersion: number;
    exactExcerpt: string;
    sourceTitle: string;
    changePreview: { from: string; to: string };
    reworkLineage: Array<{
      predecessorClaimId: string;
      successorClaimId: string;
      disposition: "reworked";
      reasonCode: "reworked";
      reworkedAt: string;
    }>;
    canSupersede: boolean;
  };
  history: Array<{
    factId: string;
    availability: "available" | "redacted";
    objective: string | null;
    status: "Superseded" | "Revoked";
    transition: "Accepted → Superseded" | "Accepted → Revoked";
    acceptedAt: string;
    changedAt: string;
  }>;
}

export type ProposalRecoveryReason =
  | "needs_rework"
  | "unsupported"
  | "incorrect"
  | "duplicate"
  | "not_useful"
  | "sensitive"
  | "other";

export const PROPOSAL_RECOVERY_REASONS: ReadonlyArray<{
  value: ProposalRecoveryReason;
  label: string;
}> = [
  { value: "needs_rework", label: "Needs rework" },
  { value: "unsupported", label: "Evidence does not support it" },
  { value: "incorrect", label: "Objective is incorrect" },
  { value: "duplicate", label: "Duplicates another proposal" },
  { value: "not_useful", label: "Not useful as an objective" },
  { value: "sensitive", label: "Contains sensitive information" },
  { value: "other", label: "Another bounded reason" }
];

export interface ConfirmationDraft {
  question: string;
  sent: false;
  status: "Not sent";
}

export function nextActionForState(state: TrustedObjectiveState): string {
  if (state.state === "empty") return "Capture engagement note";
  if (state.state === "captured") return "Propose trusted objective";
  if (state.replacementReview?.canSupersede) return "Supersede trusted objective";
  if (state.state === "revoked") return "Capture updated objective";
  if (state.state === "accepted") return "Draft confirmation question";
  if (state.proposal?.supportConfirmed && state.initiative.canAccept) {
    return "Accept trusted objective";
  }
  if (state.proposal?.canRework) return "Rework proposed objective";
  if (state.proposal?.canWithdraw) return "Withdraw proposed objective";
  if (state.proposal?.canReject) return "Reject proposed objective";
  return "Review proposed objective";
}

export function proposalRecoveryOutcome(
  outcome: NonNullable<TrustedObjectiveState["lastProposalRecovery"]>
): string {
  const reason = PROPOSAL_RECOVERY_REASONS.find(({ value }) => value === outcome.reasonCode)?.label;
  return `${outcome.disposition === "rejected" ? "Proposal rejected" : "Proposal withdrawn"}: ${reason ?? outcome.reasonCode}.`;
}

export function demoActionEnvelope(
  action:
    | "source"
    | "proposal"
    | "proposal/withdraw"
    | "proposal/rework"
    | "accept"
    | "supersede"
    | "revoke"
    | "draft-confirmation",
  payload: Record<string, string | number | boolean>
): Record<string, unknown> {
  if (action === "source" && "note" in payload) {
    return { action, note: payload.note };
  }
  if (
    (action === "proposal" || action === "proposal/rework") &&
    "objective" in payload &&
    "exactExcerpt" in payload
  ) {
    return { action, ...payload };
  }
  if (action === "proposal/withdraw") {
    return { action, ...payload };
  }
  if (
    action === "accept" &&
    "claimId" in payload &&
    "expectedClaimVersion" in payload &&
    "expectedInitiativeVersion" in payload
  ) {
    return { action, ...payload };
  }
  if (action === "supersede") {
    return {
      action,
      factId: payload.factId,
      expectedFactVersion: payload.expectedFactVersion,
      replacementClaimId: payload.replacementClaimId,
      expectedReplacementClaimVersion: payload.expectedReplacementClaimVersion,
      expectedInitiativeVersion: payload.expectedInitiativeVersion,
      reasonCode: payload.reasonCode,
      rationale: payload.rationale
    };
  }
  if (action === "revoke") {
    return {
      action,
      factId: payload.factId,
      expectedFactVersion: payload.expectedFactVersion,
      reasonCode: payload.reasonCode,
      rationale: payload.rationale
    };
  }
  return { action };
}
