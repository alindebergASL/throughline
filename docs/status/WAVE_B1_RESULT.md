# Wave B1 Result — Manual Account Work Graph and Source Capture

- **Date:** 2026-07-17 UTC
- **Status:** pre-result corrected candidate gate PASS; HOLD remains before the complete final-byte gate and every subsequent commit, verification, review, publication, merge, deployment, or release step
- **Branch:** `wave-b1-work-graph-source-capture`
- **Committed blocked head:** `7e539c0a709108f72f1e616afe95a816cc86276a`
- **Committed blocked tree:** `a2724330c4bda909e9867c863b380ecee362351c`
- **Authorized base:** `2566cb4649c24217058d32de6a0e088b303bb07b`
- **Authorized base tree:** `97782492085cc637e426eced81f46d3ede684cfd`
- **Corrected pre-result candidate tree:** `38bade333215e6d168cd9f6e68d5472e18f7fa86`
- **Canonical plan SHA-256:** `38a08d9cd57f3704f45c75bb35f5eb29a03d9a157e247e3ffa0af9ee6b77d39d`
- **Publication state:** corrected candidate remains uncommitted; no push, PR, or publication has occurred

## Scope and outcome

The corrected candidate passes the B1 manual no-integration gate:

> A user can manually create the account workflow and capture a source without any integration.

The candidate adds the approved account work graph and manual source-capture surface:

- strict pinned AI Solutions domain profiles and deterministic first-party interpretation;
- Organization, Initiative, Activity, and Relationship aggregate storage and repository behavior;
- ContentItem revisioning and SourceArtifact capture, correction, tombstone, and chunk storage;
- centralized B1 action authorization and non-leaking route behavior;
- one transaction-scoped command path binding command reservation, aggregate mutation, audit, and the canonical B1.0 product outbox;
- minimal manual HTTP routes for the approved workflow; and
- real PostgreSQL and LocalStack proof for the complete no-integration walkthrough.

No Claim, AcceptedFact, truth-ledger acceptance, ChangeSet, model call, extraction, MCP/provider integration, semantic retrieval, autonomous action, broad dashboard UI, real Kanban dispatch, deployment, or release was added.

The Activity endpoint lock remains fixed and repository-controlled for source capture and correction. Forced RLS, non-owner/NOBYPASSRLS application execution, column-level `UPDATE(id)` only, permanent write denial, deterministic Activity-before-Source locking, and contributor-or-higher source authorization remain part of the verified boundary.

## Resolved direct-review corrections

The corrected candidate resolves all seven direct-review findings:

1. The migration journal is exact, phase-aware, and fail-closed, with an exhaustive B1 catalog validator covering explicit relation and column ACLs plus bidirectional SQL `EXCEPT` checks.
2. B1 command kind, version, payload, result, audit, and outbox mappings are closed. Malformed or unknown inputs are rejected before reservation with zero residue, and idempotency is bound to trusted input.
3. `content.create.v1` requires exact integer initial revision/version `1` at application and database boundaries. Fractional, string, null, and range-forgery inputs are rejected.
4. Source GET performs `source.read` authorization before correction traversal or materialization, then terminally reauthorizes; failures do not leak source data.
5. Activity associations are authorization-filtered before projection, excluding inaccessible identifiers, counts, and metadata.
6. `relationship.end` reauthorizes persisted endpoints, context, and current authority under deterministic locks; revocation wins with zero residue.
7. Origin-backed capture verifies exact revision and scope authorization plus byte and encoding equality before hashes or chunks. Forged, deleted, tombstoned, cross-scope, and revoked origins are rejected.

The separate CI correction ensures exactly one canonical `pnpm test:b1` invocation, removes the standalone final `pnpm test:b1-0` stage, and fails required-environment validation before orchestration begins.

## Migration identity and catalog proof

The authoritative migration journal recorded:

- `0001_wave_a2_identity_access_rls.sql` — `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql` — `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`
- `0003_b1_0_canonical_product_outbox.sql` — `094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63`
- `0004_b1_work_graph.sql` — `e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76`
- `0005_b1_content_sources.sql` — `b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c`
- `0006_b1_command_integrity.sql` — `5534436f86d56e8f983c60f3869c9e66928ffdc73b1d1cdbd115a156c3dbfebc`

Protected migrations `0001`–`0003` remain byte-identical to the authorized base. B1 remains additive after `0003`.

The catalog PostgreSQL adversarial suite passed 25/25 tests. It covers the exact `0004`/`0005`/`0006` phases; missing, gapped, reordered, and checksum-drifted journals; ACL mutation; owner, RLS, policy, function, trigger, rule, role, and `search_path` mutations; and scratch cleanup.

## Complete pre-result authoritative gate

The complete gate ran from a fresh disposable PostgreSQL and LocalStack generation:

`/home/ubuntu/.hermes/rollouts/throughline-b1-implementation-20260716/authoritative-b1-20260717T042343Z-1376482`

Start tree and end tree were both `38bade333215e6d168cd9f6e68d5472e18f7fa86`.

| Stage | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test`, service variables intentionally unset | PASS | 43 files passed, 10 skipped; 616 tests passed, 279 service-backed tests skipped |
| `pnpm build` | PASS | all build tasks passed |
| canonical `pnpm test:b1`, invoked exactly once | PASS | 42 test files and 895 tests passed; 0 skipped; 0 unhandled errors |
| `git diff --check` | PASS | zero whitespace errors |

The ordinary-test skips are intentional collection behavior with service variables unset; they are not authoritative-gate skips. The canonical B1 gate's authoritative skip count is zero.

Focused PostgreSQL evidence also passed:

- manual workflow suite: 21/21, including exact integer-one forgery tests and all six functional review seams;
- security suite: 18/18 after global-prefix updates; and
- Foundation/worker suites: 87/87 after global-prefix updates.

## Evidence identities

- summary: `9ec19c9d03def32efc2e2d62a06922450453a1ad97865911fd64feb839395bc4`
- cleanup: `d1ea5931659b757693686367556c36b34dfb4c537dba5a3c1d00dff927527db5`
- frozen install log: `d35e52ef2b4df5a810d57776a88bf96c29f5beb42b5b5e5615d7dedddf34d391`
- formatting log: `68ea59b69f4f3f8e0a01c9213bb41f1e4b4578b764f035ded18d28bae6ea05f0`
- lint log: `8ad93493a15fb302a36fe0f0e5006b75cfa7630b014a266d5ee91714d40a86bf`
- typecheck log: `509faf1f56b4c3c0cd83d48a49fcdbf212fc99c005de199827bb738af4bf05ee`
- ordinary-test log: `6bbca41de79d4ee95385f0ffe3577ab29f35ef5d44bfe872994eb2524720a9a5`
- build log: `b8e98f798c6e5a996c7306026ceead8bd72e154f94bbaf8c9aee97b8fa7bd5de`
- complete B1 log: `c534afa117bb7e4fb4363a1a81d3c05af06d4783fe63b62485f5e0aee2b337b9`
- diff log: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- authoritative scan: `0a0a36e3c2410daeb306fd0f4cafd1ab9a926b7f17b8f8cec3ec65fcbf60fd8a`
- journal TSV: `03daedec53c734f28b7025d9a2be2fc04b54764125d917df1feee871513fe4ab`

## Cleanup

Before teardown:

- Foundation source queue: 0 visible / 0 in-flight;
- Foundation DLQ: 0 visible / 0 in-flight;
- product queue: 3 visible / 0 in-flight, expected accepted-send integration fixtures;
- S3 bucket objects: 0; and
- PostgreSQL residual client connections: 0.

After teardown, the PostgreSQL and LocalStack containers were absent: PASS.

The broad process scanner listed eight pre-existing Hermes TypeScript LSP/`tsserver` processes attached to the worktree. They were editor tooling, not gate or test processes and not leaked disposable resources.

## Historical evidence

The prior result artifact SHA-256 `c86acf7e216c5036f34fc8c8373ab2f93db445a74e4cd8ab40fe2458f80805e3`, its earlier candidate tree, and its earlier evidence identities are historical after this update and are not current PASS evidence.

Prior failed or interrupted catalog and authoritative runs remain preserved as diagnostics only. They are not represented as PASS evidence.

## Final-byte binding and HOLD

This artifact records the passing pre-result candidate. It does **not** claim a final-byte PASS.

The next mandatory step is a complete final-byte gate over the candidate including this updated result file. That gate must again bind identical start and end trees, the exact migration journal, all required stages, zero authoritative skips, zero unhandled errors, and complete cleanup.

The branch remains at the committed blocked head; the corrected candidate has not been committed. No corrected-candidate commit, push, PR, or publication has occurred.

HOLD remains before the final-byte gate, commit, detached verification, direct review, push, PR, merge, deployment, release, AWS/runtime access, real Kanban dispatch, canonical-document or accepted-ADR changes, and B2 work.

## Spec deviations

None identified.

## Known issues

No known B1 implementation blocker remains after the corrected pre-result gate. Final-byte gating and every post-gate action remain intentionally pending.

## Approval state

The active correction instruction conditionally authorizes bounded commits, detached exact-head verification, direct read-only review, and scoped PR publication after their prerequisite gates pass. Merge and deployment remain unauthorized under every outcome and still require separate explicit authority.
