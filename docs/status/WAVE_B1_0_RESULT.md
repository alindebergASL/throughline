# Wave B1.0 Result — Canonical Product Outbox Correction

- **Date:** 2026-07-15
- **Status:** corrected implementation and post-review timeout-observer fix verified locally; final result-bearing regate, exact-head reviews, push, and CI pending
- **PR:** `alindebergASL/throughline#6`
- **Authorized base:** `b454ae8c865c77639adbf82daf8963db67922ad6`
- **Correction parent:** `7d385391d08e0fdd2605a628960ee920fe75c7ca`
- **Parent tree:** `017c78aed14f39772451baf8407be7abf9eea90a`
- **Tested pre-result implementation tree:** `8152155cfc3970cc8e3fd2b633ac38d1faad2bc3`
- **Post-review fix head:** `cd8a2d9c6f237937254bbe5d5f4b316364ea7fde`
- **Post-review fix tree:** `7ebf1d18ff69e6442cf2bbc69b6a574868773499`
- **Branch:** `b1-0-canonical-product-outbox`
- **Local commits:** `e10fffd1abe264ae8e553ea2b8a8f17675c6988b`, `d82d4dc43b8ed452669dd2b492bc952fc97177eb`, `cd8a2d9c6f237937254bbe5d5f4b316364ea7fde`

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
  `01ac2dd3993911aff3b7104623f007f2147e5f3d9c72fd394ea87666861b4da7`

Migrations `0001` and `0002` are byte-identical to the correction parent. No migration after `0003` exists.

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

A fresh disposable PostgreSQL database and LocalStack generation reran the complete gate after the detached-verifier timeout-observer fix on tree `7ebf1d18ff69e6442cf2bbc69b6a574868773499` with `CI=1` and `TURBO_FORCE=true`.

Run directory:

`/home/ubuntu/.hermes/rollouts/throughline-pr6-correction-20260715/authoritative-gate-20260715T195307Z-114676`

| Command | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted |
| `pnpm format:check` | PASS | zero formatting errors |
| `pnpm lint` | PASS | zero lint errors |
| `pnpm typecheck` | PASS | zero type errors |
| ordinary `pnpm test` with integration variables unset | PASS | 542 passed; 233 expected environment-gated skips |
| `pnpm build` | PASS | all build tasks passed |
| `pnpm test:security` | PASS | 96 passed; zero skips |
| `pnpm test:foundation` | PASS | 451 passed; zero skips |
| `pnpm test:b1-0` | PASS | 688 passed; zero skips |
| `git diff --check` | PASS | zero whitespace errors |

The B1.0 authoritative total includes its nested Foundation and security execution. Its direct B1.0 portions were:

- combined preflight and architecture: 22 passed;
- canonical notification envelope: 3 passed;
- migration, audit, repositories, and real PostgreSQL behavior: 105 passed;
- direct authorization: 78 passed;
- product relay unit and PostgreSQL/LocalStack integration: 29 passed.

The product-relay integration included 12/12 real PostgreSQL/LocalStack tests. Standard SQS verification follows AWS behavior: `FifoQueue` is absent for a Standard queue, while explicit FIFO/unexpected values, redrive policy, incorrect/missing retention, missing attributes, and provider failure are rejected.

The gate recorded identical start and end trees, an exact migration journal, zero authoritative skips, and zero unhandled test errors.

Evidence hashes:

- summary: `5197d70ace9fa9f750e2a247907fe7ae42f7c2d9d1db34bb672f8c574c72a6c2`
- cleanup: `65afa5f12ab4fe803bfd57e5b936768d9a692694a3dbff4d1e54dffc9bd99586`
- ordinary test log: `c13e39c21c2aba9e9ff647efe1d6ad364c7b0617b4ebe5d67f9a598c6aa3d81c`
- security log: `e2aec7c193f85a366aa6852aabd5d91e27426448596b1ba75ffc4296bb661fa5`
- Foundation log: `fc48a92d26e6fdadaeb63d0c9eb527a11589a68147b275bd16040cf44a050836`
- B1.0 log: `7f3611f258550b3133f2f101c828ae02c9a3cb36ec22f8a3709c4e603a062f3b`
- migration journal: `6481f717fde9d0bd8cf8569be4964ed9c556cfb55e273dbe7a8e302b8d92c466`

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

After the last implementation byte changed, the complete authoritative gate was rerun from frozen install and passed.

## Review and publication state

At the time this result was updated:

- three bounded local correction commits existed through `cd8a2d9c6f237937254bbe5d5f4b316364ea7fde`;
- the first detached gate on `d82d4dc43b8ed452669dd2b492bc952fc97177eb` returned HOLD on the unhandled-rejection blocker;
- a direct read-only review of `d82d4dc43b8ed452669dd2b492bc952fc97177eb` found no source-level blocker before that timing-dependent test-authority failure was observed;
- fresh detached and direct read-only reviews of the final result-bearing head remained pending;
- no correction commit had been pushed;
- no exact-head GitHub Actions result existed for the correction; and
- no merge, deployment, B1 start, Kanban enablement, AWS access, or runtime-host access occurred.

PR #6 remains on HOLD until the result-bearing tree passes the complete gate, bounded commits are created, both exact-head reviews return PASS, the branch is pushed normally, and GitHub Actions succeeds on that exact head. The required stop point remains before merge.