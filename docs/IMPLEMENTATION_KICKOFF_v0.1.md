# Throughline Implementation Kickoff v0.1

**Product:** Throughline  
**Category:** AI-native Work Operating System  
**Architectural identity:** Active, trusted organizational memory  
**Operating engine:** Governed agentic runtime  
**First product:** Account & Partner Operations  
**First loop:** Engagement → Memory → Action

## 1. Decision

Architecture review is closed. The implementation baseline is **Throughline Phase 0/1 Build Specification v0.1.1**.

No further conceptual review should block coding. New questions are handled as:

1. an implementation detail resolved inside the existing architecture;
2. an ADR when the choice has lasting consequences; or
3. a deferred item when it is outside the Phase 0 exit criteria.

The first build does **not** attempt the whole Work OS. It proves the smallest complete expression of the moat:

```text
Messy source
  → verified claim
  → governed ChangeSet
  → approved fact
  → cited current view
```

## 2. First implementation target

Build a standalone trust loop before making any external provider a dependency.

### The first executable demo

1. A user signs in and belongs to one Tenant, Workspace, and Space.
2. The user manually creates an Organization, Initiative, and Engagement.
3. The user pastes a realistic engagement note or transcript.
4. Throughline stores it as an immutable SourceArtifact and trusted SourceChunks.
5. The extraction skill proposes claims, decisions, tasks, commitments, and use cases.
6. Trusted server code verifies every cited span and independently resolves entities, dates, conflicts, access class, impact, and approval route.
7. The user reviews one calm ChangeSet batch.
8. Approved operations pass through the Domain Command Bus.
9. Throughline records AcceptedFacts and ExecutionReceipts.
10. The Organization and Initiative views regenerate from current, permitted facts with citations.
11. A second user without access to a restricted child Space cannot infer its content through search, summary, Pulse, citations, titles, or counts.

This demo is the first product proof. Account Research MCP comes immediately afterward.

## 3. Build sequence

### Wave A — Foundation and isolation

**A1. Repository and delivery skeleton**

- Create a dedicated `throughline` repository.
- Initialize the pnpm/Turborepo monorepo.
- Add Next.js, NestJS/Fastify, agent worker, connector worker, and outbox relay applications.
- Add formatting, linting, unit tests, dependency-boundary tests, migration checks, and CI.
- Add local PostgreSQL/pgvector, S3-compatible storage, and SQS-compatible queue services.
- Establish OpenTelemetry trace propagation across API, outbox, and workers.

**Gate:** one traced request commits a row, emits an outbox event, and is processed by a worker.

**A2. Tenancy, identity, and authorization**

- Implement Tenant, Workspace, recursive Space, User, Person, Membership, and AgentPrincipal.
- Implement the central `can(actor, action, resource, context)` interface.
- Add PostgreSQL RLS with transaction-scoped `SET LOCAL` context.
- Separate authenticated principals from Person graph records.
- Add cross-tenant, stale-context, and principal-confusion tests.

**Gate:** default-deny isolation passes across API, SQL, queue, cache key, object key, and worker execution.

### Wave B — The moat

**B1. Work graph and source capture**

- Implement Organization, Initiative, Activity/Engagement, Relationship, and ContentItem.
- Implement append-only SourceArtifact, SourceChunk, correction links, retention tombstones, and deletion reconciliation.
- Load and validate the AI Solutions Domain Profile.
- Keep Account Operations as first-party code; do not build a generic pack runtime.

**Gate:** a user can manually create the account workflow and capture a source without any integration.

**B2. Truth ledger**

- Implement Claim, AcceptedFact, conflict groups, supersession, revocation, and DerivedViewSnapshot.
- Enforce monotonic access-class propagation.
- Implement verified source spans and reject fabricated chunk IDs, offsets, and excerpts.
- Implement permission-aware revision hashes and regenerate-on-read behavior.

**Gate:** a manually proposed claim can be accepted, superseded, revoked, and reflected in a newly generated cited summary.

**B3. Governed ChangeSet runtime**

- Implement AgentRun and Skill registry.
- Implement the untrusted-ingestion and trusted-action planes as separate execution permissions.
- Implement discriminated ProposedOperation schemas.
- Implement deterministic impact classification and approval routing.
- Implement ChangeSet review, escalation, Domain Command Bus, atomic groups, idempotency, ExecutionReceipts, verification, and compensation.
- Route human writes through the same command path.

**Gate:** no model, API handler, or adapter can mutate shared truth or domain state outside the policy and command path.

**B4. Extraction and review UX**

- Implement `engagement.extract_changes.v1` against trusted SourceChunks.
- Preserve raw and normalized date interpretations.
- Allow only context-listed entity references; retain unresolved candidates.
- Restrict newly extracted use cases to `discovered` or `proposed`.
- Build transcript-scale fixtures producing 30–50 proposals.
- Build the three-section review experience: Needs Attention, Ready to Accept, Needs Another Approver.

**Gate:** users can complete realistic batches without opening every routine item, while every consequential item remains visible and source-verifiable.

### Wave C — Modularity and usable product

**C1. Account Research MCP**

- Implement the adapter registry and Capability Broker.
- Implement the read-only AccountIntelligenceProvider contract.
- Build the Account Research Builder adapter and a deliberately simple mock adapter.
- Map provider results to SourceArtifacts and provider-attributed Claims only.
- Validate server identity, authorization, provenance, and failure isolation.

**Gate:** both adapters pass the same contract and neither can create AcceptedFacts directly.

**C2. Retrieval and derivation**

- Add PostgreSQL lexical search and exact pgvector search within authorized Spaces.
- Keep restricted material in restricted child Spaces or exclude it from semantic indexing.
- Add permission-aware Organization and Initiative summaries.
- Add the asymmetric-access and permission-tightening tests.

**Gate:** inaccessible material has no detectable influence on retrieval or derived output.

**C3. Daily-use shell**

- Build Today, Organizations, Initiative, Engagement Review, and minimal Pulse.
- Add tasks, commitments, decisions, follow-up drafts, and one recommended next action.
- Keep external communication draft-only.
- Instrument accept/edit/reject, review duration, citation opens, errors, and cost.

**Gate:** the scripted Phase 0 demonstration succeeds from a clean environment.

## 4. First ten implementation tickets

1. Initialize monorepo and dependency-boundary enforcement.
2. Add PostgreSQL, pgvector, migration tooling, and transaction wrapper.
3. Implement Tenant, Workspace, Space, User, Person, Membership, and RLS.
4. Implement signed asynchronous SecurityContext references and live reauthorization.
5. Implement Organization, Initiative, Activity, and manual source capture.
6. Implement SourceChunk generation and mechanically verified source spans.
7. Implement Claim, AcceptedFact, supersession, and access-class propagation.
8. Implement typed ChangeSet operations, deterministic impact policy, and approval routing.
9. Implement Domain Command Bus, outbox events with aggregate versions, and ExecutionReceipts.
10. Implement a deterministic/manual batch-review path before adding model extraction.

Ticket 10 is intentional: validate the domain and review mechanics without an LLM first. Then place the extraction model behind the already-proven contract.

## 5. Required ADRs before their corresponding code lands

- ADR-015: Auth provider and local-development identity strategy.
- ADR-016: PostgreSQL transaction/RLS context implementation.
- ADR-017: Source normalization, chunking, offsets, and citation verification.
- ADR-018: Access-class lattice and redaction/republication policy.
- ADR-019: Domain Command Bus and optimistic-concurrency rules.
- ADR-020: Agent job durability, retry, atomic group, and compensation semantics.
- ADR-021: Model provider for the first extraction/evaluation baseline.
- ADR-022: Account Research MCP transport and authorization strategy.

ADRs should close a concrete implementation choice. They should not reopen the product thesis.

## 6. Phase 0 test gates

A build does not move forward when any of these fail:

- cross-tenant isolation;
- stale or forged security-context rejection;
- source-citation fabrication rejection;
- prompt-injection containment;
- deterministic impact classification;
- provider poisoning containment;
- classification downgrade prevention;
- principal-confusion prevention;
- permission-tightening invalidation;
- deletion reconciliation;
- idempotent retry and out-of-order event handling;
- transcript-scale review usability;
- budget/tool/step termination.

## 7. What not to build yet

- Salesforce, Slack, Teams, Webex, or broad connector coverage;
- a public MCP server;
- a generic Solution Pack runtime or marketplace;
- Domain Profile authoring UI;
- OpenFGA;
- approximate vector search across mixed permission scopes;
- autonomous external actions;
- self-rewriting prompts or playbooks;
- full SharePoint-style document management;
- advanced Pulse analytics;
- a microservice fleet.

## 8. Implementation operating model

Use short vertical branches that end in a runnable proof. Each pull request should include:

- the requirement or ADR it implements;
- schema and migration changes;
- authorization and tenant-isolation analysis;
- unit/integration/security tests;
- audit and observability behavior;
- demo steps;
- explicit deferred work.

Recommended review roles:

```text
GPT             architecture lead and acceptance adjudication
Claude Opus     adversarial design/security review at milestone boundaries
Codex           repository implementation and test execution
Andrew          product decisions, UX judgment, and final acceptance
```

Do not send every pull request through another vision review. Use Opus after the isolation foundation, the governed trust loop, and the completed Phase 0 demonstration.

## 9. Ready-to-paste Codex kickoff instruction

```text
Create a new repository named `throughline` and implement only Wave A1 from Throughline Implementation Kickoff v0.1 and Epic P0-1 from Throughline Phase 0/1 Build Specification v0.1.1.

Treat both documents as binding architecture. Do not implement product features beyond the repository and delivery skeleton. Do not add a microservice framework, generic plugin SDK, Solution Pack runtime, OpenFGA, or provider integrations.

Required output:
1. pnpm/Turborepo monorepo with apps/web, apps/api, apps/agent-worker, apps/connector-worker, and apps/outbox-relay;
2. shared packages matching the approved module boundaries, with dependency linting that prevents Core from importing Account Operations, profiles, or adapters;
3. Next.js and NestJS/Fastify health endpoints;
4. local Docker Compose for PostgreSQL with pgvector, S3-compatible storage, and SQS-compatible queueing;
5. Drizzle migration foundation;
6. transactional outbox proof: one API request writes a domain test row and an outbox row in one transaction, the relay publishes it, and a worker consumes it idempotently;
7. OpenTelemetry trace propagation across web/API/outbox/worker;
8. unit and integration tests plus CI;
9. README with exact local startup and proof steps;
10. ADR-015 draft for identity-provider choice, without implementing production auth yet.

Keep the code production-oriented, typed, and minimal. Stop after the A1 gate is demonstrably passing. Report deviations, risks, commands run, and test results.
```

## 10. Definition of progress

The next meaningful milestone is not “the scaffold exists” or “the model produced a summary.” It is:

> A user can turn an untrusted engagement source into a mechanically cited, reviewed, authorized set of accepted facts and then see a permission-correct current view generated from those facts.

That is the first complete unit of Throughline value and the foundation for every later integration, solution pack, and Work OS surface.
