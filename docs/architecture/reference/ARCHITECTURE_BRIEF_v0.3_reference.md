# Throughline Architecture Brief v0.3

## Purpose of this review

This is the proposed strategic and technical direction for Throughline. GPT is taking the lead on the architecture; Claude’s role in the next pass is to act as an adversarial principal product architect and provide a second set of eyes.

Do not expand this into another broad requirements exercise. Redline the direction, identify contradictions and hidden coupling, close decisions where possible, and distinguish genuine blockers from questions that can safely wait. The desired output is an opinionated architecture review, not a list of 100 additional questions.

---

## 1. Product direction

### Working name

**Throughline**

The name describes the product’s central behavior: maintaining the continuous thread connecting people, conversations, content, decisions, commitments, and outcomes over time. The name is a working product decision, not yet a legal or trademark conclusion.

### Category

**AI-native Work Operating System**

### Distinctive architecture

**Active, trusted organizational memory**

### Product behavior

**Agentic by design**

### Connectivity model

**MCP-native, with provider-neutral event and synchronization adapters**

### First solution

**Account & Partner Operations**

### First indispensable loop

**Engagement → Memory → Action**

### Long-term north star

Replace the fragmented, site-and-document-centered employee experience commonly assembled through SharePoint, shared drives, email, meeting platforms, task tools, and status trackers—and go beyond it by making organizational memory active rather than passive.

The product thesis is:

> **Throughline is an AI-native Work Operating System that turns conversations, content, decisions, and activity into active, trusted organizational memory and coordinated action.**

A useful product principle is:

> **Not another place to store work. A system that understands it, remembers it, and moves it forward.**

The first product is an account and partner operating workspace, but the company is building a universal Work OS for employees and teams. Architecture should be universal; the first experience should be opinionated; go-to-market should remain focused.

---

## 2. Why this should exist

Most workplace systems preserve artifacts but lose the operational thread between them.

A meeting lives in a calendar and recording platform. Notes live in a document. The proposal lives in a file repository. Decisions are buried in chat. Tasks live somewhere else. Account or project status is manually summarized into a CRM, spreadsheet, SharePoint page, or leadership email. The employee must reconstruct context repeatedly, and the organization’s memory decays whenever someone fails to update a page or leaves the team.

Throughline should not merely improve search across that fragmentation. It should maintain a governed representation of:

- what happened;
- what the organization currently believes to be true;
- where that belief came from;
- what changed;
- what was decided;
- what was promised;
- what remains uncertain;
- what should happen next;
- who owns it;
- who is allowed to see it.

That is the difference between a passive knowledge repository and active organizational memory.

The system should earn daily use through selfish individual value:

> “I can walk into work prepared, capture what happened without writing a separate status report, and immediately know what needs my attention.”

Team and leadership intelligence should be exhaust from the work itself, not an additional reporting workflow.

---

## 3. Product hierarchy: Core → Solution Pack → Domain Profile

Claude’s Domain Profile concept is retained, but it sits beneath a Solution Pack rather than defining the whole platform.

```text
Throughline Core
    Universal Work OS primitives and services

    └── Solution Pack
        A coherent operating model for a type of employee work

        └── Domain Profile
            Declarative vocabulary, stages, readiness dimensions,
            templates, and playbooks for a particular domain or motion
```

### 3.1 Throughline Core

The Core provides universal capabilities:

- SaaS tenancy and workspaces
- people, teams, memberships, and permissions
- spaces and organizational structure
- initiatives and activities
- pages, notes, files, links, and structured content
- tasks, commitments, decisions, and approvals
- the work graph and relationship model
- source, claim, accepted fact, and derived view pipeline
- search and contextual retrieval
- audit, provenance, freshness, and version history
- agent runtime, policy, approvals, and evaluation telemetry
- MCP client/host, adapter registry, connector runtime, and normalized events
- Pulse generation and organizational insights

The Core must not assume every organization is a sales account, every activity is a customer meeting, or every initiative is a commercial opportunity.

### 3.2 Solution Packs

A Solution Pack configures the Core for a meaningful class of work. It may define:

- activity types
- structured record types
- views and navigation
- workflows and approvals
- agent skills
- Pulse definitions
- templates
- default Domain Profiles
- constrained extension fields on Core objects

The first pack is **Account & Partner Operations**.

Possible future packs include:

- Project & Program Delivery
- Customer Success
- Professional Services
- Product Operations
- Employee Onboarding
- Policy & Procedure Management
- Leadership Operations
- Security Operations
- Research & Consulting

A Solution Pack is more substantial than a vocabulary change. Employee onboarding is not merely consultative sales with renamed stages. The pack layer prevents Domain Profile from becoming an unbounded low-code application framework.

In v1, packs are built and versioned by Throughline. There is no customer-facing pack builder, marketplace, or arbitrary tenant-supplied code.

### 3.3 Domain Profiles

A Domain Profile is declarative and versioned. It supplies domain-specific expression inside a Solution Pack:

- labels and terminology
- initiative types
- stage pipeline and allowed transitions
- typed readiness dimensions
- engagement templates
- playbook seeds
- discovery prompts
- signal mappings
- display configuration

Examples inside Account & Partner Operations:

- AI Solutions
- Biotech Platform Sales
- Channel Co-Sell

Profiles are published as immutable versions. Workspaces or spaces pin a profile version; upgrades are explicit. Stable IDs survive label changes. A validator ships with the first profile. A profile-authoring UI waits until at least two real profiles reveal the actual schema.

---

## 4. The first wedge: Engagement → Memory → Action

For Account & Partner Operations, the engagement is the behavioral spine.

An engagement is the thing with a before, during, and after. Its inputs may include:

- a transcript
- typed notes
- a voice memo
- an email thread
- a forwarded message
- a document
- a pasted summary
- a calendar event

No capture source is foundational. Webex, Teams, Zoom, Slack, email, and calendar systems are adapters. Manual and voice capture are first-class built-in capabilities so the product is complete with zero integrations and when meetings cannot be recorded.

The loop is:

```text
Before engagement
    Assemble a permission-aware brief from current facts,
    research, open commitments, people, and prior activity

During or after engagement
    Capture a note, voice memo, transcript, email, or document

Agent processing
    Extract proposed claims, decisions, commitments, tasks,
    use cases, risks, changes, and recommended next actions

Calm batch review
    Accept all, edit exceptions, drop errors, resolve conflicts

Apply approved change set
    Update accepted memory, initiative state, tasks, timeline,
    draft follow-up, and Pulse inputs

Derived output
    Refresh summaries and role-aware views automatically
```

The decisive product test is:

> **Using the tool is the data entry.**

The post-engagement review must replace writing up the meeting. If it becomes claim-by-claim administration, the product has recreated manual data entry under a new name.

---

## 5. Logical architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Experience Layer                                             │
│ Today · Spaces/Organizations · Work · Knowledge · Pulse      │
│ Search/Command Bar · Embedded Agent Suggestions              │
├──────────────────────────────────────────────────────────────┤
│ Solution Layer                                               │
│ Solution Pack Runtime · Domain Profiles · Templates          │
│ Views · Workflows · Agent Skills · Pulse Definitions         │
├──────────────────────────────────────────────────────────────┤
│ Work OS Core                                                 │
│ Tenancy · Work Graph · Content · Truth/Provenance             │
│ Initiatives · Activities · Tasks · Decisions · Commitments   │
│ Search · Authorization · Audit · Notifications               │
├──────────────────────────────────────────────────────────────┤
│ Agent Runtime                                                │
│ Context Builder · Skill Registry · Orchestrator               │
│ Policy Gateway · Change Sets · Approval · Evaluation         │
├──────────────────────────────────────────────────────────────┤
│ MCP and Connector Plane                                      │
│ MCP Host/Client · Adapter Registry · OAuth/Secrets            │
│ Webhooks/Sync · Canonical Mapping · Event Normalization       │
│ Throughline MCP Server later                                 │
├──────────────────────────────────────────────────────────────┤
│ Data and Infrastructure                                      │
│ PostgreSQL · Object Storage · Vector/Search Index             │
│ Queue/Event Bus · Cache · Secrets · Observability            │
└──────────────────────────────────────────────────────────────┘
```

The Agent Runtime is cross-cutting: it reads and proposes changes through the same authorization, provenance, and policy services used by human interactions. It does not bypass the application domain or write directly to databases and external APIs.

---

## 6. Canonical domain model

The model should use explicit universal primitives, not one giant generic Record table and not a provider-specific schema.

### 6.1 Tenancy and identity

```text
Tenant       subscribing company and security boundary
Workspace    bounded operational environment or department
Space        team, account, project, initiative, or knowledge area
User         authenticated product identity
Person       human represented in the work graph
Membership   user’s role and access within a tenant/workspace
Team         group of people with shared access or responsibility
```

`User`, `Person`, and `Membership` must remain separate. A person may be an employee, customer, partner, contractor, or several of these in different contexts. A user is an authenticated identity. Membership expresses authorization and role.

### 6.2 Universal work objects

```text
Organization
Initiative
Activity
ContentItem
Task
Commitment
Decision
Approval
Relationship
SourceArtifact
Claim
AcceptedFact
DerivedView
ExternalReference
IntegrationConnection
AgentRun
ChangeSet
AuditEvent
```

### 6.3 Work graph

The work graph connects people, teams, organizations, spaces, initiatives, activities, content, facts, decisions, and tasks.

Relationships should be first-class, contextual, time-aware, and optionally claim-backed:

```typescript
interface Relationship {
  id: RelationshipId;
  tenantId: TenantId;
  subjectId: EntityId;
  predicate: string;
  objectId: EntityId;
  contextId?: EntityId;
  validFrom?: Timestamp;
  validTo?: Timestamp;
  supportingFactId?: FactId;
}
```

This supports relationships such as customer, partner, employer, project sponsor, account owner, contributor, reviewer, policy owner, delivery partner, or mentor without hard-coding all of them into the Core.

The work graph should initially be implemented in PostgreSQL through typed tables and a relationship edge table. Do not introduce a graph database until real query patterns justify one.

### 6.4 Core versus pack-specific objects

Account & Partner Operations maps onto the Core as follows:

```text
Account              Organization + customer relationship
Partner              Organization + partner relationship
Engagement           Activity subtype
AI Initiative        Initiative + AI Solutions Profile
Workshop             Activity template
Assessment           Activity + structured pack record
Use Case              Pack-defined structured record
Readiness Profile     Pack-defined structured assessment record
Proposal              ContentItem + structured metadata
Team Pulse            Derived workspace view
```

Use Case, Readiness Profile, account ownership, partner participation, evidence scoring, and commercial stage behavior belong to the Account & Partner pack or its extensions—not the universal Core.

Pack-specific records may use a validated schema-backed extension system, but the product should avoid EAV-style data modeling and arbitrary tenant-authored logic in v1.

---

## 7. Active, trusted organizational memory

This is the distinctive architecture and the product’s trust boundary.

### 7.1 V1 persisted truth model

```text
SourceArtifact → Claim → AcceptedFact → DerivedView
```

The six-layer conceptual model may include observation and current state, but v1 persists four layers. Observation can live inside Claim as excerpt/context; current state can be a projection over accepted facts.

### 7.2 SourceArtifact

A source may be native or external:

- transcript
- note
- email
- page
- file
- message thread
- research response
- CRM object
- calendar event
- human statement

Store immutable identifiers, content hashes where appropriate, origin, external reference, retrieved time, provider and adapter version, access policy, and source snapshot policy.

Throughline owns native content. For external content, the tenant chooses whether Throughline stores only a reference, an indexable extraction, or a governed snapshot. The external system remains authoritative unless explicitly promoted.

### 7.3 Claim

A claim is a proposition, not yet shared truth. It includes:

- normalized subject, predicate, and value
- source excerpt and location
- claimant or extracting agent
- confidence
- freshness
- valid-from and valid-to times where known
- access policy
- status: proposed, accepted, rejected, conflicted, or superseded
- extraction model, skill, and prompt version

A transcript saying “we hope to begin a pilot sometime in Q4” becomes a claim such as “Customer is considering a Q4 pilot,” not a fabricated date.

### 7.4 AcceptedFact

An accepted fact is the organization’s current approved assertion, not a philosophical claim of objective truth. It:

- links to one or more supporting claims
- preserves conflicts rather than deleting them
- can be superseded but not silently overwritten
- carries temporal validity and recorded time
- retains provenance, confidence, freshness, and access policy
- may require revalidation or expiration

### 7.5 DerivedView

Summaries, briefs, status views, and Pulse statements are projections over accepted facts, decisions, commitments, and permitted source material.

They are versioned and record:

- audience and access scope
- input fact and source IDs
- model/provider/version
- skill/prompt version
- generated time
- freshness and unresolved conflicts

A summary is never the system of record and is never an opaque text blob that the agent repeatedly overwrites.

### 7.6 Permission-aware derivation

This is non-negotiable.

A derived summary, search answer, or Pulse statement must not expose information more broadly than the evidence behind it. The effective access of derived knowledge is the intersection of:

- source permissions
- fact permissions
- workspace/space policy
- audience role
- data classification
- explicit redaction or republishing approval

Retrieval must be permission-filtered before context reaches the model. Post-generation filtering is insufficient. Restricted content must not leak through embeddings, summaries, titles, counts, or existence signals.

### 7.7 Provenance model

Use W3C PROV concepts as an inspiration—not necessarily a literal RDF implementation—so the system can represent entities, generating activities, responsible agents, derivation, and attribution consistently.

---

## 8. Agent architecture

Throughline should present one coherent assistant, not a cast of named agents. Internally, behavior is organized into versioned skills and deterministic workflows.

### 8.1 Main components

```text
Context Builder
    Resolves user, tenant, permissions, current work, and relevant memory

Skill Registry
    Versioned instructions, schemas, examples, and evaluation cases

Orchestrator
    Selects the appropriate bounded workflow and model calls

Tool Broker / Policy Gateway
    Mediates internal services and MCP tools

Change Set Builder
    Converts proposed changes into a reviewable batch

Workflow Engine
    Persists long-running state, retries, waits, and approvals

Evaluation and Telemetry
    Records quality, acceptance, edits, rejection, cost, and latency
```

V1 should use bounded, deterministic workflows around LLM calls rather than an open-ended multi-agent architecture.

### 8.2 Autonomy model

#### Automatic and reversible

- read permitted context
- classify and link content
- generate drafts
- prepare briefs
- extract proposed claims
- refresh derived views
- suggest entity matches
- organize timelines

#### Proposed for approval

- accept or alter shared facts
- create or assign shared commitments
- record decisions
- change initiative stage or health
- add a use case
- change readiness posture
- promote a playbook improvement
- broaden content visibility

#### Never autonomous in v1

- send external communications
- schedule external meetings
- make customer commitments
- write to CRM or research providers
- change permissions or retention
- share restricted data
- delete authoritative records
- modify its own prompts, policies, or approval rules

The governing rule is:

> **Prepare and propose freely; never commit externally or change shared truth without a person.**

### 8.3 ChangeSet and batch review

The agent should create a `ChangeSet` after an engagement. It contains proposed operations and shows:

- what will change
- why
- supporting source
- confidence
- impact
- conflicts
- whether the change creates an external or internal obligation

The review UI supports accept all, edit, drop, and selective acceptance. Low-confidence, conflicting, sensitive, and consequential changes receive attention; routine high-confidence changes stay quiet.

Applied changes create immutable audit events. Undo occurs through compensating changes, not hidden database rollback.

### 8.4 Learning and self-improvement

The product should learn, but not silently self-modify.

V1 captures from day one:

- accepted suggestions
- edits
- rejections
- incorrect entity matches
- corrected summaries
- alert dismissals
- task reassignment
- playbook use
- eventual outcomes

Learning is divided into:

1. **Personal preferences** — summary length, notification choices, writing style, common views.
2. **Retrieval and ranking feedback** — bounded improvement using explicit interaction signals.
3. **Team playbooks** — the agent may propose additions or changes; humans approve versioned updates.
4. **Model and prompt improvement** — performed through offline evaluations, version promotion, and rollback—not live autonomous rewriting.

Every AgentRun records model, provider, prompt/skill version, tool calls, inputs, outputs, approvals, cost, latency, and trace ID.

---

## 9. MCP and integration architecture

MCP is the governed connection and action plane, not the product itself and not the bulk event bus.

### 9.1 Throughline’s MCP roles

V1:

- Throughline acts as an MCP host/client.
- It connects to one or more remote or local MCP servers through an adapter registry.
- Agent tools are exposed through a policy gateway rather than directly to the model.

Later:

- Throughline also acts as an MCP server.
- It exposes permission-scoped organizational memory and approved actions to external agents.

### 9.2 Adapter runtime

Each adapter declares:

- identity and version
- supported MCP protocol version
- capabilities
- tools, resources, and prompts
- authentication method
- read/write/destructive/open-world characteristics
- required approvals
- data classifications
- external object mappings
- event/webhook support
- rate limits
- health and sync status
- canonical schema version

MCP tool annotations are treated as hints, not enforcement. Throughline maintains its own trusted adapter manifest and policy classification.

### 9.3 Capability families

Initial capability families:

- Organization Intelligence
- CRM
- Messaging
- Meeting
- Calendar
- Document
- Identity
- Notification

An adapter may implement one or several. Provider names are not hard-coded into the Core.

### 9.4 Initial Account Research Builder contract

The first adapter is read-only and supplies organization intelligence:

```text
searchOrganizations
resolveOrganization
getOrganizationProfile
getPeople
getKnownInitiatives
getSignals
getReadinessSignals
getSources
getProviderMetadata
getLastRefresh
```

Every response is provenance-bearing. Throughline can promote a provider finding into an internal claim and accepted fact, but it does not write back initially.

Atliera later implements the same capability family or maps its richer MCP surface into it. Both may operate simultaneously. Conflicting findings remain separate claims; the system never silently merges them.

A trivial mock provider ships in Phase 0 to prove the Core is not hard-coded to the first research system.

### 9.5 Read/write separation

Read access never implies write access.

External write tools are:

- separately enabled
- minimally scoped
- audited
- classified by risk
- routed through explicit human approval

The model never receives unrestricted provider credentials or direct API access.

### 9.6 Authentication and MCP security

Remote MCP adapters use OAuth-based authorization where supported. Throughline must:

- avoid token passthrough
- validate token audience
- maintain per-user or properly scoped workspace consent
- minimize scopes and support step-up authorization
- protect against confused-deputy flows
- protect OAuth discovery and redirects from SSRF
- isolate connector credentials by tenant
- sandbox or network-restrict untrusted connector processes
- audit every external tool call

### 9.7 Events and synchronization

MCP tools/resources support contextual retrieval and controlled actions. High-volume changes, webhooks, polling, and background synchronization run through the connector runtime.

Normalize inbound changes into a CloudEvents-like envelope:

```text
id
source
type
subject
time
tenantId
workspaceId
traceId
dataSchema
adapterVersion
data
```

Use idempotency keys, sync checkpoints, retries, and dead-letter handling. Normalize events before they touch the Core.

MCP experimental long-running task features should not be a hard dependency. Throughline maintains its own durable workflow state and may map to mature MCP task primitives later.

---

## 10. Multi-tenant SaaS and authorization

Throughline is a SaaS product hosted initially in AWS. It is customer-stack agnostic and provider-portable; do not claim deployment neutrality until self-hosted, customer-VPC, or multi-cloud deployment is an actual product commitment.

### 10.1 Tenant isolation

Tenant context must exist in:

- authentication tokens
- every database row
- object storage keys
- vector/search documents
- events and background jobs
- caches
- audit logs
- agent context
- connector credentials
- model usage and billing records

Start with a pooled SaaS architecture for efficiency, preserving a bridge/silo option for later enterprise requirements.

Recommended defense in depth:

- mandatory `tenant_id`
- PostgreSQL Row-Level Security
- application authorization checks
- tenant-scoped object storage paths and encryption context
- tenant-aware queue messages
- permission-filtered search and retrieval
- automated cross-tenant security tests

### 10.2 Fine-grained authorization

Simple RBAC will not be enough for spaces, nested content, teams, external collaborators, initiatives, and inherited access.

Use a relationship-based authorization model inspired by Zanzibar. OpenFGA or an equivalent service is a reasonable implementation candidate. Authorization decisions should be centralized and expressed as relationships such as:

```text
user member-of tenant
user editor-of workspace
team member-of space
space parent-of content
person contributor-to initiative
partner can-view selected engagement
```

PostgreSQL RLS remains a tenant-isolation and defense-in-depth layer; it does not replace fine-grained policy.

### 10.3 SaaS platform requirements

Foundational:

- tenant provisioning
- user invitations
- workspace and space administration
- subscription and entitlement seams
- usage metering
- tenant-scoped secrets
- audit and security logs
- data export and deletion
- backup and recovery
- retention policy hooks
- feature flags
- per-tenant model and connector policy

Later enterprise capabilities:

- SSO and SCIM
- data residency
- customer-managed keys
- legal hold
- dedicated/silo deployment
- advanced DLP and compliance policy

---

## 11. Content, knowledge, and the SharePoint north star

“Replace SharePoint and beyond” is a north-star operating-model objective, not a v1 parity checklist.

Throughline should first become the system of work, context, and memory. It may initially leave Office-style document editing and some original file storage in external systems.

Native content must nevertheless be first-class from the beginning:

- pages
- notes
- file uploads
- external links
- structured records
- comments and mentions
- version history
- metadata and tags
- ownership and freshness
- templates
- access policy
- relationships to work objects
- search and semantic retrieval
- archive, export, and deletion

A `ContentItem` can be native or externally backed. `SourceArtifact` represents immutable evidence used by the truth pipeline; a ContentItem is a living collaborative object. Do not collapse them into one object.

Do not build in v1:

- a Word/Excel/PowerPoint replacement
- full real-time document coauthoring
- complete records management
- an unrestricted no-code platform
- every SharePoint intranet feature

The strategic sequence is:

> **Become the system of work and intelligence before attempting to become the system of all file storage.**

---

## 12. Search and context assembly

Throughline search must combine:

- lexical search
- semantic/vector retrieval
- metadata filtering
- graph relationships
- freshness
- provenance quality
- permission filtering

The retrieval sequence is:

```text
Resolve identity and tenant
    → determine accessible spaces/entities/content
    → retrieve lexical/vector candidates within that boundary
    → expand relevant graph neighbors
    → rerank by task, freshness, and evidence quality
    → assemble cited context
    → generate or answer
```

No model should receive content the user could not retrieve directly. Search results and generated answers should expose citations and confidence where appropriate.

Start with PostgreSQL full-text search plus pgvector and relational graph edges. Add a dedicated search engine when scale, latency, or feature needs justify it.

---

## 13. User experience

The experience should feel calm, Apple-like, and progressively disclosed. The system’s intelligence should reduce visible complexity rather than create a wall of dashboards.

### 13.1 Universal concepts

Potential universal shell:

```text
Today
Spaces
Work
Knowledge
People
Pulse
```

The first solution pack may present a simpler three-item shell:

```text
Today
Organizations
Pulse
```

Initiatives, engagements, people, content, tasks, and readiness appear contextually within organization and initiative views.

### 13.2 Agent surface

The assistant appears as:

- a universal command/search bar
- contextual suggestions
- pre-engagement briefs
- post-engagement batch review
- draft follow-up and next actions
- explain-why and show-source affordances

It should not occupy a permanent oversized chat panel.

### 13.3 Today

Answers: **What requires my attention now?**

- upcoming work and preparation
- open commitments
- reviews awaiting approval
- important changes
- drafts
- one or two recommended next actions

### 13.4 Organization / Initiative

Opens on current state:

- active initiatives
- what changed
- key people
- open commitments
- current decisions
- recommended next action

Timeline, use cases, readiness, content, partner involvement, tasks, and history progressively reveal on demand.

### 13.5 Pulse

Pulse explains:

- what advanced
- what stalled
- what changed
- what the team learned
- recurring patterns
- commitments at risk
- where coordination is needed
- what leadership can unblock

It measures the state of the work, not the busyness of the person. Ownership is visible where action is needed; meeting counts, note counts, rankings, and productivity scores are not product goals.

Every material Pulse statement links to supporting facts and activity.

---

## 14. First Solution Pack: Account & Partner Operations

### 14.1 First user and market wedge

Initial design partner: Andrew’s team.

Initial sellable segment: consultative B2B account, specialist, partner, customer-success, and professional-services teams whose work is fragmented across research, meetings, email, files, CRM, and manual status reporting.

### 14.2 Primary objects

- customer and partner organizations
- people and stakeholder relationships
- initiatives
- engagements
- commitments and tasks
- decisions
- use cases
- proposed solutions
- workshops and assessments
- readiness posture
- native and linked content
- account/team Pulse

### 14.3 AI Solutions Domain Profile

The first profile may define:

- initiative types: governance, infrastructure, security, application/use-case, enablement
- stages: exploring, qualified, workshop, assessment, solution proposed, validated, committed, paused/closed
- readiness dimensions: executive sponsorship, governance process, AI inventory, risk classification, data readiness, security validation, human oversight, monitoring
- engagement templates: discovery, AI workshop, assessment, architecture review, executive briefing
- playbook seeds: governance gap to workshop, readiness gap to assessment, use-case validation sequence

V1 tracks lightweight posture, gaps, evidence, freshness, and recommended plays. It does not implement a complete NIST AI RMF, ISO 42001, or regulatory control-assessment product.

---

## 15. Recommended implementation strategy

### 15.1 Architecture style

Start as a **modular monolith with separate worker processes**, not microservices.

Modules:

- Identity and Tenancy
- Authorization
- Work Graph
- Content and Knowledge
- Truth and Provenance
- Workflow, Tasks, and Approvals
- Agent Runtime
- Integration Runtime
- Search
- Pulse and Analytics
- Audit and Telemetry

Use a transactional outbox/event pattern so modules can react asynchronously without adopting full event sourcing. Preserve an append-only audit and provenance history while maintaining efficient current-state projections.

Extract services only when scaling, security isolation, or ownership boundaries justify it. Connector workers and model-processing workers may separate earlier because they have distinct risk and load profiles.

### 15.2 Reference stack for review

This is a starting recommendation, not a contract:

- TypeScript monorepo
- Next.js web application
- Fastify or NestJS modular API and workers
- PostgreSQL with pgvector
- S3-compatible object storage
- SQS/EventBridge or equivalent queue/event infrastructure
- Redis only where caching/rate limiting materially helps
- OpenFGA or equivalent relationship authorization service
- AWS Secrets Manager and KMS
- OpenTelemetry
- containerized deployment on ECS/Fargate
- RDS/Aurora PostgreSQL
- model-provider gateway with task-level routing and complete model/version logging

Claude should challenge this stack if another choice materially lowers complexity or improves safety.

---

## 16. Build sequence

### Phase 0 — Prove the architectural spine

Build one end-to-end vertical slice with synthetic or approved data:

1. Create tenant, workspace, user, and basic authorization.
2. Connect the Account Research Builder MCP server read-only.
3. Search and resolve an organization with provenance.
4. Create an initiative and engagement.
5. Paste notes or submit a short voice capture.
6. Extract a ChangeSet.
7. Review accept/edit/drop in one screen.
8. Apply accepted facts, decisions, commitments, and tasks.
9. Generate a cited organization/initiative summary.
10. Show an initial Today view and minimal Pulse statement.
11. Record complete audit, model, prompt, and tool telemetry.
12. Run the same contract against a mock provider.
13. Validate the AI Solutions Domain Profile and run a core-cleanliness test.

Phase 0 should prove:

- the core is provider-neutral
- the core is not AI-sales-specific
- provenance cannot be dropped
- permissions survive derivation
- manual capture is sufficient without a transcript
- batch review is faster than manual write-up

### Phase 1 — Earn daily usage with Account & Partner Operations

- team invitations and roles
- organizations, people, initiatives, and engagement timeline
- research refresh and snapshot-on-use
- Today
- organization and initiative views
- pre-engagement brief
- manual, pasted, uploaded, and voice capture
- ChangeSet batch review
- decisions, commitments, tasks, and follow-up drafts
- native pages/notes and linked files
- use cases
- lightweight readiness posture
- basic Team Pulse
- hybrid search
- notifications and contextual alerts

### Phase 2 — Make the team smarter and the SaaS sellable

- Atliera as a second real intelligence provider
- one real calendar/meeting or messaging adapter
- partner operations
- workshop and assessment templates
- curated playbooks
- entity resolution and reversible merges
- cross-account read-only insights
- improved Pulse
- tenant admin, entitlements, usage metering, and billing
- second Domain Profile inside Account Operations
- stronger content ownership/freshness workflows

### Phase 3 — Prove the Work OS, not just the sales solution

- second non-sales Solution Pack
- richer Spaces and Knowledge experience
- Throughline as an MCP server
- enterprise SSO/SCIM
- advanced connector ecosystem
- profile authoring UI after schema evidence exists
- solution-pack SDK only after two real packs exist
- mobile/frontline capture
- formal assessment generation
- outcome analysis and playbook-improvement proposals
- enterprise isolation/data residency options

---

## 17. Explicit non-goals for v1

- full SharePoint feature parity
- a general no-code app builder
- full CRM replacement
- Slack or Teams replacement
- Office document editor replacement
- arbitrary autonomous agents
- autonomous external communications
- bidirectional sync with every provider
- adapter marketplace
- solution-pack marketplace
- customer-authored executable extensions
- formal control-level governance assessment
- graph database
- microservice fleet
- silent self-modification

---

## 18. Success tests

### Product

- The user gets useful value before connecting external systems.
- The pre-engagement brief reduces preparation effort.
- The batch review is faster than writing notes and updating trackers manually.
- A user can understand why the system believes something.
- The team can stop producing a separate manual weekly status report.
- Pulse helps coordinate and unblock work without feeling like surveillance.

### Trust and safety

- Every material agent assertion is source-backed or explicitly labeled as inference.
- No derived view broadens source access without redaction and approval.
- No external write occurs without the required approval.
- No connector can bypass tenant, user, or tool policy.
- All changes are auditable and reversible through compensating actions.

### Architecture

- The same Core works with the research adapter and mock adapter.
- No provider-specific objects leak into canonical Core tables.
- No AI-specific vocabulary leaks into the Core.
- Every persisted object and job is tenant-aware.
- Connector failure degrades gracefully without making Throughline unusable.
- Model/provider changes do not alter the domain model.

---

## 19. Questions for Claude’s second review

Review this as an adversarial principal architect and product strategist. Do not simply validate it, and do not rewrite it into a larger vision document.

Return:

1. **Verdict:** approve, approve with changes, or reject the direction.
2. **The five strongest architectural decisions.**
3. **The five most dangerous assumptions or hidden contradictions.**
4. **What is over-engineered for Phase 0/1 and should be removed.**
5. **What is under-specified and would be expensive to retrofit.**
6. **Whether Core → Solution Pack → Domain Profile is the correct abstraction split.**
7. **Whether Activity should be the universal spine and Engagement the first pack subtype.**
8. **Whether the truth model needs Claim → AcceptedFact, or a different assertion/state model.**
9. **Whether permission-aware derivation is sufficiently designed, including search and embeddings.**
10. **Whether a modular monolith plus workers is the right starting architecture.**
11. **Whether the proposed MCP boundary is correct—especially MCP versus event ingestion, local policy enforcement, and future MCP-server exposure.**
12. **MCP security risks we have missed, including OAuth, scopes, token handling, tool trust, SSRF, prompt/tool injection, and connector isolation.**
13. **Whether ReBAC/OpenFGA is justified from day one or should be staged differently.**
14. **Whether the reference AWS/TypeScript stack is appropriate.**
15. **The three changes you would make before writing the Phase-0/Phase-1 build spec.**

Be decisive. Close decisions when evidence is sufficient. Separate fatal flaws from refinements. Do not create another 100-question discovery list.

---

## 20. Research anchors considered in this architecture

- Model Context Protocol architecture, authorization, security best practices, tool annotations, and current experimental task support
- AWS SaaS Lens guidance on tenant context, isolation, and pooled/silo/bridge models
- W3C PROV Data Model and PROV Ontology
- Zanzibar-style relationship authorization and OpenFGA concepts
- CloudEvents event normalization
- Microsoft SharePoint information architecture, permissions, content/knowledge scope, and current AI direction
- Current market positioning from Slack and Notion around work operating systems, agents, enterprise search, and connected workspaces

