export const TRUSTED_OBJECTIVE_UNAVAILABLE_BODY = Object.freeze({
  statusCode: 404,
  message: "Resource unavailable",
  error: "Not Found"
});

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
  source: null | {
    title: string;
    note: string;
    capturedAt: string;
  };
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
    reasonCode:
      | "needs_rework"
      | "unsupported"
      | "incorrect"
      | "duplicate"
      | "not_useful"
      | "sensitive"
      | "other";
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
    changePreview: {
      from: string;
      to: string;
    };
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

export interface TrustedObjectiveDraft {
  question: string;
  sent: false;
  status: "Not sent";
}

export class TrustedObjectiveInputError extends Error {
  constructor() {
    super("Trusted objective request is invalid");
    this.name = "TrustedObjectiveInputError";
  }
}

export class TrustedObjectiveUnavailableError extends Error {
  constructor() {
    super("Resource unavailable");
    this.name = "TrustedObjectiveUnavailableError";
  }
}

export class TrustedObjectiveConflictError extends Error {
  constructor() {
    super("Trusted objective precondition failed");
    this.name = "TrustedObjectiveConflictError";
  }
}

export function parseCaptureBody(input: unknown): { note: string } {
  const value = exactObject(input, ["note"]);
  if (typeof value.note !== "string" || value.note.length > 100_000 || value.note.trim() === "") {
    throw new TrustedObjectiveInputError();
  }
  return { note: value.note };
}

export function parseProposalBody(input: unknown): {
  objective: string;
  exactExcerpt: string;
  supportConfirmed: true;
  proposalGenerationAnchor: string;
  sourceRevisionAnchor: string;
} {
  const value = exactObject(input, [
    "objective",
    "exactExcerpt",
    "supportConfirmed",
    "proposalGenerationAnchor",
    "sourceRevisionAnchor"
  ]);
  const proposal = parseProposalFields(value);
  if (
    typeof value.proposalGenerationAnchor !== "string" ||
    !PROPOSAL_GENERATION_ANCHOR_PATTERN.test(value.proposalGenerationAnchor) ||
    typeof value.sourceRevisionAnchor !== "string" ||
    !SOURCE_REVISION_ANCHOR_PATTERN.test(value.sourceRevisionAnchor)
  ) {
    throw new TrustedObjectiveInputError();
  }
  return {
    ...proposal,
    proposalGenerationAnchor: value.proposalGenerationAnchor,
    sourceRevisionAnchor: value.sourceRevisionAnchor
  };
}

export function parseReworkBody(input: unknown): {
  claimId: string;
  expectedClaimVersion: number;
  expectedInitiativeVersion: number;
  objective: string;
  exactExcerpt: string;
  supportConfirmed: true;
  sourceRevisionAnchor: string;
} {
  const value = exactObject(input, [
    "claimId",
    "expectedClaimVersion",
    "expectedInitiativeVersion",
    "objective",
    "exactExcerpt",
    "supportConfirmed",
    "sourceRevisionAnchor"
  ]);
  const proposal = parseProposalFields(value);
  if (
    typeof value.claimId !== "string" ||
    !UUID_PATTERN.test(value.claimId) ||
    !Number.isInteger(value.expectedClaimVersion) ||
    value.expectedClaimVersion !== 1 ||
    !Number.isInteger(value.expectedInitiativeVersion) ||
    (value.expectedInitiativeVersion as number) < 1 ||
    typeof value.sourceRevisionAnchor !== "string" ||
    !SOURCE_REVISION_ANCHOR_PATTERN.test(value.sourceRevisionAnchor)
  ) {
    throw new TrustedObjectiveInputError();
  }
  return {
    claimId: value.claimId.toLowerCase(),
    expectedClaimVersion: 1,
    expectedInitiativeVersion: value.expectedInitiativeVersion as number,
    sourceRevisionAnchor: value.sourceRevisionAnchor,
    ...proposal
  };
}

export function parseAcceptBody(input: unknown): {
  claimId: string;
  expectedClaimVersion: 1;
  expectedInitiativeVersion: number;
} {
  const value = exactObject(input, [
    "claimId",
    "expectedClaimVersion",
    "expectedInitiativeVersion"
  ]);
  if (
    typeof value.claimId !== "string" ||
    !UUID_PATTERN.test(value.claimId) ||
    value.expectedClaimVersion !== 1 ||
    !Number.isInteger(value.expectedInitiativeVersion) ||
    (value.expectedInitiativeVersion as number) < 1
  ) {
    throw new TrustedObjectiveInputError();
  }
  return {
    claimId: value.claimId.toLowerCase(),
    expectedClaimVersion: 1,
    expectedInitiativeVersion: value.expectedInitiativeVersion as number
  };
}

export type TrustedObjectiveSupersedeReasonCode =
  | "newer_evidence"
  | "accepted_value_changed"
  | "corrected_source_revalidated";

export type TrustedObjectiveRevokeReasonCode =
  | "no_longer_true"
  | "support_invalidated"
  | "entered_in_error";

export function parseSupersedeBody(input: unknown): {
  factId: string;
  expectedFactVersion: number;
  replacementClaimId: string;
  expectedReplacementClaimVersion: number;
  expectedInitiativeVersion: number;
  reasonCode: TrustedObjectiveSupersedeReasonCode;
  rationale: string;
} {
  const value = exactObject(input, [
    "factId",
    "expectedFactVersion",
    "replacementClaimId",
    "expectedReplacementClaimVersion",
    "expectedInitiativeVersion",
    "reasonCode",
    "rationale"
  ]);
  const reasonCodes = [
    "newer_evidence",
    "accepted_value_changed",
    "corrected_source_revalidated"
  ] as const;
  if (
    typeof value.factId !== "string" ||
    !UUID_PATTERN.test(value.factId) ||
    !Number.isInteger(value.expectedFactVersion) ||
    (value.expectedFactVersion as number) < 1 ||
    typeof value.replacementClaimId !== "string" ||
    !UUID_PATTERN.test(value.replacementClaimId) ||
    !Number.isInteger(value.expectedReplacementClaimVersion) ||
    value.expectedReplacementClaimVersion !== 1 ||
    !Number.isInteger(value.expectedInitiativeVersion) ||
    (value.expectedInitiativeVersion as number) < 1 ||
    !reasonCodes.includes(value.reasonCode as never) ||
    !validRationale(value.rationale)
  ) {
    throw new TrustedObjectiveInputError();
  }
  return {
    factId: value.factId.toLowerCase(),
    expectedFactVersion: value.expectedFactVersion as number,
    replacementClaimId: value.replacementClaimId.toLowerCase(),
    expectedReplacementClaimVersion: 1,
    expectedInitiativeVersion: value.expectedInitiativeVersion as number,
    reasonCode: value.reasonCode as TrustedObjectiveSupersedeReasonCode,
    rationale: value.rationale as string
  };
}

export function parseRevokeBody(input: unknown): {
  factId: string;
  expectedFactVersion: number;
  reasonCode: TrustedObjectiveRevokeReasonCode;
  rationale: string;
} {
  const value = exactObject(input, ["factId", "expectedFactVersion", "reasonCode", "rationale"]);
  const reasonCodes = ["no_longer_true", "support_invalidated", "entered_in_error"] as const;
  if (
    typeof value.factId !== "string" ||
    !UUID_PATTERN.test(value.factId) ||
    !Number.isInteger(value.expectedFactVersion) ||
    (value.expectedFactVersion as number) < 1 ||
    !reasonCodes.includes(value.reasonCode as never) ||
    !validRationale(value.rationale)
  ) {
    throw new TrustedObjectiveInputError();
  }
  return {
    factId: value.factId.toLowerCase(),
    expectedFactVersion: value.expectedFactVersion as number,
    reasonCode: value.reasonCode as TrustedObjectiveRevokeReasonCode,
    rationale: value.rationale as string
  };
}

function parseProposalFields(value: Record<string, unknown>): {
  objective: string;
  exactExcerpt: string;
  supportConfirmed: true;
} {
  if (
    typeof value.objective !== "string" ||
    typeof value.exactExcerpt !== "string" ||
    value.objective.length > 2_000 ||
    value.exactExcerpt.length > 10_000 ||
    value.objective.trim() === "" ||
    value.exactExcerpt.trim() === "" ||
    value.supportConfirmed !== true
  ) {
    throw new TrustedObjectiveInputError();
  }
  return {
    objective: value.objective,
    exactExcerpt: value.exactExcerpt,
    supportConfirmed: true
  };
}

export function parseWithdrawBody(input: unknown): {
  claimId: string;
  expectedClaimVersion: 1;
  expectedInitiativeVersion: number;
  disposition: "withdrawn" | "rejected";
  reasonCode:
    | "needs_rework"
    | "unsupported"
    | "incorrect"
    | "duplicate"
    | "not_useful"
    | "sensitive"
    | "other";
} {
  const value = exactObject(input, [
    "claimId",
    "expectedClaimVersion",
    "expectedInitiativeVersion",
    "disposition",
    "reasonCode"
  ]);
  const dispositions = ["withdrawn", "rejected"] as const;
  const reasons = [
    "needs_rework",
    "unsupported",
    "incorrect",
    "duplicate",
    "not_useful",
    "sensitive",
    "other"
  ] as const;
  if (
    typeof value.claimId !== "string" ||
    !UUID_PATTERN.test(value.claimId) ||
    value.expectedClaimVersion !== 1 ||
    !Number.isInteger(value.expectedInitiativeVersion) ||
    (value.expectedInitiativeVersion as number) < 1 ||
    !dispositions.includes(value.disposition as never) ||
    !reasons.includes(value.reasonCode as never)
  ) {
    throw new TrustedObjectiveInputError();
  }
  return {
    claimId: value.claimId.toLowerCase(),
    expectedClaimVersion: 1,
    expectedInitiativeVersion: value.expectedInitiativeVersion as number,
    disposition: value.disposition as "withdrawn" | "rejected",
    reasonCode: value.reasonCode as (typeof reasons)[number]
  };
}

export function parseEmptyBody(input: unknown): Record<string, never> {
  exactObject(input, []);
  return {};
}

function exactObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TrustedObjectiveInputError();
  }
  const value = input as Record<string, unknown>;
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TrustedObjectiveInputError();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) throw new TrustedObjectiveInputError();
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TrustedObjectiveInputError();
  }
  return value;
}

function validRationale(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2_000 &&
    value.trim() !== "" &&
    value === value.normalize("NFC") &&
    value === value.trim()
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROPOSAL_GENERATION_ANCHOR_PATTERN = /^trusted-objective:proposal-generation:[a-f0-9]{64}$/;
const SOURCE_REVISION_ANCHOR_PATTERN = /^trusted-objective:source-revision:[a-f0-9]{64}$/;
