# Wave B1.0 Result — Canonical Product Outbox Prerequisite

- **Date:** 2026-07-15
- **Status:** implementation candidate verified locally; exact-head review and GitHub CI pending
- **Authorized base:** `b454ae8c865c77639adbf82daf8963db67922ad6`
- **Branch:** `b1-0-canonical-product-outbox`
- **Tested pre-result implementation tree:** `d519f0f51af786d08160dae18bef40b2f5a8723f`
- **Commit:** pending at the time this result was written

## Scope and outcome

This candidate implements only the B1.0 prerequisite defined by `WAVE_B1_PLAN.md`:

- a closed, versioned, canonically serialized `DomainNotificationEnvelope`;
- migration `0003_b1_0_canonical_product_outbox.sql` for the secured command, audit, and product-outbox substrate;
- fixed transaction-bound command, audit, and outbox repositories;
- centralized product-relay authorization and bounded server-owned claim handles;
- deterministic authority locking around bounded Standard-SQS publication;
- fail-closed combined Foundation/B1.0 test preflight; and
- real PostgreSQL and LocalStack verification plus additive CI wiring.

It does not add B1 product commands, handlers, aggregates, routes, UI, consumers, workers, jobs, effects,
agents, model calls, MCP, search, integrations, migrations `0004`–`0006`, or `ops.domain_events`.
No deployment, release, merge, real Kanban dispatch, canonical-document edit, accepted-ADR edit,
Throughline runtime-host action, or real-AWS action occurred.

## Migration and security behavior

Migration `0003` creates and secures:

- `ops.domain_command_records`;
- `ops.audit_events`; and
- `ops.product_outbox_events`.

The migration retains forced RLS, exact least-privilege grants, fixed policies, immutable application envelope
fields, bounded relay publication fields, one-way command completion, append-only audit behavior, and
cross-scope causation constraints. Its adoption path accepts only catalog-equivalent existing objects and
fails closed on a wrong same-name function, table, index, constraint, trigger, or policy.

Real PostgreSQL debugging found and corrected replay hazards involving index adoption, ambiguous
PL/pgSQL record aliases, `name[]` catalog values, foreign keys on temporary contract tables,
constraint-trigger classification, and caller-dependent `search_path`. The final migration canonicalizes
its search path and uses a transaction-scoped access-revoked contract schema for exact structural
comparison. Bounded first-difference diagnostics contain schema metadata only.

Migration hashes on the verified candidate were:

- `0001_wave_a2_identity_access_rls.sql` —
  `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7`
- `0002_foundation_closure_async_isolation.sql` —
  `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2`
- `0003_b1_0_canonical_product_outbox.sql` —
  `8a152357bf85a383ae98f968e57e4913e24b1e906bd1ffc75e55b1f566ff30c6`

Migrations `0001` and `0002` remained byte-identical. No migration after `0003` existed.

## Command, audit, and outbox behavior

The application composition uses one caller-owned transaction and fixed parameterized repository
statements. The command reservation is stable-parent idempotent, audit and outbox causation is immediate
and same-scope, and a forced failure rolls back all three writes.

Application outbox replay uses the semantic uniqueness conflict as its serialization point and performs a
read-only exact-envelope comparison. It does not grant or require application `UPDATE` authority on the
product outbox.

The product relay:

1. claims one eligible row with `FOR UPDATE SKIP LOCKED`;
2. persists a random token and one millisecond-precision database claim timestamp;
3. binds the handle to event, scope, relay principal, policy, owner, token, attempt, timestamps, and exact
   canonical envelope;
4. locks and re-reads the exact claimed row;
5. locks all authority inputs in one deterministic order;
6. performs fresh centralized authorization;
7. performs one bounded SQS `SendMessage` while the PostgreSQL transaction and authority locks remain
   open; and
8. records publication or rolls back after the send settles.

Persisting claim timestamps at one millisecond-precision database instant preserves exact
PostgreSQL-to-JavaScript-to-PostgreSQL binding without approximate comparisons. Deterministic attempt-six
failures become `terminal_failed`; ambiguous exhausted sends become `terminal_unconfirmed`. An accepted
send followed by marker rollback can be retried with the same logical event ID and canonical envelope, so
publication remains explicitly at-least-once.

## Fail-closed preflight

The repository-owned B1.0 preflight invokes the Foundation parser before product validation and rejects
unsafe configuration before Turbo, Vitest, PostgreSQL, or LocalStack access. The matrix covers:

- every missing or blank required variable;
- pairwise reuse across the owner, app, Foundation-relay, Foundation-worker, and product-relay DSNs;
- every incorrect database role;
- non-loopback or malformed PostgreSQL and LocalStack/SQS URLs;
- unsafe database, source-queue, DLQ, product-queue, and bucket names;
- endpoint, account, URL, and name collisions across all three queues;
- FIFO product-queue configuration;
- non-dummy AWS credentials and invalid regions; and
- malformed key maps, unsafe or missing key identifiers, and invalid key material.

Errors expose only stable codes and sanitized messages. The focused combined
preflight/Foundation/architecture run passed 35 tests. A separate no-environment subprocess exited `1`
with `MISSING_VARIABLE`, started neither Turbo nor Vitest, made no `AF_INET`/`AF_INET6` connection, and
printed no supplied connection or credential value. The only observed `connect` attempts were local
`AF_UNIX` attempts by the `tsx` loader.

## Complete local verification

The complete local suite used `CI=1` and `TURBO_FORCE=true`:

| Command | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PASS | frozen lockfile accepted; no lockfile drift |
| `pnpm format:check` | PASS | all files formatted |
| `pnpm lint` | PASS | 28/28 tasks; zero cached |
| `pnpm typecheck` | PASS | 28/28 tasks; zero cached |
| ordinary `pnpm test` with integration variables unset | PASS | 466 passed; 226 expected environment-gated skips; zero failures |
| `pnpm build` | PASS | 21/21 tasks; zero cached |
| `git diff --check` | PASS | no whitespace errors |

Log:
`/home/ubuntu/.hermes/rollouts/throughline-b1-0-implementation-20260714/full-local-suite-20260715T015551Z-3622409.log`

SHA-256:
`1002b6c1a26ab28a3b85e5a4eb846aaacd43248c69a31d4dbf6cc853a0be62ff`

Ordinary-test skips were limited to suites intentionally gated on absent PostgreSQL/LocalStack variables.
The authoritative gates below supplied those resources and recorded zero skips and zero unhandled errors.

## Fresh standalone security gate

A separate disposable PostgreSQL generation ran `pnpm test:security` with `TURBO_FORCE=true`:

- database security: 18 passed;
- authorization security: 78 passed;
- authoritative skips: zero;
- unhandled errors: zero.

Log:
`/home/ubuntu/.hermes/rollouts/throughline-b1-0-implementation-20260714/focused-b1-0-gate-20260715T020724Z-3637009.log`

SHA-256:
`05129c71fd3173cf38068ef2c236be1bf9f2a48ba91e3d530510993756b3e4b7`

## Fresh standalone Foundation gate

A separate disposable PostgreSQL/LocalStack generation ran `pnpm test:foundation` with
`TURBO_FORCE=true`:

- embedded database security: 18 passed;
- embedded authorization security: 78 passed;
- Foundation database and worker transaction: 87 passed;
- direct authorization: 78 passed;
- API, real-chain, and telemetry: 56 passed;
- relay real-service: 40 passed;
- worker context and runtime: 71 passed;
- worker real-service: 22 passed;
- scoped S3 marker: 1 passed;
- authoritative skips: zero;
- unhandled errors: zero.

Log:
`/home/ubuntu/.hermes/rollouts/throughline-b1-0-implementation-20260714/focused-b1-0-gate-20260715T020854Z-3639242.log`

SHA-256:
`abf73d7fed0d7ce8dd209cf1109c11236b24c5c3ab1082b4e6e04e113e8cca8a`

## Fresh uncached B1.0 gate

The final pre-result gate used a new disposable PostgreSQL database and LocalStack generation with
`TURBO_FORCE=true`. The product queue was Standard, had `MessageRetentionPeriod=86400`, had no redrive
policy, and had no consumer.

The B1.0 invocation recorded:

- combined B1.0 preflight and architecture: 22 passed;
- canonical notification envelope: 3 passed;
- migration, repositories, and real PostgreSQL product-domain behavior: 35 passed;
- direct authorization: 78 passed;
- product relay unit and real LocalStack behavior: 16 passed;
- complete nested Foundation execution: PASS;
- authoritative skips: zero; and
- unhandled errors: zero.

Log:
`/home/ubuntu/.hermes/rollouts/throughline-b1-0-implementation-20260714/focused-b1-0-gate-20260715T021455Z-3651298.log`

Log SHA-256:
`8502344f02068dbc34285ce41ebb27855a06d60247d64c2b78a630b28b70dcab`

Resource record:
`/home/ubuntu/.hermes/rollouts/throughline-b1-0-implementation-20260714/focused-resources-20260715T021455Z-3651298.txt`

Resource-record SHA-256:
`7139db4f46de2f860ea7fc3d7544fb13b5ca7b53b4e4034027e2c571162fac7a`

Independent post-run checks found no matching disposable PostgreSQL or LocalStack container, including no
container carrying invocation suffix `3651298`.

## Candidate identity and hygiene

The tested pre-result implementation consisted of 218 tracked and non-ignored source files. Its manifest
is:

`/home/ubuntu/.hermes/rollouts/throughline-b1-0-implementation-20260714/candidate-pre-result-20260715T021923Z.sha256`

Manifest SHA-256:
`71ee0863c906ecaf77a617302f398da6609e56060b65bf8eca83edf55091b660`

Path inventory SHA-256:
`8dcce7f1982155dfb0e52e175da013963caeebc3f347227e6ca7f160a10fa5e8`

A temporary Git index produced tested implementation tree
`d519f0f51af786d08160dae18bef40b2f5a8723f` with 30 changed paths. The changed-path record SHA-256 is
`09b1216bc9781ffd22dc81fd6a48acb584b376fbaa8ca41a0bc68221f62bda8a`.

There was no `pnpm-lock.yaml` drift. Generated and ignored artifacts were limited to expected
`node_modules`, `dist`, `.next`, and `.turbo` output. Credential scanning found only explicit negative-test
markers and deliberately rejected endpoint fixtures; it found no tracked real AWS key, private key,
runtime DSN, password, raw security context, queue-body log, or signing material.

## Review and publication state

At the time this result was written:

- no implementation commit existed;
- no detached exact-head verifier had run;
- no direct-launch exact-head reviewer had run;
- no implementation branch had been pushed;
- no B1.0 implementation pull request existed;
- no exact-head GitHub Actions result existed; and
- no merge was authorized or performed.

The candidate remains on HOLD until the result-bearing tree is mechanically checked and committed, both
independent exact-head reviews return PASS, the branch is pushed normally, the scoped PR is opened, and
GitHub Actions succeeds on that exact head. The required stop point remains before merge and before B1.
