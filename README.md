# Throughline

Throughline is an AI-native Work OS identified by active, trusted organizational memory. The
first product is Account & Partner Operations, the first domain profile is AI Solutions, and the
first loop is Engagement -> Memory -> Action.

This repository is currently at Wave A1: monorepo and infrastructure skeleton only. Product
features such as tenancy tables, RLS, ChangeSets, truth ledger behavior, MCP adapters,
extraction, and production UI screens are intentionally deferred.

## Start here

1. `docs/BUILD_SPEC_v0.1.1.md` — binding architecture and acceptance baseline.
2. `docs/IMPLEMENTATION_KICKOFF_v0.1.md` — build order and operating model.
3. `backlog/phase0_backlog.csv` — issue-level Phase 0 backlog.
4. `prompts/CODEX_WAVE_A1.md` — first implementation prompt.
5. `docs/adr/` — decisions required as code lands.
6. `tests/fixtures/` — transcript-scale trust and security fixtures.
7. `profiles/ai-solutions.v1.json` — first declarative Domain Profile.
8. `contracts/account-intelligence-provider.ts` — provider-neutral read contract.

## Architecture status

Architecture is frozen for Phase 0/1. New material decisions require an ADR; out-of-scope ideas are deferred rather than added to the first build.

## Local setup

Prerequisites:

- Node.js 22+
- Corepack or pnpm 10+
- Docker with Compose for local infrastructure

Install dependencies:

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install
```

Run local infrastructure:

```bash
docker compose up -d postgres localstack
```

Run applications:

```bash
pnpm --filter @throughline/web dev
pnpm --filter @throughline/api dev
pnpm --filter @throughline/agent-worker dev
pnpm --filter @throughline/connector-worker dev
pnpm --filter @throughline/outbox-relay dev
```

Check the API health endpoint:

```bash
curl -H "x-request-id: local-request" -H "x-trace-id: local-trace" http://localhost:3001/health
```

Run CI-style checks:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run the focused Wave A1 smoke tests:

```bash
pnpm test:smoke
```

Note: these smoke tests verify the Wave A1 skeleton only. They do not claim the later kickoff proof of a traced request committing a row, emitting an outbox event, and being processed by a worker; database schema, transactional outbox behavior, and worker consumption are intentionally deferred until an approved later wave.

## Dependency notes

Production dependencies are limited to the requested Wave A1 stack: Next.js/React for
`apps/web`, NestJS with the Fastify adapter for `apps/api`, Drizzle as the database package
foundation, and a small Fastify helmet plugin for default HTTP hardening. Local S3/SQS
placeholders use LocalStack in Docker Compose and are not required for compile or unit tests.

## First proof

```text
Untrusted engagement source
  → mechanically verified claims
  → governed ChangeSet review
  → authorized AcceptedFacts
  → permission-correct cited views
```
