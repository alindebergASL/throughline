# Wave B1 Result — Manual Account Work Graph and Source Capture

- **Date:** 2026-07-16
- **Status:** local implementation checkpoint passed the complete pre-result authoritative PostgreSQL/LocalStack gate; HOLD remains before commit, independent exact-head review, publication, merge, and deployment
- **Authorized base:** `2566cb4649c24217058d32de6a0e088b303bb07b`
- **Authorized base tree:** `97782492085cc637e426eced81f46d3ede684cfd`
- **Branch:** `wave-b1-work-graph-source-capture`
- **Commit:** none; this is an uncommitted HOLD checkpoint
- **Canonical plan SHA-256:** `38a08d9cd57f3704f45c75bb35f5eb29a03d9a157e247e3ffa0af9ee6b77d39d`
- **Tested pre-result candidate tree:** `29419ad799b199c516748bf941fb02b74a35734d`

## Scope and outcome

The implementation satisfies the B1 manual no-integration gate:

> A user can manually create the account workflow and capture a source without any integration.

The candidate adds the approved account work graph and manual source-capture surface:

- strict pinned AI Solutions domain profiles and deterministic first-party interpretation;
- Organization, Initiative, Activity, and Relationship aggregate storage and repository behavior;
- ContentItem revisioning and SourceArtifact capture, correction, tombstone, and chunk storage;
- centralized B1 action authorization and non-leaking route behavior;
- one transaction-scoped command path that binds command reservation, aggregate mutation, audit, and the canonical B1.0 product outbox;
- minimal manual HTTP routes for the approved workflow; and
- real PostgreSQL and LocalStack proof for the complete no-integration walkthrough.

No Claim, AcceptedFact, truth-ledger acceptance, ChangeSet, model call, extraction, MCP/provider integration, semantic retrieval, autonomous action, broad dashboard UI, real Kanban dispatch, deployment, or release was added.

## Activity/source lock correction

`source.capture` and `source.correct` retain the Activity endpoint lock required by the plan. The generic caller-controlled Activity lock seam was replaced with the fixed repository operation `lockActivityForSourceCapture(...)`, whose query uses `SELECT ... FOR SHARE` against the exact Tenant, Workspace, governing Space, Activity, live-Space, and eligible-Activity predicates.

The application role receives only the PostgreSQL capability required for that lock:

```sql
GRANT UPDATE (id) ON work.activities TO throughline_app;
```

Migration `0004` supplies exactly two applicable Activity UPDATE policies:

- an explicit PERMISSIVE, transaction-local, scoped lock policy with the exact Tenant/Workspace/Space/live/eligible predicates and `WITH CHECK (false)`; and
- an explicit RESTRICTIVE permanent no-write guard with `USING (true)` and `WITH CHECK (false)`.

Forced RLS, non-owner/NOBYPASSRLS application execution, column-level `UPDATE(id)` only, no grant option, and denial of every tested Activity write form remain intact. No table-level Activity UPDATE, non-ID update column, PUBLIC/inherited update path, owner/BYPASSRLS execution path, SECURITY DEFINER lock helper, or arbitrary Activity lock API was introduced.

`source.capture` uses centralized `source.capture` authorization with contributor-or-higher authority in the governing Space. `source.correct` uses deterministic Activity `FOR SHARE` before predecessor/current SourceArtifact `FOR UPDATE`, then revalidates the relationship after the required locks.

The individual post-focused lock review found no bulk grant, caller-controlled SQL, broader Activity capability, or Foundation/product-relay/worker/relay lock regression. Its external report is:

`/home/ubuntu/.hermes/rollouts/throughline-b1-implementation-20260716/post-focused-lock-review.md`

## Migration identity

The migration journal from the passing pre-result gate recorded:

- `0001_wave_a2_identity_access_rls.sql` — `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql` — `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`
- `0003_b1_0_canonical_product_outbox.sql` — `094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63`
- `0004_b1_work_graph.sql` — `e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76`
- `0005_b1_content_sources.sql` — `b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c`
- `0006_b1_command_integrity.sql` — `33371e78f9137467d51d2c9235ab10744303b24e83b9fd77ee81881355c339db`

Migrations `0001`–`0003` are byte-identical to the authorized base. B1 uses only additive migrations after `0003`.

## Focused PostgreSQL gate

The final focused run before the pre-result authoritative gate passed:

`/home/ubuntu/.hermes/rollouts/throughline-b1-implementation-20260716/focused-b1-20260716T202122Z-1033851`

It included:

- formatting and architecture/dependency guards;
- domain-profile, work-graph, content, account-operation, migration, transaction, and authorization tests;
- the real 16-test B1 PostgreSQL lock/security/concurrency suite; and
- the 16-test manual API/PostgreSQL workflow suite.

The real lock proof covered exact Activity grants/policies, correct and incorrect lock contexts, stale/cross-scope/archived/cancelled denial, concurrent captures, write denial with unchanged Activity digest, lock release and pooled-context hygiene, Activity-before-Source correction ordering, correction-fork behavior, non-contributor denial, and idempotent replay/conflict behavior.

## Complete pre-result authoritative gate

A fresh disposable PostgreSQL database and LocalStack generation ran the complete gate on candidate tree `29419ad799b199c516748bf941fb02b74a35734d` with an identical end tree.

Run directory:

`/home/ubuntu/.hermes/rollouts/throughline-b1-implementation-20260716/authoritative-b1-20260716T205459Z-1066160`

| Command | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test` with integration variables unset | PASS | ordinary repository suite passed |
| `pnpm build` | PASS | all build tasks passed |
| canonical `pnpm test:b1` | PASS | nested security, Foundation, B1.0, and B1 gates all passed |
| `git diff --check` | PASS | zero whitespace errors |
| authoritative log scan | PASS | zero authoritative skips and zero unhandled test errors |

The canonical B1 gate included the unchanged Foundation and B1.0 real PostgreSQL/LocalStack regression gates, the product-relay PostgreSQL/LocalStack suite, B1 architecture and authorization gates, and the real B1 manual API/PostgreSQL gate.

Evidence SHA-256 values:

- summary: `7846c3e68136bfdd39d4600577eb0395ebeaa38885b24f5138b1ec78b10fcac0`
- cleanup: `86a24a1ae9798b6e7b527c68f7ddd2b1eeea424188e8e11f2321e4acf2913095`
- frozen install log: `1ab0aae6f10aa3cfc92c8115d57c737426df939fff0187c76a7238a84f55e7f7`
- formatting log: `68ea59b69f4f3f8e0a01c9213bb41f1e4b4578b764f035ded18d28bae6ea05f0`
- lint log: `259f73190b81f9030e29de52736d8d3400b6db6da59f1331dc0b0b005bfe11ef`
- typecheck log: `d279c9c1e69bb70e76d480eafbc74d7b7d2278210fd939721a678a3ecdd896f1`
- ordinary test log: `95338a7ac65c3aa402144bcfd4307daa04f3984608f65dc7c5bbc89c10c4af76`
- build log: `c4aafd2982ac4066d192639455e73e67ff285cf3b14b45d1143e1073b9fa8dfa`
- complete B1 log: `3717e479ce219611788fcd2227a629e66f1b50d7a6f288c908a0eb9a99045755`
- authoritative log scan: `0a0a36e3c2410daeb306fd0f4cafd1ab9a926b7f17b8f8cec3ec65fcbf60fd8a`
- migration journal: `a8450880fa4252a26bdabe08aa9c0c35a3b7f44c75d6e091eaf74d28f5ba8637`

## Cleanup

Before teardown, the Foundation source queue and DLQ had zero visible and zero in-flight messages. The product queue had three visible and zero in-flight messages from the accepted-send integration scenarios. The S3 bucket had zero objects and PostgreSQL had zero residual client connections.

Teardown removed both disposable containers and all associated queues, messages, bucket state, and database state. The cleanup record reports:

- LocalStack container absent: PASS;
- PostgreSQL container absent: PASS;
- lingering worktree processes: zero; and
- gate exit code: zero.

## Test-compatibility corrections

The complete gate exposed three bounded additive-wave compatibility issues, retained as failed evidence rather than represented as passes:

1. Foundation migration-security tests assumed only migrations `0001`–`0003`. They now recognize `0004`–`0006` while preserving the A2 predecessor-adoption proof by removing only the predecessor journal row under test.
2. Migration `0006` initially applied B1-specific result-shape and atomicity checks to non-B1 canonical fixture commands. The checks now use the closed B1 command-kind set and preserve B1.0 behavior.
3. A B1.0 product-relay test proved absence of B1 product effects by expecting future B1 tables not to exist. It now makes the stronger additive-wave assertion that those tables contain zero rows while continuing to require the duplicate `ops.domain_events` ledger to be absent.

The first attempted all-stage runner also invoked `test:b1-0` directly and then invoked canonical `test:b1`, which recursively invoked B1.0 again against the same disposable queue/database generation. The first invocation passed; the repeated invocation encountered retained integration fixture state. The final authoritative runner invokes canonical `test:b1` once, matching the repository's intended nested security → Foundation → B1.0 → B1 gate composition.

## Final-byte binding

This result artifact intentionally records the already-passing pre-result implementation tree and evidence rather than attempting to contain a self-referential hash of its own bytes. Before any commit or review, the exact candidate including this result artifact must rerun the complete authoritative gate from frozen install. That external final-byte evidence must record identical start/end trees, the exact migration journal, zero authoritative skips, zero unhandled errors, and complete cleanup.

## Review and publication state

No implementation commit exists. No detached exact-head verifier or direct exact-head reviewer has run. Nothing has been pushed, no B1 PR exists, and no merge or deployment is authorized.

HOLD remains in force before commit, review, publication, merge, deployment, release, real Kanban dispatch, AWS/runtime access, canonical-document changes, accepted-ADR changes, or B2 work.

## Spec deviations

None identified.

## Known issues

No known implementation blocker remains after the focused and complete pre-result gates. Final-byte gating, exact-head independent verification, direct review, and publication are intentionally pending authorization.

## Approval needed

Yes. Explicit authority is required before creating commits or beginning exact-head review/publication.