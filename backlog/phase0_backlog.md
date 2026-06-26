# Throughline Phase 0 Issue Backlog

Importable CSV: `phase0_backlog.csv`

## TL-001 — Initialize pnpm/Turborepo monorepo
- **Epic:** P0-1
- **Type/Priority:** task / P0
- **Depends on:** None
- **Labels:** repo,foundation
- **Acceptance:** apps and packages compile; dependency boundaries enforced

## TL-002 — Create local infrastructure compose stack
- **Epic:** P0-1
- **Type/Priority:** task / P0
- **Depends on:** TL-001
- **Labels:** infra,local-dev
- **Acceptance:** PostgreSQL+pgvector, S3-compatible store, and queue start with one command

## TL-003 — Implement transactional outbox proof
- **Epic:** P0-1
- **Type/Priority:** story / P0
- **Depends on:** TL-001;TL-002
- **Labels:** outbox,worker
- **Acceptance:** API commit writes test aggregate and outbox atomically; relay publishes; worker handles idempotently

## TL-004 — Propagate OpenTelemetry trace across API and worker
- **Epic:** P0-1
- **Type/Priority:** task / P0
- **Depends on:** TL-003
- **Labels:** observability
- **Acceptance:** single trace links request, transaction, relay, and worker

## TL-005 — Implement Tenant Workspace Space schema
- **Epic:** P0-2
- **Type/Priority:** story / P0
- **Depends on:** TL-002
- **Labels:** tenancy,db
- **Acceptance:** migrations and repositories preserve tenant/workspace keys and recursive Space

## TL-006 — Implement User Membership Person principals
- **Epic:** P0-2
- **Type/Priority:** story / P0
- **Depends on:** TL-005
- **Labels:** identity,authorization
- **Acceptance:** User/Membership separated from graph Person; invitations supported

## TL-007 — Implement ServicePrincipal and AgentPrincipal
- **Epic:** P0-2
- **Type/Priority:** task / P0
- **Depends on:** TL-006
- **Labels:** identity,agent
- **Acceptance:** workers and agents use explicit non-human principals

## TL-008 — Implement SecurityContext reference and rehydration
- **Epic:** P0-2
- **Type/Priority:** story / P0
- **Depends on:** TL-006;TL-007
- **Labels:** security,async
- **Acceptance:** queue carries signed reference; worker rehydrates and reauthorizes

## TL-009 — Implement central AuthorizationService.can
- **Epic:** P0-2
- **Type/Priority:** story / P0
- **Depends on:** TL-006
- **Labels:** authorization
- **Acceptance:** no module contains ad hoc role checks; explainable decisions supported

## TL-010 — Enable and test PostgreSQL RLS
- **Epic:** P0-2
- **Type/Priority:** story / P0
- **Depends on:** TL-005;TL-008
- **Labels:** security,rls
- **Acceptance:** cross-tenant access denied under pooled connections and worker runs

## TL-011 — Implement Organization Initiative Activity Relationship
- **Epic:** P0-3
- **Type/Priority:** story / P0
- **Depends on:** TL-010
- **Labels:** work-graph
- **Acceptance:** manual account workflow is functional with no integrations

## TL-012 — Implement AI Solutions profile loader and validator
- **Epic:** P0-3
- **Type/Priority:** story / P0
- **Depends on:** TL-001
- **Labels:** profile,validation
- **Acceptance:** profile validates typed condition AST, stable keys, stages, dimensions

## TL-013 — Add core-cleanliness dependency test
- **Epic:** P0-3
- **Type/Priority:** task / P0
- **Depends on:** TL-001
- **Labels:** architecture,test
- **Acceptance:** Core cannot import account operations, profile, or adapter modules

## TL-014 — Implement ContentItem and immutable SourceArtifact
- **Epic:** P0-4
- **Type/Priority:** story / P0
- **Depends on:** TL-011
- **Labels:** content,truth
- **Acceptance:** manual note/transcript stored with hash and immutable evidence record

## TL-015 — Implement SourceChunk normalization and hashes
- **Epic:** P0-4
- **Type/Priority:** story / P0
- **Depends on:** TL-014
- **Labels:** provenance,citations
- **Acceptance:** stable chunk IDs, offsets, normalized text, and hashes produced deterministically

## TL-016 — Implement mechanically verified source spans
- **Epic:** P0-4
- **Type/Priority:** story / P0
- **Depends on:** TL-015
- **Labels:** provenance,security
- **Acceptance:** fabricated chunk, offset, or excerpt is rejected

## TL-017 — Implement Claim and AcceptedFact ledger
- **Epic:** P0-4
- **Type/Priority:** story / P0
- **Depends on:** TL-016
- **Labels:** truth-ledger
- **Acceptance:** claim acceptance records authority and supporting evidence

## TL-018 — Implement conflicts supersession revocation
- **Epic:** P0-4
- **Type/Priority:** story / P0
- **Depends on:** TL-017
- **Labels:** truth-ledger
- **Acceptance:** old facts preserved; current state and conflicts resolvable

## TL-019 — Implement access-class propagation
- **Epic:** P0-4
- **Type/Priority:** story / P0
- **Depends on:** TL-017
- **Labels:** security,classification
- **Acceptance:** claim/fact/view cannot be less restrictive than inputs

## TL-020 — Implement DerivedView revision hash and regeneration
- **Epic:** P0-4
- **Type/Priority:** story / P0
- **Depends on:** TL-018;TL-019
- **Labels:** derived-view
- **Acceptance:** fact or permission change forces a permission-correct regeneration

## TL-021 — Implement AgentRun durable state machine
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-003;TL-008
- **Labels:** agent-runtime
- **Acceptance:** runs pause, retry, cancel, and resume without in-memory dependency

## TL-022 — Implement versioned Skill registry
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-021
- **Labels:** agent-runtime,skills
- **Acceptance:** skills declare schemas, context recipe, permissions, budgets, eval suite

## TL-023 — Implement ContextPacket builder
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-020;TL-022
- **Labels:** agent-runtime,security
- **Acceptance:** context is permission-filtered and trust-labeled before model access

## TL-024 — Enforce ingestion/action plane separation
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-023
- **Labels:** agent-runtime,security
- **Acceptance:** extraction worker has no write-capable capability path

## TL-025 — Implement typed ChangeSet operation unions
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-022
- **Labels:** changeset,types
- **Acceptance:** each operation has schema, evidence, impact floor, approval, pre/postconditions

## TL-026 — Implement deterministic impact and approval policy
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-025;TL-009
- **Labels:** policy,approval
- **Acceptance:** model cannot downgrade commitments, dates, stages, security, or external actions

## TL-027 — Implement batch review state and escalation
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-025;TL-026
- **Labels:** review,workflow
- **Acceptance:** reviewer finishes eligible batch while escalations route independently

## TL-028 — Implement Domain Command Bus
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-009;TL-025
- **Labels:** domain,commands
- **Acceptance:** all human and agent writes use typed authorized commands

## TL-029 — Implement ExecutionReceipt verification and compensation
- **Epic:** P0-5
- **Type/Priority:** story / P0
- **Depends on:** TL-028
- **Labels:** execution,reliability
- **Acceptance:** attempts, pending verification, atomic groups, and compensation recorded

## TL-030 — Create deterministic manual ChangeSet fixture path
- **Epic:** P0-7
- **Type/Priority:** story / P0
- **Depends on:** TL-027;TL-028
- **Labels:** review,test
- **Acceptance:** review UX and command semantics proven without an LLM

## TL-031 — Implement engagement extraction schema and verifier
- **Epic:** P0-7
- **Type/Priority:** story / P0
- **Depends on:** TL-016;TL-022;TL-024
- **Labels:** extraction,ai
- **Acceptance:** only allowed entities/states; citations and dates verified server-side

## TL-032 — Build transcript-scale batch review UI
- **Epic:** P0-7
- **Type/Priority:** story / P0
- **Depends on:** TL-027;TL-030;TL-031
- **Labels:** ui,review
- **Acceptance:** 30–50 items grouped into attention, ready, and escalation buckets

## TL-033 — Add normal discovery transcript evaluation
- **Epic:** P0-7
- **Type/Priority:** test / P0
- **Depends on:** TL-031;TL-032
- **Labels:** fixture,evaluation
- **Acceptance:** expected claims and impact classes pass thresholds

## TL-034 — Add conflict-heavy workshop evaluation
- **Epic:** P0-7
- **Type/Priority:** test / P0
- **Depends on:** TL-031;TL-032
- **Labels:** fixture,evaluation
- **Acceptance:** conflicts, ambiguous dates, and supersession are foregrounded

## TL-035 — Add adversarial injection evaluation
- **Epic:** P0-7
- **Type/Priority:** test / P0
- **Depends on:** TL-024;TL-031;TL-032
- **Labels:** fixture,security
- **Acceptance:** malicious instructions cannot create tool intent or hide consequential items

## TL-036 — Implement adapter registry and Capability Broker
- **Epic:** P0-6
- **Type/Priority:** story / P0
- **Depends on:** TL-009;TL-024
- **Labels:** mcp,integration
- **Acceptance:** trusted capability manifests mediate all external tools

## TL-037 — Implement mock AccountIntelligenceProvider
- **Epic:** P0-6
- **Type/Priority:** story / P0
- **Depends on:** TL-036
- **Labels:** adapter,contract
- **Acceptance:** mock returns provenance-bearing canonical contract

## TL-038 — Implement Account Research MCP adapter
- **Epic:** P0-6
- **Type/Priority:** story / P0
- **Depends on:** TL-036;TL-037
- **Labels:** mcp,adapter
- **Acceptance:** read-only provider passes same contract and cannot create facts

## TL-039 — Implement exact Space-scoped hybrid retrieval
- **Epic:** P0-8
- **Type/Priority:** story / P0
- **Depends on:** TL-010;TL-019;TL-020
- **Labels:** search,security
- **Acceptance:** retrieval only searches currently authorized Spaces

## TL-040 — Implement cited organization and initiative summaries
- **Epic:** P0-8
- **Type/Priority:** story / P0
- **Depends on:** TL-020;TL-039
- **Labels:** summary,derived-view
- **Acceptance:** material assertion links to verified source and respects current permissions

## TL-041 — Implement asymmetric-access regression suite
- **Epic:** P0-8
- **Type/Priority:** test / P0
- **Depends on:** TL-039;TL-040
- **Labels:** security,search
- **Acceptance:** restricted child Space has no influence on other user outputs or counts

## TL-042 — Implement Today and minimal Pulse
- **Epic:** P0-8
- **Type/Priority:** story / P0
- **Depends on:** TL-027;TL-040
- **Labels:** ui,pulse
- **Acceptance:** reviews, commitments, changes, and unblock needs shown without activity scoring

## TL-043 — Automate Phase 0 demo from clean environment
- **Epic:** P0-8
- **Type/Priority:** test / P0
- **Depends on:** TL-003;TL-010;TL-032;TL-038;TL-042
- **Labels:** demo,e2e
- **Acceptance:** scripted proof passes end-to-end with adapter disabled and switched
