# Wave B1.0 Result — Canonical Product Outbox Correction

- **Date:** 2026-07-15
- **Status:** PR #6 was squash-merged after its reviewed implementation checkpoint passed the authoritative gate, detached verification, direct review, publication, and exact-head CI
- **PR:** `alindebergASL/throughline#6`
- **Authorized PR head:** `228900dd822cb3b5ed22ee674fb0a5cf98fa8560`
- **Authorized base:** `b454ae8c865c77639adbf82daf8963db67922ad6`
- **Merged main:** `2566cb4649c24217058d32de6a0e088b303bb07b`
- **Merged tree:** `97782492085cc637e426eced81f46d3ede684cfd`
- **Sole parent:** `b454ae8c865c77639adbf82daf8963db67922ad6`
- **Merge time:** `2026-07-16T15:53:00Z`
- **Post-merge CI:** `https://github.com/alindebergASL/throughline/actions/runs/29513153082`
- **Merge checkpoint:** `https://github.com/alindebergASL/throughline/pull/6#issuecomment-4993983399`
- **Correction parent:** `7d385391d08e0fdd2605a628960ee920fe75c7ca`
- **Parent tree:** `017c78aed14f39772451baf8407be7abf9eea90a`
- **Tested pre-result implementation tree:** `8152155cfc3970cc8e3fd2b633ac38d1faad2bc3`
- **Post-review fix head:** `cd8a2d9c6f237937254bbe5d5f4b316364ea7fde`
- **Post-review fix tree:** `7ebf1d18ff69e6442cf2bbc69b6a574868773499`
- **Semantic timestamp fix head:** `0630ccac7cc1ea8921e9856e2877fd02a7ca9d7e`
- **Semantic timestamp fix tree:** `a280fd2c10ceb078aea3576cc29572145a35e51f`
- **Strict calendar fix head:** `b5ba93cc1d58d2073527a827702c914040f491da`
- **Strict calendar fix tree:** `0e540423877e2aee2e84e6886c0502d2b149e2a7`
- **Canonical timestamp fix head:** `a82c5253552e9c1a672e5c14e7a583bcbeb40cd9`
- **Canonical timestamp fix tree:** `babb7ecd2564facfe476cdf290efd094bd03327a`
- **Reviewed implementation checkpoint:** `5ef2781c2c7acbcf01881fb4b2ce5d765699e878`
- **Reviewed implementation tree:** `0b8689a9c5644f55573468ede5f3b2bc389addc8`
- **Branch:** `b1-0-canonical-product-outbox`

## Scope and outcome

The correction remains bounded to the B1.0 canonical product-outbox prerequisite. It adds no B1 product command, handler, aggregate, route, UI, consumer, worker, job, effect, agent, model call, MCP surface, search integration, deployment code, migration `0004`–`0006`, or `ops.domain_events`.

The corrected implementation provides:

- canonical pending/attempt-zero command and product-outbox creation and exact replay;
- direct completed-command insertion denial, including catalog-owner attempts;
- deferred rejection of a reserved command even after transaction RLS context is changed, cleared, reset, or omitted;
- database-owned outbox lifecycle state and rejection of every forged initial lifecycle state;
- application denial for claim/publication internals and `SELECT *`;
- exact action/version/resource-specific audit safe-detail validation shared by TypeScript and PostgreSQL;
- exact forced-RLS policies, grants, triggers, rules, function owners, ACLs, security mode, and pinned search paths;
- fail-closed adoption for unexpected PUBLIC, direct, inherited, permissive, or same-name catalog objects;
- queue verification before any claim or send;
- bounded send rollback that promptly releases the outbox row and all six authority locks even when the SQS promise never settles; and
- cleanup of relay composition resources when queue verification fails.

One minimal shared migration-runner change sets transaction-local `throughline.migration_batch_applied` before each migration. Migration `0003` uses that transient provenance only to distinguish legitimate same-invocation replay of immutable predecessor migrations from dangerous pre-existing callable trigger-function grants. It creates no persistent schema or runtime behavior.

## Migration identity

- `0001_wave_a2_identity_access_rls.sql`:
  `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql`:
  `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`
- `0003_b1_0_canonical_product_outbox.sql`:
  `094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63`

At the reviewed B1.0 checkpoint, migrations `0001` and `0002` were byte-identical to the correction parent, and no migration after `0003` existed.

## Final pre-result candidate freeze

The tested implementation had 16 changed paths and 223 tracked/non-ignored source files.

Freeze directory:

`/home/ubuntu/.hermes/rollouts/throughline-pr6-correction-20260715/pre-result-freeze-20260715T191332Z`

Artifacts include a temporary index, binary patch, source archive, changed-path inventory, numstat, tracked manifest, and diff check. Important artifact hashes are:

- binary patch: `b003fb4c4c253007d7924dbe69a457ff7455be442b87e35d9f6293d4f219d616`
- changed-source archive: `e664fa9c6170dddd8fa71a24ab6da700f860a0f713bcc1d2194c7010c6002230`
- tracked manifest: `efc6d7648ee691cdf9f4e57d5bf470708c504013bf477305f083ad33a5d7d8fb`
- changed-path inventory: `1885611e5a4796016ff607070212feb949f53cff2f337d71e05bb61c2a07505e`
- numstat: `0ace46bdbad20615363692c33fb10bf97ac0cf0d3c9c2e62774870ddeb0fd419`

`git diff --check` passed.

## Fresh authoritative local gate

A fresh disposable PostgreSQL database and LocalStack generation reran the complete gate after all implementation and result-artifact bytes were finalized on tree `0b8689a9c5644f55573468ede5f3b2bc389addc8` with `CI=1` and `TURBO_FORCE=true`. That tree became reviewed implementation checkpoint `5ef2781c2c7acbcf01881fb4b2ce5d765699e878` without further byte changes.

Run directory:

`/home/ubuntu/.hermes/rollouts/throughline-pr6-correction-20260715/authoritative-gate-20260715T224542Z-314660`

| Command | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test` with integration variables unset | PASS | 547 passed; 233 expected environment-gated skips |
| `pnpm build` | PASS | all build tasks passed |
| `pnpm test:security` | PASS | 96 passed; zero skips |
| `pnpm test:foundation` | PASS | 451 passed; zero skips |
| `pnpm test:b1-0` | PASS | 693 passed; zero skips |
| `git diff --check` | PASS | zero whitespace errors |

The B1.0 authoritative total includes its nested Foundation and security execution. Its direct B1.0 portions were:

- combined preflight and architecture: 22 passed;
- canonical notification envelope: 4 passed;
- migration, audit, repositories, and real PostgreSQL behavior: 109 passed;
- direct authorization: 78 passed;
- product relay unit and PostgreSQL/LocalStack integration: 29 passed.

The product-relay integration included 12/12 real PostgreSQL/LocalStack tests. Standard SQS verification follows AWS behavior: `FifoQueue` is absent for a Standard queue, while explicit FIFO/unexpected values, redrive policy, incorrect/missing retention, missing attributes, and provider failure are rejected.

The gate recorded identical start and end trees, an exact migration journal, zero authoritative skips, and zero unhandled test errors.

Evidence hashes:

- summary: `9d5a643b7c50845b20ea28c62e7ebe712f91c179ae6416619efb3c76e63605ad`
- cleanup: `743e6766e0f207c4507197b28202476fb3c3355d9a7c7fef3cb9ca3f1f7ea372`
- ordinary test log: `43ee535246e96a4986ae76286dfd20da10f52f766155078a75eede7a57b3beec`
- security log: `e20aef71699b4155895b792a44c1a8890ed81cf8dcd845ca35f194bc15dd486e`
- Foundation log: `c504a0cb2fb86e1293056340f927ff4697016eb0982927810ef36c7b8014def1`
- B1.0 log: `87cb8efe3b88b878fd3faa0a95d0b600aa804caddd0e0021f00dfa0125536b9f`
- migration journal: `478ace56c08a6ea10d79e15aea1758fcf6a6349e39d02969237486fc7ab4bc43`

## Cleanup

Before teardown:

- Foundation source queue: zero visible and zero in-flight messages;
- Foundation DLQ: zero visible and zero in-flight messages;
- product queue: zero visible and three in-flight messages produced by accepted-send integration scenarios;
- S3 bucket: zero objects;
- PostgreSQL: zero residual client connections.

Teardown then removed the disposable LocalStack and PostgreSQL containers. This removed all disposable queues, messages, bucket state, and database state. Independent post-run inspection found:

- no matching correction-gate container;
- no process attached to the repository worktree;
- no test watcher, formatter, language server, or Codex writer attached to the worktree; and
- no credential or integration-environment residue in the controlling shell.

## Correction history

Earlier fresh runs were retained as failed evidence rather than presented as passes. They exposed and led to bounded corrections for:

- concurrent ordinary integration suites sharing one database;
- partial integration environment leakage into ordinary tests;
- predecessor-replay provenance during migration adoption;
- PostgreSQL `name[]` driver representation and catalog-query ordering;
- PostgreSQL alias use with `COLLATE`; and
- actual AWS/LocalStack Standard-queue behavior, where `FifoQueue` is omitted rather than returned as `"false"`.

The first detached exact-head gate on `d82d4dc43b8ed452669dd2b492bc952fc97177eb` then found one timing-dependent Vitest unhandled rejection in the never-settling-send regression. The expected publication timeout could occur while the test was deliberately waiting for lock contenders but before the test attached its rejection assertion. Production deadline handling and lock release were correct, but the test-authority failure was a blocker. Commit `cd8a2d9c6f237937254bbe5d5f4b316364ea7fde` attaches an immediate rejection observer while retaining the later exact `TimeoutError` assertion. The focused B1.0 gate and the complete authoritative gate then passed with zero unhandled errors.

A fresh direct read-only review of `2ea00def3fa375f8da2a6b365d57f418dc8133d6` then found that the TypeScript and PostgreSQL audit validators accepted timestamp-shaped but semantically invalid `relationship.end` values such as hour 25, even though the canonical notification parser rejects them. Commit `0630ccac7cc1ea8921e9856e2877fd02a7ca9d7e` adds the semantic check to TypeScript and PostgreSQL and an exact shared rejection vector. The focused 106-test database gate and the complete authoritative gate passed afterward.

The next direct read-only review found one remaining language mismatch: JavaScript `Date.parse` normalizes calendar overflow such as February 30 while PostgreSQL rejects the original timestamp. Commit `b5ba93cc1d58d2073527a827702c914040f491da` makes the TypeScript and PostgreSQL validators both enforce valid calendar dates, hour/minute/second ranges, and the PostgreSQL-compatible maximum numeric offset, with shared rejection vectors for calendar overflow, hour overflow, leap seconds, and offset overflow. The focused 109-test database gate and the complete authoritative gate passed afterward.

The following exact-head review identified that the canonical domain-notification parser still used its older `Date.parse`-only rule. Commit `a82c5253552e9c1a672e5c14e7a583bcbeb40cd9` moves the strict TypeScript timestamp contract into the canonical core-types module, makes audit validation reuse that single implementation, and adds canonical envelope rejection coverage for the same calendar and range cases. The complete authoritative gate passed afterward.

After the last implementation byte changed, the complete authoritative gate was rerun from frozen install and passed.

## Review and publication state

Reviewed implementation checkpoint `5ef2781c2c7acbcf01881fb4b2ce5d765699e878` completed every authorized publication gate:

- the complete authoritative PostgreSQL/LocalStack gate passed on exact tree `0b8689a9c5644f55573468ede5f3b2bc389addc8` with zero authoritative skips and zero unhandled errors;
- the detached exact-head authoritative verifier passed on the same head and tree; its summary SHA-256 is `7a25a000ca9ef1439a896d1d7fad624daadc30bd9d89660f1883629690bdb760` and cleanup SHA-256 is `40a083fb7f237afb06842842f813807f8f2073d2f812b42f1bb5e8a8d88a3df2`;
- the direct read-only exact-head reviewer returned PASS with no actionable regressions or correctness issues; report SHA-256: `345bb08eaebe18d591437d2c190dbea21ef8d47077c88684854d2ec81c6a823e`;
- the branch was pushed normally and PR #6 advanced to that exact head; and
- GitHub Actions run `29458169560` completed successfully on that exact head (`verify`, job `87495840518`).

The historical failed and intermediate review attempts above remain evidence of the correction path; none is substituted for the final exact-head passes.

At the historical pre-merge checkpoint, PR #6 was open and unmerged, and merge, deployment,
release, B1 implementation, real Kanban dispatch, AWS/runtime access, canonical-document changes,
and accepted-ADR changes were explicitly on HOLD. The authorized PR head
`228900dd822cb3b5ed22ee674fb0a5cf98fa8560` was subsequently squash-merged as
`2566cb4649c24217058d32de6a0e088b303bb07b` with tree
`97782492085cc637e426eced81f46d3ede684cfd` and sole parent
`b454ae8c865c77639adbf82daf8963db67922ad6` at `2026-07-16T15:53:00Z`. Post-merge CI succeeded:

`https://github.com/alindebergASL/throughline/actions/runs/29513153082`

The merge checkpoint is:

`https://github.com/alindebergASL/throughline/pull/6#issuecomment-4993983399`
