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

type ObjectiveAction =
  | "source"
  | "proposal"
  | "proposal/withdraw"
  | "proposal/rework"
  | "accept"
  | "supersede"
  | "revoke"
  | "draft-confirmation";

type ObjectiveAct = (
  action: ObjectiveAction,
  values?: Record<string, string | number | boolean>
) => Promise<void | undefined>;

type RevokeReason = "no_longer_true" | "support_invalidated" | "entered_in_error";

const REVOKE_REASONS: ReadonlyArray<{ value: RevokeReason; label: string }> = [
  { value: "no_longer_true", label: "It is no longer true" },
  { value: "support_invalidated", label: "Its supporting evidence is no longer valid" },
  { value: "entered_in_error", label: "It was recorded in error" }
];

export function TrustedObjectiveExperience(input: { initiativeId: string }) {
  const [state, setState] = useState<TrustedObjectiveState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("Loading Initiative");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<ConfirmationDraft | null>(null);
  const [reworking, setReworking] = useState(false);
  const [suggestingUpdate, setSuggestingUpdate] = useState(false);
  const [recoveryIntent, setRecoveryIntent] = useState<"withdrawn" | "rejected" | null>(null);
  const [recoveryReason, setRecoveryReason] = useState<ProposalRecoveryReason | "">("");
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalReason, setRemovalReason] = useState<RevokeReason | "">("");
  const [removalRationale, setRemovalRationale] = useState("");
  const [removalConfirmed, setRemovalConfirmed] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [postFailureFocusEpoch, setPostFailureFocusEpoch] = useState(0);
  const requestOwnerRef = useRef<symbol | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null);
  const unavailableHeadingRef = useRef<HTMLHeadingElement>(null);
  const restoreReviewFocusRef = useRef(false);
  const hasRenderedSuccessfulStateRef = useRef(false);

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
    action: ObjectiveAction,
    values: Record<string, string | number | boolean> = {}
  ): Promise<void | undefined> {
    return runSingleFlight(requestOwnerRef, setBusy, async () => {
      setAnnouncement("Saving");
      setFailureMessage(null);
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
          setSuggestingUpdate(false);
          setRecoveryIntent(null);
          setRecoveryReason("");
          setRemovalOpen(false);
          const message =
            response.status === 409
              ? "This objective changed before your action completed. No unconfirmed change occurred. The current Initiative objective was refreshed."
              : "The request could not be completed. No unconfirmed change occurred. The current Initiative objective was refreshed.";
          await load(message);
          setFailureMessage(message);
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
          setSuggestingUpdate(false);
          setRecoveryIntent(null);
          setRecoveryReason("");
          setRemovalOpen(false);
          setRemovalReason("");
          setRemovalRationale("");
          setRemovalConfirmed(false);
          if (action === "supersede") {
            setAnnouncement(
              "Objective updated. The previous objective remains in history. Nothing was sent."
            );
          } else if (action === "revoke") {
            setAnnouncement(
              "Objective removed. No current primary objective remains. Nothing was sent."
            );
          } else if (action === "proposal/withdraw" && next.acceptedMemory) {
            setAnnouncement("Current objective kept. The suggested update was not applied.");
          } else {
            setAnnouncement(
              action === "proposal/withdraw" && next.lastProposalRecovery
                ? `${proposalRecoveryOutcome(next.lastProposalRecovery)} ${nextActionForState(next)} ready.`
                : `${nextActionForState(next)} ready`
            );
          }
        }
      } catch {
        setReworking(false);
        setSuggestingUpdate(false);
        setRecoveryIntent(null);
        setRecoveryReason("");
        setRemovalOpen(false);
        const message =
          "The request could not be completed. No unconfirmed change occurred. The current Initiative objective was refreshed.";
        await load(message);
        setFailureMessage(message);
        setPostFailureFocusEpoch((epoch) => epoch + 1);
      }
    });
  }

  async function refreshCurrentObjective() {
    return runSingleFlight(requestOwnerRef, setBusy, async () => {
      setAnnouncement("Refreshing current objective");
      await load("Current Initiative objective refreshed.");
      setFailureMessage(null);
    });
  }

  useEffect(() => {
    if (unavailable) {
      unavailableHeadingRef.current?.focus();
      return;
    }
    if (!state) return;
    if (!hasRenderedSuccessfulStateRef.current) {
      hasRenderedSuccessfulStateRef.current = true;
      return;
    }
    if (removalOpen) {
      document.querySelector<HTMLElement>("[data-removal-heading]")?.focus();
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
  }, [
    state?.state,
    state?.acceptedMemory?.factId,
    state?.replacementReview?.replacementClaimId,
    reworking,
    suggestingUpdate,
    recoveryIntent,
    removalOpen,
    unavailable,
    postFailureFocusEpoch
  ]);

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

  function beginRemoval() {
    setRemovalReason("");
    setRemovalRationale("");
    setRemovalConfirmed(false);
    setRemovalOpen(true);
    setAnnouncement("Remove current objective confirmation ready.");
  }

  function cancelRemoval() {
    setRemovalOpen(false);
    setRemovalReason("");
    setRemovalRationale("");
    setRemovalConfirmed(false);
    setAnnouncement("Current objective restored. No change was made.");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          Throughline
        </Link>
      </header>
      <main className="initiative-surface">
        <p className="action-announcement" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {unavailable ? (
          <section className="unavailable" aria-labelledby="unavailable-title">
            <p className="unavailable-context">Throughline · Initiative</p>
            <h1 id="unavailable-title" ref={unavailableHeadingRef} tabIndex={-1}>
              This Initiative is unavailable.
            </h1>
            <p>It may not exist, or you may not be able to open it.</p>
          </section>
        ) : !state ? (
          <p>Loading Initiative…</p>
        ) : (
          <>
            {failureMessage && (
              <section className="failure-notice" aria-labelledby="failure-title">
                <h2 id="failure-title">Current objective rechecked</h2>
                <p>{failureMessage}</p>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void refreshCurrentObjective()}
                >
                  Refresh current objective
                </button>
              </section>
            )}
            <header className="initiative-header" aria-label="Initiative context">
              <p className="initiative-context">
                {state.initiative.organizationName} <span aria-hidden="true">·</span>{" "}
                {state.initiative.title}
              </p>
            </header>

            {state.state === "empty" && (
              <section className="workflow-card" aria-labelledby="capture-title">
                <h1 id="capture-title" data-step-heading tabIndex={-1}>
                  Capture the engagement note
                </h1>
                <p>Nothing becomes current until you review and confirm it.</p>
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

            {state.state === "captured" && state.source && !state.proposal && (
              <ObjectiveSuggestionCard
                key={`${state.source.capturedAt}-${state.proposalGenerationAnchor}-${state.sourceRevisionAnchor}`}
                source={state.source}
                busy={busy}
                announce={setAnnouncement}
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
                <h1 id="review-title" ref={reviewHeadingRef} data-step-heading tabIndex={-1}>
                  An objective is ready for your review
                </h1>
                <p className="trust-label proposed-label">Suggested update · Not applied</p>
                <blockquote className="objective-quote">{state.proposal.objective}</blockquote>
                <EvidenceDisclosure
                  sourceTitle={state.proposal.sourceTitle}
                  exactExcerpt={state.proposal.exactExcerpt}
                  relevantDate={state.source?.capturedAt}
                  status="Suggested, not current"
                  supportStatement="This excerpt supports the suggested objective. It does not establish that the objective is current or that anything was sent."
                  visibility={state.initiative.effectiveVisibility}
                />
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
                      Use this objective
                    </button>
                  ) : (
                    <p>Only the current Initiative owner can accept this proposed memory.</p>
                  )
                ) : (
                  <p>
                    This earlier proposal has no durable human support confirmation. Rework it with
                    fresh evidence confirmation before acceptance.
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
                        Edit suggestion
                      </button>
                    )}
                    {state.proposal.canWithdraw && (
                      <button
                        className="text-action"
                        disabled={busy}
                        onClick={() => openRecovery("withdrawn")}
                      >
                        Withdraw suggestion
                      </button>
                    )}
                    {state.proposal.canReject && (
                      <button
                        className="text-action"
                        disabled={busy}
                        onClick={() => openRecovery("rejected")}
                      >
                        Reject suggestion
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
                      Confirm suggestion{" "}
                      {recoveryIntent === "rejected" ? "rejection" : "withdrawal"}
                    </h3>
                    <p>
                      This suggestion will not be applied. It remains in history and cannot be used
                      later.
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

            {state.acceptedMemory && state.replacementReview && state.proposal ? (
              <ReplacementReviewSurface
                state={state}
                busy={busy}
                recoveryIntent={recoveryIntent}
                recoveryReason={recoveryReason}
                reviewHeadingRef={reviewHeadingRef}
                recoveryHeadingRef={recoveryHeadingRef}
                setRecoveryReason={setRecoveryReason}
                openRecovery={openRecovery}
                cancelRecovery={cancelRecovery}
                act={act}
              />
            ) : state.acceptedMemory && suggestingUpdate && state.source ? (
              <ObjectiveSuggestionCard
                key={`update-${state.sourceRevisionAnchor}`}
                source={state.source}
                busy={busy}
                announce={setAnnouncement}
                submitLabel="Review suggested update"
                onCancel={() => {
                  setSuggestingUpdate(false);
                  setAnnouncement("Current objective restored. No suggestion was submitted.");
                }}
                createProposal={(values) =>
                  act("proposal", {
                    ...values,
                    proposalGenerationAnchor: state.proposalGenerationAnchor,
                    sourceRevisionAnchor: state.sourceRevisionAnchor!
                  })
                }
              />
            ) : state.acceptedMemory ? (
              <CurrentObjectiveSurface
                state={state}
                busy={busy}
                draft={draft}
                removalOpen={removalOpen}
                removalReason={removalReason}
                removalRationale={removalRationale}
                removalConfirmed={removalConfirmed}
                setRemovalReason={setRemovalReason}
                setRemovalRationale={setRemovalRationale}
                setRemovalConfirmed={setRemovalConfirmed}
                beginRemoval={beginRemoval}
                cancelRemoval={cancelRemoval}
                suggestUpdate={() => setSuggestingUpdate(true)}
                act={act}
              />
            ) : state.state === "revoked" && suggestingUpdate && state.source ? (
              <ObjectiveSuggestionCard
                key={`recapture-${state.sourceRevisionAnchor}`}
                source={state.source}
                busy={busy}
                announce={setAnnouncement}
                submitLabel="Review updated objective"
                onCancel={() => {
                  setSuggestingUpdate(false);
                  setAnnouncement("No current objective restored. No suggestion was submitted.");
                }}
                createProposal={(values) =>
                  act("proposal", {
                    ...values,
                    proposalGenerationAnchor: state.proposalGenerationAnchor,
                    sourceRevisionAnchor: state.sourceRevisionAnchor!
                  })
                }
              />
            ) : state.state === "revoked" ? (
              <NoCurrentObjectiveSurface
                busy={busy}
                captureUpdatedObjective={() => setSuggestingUpdate(true)}
              />
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function CurrentObjectiveSurface(input: {
  state: TrustedObjectiveState;
  busy: boolean;
  draft: ConfirmationDraft | null;
  removalOpen: boolean;
  removalReason: RevokeReason | "";
  removalRationale: string;
  removalConfirmed: boolean;
  setRemovalReason: (reason: RevokeReason | "") => void;
  setRemovalRationale: (rationale: string) => void;
  setRemovalConfirmed: (confirmed: boolean) => void;
  beginRemoval: () => void;
  cancelRemoval: () => void;
  suggestUpdate: () => void;
  act: ObjectiveAct;
}) {
  const {
    state,
    busy,
    draft,
    removalOpen,
    removalReason,
    removalRationale,
    removalConfirmed,
    setRemovalReason,
    setRemovalRationale,
    setRemovalConfirmed,
    beginRemoval,
    cancelRemoval,
    suggestUpdate,
    act
  } = input;
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  if (!state.acceptedMemory) return null;
  const changedFrom = state.history.find(
    (entry) => entry.status === "Superseded" && entry.availability === "available"
  );

  function closeRemoval() {
    cancelRemoval();
    requestAnimationFrame(() => removeTriggerRef.current?.focus());
  }

  return (
    <section className="objective-surface" aria-labelledby="memory-title">
      <h1 id="memory-title" className="objective-statement" data-step-heading tabIndex={-1}>
        {state.acceptedMemory.objective}
      </h1>
      <div className="source-line">
        <span>Confirmed · {formatDateOnly(state.acceptedMemory.acceptedAt)} ·</span>
        <EvidenceDisclosure
          engagementTitle={state.initiative.engagementTitle}
          sourceTitle={state.acceptedMemory.sourceTitle}
          exactExcerpt={state.acceptedMemory.exactExcerpt}
          relevantDate={state.acceptedMemory.acceptedAt}
          status="Current objective"
          confirmedBy={state.acceptedMemory.acceptedBy}
          basis={state.acceptedMemory.whyBelieved}
          supportStatement="This evidence supports the current objective. It does not establish that any external message was sent."
          visibility={state.acceptedMemory.effectiveVisibility}
        />
      </div>
      <div className="objective-actions">
        <button className="primary" disabled={busy} onClick={() => void act("draft-confirmation")}>
          Prepare the next conversation
        </button>
        <button className="text-action" disabled={busy} onClick={suggestUpdate}>
          Suggest a revision
        </button>
      </div>
      {draft && (
        <section className="draft" aria-labelledby="draft-title">
          <h3 id="draft-title">Confirmation question</h3>
          <p className="draft-question">{draft.question}</p>
          <p className="draft-boundary">Draft only · not sent</p>
        </section>
      )}
      {(changedFrom || state.acceptedMemory.canRevoke) && (
        <details className="more-disclosure">
          <summary>History and options</summary>
          <div className="more-panel">
            {changedFrom && (
              <section className="history-detail" aria-labelledby="objective-history-title">
                <h3 id="objective-history-title">History</h3>
                <p>{changedFrom.objective}</p>
                <p className="muted">
                  Current until {formatDateOnly(changedFrom.changedAt)}. The earlier objective
                  remains in history.
                </p>
              </section>
            )}
            {state.acceptedMemory.canRevoke &&
              (!removalOpen ? (
                <button
                  ref={removeTriggerRef}
                  className="danger-outline"
                  disabled={busy}
                  onClick={beginRemoval}
                >
                  Remove current objective
                </button>
              ) : (
                <RemovalConfirmation
                  state={state}
                  busy={busy}
                  removalReason={removalReason}
                  removalRationale={removalRationale}
                  removalConfirmed={removalConfirmed}
                  setRemovalReason={setRemovalReason}
                  setRemovalRationale={setRemovalRationale}
                  setRemovalConfirmed={setRemovalConfirmed}
                  cancelRemoval={closeRemoval}
                  act={act}
                />
              ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ReplacementReviewSurface(input: {
  state: TrustedObjectiveState;
  busy: boolean;
  recoveryIntent: "withdrawn" | "rejected" | null;
  recoveryReason: ProposalRecoveryReason | "";
  reviewHeadingRef: { current: HTMLHeadingElement | null };
  recoveryHeadingRef: { current: HTMLHeadingElement | null };
  setRecoveryReason: (reason: ProposalRecoveryReason | "") => void;
  openRecovery: (intent: "withdrawn" | "rejected") => void;
  cancelRecovery: () => void;
  act: ObjectiveAct;
}) {
  const {
    state,
    busy,
    recoveryIntent,
    recoveryReason,
    reviewHeadingRef,
    recoveryHeadingRef,
    setRecoveryReason,
    openRecovery,
    cancelRecovery,
    act
  } = input;
  if (!state.acceptedMemory || !state.replacementReview || !state.proposal) return null;
  const acceptedMemory = state.acceptedMemory;
  const replacementReview = state.replacementReview;

  function keepCurrent() {
    if (state.proposal?.canReject) {
      openRecovery("rejected");
    } else if (state.proposal?.canWithdraw) {
      openRecovery("withdrawn");
    }
  }

  return (
    <section className="objective-surface replacement-review" aria-labelledby="replacement-title">
      <h1 id="replacement-title" ref={reviewHeadingRef} data-step-heading tabIndex={-1}>
        An objective update is ready for your review
      </h1>
      <div className="objective-comparison">
        <section aria-labelledby="current-objective-label">
          <h3 id="current-objective-label">Current</h3>
          <p className="comparison-objective">{state.replacementReview.changePreview.from}</p>
        </section>
        <section aria-labelledby="suggested-objective-label">
          <h3 id="suggested-objective-label">Suggested update</h3>
          <p className="comparison-objective">{state.replacementReview.changePreview.to}</p>
          <p className="suggestion-boundary">Suggested from the latest engagement · Not applied</p>
        </section>
      </div>
      <p className="review-boundary">
        The current objective stays in place until you approve this update. Approving moves it to
        history. Nothing is sent.
      </p>
      {recoveryIntent ? (
        <ProposalRecoveryConfirmation
          state={state}
          busy={busy}
          recoveryIntent={recoveryIntent}
          recoveryReason={recoveryReason}
          recoveryHeadingRef={recoveryHeadingRef}
          setRecoveryReason={setRecoveryReason}
          cancelRecovery={cancelRecovery}
          act={act}
        />
      ) : (
        <>
          <div className="objective-actions">
            {state.replacementReview.canSupersede && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act("supersede", {
                    factId: acceptedMemory.factId,
                    expectedFactVersion: acceptedMemory.version,
                    replacementClaimId: replacementReview.replacementClaimId,
                    expectedReplacementClaimVersion: replacementReview.replacementClaimVersion,
                    expectedInitiativeVersion: state.initiative.version,
                    reasonCode: "accepted_value_changed",
                    rationale:
                      "The latest engagement established the reviewed primary objective update."
                  })
                }
              >
                Use updated objective
              </button>
            )}
            {(state.proposal.canReject || state.proposal.canWithdraw) && (
              <button
                className={state.replacementReview.canSupersede ? "secondary" : "primary"}
                disabled={busy}
                onClick={keepCurrent}
              >
                Keep current
              </button>
            )}
          </div>
        </>
      )}
      <div className="review-evidence" aria-label="Objective evidence">
        <section aria-labelledby="current-evidence-title">
          <h3 id="current-evidence-title">Current objective evidence</h3>
          <EvidenceDisclosure
            sourceTitle={acceptedMemory.sourceTitle}
            exactExcerpt={acceptedMemory.exactExcerpt}
            relevantDate={acceptedMemory.acceptedAt}
            status="Current objective"
            confirmedBy={acceptedMemory.acceptedBy}
            basis={acceptedMemory.whyBelieved}
            supportStatement="This evidence supports the current objective. It does not establish that the suggested update is current."
            visibility={acceptedMemory.effectiveVisibility}
          />
        </section>
        <section aria-labelledby="suggested-evidence-title">
          <h3 id="suggested-evidence-title">Suggested update evidence</h3>
          <EvidenceDisclosure
            sourceTitle={replacementReview.sourceTitle}
            exactExcerpt={replacementReview.exactExcerpt}
            relevantDate={state.source?.capturedAt}
            status="Suggested update, not current"
            supportStatement="This evidence supports the suggested wording. It does not establish approval, change the current objective, or send anything."
            visibility={state.initiative.effectiveVisibility}
          />
        </section>
      </div>
    </section>
  );
}

function NoCurrentObjectiveSurface(input: { busy: boolean; captureUpdatedObjective: () => void }) {
  return (
    <section className="objective-surface empty-objective" aria-labelledby="no-objective-title">
      <h1 id="no-objective-title" data-step-heading tabIndex={-1}>
        No current primary objective
      </h1>
      <p>The previous objective is no longer current. Its history remains.</p>
      <button className="primary" disabled={input.busy} onClick={input.captureUpdatedObjective}>
        Capture updated objective
      </button>
    </section>
  );
}

function RemovalConfirmation(input: {
  state: TrustedObjectiveState;
  busy: boolean;
  removalReason: RevokeReason | "";
  removalRationale: string;
  removalConfirmed: boolean;
  setRemovalReason: (reason: RevokeReason | "") => void;
  setRemovalRationale: (rationale: string) => void;
  setRemovalConfirmed: (confirmed: boolean) => void;
  cancelRemoval: () => void;
  act: ObjectiveAct;
}) {
  const {
    state,
    busy,
    removalReason,
    removalRationale,
    removalConfirmed,
    setRemovalReason,
    setRemovalRationale,
    setRemovalConfirmed,
    cancelRemoval,
    act
  } = input;
  if (!state.acceptedMemory) return null;
  const acceptedMemory = state.acceptedMemory;
  return (
    <section
      className="removal-confirmation"
      aria-labelledby="removal-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelRemoval();
        }
      }}
    >
      <h3 id="removal-title" data-removal-heading tabIndex={-1}>
        Remove current objective?
      </h3>
      <p className="effect-copy">
        This leaves the Initiative without a current objective. The objective and its evidence
        remain in history. Nothing is sent.
      </p>
      <label htmlFor="removal-reason">Why are you removing it?</label>
      <select
        id="removal-reason"
        value={removalReason}
        disabled={busy}
        onChange={(event) => setRemovalReason(event.target.value as RevokeReason | "")}
      >
        <option value="">Choose a reason</option>
        {REVOKE_REASONS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor="removal-rationale">Brief explanation</label>
      <textarea
        id="removal-rationale"
        value={removalRationale}
        disabled={busy}
        maxLength={2000}
        rows={3}
        onChange={(event) => setRemovalRationale(event.target.value)}
      />
      <label className="support-confirmation">
        <input
          type="checkbox"
          checked={removalConfirmed}
          disabled={busy}
          onChange={(event) => setRemovalConfirmed(event.target.checked)}
        />
        I understand this Initiative will have no current objective.
      </label>
      <div className="confirmation-actions">
        <button className="secondary" disabled={busy} onClick={cancelRemoval}>
          Cancel
        </button>
        <button
          className="danger-outline"
          disabled={
            busy || removalReason === "" || removalRationale.trim() === "" || !removalConfirmed
          }
          onClick={() =>
            void act("revoke", {
              factId: acceptedMemory.factId,
              expectedFactVersion: acceptedMemory.version,
              reasonCode: removalReason,
              rationale: removalRationale.trim()
            })
          }
        >
          Remove current objective
        </button>
      </div>
    </section>
  );
}

function EvidenceDisclosure(input: {
  engagementTitle?: string;
  sourceTitle: string;
  exactExcerpt: string;
  relevantDate?: string | undefined;
  status: string;
  confirmedBy?: string;
  basis?: string;
  supportStatement: string;
  visibility?: TrustedObjectiveState["initiative"]["effectiveVisibility"];
}) {
  const summaryRef = useRef<HTMLElement>(null);
  const reviewSummaryRef = useRef<HTMLElement>(null);
  return (
    <details
      className="evidence-disclosure"
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.preventDefault();
          event.currentTarget.open = false;
          summaryRef.current?.focus();
        }
      }}
    >
      <summary ref={summaryRef}>Source</summary>
      <div className="evidence-panel">
        <p className="source-kicker">Exact excerpt</p>
        <blockquote>{input.exactExcerpt}</blockquote>
        <p className="source-meta">
          {input.engagementTitle && (
            <>
              <span>{input.engagementTitle}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>{input.sourceTitle}</span>
          <span aria-hidden="true">·</span>
          <span>
            {input.relevantDate ? formatDateOnly(input.relevantDate) : "Date not available"}
          </span>
        </p>
        <details
          className="review-details"
          onKeyDown={(event) => {
            if (event.key === "Escape" && event.currentTarget.open) {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.open = false;
              reviewSummaryRef.current?.focus();
            }
          }}
        >
          <summary ref={reviewSummaryRef}>Review details</summary>
          <div className="review-details-content">
            {input.basis && <p>{input.basis}</p>}
            <p>
              <strong>Status</strong>
              <br />
              {input.status}
            </p>
            {input.confirmedBy && (
              <p>
                <strong>Confirmed by</strong>
                <br />
                {input.confirmedBy}
              </p>
            )}
            {input.visibility && (
              <p>
                <strong>Visibility</strong>
                <br />
                {input.visibility}
              </p>
            )}
            <p>{input.supportStatement}</p>
            {(input.visibility === "Restricted" || input.visibility === "Confidential") && (
              <p>Visible only to people permitted to view this Initiative.</p>
            )}
          </div>
        </details>
      </div>
    </details>
  );
}

function ProposalRecoveryConfirmation(input: {
  state: TrustedObjectiveState;
  busy: boolean;
  recoveryIntent: "withdrawn" | "rejected";
  recoveryReason: ProposalRecoveryReason | "";
  recoveryHeadingRef: { current: HTMLHeadingElement | null };
  setRecoveryReason: (reason: ProposalRecoveryReason | "") => void;
  cancelRecovery: () => void;
  act: ObjectiveAct;
}) {
  const {
    state,
    busy,
    recoveryIntent,
    recoveryReason,
    recoveryHeadingRef,
    setRecoveryReason,
    cancelRecovery,
    act
  } = input;
  if (!state.proposal) return null;
  return (
    <section
      className="recovery-confirmation"
      aria-labelledby="keep-current-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelRecovery();
        }
      }}
    >
      <h3 id="keep-current-title" ref={recoveryHeadingRef} tabIndex={-1}>
        Keep the current objective?
      </h3>
      <p>
        The current objective will stay unchanged. The suggested update will remain in history as
        not applied.
      </p>
      <label htmlFor="keep-current-reason">Why are you keeping the current objective?</label>
      <select
        id="keep-current-reason"
        value={recoveryReason}
        disabled={busy}
        onChange={(event) => setRecoveryReason(event.target.value as ProposalRecoveryReason | "")}
      >
        <option value="">Choose a reason</option>
        {PROPOSAL_RECOVERY_REASONS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <div className="confirmation-actions">
        <button className="secondary" disabled={busy} onClick={cancelRecovery}>
          Back to review
        </button>
        <button
          className="secondary"
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
          Confirm keep current
        </button>
      </div>
    </section>
  );
}

function ObjectiveSuggestionCard(input: {
  source: NonNullable<TrustedObjectiveState["source"]>;
  busy: boolean;
  announce: (message: string) => void;
  initialValues?: { objective: string; exactExcerpt: string };
  submitLabel?: string;
  onCancel?: () => void;
  recoveryOutcome?: TrustedObjectiveState["lastProposalRecovery"];
  createProposal: (values: {
    objective: string;
    exactExcerpt: string;
    supportConfirmed: true;
  }) => Promise<void | undefined>;
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
      <h1 id="proposal-title" data-step-heading tabIndex={-1}>
        {isSuggested ? "Review objective suggestion" : "Enter the primary objective manually"}
      </h1>

      {input.recoveryOutcome && (
        <div className="recovery-outcome" role="status">
          <strong>{proposalRecoveryOutcome(input.recoveryOutcome)}</strong>
          <p>The earlier suggestion remains in history. You can prepare a new one now.</p>
        </div>
      )}

      {isSuggested ? (
        <>
          <p className="trust-label suggested-label">
            Suggested from the latest engagement · Not applied
          </p>
          <p>
            Review the wording and its supporting excerpt. Nothing changes until you submit and
            approve it.
          </p>
        </>
      ) : input.initialValues ? (
        <p className="manual-explanation">
          Review the earlier suggestion as a starting point. It remains unchanged until this update
          is submitted. Treat the excerpt as a candidate until it is verified.
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
        <p>The exact excerpt will be checked before this suggestion is saved for review.</p>
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

function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC"
  }).format(new Date(value));
}
