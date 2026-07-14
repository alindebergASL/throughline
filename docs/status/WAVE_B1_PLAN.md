# Wave B1 Plan — Work Graph and Source Capture

> **Plan only; implementation HOLD.** Do not implement Wave B1 until a separately approved,
> bounded **B1.0 canonical product-outbox prerequisite** is merged and Andrew explicitly lifts this
> HOLD. This artifact defines but does not authorize B1.0, B1 command handlers or migrations, B2
> truth-ledger work, B3 governed runtime work, model extraction, ChangeSets, integrations, product
> UI, deployment, or changes to canonical kickoff documents or accepted ADRs.

- **Date:** 2026-07-14
- **Authorized correction base:** `d870d4def9ee3be21b8dbf041cd63fb594e7e4c6`
- **Correction branch:** `throughline/impl/t_eb4dee8d-pr5-b1-plan-review-hold-correction`
- **Wave:** B1 — Work graph and source capture
- **Planning verdict:** **HOLD** — ADR-019, Build Spec §14.1, and Implementation Kickoff ticket 9
  require every domain mutation to emit a transactional outbox event with aggregate version. The
  merged Foundation proof outbox/relay is exact-purpose and cannot carry B1 events. B1 therefore
  requires the additive, isolated B1.0 canonical product-domain outbox below before any B1 command
  handler or migration may ship.

## Proposed goal and gate after HOLD lift

After B1.0 is separately approved and merged and the HOLD is explicitly lifted, implement
the smallest manual Account Operations graph and evidence-capture path on top of the closed Wave A
isolation foundation:

```text
authenticated Membership
  → Organization + organization Space
  → Initiative + initiative Space
  → Activity(subtype = AI Solutions engagement template)
  → immutable SourceArtifact
  → deterministic SourceChunks
```

The B1 gate is:

> A user can manually create the account workflow and capture a source without any integration.

The proof ends when the source and trusted chunks are durably stored, readable only through the
current Tenant/Workspace/Space authorization path, and available for later B2 citation
verification. B1 does not create a Claim, AcceptedFact, DerivedView, ChangeSet, or model run.

## Canonical documents and repository state consulted

This plan was drafted only after reading the repository instructions and the canonical sources:

- `AGENTS.md`;
- `docs/BUILD_SPEC_v0.1.1.md`;
- `docs/IMPLEMENTATION_KICKOFF_v0.1.md`;
- `docs/ux/UX_INTERACTION_SPEC_v0.1.md`;
- `docs/PHASE0_DEMO_SCRIPT.md`;
- `backlog/phase0_backlog.csv` and `backlog/phase0_backlog.md`;
- `profiles/ai-solutions.v1.json`;
- `contracts/account-intelligence-provider.ts`;
- `docs/adr/ADR-015.md` through `docs/adr/ADR-022.md`;
- `tests/fixtures/**/*`.

The implementation shape also reflects the current, merged Wave A conventions in:

- `packages/db/src/schema.ts` and migrations `0001` / `0002`;
- `packages/db/src/transaction.ts` and the migration/security suites;
- `packages/authorization/src/*` and `packages/tenancy/src/*`;
- `apps/api/src/foundation-proof/*`;
- `docs/status/WAVE_A2_*` and `docs/status/WAVE_A_FOUNDATION_CLOSURE_*`.

Planning began from a clean worktree at the exact authorized SHA. No application file, migration,
dependency, canonical document, or accepted ADR is changed by this plan.

## Scope

### Proposed in scope after HOLD lift

1. `Organization`, `Initiative`, universal `Activity`, and directed `Relationship` persistence.
2. Account Operations interpretation of an Engagement as an `Activity` subtype, not a second
   aggregate or table.
3. Organization/Initiative/Activity association tables required by the normalized persistence
   contract.
4. Mutable `ContentItem` metadata with append-only revisions.
5. Append-only `SourceArtifact` evidence and deterministic `SourceChunk` normalization/chunking.
6. Source correction chains, retention tombstones, and the B1 portion of deletion reconciliation.
7. Exact AI Solutions profile validation, build/startup loading, and Workspace version pinning.
8. Central authorization actions and Space-scoped repositories for the B1 resources.
9. A minimal typed domain-command façade for the manual B1 mutations, as required by accepted
   ADR-019, without implementing the later governed ChangeSet runtime.
10. Minimal REST endpoints and tests needed to prove the manual no-integration gate.
11. Proposed reviewed SQL migrations, Drizzle mirrors, RLS/privilege tests, audit and canonical
    product-outbox records, and observability for the new path, all blocked from implementation
    until B1.0 is separately approved and merged.

### Explicit non-goals

- Claim, AcceptedFact, conflict group, supersession of facts, or DerivedViewSnapshot.
- Mechanically verified Claim spans; B1 prepares trusted chunks, while B2 verifies candidate spans.
- AgentRun, Skill registry, ContextPacket, model gateway, extraction, or evaluation execution.
- ChangeSet, ProposedOperation, approval routing, impact triage, ExecutionReceipt, or compensation.
- Account Research MCP, provider adapters, external references, webhooks, or connector writes.
- Search, embeddings, pgvector indexes, summaries, Today, Pulse, or Engagement Review UI.
- Voice transcription, PDF/document extraction, arbitrary file upload, email/calendar/message
  ingestion, or external object fetch.
- Production authentication changes, WorkOS integration, new infrastructure, or deployment.
- A generic Solution Pack/Profile runtime, profile authoring UI, graph database, OpenFGA, or a new
  service.
- Tasks, commitments, decisions, use cases, or readiness records.
- Changes to `docs/BUILD_SPEC_v0.1.1.md`, `docs/IMPLEMENTATION_KICKOFF_v0.1.md`, accepted ADRs, the
  profile JSON, or backlog files.

## Locked modeling decisions

### 1. Organization, Initiative, Activity, and Engagement

`Organization`, `Initiative`, and `Activity` are distinct Core work-graph aggregates. Engagement is
not a persisted sibling of Activity and does not receive an `engagements` table.

- `work.organizations` owns one governing organization Space.
- `work.initiatives` owns one governing initiative Space and is associated with at least one
  Organization through `work.initiative_organizations`.
- `work.activities` is bound to one governing parent Space and stores `subtype` plus optional
  `profile_template_key`.
- Account Operations calls an Activity an Engagement only when `profile_template_key` resolves to
  an `activityTemplates[].key` in the Workspace-pinned AI Solutions profile. For B1,
  `subtype = profile_template_key` so Core retains a provider/profile-neutral subtype string.
- A manually created Initiative has exactly one `primary` Organization association in B1. Partner
  or supporting organizations may be associated without changing ownership.
- The Initiative Space is a child of the primary Organization Space. An Activity with Initiative
  links must name one `governingInitiativeId` from `initiativeIds`; trusted code derives the
  Activity `space_id` from that Initiative. An Activity with no Initiative link must name one
  `governingOrganizationId` from `organizationIds`; trusted code derives the Activity `space_id`
  from that Organization. The two governing-parent fields are mutually exclusive. There is no
  first-array-element, sort-order, most-recent, or other implicit fallback.
- An Activity may link additional Organizations or Initiatives in the same Workspace, but those
  links do not move its governing Space. Every later update preserves the selected governing
  parent or performs an explicit, separately authorized reparent command outside B1. Creating a
  cross-Space link requires current read access to every endpoint and contributor-or-higher
  authority in the Activity Space.
- Organization/Initiative/Activity owner fields remain graph `Person` references. Authorization
  continues to use User/Membership/ServicePrincipal/AgentPrincipal only; a Person never grants
  authority.

The creation invariants are:

```text
Organization command
  = organization row + child Space + exact direct product-relay access row
    + audit event + canonical product-outbox notification

Initiative command
  = initiative row + child Space + exact direct product-relay access row
    + primary organization link + audit event + canonical product-outbox notification

Activity command
  = activity row + normalized association rows + audit event
    + canonical product-outbox notification
```

Once B1.0 is separately approved and merged, each group commits atomically. A partially created
aggregate/Space pair, child Space without its fixed direct product-relay access row, or mutation without
its audit and canonical product-outbox records is invalid.

Organization and Initiative create idempotency is anchored to a stable, pre-existing reservation
scope, never the child Space being created:

- `organization.create` reserves against the existing Workspace root Space;
- `initiative.create` reserves against the existing primary Organization Space; and
- the unique key is
  `(tenant_id, workspace_id, reservation_space_id, command_kind, idempotency_key)`.

The handler hashes the canonical trusted command input, begins one transaction scoped to the
reservation Space, locks and authorizes that live parent, and attempts to insert the command
reservation. Only the transaction that inserts the reservation may generate the UUIDv7 child
Space ID and UUIDv7 aggregate ID. It generates each once, immediately persists both, and invokes only
the creation helper's fixed server-derived access-row operation to insert the Workspace product-relay
service principal's direct `manager` relationship to that new child Space in the same transaction. The
caller supplies neither principal, Space, relation, nor source, and the child callback receives no
generic access-relationship repository. The handler completes the command record with the result
references and a safe response, and commits aggregate, Space, exact relay access row, audit, and
canonical product-outbox records together. No child ID is
accepted from the caller, generated before the reservation win, or regenerated on replay. This
protocol remains proposed only until B1.0 supplies the canonical typed row and domain-notification
relay contract.

The reservation has no durable abandoned state. `reserved` is an in-transaction state only; the
create handler must either update it to `completed` before commit or throw so
`withTenantTransaction` rolls back. A deferred database constraint rejects commit of a create
record still in `reserved`. A lost connection, handler error, statement/idle transaction timeout,
or explicit cancellation therefore removes the reservation and every associated write. The next
request may then win and allocate one pair of IDs.

Exact outcomes are mechanical:

- identical replay of a committed record returns the stored IDs/response without allocation or
  writes;
- reuse with a different canonical request hash returns conflict without revealing the stored
  request or result;
- a concurrent identical request waits on the unique-key conflict and then follows identical
  replay;
- a concurrent mismatched request waits and then follows mismatch conflict;
- any failure before commit rolls back reservation, Space, aggregate, fixed child product-relay access
  row, audit, and canonical product-outbox records together;
  and
- an abandoned open transaction is cancelled/rolled back and is behaviorally identical to any
  other rollback, not converted into a committed pending record.

Database and concurrency tests count one command record, one child Space, one aggregate, one exact
direct product-relay access row, one audit event, and one canonical product-outbox event after retries;
inject failures after reservation, after each UUID allocation, after child creation, before/after the
fixed relay-access insert, after each remaining insert, and before commit; and prove no replay path can
create a duplicate Space, aggregate, relay access row, audit event, or outbox event.

### 2. Normalized associations

The canonical API arrays are projections over join tables, never PostgreSQL array columns:

| Projection | Authoritative persistence |
| --- | --- |
| Organization domains | `work.organization_domains` |
| Initiative organizations | `work.initiative_organizations` |
| Initiative contributors | `work.initiative_people` |
| Activity organizations | `work.activity_organizations` |
| Activity initiatives | `work.activity_initiatives` |
| Activity attendees | `work.activity_attendees` |
| Activity sources | `work.activity_sources` |

Association tables are not duplicated as generic `Relationship` rows. They answer containment,
membership, and cardinality questions. `Relationship` is reserved for a meaningful directed graph
assertion such as a Person being account owner for an Organization or an Organization being a
partner on an Initiative.

### 3. Relationship direction and endpoints

A relationship is stored once, from grammatical subject to grammatical object:

```text
subject --predicate--> object
```

There are no automatic inverse rows. Reverse traversal queries the object columns. Predicate keys
are stable lowercase snake/dotted identifiers owned by Core or first-party Account Operations; a
request cannot introduce executable behavior through a predicate string.

B1 permits these implemented endpoint kinds only:

- `space`;
- `person`;
- `organization`;
- `initiative`;
- `activity`;
- `content`.

Reserved future `EntityKind` values are rejected until their tables and endpoint validators exist.
A reviewed SQL constraint plus a fixed trigger validates that every endpoint exists in the same
Tenant and Workspace. The trigger branches over the allowlisted table names; it never constructs
dynamic SQL from request data. Endpoint validation and authorization are repeated in trusted
server code before the insert.

Every relationship has one governing `space_id`. `space`, `organization`, `initiative`, `activity`,
and `content` are Space-bearing kinds; `person` is not:

- if `context_type/context_id` is present, it must be Space-bearing and its Space is the governing
  Space;
- without a context, the subject's Space is governing when the subject is Space-bearing;
- otherwise, the object must be Space-bearing and its Space is governing;
- a relationship whose subject and object are both non-Space-bearing is rejected unless it has an
  authorized Space-bearing context;
- a Person endpoint has no independent Space and inherits no authority; and
- a relationship is readable only when the caller can read its governing Space, subject, object,
  and explicit context without disclosing an inaccessible endpoint.

Trusted server code derives `space_id`; the request never selects it. The fixed integrity trigger
independently validates the same context → subject → object resolution, rejects a non-Space-bearing
context or an unresolved governing Space, and rejects a persisted `space_id` that differs from the
derived value. Thus `person --account_owner_for--> organization` without a context is governed by
the Organization Space, while `person --> person` requires an explicit authorized Space-bearing
context.

If an endpoint is in a more restrictive or otherwise inaccessible Space, the API must not publish
the relationship into a broader context. The request is denied or must select an authorized
governing context that does not broaden visibility.

`valid_from` and `valid_to` use half-open validity `[valid_from, valid_to)`. Ending a relationship
sets `valid_to` through a version-checked command; it does not delete the historical row. B1 does
not infer relationships from source text.

### 4. ContentItem versus SourceArtifact ownership

`ContentItem` and `SourceArtifact` have intentionally different lifecycles:

- A `ContentItem` is mutable collaboration content. The item row contains current metadata and a
  current revision number; each body change appends an immutable `content.content_revisions` row.
- A `SourceArtifact` is immutable evidence. It is owned by its Tenant, Workspace, governing Space,
  and capture provenance, not by a mutable ContentItem.
- A source captured from content may point to the exact `(content_item_id, revision_number)` that
  was snapshotted. That optional provenance link never means the source follows later edits.
- A source captured directly from an Activity needs no ContentItem. The Activity association is
  recorded in `work.activity_sources`.
- Updating or deleting a ContentItem never mutates a SourceArtifact. Creating new evidence from a
  later content revision creates a new SourceArtifact.
- Source access class is at least the governing Space access class and may be more restrictive.
  B1 never downgrades access class during capture or correction.

This distinction lets quick note/paste capture satisfy the B1 gate without pretending that an
editable note is itself immutable evidence.

## Proposed persistence and migration order

Do not rewrite or renumber migrations `0001` or `0002`. Add reviewed SQL migrations after the
current journal head and mirror them in Drizzle schema definitions.

### Migration 0003 — B1.0 canonical product-domain outbox prerequisite

B1.0 is a bounded prerequisite PR, not B3 and not B1 implementation. Migration `0003` creates the
minimal generic product-command infrastructure required to make a product notification impossible
without durable command causation and audit evidence:

- `ops.domain_command_records`;
- append-only `ops.audit_events`; and
- `ops.product_outbox_events`, the canonical transactional product-domain outbox.

The bounded B1.0 prerequisite also introduces the dedicated product-relay database role and defines
its policies, grants, constraints, indexes, publication-state triggers, relay repository, queue
contract, authorization action, service principal, envelope, and tests. All are additive and isolated from the existing Foundation proof
table and path. Creating this generic infrastructure authorizes no B1 handler, route, aggregate
migration, or product write.

`ops.domain_command_records` is generic infrastructure rather than a B1 handler registry. It contains
exact Tenant/Workspace/reservation-Space scope, bounded command kind and command-schema version,
caller-supplied idempotency key, canonical request hash, transaction-only `reserved` and durable
`completed` states, nullable typed result reference/safe response slots, actor/delegation references,
request/trace metadata, timestamps, a deferred no-committed-`reserved` integrity trigger,
`UNIQUE (tenant_id, workspace_id, id)` for composite causation targets, and an idempotency unique key
on
`(tenant_id, workspace_id, reservation_space_id, command_kind, idempotency_key)`. Identical replay is
accepted only when the full canonical request hash and trusted scope/actor metadata match. B1-specific
command-kind, result-table, generated-child, and response-shape integrity is deferred to migration
`0006`; no route can invoke the generic records alone. Migration `0003` constrains `command_kind` to a
bounded versioned identifier grammar but authorizes no B1 kind; disposable B1.0 tests use the reserved
`b1_0.fixture.v1` kind only through the test harness, and teardown removes every fixture before any
`0006` apply.

The application role receives no generic command update. Its migration-`0003` grant is limited to
`UPDATE (state, result_resource_type, result_resource_id, safe_response, completed_at, updated_at)` on
`ops.domain_command_records`. A fixed prepared repository statement matches exact
Tenant/Workspace/reservation-Space/command ID, `state = 'reserved'`, idempotency key, and request hash;
a transition trigger permits only `reserved → completed` in the creating transaction and rejects
changes to scope, kind/schema version, idempotency/request identity, actor/delegation, or trace fields.
No reset/reopen/delete path exists. Catalog and role tests prove the exact completion columns are the
only application-update surface and that a command can complete before the deferred no-committed-
`reserved` check fires.

`ops.audit_events` contains exact Tenant/Workspace/Space scope; a non-null domain-command causation ID;
the allowlisted action and typed resource type/ID; actor Membership and User; delegating Membership
and User when present; agent principal when present; policy version; request and trace IDs; an
audit-schema version; and schema-validated safe detail. Actor/delegator/principal/policy references
are composite same-scope foreign keys; command causation is a composite Tenant/Workspace foreign key
without false Space equality because creation commands may remain parent-scoped while audit rows are
child-resource-scoped. Detail excludes raw source text, object keys, restricted Person fields, credentials, and policy-erased hashes. The table is immutable after insert: no application
update/delete grant exists and an append-only trigger rejects owner, application, or maintenance-path
`UPDATE`/`DELETE` except a separately governed archival migration that is outside B1.0/B1.

Each `ops.product_outbox_events` row contains:

- UUIDv7 `id`, also the stable logical `event_id` generated once by the winning command reservation
  and reused on every publication attempt;
- exact non-null `tenant_id`, `workspace_id`, and governing `space_id` with composite scope foreign
  keys;
- the exact notification-only `relay_service_principal_id` and exact `policy_version_id`, each bound by
  a composite same-scope foreign key; both are immutable publication-authorization inputs and omitted
  from the notification envelope;
- a closed typed B1 `event_type` union and matching closed B1 `aggregate_type` union;
- positive `event_schema_version`, positive `payload_schema_version`, aggregate UUIDv7 `aggregate_id`,
  and positive committed `aggregate_version`;
- non-null `causation_command_id` bound immediately by the migration-`0003` composite same-Tenant/
  Workspace foreign key to `ops.domain_command_records`;
- a schema-validated safe JSON payload whose discriminant and payload schema version match
  `event_type`, excluding raw source text, object keys, restricted Person fields, credentials, and
  policy-erased hashes;
- bounded `request_id`, `traceparent`, and optional `tracestate`; and
- publication state limited to `publication_attempt`, `claimed_by`, an unguessable per-attempt `claim_token`, `claim_expires_at`, next-attempt time, sanitized outcome code,
  broker-assigned SQS `MessageId`, broker-acknowledged `published_at`, or terminal publication
  state/time.

The command and outbox may intentionally have different Spaces for Organization/Initiative creation:
the command is parent-reservation-scoped and the notification is child-aggregate-scoped. The
migration-`0003` causation foreign key therefore binds `(tenant_id, workspace_id,
causation_command_id)` to the matching command without a false Space-equality requirement. Migration
`0006` adds only the B1-specific deferred trigger proving the completed command result, generated
child, aggregate, audit row, and notification belong to the exact authorized creation transaction.

The stable duplicate identity is both `event_id` and a unique semantic key on
`(tenant_id, workspace_id, space_id, causation_command_id, event_type, aggregate_type, aggregate_id,
aggregate_version)`. Identical command replay returns the existing row and event ID only when the
full trusted envelope payload is byte-for-byte/canonically equal. Any mismatch is an invariant
conflict and rolls back. Publication retries always preserve `event_id`; they do not assume broker
message deduplication.

The canonical TypeScript `DomainNotificationEnvelope` is a discriminated union containing exactly
`eventId`, `eventType`, `eventSchemaVersion`, `payloadSchemaVersion`, Tenant/Workspace/Space scope,
aggregate type/ID/version, causation command ID, safe payload, request ID, and trace carrier. It is a
notification of an already-authorized committed fact, not authority to execute an effect. It
contains and requires no `jobId`, signed delegated-context reference, worker execution authority,
active consumer, AgentRun, ChangeSet, ExecutionReceipt, consumer acknowledgement, redrive, or DLQ
lifecycle.

A future B1 mutation must insert its aggregate state, command record, `ops.audit_events`, and canonical
product-outbox row through repositories sharing one `TenantDbTransaction`; none may acquire a pool or
accept a post-commit copy. A mutation without its audit/outbox record, or a later promotion into the
outbox, is invalid. Migration `0003` supplies these secured transaction-bound contracts and rollback
tests; B1 handlers remain forbidden until B1.0 is merged and the HOLD is explicitly lifted.

#### Migration-0003 install order and no-orphan invariant

Within the migration transaction, `0003` creates all three tables with no application or product-relay
privileges, installs and validates every check/composite foreign key/index/immutability/publication
trigger, enables and forces RLS, creates exact policies, and runs catalog assertions. Only after all
constraints and security objects exist may the final statements grant scoped application
`INSERT`/`SELECT`, the exact command-completion `UPDATE` columns above, and product-relay
claim/publication authority. Any failed constraint, policy, catalog
assertion, or grant rolls back the entire migration; there is no intermediate granted state.

The product outbox's non-deferrable composite causation foreign key and forced-RLS insert policy make
an orphan notification unrepresentable through the application or relay role. `ops.audit_events`
likewise requires a real same-Tenant/Workspace command row. The product relay has no outbox `INSERT`/`DELETE`, no
command/audit write grant, and no authority to publish an unclaimed or causally invalid row. Catalog
and adversarial tests apply migration `0003` alone, then prove an absent, cross-Tenant, cross-Workspace,
or mismatched command ID cannot be inserted or claimed/published and produces zero SQS sends.

B1.0 atomicity/publication tests use the real forced-RLS `ops.domain_command_records`,
`ops.audit_events`, and `ops.product_outbox_events` tables and their real application/product-relay
roles. They insert an allowlisted generic fixture command plus audit/outbox rows in one transaction;
test rows are rolled back where possible and otherwise cleaned only by dropping the disposable test
database/resource after relay transactions finish, never by bypassing append-only row rules.
Lookalike test-schema command/audit tables are forbidden. The B1 application routes remain
absent/disabled, and no production B1 aggregate/result row is created.

#### Product-relay authorization-to-send transaction

Publication uses a new least-privilege `throughline_product_relay` database role and one fixed
notification-only product-relay service principal per Workspace, authorized only for
`product_outbox.relay.publish`. B1.0 provisions the principal but no blanket Space grant. A product
notification is eligible only when its exact Space already has one live direct `manager`
`access.access_relationships` row for that same-Workspace principal: the creation helper inserts it
atomically for every new Organization/Initiative child, and any pre-existing eligible Space requires a
separately authorized fixed provisioning transaction before a B1 route may use it. Claiming remains a
separate bounded-lease transaction and conveys no send authority. Every send attempt starts a new fixed product-relay publish transaction that:

1. begins with a server-owned claim handle captured by the claim transaction containing the exact row
   ID, Tenant/Workspace/Space, product-relay principal, `policy_version_id`, `publication_attempt`,
   `claimed_by`, unguessable `claim_token`, and `claim_expires_at`; sets those transaction-local scope,
   principal, and policy values before forced-RLS access; and treats the handle as no authority;
2. selects that exact claimed `ops.product_outbox_events` row `FOR UPDATE`, rejecting unless every
   immutable scope/principal/policy/event field and every claim owner/token/attempt/expiry value
   exactly matches the handle and the lease is still live in an unpublished/retryable state;
3. locks every live authority input with fixed `SELECT id ... FOR UPDATE` statements in this
   deterministic order and retains every lock through the SQS send, publication-state update, and
   database commit or rollback: Tenant, Workspace, exact policy version, product-relay service
   principal, Space, then the exact `source = 'direct'`, `relation = 'manager'`
   `access.access_relationships` row;
4. executes central `product_outbox.relay.publish` reauthorization against those locked live rows and
   denies before SQS when any row is absent, inactive, archived, retired, disabled, cross-scope,
   indirect, revoked, or no longer grants that exact direct `manager` relation;
5. sends the immutable envelope to SQS while all authority locks remain held; and
6. records only the allowed publication outcome columns and commits, or rolls back all database state
   and releases every lock.

The relay repository exposes only fixed prepared claim/publish statements and the immutable envelope;
it exposes no generic query callback, arbitrary SQL, or broader table mutation capability. For the
six authority tables, the role receives scoped `SELECT` plus only the narrowly required catalog-tested
`UPDATE(id)` privilege that lets PostgreSQL take row locks. Each table has a scoped permissive
`FOR UPDATE` policy with its exact live/scope predicate and `WITH CHECK (false)`, plus a restrictive
no-write `FOR UPDATE` guard with `USING (true)` and `WITH CHECK (false)`. No other column is updateable.
The outbox grants only claim/publication columns, and immutable envelope columns cannot be updated.
Both roles are `NOBYPASSRLS`; the product relay receives no grants on B1 aggregate/audit/command
writes and cannot use Foundation `throughline_relay`.

Deterministic database/broker-seam races prove:

- a stale, replayed, mismatched-token, wrong-owner, wrong-attempt, expired, or policy-version-mismatched
  claim handle is denied under the row lock with zero sends, and two relay instances sharing scope
  cannot publish each other's claim;
- after a claim commits, if revocation commits before publish starts, the publish transaction denies
  and sends zero messages;
- when revocation wins first, publish sends zero messages and makes no publication update;
- when relay locking wins first, revocation blocks until relay commit or rollback, so authority cannot
  change between authorization and send;
- timeout, cancellation, broker error, and transaction rollback release the outbox and all authority
  locks; and
- concurrent relays/revocations following the exact order above complete without deadlock.

#### Dedicated SQS Standard no-consumer contract

B1.0 provisions one dedicated **SQS Standard** product-notification queue with
`MessageRetentionPeriod = 86400`. It has no redrive policy, consumer, event-source mapping, or no-op
worker. The product-relay runtime principal receives exactly `sqs:SendMessage` and narrowly scoped
`sqs:GetQueueAttributes` for this queue, with no other SQS data-plane action. No B1.0 principal
receives `sqs:ReceiveMessage`, `sqs:DeleteMessage`, or `sqs:ChangeMessageVisibility`.

`DomainNotificationEnvelope.eventId` is the stable logical identity in the message body and is copied
to the allowlisted String message attribute `event_id`. SQS `MessageId` is broker-assigned diagnostic
metadata, stored separately in the outbox publication fields. The Standard-queue send never supplies
`MessageDeduplicationId` or `MessageGroupId`. Publication is at-least-once and potentially unordered,
not exactly-once.

An accepted send followed by a lost acknowledgement, database marker failure, or transaction rollback
may put duplicate messages on the queue with the same `eventId` and envelope but distinct possible
SQS `MessageId` values. `published_at` means only that broker acknowledgement was observed and the
publication marker committed; it does not prove exactly-once delivery. A deterministic rejected send
may eventually become `terminal_failed`; exhausted ambiguous send outcomes become
`terminal_unconfirmed`, never proof that no message was published. An explicitly authorized operator
retry may clear only publication terminal state and must preserve the event ID and exact envelope.
Automatic attempts remain bounded to the initial send plus retries after 1, 5, 30, 120, and 600
seconds.

Future consumers must durably deduplicate by `eventId`, reject any duplicate whose full canonical
envelope is not equal, validate `aggregateVersion` against their durable per-aggregate processing
state, tolerate unordered delivery, establish their own current execution context, and reauthorize
every effect. The notification conveys no delegated authority.

Tests read back `MessageRetentionPeriod` as exactly the string/seconds value `86400`, inspect exact
queue/IAM attributes and prove no redrive or receive/delete/change-visibility authority. A disposable
test-harness observer outside every B1.0 application/runtime principal may inspect test messages only
to assert queue behavior and is destroyed with the disposable queue; that observer is never a
product consumer or deployable role. Behavioral expiry is broker-managed and eventual: tests use a
documented provider clock seam, or a separately supported shortened retention on a disposable queue,
plus bounded polling. They do not claim exact
wall-clock deletion at 86,400 seconds without such a seam. Accepted-send/marker-rollback/retry tests
prove duplicate messages retain identical logical envelopes and `eventId`, may have distinct broker
`MessageId` values, cause zero product effects, and leave no consumer invocation.

B1.0 must prove the existing Foundation `ops.outbox_events` table, checks/FKs/indexes, constants,
`FoundationQueueEnvelope`, `throughline_relay`/`throughline_worker` roles and grants, relay repository
and authorization path, signed context-reference flow, queue resources, and end-to-end proof are
byte/behavior unchanged. Product rows remain unreachable from Foundation claim filters, and
Foundation roles cannot select or mutate the product outbox. These isolation/non-regression tests run
in both the full Foundation gate and the B1.0 gate.

Migration `0003` is separately reviewed and approved; this plan correction does not authorize its
implementation or merge.

### Migration 0004 — work graph

Create schema `work` and these tables:

- `work.organizations`;
- `work.organization_domains`;
- `work.initiatives`;
- `work.initiative_organizations`;
- `work.initiative_people`;
- `work.activities`;
- `work.activity_organizations`;
- `work.activity_initiatives`;
- `work.activity_attendees`;
- `work.relationships`.

All tables, including joins, contain `tenant_id`, `workspace_id`, and `space_id`. Aggregate tables
also contain UUIDv7 `id`, timestamps, and integer optimistic `version`. Append-only association rows
use `created_at`; an association that requires history uses an end timestamp rather than deletion.

Minimum aggregate columns follow the canonical interfaces, with normalized arrays removed:

- Organization: `id`, scope, `name`, `normalized_name`, `status`, timestamps, `version`.
- Initiative: `id`, scope, `title`, `type_key`, `stage_key`, `health`, `owner_person_id`,
  `profile_id`, `profile_version`, optional evidence fields, timestamps, `version`.
- Activity: `id`, scope, `subtype`, `profile_template_key`, `title`, `status`, occurrence/schedule
  timestamps, `owner_person_id`, mutually exclusive `governing_initiative_id` /
  `governing_organization_id`, timestamps, `version`.
- Relationship: `id`, scope, typed subject/object/context columns, predicate, optional
  `supporting_fact_id` reserved null until B2, validity interval, timestamps, `version`.

Important constraints:

- `UNIQUE (tenant_id, workspace_id, id)` and
  `UNIQUE (tenant_id, workspace_id, space_id, id)` on aggregate tables for composite foreign keys;
- domains are canonical lowercase IDNA ASCII host names, unique per Organization;
- exactly one active `primary` organization association per Initiative;
- Initiative/Activity profile keys are checked by the application against the exact Workspace pin;
- Activity time constraints reject `ends_at < starts_at`;
- an Activity has exactly one governing-parent column; the selected parent must also exist in the
  matching Activity association table, must be in the exact scope, and its Space must equal the
  Activity `space_id`. Deferred fixed triggers validate the completed association set at commit so
  insert order cannot create a temporary security exception;
- relationship subject cannot equal object for an identical kind unless the predicate is explicitly
  allowlisted as reflexive (none are allowlisted in B1);
- relationship validity rejects `valid_to <= valid_from`;
- all composite foreign keys preserve Tenant/Workspace identity; join rows also preserve the
  governing Space of their parent aggregate.

Organization and Initiative Space creation uses existing `access.spaces`; B1 does not create a
parallel containment tree.

Migration `0004` also installs, in this same transaction, RLS enablement/FORCE RLS, exact app-role
grants, policies, composite scope foreign keys, and all work-table integrity triggers, including
Relationship endpoint/governing-Space enforcement. A work table is never committed by the
migration runner without its complete security boundary.

### Migration 0005 — content, sources, and chunks

Create schema `content` and:

- `content.content_items`;
- `content.content_revisions`;
- `content.source_artifacts`;
- `content.source_chunks`;
- `work.activity_sources` after the source table exists.

`content_items` contains mutable metadata and `current_revision`. `content_revisions` has a unique
logical key `(tenant_id, workspace_id, content_item_id, revision_number)` and is insert-only.

`source_artifacts` includes the canonical source fields plus:

- `version` (created at `1`; only the governed tombstone transition increments it once);
- `normalization_version` (B1 writes only `source-normalization.v1`);
- `chunking_version` (B1 writes only `source-chunking.v1`);
- `normalized_content_hash` for the full normalized text used to create chunks;
- immutable, server-derived `hash_retention_policy` (`retain` or `erase_on_tombstone`), resolved
  from the governing retention policy when the source is captured;
- optional `origin_content_item_id` and `origin_content_revision`;
- `supersedes_source_id`;
- tombstone fields `deleted_at`, `deletion_reason`, `deletion_policy_ref`, and nullable
  `hash_disposition`; the disposition is derived from `hash_retention_policy`, and hash columns are
  nullable only for the governed `erase_on_tombstone` transition.

`source_chunks` includes:

- UUIDv7 row `id`;
- exact scope and `source_artifact_id`;
- `normalization_version`;
- `chunking_version`;
- zero-based `chunk_index`;
- normalized source-global `[start_offset, end_offset)`;
- `normalized_text`;
- SHA-256 `content_hash`;
- inherited `access_class`;
- `created_at`.

The deterministic logical identity is unique on:

```text
(tenant_id, workspace_id, source_artifact_id, normalization_version, chunking_version, chunk_index)
```

The persisted row ID remains UUIDv7, preserving the canonical all-ID rule. A retry locks/looks up
the logical key and returns the already persisted UUIDv7; it never creates a UUIDv5 or content-hash
primary key.

An idempotent lookup is successful only when the full trusted persisted payload is equal: exact
Tenant/Workspace/Space/source scope, normalization and chunking versions, index, scalar offsets,
normalized text, content hash, and inherited access class. A matching logical key with any
different field is an invariant violation that rolls back the command; it is never treated as a
successful replay.

Migration `0005` also installs, in this same transaction, RLS enablement/FORCE RLS, exact app-role
grants, policies, composite scope foreign keys, access-class checks, immutable-row triggers, and
the exact governed correction/tombstone transition triggers for every table it creates. There is
no interval in which content/source tables exist without their complete security boundary.

### Migration 0006 — B1 aggregate, result, and child integrity only

Migration `0003` already owns the real secured `ops.domain_command_records`, `ops.audit_events`, and
`ops.product_outbox_events` tables, their generic constraints/indexes, forced RLS, exact grants and
policies, audit immutability, publication-state triggers, and the composite Tenant/Workspace
outbox-to-command causation foreign key. Migration `0006` creates no replacement or shadow ops table
and does not add generic application or product-relay authority.

After migrations `0004` and `0005` create the B1 aggregate tables, migration `0006` adds only
B1-specific integrity that could not exist in `0003`:

- the closed B1 command-kind and schema-version allowlist;
- typed command-result/resource references and schema-validated safe response shapes;
- deferred fixed triggers proving a completed command result references the exact aggregate written
  by that command transaction;
- Organization/Initiative creation integrity proving the parent-reservation-scoped command, helper-
  generated direct child Space, helper-owned exact direct `manager` access row for the fixed Workspace
  product-relay service principal, child-scoped aggregate, audit row, and product notification form
  the exact allowed parent → new child → parent transaction;
- event/aggregate-pair and resulting aggregate-version checks against the committed B1 aggregate; and
- audit action/resource consistency with the command and committed aggregate.

The command and notification intentionally do not have a Space-equality foreign key for
Organization/Initiative creation: the command remains parent-scoped while the result/outbox/audit are
bound to the generated child as defined above. `0006` cannot loosen or replace the generic `0003`
causation FK, RLS, grants, append-only trigger, outbox immutability, relay lock policy, or SQS contract.
Its own B1-specific constraints/triggers and catalog assertions install in the same migration
transaction before any separately approved B1 route could be enabled.

Throughline remains non-event-sourced and creates no `ops.domain_events` ledger. The canonical
`ops.product_outbox_events` notification plus `ops.audit_events` is the complete durable event/audit
record. Migration `0006` remains proposed and must not ship until B1.0 is separately approved and
merged and Andrew explicitly lifts the B1 HOLD.

Across the four migrations:

- every table is secured in the same numbered migration that creates it;
- `0003` owns the generic command/audit/product-outbox tables, all of their RLS/grants/policies,
  command/audit causation foreign keys, audit append-only and publication-state triggers, the
  `throughline_product_relay` role, the authority-row lock policies, and the SQS Standard contract;
- application access to the three generic ops tables is exact and is granted only after all `0003`
  constraints/security objects exist; command updates are limited to the fixed one-way completion
  columns/statement and audit/outbox immutability remains enforced;
- `throughline_product_relay` has no command/audit/aggregate write grant, only exact outbox
  claim/publication columns plus catalog-tested authority-row `UPDATE(id)` lock capability;
- no B1 product/audit/command grants go to Foundation `throughline_relay` or `throughline_worker`;
- `ops.audit_events` remains app `SELECT, INSERT` only, with no app `UPDATE` or `DELETE`;
- `0004` owns work-table RLS/grants/policies/triggers;
- `0005` owns content/source RLS/grants/policies/triggers; and
- `0006` owns only the B1 aggregate/result/generated-child/event-version consistency constraints and
  triggers that depend on tables introduced by `0004`/`0005`.

Migration tests must inspect the catalog and exact privilege surface, not only match SQL strings.

## Tenant, Workspace, Space, RLS, and privilege rules

Every B1 row has explicit ownership:

| Table family | Tenant | Workspace | Governing Space |
| --- | --- | --- | --- |
| Organizations/domains | required | required | Organization Space |
| Initiatives and their joins | required | required | Initiative Space |
| Activities and their joins | required | required | Activity Space |
| Relationships | required | required | context/subject/object fallback Space |
| Content items/revisions | required | required | ContentItem Space |
| Source artifacts/chunks | required | required | SourceArtifact Space |
| Activity-source links | required | required | Activity Space |
| Domain command records | required | required | stable target/parent reservation Space |
| Product outbox events | required | required | aggregate governing Space |
| Audit events | required | required | command resource governing Space |

For each table:

1. `tenant_id`, `workspace_id`, and `space_id` are non-null.
2. A composite foreign key proves the Space belongs to the same Tenant and Workspace.
3. Cross-table foreign keys include Tenant and Workspace; parent-owned children additionally bind
   the parent's governing Space.
4. RLS is both enabled and forced.
5. `USING` restricts app-role visibility to current Tenant and Workspace.
6. `WITH CHECK` additionally requires the command's exact transaction-local `app.space_id` for
   ordinary inserts/updates. Every statement therefore has one exact Space. Organization/Initiative
   creation begins and ends in the stable authorized parent Space; only the fixed creation helper
   below may enter the newly created child Space. Handlers and repositories never call raw
   `set_config`, choose a replacement scope, or receive a generic scope-switch capability. Using the
   not-yet-created child as idempotency or authorization scope is forbidden.
7. Space-level read authorization remains the canonical centralized `can()` plus explicit
   permitted-Space repository predicate. RLS is the Tenant/Workspace backstop; it is not falsely
   presented as a replacement for recursive Space authorization.
8. Repositories accept a `TenantDbTransaction`; none acquire a pool or execute outside
   `withTenantTransaction`.
9. The application asserts the expected `NOBYPASSRLS` role at the boundary before authorization and
   mutation, following the existing Foundation pattern.
10. Missing, empty, expired, cross-scope, archived-Space, suspended-Membership, or inactive-policy
    context fails closed before returning resource existence, title, count, or source text.

### Creation-only Space context transition helper

`packages/db/src/transaction.ts` owns one fixed `withCreatedChildSpaceScope` helper layered inside an
already-open `withTenantTransaction`. It is not exported as a generic scope switch and is the only
code allowed to change transaction-local `app.space_id` after transaction setup. Handlers and
repositories receive neither the setting name nor raw configuration/query access for scope changes.

The helper enforces this exact state machine and no other transition:

```text
locked + centrally authorized parent Space
  → helper-generated and helper-inserted direct child Space in the same transaction
  → helper-owned exact direct manager access row for the Workspace product-relay principal
  → restricted child-creation writes
  → original parent Space
```

Before entering child scope, the helper requires the current setting to equal the expected parent,
locks that live parent in the exact Tenant/Workspace, generates the UUIDv7 child ID internally after
the command reservation win, inserts the child with `parent_id = expected_parent_id`, and verifies
the inserted row through `RETURNING`. It rejects caller-supplied child IDs, a missing/archived parent,
an existing child row, a non-direct child, a cross-scope row, a pre-existing unrelated Space, or any
attempted parent → unrelated/pre-existing child transition. Still in the authorized creation path and
before exposing child scope, the helper resolves the one fixed Workspace product-relay service
principal created by B1.0, locks that live same-Workspace principal, and executes one fixed insert into
`access.access_relationships` with server-derived subject/principal, the generated child Space,
`relation = 'manager'`, and `source = 'direct'`. Neither caller nor callback chooses any field or
receives generic relationship-write authority; uniqueness makes replay or an additional relay grant
fail closed. Migration `0006` adds the B1 child-specific deferred integrity check requiring exactly that
one same-transaction direct row before the child aggregate/outbox can commit.

While child scope is active, the callback receives a restricted `ChildCreationDbTransaction`
capability rather than `TenantDbTransaction`. It exposes only fixed statements/repositories for that
new child Space's aggregate, required associations, audit row, and canonical product-outbox row. It
cannot call `can()`, resolve/read unrelated resources, invoke arbitrary repositories/SQL, recurse,
create another Space, or perform unrelated authorization or domain work. The command record remains
parent-scoped and is completed only after the helper has restored the parent.

A `finally` block restores the exact original parent and verifies the setting before returning. Any
child write, callback, restore, or verification failure aborts the whole transaction. The outer
transaction wrapper rolls back and, before pool release, verifies transaction-local Tenant,
Workspace, Space, actor, and policy settings are cleared; a cleanup failure destroys rather than
reuses the connection. No child/aggregate/product-relay-access/audit/outbox residue may survive
rollback.

Adversarial tests cover forged caller child IDs, an existing unrelated Space ID, a child under a
different parent, cross-Tenant/Workspace IDs, nested/reentrant switches, arbitrary query/repository
attempts from the restricted callback, authorization attempts while switched, forged relay
principal/relation/source fields, missing/duplicate/cross-Workspace relay access rows, failure
before/after the fixed relay-access insert, callback failure, restore failure, commit and rollback
paths, and release/reacquire of the same pooled connection with no leaked context. Tests also prove
the only observed sequence is parent → same-transaction direct child plus exact direct relay access
row → parent and that every successful retry produces one child, one exact relay access row, one
aggregate, one audit row, and one outbox row.

No request body or header supplies trusted Tenant, Workspace, Space, actor, access class, profile
version, hash, chunk identity, or offsets. Trusted server code derives those fields from current
context, live rows, and the pinned profile.

### ADR-018 access-class enforcement

B1 implements the accepted lattice as an ordered server constant:

```text
public (0) < workspace (1) < restricted (2) < confidential (3)
```

Every protected read and mutation compares the effective resource class with
`SecurityContext.dataClassCeiling`; a resource is eligible only when its rank is less than or equal
to the ceiling. `requestedSpaceIds`, a Relationship, an association row, or a broader context never
raises that ceiling or lowers an endpoint/resource class.

For sources, `effective_source_class = max(governing Space access_class, SourceArtifact
access_class)`. Capture derives the source class as at least the governing Space class and rejects
a caller whose ceiling cannot read the result. Correction derives
`max(current predecessor effective class, governing Space class, authorized requested class)` and
never downgrades. Source metadata, body, chunks, direct lookup, history/current resolution, and
every list/count query apply both permitted-Space and effective-class predicates before projection.

An Activity-source link is readable only when the caller can read the Activity, the source's own
governing Space, and the effective source class. The link/list/count result is filtered as one unit;
an authorized broader Activity never reveals the existence, ID, title, hash, count, or timing of a
more restrictive source. Capture and correction lock and validate the Activity/source endpoints
under these same rules. A link cannot republish source data into the Activity's broader class.

Relationship reads likewise require the governing context plus each endpoint's independent read
rule and effective class. A broader explicit context cannot make a restricted endpoint visible.
The required matrices include at least:

| Governing/container class | Endpoint/source class | Context ceiling | Result |
| --- | --- | --- | --- |
| `workspace` Activity Space | `restricted` source | `workspace` | non-leaking denial/omission, including count |
| `workspace` Activity Space | `restricted` source | `restricted` with source-Space access | allow |
| `workspace` Relationship context | `restricted` endpoint | `workspace` | non-leaking denial/omission |
| `workspace` Relationship context | `restricted` endpoint | `restricted` with endpoint access | allow |
| `restricted` container | `workspace` source request | `restricted` | persist/read as `restricted`; no downgrade |

Tests cover all four lattice values, lower/equal/higher ceiling comparisons, broader-Space with
more-restrictive source, broader-context with restricted endpoint, link/list/count behavior, and
permission/class tightening after prior access.

## Append-only SourceArtifact behavior

Normal application behavior permits `INSERT` and `SELECT` but no update or delete of evidence rows.
The following are immutable after insertion:

- source type/trust class and capture provenance;
- title, immutable text/object reference, and hashes;
- origin ContentItem revision;
- provider/adapter metadata;
- occurrence/retrieval timestamps;
- access class and snapshot policy;
- correction predecessor;
- normalization and chunking versions; and
- the server-derived `hash_retention_policy` selected from the governing retention policy at
  capture.

The only mutation exception is a governed retention/lawful-erasure transition. The fixed command
handler may atomically:

1. lock the current non-deleted SourceArtifact;
2. verify policy/authority and an idempotency key;
3. derive `hash_disposition` mechanically from the artifact's immutable
   `hash_retention_policy` and irreversibly set tombstone fields;
4. clear `immutable_text` and `object_key` where policy requires erasure;
5. for `erase_on_tombstone`, atomically null the artifact hashes; for `retain`, keep them;
6. delete/cryptographically erase SourceChunks and stored objects;
7. append audit and canonical product-outbox metadata with only policy-permitted identifiers,
   conditionally allowlisted hashes, reason category, and policy reference, but no erased content; and
8. record the domain-command result in that same transaction.

A trigger rejects every other update and all physical deletion of the SourceArtifact row. A
tombstone can never be restored to live content.

The `content_hash` is SHA-256 over the exact captured UTF-8 bytes retained for the artifact.
`normalized_content_hash` is SHA-256 over the UTF-8 encoding of the v1 normalized text. Neither is
accepted from the client. Both are non-null for every live artifact, including one governed by
`erase_on_tombstone`, and may become null only in that exact policy-governed tombstone transition.
The server derives and stores `hash_retention_policy` when it captures each source; a caller or
later tombstone command can never select or change it.

## Deterministic SourceChunk normalization, identity, and offsets

ADR-017 is implemented with one versioned, fixture-tested algorithm.

### `source-normalization.v1`

For B1 text note/paste capture:

1. Require valid UTF-8 and reject NUL (`U+0000`) or an empty/whitespace-only source.
2. Remove one leading Unicode BOM if present.
3. Convert CRLF and lone CR to LF.
4. Normalize Unicode to NFC.
5. Preserve all other characters and whitespace exactly: no trim, case fold, punctuation rewrite,
   HTML interpretation, or instruction processing.
6. Index the resulting text by Unicode scalar value, not UTF-16 code unit or UTF-8 byte position.

Offsets are zero-based, half-open Unicode-scalar intervals. `SourceChunk.start_offset/end_offset`
refer to the full normalized artifact. Later Claim offsets are chunk-local half-open scalar
intervals. Trusted citation code converts offsets with shared scalar-safe helpers; JavaScript
`String.slice` is not used directly for non-ASCII offset arithmetic.

### `source-chunking.v1`

- Target maximum: 2,000 Unicode scalar values per chunk.
- Chunks are contiguous, ordered, non-overlapping, and lossless.
- At or before the maximum, choose the latest boundary in this order: paragraph break (`\n\n`),
  line break (`\n`), Unicode whitespace boundary, then the hard scalar limit.
- The boundary character belongs to the earlier chunk so concatenating chunks in index order
  reconstructs normalized text byte-for-byte after UTF-8 encoding.
- No overlap is stored in evidence chunks. A later Context Builder may assemble adjacent chunks
  without changing citation identity.
- `chunk_index` begins at zero with no gaps.
- Each row must satisfy its own hash, text length, global offsets, and exact substring
  reconstruction.
- Concatenated chunks and the full normalized-content hash must agree before commit.

Chunk generation runs in trusted deterministic TypeScript without model involvement. Golden tests
cover ASCII, CRLF/lone CR, BOM, composed/decomposed Unicode, emoji/non-BMP characters, blank lines,
long unbroken tokens, boundary whitespace, and retry identity.

## Correction chains

A correction never edits evidence. `CorrectSourceArtifact` creates a complete new SourceArtifact
with `supersedes_source_id` pointing to the immediately prior artifact.

Rules:

- predecessor and successor have the same Tenant, Workspace, and governing Space;
- predecessor exists and is visible to the actor;
- a source may have at most one direct successor in B1 (`UNIQUE (supersedes_source_id)`), producing
  a linear chain rather than silent forks;
- only the live terminal leaf may be corrected;
- a tombstoned source cannot be used as a readable correction input, though its tombstone may
  remain in a chain;
- the command locks the predecessor and checks for an existing successor, preventing concurrent
  forks;
- cycles and self-supersession are rejected;
- the new source's access class is no less restrictive than its predecessor and governing Space;
- current resolution follows successor links to the terminal leaf without skipping tombstones. A
  live leaf returns evidence; a tombstoned leaf returns the non-leaking tombstone/no-current-
  evidence result. It never searches backward for a live predecessor. History/audit reads may
  expose authorized predecessors independently.

Correction emits `source_artifact.corrected` with both IDs through the canonical product outbox. For
each referenced artifact, audit and product-outbox metadata may include its hash only when that
artifact's immutable policy is `retain`. If either artifact is `erase_on_tombstone`, no append-only
audit or product-outbox record copies that artifact's hashes during capture or correction. The
correction does not revoke a Claim in B1 because claims do not yet exist.

The mandatory regression is `A → B`, followed by `tombstone(B)`: current resolution returns B's
tombstone/no current evidence, B's text/chunks are absent, and it never falls back to A. Authorized
history may still show A only when policy retained A and the caller independently passes A's Space
and access-class checks.

## Retention tombstones and deletion reconciliation

B1 implements the source-side contract and no more:

- source body/chunks/object are removed or cryptographically erased as policy requires;
- source capture resolves and stores immutable `hash_retention_policy` as `retain` or
  `erase_on_tombstone`. Live rows have null `hash_disposition` and non-null `content_hash` /
  `normalized_content_hash`. Tombstoning derives `retained` from `retain` or `erased` from
  `erase_on_tombstone`; it never accepts a requested disposition. A `retained` tombstone keeps both
  hashes, while an `erased` tombstone atomically nulls both. A check constraint permits only those
  policy/state combinations and forbids later changes;
- the non-sensitive SourceArtifact tombstone, capture/correction linkage, timestamps, actor,
  reason category, policy reference, audit event, and canonical product-outbox event remain only
  where policy permits;
- normal source reads return a non-leaking tombstone state and never return erased content;
- ContentItem deletion is a separate command and does not imply evidence deletion;
- source correction is not used as a substitute for lawful deletion.

Because B1 has no Claim, AcceptedFact, embedding, citation, or DerivedView table, the B1
reconciliation transaction proves there are no such local dependents and completes source/chunk
cleanup plus invalidation event emission. Before B2 enables any downstream support, its migration
and command handlers must consume this contract and atomically revoke, redact, revalidate, delete,
or invalidate all affected records. Once those tables exist, tombstoning must fail closed unless
the downstream reconciliation handler is installed and succeeds in the same governed workflow.

Required retained metadata is Tenant/Workspace/Space, source ID, predecessor/successor IDs where
applicable, deletion reason category, policy reference, causation/command ID, actor, and trace ID.
For `retain`, append-only audit/product-outbox metadata may include explicitly allowlisted hashes and
the tombstone retains them. For `erase_on_tombstone`, no append-only audit or product-outbox record
may copy either hash at capture, correction, or tombstone time; the tombstone atomically nulls the
live artifact columns, so erasure never pretends to rewrite append-only history, and those hashes
never enter logs. Raw source text, chunks, and
erased object keys never enter event payloads, logs, or audit detail. Tests exercise both immutable
policies, derived dispositions, nullable transitions, immutable post-tombstone state,
capture/correction/tombstone metadata, and rejection of any caller-selected disposition.

## AI Solutions profile validation and version pinning

The profile remains declarative first-party configuration, not executable code or a generic pack
runtime.

### Validation

`packages/domain-profiles` owns a strict Zod schema and pure loader. It validates at build/test and
API startup:

- exact top-level shape with unknown keys rejected;
- `id`, semantic `version`, `status`, and compatible `minCoreVersion`;
- unique lowercase snake-case keys;
- unique, strictly increasing stage order;
- evidence-rule stage references;
- evidence signal keys against a versioned AI Solutions allowlist shipped with the schema (the
  canonical JSON has no separate signal catalog);
- readiness enum options or numeric min/max, with mutually valid shapes;
- unique activity-template and playbook keys;
- playbook conditions as an allowlisted discriminated AST (`eq`/`in` for v1), with field paths and
  value types validated against known profile fields;
- no functions, expressions, URLs, authorization rules, code, or unknown operators.

Compatibility compares `minCoreVersion` with an explicit Core contract version (`0.1.0` for this
baseline), not the root monorepo package's pre-release `0.0.0` value.

`packages/domain-profiles` remains outside Core dependency direction. Core packages do not import
it. `packages/account-operations` may consume its validated profile projection and Core services.

### Pinning

- The runtime registry key is the exact tuple `(profile_id, profile_version)`.
- The existing Workspace fields must resolve exactly to `('ai-solutions', '1.0.0')` for B1.
- There is no `latest` fallback and no automatic upgrade.
- Initiative rows copy the exact pin; their `type_key` and `stage_key` must resolve in that version.
- Engagement Activities validate `profile_template_key` against that same version.
- A build-generated manifest records the profile file SHA-256 for audit/startup diagnostics. A
  published profile changing without a version/manifest update fails tests; no database row is
  silently rewritten.
- An unknown, malformed, unpublished, incompatible, or mismatched profile causes startup or command
  failure before product data is written.
- Profile upgrades and migration previews remain deferred.

## Minimal Domain Command Bus seam

Accepted ADR-019 applies now even though the full governed ChangeSet runtime remains B3. Subject to
the implementation HOLD and the separately approved/merged B1.0 prerequisite, B1 would use a narrow
typed `DomainCommandBus` façade and fixed handlers for human-originated B1 commands only:

- `organization.create`;
- `initiative.create`;
- `activity.create`;
- `relationship.create`;
- `relationship.end`;
- `content.create`;
- `content.revise`;
- `source.capture`;
- `source.correct`;
- `source.tombstone`.

This is not AgentRun, ChangeSet, approval, or a generic command framework. Once B1.0 is merged and the
HOLD is lifted, each handler must:

1. parse a discriminated Zod payload;
2. resolve trusted scope/profile/access values server-side;
3. execute current `can()` in the same transaction immediately before mutation;
4. check optimistic preconditions where updating mutable state;
5. enforce a stable idempotency key and canonical request hash;
6. write aggregate state, `ops.audit_events`, and the canonical `ops.product_outbox_events` row
   atomically; and
7. return a typed result with no unrestricted repository or SQL callback.

A reused idempotency key with an identical request returns the stored result. Reuse with a different
request hash returns conflict. Human API handlers never write B1 tables directly. The stable-scope
reservation and fixed creation-only Space helper above are normative for Organization/Initiative
creation. No listed handler may be implemented or shipped under this plan alone.

### B1.0 product notification and Foundation isolation boundary

The merged Foundation `ops.outbox_events` is an exact proof-path table, not an existing generic
product outbox. Its actual contract:

- constrains `aggregate_type = 'foundation_test_aggregate'` and has a composite foreign key to
  `ops.foundation_test_aggregates`;
- requires `job_id`, a system relay service principal, a durable security-context reference, and its
  signed token;
- binds one context reference and one outbox row to the Foundation job/scope;
- is claimed only when `event_type = 'foundation.proof.created.v1'` and
  `aggregate_type = 'foundation_test_aggregate'`;
- reauthorizes `foundation.relay.publish` for an exact system relay principal/Space; and
- publishes the typed `FoundationQueueEnvelope`, whose required fields are Foundation event/job,
  exact scope, signed context reference, request ID, and trace carrier.

B1 must not insert product rows into `ops.outbox_events`, loosen its checks/FKs/constants/query
filters, fabricate jobs or context references, reuse `FoundationQueueEnvelope`, change Foundation
roles/grants/queues, or route product notifications through the Foundation repository or relay.
B1.0 instead supplies the additive `ops.product_outbox_events`, dedicated product relay role and
principal, fixed `product_outbox.relay.publish` authorization, and typed
`DomainNotificationEnvelope` defined above.

The B1 event union is exactly `organization.created`, `initiative.created`, `activity.created`,
`activity.capture_added`, `relationship.created`, `relationship.ended`, `content.created`,
`content.revised`, `source_artifact.captured`, `source_artifact.corrected`, and
`source_artifact.tombstoned`. The matching aggregate union is exactly `organization`, `initiative`,
`activity`, `relationship`, `content_item`, and `source_artifact`. Any event/aggregate pair not
allowlisted by the discriminated schema is rejected before insert and again by database constraints.

Create notifications record aggregate version `1`; mutable commands lock the expected version,
increment exactly once, and record that resulting version; source correction records the new
successor at version `1`; source tombstone records the locked artifact's single increment. Event
schema/payload versions are independent from aggregate optimistic versions and never substitute for
them. Tests reject stale commands, wrong type/event pairs, zero/skipped versions, and event versions
that do not equal the committed aggregate.

Canonical product-outbox insertion is required for every B1 domain mutation even when no consumer
exists. B1.0 has no job/context-reference, worker authority, active-consumer, execution receipt, or
consumer/DLQ prerequisite. If publication precedes a consumer, the dedicated SQS Standard
`MessageRetentionPeriod = 86400` no-consumer disposition defined above is mandatory; a redrive policy,
event-source mapping, receive-capable B1.0 principal, and no-op worker are forbidden. Publication is
at-least-once/potentially unordered. Future consumers durably deduplicate by `eventId`, validate full
envelope equality and `aggregateVersion`, establish their own execution context, and reauthorize
their effects.

Wave B1 implementation remains **HOLD** until the bounded B1.0 prerequisite is separately approved,
merged, and evidenced with exact Foundation non-regression tests, and Andrew explicitly lifts this
HOLD. Mutation, `ops.audit_events`, and the canonical product-outbox row must commit atomically. A
later copy/promotion cannot repair a mutation committed without its canonical outbox row. This
plan-safety correction does not authorize B1.0, new roles/grants/relay behavior, migrations, B1
handlers, B3 work, merge, release, or deployment.

## Central authorization additions

Extend the closed `AuthorizationAction` union and `PostgresAuthorizationService`; do not create
package-local role checks.

Minimum actions:

```text
organization.create/read
initiative.create/read
activity.create/read
person.read
relationship.create/end/read
content.create/revise/read
source.capture/correct/tombstone/read
```

Rules are based on live active Membership, policy version, recursive Space access, and direct
relationship authority. Snapshot `roleHints`, requested Space IDs, Person ownership, profile
labels, and request payloads never grant authority.

The first implementation should remain conservative:

- creating an Organization requires `space.create_child` on the Workspace root;
- creating an Initiative requires contributor-or-higher authority on the primary Organization
  Space plus permission to create its child Space;
- creating an Activity or capturing a source requires contributor-or-higher authority in its
  governing Space;
- revising content requires contributor-or-higher authority and version precondition;
- source correction requires contributor-or-higher authority and access to the predecessor;
- tombstoning requires Workspace admin/owner plus a valid retention decision;
- relationships require authority in the mechanically derived governing Space and read access to
  the subject, object, and explicit context;
- service and agent principals remain default-denied for every B1 action unless a later approved
  plan adds one exact-purpose rule.

Denials use stable reason codes and do not disclose unauthorized resource metadata.

`person.read` is centralized because Foundation currently supplies only Workspace-scoped RLS for
`identity.people`; that RLS is a backstop and is not endpoint authorization. B1 does not add a
free-standing Person list/search/detail API. Trusted code may request `person.read` only with an
exact already-loaded use-site proof: the governing Activity for an attendee/owner projection, the
governing Initiative/Organization for an owner/contributor projection, or the mechanically derived
governing resource/context for a Relationship endpoint. The authorization service verifies the
Person and use-site association are in the exact Tenant/Workspace, authorizes the use-site Space,
applies its access class and `dataClassCeiling`, and then permits only that Person projection. An
unreferenced Person ID, a reference through an inaccessible resource, or a cross-scope Person is
the same non-leaking denial. `actorDisplayPersonId`, `owner_person_id`, and being a Relationship
endpoint never grant authority.

Default Person projections contain only `id`, `displayName`, and `isInternal`. `primaryEmail`,
`externalRefs`, employer/title references, membership linkage, and timestamps are excluded from
Activity attendee/owner and Relationship endpoint responses in B1. No route returns raw
`identity.people` rows. Activity GET returns only safe projections for attendees whose individual
`person.read` checks pass; to avoid leaking list size, partial filtering is not allowed for a
single-Activity detail response—an inaccessible attendee causes the same non-leaking resource
denial. Relationship GET/list similarly requires both endpoint projections to pass before the row
is returned; list/count queries filter inaccessible rows in SQL and never expose hidden endpoint
counts.

Authorization/API tests cover safe-field allowlists; cross-Workspace and cross-Tenant Persons;
missing and inaccessible Persons; owner/attendee/Relationship use sites; direct ID, list, and count
enumeration; response/error-shape equivalence; and a Person marked owner without any active
User/Membership authority. Person ownership never changes the decision.

## Minimum manual API and no-integration workflow

Add only the command façades and reads needed for the B1 proof:

```text
POST /v1/organizations
GET  /v1/organizations
GET  /v1/organizations/:organizationId

POST /v1/initiatives
GET  /v1/initiatives/:initiativeId

POST /v1/activities
GET  /v1/activities/:activityId

POST /v1/activities/:activityId/sources
GET  /v1/activities/:activityId/sources
GET  /v1/sources/:sourceArtifactId
```

Correction/tombstone routes may remain command-level test surfaces in B1 if exposing a public route
is not required for the manual gate; their domain behavior and security tests are still required.

The accepted source-capture media in B1 is UTF-8 text for `note`, pasted `transcript`, or `human`.
The server sets `trust_class = untrusted_user_content` and
`source_snapshot_policy = full_snapshot`, and derives immutable `hash_retention_policy` from the
governing retention policy. Uploaded binary files, URLs, voice, email, message, calendar, and
research are rejected as unsupported.

Every mutation requires `Idempotency-Key`. Request bodies contain human input and explicit parent
IDs only. They do not accept Tenant/Workspace/Space ownership, actor/principal, access class,
profile version override, source/chunk hashes, chunk indexes, offsets, provider metadata, deletion
state, hash-retention policy/disposition, or audit fields.

### Gate walkthrough

1. Resolve the deterministic dev/test User and active Membership from server-owned authentication.
2. `POST /v1/organizations` creates a manual Organization and organization child Space.
3. `POST /v1/initiatives` creates an AI Initiative under that Organization using the exact
   Workspace-pinned profile/type/stage.
4. `POST /v1/activities` creates an Engagement Activity using an allowlisted activity template.
5. `POST /v1/activities/:id/sources` captures a pasted note/transcript and creates its artifact,
   chunks, activity link, command/audit record, and canonical product-outbox row in one transaction
   after B1.0 is merged and the HOLD is lifted.
6. Authorized GETs reconstruct the Activity associations and return source metadata/chunks.
7. A second user without the Initiative Space cannot learn the Activity/source existence, title,
   count, hashes, text, or chunks.
8. No integration, model, Claim, or shared-truth mutation participates.

## Expected implementation locations after HOLD lift

Only after B1.0 is separately approved and merged and Andrew explicitly lifts the HOLD, the
implementation wave is expected to touch the existing modular-monolith seams, use the already
approved B1.0 product-outbox contracts, add tests, and produce a result artifact:

- `packages/core-types/src/*` — B1 refs/DTOs and typed command/result contracts;
- `packages/work-graph/src/*` — graph aggregates, invariants, and repositories;
- `packages/content/src/*` — content/source normalization, chunking, and repositories;
- `packages/domain-profiles/src/*` — strict AI Solutions schema/registry;
- `packages/account-operations/src/*` — first-party profile interpretation and command assembly;
- `packages/authorization/src/*` — central B1 action rules;
- `packages/db/src/schema.ts`, migrations, and database/security tests;
- `apps/api/src/*` — minimal controllers/modules/services for the listed routes;
- `packages/testing/src/*` and `tests/*` — fixtures/helpers, architecture, integration, and security
  coverage;
- root scripts only where needed to expose the authoritative B1 gate;
- `README.md` and `docs/status/WAVE_B1_RESULT.md` only during approved implementation/result work.

No production dependency is expected. If implementation proves a dependency is necessary, stop and
document the reason and security/maintenance impact before adding it.

## Implementation sequence after HOLD lift

1. Verify the separately approved B1.0 prerequisite is merged at an exact reviewed SHA and passes its
   real secured command/audit/outbox, no-orphan, relay-lock/revocation-race, SQS Standard/no-consumer,
   and Foundation-isolation gates; otherwise stop on HOLD. Freeze the approved plan/B1.0 SHAs and
   re-prove clean migration/application-role baselines.
2. Add failing profile-schema and core dependency-boundary tests.
3. Implement the strict profile loader/registry and exact Workspace pin resolution.
4. Add migration `0004` work tables with their complete constraints, RLS, grants, policies,
   triggers, and migration/security tests in the same migration.
5. Add Work Graph TypeScript aggregates/repositories and invariant tests.
6. Add failing normalization/chunking golden tests, including Unicode scalar offsets.
7. Add migration `0005` content/source/chunk/activity-source tables with their complete RLS,
   grants, policies, access-class checks, and immutability/correction/tombstone triggers in the same
   migration.
8. Implement Content/Source deterministic helpers and repositories.
9. Add migration `0006` B1-only aggregate/result/generated-child/event-version consistency constraints
   and catalog tests; do not recreate or loosen `0003` command/audit/outbox infrastructure and do not
   defer security for `0004`/`0005` tables.
10. Extend central authorization with B1 actions and negative matrices.
11. Add the fixed creation-only Space helper and its forged-ID, restricted-capability,
    rollback/restore, and pooled-connection cleanup tests before any create handler.
12. Implement the minimal Domain Command Bus handlers and atomic idempotency/audit/product-outbox
    behavior without a duplicate domain-event ledger.
13. Add the minimal API routes through the command bus, with schema validation and non-leaking
    errors.
14. Add correction, concurrent-fork, tombstone, and deletion-reconciliation tests.
15. Add the complete manual no-integration API walkthrough and restricted-Space denial proof.
16. Run the full Foundation gate unchanged, the B1.0 real-table/no-orphan,
    relay-lock/revocation-race, SQS Standard duplicate/no-consumer/isolation gates, then the new B1
    gate, to prove no isolation regression.
17. Write `WAVE_B1_RESULT.md`, obtain independent exact-head review, and stop before B2.

## Test plan

### Unit tests

- strict AI Solutions schema, typed AST, stable keys, reference resolution, and exact pinning;
- unknown/incompatible/unpublished profile failure and no `latest` fallback;
- organization/domain normalization and aggregate invariants;
- Initiative primary-organization and profile key constraints;
- Activity subtype/template/time validation and explicit governing-parent selection with no
  array-order fallback;
- Relationship direction, endpoint allowlist, validity, governing-Space resolution, and no inverse
  duplication, including object fallback for a Person subject and rejection when neither endpoint
  nor context is Space-bearing;
- Content revision optimistic concurrency;
- normalization/chunking golden fixtures, stored pipeline versions, hash reconstruction, and
  full-payload equality on logical-key reuse;
- command schemas, request hashing, stable parent-scoped reservation, idempotent replay,
  mismatched-key conflict, concurrency, rollback, and abandoned-transaction recovery;
- Source correction/tombstone state transitions, including `A → B → tombstone(B)` with no fallback
  to A; both immutable hash-retention policies; mechanically derived dispositions; and hash-free
  audit/product-outbox metadata at capture, correction, and tombstone time for
  `erase_on_tombstone`.

### Migration and database tests

- clean `0001 → 0002 → 0003 → 0004 → 0005 → 0006` apply and deterministic repeat, with `0003`
  independently proving the bounded B1.0 prerequisite before any B1 handler is enabled;
- after each individual migration commit, every table created by that migration already has FORCE
  RLS, exact grants/policies, and its required integrity/immutability/publication-state triggers;
- true migration SHA-256 journal checks and rollback-on-journal-failure behavior;
- exact B1/B1.0 table catalog, constraints, indexes, triggers, and composite foreign keys;
- migration `0003` alone contains the real secured `ops.domain_command_records`, `ops.audit_events`,
  and `ops.product_outbox_events` tables plus command/audit/outbox causation FKs; absent, mismatched,
  and cross-scope command IDs cannot create, claim, or publish an orphan notification and cause zero
  SQS sends;
- migration `0003` grants no application insert, exact command-completion update, or product-relay
  publication authority until every constraint, index, trigger, RLS policy, and catalog assertion has
  installed successfully; catalog tests then prove the application can perform only the one-way
  reserved-to-completed command transition on the listed columns and cannot reopen/delete/mutate
  command identity;
- B1.0 tests use those real forced-RLS ops tables and real roles, roll back transactions or tear down
  the disposable database/resource, never bypass append-only row rules, and contain no lookalike
  test-schema command/audit tables;
- RLS enabled/forced on every B1/B1.0 table;
- app, product-relay, Foundation-relay, and worker roles remain `NOBYPASSRLS` with exact disjoint
  grants;
- the product relay has only scoped `SELECT` plus `UPDATE(id)` lock capability on Tenant, Workspace,
  policy version, service principal, Space, and direct access-relationship rows; catalog tests prove
  scoped permissive `FOR UPDATE` policies plus restrictive `WITH CHECK (false)` no-write guards, no
  other updateable authority column, and no generic query/arbitrary-SQL capability;
- no context sees no rows and cannot write;
- cross-Tenant and cross-Workspace reads/writes fail;
- wrong Space insert/update fails `WITH CHECK`;
- the creation-only Space helper rejects forged/pre-existing/unrelated child IDs, derives and inserts
  exactly one direct `manager` access row for the fixed same-Workspace product-relay principal before
  child scope, exposes no generic relationship/query/authorization capability while switched,
  restores parent scope in `finally`, rolls back all child/access/domain writes on failure, and leaks
  no context after pooled release/reacquire;
- pooled transaction-local context does not leak;
- cross-scope join and Relationship endpoints fail;
- the Relationship trigger derives the Organization Space for a context-free
  `person --account_owner_for--> organization`, rejects a forged `space_id`, rejects a Person
  context, and rejects `person --> person` without a Space-bearing context;
- immutable SourceArtifact/SourceChunk/ContentRevision update/delete attempts fail;
- only the exact tombstone transition is allowed and cannot be reversed;
- `hash_retention_policy` is server-derived and immutable, live hashes are required, tombstone
  disposition is derived, and a caller cannot select a later hash outcome;
- concurrent correction attempts produce one successor;
- source/chunk hashes, normalization/chunking versions, deterministic logical keys, and exact
  full-payload equality are enforced;
- Organization/Initiative retry/failure matrices persist exactly one reservation, child Space,
  aggregate, audit record, and canonical product-outbox event, with no committed `reserved` record;
- `ops.audit_events` contains exact command/causation, action/resource, actor/delegator/agent,
  policy-version, request/trace, and schema-versioned safe-detail fields; it is append-only,
  immutable, forced-RLS, and app-only;
- no `ops.domain_events` ledger exists; tests prove the canonical product outbox plus audit records
  are the only durable event/audit seams and that Throughline does not claim event sourcing;
- `ops.product_outbox_events` enforces typed event/aggregate unions, scope, event/schema and aggregate
  identity/version, immediate real-command causation, safe payload, request/trace, stable duplicate
  identity, atomic rollback, fixed relay authorization/RLS/grants, bounded retries,
  `terminal_failed`/`terminal_unconfirmed`, and exact full-envelope equality on replay;
- every publish transaction locks the claimed outbox row `FOR UPDATE`, locks Tenant, Workspace, policy
  version, product-relay service principal, Space, and the direct access relationship in that exact
  order, then reauthorizes against those locked rows and holds them through SQS send and
  commit/rollback;
- deterministic races prove stale/wrong-owner/wrong-token/wrong-attempt/expired/policy-mismatched claim
  handles deny with zero sends, claim-then-revocation and revocation-first both deny with zero sends/no
  publication update, relay-first blocks revocation until commit/rollback, timeout/rollback releases
  every lock, and the fixed order has no deadlock;
- the dedicated SQS Standard queue reads back `MessageRetentionPeriod = 86400`, has no redrive,
  consumer, event-source mapping, or no-op worker, and grants no B1.0 principal `ReceiveMessage`,
  `DeleteMessage`, or `ChangeMessageVisibility`;
- SQS sends carry the stable body `eventId` plus allowlisted `event_id` attribute, never
  `MessageDeduplicationId`/`MessageGroupId`; accepted-send/marker-rollback/retry tests prove identical
  logical envelopes may have distinct broker `MessageId` values, `published_at` means observed broker
  acknowledgement plus committed marker, publication is at-least-once/potentially unordered, and
  zero product effect occurs;
- retention tests describe deletion as broker-managed/eventual and use a documented provider clock
  seam or supported shortened disposable retention rather than claiming exact wall-clock deletion;
  and
- Foundation `ops.outbox_events` checks/FKs/grants, constants, filters, envelope, roles, relay path,
  signed context flow, queue resources, and end-to-end proof remain exact and unchanged.

### Authorization and API security tests

- all B1 actions default deny for missing/expired/stale/forged context;
- suspended Membership, archived Space, inactive policy, Person-only owner, and unapproved
  service/agent principal deny;
- User B cannot infer a restricted Activity/source through ID, list, count, title, hash, chunk,
  error, or timing-sensitive alternate response shape;
- `dataClassCeiling` and permitted-Space checks cover the full ADR-018 lattice for source direct
  reads, history/current resolution, Activity-source link/list/count, capture, and correction;
- a broader Activity Space cannot reveal a more restrictive source, and a broader Relationship
  context cannot reveal a restricted endpoint;
- `person.read` safe projections and exact use-site checks reject cross-scope, inaccessible,
  unreferenced, enumerated, and Person-owner-only cases without leaking ID/list/count differences;
- caller cannot forge scope, access class, profile version, owner authority, hashes, offsets,
  hash-retention policy/disposition, tombstone fields, or audit identity/detail;
- a context-free `person --account_owner_for--> organization` requires relationship authority in
  the Organization Space and readable Person and Organization endpoints;
- `person --> person` is denied without a Space-bearing context, and with one is allowed only when
  the actor can read both Persons and the context and has relationship authority in the context
  Space;
- a missing, inaccessible, cross-scope, or non-Space-bearing explicit context is denied without
  leaking endpoint or context metadata;
- route handlers contain no direct table mutation path;
- source text remains untrusted data and is never treated as a command/instruction;
- no source path exposes a write-capable tool or external action.

### Integration and gate tests

- exact manual Organization → Initiative → Engagement → Source workflow with no integration;
- atomic Space/aggregate/audit/product-outbox creation rollback on every injected failure;
- atomic SourceArtifact/chunks/activity link/command/audit/product-outbox rollback on every injected
  failure;
- idempotent retry returns one aggregate/source, one audit event, and one canonical product-outbox
  event; Organization and Initiative create retries cannot duplicate child Spaces or aggregates;
- the observed creation-scope sequence is only authorized parent → helper-created direct child →
  parent, forged/unrelated IDs and unrelated work while switched fail, and pooled context is clean;
- API/repository responses reconstruct normalized associations correctly;
- correction resolves the terminal leaf but preserves separately authorized history;
- tombstoning the B leaf of `A → B` returns tombstone/no current evidence and never A;
- tombstone removes text/chunks and writes policy-conditional safe invalidation metadata, proving
  `retain` may preserve allowlisted hashes while `erase_on_tombstone` never copied hashes into
  append-only audit/product-outbox history and atomically nulls the live artifact hashes;
- existing `pnpm test:foundation` remains passing with zero authoritative skips, along with the B1.0
  Foundation-isolation and no-consumer publication regressions;
- core dependency test continues preventing Core imports from Account Operations, profiles, and
  adapters.

The existing transcript fixtures are not model-evaluation inputs in B1. At least one is used only as
opaque pasted text to prove capture, Unicode-safe deterministic chunks, untrusted-data handling,
and no external action.

## Required verification commands

Run from a clean approved implementation worktree with disposable PostgreSQL/LocalStack resources
and the repository's fail-closed environment preflight:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:security
pnpm test:foundation
pnpm test:b1
git diff --check
git status --short
```

`test:b1` may be added during implementation, but it must fail closed when required owner/app test
DSNs or safe disposable resource names are missing. Tests cannot convert missing infrastructure
into skips in the authoritative gate.

The planning artifact itself is verified with repository formatting/check commands and a docs-only
diff; it does not run or claim the future B1 implementation gate.

## Acceptance gate

B1 is complete only when all of the following are evidenced from a clean database:

- a manual Organization, Initiative, Engagement Activity, and text SourceArtifact can be created
  without an integration;
- Engagement is demonstrably an Activity subtype, not a parallel model;
- every multi-parent Activity has one explicit deterministic governing Initiative or Organization;
- every B1 row is Tenant/Workspace/Space bound with forced RLS and central authorization;
- association and Relationship direction/endpoints are mechanically constrained, including the
  context → subject → object governing-Space rule and Person-only rejection without an authorized
  Space-bearing context;
- the AI Solutions profile validates at build/startup and exact Workspace pinning fails closed;
- SourceArtifacts and SourceChunks are immutable outside the exact governed tombstone transition;
- normalization/chunking versions, chunk logical identity, full-payload reuse checks, hashes, and
  Unicode-scalar offsets are deterministic;
- correction chains cannot fork/cycle and retain authorized history;
- terminal-leaf resolution never falls back through a tombstone;
- tombstoning removes source content/chunks and records only policy-permitted reconciliation/audit
  evidence; immutable `retain` preserves allowlisted hashes, while `erase_on_tombstone` never copies
  them to append-only audit/product-outbox history and atomically nulls the live row hashes;
- source and Relationship visibility obey ADR-018 and `dataClassCeiling` at direct, link, list, and
  count surfaces;
- Person projections require centralized `person.read`, are field-safe, non-enumerable across
  inaccessible scope, and never convert Person ownership into authority;
- User B cannot infer restricted source existence or content;
- manual API writes use typed authorized commands and stable-scope idempotency, and atomically write
  immutable `ops.audit_events` plus B1.0 canonical product-outbox rows; no duplicate
  `ops.domain_events` ledger exists and no B1 event enters or weakens the Foundation proof path;
- the fixed creation helper admits only authorized parent → same-transaction direct child → parent,
  exposes no unrelated activity while switched, and proves rollback and pooled-context cleanup;
- no Claim, AcceptedFact, DerivedView, ChangeSet, model, integration, or production UI is added;
- the full Foundation gate, B1.0 real-table/no-orphan, relay-lock/revocation-race, SQS Standard
  duplicate/no-consumer/isolation regressions, and B1 security gate pass without authoritative skips;
- an independent exact-head reviewer returns PASS.

## Canonical boundaries and unresolved implementation gate

Three implementation ambiguities are intentionally closed narrowly:

1. The Build Spec gives `organization.customer-of-workspace` as prose while the canonical
   `Relationship` endpoint type is `EntityKind`, which does not include Workspace. B1 follows the
   normative type and does **not** implement Workspace as a Relationship endpoint. Customer/partner
   semantics needed now use Organization/Initiative associations or allowed EntityKind endpoints.
   Supporting a literal Workspace endpoint later requires an explicit canonical type decision.
2. The kickoff schedules the full Domain Command Bus in B3, while accepted ADR-019 already requires
   every human mutation to use typed authorized commands. B1 proposes only the minimal façade and
   fixed handlers needed for its own manual writes. ChangeSets, approvals, receipts, compensation,
   and agent operation unions remain B3, and no façade/handler ships while this HOLD remains.
3. ADR-019, Build Spec §14.1, and Implementation Kickoff ticket 9 require canonical transactional
   outbox emission with aggregate version. The merged Foundation proof relay is too exact-purpose to
   reuse safely. The bounded B1.0 prerequisite above resolves that seam additively without beginning
   B3, inventing job/delegated-context/worker semantics, or adding a duplicate event ledger. It is a
   separate approval/merge prerequisite, not permission to loosen or fabricate inputs for the
   Foundation path.

The first two boundaries require no canonical-document or accepted-ADR change. The third keeps B1
implementation on HOLD until B1.0 is separately approved and merged and Andrew explicitly lifts the
HOLD.

## Stop conditions

Stop and return **HOLD** before implementation or further mutation if any of these occurs:

1. A required behavior cannot be implemented without changing a locked architecture decision,
   canonical kickoff document, or accepted ADR.
2. Product requirements demand Workspace as a generic Relationship endpoint before the canonical
   endpoint type is resolved.
3. Deterministic chunks are interpreted as UUIDv5/content-hash primary keys, conflicting with the
   canonical UUIDv7 ID rule.
4. The implementation would make Engagement a separate aggregate/table rather than Activity
   subtype.
5. Organization/Initiative/Activity/source creation cannot stay inside central `can()`, forced RLS,
   typed commands, and transaction-local scope.
6. Any route, adapter, model, or worker would write product tables directly.
7. Source capture requires a new production dependency, binary extraction stack, connector,
   write-capable worker, or infrastructure service.
8. Correction or deletion cannot preserve required audit linkage or reconcile downstream support
   safely.
9. Profile loading requires executable expressions, generic extensions, automatic upgrades, or a
   Core dependency on Account Operations/profile packages.
10. Existing Foundation RLS/role/context guarantees would be weakened or their authoritative gate
    would be skipped.
11. The manual gate expands into B2 truth, B3 governed runtime, B4 extraction/review, or C-wave
    integration/UI work.
12. The implementation worktree is not based on the exact approved SHA or contains unrelated user
    changes that cannot be preserved safely.
13. The separately approved B1.0 prerequisite is absent or does not fully define migration `0003`'s
    real secured command/audit/product-outbox tables, immediate causation FKs, constraints-before-
    grants order, no-orphan proof, typed row/envelope, atomic insertion, fixed relay
    authorization/row locks/RLS/grants/retries/failure behavior, SQS Standard at-least-once contract,
    bounded no-consumer disposition, and exact Foundation-isolation regressions.
14. Any proposal fabricates a job/context reference, adds worker execution authority or a no-op
    worker, requires consumer/DLQ lifecycle, reuses `FoundationQueueEnvelope`, changes Foundation
    outbox checks/FKs/constants/filters/envelope/roles/relay path, weakens Foundation role isolation,
    or grants any Foundation relay/worker access to the product outbox or B1 tables.
15. Any handler/repository issues a raw Space-context change, the helper accepts a caller or existing
    unrelated child ID, fails to derive exactly one direct `manager` access row for the fixed
    same-Workspace product-relay principal, exposes generic relationship write authority, permits
    unrelated authorization/repository work while switched, fails to restore the parent in `finally`,
    or lacks rollback, forged-ID, leaked-context, and pooled-connection cleanup proof.
16. Migration `0003` leaves generic command/audit tables or outbox causation security to `0006`,
    omits the narrow one-way command-completion grant/transition, grants insert/publication before all
    constraints exist, permits an orphan notification, or substitutes lookalike test-schema
    command/audit tables for the real secured ops tables.
17. Product publication can send outside the exact row-lock/reauthorization transaction, does not hold
    live authority inputs in deterministic order, grants broader than `UPDATE(id)` lock capability,
    claims FIFO/exactly-once semantics, uses SQS deduplication/group IDs, grants receive/delete/
    visibility authority, or treats an ambiguous send as proof of no publication.

## Approval requested

No B1 implementation approval is requested while this plan is on HOLD. Andrew must separately
approve and merge the bounded B1.0 canonical product-outbox prerequisite and then explicitly lift
this HOLD before any B1 command handler or migration may ship. Approval of this plan-safety
correction alone does not authorize B1.0, B1 implementation, B2, B3, deployment,
canonical-document edits, accepted-ADR changes, integrations, model work, production UI, merge, or
release.
