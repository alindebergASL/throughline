export interface TrustedObjectiveState {
  state: "empty" | "captured" | "proposed" | "accepted";
  initiative: {
    title: string;
    organizationName: string;
    engagementTitle: string;
  };
  source: null | { title: string; note: string; capturedAt: string };
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

export interface ConfirmationDraft {
  question: string;
  sent: false;
  status: "Not sent";
}

export function nextActionForState(state: TrustedObjectiveState["state"]): string {
  return (
    {
      empty: "Capture engagement note",
      captured: "Propose trusted objective",
      proposed: "Accept trusted objective",
      accepted: "Draft confirmation question"
    } as const
  )[state];
}

export function demoActionEnvelope(
  action: "source" | "proposal" | "accept" | "draft-confirmation",
  payload: { note: string } | { objective: string; exactExcerpt: string } | Record<string, never>
): Record<string, unknown> {
  if (action === "source" && "note" in payload) {
    return { action, note: payload.note };
  }
  if (action === "proposal" && "objective" in payload && "exactExcerpt" in payload) {
    return { action, objective: payload.objective, exactExcerpt: payload.exactExcerpt };
  }
  return { action };
}
