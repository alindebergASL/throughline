# Wave A Foundation Closure Plan — Asynchronous Isolation

> **Plan only.** Do not implement this plan until Andrew explicitly approves it. This closure is
> not Wave A3 and does not authorize B1, deployment, or any product-domain work.

- **Date:** 2026-07-10
- **Plan branch:** `docs-post-a2-foundation-closure`
- **Proposed implementation branch:** `foundation-closure-async-isolation`
- **Base for this plan:** `b6b2e41a933fcf18587d721d1e3233c490729d18`
- **Wave owner:** Hermes
- **Primary implementation:** Codex CLI
- **Independent reviewer:** Claude Code CLI or an isolated fallback reviewer

## Goal

Close only the asynchronous and cross-boundary foundation evidence left open after the scoped A2
merge. The completed proof must show one authenticated API request atomically committing a signed
context reference, neutral test aggregate, and outbox event; the relay publishing the committed
event to LocalStack SQS; and an idempotent worker rehydrating the signed/opaque SecurityContext
reference, reauthorizing live, and consuming the job under tenant/workspace/Space isolation with
one propagated OpenTelemetry trace.

## Why this is a Foundation Closure rather than a new product wave

The scoped A2 implementation merged tenancy, identity, centralized authorization,
transaction-local PostgreSQL RLS context, and direct database denial evidence. It did not close all
of the broader canonical Wave A gates:

- `docs/IMPLEMENTATION_KICKOFF_v0.1.md` requires a traced request to commit a row, emit an outbox
  event, and be processed by a worker;
- the same kickoff requires default-deny isolation across API, SQL, queue, cache key, object key,
  and worker execution;
- backlog TL-003 requires an atomic database/outbox write, relay publication, and idempotent worker;
- backlog TL-004 requires one trace across request, transaction, relay, and worker;
- backlog TL-008 requires a signed context reference, worker rehydration, and live
  reauthorization;
- the Build Spec requires queue payloads to carry a signed reference rather than an editable
  client-supplied context.

This plan closes those foundation obligations without starting the work graph or any later wave.

## Canonical documents consulted

- `docs/BUILD_SPEC_v0.1.1.md`
  - selected stack: PostgreSQL, SQS, transactional outbox, OpenTelemetry, and LocalStack;
  - request/job SecurityContext propagation rules;
  - transaction-local RLS requirements;
  - transactional outbox and idempotent worker rules;
  - tenant/workspace/Space object-key prefixes;
  - API → outbox → worker integration and cross-tenant security tests;
  - P0-1 and P0-2 completion criteria.
- `docs/IMPLEMENTATION_KICKOFF_v0.1.md`
  - Wave A1 traced request/outbox/worker gate;
  - Wave A2 cross-boundary default-deny gate;
  - B1 boundary, which remains out of scope.
- `backlog/phase0_backlog.md` and `backlog/phase0_backlog.csv`
  - TL-003, TL-004, TL-008, and the async portion of TL-010.
- `AGENTS.md` and `CLAUDE.md`
  - scope discipline, central `can()`, RLS, worker isolation, and stop conditions.
- Accepted ADRs:
  - ADR-015: provider-neutral identity and deterministic local identity;
  - ADR-016: explicit transactions, `SET LOCAL`, `NOBYPASSRLS`, and `FORCE ROW LEVEL SECURITY`;
  - ADR-017 and ADR-018: remain binding but are not exercised because source/provenance and
    derived-object scope is excluded;
  - ADR-019: idempotent transactional writes and outbox-event discipline, without implementing
    Domain Commands or ChangeSets in this closure;
  - ADR-020: durable retry/idempotency principles, without implementing AgentRun, ChangeSet,
    ExecutionReceipt, atomic groups, or compensation.

The canonical kickoff and Build Spec remain unchanged by this plan.

## Scope

### In scope

1. A signed context-reference row and neutral foundation test aggregate written in PostgreSQL
   together with an outbox row in one transaction.
2. An outbox relay that publishes committed, unpublished rows to LocalStack SQS and records publish
   success only after SQS acknowledges the message.
3. An idempotent worker consumer that applies the neutral test effect at most once.
4. A signed, opaque SecurityContext reference bound to one job, tenant, workspace, and Space.
5. Worker-side signature verification, database rehydration, expiry/revocation checks, and live
   reauthorization immediately before handler execution.
6. Fail-closed denial for forged, expired, revoked, duplicate, stale, and cross-tenant jobs.
7. Shared tenant/workspace/Space-scoped queue-routing, cache-key, and object-key builders.
8. OpenTelemetry context propagation across API, database/outbox, relay, SQS, and worker spans.
9. PostgreSQL plus LocalStack SQS/S3 integration coverage in local verification and CI.
10. Documentation and run-command updates required to operate the deterministic test proof.

### Explicit non-goals

- Organization, Initiative, Activity, Engagement, or Relationship.
- ContentItem, SourceArtifact, or SourceChunk.
- Claim, AcceptedFact, DerivedView, ChangeSet, ProposedOperation, or ExecutionReceipt.
- AgentRun, Skill registry, model invocation, or any model/provider selection.
- MCP, provider adapters, extraction, retrieval, embeddings, search, or product UI.
- Production authentication integration, external connector behavior, or external write actions.
- A generic event platform, workflow engine, cache backend, object-ingestion system, or microservice
  split.
- B1 planning or implementation.
- Deployment or production infrastructure changes.

## Locked design constraints

### 1. The proof aggregate is operational, not product-domain data

Use a narrowly named test aggregate solely to prove the transaction/outbox/worker path. It must not
model an Organization, Initiative, Activity, ContentItem, source, claim, or ChangeSet. The proof
must remain removable without migrating product-domain state.

### 2. The database commit and outbox insert are atomic

A single transaction under `withTenantTransaction()` must:

1. create the scoped `ops.security_context_references` row and signed token;
2. insert or update the neutral test aggregate;
3. insert the `ops.outbox_events` row with a composite foreign key to that exact reference/job/scope;
4. commit all three rows or roll back all three.

The signed token may be computed in memory before its row is inserted, but neither the reference,
aggregate, nor outbox event may become independently visible. Tests must force both reference
insertion failure and outbox insertion failure and prove that none of the three rows persists.

The proof request must traverse a real test-only API authentication and authorization boundary. The
controller is present only in the test Foundation module, never the normal `AppModule`, and must:

1. require `AUTH_ADAPTER=dev` in a non-production process;
2. call the existing `resolveDevIdentityFromHeaders()` guard rather than accept a SecurityContext,
   tenant, workspace, user, membership, role, or permission from the request body;
3. reject missing/unknown deterministic identity aliases and every forbidden authority header;
4. resolve the target Space only inside the authenticated tenant/workspace;
5. call the centralized authorization service for `foundation.proof.create` on that exact Space
   inside the same transaction as the aggregate/outbox write;
6. lock and require an active Tenant, active Workspace, active user/membership, active policy
   version, and current Space authorization before writing.

The request tests must prove unauthenticated, unknown-alias, forged-authority-header, wrong-Space,
cross-workspace, and cross-tenant requests create neither aggregate nor outbox row. Diagnostic
request/trace headers remain metadata only.

The outbox row must contain at least:

- event ID and event type;
- tenant ID, workspace ID, and Space ID;
- aggregate type, ID, and version;
- causation ID and request ID;
- OpenTelemetry propagation fields;
- job ID;
- bound relay service-principal ID;
- the signed opaque context reference, never the editable SecurityContext body;
- creation, publication-attempt, publication, and terminal-failure metadata.

A test must force each post-signing database write to fail and prove that reference, aggregate, and
outbox visibility remains atomic.

### 3. Outbox relay publication is retry-safe

The relay must claim eligible rows using a concurrency-safe PostgreSQL pattern such as
`FOR UPDATE SKIP LOCKED`. It must not mark an event published before SQS acknowledges it.

The relay may retry an event after an ambiguous failure. Therefore SQS message identity and worker
idempotency—not an assumption of exactly-once delivery—must prevent duplicate effects. Retryable
and terminal failures must be represented distinctly, and logs must avoid raw context or sensitive
payloads.

The closure uses one local test queue. It does not create one physical SQS queue per tenant. A
validated tenant/workspace/Space routing key and message attributes carry logical scope.

The relay must not use the owner/migration pool, `throughline_app`, or a role with `BYPASSRLS`.
Migration 0002 must create a dedicated `throughline_relay` database role as `NOLOGIN NOBYPASSRLS`;
tests may provision a disposable login credential outside canonical migration SQL, following the
A2 app-role pattern. The relay role is a least-privilege database transport role, not cross-tenant
authority:

- every claim/update transaction receives one complete, validated service-principal
  SecurityContext and uses `SET LOCAL` through the tenant transaction wrapper;
- the context must be for an active relay service principal with `purpose='system'`, a direct grant
  to the exact Space, and the same tenant/workspace;
- the centralized authorization service must allow the exact `foundation.relay.publish` action for
  that principal and Space inside the same claim transaction;
- RLS requires each outbox row to match the current tenant/workspace/Space and service principal;
- no transaction may discover or scan another tenant, workspace, or Space;
- read-only access to only the authority columns in the exact Tenant, Workspace, policy-version,
  relay service-principal, Space, and direct relationship rows needed by
  `foundation.relay.publish`, all constrained by the same transaction-local RLS scope;
- no other identity/access reads and no `INSERT`, `DELETE`, ownership, schema-create, or
  domain-table privileges;
- `SELECT` only on `ops.outbox_events` columns required to construct the queue message;
- `UPDATE` only on that table's claim/lease, attempt, retry-code, and publication-result columns;
- immutable event ID, scope, type, payload, aggregate, context-reference, causation, and trace
  columns cannot be changed by that role.

The proof harness invokes one explicitly seeded relay context at a time; cross-tenant scheduling or
scope discovery is not part of this closure. Relay repository code must use a dedicated relay pool
and a fixed transaction API that exposes only claim, mark-published, and mark-retry operations. It
must not expose a general query callback. Tests must prove the relay role sees only its exact scoped
authority rows, cannot read unrelated identity/access or any product-domain tables, cannot
insert/delete outbox rows or alter immutable event fields, and cannot omit transaction-local scope,
cross scopes, or use owner/migration credentials.

### 4. Queue payloads contain a signed opaque context reference

The API-side issuer must create an application-generated UUIDv7 reference record in PostgreSQL and
emit only a versioned opaque token. The reference ID is not authority by itself; the signed
claims are sufficient for a narrow bootstrap lookup without asserting the full SecurityContext as
authority.

Use this exact signing contract:

```text
tlctx.v1.hs256.<kid>.<payload-base64url>.<mac-base64url>
```

- algorithm: HMAC-SHA-256;
- `<kid>`: 1–32 ASCII letters, digits, `_`, or `-`, selected from an injected verification-key map;
- payload: UTF-8 JSON with no whitespace, encoded as unpadded base64url;
- payload shape: an exact fixed-order array containing `v1`, reference ID, job ID, tenant ID,
  workspace ID, Space ID, target worker service-principal ID, policy-version ID, issued-at Unix
  seconds, and expiry Unix seconds;
- MAC input: the exact ASCII bytes `tlctx.v1.hs256.<kid>.<payload-base64url>`;
- MAC encoding: the 32-byte digest as unpadded base64url;
- comparison: decode to exactly 32 bytes and use constant-time comparison.

Verification must cap the complete token at 2 KiB and decoded payload at 1 KiB before JSON parsing,
require exactly six dot-separated segments with literal `tlctx`, `v1`, and `hs256`, require the
exact array length/types, reject extra/missing fields, validate all IDs and timestamps, and reject
unknown format versions, algorithms, or key IDs. These bounds are deliberately far above the fixed
identifier payload while preventing unbounded decode/parse work.

The injected key map must provide at least 32 random bytes per key and identify one active signing
key. Verification may retain explicitly configured prior keys only for rotation until every token
they signed has expired; unknown or removed keys fail closed. Key material comes only from explicit
runtime/test configuration and is never stored in the repository, database row, log, queue body, or
trace attribute. CI uses a disposable test key and key ID.

The token lifetime must be positive and no more than 900 seconds, matching the existing 15-minute
SecurityContext lifetime. Token expiry may not exceed either the persisted reference expiry or the
stored SecurityContext expiry. Issued-at may be at most 30 seconds ahead of the verifier to tolerate
small local clock skew; expiry has no grace and `now >= expiry` is denied. Verification uses an
injected clock in unit tests, while the final database effect guard independently uses
`clock_timestamp()`.

The persisted reference records the complete validated SecurityContext snapshot, the worker
service principal, delegating user/membership where applicable, the target Space, issue/expiry
times, policy version, status, signing key ID, and revocation metadata. Requested Space and role
hints remain ceilings/snapshots, not live authority. The raw signing key and MAC are never persisted
in the reference row.

The worker process must use a dedicated `throughline_worker` database role created as
`NOLOGIN NOBYPASSRLS`; test login provisioning remains outside canonical migration SQL. After
cryptographically verifying the token, a dedicated bootstrap wrapper may set transaction-local
tenant, workspace, Space, job, reference, worker-principal, and policy-version settings from the
verified signed claims. It may then execute only one fixed reference lookup—no caller-supplied SQL
and no general transaction callback.

The reference-table bootstrap RLS policy must require all persisted scope/binding columns to equal
those transaction-local verified claims and must require `current_user = 'throughline_worker'`.
The worker role receives no owner/migration privileges and no unscoped reference-table read. A
missing setting, wrong worker principal, wrong scope, wrong job/reference binding, unknown
reference, or forged token returns no row. Only after this constrained lookup returns the stored
snapshot may normal SecurityContext parsing and live authorization begin.

The subsequent handler transaction also uses the dedicated worker pool, never the app,
owner, or migration pool. Its wrapper sets the complete rehydrated context, including delegating
user/membership and exact target Space/reference/job bindings, with `SET LOCAL`. Migration 0002 may
add narrowly scoped worker RLS policies on only the authority rows required for the decision:

- the exact context-reference row;
- the exact Tenant and Workspace rows;
- the exact worker service-principal row;
- the exact policy-version row;
- the exact delegating user and membership rows;
- the target Space and only the access-relationship rows needed to authorize it;
- the matching proof aggregate and idempotency rows.

The worker role may select those bound authority rows and mutate only the neutral proof aggregate
and idempotency record. It receives no unscoped identity/access reads and no access to future
product-domain tables. Tests must prove a changed transaction-local binding cannot expose another
row and the worker cannot use a general query surface to broaden access.

### 5. Worker rehydration and live reauthorization fail closed

Before a handler reads or mutates the proof aggregate, the worker must:

1. parse the versioned reference envelope;
2. verify the signature before trusting any embedded routing value;
3. use the dedicated worker role and fixed bootstrap wrapper to set only the verified signed
   bindings and load the exact reference under bootstrap RLS;
4. require the reference to exist, be active, be bound to the exact job and Space, and be unexpired;
5. validate the rehydrated SecurityContext;
6. require an active Tenant and active Workspace matching the signed scope;
7. require the worker service principal to be active and scoped to the same tenant/workspace;
8. require the referenced policy version and delegated membership to remain live;
9. open one handler transaction with the rehydrated context;
10. lock the reference, Tenant, Workspace, worker principal, policy version, delegating
    user/membership, target Space, and authorization relationship rows needed by the decision;
11. call a transaction-aware entry point of the centralized authorization service for
    `foundation.worker.consume` on the exact Space, using that same transaction;
12. recheck expiry with PostgreSQL `clock_timestamp()` and recheck aggregate/job versions in the
    final guarded mutation;
13. write the idempotency record and proof effect atomically in that same transaction.

Do not broadly authorize service or agent principals. The only new allow paths may be the exact
`foundation.proof.create`, `foundation.relay.publish`, and `foundation.worker.consume` actions,
each bound to its required human or service principal and exact tenant/workspace/Space. Existing
default-deny behavior must remain unchanged for every other action.

The allow predicates are fixed:

- `foundation.proof.create`: a complete human user/membership actor only; active Tenant, Workspace,
  user, membership, and policy; membership role `owner` or `admin`; non-archived exact target Space;
  and current Space authorization under the existing restricted-boundary rules. Service/agent
  principals and a Space supplied outside the resolved context deny.
- `foundation.relay.publish`: a service-principal actor only; active Tenant, Workspace, policy, and
  service principal; `purpose='system'`; executing principal ID equals the transaction-local
  service-principal ID; and a direct `manager` relationship for that principal on the exact Space.
  The claimed outbox row must match the same tenant/workspace/Space and bound relay-principal ID.
- `foundation.worker.consume`: a service-principal actor only; active Tenant, Workspace, policy, and
  service principal; `purpose='worker'`; executing principal ID equals the token, reference, and
  transaction-local worker-principal IDs; a direct `contributor` relationship for that worker on
  the exact Space; an exact stored delegating user/membership pair that remains active; and the
  delegator still passes current Space authorization under the existing restricted-boundary rules.

The decision transaction locks every row used by its predicate. Tests must deny wrong human role,
wrong principal kind or purpose, executing-principal mismatch, removed relay/worker direct grant,
removed delegator access, inactive Tenant/Workspace/principal/membership/policy, and every
cross-scope variant.

The existing public `AuthorizationService.can()` contract remains central. Add a narrowly scoped
transaction-aware implementation seam so `can()` can delegate to the same decision logic and the
worker can evaluate it inside its already-open handler transaction. Do not copy authorization SQL
into the worker.

Tenant suspension/deletion, Workspace archival, and reference revocation/principal disablement/
membership suspension/policy retirement writes must contend on the same rows locked by the
handler. This establishes a deterministic order: a change committed first causes denial; a handler
that holds the authority locks and commits first is ordered before the later authority change. The
final effect statement must use `clock_timestamp()`—not `now()`, `CURRENT_TIMESTAMP`, or
transaction-start time—for the expiry predicate, together with aggregate/job version predicates.
A dedicated test must begin the transaction before expiry, hold at a barrier until after expiry,
and prove the final mutation creates no effect.

### 6. Denial and idempotency semantics are explicit

The integration suite must prove:

| Case | Required result |
| --- | --- |
| Forged token/signature | Denied before context authority or handler access; no effect |
| Unknown reference | Denied; no effect |
| Expired reference | Denied before handler transaction; no effect |
| Revoked reference | Denied before handler transaction; no effect |
| Suspended/deleted Tenant | Live authorization denied; no effect |
| Archived Workspace | Live authorization denied; no effect |
| Disabled worker principal | Live authorization denied; no effect |
| Wrong-purpose or wrong executing worker principal | Live authorization denied; no effect |
| Removed worker direct Space grant | Live authorization denied; no effect |
| Suspended/deactivated delegator | Live authorization denied; no effect |
| Removed delegator Space authority | Live authorization denied; no effect |
| Retired/unknown policy version | Treated as stale authority and denied; no effect |
| Stale aggregate/job version | Terminal denial; no effect; source message redrives to DLQ |
| Duplicate SQS delivery | Acknowledged as already handled; exactly one durable effect |
| Cross-tenant reference/envelope mismatch | Denied under RLS and application checks; no effect |
| Cross-workspace or cross-Space mismatch | Denied; no effect |
| Out-of-order aggregate version | Terminal denial; no effect; source message redrives to DLQ |

A unique idempotency record must be written in the same transaction as the worker effect. A crash
before commit leaves neither; a redelivery can retry. A crash after commit sees the existing
idempotency record and cannot apply the effect again.

Concurrency tests must use separate database connections and controlled barriers to prove that
Tenant suspension/deletion, Workspace archival, reference revocation, token expiry, policy
retirement, worker disablement, or delegator suspension cannot race between live authorization and
the durable effect. Each race must end in either one effect ordered before the authority change or
zero effects when the authority change wins—never an effect authorized from a stale
pre-transaction decision.

#### SQS receipt lifecycle

The LocalStack proof must configure a source queue and dead-letter queue with a redrive policy. Use a
30-second visibility timeout, a 20-second handler deadline, and `maxReceiveCount=3`; these small test
values provide two observable retries while keeping the integration suite bounded. Runtime values
remain explicit configuration, and the handler deadline must stay below visibility timeout.

For each actual SQS receipt:

1. start the consumer span by extracting the signed envelope and persisted W3C propagation fields;
2. if processing approaches 10 seconds of visibility remaining, extend visibility with
   `ChangeMessageVisibility`; never continue after extension failure without treating the attempt as
   retryable;
3. call `DeleteMessage` only after the proof effect and idempotency record durably commit, or after
   an exact-scope/job/handler idempotency lookup confirms a duplicate committed earlier;
4. on transient PostgreSQL, LocalStack, or visibility-extension failure, do not delete the message;
   allow visibility expiry/backoff and retry;
5. on malformed/forged/expired/revoked/cross-scope/inactive-authority/stale/out-of-order terminal
   denial, apply no effect, do not record success, emit only a sanitized reason code, and leave the
   message for the configured redrive policy to move to the DLQ;
6. if `DeleteMessage` fails after commit, accept redelivery and resolve it through the duplicate
   path without a second effect.

The queue body contains only the signed opaque reference and bounded routing/trace metadata—never a
raw SecurityContext or product payload. Logs and spans must not copy the queue body/token. Tests
must prove successful deletion, duplicate deletion, transient redelivery, terminal denial redrive
to the DLQ after three receipts, visibility extension, and post-commit delete-failure recovery.

### 7. Infrastructure key builders are centralized and validated

Add one shared scope type containing `tenantId`, `workspaceId`, and `spaceId`. Builders must validate
all identifiers and produce unambiguous deterministic values for:

- queue routing/message-group or deduplication scope;
- cache keys;
- S3 object keys.

Object keys must begin with tenant/workspace/Space segments as required by the Build Spec. Cache
keys must include the same scope before resource-specific segments. Queue envelopes and SQS message
attributes must include the same scope and be checked against the rehydrated reference.

Builders must reject empty IDs, separators/path traversal, URLs, host-like infrastructure values,
and mismatched supplied resource scope. This closure does not add a cache backend or product object
storage. LocalStack S3 coverage may write only a disposable neutral marker under the generated
proof key to validate endpoint wiring and prefix behavior.

### 8. OpenTelemetry is real propagation, not only correlated UUIDs

Retain `requestId` for human-readable correlation, but replace the current trace-ID placeholder
path with OpenTelemetry context injection/extraction:

1. API request span;
2. database/outbox commit child span;
3. relay claim/publish span linked through persisted propagation data;
4. SQS message attributes carrying W3C propagation fields;
5. worker receive/rehydrate/authorize/handle spans under the same trace.

The relay and consumer must extract the persisted W3C `traceparent`/`tracestate` and use that remote
context as the parent so API, relay, and worker spans keep one trace ID. Span links may record
additional message/causation relationships but must not replace parent extraction with a separate
trace.

Use an in-memory exporter in tests. Assert a single trace, the expected parent/child and optional
message-link relationships, and matching request/tenant/workspace/job attributes. Never put
signing keys, full SecurityContext bodies, raw queue payloads/tokens, or credentials in span
attributes.

## Proposed persistence additions

Use one reviewed SQL migration after the current `0001_wave_a2_identity_access_rls.sql`, proposed as:

`packages/db/migrations/0002_foundation_closure_async_isolation.sql`

The migration should add only operational foundation tables under `ops`, with exact naming finalized
in implementation review:

- `ops.foundation_test_aggregates` — neutral transactional proof row;
- `ops.outbox_events` — durable publish journal;
- `ops.security_context_references` — scoped, expiring, revocable context records;
- `ops.idempotency_records` — unique consumer/job/handler effect keys.

Every tenant-owned row must include tenant/workspace/Space scope where applicable, composite scope
constraints, RLS with `ENABLE` and `FORCE`, and app-role policies. Reviewed SQL remains authoritative;
Drizzle mirrors table shape only. Migration journal repeatability, checksum, adoption, and rollback
behavior from A2 must remain intact.

The migration must also create `throughline_relay` and `throughline_worker` as least-privilege
`NOLOGIN NOBYPASSRLS` roles, with no embedded credentials. Their grants and RLS policies must be
limited to the relay and bootstrap/handler surfaces defined above. Test-only login provisioning
must derive disposable credentials from explicit test configuration and must never log them.

## Expected implementation files

Exact paths may be adjusted only when the implementer demonstrates an existing-file collision and
records the replacement path in the result artifact.

### Root and CI

- Modify: `package.json` — add a fail-closed `test:foundation` command.
- Modify: `turbo.json` — pass only the explicit test environment needed by the affected tasks.
- Modify: `.env.example` — document disposable LocalStack/test values, not reusable secrets.
- Modify: `.github/workflows/ci.yml` — add LocalStack and run the serial foundation integration gate.
- Create: `scripts/require-foundation-test-env.ts` — fail before tests if PostgreSQL or LocalStack
  test endpoints are missing; reject non-local AWS endpoints in the test command.

### Shared contracts and scoped keys

- Create: `packages/core-types/src/async-foundation.ts` — outbox, queue-envelope, scope, and context
  reference contracts with no product-domain types.
- Modify: `packages/core-types/src/index.ts` — export the narrow contracts.
- Create: `packages/tenancy/src/scoped-resource-keys.ts`.
- Create: `packages/tenancy/src/scoped-resource-keys.spec.ts`.
- Create: `packages/tenancy/src/async-context-reference.ts`.
- Create: `packages/tenancy/src/async-context-reference.spec.ts`.
- Modify: `packages/tenancy/src/index.ts`.

### PostgreSQL and authorization

- Create: `packages/db/migrations/0002_foundation_closure_async_isolation.sql`.
- Modify: `packages/db/src/schema.ts` — mirror the reviewed SQL.
- Create: `packages/db/src/foundation-outbox.ts`.
- Create: `packages/db/src/foundation-outbox.spec.ts`.
- Create: `packages/db/src/async-context-repository.ts`.
- Create: `packages/db/src/idempotency-repository.ts`.
- Create: `packages/db/src/relay-transaction.ts` — fixed tenant-scoped relay transaction surface.
- Create: `packages/db/src/worker-bootstrap.ts` — fixed signed-claim bootstrap lookup only.
- Create: `packages/db/src/worker-transaction.ts` — fixed rehydrated-context handler transaction.
- Modify: `packages/db/src/seed.ts` — deterministic relay/worker principals and exact direct Space
  grants needed only by the proof.
- Modify: `packages/db/src/security.spec.ts` — RLS/no-context/cross-tenant assertions for every new
  table.
- Modify: `packages/db/src/migrations.spec.ts` — repeatability and rollback with migration 0002.
- Modify: `packages/db/src/index.ts`.
- Modify: `packages/authorization/src/authorization-service.ts` — only the three exact Foundation
  actions and shared transaction-aware decision logic.
- Modify: `packages/authorization/src/types.ts` — add only `foundation.proof.create`,
  `foundation.relay.publish`, `foundation.worker.consume`, and the transaction-aware internal
  decision seam.
- Modify: `packages/authorization/src/authorization-service.spec.ts` — exact-action PASS cases plus
  disabled, stale-policy, inactive-Tenant/Workspace, cross-scope, and all-other-service-actions
  DENY.

### API, relay, worker, and observability

- Create: `apps/api/src/foundation-proof/foundation-proof.module.ts`.
- Create: `apps/api/src/foundation-proof/foundation-proof.guard.ts` — non-production dev-identity
  resolution only; the service performs `foundation.proof.create` authorization in the write
  transaction.
- Create: `apps/api/src/foundation-proof/foundation-proof.controller.ts`.
- Create: `apps/api/src/foundation-proof/foundation-proof.service.ts`.
- Create: `apps/api/src/foundation-proof/foundation-proof.e2e.spec.ts` — test-only Nest module and
  request path; do not expose a product route from the normal `AppModule`.
- Create: `apps/outbox-relay/src/relay.ts`.
- Create: `apps/outbox-relay/src/relay.spec.ts`.
- Modify: `apps/outbox-relay/src/main.ts` — thin runtime composition only.
- Create: `apps/agent-worker/src/foundation-consumer.ts`.
- Create: `apps/agent-worker/src/foundation-consumer.spec.ts`.
- Modify: `apps/agent-worker/src/worker-context.ts` — replace the unsigned placeholder envelope.
- Modify: `apps/agent-worker/src/worker-context.spec.ts`.
- Modify: `apps/agent-worker/src/main.ts` — thin runtime composition only.
- Modify: `packages/observability/src/index.ts` or split into narrowly named propagation files.
- Create: `packages/observability/src/propagation.spec.ts`.
- Modify package manifests and `pnpm-lock.yaml` only for the minimum AWS SDK SQS/S3 and
  OpenTelemetry packages justified by this plan.

### Integration proof and documentation

- Create: `tests/integration/foundation-closure.test.ts` — real PostgreSQL and LocalStack path.
- Create: `tests/security/async-isolation.test.ts` — adversarial denial matrix.
- Modify: `README.md` — commands and achieved gate only after implementation passes.
- Create after implementation: `docs/status/WAVE_A_FOUNDATION_CLOSURE_RESULT.md`.

## Implementation sequence

Each implementation task must use tests first and a small commit. Codex receives only this plan and
the canonical documents; it must not infer later-wave work.

### Task 1 — Freeze the implementation baseline

1. Fetch `origin/main`.
2. Require the exact approved implementation base supplied with the future authorization.
3. Require a clean worktree.
4. Create `foundation-closure-async-isolation` from that exact base.
5. Record tool versions, branch, base SHA, and clean status in the result artifact draft.
6. Stop if `main` changed from the approved SHA; do not silently rebase the plan.

### Task 2 — Add scope contracts and key builders

1. Write failing unit tests for valid queue/cache/object keys and all malformed/cross-scope cases.
2. Add the minimal shared scope and queue-envelope contracts.
3. Implement builders with strict segment validation and deterministic encoding.
4. Run tenancy/core-type tests, lint, and typecheck.
5. Commit only the contracts, builders, and tests.

### Task 3 — Add the operational SQL schema

1. Write failing PostgreSQL tests for table presence, RLS/FORCE RLS, no-context invisibility,
   cross-tenant/workspace/Space write denial, and required unique keys.
2. Add reviewed migration 0002 and the Drizzle mirror.
3. Add migration repeatability, checksum, rollback, and reset tests.
4. Add least-privilege relay/worker role tests proving role identity, `NOBYPASSRLS`, permitted
   columns/operations, denied domain-table access, and no owner/migration-pool use.
5. Run the dedicated PostgreSQL security suite with explicit owner/app/relay/worker test DSNs and
   prove no tests skipped.
6. Commit only migration/schema/test changes.

### Task 4 — Implement signed opaque context references

1. Write failing tests for the exact `tlctx.v1.hs256` HMAC-SHA-256 format, canonical array encoding,
   size limits, key selection/rotation, constant-time MAC comparison, unknown version/key,
   malformed payload, 900-second TTL ceiling, 30-second issued-at skew, no-grace expiry, and the
   full forged/expired/revoked/scope mismatch matrix.
2. Implement the fixed signing/verification contract with injected key map, active key ID, and
   injected clock.
3. Implement the fixed worker bootstrap wrapper, verified transaction-local bindings, and
   bootstrap RLS reference repository using the dedicated worker role.
4. Prove no-context, wrong-worker, forged-scope, and cross-tenant bootstrap lookups return no row.
5. Prove queue bodies/logs/traces contain no raw SecurityContext or signing material.
6. Commit the reference seam and tests.

### Task 5 — Prove atomic API aggregate plus outbox commit

1. Write test-only Nest request tests for valid deterministic identity plus unauthenticated,
   unknown-alias, forbidden-authority-header, wrong-Space, cross-workspace, and cross-tenant denial.
2. Implement the non-production proof guard with `resolveDevIdentityFromHeaders()`; never accept a
   caller-supplied SecurityContext or authority field.
3. Add the exact `foundation.proof.create` predicate: complete human actor, active
   Tenant/Workspace/user/membership/policy, `owner` or `admin` role, non-archived target Space, and
   current Space authorization; deny every service/agent or lower-role caller.
4. Implement the neutral proof service under `withTenantTransaction()`.
5. Persist the context-reference row, proof aggregate, and outbox row—with composite
   reference/job/scope integrity—in the same authorized transaction.
6. Force reference and outbox insertion failures and prove none of the three rows commits.
7. Prove the normal `AppModule` does not expose the proof controller.
8. Commit the API proof seam and tests.

### Task 6 — Publish committed outbox events through LocalStack SQS

1. Write relay tests for one tenant-scoped service-principal context, missing scope, cross-scope
   denial, least-privilege role access, claim, publish, acknowledged marking, retryable failure,
   immutable-column protection, and concurrent relay attempts.
2. Add the exact `foundation.relay.publish` predicate: active `purpose='system'` executing principal,
   direct `manager` Space grant, and exact active Tenant/Workspace/Space.
3. Implement the dedicated relay pool plus fixed tenant transaction claim/result repository,
   claim leases/locking, and SQS publication; do not implement cross-tenant discovery.
4. Persist W3C trace propagation and scoped message attributes.
5. Prove unpublished/uncommitted events are not marked successful and duplicate publication remains
   safe for the consumer.
6. Commit relay code and tests.

### Task 7 — Consume idempotently with live reauthorization

1. Write the worker denial matrix before implementation, including wrong principal purpose/ID,
   removed worker direct grant, and removed delegator Space access.
2. Implement signature verification and the constrained worker-role bootstrap before handler
   access.
3. Add the exact `foundation.worker.consume` predicate and shared transaction-aware decision seam
   without weakening existing service/agent default-deny behavior.
4. Lock and recheck active Tenant, Workspace, and every other live authority row inside the handler
   transaction.
5. Apply a database-time/version-guarded proof effect and idempotency record in that same
   transaction.
6. Implement the fixed visibility/acknowledgement/redrive lifecycle and prove success/confirmed
   duplicate are the only `DeleteMessage` paths; transient failures retry and terminal denials
   redrive to the DLQ without an effect.
7. Prove duplicate delivery applies one effect; stale/out-of-order jobs deny and redrive.
8. Use two-connection barrier tests to prove concurrent expiry/revocation/policy retirement/
   principal disablement/delegator suspension/Tenant suspension/Workspace archival cannot
   authorize a stale effect, including expiry after transaction start before mutation.
9. Commit worker, authorization, idempotency, SQS receipt handling, and tests.

### Task 8 — Complete OpenTelemetry propagation

1. Write an in-memory-exporter test for one trace across API, outbox, relay, and worker.
2. Replace placeholder correlation-only propagation with OpenTelemetry inject/extract.
3. Add only allowlisted non-sensitive span attributes.
4. Prove trace continuity and no sensitive attributes.
5. Commit observability wiring and tests.

### Task 9 — Add the full PostgreSQL plus LocalStack gate to CI

1. Add the fail-closed environment preflight.
2. Start PostgreSQL and LocalStack SQS/S3 in CI.
3. Provision a disposable source queue, DLQ/redrive policy, and bucket with dummy local credentials.
4. Run the complete foundation integration suite serially.
5. Prove the test command refuses missing variables and non-local AWS endpoints.
6. Run the exact CI-equivalent command locally.
7. Commit CI, scripts, lockfile, and command documentation.

### Task 10 — Final verification, independent review, and PR gate

1. Run all focused tests.
2. Run frozen install, format, lint, typecheck, ordinary tests, build, A2 PostgreSQL security tests,
   and the new foundation integration/security gate.
3. Verify ignored/generated artifacts and LocalStack data are not staged.
4. Scan added lines for credentials, raw contexts, and accidental product-domain scope.
5. Ask an independent reviewer to inspect the exact diff against the kickoff, backlog, Build Spec,
   accepted ADRs, and this plan.
6. Fix only blocking findings and rerun the entire gate.
7. Write `docs/status/WAVE_A_FOUNDATION_CLOSURE_RESULT.md` with exact commands/results and caveats.
8. Open a scoped PR and stop before merge.

## Test plan

### Unit tests

- scoped key construction and rejection;
- queue-envelope schema validation;
- exact `tlctx.v1.hs256` signing format, canonical payload, key selection/rotation, size limits,
  TTL/skew,
  unknown version/key, malformed input, and constant-time verification;
- reference expiry and revocation;
- idempotency key construction;
- OpenTelemetry carrier inject/extract;
- relay error classification;
- authorization action default-deny preservation.

### PostgreSQL integration/security tests

- test-only API guard resolves only the deterministic dev identity and denies unauthenticated,
  unknown, forged-authority-header, wrong-Space, cross-workspace, and cross-tenant requests;
- atomic context-reference + aggregate + outbox commit;
- forced rollback on reference and outbox failure with none of the three rows visible;
- all new tables use RLS and FORCE RLS;
- app role sees no new rows without context;
- cross-tenant/workspace/Space read and write denial;
- reference lookup cannot cross scope;
- no-context, wrong-worker, forged-scope, and cross-tenant bootstrap denial;
- exact allow/deny predicates for proof, relay, and worker actions, including wrong role/purpose,
  executing-principal mismatch, removed worker/relay grant, and removed delegator access;
- active/expired/revoked transitions;
- worker effect plus idempotency record atomicity;
- duplicate and stale-version behavior;
- suspended/deleted Tenant and archived Workspace denial;
- transaction-start-before-expiry/final-mutation-after-expiry denial using `clock_timestamp()`;
- concurrent Tenant suspension, Workspace archival, reference revocation, expiry, policy
  retirement, worker disablement, and delegator suspension are ordered against the effect with no
  stale authorization window;
- relay role can claim/update only same-tenant/workspace/Space outbox metadata and cannot scan
  another scope, read/write domain tables, or mutate immutable event fields;
- migration 0002 repeatability, checksum enforcement, and deterministic reset.

### LocalStack integration tests

- relay publishes the committed event to SQS;
- SQS message contains the signed opaque reference and scoped attributes but no raw context;
- worker receives and applies one effect;
- success and confirmed duplicate delete the receipt; redelivery produces no second effect;
- transient database/SQS/visibility-extension failure is not deleted and retries;
- processing near the visibility deadline extends visibility or fails retryably;
- terminal security/stale/out-of-order denial applies no effect and redrives to the DLQ after the
  configured three receipts;
- post-commit `DeleteMessage` failure redelivers and resolves as a confirmed duplicate;
- forged, expired, revoked, stale, and cross-tenant jobs produce no effect;
- disposable S3 marker uses only the generated scoped object prefix;
- tests cannot use a real AWS endpoint.

### Trace assertions

- one trace spans API request, transactional commit/outbox, relay, and worker;
- request/job/tenant/workspace identifiers agree across allowlisted attributes;
- propagation survives PostgreSQL persistence and SQS message attributes;
- credentials, signatures, raw SecurityContext, and raw payloads are absent.

## Required verification commands

The implementation may add a narrow helper script, but the final result must report real output from
at least:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
env -u DATABASE_URL -u TEST_DATABASE_URL -u TEST_APP_DATABASE_URL pnpm test
pnpm build
pnpm test:security
pnpm test:foundation
git diff --check
git status --short --branch
git status --ignored --short
git ls-files
```

`pnpm test:security` must retain its A2 fail-closed owner/app DSN behavior. `pnpm test:foundation`
must fail closed unless all of the following are explicit:

- `TEST_DATABASE_URL` — owner/migration test connection;
- `TEST_APP_DATABASE_URL` — A2 app-role test connection;
- `TEST_RELAY_DATABASE_URL` — disposable login for the `throughline_relay` role;
- `TEST_WORKER_DATABASE_URL` — disposable login for the `throughline_worker` role;
- a local-only LocalStack endpoint, region, dummy credentials, source-queue URL, DLQ URL, and bucket
  name;
- a disposable Foundation verification-key map and active key ID.

The preflight must reject absent values, equal owner/relay/worker DSNs, non-local AWS endpoints, and
non-test resource names. Passing output must include concrete non-skipped PostgreSQL and LocalStack
test counts. No credential value may be printed.

## Acceptance gate

Foundation Closure is complete only when one deterministic test request proves:

```text
API request
  -> PostgreSQL context reference + proof aggregate + outbox event in one commit
  -> relay publishes committed event to LocalStack SQS
  -> worker verifies and rehydrates signed opaque context reference
  -> worker live-reauthorizes exact tenant/workspace/Space scope
  -> worker applies exactly one idempotent effect
```

The same test evidence must show one OpenTelemetry trace across the path and zero effects for every
required denial case. A unit-only or mocked-SQS result is insufficient.

Passing this gate closes the listed Foundation obligations only. It does not authorize B1, claim
that product workflows exist, or authorize deployment.

## Independent review plan

Before the implementation PR is opened, provide an independent reviewer with:

- the exact implementation diff and head SHA;
- `docs/IMPLEMENTATION_KICKOFF_v0.1.md`;
- TL-003, TL-004, TL-008, and TL-010 from both backlog formats;
- Build Spec sections 2, 4, 14, 15.3, 16, 17, and 18;
- accepted ADRs 015–020;
- this plan;
- exact verification output.

The reviewer must return PASS only if:

- the implementation remains Foundation-only;
- the test-only API proof uses the guarded deterministic identity resolver and centralized
  `foundation.proof.create` authorization rather than caller-supplied authority;
- context-reference/aggregate/outbox atomicity and worker idempotency are real;
- queued authority uses the exact versioned signing contract and is an opaque reference, not an
  editable context;
- all three Foundation authorization actions implement only their fixed predicates and deny wrong
  roles, purposes, identities, removed grants, and removed delegator access;
- live worker reauthorization cannot be bypassed;
- relay and worker bootstrap database roles are least-privilege, `NOBYPASSRLS`, never use the
  owner/migration pool, and every relay transaction is bound by `SET LOCAL` to one
  tenant/workspace/Space;
- live authorization and the effect share one transaction with race-tested locks and guarded
  predicates;
- the final expiry guard uses `clock_timestamp()` and active Tenant/Workspace state is part of live
  authorization;
- all required denial cases have direct no-effect tests;
- SQS receipts are deleted only after durable success/confirmed duplicate, transient failures
  retry, and terminal denials redrive to the DLQ;
- RLS and scoped key builders cover tenant/workspace/Space;
- real PostgreSQL and LocalStack run in CI;
- trace propagation is OpenTelemetry-based and excludes secrets;
- B1, models, MCP, retrieval, product UI, and deployment remain untouched.

A timeout, unavailable reviewer, partial review, or review of a non-final SHA is not PASS evidence.

## Stop conditions

Stop and report before implementation or PR progression if:

- `origin/main` differs from the explicitly approved implementation base;
- a required behavior would modify a canonical document or accepted ADR;
- a proposed fix requires Organization, Initiative, Activity, source, claim, ChangeSet, model, MCP,
  retrieval, or UI scope;
- real AWS credentials/endpoints or production infrastructure would be required;
- the proof would weaken RLS, `can()`, strict principal separation, or existing service/agent
  default-deny behavior;
- relay implementation requires any cross-tenant scan, role-only cross-tenant RLS allow, or
  owner/`BYPASSRLS` access; that requires a separately approved ADR and is not authorized here;
- PostgreSQL or LocalStack integration tests skip or cannot run;
- the independent reviewer does not return PASS on the final exact head.

## Approval requested later

This document requests no implementation authorization by itself. After this docs-only PR is
reviewed and merged, Hermes must stop and wait for explicit approval before creating
`foundation-closure-async-isolation` or modifying application code.
