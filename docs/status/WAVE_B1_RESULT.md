# Wave B1 Result — Manual Account Work Graph and Source Capture

- **Date:** 2026-07-17 UTC
- **Status:** second-review corrected candidate pre-result gate PASS; HOLD remains before the complete final-byte gate and every subsequent commit, exact-head verification, review, publication, merge, deployment, or release step
- **Branch:** `wave-b1-work-graph-source-capture`
- **Committed corrected head:** `71ad5b33ff648e2ee1749509f5bbb31170400ef2`
- **Committed corrected tree:** `4af7f684357b4d706165c9333cdadfdf489b90d7`
- **Original blocked head:** `7e539c0a709108f72f1e616afe95a816cc86276a`
- **Authorized base:** `2566cb4649c24217058d32de6a0e088b303bb07b`
- **Authorized base tree:** `97782492085cc637e426eced81f46d3ede684cfd`
- **Second-review corrected pre-result candidate tree:** `a2be3f82d58d7460426034e0c9fb2971aec9b1f5`
- **Canonical plan SHA-256:** `38a08d9cd57f3704f45c75bb35f5eb29a03d9a157e247e3ffa0af9ee6b77d39d`
- **Publication state:** the second-review corrections remain uncommitted; no push, PR, or publication has occurred

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

## Resolved first-review corrections

The prior corrected head resolved all seven findings from the first direct review:

1. exact, phase-aware, fail-closed migration-journal and installed-catalog validation;
2. closed B1 command kind, version, payload, result, audit, and outbox mappings;
3. exact integer initial revision/version `1` for `content.create.v1` at application and database boundaries;
4. `source.read` authorization before source correction traversal or materialization, with terminal reauthorization;
5. authorization-filtered Activity associations;
6. locked persisted-endpoint and current-authority reauthorization for `relationship.end`; and
7. exact revision, scope, encoding, and byte equality for origin-backed capture.

That corrected committed head passed detached exact-head verification, but the subsequent independent direct review returned `BLOCK` with eight additional IMPORTANT findings. No publication occurred.

## Resolved second-review corrections

The current uncommitted candidate addresses all eight findings from the second direct review:

1. Content authorization now enforces the effective Space, ContentItem, and selected revision access-class ceiling. Origin authorization precedes reading or comparing revision bytes.
2. Human Space authority is represented by exact current grant tokens. Relationship mutation uses locked persisted endpoints plus an atomic authority predicate so a committed revocation wins with zero mutation residue.
3. Activity Source listing enumerates only candidate identifiers before `source.read`; full text, chunks, and metadata are materialized only after authorization while current authority is held.
4. Initiative Organization associations are authorized individually before projection; unreadable IDs, primary association, and association count are omitted.
5. The `work`/`content` `pg_class` inventory is closed across every relation kind, including unexpected ACL-bearing sequences. Index kind/cardinality normalization is paired with separate exact index-name and definition validation.
6. `ops.domain_command_records` now has an exact full constraint, user-trigger, and rewrite-rule inventory; differently named extras and altered enablement or definitions fail closed.
7. Predecessor `access`/`identity`/`ops` ACL authority is compared as normalized schema/relation/scope/column/grantee/privilege/grant-option/grantor tuples in both directions with SQL `EXCEPT`; PUBLIC, rogue-role, alternate-grantor, and inherited authority fail closed.
8. Canonical `pnpm test:b1` includes `b1-account-operations.runtime.spec.ts`; the authoritative log scan requires that runtime suite.

Real-service correction work also fixed two validation-harness defects found before the passing gate:

- the closed relation inventory now compares PostgreSQL and scratch index cardinality using one deterministic structural ordering without weakening separate exact index checks; and
- the expected command-integrity relation uses the transaction-local ordinary scratch schema because PostgreSQL forbids temporary-table constraints from referencing persistent predecessor relations.

## Migration identity and catalog proof

The authoritative migration journal recorded:

- `0001_wave_a2_identity_access_rls.sql` — `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql` — `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`
- `0003_b1_0_canonical_product_outbox.sql` — `094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63`
- `0004_b1_work_graph.sql` — `e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76`
- `0005_b1_content_sources.sql` — `b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c`
- `0006_b1_command_integrity.sql` — `5534436f86d56e8f983c60f3869c9e66928ffdc73b1d1cdbd115a156c3dbfebc`

Protected migrations `0001`–`0003` remain byte-identical to the authorized base. B1 remains additive after `0003`.

The expanded catalog PostgreSQL adversarial suite passed 31/31 tests. It covers exact `0004`/`0005`/`0006` phases; unknown, missing, gapped, reordered, duplicated, and checksum-drifted journals; exact-but-unjournaled installed phases; every unexpected relation kind; complete command-table constraints/triggers/rules; exact predecessor and B1 ACL authority; owner, RLS, policy, function, role, inheritance, and `search_path` mutations; and scratch cleanup.

The manual PostgreSQL/API workflow suite passed 23/23 tests, including source authorization-before-materialization, Initiative/Activity association filtering, exact integer-one validation, origin authorization before byte comparison, and revocation-winning relationship mutation.

## Complete second-review pre-result authoritative gate

The complete gate ran from a fresh disposable PostgreSQL and LocalStack generation:

`/home/ubuntu/.hermes/rollouts/throughline-b1-review-v2-correction-20260717T062813Z/authoritative-b1-20260717T081415Z-1560788`

Start tree and end tree were both `a2be3f82d58d7460426034e0c9fb2971aec9b1f5`.

| Stage | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test`, service variables intentionally unset | PASS | 44 files passed, 10 skipped; 630 tests passed, 287 service-backed tests skipped |
| `pnpm build` | PASS | all build tasks passed |
| canonical `pnpm test:b1`, invoked exactly once | PASS | 44 test files and 923 tests passed; 0 skipped; 0 unhandled errors |
| `git diff --check` | PASS | zero whitespace errors |

The ordinary-test skips are intentional collection behavior with service variables unset; they are not authoritative-gate skips. The canonical B1 gate's authoritative skip count is zero.

## Evidence identities

- summary: `fbdd54a2ea86ef1a1e50b2fe8c5eccbc3c4316b33b847013483a4e2be0157aa7`
- cleanup: `c7ebe4077a60ce804bf4247ebc843dbf3e0b7b7a831d690241973a5ba48ed9fb`
- frozen install log: `b2b840554feaa30d80683a95a4c277ac22d1346c564e66bef22885bfdb08566b`
- formatting log: `68ea59b69f4f3f8e0a01c9213bb41f1e4b4578b764f035ded18d28bae6ea05f0`
- lint log: `2a3809c38e5c08477931b6552d6a3e20410abc587e40ed5a1050b7abe9fc79c7`
- typecheck log: `42a914523ec801437110f9dab3d308800689ce86d32f83a5340226a2c74527b4`
- ordinary-test log: `72201b27f9f820423d550a579121b26269f3605e6875ae12749ec2499939b151`
- build log: `e28b2c610dd18a569893635a2405caf125fc7a97d01ab411d674508fbb812143`
- complete B1 log: `ef1aa22c47ea434c323d2b9e01a0f974e3b1a5ec6852abfd60b0f6205458b9fc`
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

After teardown, the gate's PostgreSQL and LocalStack containers were absent: PASS.

The cleanup scanner listed four Hermes TypeScript language-service processes attached to the worktree. They were editor tooling rather than gate/test processes or disposable service leaks. They were terminated after the gate; the bounded cleanup record reports zero remaining processes and has SHA-256 `bbdf030ed44d0889255e0069f993222f1b11c4ce295330994949cfcbf111473d`.

## Historical evidence

The prior first-review result, passing final-byte gate, bounded commits at `71ad5b33ff648e2ee1749509f5bbb31170400ef2`, and passing detached verifier remain valid historical evidence for those exact earlier bytes. The subsequent direct review's eight-finding `BLOCK` supersedes them as publication authority.

The failed pre-result runs at `authoritative-b1-20260717T075907Z-1546547` and `authoritative-b1-20260717T080336Z-1550487` are preserved as diagnostics. They exposed, respectively, one obsolete temporary-relation helper rejected by lint and one over-broad static assertion that rejected non-filtering index normalization. Neither is represented as PASS evidence.

## Final-byte binding and HOLD

This artifact records the passing second-review pre-result candidate. It does **not** claim a final-byte PASS.

The next mandatory step is a complete final-byte gate over the candidate including this updated result file. That gate must again bind identical start and end trees, the exact migration journal, all required stages, zero authoritative skips, zero unhandled errors, and complete cleanup.

The branch remains at committed head `71ad5b33ff648e2ee1749509f5bbb31170400ef2`; the second-review corrections have not been committed. No second-review correction commit, push, PR, or publication has occurred.

HOLD remains before the final-byte gate, bounded commit, detached exact-head verification, direct review, GitHub authentication check, push, PR, merge, deployment, release, AWS/runtime access, real Kanban dispatch, canonical-document or accepted-ADR changes, and B2 work.

## Spec deviations

None identified.

## Known issues

No known B1 implementation blocker remains after the second-review corrected pre-result gate. Final-byte gating and every post-gate action remain intentionally pending.

## Approval state

The active correction instruction conditionally authorizes bounded commits, detached exact-head verification, direct read-only review, and scoped PR publication after their prerequisite gates pass. Merge and deployment remain unauthorized under every outcome and still require separate explicit authority.
