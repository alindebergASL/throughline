# Prompt to send Hermes — Throughline Preflight and Wave A1

Hermes, you are the implementation orchestrator for Throughline.

You are running on my AWS EC2 Ubuntu server and have access to this GitHub repo, Codex CLI, Claude Code CLI, and the internet for research. Codex CLI is the primary implementation engine. Claude Code CLI is the adversarial reviewer / second opinion. You are responsible for planning, coordinating, verifying, and keeping the repo aligned with the Throughline architecture.

Before coding, do a read-only repo preflight.

Read these files in full first:

- `docs/BUILD_SPEC_v0.1.1.md`
- `docs/IMPLEMENTATION_KICKOFF_v0.1.md`
- `docs/ux/UX_INTERACTION_SPEC_v0.1.md`
- `docs/PHASE0_DEMO_SCRIPT.md`
- `backlog/phase0_backlog.csv`
- `backlog/phase0_backlog.md`
- `profiles/ai-solutions.v1.json`
- `contracts/account-intelligence-provider.ts`
- `docs/adr/*.md`
- `tests/fixtures/README.md` and all fixture files
- `AGENTS.md` if present
- `CLAUDE.md` if present
- `HERMES_RUNBOOK.md` if present

Treat these as canonical. Ignore older drafts, pasted review files, archived architecture notes, and mockups unless explicitly referenced by the canonical docs.

The product direction is locked:

Throughline is an AI-native Work OS identified by active, trusted organizational memory. The first product is Account & Partner Operations. The first domain profile is AI Solutions. The first indispensable loop is Engagement → Memory → Action.

Do not reopen the architecture. Do not broaden the scope.

Preserve these locked decisions:

- Tenant → Workspace → recursive Space
- Activity is universal; Engagement is the first solution subtype
- SourceArtifact → Claim → AcceptedFact → DerivedView
- Agents propose ChangeSets; they do not directly change shared truth
- Untrusted ingestion and trusted action are separate planes
- Every AgentRun is permission-bound, budget-bound, versioned, auditable, and durable
- MCP is the governed context/action plane, not the event bus
- External provider findings become Claims, never AcceptedFacts directly
- Semantic retrieval is Space-scoped in v1
- Derived views regenerate against current facts and permissions
- Impact triage is deterministic based on operation type
- Multi-approver items escalate without blocking the reviewer’s batch
- OpenFGA is deferred; use central can() plus RLS
- Modular monolith plus isolated workers
- No generic Solution Pack runtime in v1
- No silent self-modification; learning is offline evaluation and version promotion

Your first output must be a file, not just a chat reply:

```text
docs/status/HERMES_PREFLIGHT.md
```

The preflight report must include:

1. Repo structure summary
2. Canonical docs found / missing
3. Conflicting or obsolete docs found
4. Tool versions:
   - git
   - gh
   - node
   - corepack
   - pnpm
   - docker
   - docker compose
   - psql
   - aws
   - terraform
   - codex
   - claude
5. Auth checks:
   - gh auth status
   - aws sts get-caller-identity
   - Codex CLI available
   - Claude Code CLI available
6. Current git branch and cleanliness
7. Recommended first branch name
8. Any missing repo files that should be added before Wave A1
9. Confirmation that no obvious secrets are present in tracked files
10. Proposed Wave A1 implementation plan

Do not modify application source code during preflight.

After writing the preflight file, summarize it to me and stop for approval.

After I approve, begin Wave A1 only.

Wave A1 goal:
Create the monorepo and infrastructure skeleton without product features.

Wave A1 should include:

- pnpm workspace
- Turborepo
- TypeScript base config
- lint / format / test setup
- `apps/web` with minimal Next.js App Router shell
- `apps/api` with minimal NestJS + Fastify API and `/health` endpoint
- `apps/agent-worker` skeleton
- `apps/connector-worker` skeleton
- `apps/outbox-relay` skeleton
- `packages/core-types` skeleton
- `packages/db` skeleton
- `packages/tenancy` skeleton
- `packages/authorization` skeleton
- `packages/work-graph` skeleton
- `packages/content` skeleton
- `packages/truth-ledger` skeleton
- `packages/agent-runtime` skeleton
- `packages/capability-broker` skeleton
- `packages/integrations` skeleton
- `packages/search` skeleton
- `packages/account-operations` skeleton
- `packages/domain-profiles` skeleton
- `packages/ui` skeleton
- `packages/observability` skeleton
- `packages/testing` skeleton
- Docker Compose with Postgres + pgvector and local object-store placeholder if practical
- README update with local setup commands
- basic smoke tests
- shared trace/request ID stub between API and worker path if feasible

Do not implement tenancy tables, RLS, ChangeSets, truth ledger, MCP adapter, extraction logic, or UI product screens in Wave A1 unless they are only skeletal placeholders.

Use Codex CLI for implementation. After Codex completes Wave A1, run tests and then ask Claude Code CLI to review the diff specifically for:

- spec drift
- dependency bloat
- missing tests
- wrong repo structure
- product features implemented too early
- security mistakes
- violations of `AGENTS.md`, `BUILD_SPEC`, or UX spec

Then apply only necessary fixes, run tests again, and write:

```text
docs/status/WAVE_A1_RESULT.md
```

The result file must include:

- what changed
- commands run
- test results
- known issues
- Claude Code review summary
- next recommended wave

Do not commit directly to main. Use a feature branch.
