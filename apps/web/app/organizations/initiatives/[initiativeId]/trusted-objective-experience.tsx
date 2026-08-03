"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  demoActionEnvelope,
  nextActionForState,
  type ConfirmationDraft,
  type TrustedObjectiveState
} from "../../../../lib/trusted-objective";

export function TrustedObjectiveExperience(input: { initiativeId: string }) {
  const [state, setState] = useState<TrustedObjectiveState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("Loading Initiative");
  const [note, setNote] = useState("");
  const [objective, setObjective] = useState("");
  const [exactExcerpt, setExactExcerpt] = useState("");
  const [draft, setDraft] = useState<ConfirmationDraft | null>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);

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
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  }

  function useSelection() {
    const field = sourceRef.current;
    if (!field || field.selectionStart === field.selectionEnd) {
      setAnnouncement("Select an exact excerpt in the engagement note first.");
      return;
    }
    const selected = field.value.slice(field.selectionStart, field.selectionEnd);
    setExactExcerpt(selected);
    setAnnouncement("Selected excerpt is ready to support the proposed objective.");
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
                <section className="workflow-card" aria-labelledby="proposal-title">
                  <p className="step">2 of 3 · Propose memory</p>
                  <h2 id="proposal-title">Select the exact supporting excerpt</h2>
                  <p>
                    Select text in the read-only note, then use the selected excerpt. You can also
                    identify the exact text in the field below.
                  </p>
                  <label htmlFor="captured-source">{state.source.title}</label>
                  <textarea
                    id="captured-source"
                    ref={sourceRef}
                    value={state.source.note}
                    readOnly
                    rows={10}
                    className="source-text"
                  />
                  <button className="secondary" type="button" onClick={useSelection}>
                    Use selected excerpt
                  </button>
                  <label htmlFor="exact-excerpt">Exact excerpt</label>
                  <textarea
                    id="exact-excerpt"
                    value={exactExcerpt}
                    onChange={(event) => setExactExcerpt(event.target.value)}
                    rows={3}
                  />
                  <label htmlFor="objective">Proposed primary objective</label>
                  <textarea
                    id="objective"
                    value={objective}
                    onChange={(event) => setObjective(event.target.value)}
                    rows={3}
                    placeholder="State the Initiative’s primary objective in plain language."
                  />
                  <button
                    className="primary"
                    disabled={busy || objective.trim() === "" || exactExcerpt.trim() === ""}
                    onClick={() => void act("proposal", { objective, exactExcerpt })}
                  >
                    Propose trusted objective
                  </button>
                </section>
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value));
}
