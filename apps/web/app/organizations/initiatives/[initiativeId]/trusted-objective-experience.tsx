"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  demoActionEnvelope,
  nextActionForState,
  PROPOSAL_RECOVERY_REASONS,
  proposalRecoveryOutcome,
  type ConfirmationDraft,
  type ProposalRecoveryReason,
  type TrustedObjectiveState
} from "../../../../lib/trusted-objective";
import {
  createAssistedObjectiveDraft,
  rejectAssistedObjective,
  rejectAssistedObjectivePreservingEdits,
  type AssistedObjectiveDraft
} from "../../../../lib/assisted-objective";
import {
  focusAssistedObjectiveTarget,
  runSingleFlight,
  type AssistedObjectiveFocusTarget
} from "../../../../lib/assisted-objective-focus";

export function TrustedObjectiveExperience(input: { initiativeId: string }) {
  const [state, setState] = useState<TrustedObjectiveState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("Loading Initiative");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<ConfirmationDraft | null>(null);
  const [reworking, setReworking] = useState(false);
  const [recoveryIntent, setRecoveryIntent] = useState<"withdrawn" | "rejected" | null>(null);
  const [recoveryReason, setRecoveryReason] = useState<ProposalRecoveryReason | "">("");
  const [postFailureFocusEpoch, setPostFailureFocusEpoch] = useState(0);
  const requestOwnerRef = useRef<symbol | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null);
  const unavailableHeadingRef = useRef<HTMLHeadingElement>(null);
  const restoreReviewFocusRef = useRef(false);

  const load = useCallback(
    async (successAnnouncement?: string) => {
      try {
        const response = await fetch(
          `/api/demo/initiatives/${encodeURIComponent(input.initiativeId)}/trusted-objective`,
          { cache: "no-store" }
        );
        if (!response.ok) throw new Error("Unavailable");
        const next = (await response.json()) as TrustedObjectiveState;
        setState(next);
        setUnavailable(false);
        setAnnouncement(successAnnouncement ?? `${nextActionForState(next)} ready`);
      } catch {
        setUnavailable(true);
        setState(null);
        setAnnouncement("Initiative unavailable");
      }
    },
    [input.initiativeId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    action:
      | "source"
      | "proposal"
      | "proposal/withdraw"
      | "proposal/rework"
      | "accept"
      | "draft-confirmation",
    values: Record<string, string | number | boolean> = {}
  ) {
    return runSingleFlight(requestOwnerRef, setBusy, async () => {
      setAnnouncement("Saving");
      try {
        const response = await fetch(
          `/api/demo/initiatives/${encodeURIComponent(input.initiativeId)}/trusted-objective`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(demoActionEnvelope(action, values as never))
          }
        );
        if (!response.ok) {
          setReworking(false);
          setRecoveryIntent(null);
          setRecoveryReason("");
          await load(
            response.status === 409
              ? "The proposal changed. Current Initiative state is ready for review."
              : "The request could not be completed. Current Initiative state was refreshed."
          );
          setPostFailureFocusEpoch((epoch) => epoch + 1);
          return;
        }
        if (action === "draft-confirmation") {
          const nextDraft = (await response.json()) as ConfirmationDraft;
          setDraft(nextDraft);
          setAnnouncement("Confirmation question drafted. Not sent.");
        } else {
          const next = (await response.json()) as TrustedObjectiveState;
          setState(next);
          setReworking(false);
          setRecoveryIntent(null);
          setRecoveryReason("");
          setAnnouncement(
            action === "proposal/withdraw" && next.lastProposalRecovery
              ? `${proposalRecoveryOutcome(next.lastProposalRecovery)} ${nextActionForState(next)} ready.`
              : `${nextActionForState(next)} ready`
          );
        }
      } catch {
        setReworking(false);
        setRecoveryIntent(null);
        setRecoveryReason("");
        await load("The request could not be completed. Current Initiative state was refreshed.");
        setPostFailureFocusEpoch((epoch) => epoch + 1);
      }
    });
  }

  useEffect(() => {
    if (unavailable) {
      unavailableHeadingRef.current?.focus();
      return;
    }
    if (recoveryIntent) {
      recoveryHeadingRef.current?.focus();
      return;
    }
    if (restoreReviewFocusRef.current) {
      restoreReviewFocusRef.current = false;
      reviewHeadingRef.current?.focus();
      return;
    }
    const heading = document.querySelector<HTMLElement>("[data-step-heading]");
    heading?.focus();
  }, [state?.state, reworking, recoveryIntent, unavailable, postFailureFocusEpoch]);

  function openRecovery(intent: "withdrawn" | "rejected") {
    setRecoveryReason("");
    setRecoveryIntent(intent);
    setAnnouncement(
      `${intent === "rejected" ? "Reject" : "Withdraw"} confirmation requires a reason.`
    );
  }

  function cancelRecovery() {
    restoreReviewFocusRef.current = true;
    setRecoveryIntent(null);
    setRecoveryReason("");
    setAnnouncement("Proposal review restored. No change was made.");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <strong>Throughline</strong>
        <label className="command">
          <span className="sr-only">Universal command and search</span>
          <input placeholder="Search or ask Throughline..." disabled />
        </label>
      </header>
      <div className="layout">
        <nav aria-label="Primary">
          <Link href="#">Today</Link>
          <Link href="#" aria-current="page">
            Organizations
          </Link>
          <Link href="#">Pulse</Link>
        </nav>
        <main className="initiative-surface">
          <p className="action-announcement" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
          {unavailable ? (
            <section className="unavailable" aria-labelledby="unavailable-title">
              <p className="eyebrow">Organizations</p>
              <h1 id="unavailable-title" ref={unavailableHeadingRef} tabIndex={-1}>
                This Initiative is unavailable.
              </h1>
              <p>It may not exist, or you may not be able to open it.</p>
            </section>
          ) : !state ? (
            <p>Loading Initiative…</p>
          ) : (
            <>
              <header className="initiative-header">
                <p className="eyebrow">{state.initiative.organizationName}</p>
                <h1>{state.initiative.title}</h1>
                <p>
                  {state.initiative.engagementTitle} · Turn exact engagement evidence into trusted
                  memory.
                </p>
              </header>

              {state.state === "empty" && (
                <section className="workflow-card" aria-labelledby="capture-title">
                  <p className="step">1 of 3 · Capture evidence</p>
                  <h2 id="capture-title" data-step-heading tabIndex={-1}>
                    Paste the engagement note
                  </h2>
                  <p>
                    Source text is untrusted data. Nothing becomes shared truth until you explicitly
                    accept it.
                  </p>
                  <label htmlFor="engagement-note">Engagement note</label>
                  <textarea
                    id="engagement-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    rows={10}
                    placeholder="Paste a realistic note from the engagement…"
                  />
                  <button
                    className="primary"
                    disabled={busy || note.trim() === ""}
                    onClick={() => void act("source", { note })}
                  >
                    Capture engagement note
                  </button>
                </section>
              )}

              {state.source && !state.proposal && !state.acceptedMemory && (
                <ObjectiveSuggestionCard
                  key={`${state.source.capturedAt}-${state.proposalGenerationAnchor}-${state.sourceRevisionAnchor}`}
                  source={state.source}
                  busy={busy}
                  announce={setAnnouncement}
                  visibility={state.initiative.effectiveVisibility}
                  authority={state.initiative.requiredAcceptanceAuthority}
                  recoveryOutcome={state.lastProposalRecovery}
                  createProposal={(values) =>
                    act("proposal", {
                      ...values,
                      proposalGenerationAnchor: state.proposalGenerationAnchor,
                      sourceRevisionAnchor: state.sourceRevisionAnchor!
                    })
                  }
                />
              )}

              {state.proposal && !state.acceptedMemory && reworking && (
                <ObjectiveSuggestionCard
                  key={`rework-${state.proposal.claimId}-${state.sourceRevisionAnchor}`}
                  source={state.source!}
                  busy={busy}
                  announce={setAnnouncement}
                  visibility={state.initiative.effectiveVisibility}
                  authority={state.initiative.requiredAcceptanceAuthority}
                  initialValues={{
                    objective: state.proposal.objective,
                    exactExcerpt: state.proposal.exactExcerpt
                  }}
                  submitLabel="Replace proposed objective"
                  onCancel={() => {
                    restoreReviewFocusRef.current = true;
                    setReworking(false);
                    setAnnouncement("Proposal review restored. No replacement was submitted.");
                  }}
                  createProposal={(values) =>
                    act("proposal/rework", {
                      ...values,
                      claimId: state.proposal!.claimId,
                      expectedClaimVersion: state.proposal!.version,
                      expectedInitiativeVersion: state.initiative.version,
                      sourceRevisionAnchor: state.sourceRevisionAnchor!
                    })
                  }
                />
              )}

              {state.proposal && !state.acceptedMemory && !reworking && (
                <section className="workflow-card proposed" aria-labelledby="review-title">
                  <p className="step">3 of 3 · Review</p>
                  <h2 id="review-title" ref={reviewHeadingRef} data-step-heading tabIndex={-1}>
                    Review proposed memory
                  </h2>
                  <p className="trust-label proposed-label">{state.proposal.status}</p>
                  <p>
                    Visibility: {state.initiative.effectiveVisibility} · Acceptance authority:{" "}
                    {state.initiative.requiredAcceptanceAuthority}
                  </p>
                  <blockquote>{state.proposal.objective}</blockquote>
                  <ReworkLineage lineage={state.reworkLineage} />
                  <details>
                    <summary>Inspect exact source evidence</summary>
                    <div className="evidence-panel">
                      <p>
                        <strong>Source</strong>
                        <br />
                        {state.proposal.sourceTitle}
                      </p>
                      <p>
                        <strong>Human-confirmed supporting excerpt</strong>
                      </p>
                      <blockquote>{state.proposal.exactExcerpt}</blockquote>
                      <p>
                        This source remains untrusted evidence until you accept the proposed memory.
                      </p>
                    </div>
                  </details>
                  {state.proposal.supportConfirmed ? (
                    state.initiative.canAccept ? (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void act("accept", {
                            claimId: state.proposal!.claimId,
                            expectedClaimVersion: state.proposal!.version,
                            expectedInitiativeVersion: state.initiative.version
                          })
                        }
                      >
                        Accept objective
                      </button>
                    ) : (
                      <p>Only the current Initiative owner can accept this proposed memory.</p>
                    )
                  ) : (
                    <p>
                      This earlier proposal has no durable human support confirmation. Rework it
                      with fresh evidence confirmation before acceptance.
                    </p>
                  )}
                  {(state.proposal.canRework ||
                    state.proposal.canWithdraw ||
                    state.proposal.canReject) && (
                    <div className="recovery-actions">
                      {state.proposal.canRework && (
                        <button
                          className={
                            state.initiative.canAccept && state.proposal.supportConfirmed
                              ? "secondary"
                              : "primary"
                          }
                          disabled={busy}
                          onClick={() => setReworking(true)}
                        >
                          Rework proposal
                        </button>
                      )}
                      {state.proposal.canWithdraw && (
                        <button
                          className="text-action"
                          disabled={busy}
                          onClick={() => openRecovery("withdrawn")}
                        >
                          Withdraw proposal
                        </button>
                      )}
                      {state.proposal.canReject && (
                        <button
                          className="text-action"
                          disabled={busy}
                          onClick={() => openRecovery("rejected")}
                        >
                          Reject proposal
                        </button>
                      )}
                    </div>
                  )}
                  {recoveryIntent && (
                    <section
                      className="recovery-confirmation"
                      role="dialog"
                      aria-modal="false"
                      aria-labelledby="recovery-confirmation-title"
                    >
                      <h3 id="recovery-confirmation-title" ref={recoveryHeadingRef} tabIndex={-1}>
                        Confirm proposal{" "}
                        {recoveryIntent === "rejected" ? "rejection" : "withdrawal"}
                      </h3>
                      <p>
                        This will preserve the proposal as immutable terminal history. It cannot be
                        reopened or accepted afterward.
                      </p>
                      <label htmlFor="proposal-recovery-reason">Reason</label>
                      <select
                        id="proposal-recovery-reason"
                        value={recoveryReason}
                        disabled={busy}
                        onChange={(event) =>
                          setRecoveryReason(event.target.value as ProposalRecoveryReason | "")
                        }
                      >
                        <option value="">Select the real reason</option>
                        {PROPOSAL_RECOVERY_REASONS.map(({ value, label }) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <div className="confirmation-actions">
                        <button className="secondary" disabled={busy} onClick={cancelRecovery}>
                          Cancel
                        </button>
                        <button
                          className="primary"
                          disabled={busy || recoveryReason === ""}
                          onClick={() =>
                            void act("proposal/withdraw", {
                              claimId: state.proposal!.claimId,
                              expectedClaimVersion: state.proposal!.version,
                              expectedInitiativeVersion: state.initiative.version,
                              disposition: recoveryIntent,
                              reasonCode: recoveryReason
                            })
                          }
                        >
                          Confirm {recoveryIntent === "rejected" ? "rejection" : "withdrawal"}
                        </button>
                      </div>
                    </section>
                  )}
                </section>
              )}

              {state.acceptedMemory && (
                <section className="trusted-memory" aria-labelledby="memory-title">
                  <div className="accepted-heading">
                    <div>
                      <p className="step">Trusted memory</p>
                      <h2 id="memory-title" data-step-heading tabIndex={-1}>
                        Primary objective
                      </h2>
                    </div>
                    <span className="trust-label accepted-label">
                      {state.acceptedMemory.status}
                    </span>
                  </div>
                  <blockquote className="objective-quote">
                    {state.acceptedMemory.objective}
                  </blockquote>
                  <ReworkLineage lineage={state.reworkLineage} />
                  <dl className="memory-details">
                    <div>
                      <dt>Changed</dt>
                      <dd>{state.acceptedMemory.transition}</dd>
                    </div>
                    <div>
                      <dt>Accepted by</dt>
                      <dd>{state.acceptedMemory.acceptedBy}</dd>
                    </div>
                    <div>
                      <dt>Accepted</dt>
                      <dd>{formatDate(state.acceptedMemory.acceptedAt)}</dd>
                    </div>
                    <div>
                      <dt>Effective visibility</dt>
                      <dd>{state.acceptedMemory.effectiveVisibility}</dd>
                    </div>
                  </dl>
                  <details>
                    <summary>Why is this believed?</summary>
                    <div className="evidence-panel">
                      <p>{state.acceptedMemory.whyBelieved}</p>
                      <p>
                        <strong>Source</strong>
                        <br />
                        {state.acceptedMemory.sourceTitle}
                      </p>
                      <p>
                        <strong>Exact excerpt</strong>
                      </p>
                      <blockquote>{state.acceptedMemory.exactExcerpt}</blockquote>
                    </div>
                  </details>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void act("draft-confirmation")}
                  >
                    Draft confirmation question
                  </button>
                  {draft && (
                    <section className="draft" aria-labelledby="draft-title">
                      <div className="accepted-heading">
                        <h3 id="draft-title">Confirmation question</h3>
                        <span className="trust-label not-sent">{draft.status}</span>
                      </div>
                      <p>{draft.question}</p>
                      <p className="muted">
                        Drafted deterministically from accepted memory. Sent: {String(draft.sent)}.
                      </p>
                    </section>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function ReworkLineage(input: { lineage: TrustedObjectiveState["reworkLineage"] }) {
  if (input.lineage.length === 0) return null;
  const latest = input.lineage.at(-1)!;
  return (
    <div className="rework-lineage">
      <p>This successor was reworked from proposal {shortClaimId(latest.predecessorClaimId)}.</p>
      <details>
        <summary>Inspect objective rework lineage</summary>
        <ol>
          {input.lineage.map((entry) => (
            <li key={`${entry.predecessorClaimId}-${entry.successorClaimId}`}>
              Proposal {shortClaimId(entry.predecessorClaimId)} →{" "}
              {shortClaimId(entry.successorClaimId)}
              {" · "}Reworked · {formatDate(entry.reworkedAt)}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function shortClaimId(claimId: string): string {
  return claimId.slice(-12);
}

function ObjectiveSuggestionCard(input: {
  source: NonNullable<TrustedObjectiveState["source"]>;
  busy: boolean;
  announce: (message: string) => void;
  visibility?: TrustedObjectiveState["initiative"]["effectiveVisibility"];
  authority?: TrustedObjectiveState["initiative"]["requiredAcceptanceAuthority"];
  initialValues?: { objective: string; exactExcerpt: string };
  submitLabel?: string;
  onCancel?: () => void;
  recoveryOutcome?: TrustedObjectiveState["lastProposalRecovery"];
  createProposal: (values: {
    objective: string;
    exactExcerpt: string;
    supportConfirmed: true;
  }) => Promise<void>;
}) {
  const [objectiveDraft, setObjectiveDraft] = useState<AssistedObjectiveDraft>(() =>
    input.initialValues
      ? { mode: "manual", ...input.initialValues, reason: "rejected" }
      : createAssistedObjectiveDraft(input.source.note)
  );
  const originalSuggestionRef = useRef(objectiveDraft.mode === "suggested" ? objectiveDraft : null);
  const [supportConfirmed, setSupportConfirmed] = useState(false);
  const [correctingEvidence, setCorrectingEvidence] = useState(false);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const exactEvidenceRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const pendingFocusRef = useRef<AssistedObjectiveFocusTarget | null>(null);
  const isSuggested = objectiveDraft.mode === "suggested";
  const showManualEvidence = !isSuggested || correctingEvidence;
  const controlsDisabled = input.busy;

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    if (
      focusAssistedObjectiveTarget(target, {
        objective: objectiveRef.current,
        evidence: exactEvidenceRef.current
      })
    ) {
      pendingFocusRef.current = null;
    }
  }, [correctingEvidence, objectiveDraft.mode]);

  function setObjective(objective: string) {
    setSupportConfirmed(false);
    setObjectiveDraft((current) => ({ ...current, objective }));
  }

  function setExactExcerpt(exactExcerpt: string) {
    setSupportConfirmed(false);
    setObjectiveDraft((current) => ({ ...current, exactExcerpt }));
  }

  function useSelection() {
    const field = sourceRef.current;
    if (!field || field.selectionStart === field.selectionEnd) {
      input.announce("Select an exact excerpt in the engagement note first.");
      return;
    }
    setExactExcerpt(field.value.slice(field.selectionStart, field.selectionEnd));
    input.announce("Selected excerpt is ready to support the proposed objective.");
  }

  function correctEvidence() {
    pendingFocusRef.current = "evidence";
    setCorrectingEvidence(true);
    input.announce("Manual evidence correction controls ready.");
  }

  function rejectSuggestion() {
    setSupportConfirmed(false);
    setObjectiveDraft((current) => {
      const original = originalSuggestionRef.current;
      if (original && current.objective !== original.objective) {
        pendingFocusRef.current = "evidence";
      } else {
        pendingFocusRef.current = "objective";
      }
      return original
        ? rejectAssistedObjectivePreservingEdits(current, original)
        : rejectAssistedObjective();
    });
    setCorrectingEvidence(false);
    input.announce("Suggestion rejected. Manual objective entry ready.");
  }

  return (
    <section className="workflow-card suggestion-card" aria-labelledby="proposal-title">
      <p className="step">2 of 3 · Prepare proposal</p>
      <h2 id="proposal-title" data-step-heading tabIndex={-1}>
        {isSuggested ? "Review objective suggestion" : "Enter the primary objective manually"}
      </h2>

      {input.recoveryOutcome && (
        <div className="recovery-outcome" role="status">
          <strong>{proposalRecoveryOutcome(input.recoveryOutcome)}</strong>
          <p>
            The terminal proposal remains in audit history. A fresh proposal may now be prepared.
          </p>
        </div>
      )}

      {isSuggested ? (
        <>
          <p className="trust-label suggested-label">Suggested proposal · not accepted</p>
          <p>
            Inspect the prefilled objective and candidate excerpt. This browser-only suggestion has
            no durable confidence, has not been server-verified, does not accept the objective as
            trusted memory, and has not created a Claim.
          </p>
        </>
      ) : input.initialValues ? (
        <p className="manual-explanation">
          Review the predecessor as preparation only. It remains durable until this replacement is
          submitted atomically. Treat the excerpt as a candidate until the server verifies it.
        </p>
      ) : (
        <p className="manual-explanation">{manualExplanation(objectiveDraft.reason)}</p>
      )}

      <label htmlFor="objective">Proposed primary objective</label>
      <textarea
        id="objective"
        ref={objectiveRef}
        value={objectiveDraft.objective}
        onChange={(event) => setObjective(event.target.value)}
        disabled={controlsDisabled}
        rows={3}
        placeholder="State the Initiative’s primary objective in plain language."
      />

      <label htmlFor="exact-excerpt">Candidate supporting excerpt</label>
      <textarea
        id="exact-excerpt"
        ref={exactEvidenceRef}
        value={objectiveDraft.exactExcerpt}
        onChange={(event) => setExactExcerpt(event.target.value)}
        readOnly={isSuggested && !correctingEvidence}
        disabled={controlsDisabled}
        rows={3}
      />

      {isSuggested && !correctingEvidence && (
        <button
          className="secondary"
          type="button"
          disabled={controlsDisabled}
          onClick={correctEvidence}
        >
          Correct evidence manually
        </button>
      )}

      {showManualEvidence ? (
        <div className="manual-evidence" aria-labelledby="manual-evidence-title">
          <h3 id="manual-evidence-title">Select exact evidence from the captured source</h3>
          <label htmlFor="captured-source">{input.source.title}</label>
          <textarea
            id="captured-source"
            ref={sourceRef}
            value={input.source.note}
            readOnly
            disabled={controlsDisabled}
            rows={10}
            className="source-text"
          />
          <button
            className="secondary"
            type="button"
            disabled={controlsDisabled}
            onClick={useSelection}
          >
            Use selected excerpt
          </button>
        </div>
      ) : (
        <details>
          <summary>Inspect captured source</summary>
          <div className="evidence-panel">
            <p>
              <strong>{input.source.title}</strong>
            </p>
            <SourceContext source={input.source.note} candidate={objectiveDraft.exactExcerpt} />
          </div>
        </details>
      )}

      {isSuggested && (
        <button
          className="text-action"
          type="button"
          disabled={controlsDisabled}
          onClick={rejectSuggestion}
        >
          Reject suggestion and enter manually
        </button>
      )}

      <label className="support-confirmation">
        <input
          type="checkbox"
          checked={supportConfirmed}
          disabled={controlsDisabled}
          onChange={(event) => setSupportConfirmed(event.target.checked)}
        />
        I confirm that this exact excerpt semantically supports this exact objective.
      </label>

      <div className="proposal-action">
        <p>
          Visibility: {input.visibility ?? "Workspace"} · Acceptance authority:{" "}
          {input.authority ?? "Initiative owner"}. The server will independently verify the exact
          excerpt before creating a Proposed Claim.
        </p>
        <button
          className="primary"
          disabled={
            controlsDisabled ||
            objectiveDraft.objective.trim() === "" ||
            objectiveDraft.exactExcerpt.trim() === "" ||
            !supportConfirmed
          }
          onClick={() =>
            void input.createProposal({
              objective: objectiveDraft.objective,
              exactExcerpt: objectiveDraft.exactExcerpt,
              supportConfirmed: true
            })
          }
        >
          {input.submitLabel ?? "Create proposed objective"}
        </button>
        {input.onCancel && (
          <button className="secondary" disabled={controlsDisabled} onClick={input.onCancel}>
            Back to proposal review
          </button>
        )}
      </div>
    </section>
  );
}

function SourceContext(input: { source: string; candidate: string }) {
  const index = input.candidate ? input.source.indexOf(input.candidate) : -1;
  if (index < 0) return <p className="source-inspection">{input.source}</p>;
  return (
    <p className="source-inspection">
      {input.source.slice(0, index)}
      <mark>{input.candidate}</mark>
      {input.source.slice(index + input.candidate.length)}
    </p>
  );
}

function manualExplanation(reason: Extract<AssistedObjectiveDraft, { mode: "manual" }>["reason"]) {
  if (reason === "conflicting") {
    return "Throughline found competing objective statements and did not choose between them. Select the exact evidence and enter the objective manually.";
  }
  if (reason === "ambiguous") {
    return "Throughline could not identify one unique supporting excerpt. Select the exact evidence and enter the objective manually.";
  }
  if (reason === "rejected") {
    return "The suggestion was rejected locally. Select the exact evidence and enter the objective manually.";
  }
  return "Throughline did not find one safe objective in this note. Select the exact evidence and enter the objective manually.";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value));
}
