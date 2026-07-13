# Wave A Foundation Closure Result — Asynchronous Isolation

- **Status:** implementation complete; independently reviewed `PASS`
- **Authorized base:** `6dec188bbd341576e966d0df7040f2eeddba3418`
- **Task 9 checkpoint:** `bfc99efe2a16161eb305d75e5df3c8b1ce1124c7`
- **Previously blocked implementation:** `d8df5d1ad910a0f6770ae01b4b6f2e73f0a6b957`
- **Reviewed implementation and CI-race correction:** `6f075e11edb68ad5dd73aaac56ddf01a1032918e`
- **Tested and reviewed tree:** `5c1fcd072bd291afd91b7738385a2315741d568c`
- **Production implementation checkpoint:** `e44a4907ed82eb5f95cb3c8f8a842fdcf95eaa71`
- **Branch:** `foundation-closure-async-isolation`

## Scope and outcome

This result closes only the asynchronous Foundation obligations described by
`WAVE_A_FOUNDATION_CLOSURE_PLAN.md`. It does not add product-domain entities, model/provider behavior,
MCP, retrieval, UI, production infrastructure, or deployment behavior.

The completed proof covers one authenticated API request committing a signed context reference,
neutral proof aggregate, and transactional outbox event; relay publication through a dedicated
least-privilege PostgreSQL role to LocalStack SQS; worker-side signed-reference rehydration and live
reauthorization; one idempotent PostgreSQL effect; and end-to-end OpenTelemetry continuity under
Tenant, Workspace, and Space isolation.

No deployment, merge, B1 work, canonical-document change, or accepted-ADR work was performed.

## Accepted review BLOCK and correction

The first independent implementation review blocked `d8df5d1` because `claimNext()` authorized and
committed before `SendMessage`, leaving an unlocked interval in which relay authority could be
revoked while the already claimed event was still published.

The corrected implementation treats `claimNext()` only as scheduling and lease acquisition. It
persists a random claim token and grants no later publication authority. Final publication now:

1. asserts the dedicated `throughline_relay` database role;
2. initializes transaction-local scope;
3. locks and re-reads the exact outbox row by event ID, claim identity, attempt, token, and live lease;
4. reconstructs the immutable publication envelope from persisted database state;
5. locks the Tenant, Workspace, policy-version, relay-service-principal, Space, and direct-manager
   relationship rows in one deterministic order;
6. performs fresh centralized `foundation.relay.publish` authorization;
7. executes the bounded SQS `SendMessage` while the PostgreSQL transaction and all authority locks
   remain open;
8. records the publication marker using the same PostgreSQL client and transaction; and
9. commits, or rolls back only after the send operation has settled.

The publisher receives only an immutable publication request. It receives neither a PostgreSQL
client nor arbitrary SQL capability, and callers cannot substitute a stale or fabricated envelope.

## Serialization and bounded stronger-lock residual

Real PostgreSQL and LocalStack tests exercised both serialization orders for all six authority
inputs.

- When revocation committed before final publication acquired the authority locks, revocation won:
  no `SendMessage`, publication marker, idempotency record, or worker effect was created.
- When final publication locked valid authority first, publication won: revocation waited across the
  real `SendMessage` and database completion or rollback. The six commit cases each continued
  through the real worker and proved one logical event, one idempotency record, and exactly one
  durable effect.

The authority tables use twelve functional relay policies: one scoped `SELECT` policy and one
lock-only `UPDATE` policy for each of the six authority inputs. Six restrictive no-write companion
policies and six column-level `UPDATE(id)` grants permit PostgreSQL row locking without permitting a
successful authority-row mutation. The residual is stronger locking capability on those exact
scoped authority rows. It is bounded by RLS, restrictive `WITH CHECK (false)` composition,
least-privilege grants, fixed parameterized repository surfaces, dedicated `NOBYPASSRLS` roles, and
negative privilege tests. No owner, `BYPASSRLS`, `SECURITY DEFINER`, generic SQL callback, schema
creation, inherited/PUBLIC write, partition, trigger, rule, or ownership escape was introduced.

## API, relay, queue, and worker evidence

The authoritative real-service proof covered:

- test-only authenticated API identity resolution and centralized authorization;
- one PostgreSQL transaction for reference, aggregate, and outbox visibility, including forced
  reference/outbox failures and pre-commit invisibility;
- committed-event claiming with `FOR UPDATE SKIP LOCKED` and a persisted unforgeable claim token;
- fresh relay reauthorization at final publication;
- mandatory body/attribute agreement for routing key, Tenant, Workspace, Space, event, job, request,
  `traceparent`, and conditional `tracestate` metadata;
- signed-reference binding, expiry, revocation, delegation, worker/principal binding, and active plus
  prior verification-key rotation behavior;
- retryable and terminal relay outcomes without direct relay DLQ publication;
- real accepted-send/marker-rollback ambiguity, reclaim with a new token and attempt, stable event,
  job, reference, scope, routing, body, and worker-idempotency identities, and duplicate SQS
  publication;
- a real post-commit client-response ambiguity resolved by a fresh exact database-truth lookup,
  without a second send or false unpublished state;
- two real duplicate deliveries producing one applied worker result, one confirmed duplicate, one
  idempotency record, and exactly one durable effect;
- the worker's 30-second receipt visibility, one extension attempt at 15 seconds, unchanged absolute
  20-second lifecycle deadline, cancellation, transaction rollback, and no deadline reset;
- post-commit `DeleteMessage` failure followed by exact duplicate redelivery;
- broker-native SQS redrive at receive counts 1, 2, and 3 into the dedicated DLQ, with no worker
  delete and no relay-side DLQ send;
- Tenant, Workspace, Space, queue-routing, cache-key, and S3 object-key isolation;
- the complete terminal-denial no-effect matrix; and
- one continuous API, database/outbox, relay, queue, and worker trace without raw context, signing
  keys, DSNs, credentials, or sensitive authority values in emitted evidence.

The event ID is correlation metadata only. It is not part of the signed authority payload and cannot
replace the signed job, Tenant, Workspace, Space, worker-principal, policy-version, expiry, or
reference bindings.

## GitHub Actions fixture-race correction

The first pull-request Actions execution for reviewed result head
`77e8c389ada6c009166656819c3405717b1fa064` failed in the Foundation gate:
<https://github.com/alindebergASL/throughline/actions/runs/29209051826>. Formatting, lint,
typecheck, ordinary tests, build, and the standalone PostgreSQL security gate had already passed.

The raw log showed `foundation-security.spec.ts` and `worker-transaction.postgres.spec.ts` running
concurrently against one shared PostgreSQL database. Both files reset and provision the disposable
schema and roles. The worker file therefore changed the shared fixture while the security file was
executing, producing missing-schema, `NOLOGIN`, and transaction-aborted cascade failures. This was a
test-runner file-parallelism race, not a production authorization failure.

`package.json` now adds Vitest `--no-file-parallelism` to all six direct authoritative Foundation
Vitest invocations. The pinned Vitest 3.2.6 recognizes that option and executes the files with one
worker. The exact corrected database invocation passed both files and all 87 tests, after which the
entire fresh disposable-resource gate below was rerun. Production implementation paths remained
byte-identical to `e44a4907ed82eb5f95cb3c8f8a842fdcf95eaa71`.

## Authoritative gate

The final gate used a newly provisioned disposable PostgreSQL database, a LocalStack source queue
with a dedicated native-redrive DLQ, and a scoped LocalStack S3 bucket. `TURBO_FORCE=true` forced all
Turbo tasks to execute without cache reliance.

| Command | Exit | Duration | Observed result |
| --- | ---: | ---: | --- |
| `npm exec -- pnpm install --frozen-lockfile` | 0 | 2.172 s | frozen installation state accepted |
| `npm exec -- pnpm format:check` | 0 | 8.327 s | formatting accepted |
| `npm exec -- pnpm lint` | 0 | 151.254 s | all lint tasks passed |
| `npm exec -- pnpm typecheck` | 0 | 107.863 s | all typecheck tasks passed |
| `npm exec -- pnpm test` | 0 | 70.766 s | 404 passed; 204 expected environment-gated skips |
| `npm exec -- pnpm build` | 0 | 103.700 s | all build tasks passed |
| `npm exec -- pnpm test:security` | 0 | 24.197 s | DB 18 passed; authorization 70 passed |
| `npm exec -- pnpm test:foundation` | 0 | 73.524 s | all authoritative suites passed with zero skips |

The Foundation invocation recorded these executions:

- embedded security execution: 18 database tests and 70 authorization tests passed;
- Foundation database and worker-transaction execution: 87 passed;
- direct Foundation authorization execution: 70 passed;
- API, real-chain, and telemetry execution: 56 passed;
- relay real-service execution: 40 passed;
- worker context/runtime execution: 71 passed;
- worker real-service execution: 22 passed; and
- scoped S3 marker execution: 1 passed.

The two 70-test authorization entries are two executions of that suite. They are not represented as
140 unique authorization test cases.

Ordinary-test skips were limited to the documented environment-gated PostgreSQL/LocalStack and
authorization cases. The authoritative Foundation invocation supplied those resources and recorded
zero skips.

## Fail-closed preflight evidence

The legacy negative probe ran `pnpm test:security` without owner or app database variables. It exited
`1` in 1.257 seconds, identified both `TEST_DATABASE_URL` and `TEST_APP_DATABASE_URL` as missing,
and stopped before Turbo/Vitest execution or skip reporting. No configured DSN, database password,
or verification-key value appeared in its output.

The Foundation preflight negative matrix passed 20 of 20 cases. Every case exited nonzero with its
expected error code before tests started and without leaking the supplied value. The matrix covered
missing variables; non-distinct DSNs; wrong owner, app, relay, and worker roles; non-loopback
PostgreSQL/SQS endpoints; unsafe database, queue, DLQ, and bucket names; identical source/DLQ URLs;
endpoint/account mismatches; non-dummy AWS credentials; and unsafe verification-key IDs.

## Migration, topology, cleanup, and environment restoration

The fresh database began without a migration journal and recorded:

- `0001_wave_a2_identity_access_rls.sql` —
  `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql` —
  `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`

Before resource deletion, the source queue, DLQ, and S3 bucket were empty; the source queue's
redrive policy targeted the dedicated DLQ with `maxReceiveCount=3`; no temporary test trigger,
function, or rule remained; no app, relay, or worker database connection remained; and no gate or
test process remained. Test database and service variables were absent from the parent shell.

The disposable database, source queue, DLQ, and bucket were then deleted, and independent absence
checks confirmed that all four resource classes were gone.

The tested pre-gate and post-gate binary patches were byte-identical, and the tested staged tree was
exactly `5c1fcd072bd291afd91b7738385a2315741d568c`, the tree committed at the reviewed implementation and
CI-race-correction SHA.

## Independent review

Claude Fable was unavailable because of its spend limit and is therefore not review evidence.

A fresh isolated, read-only fallback Codex reviewer inspected the exact implementation and
CI-race-correction head, the base and Task 10 diffs, the accepted BLOCK, failed Actions evidence,
corrected serial proof, authoritative raw logs, canonical kickoff, both backlog formats, Build Spec,
ADRs 015–020, repository instructions, and the Foundation Closure plan. It returned:

- `VERDICT: PASS`
- `REVIEWED_SHA: 6f075e11edb68ad5dd73aaac56ddf01a1032918e`
- `REVIEWED_TREE: 5c1fcd072bd291afd91b7738385a2315741d568c`
- `PRODUCTION_PATHS_UNCHANGED_FROM_E44: yes`
- `BLOCKING_FINDINGS: none`
- `FILES_MODIFIED: none`

The reviewer retained four non-blocking observations: bounded visibility-extension delay behavior,
fixed dummy CI HMAC material that production runtime rejects, two worker lock assertions that could
use catalog observation instead of bounded non-completion windows, and the accepted stronger-lock
residual described above. None violated a Foundation Closure acceptance criterion.

## Explicit stop state

This result records implementation and review evidence only. At the time this revision was written:

- no deployment occurred;
- B1 was not started;
- no merge occurred;
- no canonical document or accepted ADR was changed;
- PR <https://github.com/alindebergASL/throughline/pull/4> was open at the prior reviewed result head;
- its first Actions run had the fixture-race failure recorded above;
- no Actions success existed for `6f075e11edb68ad5dd73aaac56ddf01a1032918e`; and
- the SHA for this separate result-document correction did not yet exist.
