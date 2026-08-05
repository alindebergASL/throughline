# B2 Slice 3 assisted-objective owner QA

## Scope and trust boundary

This packet covers deterministic browser-side assistance and the bounded recovery path for an Initiative primary-objective proposal.

The adviser is pure, model-free, provider-free, and ephemeral. Its output is neither a Claim nor accepted truth. Initial proposal and atomic rework requests contain the objective, exact excerpt, and a literal fresh human support confirmation. The API independently derives and verifies source identity, chunk identity, Unicode-scalar offsets, hashes, exact-match uniqueness, authorization, and proposal authority. The durable support attestation is bound to the authenticated actor, exact new Claim, value hash, verified evidence span, and excerpt hash. Explicit proposal and explicit owner acceptance remain separate actions on the existing path:

`SourceArtifact → verified evidence span + human support attestation → Proposed Claim → explicit owner Accept → AcceptedFact`

Migration `0011_b2_primary_objective_proposal_recovery.sql` adds only objective support attestations and objective proposal recovery lineage. It adds no generic Claim/Fact lifecycle, accepted-Fact mutation, provider/model call, external write, telemetry, deployment, or broader predicate.

## Deterministic rule catalog

The catalog now has exactly one rule:

| Rule ID                      | Supported leading assertion                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `explicit_primary_objective` | `The primary objective is to ...` or `Primary objective: to ...` |

Case matching follows the prior case-insensitive behavior. A conventional leading bullet (`-`, `*`, `•`) or ordered-list marker (`1.`, `1)`, up to three digits) is allowed. No other objective, goal, or priority cue is recognized, and the infinitive `to` is mandatory.

The adviser analyzes normalized nonempty logical lines. It suggests only when exactly one line matches the strict objective grammar and every other line is bounded ordinary metadata (`Meeting`, `Participants`, `Attendees`, `Account`, `Organization`, `Engagement`, `Topic`, `Location`, `Facilitator`, `Recorded by`, or `Next meeting`) with safe content. Multiple candidates, unknown narrative/labels, corrections, negation, uncertainty, conditions, approval-bearing content, or objective-like competing content abstain. There is no ranking or prefix-returning sentence extractor.

The exact evidence is the whole trimmed supported source line, including any list marker and optional trailing ASCII period. The adviser never returns a plausible prefix. After the cue is removed, a bounded positive scalar grammar permits only ASCII letters/digits/ordinary spaces; comma, period, apostrophe, and hyphen; Unicode letters, combining marks, and numbers; `U+2019` curly apostrophe; and `Extended_Pictographic` scalars. Every other punctuation, symbol, or whitespace scalar causes abstention. This rejects structural lookalikes without a confusable denylist, including colon, pipe, slash, bracket, hyphen-separator, semicolon, and comma confusables as well as unsupported ASCII structural symbols. A structural Unicode check additionally rejects Variation Selector scalars, modifier letters (`Lm`), and any one letter token that mixes ASCII and non-ASCII base letters. Decomposed ordinary Unicode remains supported when its base letters do not mix, including the retained `Cafe` plus combining accent fixture, the separate Greek word, and the Arabic numeral.

Candidate safety remains deliberately conservative. It rejects uncertainty and dependency language including possible/potential/plausible/conceivable forms; may/might/could; expected and likely/unlikely forms; upon/once/when/whenever; if/unless/until/after/before conditions; assuming/provided/subject-to/contingent/conditional/dependent forms; pending and sign-off/signoff; and any approval/approve or authorization/authorize family word anywhere in the objective body. All uncertainty, conditional, approval, sign-off, negation, disjunction, hostile, and correction predicates run against a safety-only NFKD view with combining marks removed. That view never replaces returned content: exact source and evidence retain their original bytes, and the objective remains derived from the original body under the existing capitalization/final-period behavior. Existing sentence-terminal, control/format-character, malformed, length, and capture-bound checks remain separate and fail closed. The sentence-terminal check permits bounded dotted initialisms such as `U.S.` and `e.g.` without treating an ordinary following sentence as objective text. `U+2019`, `Extended_Pictographic` scalars, and the documented rocket positive remain valid.

The normalized objective removes only the supported leading assertion and optional final ASCII period, preserves the body, capitalizes the first Unicode scalar only when that mapping stays one scalar, and appends one ASCII period. Whole-source exact-match uniqueness remains necessary. The excerpt must also fit wholly within one browser-reproduced `source-chunking.v1` chunk: the canonical 2,000-Unicode-scalar paragraph/line/whitespace/hard-boundary contract from `packages/content/src/source-text.ts`. Processing remains bounded by 100,000 source code units, 320 candidate Unicode scalars, and the existing defensive 32-cue ceiling.

## Fixture coverage and RED evidence

[`apps/web/lib/assisted-objective.spec.ts`](../../../apps/web/lib/assisted-objective.spec.ts) covers:

- the two supported leading infinitive assertions in direct, bullet, and numbered forms, with whole-line exact evidence;
- direct useful wording including `The primary objective is to launch a governed pilot by October.`, direct/list forms, `U.S.`, `e.g.`, straight and curly apostrophes, safe comma/period/hyphen prose, Unicode letters/combining marks/numbers, and the `🚀` positive;
- one realistic multiline note with exactly one safe supported objective line and bounded ordinary metadata;
- abstention for formerly broad cues and multiline notes containing unknown, competing, corrective, conditional, uncertain, approval-bearing, or unsafe content;
- pipe `Foobar`/`Deadline`/`Sponsor`/nested-cue suffixes, parenthesized and no-separator `Deadline` suffixes, comma-embedded `Owner`, slash/dash/bullet separators, additional colons, and bracketed suffixes;
- Unicode `U+2028`, `U+2029`, `U+3002`, `U+FF01`, `U+FF1F`, and another Unicode sentence-terminal boundary;
- structural scalar rejection for `U+FF1A`, `U+FE55`, `U+A789`, `U+2236`, `U+FF5C`, `U+2223`, `U+FF0F`, `U+2215`, fullwidth parentheses/square/curly brackets, `U+2010`, `U+2011`, fullwidth semicolon/comma, the requested unsupported ASCII structural symbols, and nearby punctuation/symbol/non-ordinary-whitespace representatives;
- possible/potential/upon/once/when/whenever/on-condition/pending-sign-off and the wider conservative uncertainty/dependency grammar;
- approval, approvals, approve/approves/approved/approving, authorization/authorizations, and authorize/authorizes/authorized/authorizing anywhere in the objective body;
- abstention rather than prefix extraction for abbreviations, internal sentence punctuation, title-cased continuations, and structured suffixes;
- exact excerpt uniqueness, word support, byte-identical repeated calls, and the closed output shape;
- no cue, unclear/not-agreed/TBD/to-be-determined language, modal/probabilistic/conditional uncertainty, unsafe competing cues, alternatives, competing objectives, repeated evidence, hostile non-human labels, unresolved approval/agreement/review auxiliaries and contractions, withdrawal/replacement/cancellation/invalidity/obsolescence corrections, long-gap challenges, Unicode format/bidi/zero-width controls, realistic conflict, short/oversized/malformed candidates, questions, quoted speculation, and the capture-size limit;
- the retained attribution, correction, prompt-injection, control-character, hostile-action, source/candidate-bound, and canonical 2,000-scalar chunk security regressions;
- deterministic pure draft construction, local value-edit isolation, rejection that clears untouched machine prefill while preserving either user-edited field, and abstention to a blank manual value;
- executable focus-target routing with test doubles, plus static verification that the component wires pending-focus refs through a post-render effect. The unit suite itself does not claim mounted-DOM or browser-focus proof; disposable browser evidence is recorded separately below.
- direct owner-token single-flight behavior with a deferred request, two synchronous invocations, losing-invocation announcement isolation, exact busy events, and stale-owner release protection; plus static verification that the component uses the helper and its controls consume the same busy state. This is helper/static evidence, not a mounted-DOM test.

The required focused RED was observed before the helper existed:

```text
FAIL  lib/assisted-objective.spec.ts
Error: Cannot find module './assisted-objective'
Test Files  1 failed (1)
Tests       no tests
```

Command:

```bash
pnpm --filter @throughline/web exec vitest run lib/assisted-objective.spec.ts --poolOptions.threads.singleThread --no-file-parallelism
```

The bounded corrective regressions were run against the pre-fix helper and component before production changes:

```text
Test Files  2 failed (2)
Tests       59 failed | 74 passed (133)
```

The 59 failures covered abbreviation truncation, standalone and long-gap corrections, discarded unsafe cues, Unicode controls, non-speaker labels, metadata/closing-delimiter folding, cross-chunk evidence, redundant draft state, missing focus routing, and missing ref/effect integration. The independently reproduced two-line `no longer correct` case was included.

For the exact-head corrective pass documented here, all new regressions were added before production changes. Against `96a236a3159ab566e49777b5d848f4970091fe36`, the focused run failed as:

```text
Test Files  2 failed (2)
Tests       54 failed | 145 passed (199)
```

The 54 failures comprised 53 deterministic adviser examples covering every corrective category above and one static component-source assertion for the in-flight request lock. A follow-up nearby-equivalent RED then recorded `2 failed | 171 passed (173)` for `; due date:` metadata and an unrelated conditional next action, preventing the conditional filter from broadening beyond objective-like statements. This is terminal/static evidence only: it does not claim mounted-DOM behavior.

This RED evidence is terminal-only and makes no browser claim. Corrected browser evidence is recorded separately below.

Hermes's three near-neighbor groups were also added before the corresponding production correction. The focused adviser plus trusted-objective run recorded exactly 19 RED failures with 204 neighboring passes: five `should no longer`/`must not`/`cannot`/straight-and-curly-`can't` correction variants, three unknown title-cased continuations after `U.S.`/`U.K.`/`a.m.`, and eleven known model/vendor labels. The same command passed GREEN with 223 tests:

```text
Test Files  2 passed (2)
Tests       223 passed (223)
```

For this structural corrective pass, the complete new reviewer regressions were added before implementation. The focused adviser plus trusted-objective command recorded `69 failed | 220 passed (289)`. The failures covered structural colon attribution (including arbitrary labels), non-candidate governance/correction language without proximity, expanded candidate uncertainty/conditions, generic metadata boundaries, and unknown abbreviation/same-line sentence truncation. After the correction and final exact-repro/numbered-positive additions, the same focused command passed `297 passed (297)`. This is terminal/static evidence only and makes no mounted-browser claim.

For the final structural tightening, tests were added before the helper changed. The focused adviser plus trusted-objective run recorded `8 failed | 317 passed (325)`: `turned down`, `shelved`, separate-line `Maya:`, narrative/heading/unknown-label spans, and empty/overlong neutral metadata. `Governance put the plan on ice` already failed only because the earlier vocabulary scan happened to recognize `governance`; the new structural rule no longer relies on that word. After implementation and neighboring fixture updates, the same command passed `325 passed (325)`. This is terminal/static evidence only and makes no mounted-browser claim.

For the current exact-head simplification, the final reviewer regressions were added before production code changed. The focused adviser plus trusted-objective command recorded:

```text
Test Files  1 failed | 1 passed (2)
Tests       44 failed | 327 passed (371)
```

Those RED failures covered pipe `Foobar`/`Deadline`/`Sponsor`/nested-cue suffixes; parenthesized and no-separator `Deadline`; comma `Owner`, slash, dash, extra-colon, and bracket suffixes; multiline metadata with correction/dependency values; possible/potential/upon/once/when/on-condition/pending-sign-off language; `U+2028`, `U+2029`, `U+3002`, `U+FF01`, and `U+FF1F`; and whole-line list evidence. The astral-Unicode positive already passed. After replacing the prior sentence/metadata catalog with the bounded single-line parser, adapting the former metadata positives to abstention, and adding seven neighboring assertions for the two exact infinitive forms and wider structural punctuation handling, the same command passed:

```text
Test Files  2 passed (2)
Tests       378 passed (378)
```

This evidence is terminal/static only and makes no mounted-browser claim.

For the approval-family safety simplification, the regression table was added before production code changed. The focused adviser plus trusted-objective command recorded:

```text
Test Files  1 failed | 1 passed (2)
Tests       13 failed | 378 passed (391)
```

All 13 failures were approval-family objectives that the prior contextual requirement regex still suggested, including sponsor/regulatory approval, legal authorization, plurals, and approve/authorize verb forms. Replacing that complex detector with one bounded word-family check, while retaining the separate sign-off check, produced:

```text
Test Files  2 passed (2)
Tests       391 passed (391)
```

This evidence is terminal/static only and makes no mounted-browser claim.

For the structural-scalar corrective pass against frozen HEAD `647ba885b6c73f51ecfa317b1ce572800fa94c24` (tree `d6b45c2014efc926db00e4809bad0473a5ce6301`), the 36-row regression table was added before production code changed. The focused adviser plus trusted-objective command recorded:

```text
Test Files  1 failed | 1 passed (2)
Tests       35 failed | 392 passed (427)
```

All requested confusable and unsupported ASCII structural rows failed. The `U+0009` tab representative already abstained through the pre-existing control check, accounting for 35 new failures from 36 rows. After the positive scalar grammar replaced the structural punctuation catalog and the required positive fixtures were established, the same command recorded:

```text
Test Files  2 passed (2)
Tests       427 passed (427)
```

Command:

```bash
pnpm --filter @throughline/web exec vitest run lib/assisted-objective.spec.ts lib/trusted-objective.spec.ts --poolOptions.threads.singleThread --no-file-parallelism
```

This evidence is terminal/static only and makes no mounted-browser claim.

For the final Unicode-safety and synchronous-single-flight corrective pass against frozen HEAD `c54940bd82281e6712b33e3c76ade00b2e5d1d37` (tree `e9fc144b5f7f4eb015f380a6a96da1aa60f5317b`), all regressions were added before production code changed. The final focused RED recorded:

```text
Test Files  2 failed (2)
Tests       18 failed | 427 passed (445)
```

The 18 failures were 16 Unicode safety rows (the three exact reviewer repros plus combining-mark, `U+FE0E`/`U+FE0F`, modifier-letter, and mixed-base-letter neighbors), one deferred single-flight behavior test, and one static component-wiring test. After the bounded safety view, structural checks, owner-token helper, and component integration, the identical focused command recorded:

```text
Test Files  2 passed (2)
Tests       445 passed (445)
```

The ordinary Unicode fixture containing decomposed `Cafe`, a Greek word, and an Arabic numeral remained unchanged and green, as did curly apostrophe, rocket, `U.S.`, and `e.g.` positives. An older capitalization-only `ßeta` fixture was changed to all-non-ASCII `ßήτα` so it continues testing one-scalar capitalization without contradicting the new mixed-base-letter rule. This evidence is terminal helper/static coverage only. It does not claim mounted-DOM or browser behavior; a mounted browser remains a separate owner verification.

## Interaction contract

Clear-note state shows one `Review objective suggestion` card with:

- `Suggested proposal · not accepted` visible before the fields;
- editable prefilled objective;
- exact evidence visible and initially read-only;
- an explicit `Correct evidence manually` control before evidence can be edited;
- post-render focus moves to exact evidence after correction is enabled;
- captured source behind progressive disclosure until correction is requested;
- `Reject suggestion and enter manually`, which clears the suggestion locally;
- post-render focus moves to the objective field after rejection;
- one primary `Create proposed objective` action with copy stating that it creates a Proposed Claim and does not accept truth.
- one explicit semantic-support checkbox; editing the objective or excerpt clears it and submission remains disabled until the human confirms again.
- while that proposal request is in flight, objective/evidence fields, evidence correction, suggestion rejection, and manual-selection controls are disabled from the same request-busy state.
- source capture, proposal creation, acceptance, and confirmation drafting share one synchronous owner-token single-flight lock. A same-tick losing invocation performs no request and changes neither busy state nor the live announcement; only the current owner releases busy state.

Abstained or rejected state shows no prefilled guess. It explains the safe abstention, keeps the captured source read-only and selectable, provides `Use selected excerpt`, and leaves exact excerpt and objective editable. Abstention and rejection perform no write.

Durable Proposed state projects Workspace visibility, Initiative-owner acceptance authority, acceptance availability, and non-leaking management availability. The original proposer can rework or withdraw their active proposal; the current Initiative owner can reject/withdraw and is the only actor who can accept. Rework atomically terminalizes the predecessor as superseded and creates one successor with new evidence and a new support attestation. Withdrawal/rejection terminalizes the predecessor, frees the active slot, and returns to captured preparation. Reload projects only the active Proposed successor; terminal Claims remain immutable history. Legacy unconfirmed proposals cannot be accepted and must be withdrawn or reworked. Deterministic confirmation drafting remains `Not sent`.

## Effort comparison

| Path                   | Proposal preparation                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Slice 2 clear note     | Select evidence, copy the selection into the exact-excerpt field, type the objective, then create the proposal. |
| Slice 3 clear note     | Inspect the prefilled objective and exact evidence, then use one create-proposal action.                        |
| Slice 3 ambiguous note | No effort-reduction claim. Select exact evidence, enter the objective manually, and create the proposal.        |

The clear path requires no manual highlight and no objective retyping when the suggestion is correct. No surveillance or product telemetry was added.

## Owner browser script

Use the disposable local Slice 2 database/API/web setup documented in the repository root. Do not point the script at shared infrastructure.

1. Capture a direct unprefixed clear note and verify exact objective/evidence prefill, the suggested/not-accepted label, and one create-proposal action.
2. Capture a realistic multiline note with safe meeting/participant context and exactly one clear objective line. Verify that line alone is suggested as the candidate excerpt. Then add a second objective, correction, condition, uncertainty, or approval-bearing line and verify blank manual fallback.
3. Edit the suggested objective; explicitly enable evidence correction, select source text, and use the selection.
4. Reject an untouched suggestion and verify both fields clear. Repeat after editing only the objective, only the excerpt, and both; verify every user-edited value is preserved and focus moves to the next useful control.
5. Capture two distinct explicit objectives and verify calm conflicting abstention with no prefilled guess and no write.
6. Capture a note without an explicit cue and verify unsupported abstention with the same manual path.
7. Verify proposal submission is disabled until semantic support is checked. Check it, edit either field, and verify it clears. Re-check, create the proposal, and inspect `Proposed, not accepted.` plus Workspace visibility and Initiative-owner authority.
8. As the proposer, begin rework and verify predecessor values populate preparation without changing durable state. Edit objective/evidence, freshly confirm support, submit, refresh, and verify one active successor. Inspect the database for a superseded predecessor, explicit lineage, new evidence, and a new authenticated support attestation.
9. Withdraw the active proposal, refresh, and verify captured preparation returns, the active slot is free, and Claim/evidence/recovery/audit/outbox history remains. Create a fresh proposal. As current owner but not proposer, repeat the rejection path and verify rework is unavailable.
10. Attempt acceptance of a legacy/unconfirmed proposal and verify fail-closed conflict with no Fact or partial writes. Accept only the active supported successor as the current Initiative owner and inspect accepted memory, accepter/time, visibility, source, and exact excerpt.
11. Draft confirmation twice and verify byte-identical text, `Not sent`, and `Sent: false`.
12. Refresh at captured, Proposed, withdrawn/rejected, reworked, and Accepted states. Verify terminal Claims never project as active or accepted memory.
13. Repeat the generic unavailable check as a non-authorized actor and verify the identical 404 body, zero writes, and no hidden proposer/owner identity.
14. At desktop and 390 px widths, keyboard through every field, disclosure, correction, rejection, rework, withdrawal, manual selection, support confirmation, proposal, Accept, and draft action. Confirm major transitions focus the new heading or first useful field; also check visible focus, live announcements, console errors, clipping, and horizontal overflow.
15. Verify one matching audit row and one versioned outbox event per completed withdraw/reject/rework command. Details must contain only identifiers, versions, disposition/reason, evidence, and attestation references—never source or objective text.

## Historical disposable browser and database evidence

A disposable local owner run was performed against an earlier Slice 3 candidate. PostgreSQL, API, and web listeners were restricted to `127.0.0.1`; production and shared infrastructure were untouched. The stack, database container and volume, and temporary loopback preload were removed after the run. This section is intentionally historical: it supports only the unchanged durable trust-path observations below. It does not validate the current single-line infinitive parser, current exact-evidence behavior, current abstention cases, or mounted-DOM behavior at this head. Earlier adviser outcomes described here are superseded and are not claims of current support.

- A realistic clear note containing `U.S.`, `Sept.`, and `e.g.` prefilled the complete objective and exact evidence while remaining visibly `Suggested proposal · not accepted`.
- Keyboard activation of `Correct evidence manually` made evidence editable, revealed manual selection, and moved focus to `#exact-excerpt`. Keyboard activation of `Reject suggestion and enter manually` cleared both fields, disabled proposal creation, and moved focus to `#objective`.
- Rejection retained only the SourceArtifact/chunk and created zero verified spans, Claims, fact links, or AcceptedFacts.
- A combined instruction-shaped and contested note abstained with blank fields, a disabled proposal action, and the manual evidence path. It created zero trusted-memory rows.
- The clear durable path showed source-only state before proposal; then one exact verified span and one `proposed` Claim with zero fact links/Facts. Stored excerpt slicing, excerpt hash, and chunk hash matched.
- Explicit acceptance changed the Claim to `accepted` and produced one linked `current` AcceptedFact through `fact_claims`, with matching subject, predicate, and value hash.
- Confirmation drafting was invoked twice. Both rendered questions were byte-identical at 134 UTF-8 bytes and visibly `Not sent` with `Sent: false`.
- Desktop `1440×900` and mobile `390×844` measurements showed no application-level horizontal overflow. At mobile width, all controls remained within the content viewport and `Accepted` was visually distinct from `Not sent`. The Next.js development toolbar was identified as a dev-only overlay and excluded from app-layout evidence.
- The final development browser console contained no JavaScript errors. A production-mode request correctly rendered the generic non-disclosing unavailable state with an empty console because the demo route is fail-closed in production.

No Slice 3 screenshot is committed to this packet, and the source-characterization tests are not represented as browser automation. The owner handoff and draft PR should retain the exact manual evidence above.

## Merge and deployment boundary

This slice must remain unmerged and undeployed. A commit, feature-branch push, and draft PR are permitted only after fresh PostgreSQL/B2 gates and independent exact-head review. Merge consideration remains contingent on owner testing and separate explicit authority. No shared infrastructure may be accessed from this QA script.
