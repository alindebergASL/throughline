# Wave B1 Result — Manual Account Work Graph and Source Capture

- **Date:** 2026-07-17 UTC
- **Status:** third-review corrected pre-result candidate PASS; HOLD remains before the complete final-byte gate, bounded commits, exact-head verification, direct review, publication, merge, deployment, or release
- **Branch:** `wave-b1-work-graph-source-capture`
- **Committed parent:** `845c8e108ca542f3389c0ac6f990786ad619497c`
- **Committed parent tree:** `7c48cdfd2bca0f9c25c9ccd60df042081678fec9`
- **Authorized base:** `2566cb4649c24217058d32de6a0e088b303bb07b`
- **Authorized base tree:** `97782492085cc637e426eced81f46d3ede684cfd`
- **Third-review corrected pre-result candidate tree:** `5b58bd9a93f575fcca617109cfa892c4c8726a61`
- **Canonical plan SHA-256:** `38a08d9cd57f3704f45c75bb35f5eb29a03d9a157e247e3ffa0af9ee6b77d39d`
- **Publication state:** the third-review corrections remain uncommitted; no push, PR, merge, deployment, or publication has occurred

## Scope and outcome

The corrected candidate passes the B1 manual no-integration gate:

> A user can manually create the account workflow and capture a source without any integration.

The B1 surface remains limited to:

- strict pinned AI Solutions domain profiles and deterministic first-party interpretation;
- Organization, Initiative, Activity, and Relationship aggregate storage and repository behavior;
- ContentItem revisioning and SourceArtifact capture, correction, tombstone, and chunk storage;
- centralized B1 authorization and non-leaking route behavior;
- transaction-scoped command reservation, aggregate mutation, audit, and canonical B1.0 product outbox; and
- minimal manual HTTP routes for the approved workflow.

No Claim, AcceptedFact, truth-ledger acceptance, ChangeSet, model call, extraction, MCP/provider integration, semantic retrieval, autonomous action, broad dashboard UI, real Kanban dispatch, deployment, or release was added. No canonical product document or accepted ADR was modified.

## Prior review closure

The committed parent retains the corrections for all seven first-review findings and all eight second-review findings. Those findings covered exact migration-journal/catalog adoption, closed command/result integrity, exact integers, source authorization ordering, association filtering, relationship revocation, origin-byte authorization, effective content access classes, live authority tokens, candidate-only source listing, exact PostgreSQL relation/constraint/trigger/rule/ACL inventories, and canonical `pnpm test:b1` wiring.

The detached verifier for parent `845c8e108ca542f3389c0ac6f990786ad619497c` passed, but the subsequent direct review returned `BLOCK` with one additional Source-mutation authorization finding. That review superseded earlier publication authority.

## Resolved third-review correction

The current candidate closes that finding:

1. `ContentRepository.getSourceScope()` selects and returns only `id` and `space_id`. It does not read Source text, title, hashes, access class, deletion state, version, correction-chain state, chunks, or Activity associations.
2. `source.correct` and `source.tombstone` route reservation scope through that minimal lookup instead of `getSource()`.
3. Inside the mutation transaction, `source.read` and the requested action are authorized with live authority locking before Source links, Activity projections, full Source state, text, chunks, hashes, or deletion metadata can be materialized.
4. Correction preserves deterministic Activity-before-Source row-locking. After Activity and Source locks, the exact Source identity, governing Space, and Activity link are revalidated; `source.read` and `source.correct` are repeated against live state before mutation.
5. Tombstone repeats `source.read` and `source.tombstone` after the full Source lock and before command reservation or mutation.
6. Denial is non-leaking and rolls back with transaction-local context cleared. Execute-path tests prove denied correction and tombstone never call the Source-link, Activity-lock, or full-Source materialization paths.
7. Real PostgreSQL races prove a committed contributor-grant revocation after scope lookup denies correction and a committed owner-membership suspension after scope lookup denies tombstone. Both leave zero Source, chunk, link, command, audit, outbox, work-graph, content-item, or relationship residue.

The new Account Operations test file executes the production command bus and transaction wrapper. Repository and authorization seams are instrumented only to record production call order and to stop after the asserted boundary; denial tests also assert rollback, pooled-context cleanup, and absence of materialization calls.

## Focused evidence

Focused unit and static verification passed:

- Account Operations: 12/12 tests, including four production command-bus ordering/denial tests;
- Content: 14/14 tests, including exact minimal Source-scope SQL;
- B1 architecture/dependency gate: 9/9 tests;
- transaction cleanup: 5/5 tests;
- focused package typecheck, lint, Prettier, and `git diff --check`: PASS.

Fresh focused PostgreSQL evidence:

`/home/ubuntu/.hermes/rollouts/throughline-b1-third-review-recovery-20260717T164436Z/focused-postgres-20260717T170609Z-1828354`

- manual workflow: 25/25 tests passed;
- authoritative skips: 0;
- unhandled errors: 0;
- start/end dirty-state digest identical;
- PostgreSQL residual connections: 0;
- disposable PostgreSQL container absent after cleanup: PASS.

## Migration identity and catalog proof

The fresh authoritative journal recorded:

- `0001_wave_a2_identity_access_rls.sql` — `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql` — `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`
- `0003_b1_0_canonical_product_outbox.sql` — `094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63`
- `0004_b1_work_graph.sql` — `e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76`
- `0005_b1_content_sources.sql` — `b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c`
- `0006_b1_command_integrity.sql` — `5534436f86d56e8f983c60f3869c9e66928ffdc73b1d1cdbd115a156c3dbfebc`

Protected migrations `0001`–`0003` remain byte-identical. No migration was modified by the third-review correction. The B1 catalog adversarial suite passed 31/31 tests.

## Complete third-review pre-result authoritative gate

The accepted complete pre-result gate ran against fresh disposable PostgreSQL and LocalStack resources:

`/home/ubuntu/.hermes/rollouts/throughline-b1-third-review-recovery-20260717T164436Z/authoritative-b1-20260717T173608Z-1857242`

Start and end candidate trees were both `5b58bd9a93f575fcca617109cfa892c4c8726a61`.

| Stage | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test`, service variables intentionally unset | PASS | 45 files passed, 10 skipped; 636 tests passed, 289 service-backed tests skipped |
| `pnpm build` | PASS | all build tasks passed |
| canonical `pnpm test:b1`, invoked exactly once | PASS | 45 test files and 931 tests passed; 0 skipped; 0 unhandled errors |
| `git diff --check` | PASS | zero whitespace errors |

Ordinary-test skips are intentional collection behavior with integration variables unset. The canonical B1 gate has zero authoritative skips.

## Evidence identities

- summary: `a15523cc3683a9f645a650718c179436525b5d653717f2fc4e97d0a131217478`
- cleanup: `de9d878f6f623191c73c08fd00376eaf99eef93fa097c5b8487fb14d3d8814c4`
- frozen install log: `d35e52ef2b4df5a810d57776a88bf96c29f5beb42b5b5e5615d7dedddf34d391`
- formatting log: `68ea59b69f4f3f8e0a01c9213bb41f1e4b4578b764f035ded18d28bae6ea05f0`
- lint log: `8b19ec0926a22dab219c0d179b64e1d56b32d4dc7b8649e8e30cd9ddd929d9c6`
- typecheck log: `5494bf2a935f137be4b2f0d7be44c17550c503bc905b53a9e2ac27c1688de724`
- ordinary-test log: `665954137f2c03bc375010c3cce7a0ee1ac5c1f523427630839e95900f006dbc`
- build log: `25d831f822dc9ae778d3778c04fe2a501c428e3c1afea819a68abd0959b71b75`
- complete B1 log: `5207f16412083ef9f992d9e99167ca02b8dc155d1641815aabee4c4a42bfa9f2`
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

After teardown:

- PostgreSQL container absent: PASS;
- LocalStack container absent: PASS;
- lingering repository processes: 0; and
- gate exit code: 0.

An earlier run against the same candidate passed every test stage but recorded eight pre-existing Hermes TypeScript language-service processes during cleanup. It is preserved as diagnostic evidence and is not the accepted cleanup record. Those processes were terminated before the accepted rerun.

## Final-byte binding and HOLD

This artifact records the accepted passing third-review pre-result candidate. It does **not** claim a final-byte PASS because this result-file update changes the candidate tree.

The next mandatory step is a complete fresh gate over the candidate including this exact result file. That gate must again bind identical start/end trees, the exact migration journal, all required stages, zero authoritative skips, zero unhandled errors, and complete cleanup.

The branch remains at committed parent `845c8e108ca542f3389c0ac6f990786ad619497c`; the third-review corrections have not been committed. HOLD remains before bounded commits, detached exact-head verification, direct review, push, PR, merge, deployment, release, AWS/runtime access, real Kanban dispatch, canonical-document or accepted-ADR changes, and B2 work.

## Spec deviations

None identified.

## Known issues

No known B1 implementation blocker remains after the third-review corrected pre-result gate. Final-byte gating and exact-head reviews remain intentionally pending.
