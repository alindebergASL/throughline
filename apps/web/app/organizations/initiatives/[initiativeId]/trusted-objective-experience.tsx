"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  demoActionEnvelope,
  nextActionForState,
  type ConfirmationDraft,
  type TrustedObjectiveState
} from "../../../../lib/trusted-objective";
import {
  createAssistedObjectiveDraft,
  rejectAssistedObjective,
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
  const requestOwnerRef = useRef<symbol | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/demo/initiatives/${encodeURIComponent(input.initiativeId)}/trusted-objective`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error("Unavailable");
      const next = (await response.json()) as TrustedObjectiveState;
      setState(next);
      setUnavailable(false);
      setAnnouncement(`${nextActionForState(next.state)} ready`);
    } catch {
      setUnavailable(true);
      setState(null);
      setAnnouncement("Initiative unavailable");
    }
  }, [input.initiativeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    action: "source" | "proposal" | "accept" | "draft-confirmation",
    values: Record<string, string> = {}
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
          setAnnouncement(
            response.status === 409
              ? "That action no longer matches the current Initiative. Refresh and try again."
              : "The request could not be completed."
          );
          return;
        }
        if (action === "draft-confirmation") {
          const nextDraft = (await response.json()) as ConfirmationDraft;
          setDraft(nextDraft);
          setAnnouncement("Confirmation question drafted. Not sent.");
        } else {
          const next = (await response.json()) as TrustedObjectiveState;
          setState(next);
          setAnnouncement(`${nextActionForState(next.state)} ready`);
        }
      } catch {
        setAnnouncement("The request could not be completed.");
      }
    });
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
              <h1 id="unavailable-title">This Initiative is unavailable.</h1>
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
                  <h2 id="capture-title">Paste the engagement note</h2>
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
                  key={state.source.capturedAt}
                  source={state.source}
                  busy={busy}
                  announce={setAnnouncement}
                  createProposal={(values) => act("proposal", values)}
                />
              )}

              {state.proposal && !state.acceptedMemory && (
                <section className="workflow-card proposed" aria-labelledby="review-title">
                  <p className="step">3 of 3 · Review</p>
                  <h2 id="review-title">Review proposed memory</h2>
                  <p className="trust-label proposed-label">{state.proposal.status}</p>
                  <blockquote>{state.proposal.objective}</blockquote>
                  <details>
                    <summary>Inspect exact source evidence</summary>
                    <div className="evidence-panel">
                      <p>
                        <strong>Source</strong>
                        <br />
                        {state.proposal.sourceTitle}
                      </p>
                      <p>
                        <strong>Exact excerpt</strong>
                      </p>
                      <blockquote>{state.proposal.exactExcerpt}</blockquote>
                      <p>
                        This source remains untrusted evidence until you accept the proposed memory.
                      </p>
                    </div>
                  </details>
                  <button className="primary" disabled={busy} onClick={() => void act("accept")}>
                    Accept objective
                  </button>
                </section>
              )}

              {state.acceptedMemory && (
                <section className="trusted-memory" aria-labelledby="memory-title">
                  <div className="accepted-heading">
                    <div>
                      <p className="step">Trusted memory</p>
                      <h2 id="memory-title">Primary objective</h2>
                    </div>
                    <span className="trust-label accepted-label">
                      {state.acceptedMemory.status}
                    </span>
                  </div>
                  <blockquote className="objective-quote">
                    {state.acceptedMemory.objective}
                  </blockquote>
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

function ObjectiveSuggestionCard(input: {
  source: NonNullable<TrustedObjectiveState["source"]>;
  busy: boolean;
  announce: (message: string) => void;
  createProposal: (values: { objective: string; exactExcerpt: string }) => Promise<void>;
}) {
  const [objectiveDraft, setObjectiveDraft] = useState<AssistedObjectiveDraft>(() =>
    createAssistedObjectiveDraft(input.source.note)
  );
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
    setObjectiveDraft((current) => ({ ...current, objective }));
  }

  function setExactExcerpt(exactExcerpt: string) {
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
    pendingFocusRef.current = "objective";
    setObjectiveDraft(rejectAssistedObjective());
    setCorrectingEvidence(false);
    input.announce("Suggestion rejected. Manual objective entry ready.");
  }

  return (
    <section className="workflow-card suggestion-card" aria-labelledby="proposal-title">
      <p className="step">2 of 3 · Prepare proposal</p>
      <h2 id="proposal-title">
        {isSuggested ? "Review objective suggestion" : "Enter the primary objective manually"}
      </h2>

      {isSuggested ? (
        <>
          <p className="trust-label suggested-label">Suggested proposal · not accepted</p>
          <p>
            Inspect the prefilled objective and exact evidence. This browser-only suggestion has not
            created a Claim or changed shared truth.
          </p>
        </>
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

      <label htmlFor="exact-excerpt">Exact supporting evidence</label>
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
            <p className="source-inspection">{input.source.note}</p>
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

      <div className="proposal-action">
        <p>
          Create a Proposed Claim for separate review. This action does not accept the objective as
          truth.
        </p>
        <button
          className="primary"
          disabled={
            controlsDisabled ||
            objectiveDraft.objective.trim() === "" ||
            objectiveDraft.exactExcerpt.trim() === ""
          }
          onClick={() =>
            void input.createProposal({
              objective: objectiveDraft.objective,
              exactExcerpt: objectiveDraft.exactExcerpt
            })
          }
        >
          Create proposed objective
        </button>
      </div>
    </section>
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
