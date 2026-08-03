# B2 Slice 2 owner-review evidence

## Scope

This packet covers the bounded trusted-primary-objective walking slice only:

`SourceArtifact → verified evidence span → Claim → fact_claims → AcceptedFact`

No primary-objective column, parallel truth table, production identity system, send operation, model call, deployment, or merge is included.

## Screenshot evidence

- [`proposed-review-mobile.png`](./proposed-review-mobile.png) — mobile Proposed state, exact source/excerpt inspection, and explicit acceptance action.
- [`accepted-trusted-memory-desktop.png`](./accepted-trusted-memory-desktop.png) — Accepted trusted memory with objective, Proposed → Accepted transition, accepter/time, effective visibility, rationale, source, and exact excerpt.
- [`confirmation-draft-not-sent.png`](./confirmation-draft-not-sent.png) — deterministic confirmation question marked `Not sent` and `Sent: false`.
- [`unavailable-generic-separate-context.png`](./unavailable-generic-separate-context.png) — generic unavailable behavior from a separately configured web-server session and browser context.

The screenshots contain no product-visible persona control or label. The local Next development-tools portal was removed before capture; no product DOM or trust data was altered.

## Browser proof

The representative flow was performed from the Initiative page after normal development setup, without CLI or direct API assistance during the user journey:

1. Paste and capture the engagement note.
2. Select the exact Maya sentence from the read-only captured source.
3. Enter and propose the normalized primary objective.
4. Inspect `Proposed, not accepted.` plus the exact evidence.
5. Explicitly accept the objective.
6. Inspect the durable trusted-memory presentation.
7. Draft the deterministic local confirmation question.
8. Draft again and verify byte-identical rendered content (`same: true`).

The owner journey created the demonstrated SourceArtifact, Claim, and AcceptedFact through the browser workflow. Demo setup seeded only prerequisites; before the journey, database counts were `0 SourceArtifact / 0 Claim / 0 AcceptedFact`.

To reproduce the unavailable proof, stop the owner API session and start a new API session with `AUTH_ADAPTER=dev` and exact startup configuration `TRUSTED_OBJECTIVE_DEMO_PERSONA=unavailable`. The web server has no persona configuration. Open the same Initiative URL in a separate browser context. Its rendered text must contain only the generic unavailable message and disclose no Initiative title, objective, source, excerpt, hashes, counts, Claim/Fact state, or other protected metadata.

## Accessibility and responsive checklist

Verified in browser snapshots and visual captures:

- one `main` landmark and semantic heading order;
- labels for engagement note, captured source, exact excerpt, and objective fields;
- keyboard text selection support via native `selectionStart` / `selectionEnd`;
- read-only captured-source field;
- status updates through `role="status"` and `aria-live="polite"`;
- disclosure controls for evidence/rationale;
- visible `:focus-visible` treatment;
- no horizontal overflow or clipped mobile content at 390 px;
- primary action remains obvious at each state;
- generic unavailable state uses one non-disclosing heading and explanation.

## Five-minute representative-user test

Use the setup and script in the repository root [`README.md`](../../../README.md#b2-slice-2-local-browser-demo).

Success criteria:

- the user understands that captured source is not yet trusted memory;
- the user can select the exact supporting sentence and propose the objective without assistance;
- the Proposed → Accepted transition is visible and understandable;
- source, exact excerpt, rationale, visibility, accepter, and acceptance time are reachable without leaving the Initiative;
- confirmation drafting is clearly unsent;
- the unavailable session does not reveal whether the Initiative or trusted memory exists.

Human usability-testing completion is not claimed. This packet records deterministic engineering/browser QA; an owner or representative user should perform the five-minute script before merge consideration.

## Merge recommendation boundary

A merge recommendation is contingent on exact-head full gates, independent exact-head review, and GitHub CI. This branch must remain unmerged and undeployed until the owner grants separate authority.
