# Wave B1 Result — Manual Account Work Graph and Source Capture

- **Date:** 2026-07-19 UTC
- **Status:** replacement-review BLOCK corrected; fresh pre-result candidate PASS; HOLD remains before final-byte verification, bounded commits, exact-head verification, direct review, publication, merge, deployment, or release
- **Branch:** `wave-b1-work-graph-source-capture`
- **Committed parent:** `6acac5f790cd8e3fae096c243a28c912c7102ba5`
- **Committed parent tree:** `86657946334e8b22d163e1f4f81e5436bd9360f9`
- **Authorized base:** `2566cb4649c24217058d32de6a0e088b303bb07b`
- **Corrected pre-result candidate tree:** `c46c4a5d231fc641233c76e83d46c550d177a712`
- **Canonical plan SHA-256:** `38a08d9cd57f3704f45c75bb35f5eb29a03d9a157e247e3ffa0af9ee6b77d39d`
- **Publication state:** corrections remain uncommitted; no push, PR, merge, deployment, AWS access, or publication has occurred

## Scope and outcome

The corrected candidate passes the B1 manual no-integration gate:

> A user can manually create the account workflow and capture a source without any integration.

The B1 surface remains limited to strict pinned domain profiles, Organization/Initiative/Activity/Relationship storage, Content and Source lifecycle storage, centralized authorization, transaction-scoped command/audit/outbox behavior, and the approved manual HTTP workflow.

No Claim, AcceptedFact, truth-ledger acceptance, ChangeSet, model call, extraction, MCP/provider integration, semantic retrieval, autonomous action, broad dashboard UI, deployment, or release was added. No canonical product document or accepted ADR was modified.

## Fourth direct-review closure

The earlier direct reviewer reported five findings. The corrected candidate retains the accepted corrections for all five.

### 1. Production fixture-command escape removed

- Migration `0006_b1_command_integrity.sql` contains no `b1_0.fixture.v1` command-shape or deferred-atomicity exception.
- The production command catalog accepts only the ten declared B1 v1 command/result shapes.
- `throughline_app` cannot reserve or complete an unknown, misspelled, later-version, or test command.
- Completion requires the exact aggregate, audit, and canonical product-outbox companions.
- Positive tests construct legitimate production companion state. Fixture-command strings remain only in adversarial tests proving rejection and absence from the production catalog.

### 2. Corrected Source linkage bound at the database boundary

Deferred command atomicity requires a corrected Source to preserve:

- the exact live predecessor and successor supersession identity;
- command reservation Space equal to both Source Spaces;
- exactly one predecessor and one successor `work.activity_sources` row;
- the exact same predecessor Activity and governing Space on the successor link; and
- the exact predecessor identity in matching audit and product-outbox companions.

PostgreSQL regressions cover missing or forged links, changed Activity, changed governing or reservation Space, forged companion identity, attempted concurrent predecessor relinking, rollback, and zero denied-path residue. The valid serialized outcome retains exactly the predecessor Activity and Space.

### 3. `relationship.end` binds and globally orders every live human-authority input

The command now:

1. derives only minimal Relationship reservation scope;
2. performs unlocked preauthorization before protected Relationship materialization;
3. locks and materializes the exact Relationship;
4. discovers the complete current authority snapshot without taking authority-row locks;
5. locks active policy and actor rows, then every governing/endpoint/inherited-path Space row in one global row-ID order, then every relied-upon grant in one global row-ID order;
6. re-evaluates every request and rejects any changed Space, path, grant, actor, policy, decision, or authority token;
7. reserves the command only after the globally ordered authority locks, preventing the reservation Space foreign-key lock from being acquired out of order;
8. performs the versioned mutation through an atomic predicate binding active policy, active membership, active user, current role, active governing Space, and every exact relied-upon grant; and
9. writes the audit, canonical product outbox, and command completion atomically.

The candidate PostgreSQL race matrix now covers both serialization directions without deadlock for:

- membership, user, policy, governing-Space, and endpoint-grant revocation;
- intermediate inherited-path restriction;
- ancestor archival;
- inherited-path reparenting; and
- an opposing ancestor-first multi-row Space mutation that also requests the governing Space.

Authority-wins leaves the Relationship unchanged with zero command/audit/outbox residue and returns the non-leaking authorization contract. Mutation-wins blocks the opposing authority mutation, completes exactly once, then releases it.

The membership, user, policy, and governing-Space mutation-first cases added after the exact-head HOLD passed Hermes' fresh isolated focused PostgreSQL verification. Complete final-byte gating and exact-head rereview remain pending.

### 4. Source Space-archival race closed

Live Space authorization locks the active governing Space even for owner/admin decisions. Source correction and tombstone authorize with live authority locking and reauthorize after deterministic resource locks before protected materialization or mutation.

Real PostgreSQL tests prove both serialized outcomes for correction and tombstone:

- archival commits first: non-leaking denial, complete rollback, zero residue;
- authorized mutation locks first: one command, one audit, one outbox event, then archival proceeds without deadlock.

### 5. Source existence oracle closed with a sealed public mapping

- `getSourceScope()` remains a minimal `id, space_id` lookup.
- Missing Source and existing-but-unauthorized Source commands converge on `B1AuthorizationError: B1 resource is unavailable` before Source/Activity materialization.
- The controller emits the same external 404 status, code, and body for missing and denied Source reads.
- Only the three exact expected typed Content-unavailability messages are normalized to that 404 contract; arbitrary `ContentInvariantError` messages ending in ` is unavailable` are not accepted.
- Other typed Content precondition failures use the public 409 command-conflict contract.
- Untyped database/system failures remain 500 errors and are not normalized into authorization denials.
- Command-bus, controller, and real PostgreSQL tests prove contracts, rollback, and zero command/audit/outbox or Source-pipeline residue.

## Replacement pre-commit review and correction

Replacement read-only review `deleg_b6e075ff` returned explicit BLOCK for exact tree `159dbe3b2a024d7e87b0c2317402d46b175fac55`:

1. Relationship authority rows were not guaranteed to be acquired in one global deterministic order; and
2. the controller used an open-ended typed-message suffix for Source-unavailability normalization.

The raw verdict is preserved at:

`/home/ubuntu/.hermes/rollouts/throughline-b1-review-block-correction-20260719T173404Z/precommit-review-block.json`

The suffix mapper was replaced with an exact three-message allowlist. Relationship authority was converted to discovery followed by global policy/actor/Space/grant locking and locked-state reauthorization.

A fresh opposing ancestor-first PostgreSQL regression then exposed one remaining real deadlock: `relationship.end` reserved its command before the global Space locks, allowing the reservation Space foreign key to lock the governing Space out of order. The rejected RED run is preserved at:

`/home/ubuntu/.hermes/rollouts/throughline-b1-fourth-review-correction-20260717T210807Z/focused-postgres-20260719T184442Z-3225382`

Command reservation now occurs only after the Relationship and full authority batch are locked and reauthorized. A unit ordering regression pins the sequence. No deadlock is retried, swallowed, or remapped.

## Accepted focused PostgreSQL evidence

Accepted run:

`/home/ubuntu/.hermes/rollouts/throughline-b1-final-review-correction-20260720/focused-postgres-20260720T173823Z-3869540`

- authorization service: 86/86 tests;
- B1 product-domain PostgreSQL: 17/17 tests;
- manual workflow and concurrency: 35/35 tests;
- total: 138/138 tests;
- authoritative skips: 0;
- unhandled errors: 0;
- start/end candidate trees: `6b00bf8e4e45f59807b52d6a5c1540890aeab6c8`;
- residual PostgreSQL client connections: 0;
- disposable PostgreSQL container absent after cleanup: PASS; and
- lingering repository processes: 0.

Focused evidence SHA-256 values:

- summary: `d1f43d15411364fa45be17aa931a35903b5dfb1e3e2fd0da24265d1ea0fcf8ae`
- cleanup: `111e2b66906fdaddf9ea150249203cfc902d6db0b89de57557d36a982780c52c`
- log scan: `7de5fa3fe2de775e29ed6ce5526b15bba8e2833066e534b43a4a9f051cc1a3a1`
- authorization log: `bc03b7b58a93ab4e3f90cd5c16318507663a10587c7fd7fb46aba886e192e84b`
- B1 product-domain log: `de106094abbcbdf0c0403ce9c8f27cfe99d2323f11ad8511c0f19cb189364c6b`
- manual-workflow log: `0d94614dd2fab03dcd85b0d72ec6794777086ec6d4be9dcc2828add8220485ab`

## Migration identity and catalog proof

The fresh authoritative migration journal recorded:

- `0001_wave_a2_identity_access_rls.sql` — `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql` — `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`
- `0003_b1_0_canonical_product_outbox.sql` — `094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63`
- `0004_b1_work_graph.sql` — `e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76`
- `0005_b1_content_sources.sql` — `b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c`
- `0006_b1_command_integrity.sql` — `cf2cd1c20e27cad0526f5896090fdf797ff748b90a02b994c2f5c2894b762897`

Migrations `0001`–`0003` remain byte-identical. Migration-journal SHA-256: `3b1cbf86c9c9b1323cf1b5d7f1ddf9b9fa6256045966aea30a49d573bb52fa74`.

## Complete post-review pre-result authoritative gate

Accepted run:

`/home/ubuntu/.hermes/rollouts/throughline-b1-final-review-correction-20260720/authoritative-b1-20260720T174555Z-3875816`

Start and end candidate trees were both `62204b8ded7cd125b2911fc73a4ee3f480ac6735`.

| Stage | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test`, service variables intentionally unset | PASS | 45 files passed, 10 skipped; 656 tests passed, 299 service-backed tests skipped |
| `pnpm build` | PASS | all build tasks passed |
| canonical `pnpm test:b1`, invoked exactly once | PASS | 45 files and 985 tests passed; 0 skipped; 0 unhandled errors |
| `git diff --check` | PASS | zero whitespace errors |

Ordinary-test skips are intentional collection behavior with service variables unset. The canonical B1 gate had zero authoritative skips.

## Evidence identities

- summary: `6b1205a3419ca6b40ce97849b82158f8343b358468bcfdff551d43bf9ed76a4f`
- cleanup: `81223871bcb490bf257d2c46ad50ce902b2cb86ab6dcecab4525a216a148da2c`
- frozen install log: `f6c3ead6a0216ab8e49a34f03794cf2e52b8070a22835f9f54eb7c0cbdaa835a`
- formatting log: `68ea59b69f4f3f8e0a01c9213bb41f1e4b4578b764f035ded18d28bae6ea05f0`
- lint log: `12eda237957e39e56c75d42300f7d3204bf64bf22db9bdca25a294e20c3bb81b`
- typecheck log: `1c189a4ee878c809e90e6fc64c44c8838a08bbccd9c5ede23284a513a5f7e3b2`
- ordinary-test log: `d5a8aeec42ab665bf79d09735551b5c7dfa0fe07e64c6e4b616bd90ae087d9fa`
- build log: `9753b15e3b6969cc5758fa1b628b8a30fc905b7b24a48d81b6294a6f8d8e9db9`
- complete B1 log: `b3b2c1997986aa572274c0ce6a670d6f3c1973c6cb93edd42965c8f67df27dc2`
- diff log: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- authoritative scan: `0a0a36e3c2410daeb306fd0f4cafd1ab9a926b7f17b8f8cec3ec65fcbf60fd8a`
- migration journal: `3b1cbf86c9c9b1323cf1b5d7f1ddf9b9fa6256045966aea30a49d573bb52fa74`

## Cleanup

Before teardown:

- Foundation source queue: 0 visible / 0 in-flight;
- Foundation DLQ: 0 visible / 0 in-flight;
- product queue: 3 visible / 0 in-flight, expected accepted-send integration fixtures;
- S3 bucket objects: 0; and
- PostgreSQL residual client connections: 0.

After teardown:

- PostgreSQL container absent: PASS;
- LocalStack container absent: PASS;
- lingering repository gate/test processes: 0; and
- gate exit code: 0.

## Final-byte binding and HOLD

This record describes the accepted corrected pre-result candidate. Updating this file changes the candidate tree, so it does not itself claim final-byte PASS.

The next mandatory step is one complete fresh gate over the candidate including these exact result-file bytes. That gate must again prove identical start/end trees, exact migration identity, all stages passing, zero authoritative skips, zero unhandled errors, zero residual connections, absent disposable containers, and no lingering gate/test processes.

HOLD remains before bounded commits, detached exact-head verification, a fresh independent direct read-only review, push, PR, merge, deployment, release, or B2 work.

## Spec deviations

None identified.

## Known issues

No known B1 implementation blocker remains after the exact-head review correction and fresh post-review pre-result gate. Final-byte gating and exact-head rereview remain intentionally pending.
