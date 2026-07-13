# Wave B1 Plan — Work Graph and Source Capture

> **Plan only.** Do not implement Wave B1 until Andrew explicitly approves this plan. This
> artifact does not authorize B2 truth-ledger work, model extraction, ChangeSets, integrations,
> product UI, deployment, or changes to canonical kickoff documents or accepted ADRs.

- **Date:** 2026-07-13
- **Authorized planning base:** `f36804b0f54d659fb4c59e3a5a887189d2d38801`
- **Planning branch:** `throughline/impl/t_948b364f-b1-work-graph-source-capture-plan`
- **Wave:** B1 — Work graph and source capture
- **Planning verdict:** **PASS** — no canonical-document or accepted-ADR change is required for
  the bounded plan below

## Goal and gate

Implement the smallest manual Account Operations graph and evidence-capture path on top of the
closed Wave A isolation foundation:

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

### In scope

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
11. Reviewed SQL migrations, Drizzle mirrors, RLS/privilege tests, audit/outbox records, and
    observability for the new path.

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
- `work.activities` owns one governing Space and stores `subtype` plus optional
  `profile_template_key`.
- Account Operations calls an Activity an Engagement only when `profile_template_key` resolves to
  an `activityTemplates[].key` in the Workspace-pinned AI Solutions profile. For B1,
  `subtype = profile_template_key` so Core retains a provider/profile-neutral subtype string.
- A manually created Initiative has exactly one `primary` Organization association in B1. Partner
  or supporting organizations may be associated without changing ownership.
- The Initiative Space is a child of the primary Organization Space. An Activity related to an
  Initiative is governed by that Initiative Space. An organization-only Activity is governed by
  the Organization Space.
- An Activity may link additional Organizations or Initiatives in the same Workspace, but those
  links do not move its governing Space. Creating a cross-Space link requires current read access
  to every endpoint and contributor-or-higher authority in the Activity Space.
- Organization/Initiative/Activity owner fields remain graph `Person` references. Authorization
  continues to use User/Membership/ServicePrincipal/AgentPrincipal only; a Person never grants
  authority.

The creation invariants are:

```text
Organization command
  = organization row + child Space + outbox event

Initiative command
  = initiative row + child Space + primary organization link + outbox event

Activity command
  = activity row + normalized association rows + outbox event
```

Each group commits atomically. A partially created aggregate/Space pair is invalid.

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

### Migration 0003 — work graph

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
  timestamps, `owner_person_id`, timestamps, `version`.
- Relationship: `id`, scope, typed subject/object/context columns, predicate, optional
  `supporting_fact_id` reserved null until B2, validity interval, timestamps, `version`.

Important constraints:

- `UNIQUE (tenant_id, workspace_id, id)` and
  `UNIQUE (tenant_id, workspace_id, space_id, id)` on aggregate tables for composite foreign keys;
- domains are canonical lowercase IDNA ASCII host names, unique per Organization;
- exactly one active `primary` organization association per Initiative;
- Initiative/Activity profile keys are checked by the application against the exact Workspace pin;
- Activity time constraints reject `ends_at < starts_at`;
- relationship subject cannot equal object for an identical kind unless the predicate is explicitly
  allowlisted as reflexive (none are allowlisted in B1);
- relationship validity rejects `valid_to <= valid_from`;
- all composite foreign keys preserve Tenant/Workspace identity; join rows also preserve the
  governing Space of their parent aggregate.

Organization and Initiative Space creation uses existing `access.spaces`; B1 does not create a
parallel containment tree.

### Migration 0004 — content, sources, and chunks

Create schema `content` and:

- `content.content_items`;
- `content.content_revisions`;
- `content.source_artifacts`;
- `content.source_chunks`;
- `work.activity_sources` after the source table exists.

`content_items` contains mutable metadata and `current_revision`. `content_revisions` has a unique
logical key `(tenant_id, workspace_id, content_item_id, revision_number)` and is insert-only.

`source_artifacts` includes the canonical source fields plus:

- `normalization_version` (B1 writes only `source-normalization.v1`);
- `normalized_content_hash` for the full normalized text used to create chunks;
- optional `origin_content_item_id` and `origin_content_revision`;
- `supersedes_source_id`;
- tombstone fields `deleted_at`, `deletion_reason`, and `deletion_policy_ref`.

`source_chunks` includes:

- UUIDv7 row `id`;
- exact scope and `source_artifact_id`;
- `normalization_version`;
- zero-based `chunk_index`;
- normalized source-global `[start_offset, end_offset)`;
- `normalized_text`;
- SHA-256 `content_hash`;
- inherited `access_class`;
- `created_at`.

The deterministic logical identity is unique on:

```text
(tenant_id, workspace_id, source_artifact_id, normalization_version, chunk_index)
```

The persisted row ID remains UUIDv7, preserving the canonical all-ID rule. A retry locks/looks up
the logical key and returns the already persisted UUIDv7; it never creates a UUIDv5 or content-hash
primary key.

### Migration 0005 — B1 command idempotency, RLS, privileges, and immutability

Add `ops.domain_command_records` rather than overloading Foundation worker
`ops.idempotency_records`. It contains exact Tenant/Workspace/Space scope, command kind,
caller-supplied idempotency key, canonical request hash, state, result reference, safe response
snapshot, actor/delegation references, timestamps, and a unique key on
`(tenant_id, workspace_id, space_id, command_kind, idempotency_key)`.

The same migration adds:

- RLS and FORCE RLS for every B1 table;
- explicit grants to the existing `throughline_app` role only;
- no B1 product-table grants to `throughline_relay` or `throughline_worker`;
- immutable-row triggers for Content revisions, SourceArtifacts, and SourceChunks;
- fixed endpoint-integrity and governing-Space triggers for Relationships;
- source correction-chain constraints; and
- indexes required by the manual workflow.

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
| Domain command records | required | required | target/parent Space |

For each table:

1. `tenant_id`, `workspace_id`, and `space_id` are non-null.
2. A composite foreign key proves the Space belongs to the same Tenant and Workspace.
3. Cross-table foreign keys include Tenant and Workspace; parent-owned children additionally bind
   the parent's governing Space.
4. RLS is both enabled and forced.
5. `USING` restricts app-role visibility to current Tenant and Workspace.
6. `WITH CHECK` additionally requires the command's exact transaction-local `app.space_id` for
   inserts/updates. Every B1 mutation therefore runs with exactly one requested Space.
   Organization/Initiative creation generates the child Space UUID before the transaction and uses
   that target as `app.space_id`; authorization still locks and evaluates the existing parent Space
   before either the child Space or aggregate is inserted.
7. Space-level read authorization remains the canonical centralized `can()` plus explicit
   permitted-Space repository predicate. RLS is the Tenant/Workspace backstop; it is not falsely
   presented as a replacement for recursive Space authorization.
8. Repositories accept a `TenantDbTransaction`; none acquire a pool or execute outside
   `withTenantTransaction`.
9. The application asserts the expected `NOBYPASSRLS` role at the boundary before authorization and
   mutation, following the existing Foundation pattern.
10. Missing, empty, expired, cross-scope, archived-Space, suspended-Membership, or inactive-policy
    context fails closed before returning resource existence, title, count, or source text.

No request body or header supplies trusted Tenant, Workspace, Space, actor, access class, profile
version, hash, chunk identity, or offsets. Trusted server code derives those fields from current
context, live rows, and the pinned profile.

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
- normalization version.

The only mutation exception is a governed retention/lawful-erasure transition. The fixed command
handler may atomically:

1. lock the current non-deleted SourceArtifact;
2. verify policy/authority and an idempotency key;
3. irreversibly set tombstone fields;
4. clear `immutable_text` and `object_key` where policy requires erasure;
5. delete/cryptographically erase SourceChunks and stored objects;
6. emit `source_artifact.tombstoned` with identifiers/hashes/reason/policy but no erased content;
7. record an append-only audit event and domain-command result.

A trigger rejects every other update and all physical deletion of the SourceArtifact row. A
tombstone can never be restored to live content.

The `content_hash` is SHA-256 over the exact captured UTF-8 bytes retained for the artifact.
`normalized_content_hash` is SHA-256 over the UTF-8 encoding of the v1 normalized text. Neither is
accepted from the client.

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
- only the current leaf may be corrected;
- a tombstoned source cannot be used as a readable correction input, though its tombstone may
  remain in a chain;
- the command locks the predecessor and checks for an existing successor, preventing concurrent
  forks;
- cycles and self-supersession are rejected;
- the new source's access class is no less restrictive than its predecessor and governing Space;
- reads asking for current evidence resolve to the latest non-tombstoned leaf while history/audit
  reads may expose authorized predecessors.

Correction emits `source_artifact.corrected` with both IDs and safe hashes. It does not revoke a
Claim in B1 because claims do not yet exist.

## Retention tombstones and deletion reconciliation

B1 implements the source-side contract and no more:

- source body/chunks/object are removed or cryptographically erased as policy requires;
- the non-sensitive SourceArtifact tombstone, content hashes, capture/correction linkage,
  timestamps, actor, reason, policy reference, audit event, and outbox event remain only where
  policy permits;
- normal source reads return a non-leaking tombstone state and never return erased content;
- ContentItem deletion is a separate command and does not imply evidence deletion;
- source correction is not used as a substitute for lawful deletion.

Because B1 has no Claim, AcceptedFact, embedding, citation, or DerivedView table, the B1
reconciliation transaction proves there are no such local dependents and completes source/chunk
cleanup plus invalidation event emission. Before B2 enables any downstream support, its migration
and command handlers must consume this contract and atomically revoke, redact, revalidate, delete,
or invalidate all affected records. Once those tables exist, tombstoning must fail closed unless
the downstream reconciliation handler is installed and succeeds in the same governed workflow.

Required event metadata is Tenant/Workspace/Space, source ID, predecessor/successor IDs where
applicable, prior hashes, deletion reason category, policy reference, causation/command ID, actor,
and trace ID. Raw source text and erased object keys do not enter queue messages, logs, or audit
detail.

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

Accepted ADR-019 applies now even though the full governed ChangeSet runtime is B3. B1 therefore
implements a narrow typed `DomainCommandBus` façade and fixed handlers for human-originated B1
commands only:

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

This is not AgentRun, ChangeSet, approval, or a generic command framework. Each handler:

1. parses a discriminated Zod payload;
2. resolves trusted scope/profile/access values server-side;
3. executes current `can()` in the same transaction immediately before mutation;
4. checks optimistic preconditions where updating mutable state;
5. enforces a stable idempotency key and canonical request hash;
6. writes aggregate state, audit data, and the existing transactional outbox shape atomically;
7. returns a typed result with no unrestricted repository or SQL callback.

A reused idempotency key with an identical request returns the stored result. Reuse with a different
request hash returns conflict. Human API handlers never write B1 tables directly.

The existing outbox/context-reference infrastructure is extended rather than replaced. B1 event
types include `organization.created`, `initiative.created`, `activity.created`,
`activity.capture_added`, `relationship.created`, `relationship.ended`, `content.created`,
`content.revised`, `source_artifact.corrected`, and `source_artifact.tombstoned`. B1 adds no model
or write-capable worker consumer.

## Central authorization additions

Extend the closed `AuthorizationAction` union and `PostgresAuthorizationService`; do not create
package-local role checks.

Minimum actions:

```text
organization.create/read
initiative.create/read
activity.create/read
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
`source_snapshot_policy = full_snapshot`. Uploaded binary files, URLs, voice, email, message,
calendar, and research are rejected as unsupported.

Every mutation requires `Idempotency-Key`. Request bodies contain human input and explicit parent
IDs only. They do not accept Tenant/Workspace/Space ownership, actor/principal, access class,
profile version override, source/chunk hashes, chunk indexes, offsets, provider metadata, deletion
state, or audit fields.

### Gate walkthrough

1. Resolve the deterministic dev/test User and active Membership from server-owned authentication.
2. `POST /v1/organizations` creates a manual Organization and organization child Space.
3. `POST /v1/initiatives` creates an AI Initiative under that Organization using the exact
   Workspace-pinned profile/type/stage.
4. `POST /v1/activities` creates an Engagement Activity using an allowlisted activity template.
5. `POST /v1/activities/:id/sources` captures a pasted note/transcript, creates its artifact,
   chunks, activity link, command/audit record, and outbox event in one transaction.
6. Authorized GETs reconstruct the Activity associations and return source metadata/chunks.
7. A second user without the Initiative Space cannot learn the Activity/source existence, title,
   count, hashes, text, or chunks.
8. No integration, model, Claim, or shared-truth mutation participates.

## Expected implementation locations after approval

The implementation wave is expected to touch only the existing modular-monolith seams plus new
tests and a result artifact:

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

## Implementation sequence

1. Freeze the approved plan SHA and re-prove clean migration/application-role baselines.
2. Add failing profile-schema and core dependency-boundary tests.
3. Implement the strict profile loader/registry and exact Workspace pin resolution.
4. Add migration `0003` work tables, constraints, RLS, grants, and migration/security tests.
5. Add Work Graph TypeScript aggregates/repositories and invariant tests.
6. Add failing normalization/chunking golden tests, including Unicode scalar offsets.
7. Add migration `0004` content/source/chunk/activity-source tables and immutability constraints.
8. Implement Content/Source deterministic helpers and repositories.
9. Add migration `0005` command records, remaining policies/grants/triggers, and catalog tests.
10. Extend central authorization with B1 actions and negative matrices.
11. Implement the minimal Domain Command Bus handlers and idempotency/outbox/audit behavior.
12. Add the minimal API routes through the command bus, with schema validation and non-leaking
    errors.
13. Add correction, concurrent-fork, tombstone, and deletion-reconciliation tests.
14. Add the complete manual no-integration API walkthrough and restricted-Space denial proof.
15. Run the full Foundation gate unchanged, then the new B1 gate, to prove no isolation regression.
16. Write `WAVE_B1_RESULT.md`, obtain independent exact-head review, and stop before B2.

## Test plan

### Unit tests

- strict AI Solutions schema, typed AST, stable keys, reference resolution, and exact pinning;
- unknown/incompatible/unpublished profile failure and no `latest` fallback;
- organization/domain normalization and aggregate invariants;
- Initiative primary-organization and profile key constraints;
- Activity subtype/template/time validation;
- Relationship direction, endpoint allowlist, validity, governing-Space resolution, and no inverse
  duplication, including object fallback for a Person subject and rejection when neither endpoint
  nor context is Space-bearing;
- Content revision optimistic concurrency;
- normalization/chunking golden fixtures and hash reconstruction;
- command schemas, request hashing, idempotent replay, and mismatched-key conflict;
- Source correction/tombstone state transitions.

### Migration and database tests

- clean `0001 → 0002 → 0003 → 0004 → 0005` apply and deterministic repeat;
- true migration SHA-256 journal checks and rollback-on-journal-failure behavior;
- exact B1 table catalog, constraints, indexes, triggers, and composite foreign keys;
- RLS enabled/forced on every B1 table;
- app/relay/worker roles remain `NOBYPASSRLS` with exact grants;
- no context sees no rows and cannot write;
- cross-Tenant and cross-Workspace reads/writes fail;
- wrong Space insert/update fails `WITH CHECK`;
- pooled `SET LOCAL` context does not leak;
- cross-scope join and Relationship endpoints fail;
- the Relationship trigger derives the Organization Space for a context-free
  `person --account_owner_for--> organization`, rejects a forged `space_id`, rejects a Person
  context, and rejects `person --> person` without a Space-bearing context;
- immutable SourceArtifact/SourceChunk/ContentRevision update/delete attempts fail;
- only the exact tombstone transition is allowed and cannot be reversed;
- concurrent correction attempts produce one successor;
- source/chunk hashes and deterministic logical keys are enforced.

### Authorization and API security tests

- all B1 actions default deny for missing/expired/stale/forged context;
- suspended Membership, archived Space, inactive policy, Person-only owner, and unapproved
  service/agent principal deny;
- User B cannot infer a restricted Activity/source through ID, list, count, title, hash, chunk,
  error, or timing-sensitive alternate response shape;
- caller cannot forge scope, access class, profile version, owner authority, hashes, offsets, or
  tombstone fields;
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
- atomic Space/aggregate creation rollback on every injected failure;
- atomic SourceArtifact/chunks/activity link/command/audit/outbox rollback on every injected
  failure;
- idempotent retry returns one aggregate/source and one logical event;
- API/repository responses reconstruct normalized associations correctly;
- correction resolves the current leaf but preserves authorized history;
- tombstone removes text/chunks and emits safe invalidation metadata;
- existing `pnpm test:foundation` remains passing with zero authoritative skips;
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
- every B1 row is Tenant/Workspace/Space bound with forced RLS and central authorization;
- association and Relationship direction/endpoints are mechanically constrained, including the
  context → subject → object governing-Space rule and Person-only rejection without an authorized
  Space-bearing context;
- the AI Solutions profile validates at build/startup and exact Workspace pinning fails closed;
- SourceArtifacts and SourceChunks are immutable outside the exact governed tombstone transition;
- normalization, chunk logical identity, hashes, and Unicode-scalar offsets are deterministic;
- correction chains cannot fork/cycle and retain authorized history;
- tombstoning removes source content/chunks and emits safe reconciliation/audit evidence;
- User B cannot infer restricted source existence or content;
- manual API writes use typed authorized commands, idempotency, audit, and transactional outbox;
- no Claim, AcceptedFact, DerivedView, ChangeSet, model, integration, or production UI is added;
- the full Foundation gate and B1 security gate pass without authoritative skips;
- an independent exact-head reviewer returns PASS.

## Canonical ambiguities resolved without architecture change

Two implementation ambiguities are intentionally closed narrowly:

1. The Build Spec gives `organization.customer-of-workspace` as prose while the canonical
   `Relationship` endpoint type is `EntityKind`, which does not include Workspace. B1 follows the
   normative type and does **not** implement Workspace as a Relationship endpoint. Customer/partner
   semantics needed now use Organization/Initiative associations or allowed EntityKind endpoints.
   Supporting a literal Workspace endpoint later requires an explicit canonical type decision.
2. The kickoff schedules the full Domain Command Bus in B3, while accepted ADR-019 already requires
   every human mutation to use typed authorized commands. B1 implements only the minimal façade and
   fixed handlers needed for its own manual writes. ChangeSets, approvals, receipts, compensation,
   and agent operation unions remain B3.

Neither ambiguity requires changing a canonical document or accepted ADR for this bounded wave.

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

## Approval requested

Andrew's approval should authorize only the bounded B1 implementation described here. Approval does
not authorize B2, deployment, canonical-document edits, accepted-ADR changes, integrations, model
work, production UI, merge, or release.
