export const TRUSTED_OBJECTIVE_UNAVAILABLE_BODY = Object.freeze({
  statusCode: 404,
  message: "Resource unavailable",
  error: "Not Found"
});

export interface TrustedObjectiveState {
  state: "empty" | "captured" | "proposed" | "accepted";
  initiative: {
    title: string;
    organizationName: string;
    engagementTitle: string;
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
  };
  acceptedMemory: null | {
    objective: string;
    status: "Accepted";
    exactExcerpt: string;
    sourceTitle: string;
    whyBelieved: string;
    transition: "Proposed → Accepted";
    acceptedBy: string;
    acceptedAt: string;
    effectiveVisibility: "Public" | "Workspace" | "Restricted" | "Confidential";
  };
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

export function parseProposalBody(input: unknown): { objective: string; exactExcerpt: string } {
  const value = exactObject(input, ["objective", "exactExcerpt"]);
  if (
    typeof value.objective !== "string" ||
    typeof value.exactExcerpt !== "string" ||
    value.objective.length > 2_000 ||
    value.exactExcerpt.length > 10_000 ||
    value.objective.trim() === "" ||
    value.exactExcerpt.trim() === ""
  ) {
    throw new TrustedObjectiveInputError();
  }
  return { objective: value.objective, exactExcerpt: value.exactExcerpt };
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
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TrustedObjectiveInputError();
  }
  return value;
}
