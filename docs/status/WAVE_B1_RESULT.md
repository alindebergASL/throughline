# Wave B1 Result — Manual Account Work Graph and Source Capture

- **Date:** 2026-07-21 UTC
- **Status:** PR #8 was squash-merged after the reconciled final-byte gate, detached exact-head verification, direct read-only review, normal publication, exact-head CI, and durable checkpoint passed; B1 is merged but not deployed, and B2 has not started
- **Branch:** `wave-b1-work-graph-source-capture`
- **Authorized PR #8 head:** `55afbfd4221745c5a541db855149de52878137a7`
- **Merged main:** `32c97afd13ee2288b84134a6a358c99fa165f157`
- **Merged tree:** `6527a6ba927711deb09d5bebfb264a2e977a9131`
- **Sole parent:** `a302c1f4a48a632b965be7bfcd1e8086795c0e8d`
- **Merge time:** `2026-07-21T04:58:20Z`
- **Exact-new-main push CI:** `https://github.com/alindebergASL/throughline/actions/runs/29802678285`
- **Merge checkpoint:** `https://github.com/alindebergASL/throughline/pull/8#issuecomment-5030374515`
- **Historical published PR #8 head:** `81a58639667a290d395b52116cefa6234b3754c1`
- **Historical published PR #8 tree:** `66465e4e48fffddca07aeb882823865b43168293`
- **Original merge base:** `2566cb4649c24217058d32de6a0e088b303bb07b`
- **Reconciled current main:** `a302c1f4a48a632b965be7bfcd1e8086795c0e8d`
- **Reconciliation merge:** `ee467b748d8b9f531b61bdc935cacd58bf419673`
- **Merge parents:** `81a58639667a290d395b52116cefa6234b3754c1` and `a302c1f4a48a632b965be7bfcd1e8086795c0e8d`
- **Reconciled pre-result candidate tree:** `f2031959fb2b762e00eee860f3d53fd589f8d45a`
- **Reviewed implementation/evidence parent:** `da478e9f05f0dfd0274cc3d8ffa425c4df0d8f84`
- **Reviewed implementation/evidence tree:** `351b209eb39aa9b2f2114ab89e793db2fba27e11`
- **Canonical plan SHA-256:** `38a08d9cd57f3704f45c75bb35f5eb29a03d9a157e247e3ffa0af9ee6b77d39d`
- **Historical publication state:** PR #8 was normally published at reviewed parent `da478e9f05f0dfd0274cc3d8ffa425c4df0d8f84`; exact-head CI run `29789153257` succeeded; durable checkpoint `5028715935` was posted and verified before the later authorized head was squash-merged

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

The membership, user, policy, and governing-Space mutation-first cases added after the exact-head HOLD passed Hermes' isolated focused PostgreSQL verification. The subsequent final-byte gate, detached exact-head verifier, direct reviewer, and PR #8 CI all passed for historical tree `66465e4e48fffddca07aeb882823865b43168293`; after PR #7 merged, that evidence remains historical and is not merge authority for the reconciled tree.

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

## Historical pre-PR #7 post-review pre-result authoritative gate

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

## Historical pre-PR #7 evidence identities

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

## Historical pre-PR #7 cleanup

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

## PR #7 reconciliation

PR #7 (`fix/throughline-docker-harness-cleanup`) merged as `a302c1f4a48a632b965be7bfcd1e8086795c0e8d` from exact head `8ab7b174849aa934593dde4895115b0ee82ce378`. Post-merge push CI passed at:

`https://github.com/alindebergASL/throughline/actions/runs/29774272560`

The pre-mutation inventory resolved a prior report's ambiguous `228900dd822cb3b5ed22ee674fb0a5cf98fa8560` reference: it is the historical `b1-0-canonical-product-outbox` head for merged PR #6, not PR #8's live head. PR #8's mutation target was and remains `wave-b1-work-graph-source-capture`, whose historical published head was `81a58639667a290d395b52116cefa6234b3754c1`.

One mutation owner created normal merge commit `ee467b748d8b9f531b61bdc935cacd58bf419673` with ordered parents:

1. `81a58639667a290d395b52116cefa6234b3754c1`; and
2. `a302c1f4a48a632b965be7bfcd1e8086795c0e8d`.

There was no rebase, reset, amend, cherry-pick, force-push, or history rewrite. Git's `ort` strategy auto-merged the sole overlapping path, `package.json`, without conflict. The merge changed exactly the five PR #7 paths relative to the historical PR #8 head:

- `HERMES_RUNBOOK.md` — exact PR #7 bytes, SHA-256 `f0bc7d02d383a2e62c781e6a564f541b68512a54d5e670e89574af7056f91cb7`;
- `README.md` — exact PR #7 bytes, SHA-256 `03f411998fb3001d41a90494f9d705a7f6b3d9c5ed89e9be873f2c92d45f0aef`;
- `scripts/throughline-docker-harness.sh` — exact PR #7 bytes, SHA-256 `7e3d0fd79e302f056cb90c2086dc2d73d415121bd0f74fb58806aae5efacc97f`;
- `scripts/throughline-docker-harness.test.sh` — exact PR #7 bytes, SHA-256 `dab1131ad9dc1607cc780c67afbf47a65dcd9b4b5e6e5c979a42590e37324671`; and
- `package.json` — mechanical union preserving PR #7's `"test": "pnpm test:docker-harness && turbo test"` and `test:docker-harness` command plus B1's complete `test:b1` command.

Migrations `0001`–`0003` remain byte-identical at the hashes recorded above. No B1 production, migration, security-boundary, canonical product-document, or accepted-ADR bytes changed during reconciliation.

The external pre-reconciliation manifest and verified Git bundle are preserved under:

`/home/ubuntu/.hermes/rollouts/throughline-pr8-reconcile-pr7-20260720`

## Focused reconciliation evidence

- repository Docker-harness regression: PASS;
- focused B1 architecture, test-gate, and dependency-boundary checks: 3 files / 10 tests PASS;
- exact five-path merge scope: PASS;
- exact PR #7 script/README/runbook bytes: PASS;
- combined `test`, `test:docker-harness`, and `test:b1` commands: PASS;
- migrations `0001`–`0003` unchanged: PASS;
- candidate tree unchanged during focused checks: `f2031959fb2b762e00eee860f3d53fd589f8d45a`;
- pre-existing dangling-volume set unchanged at exactly 16 volumes; and
- protected `throughline-postgres-1`, `throughline-localstack-1`, `throughline_postgres-data`, and `throughline_localstack-data` identities remained untouched.

Focused log SHA-256 values:

- Docker harness: `114987f0e56b576aa8a5c667ab0b64f6716d4d3f6a67e67e7a126cf5e59297b6`;
- focused B1: `8075b771f90d9f3236285355b103128455faaee3c4dbdeea424981790d145334`.

## Rejected diagnostic gate

The first generated post-reconciliation gate run is preserved at:

`/home/ubuntu/.hermes/rollouts/throughline-pr8-reconcile-pr7-20260720/authoritative-pr8-reconciled-preresult-20260720T213732Z-4038005`

It stopped fail-closed at the explicit Foundation preflight because the disposable database name omitted the required `test` marker. This was an external rollout-harness naming error, not a repository change or product failure. Its cleanup still proved zero residual clients, exact disposable-container removal through the repository harness, the unchanged 16-volume dangling set, untouched protected services, and zero lingering repository processes. It is diagnostic evidence only and is not counted as PASS.

## Accepted post-reconciliation pre-result authoritative gate

Accepted run:

`/home/ubuntu/.hermes/rollouts/throughline-pr8-reconcile-pr7-20260720/authoritative-pr8-reconciled-preresult-20260720T215546Z-4054507`

Start and end candidate trees were both `f2031959fb2b762e00eee860f3d53fd589f8d45a`.

| Stage | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test` | PASS | repository Docker-harness regression PASS; 45 files and 656 tests passed; 10 files / 299 service-backed tests intentionally skipped outside authoritative service mode |
| `pnpm build` | PASS | all build tasks passed |
| explicit `pnpm test:security` | PASS | 3 files / 114 tests; 0 skipped |
| explicit `pnpm test:foundation` | PASS | 14 files / 477 tests; 0 skipped |
| explicit `pnpm test:b1-0` | PASS | 26 files / 727 tests; 0 skipped |
| canonical `pnpm test:b1` | PASS | 45 files / 985 tests; 0 skipped; 0 unhandled errors |
| `git diff --check` | PASS | zero whitespace errors |

The authoritative service-backed logs had zero skips and zero unhandled errors. The migration journal remained exact.

Accepted evidence SHA-256 values:

- summary: `584dd70298cb647179dae90d14f06562c6fa247b22d2ea8515a4f0fad726cc28`;
- cleanup: `cc15955a461579795eb3114d65d412f6faecf7696ef4e89d594402dd3a063db8`;
- frozen install: `6a4d3b8aa8d1508317753dc2b2bed42ccc56a0f1e8e21ede343761d4bd755de7`;
- format: `68ea59b69f4f3f8e0a01c9213bb41f1e4b4578b764f035ded18d28bae6ea05f0`;
- lint: `81758c3e0131618e4238c2c9e014eceaa683b947ec0e07df1ba1e38c493a5c8a`;
- typecheck: `293aa25b875c0c052f935cb78dbf55345ec153d3167d065131e6f3cc4bf83889`;
- ordinary test: `0671dc818c7a97e8f49813b2d4d7a3a6c5d32fcd8fbad00d80c499261efb1fcf`;
- build: `1dc571d83b398333bcf65b46aedfd5b166f24c5ef135cadcc5c3e6b253677b40`;
- security: `0c75ba28957531ce3f21c09ede941e8c221ca5b56056c774e64a4d434d608f3d`;
- Foundation: `d271491637f92f2945a5f464a7deb1f8c8d0292b83354eaad8a5a53c3b1a93b8`;
- B1.0: `8f8effb454c8041753da9c9c25e3926431eefbe000b76f3a9c8394544c756745`;
- canonical B1: `ca9e0d29f10a30da56a90994d0c7fed9314e7c22b9d14e7d20d30e056e57184c`;
- diff check: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- authoritative scan: `036e768f9350ba79fe1aa3264229a035079fc618063bcfa86e4a8c788e99cee0`;
- migration journal: `3b1cbf86c9c9b1323cf1b5d7f1ddf9b9fa6256045966aea30a49d573bb52fa74`.

## Post-reconciliation Docker cleanup proof

Before and after the accepted gate:

- pre-existing dangling-volume count: exactly 16;
- dangling-volume set SHA-256: `0e50889a556c819f1b018b44556f3438a41f0631b8c26ae736f43fcddf9f2b6d` both before and after;
- all-volume set SHA-256: `8bd1d16f9c27e032d59de28735ae20360e36c38239600476278f73e808359038` both before and after;
- protected-service fingerprint SHA-256: `4ddfd1b108d2687c92ac95093a2ab16a42d37d689ac16938bde7fb93bf63de68` both before and after;
- disposable PostgreSQL and LocalStack IDs and names absent after cleanup: PASS;
- repository-owned Docker-harness cleanup result: 0;
- residual PostgreSQL client connections: 0;
- lingering repository processes before and after cleanup: 0; and
- gate exit code: 0.

No legacy volume was deleted. The protected live PostgreSQL and LocalStack containers, their start identities, and their named volumes remained untouched.

## Reconciled final-byte and exact-head closeout

The complete reconciled final-byte gate succeeded over exact tree `351b209eb39aa9b2f2114ab89e793db2fba27e11`:

`/home/ubuntu/.hermes/rollouts/throughline-pr8-reconcile-pr7-20260720/authoritative-pr8-reconciled-final-byte-20260720T223127Z-4087476`

It passed frozen install, formatting, lint, typecheck, ordinary tests, build, explicit security, Foundation, B1.0, canonical B1, and diff checking. Canonical B1 passed 45 files / 985 tests with zero authoritative skips and zero unhandled errors. Start and end candidate trees were identical. Cleanup proved zero residual PostgreSQL clients, exact disposable-container absence, an unchanged 16-volume dangling set, untouched protected services and volumes, and zero lingering repository processes.

Final-byte evidence SHA-256 values:

- summary: `406666234e54463f5961b9a2878a286c9457fd863702284bee91854912351f18`;
- cleanup: `ef37756ef9e476bed02562c098ffe0169773ff33259e02ae75e6e85730a10fe3`;
- authoritative scan: `036e768f9350ba79fe1aa3264229a035079fc618063bcfa86e4a8c788e99cee0`;
- migration journal: `3b1cbf86c9c9b1323cf1b5d7f1ddf9b9fa6256045966aea30a49d573bb52fa74`.

A fresh detached exact-head verifier then repeated the complete gate successfully against reviewed implementation/evidence parent `da478e9f05f0dfd0274cc3d8ffa425c4df0d8f84` and tree `351b209eb39aa9b2f2114ab89e793db2fba27e11`:

`/home/ubuntu/.hermes/rollouts/throughline-pr8-reconcile-pr7-20260720/detached-exact-head-verifier-da478e9-20260720T230519Z-4118459`

Detached-verifier evidence SHA-256 values:

- summary: `140df198fcc5a6d372d71fad583d704940b7e86c46778dbebec8b794d1e89459`;
- cleanup: `b995098fef30f35ba1a25e64c4a7d89e2ecf63986a50d7d666f6f1e183125283`.

The independent direct read-only reviewer returned explicit PASS with no blocking findings for the complete current-main diff and reconciliation delta, bound to the same head and tree. Raw verdict:

`/home/ubuntu/.hermes/rollouts/throughline-pr8-reconcile-pr7-20260720/reviewer-verdict-da478e9.json`

Verdict SHA-256: `dc14de75916761dcc320e3fb5fb7aaef4b9d2c9962b92adc935af2b5880b9a7a`.

## Publication and durable checkpoint

PR #8 was normally published without force or history rewriting at reviewed implementation/evidence parent `da478e9f05f0dfd0274cc3d8ffa425c4df0d8f84`.

Exact-head pull-request CI run `29789153257` completed successfully:

`https://github.com/alindebergASL/throughline/actions/runs/29789153257`

Durable reconciliation checkpoint `5028715935` was posted and read back byte-for-byte:

`https://github.com/alindebergASL/throughline/pull/8#issuecomment-5028715935`

The earlier database-naming run at `authoritative-pr8-reconciled-preresult-20260720T213732Z-4038005` remains rejected diagnostic evidence only. It failed closed at Foundation preflight because its disposable database name omitted the required `test` marker; it is not counted as PASS and does not replace the accepted final-byte or detached exact-head evidence.

## Historical docs-only closeout child and pre-merge HOLD

The pre-merge durable artifact identified `da478e9f05f0dfd0274cc3d8ffa425c4df0d8f84` explicitly as the reviewed implementation/evidence parent. That historical closeout changed only `docs/status/WAVE_B1_RESULT.md`; it did not alter implementation, migrations, tests, dependencies, workflows, Docker harnesses, canonical product documents, or accepted ADRs.

To avoid a self-referential identifier, that artifact did not name its eventual docs-only child SHA. The exact child head/tree, corrected result-file SHA-256, exact-delta verifier/reviewer evidence, and child CI were recorded in the PR description and final docs-closeout checkpoint after normal publication.

At that historical checkpoint, PR #8 remained open and unmerged, and merge remained unauthorized
pending explicit approval. No deployment, release, AWS/runtime access, B2 work, canonical-document
change, accepted-ADR change, real Kanban dispatch, Docker-volume cleanup, shared Hermes-control
change, history rewrite, or Atliera action occurred.

The later authorized PR #8 head `55afbfd4221745c5a541db855149de52878137a7` was squash-merged as
`32c97afd13ee2288b84134a6a358c99fa165f157` with tree
`6527a6ba927711deb09d5bebfb264a2e977a9131` and sole parent
`a302c1f4a48a632b965be7bfcd1e8086795c0e8d` at `2026-07-21T04:58:20Z`. Exact-new-main push CI
succeeded:

`https://github.com/alindebergASL/throughline/actions/runs/29802678285`

The merge checkpoint is:

`https://github.com/alindebergASL/throughline/pull/8#issuecomment-5030374515`

B1 is merged but has not been deployed. B2 has not started. This documentation closeout does not
claim that its own future PR is merged.

## Spec deviations

None identified.

## Known issues

No known B1 implementation or reconciliation blocker remains.
