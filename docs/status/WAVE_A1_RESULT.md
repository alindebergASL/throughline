# Wave A1 Result — Monorepo and Infrastructure Skeleton

**Date:** 2026-06-26  
**Branch:** `wave-a1-repo-foundation`  
**Base:** `main` at preflight start, repo local path `/home/ubuntu/throughline`  
**Orchestrator:** Hermes Agent  
**Primary implementation engine:** Codex CLI  
**Reviewer:** Claude Code CLI

## Summary

Wave A1 created the Throughline monorepo and local-development skeleton only. It does not implement product features, tenancy tables, RLS, ChangeSets, truth ledger behavior, MCP adapters, extraction logic, provider integrations, or production UI screens.

The branch now has:

- pnpm workspace and lockfile.
- Turborepo configuration.
- TypeScript base configuration.
- Prettier and ESLint setup.
- Vitest smoke-test setup.
- `apps/web` minimal Next.js App Router shell.
- `apps/api` minimal NestJS + Fastify API with `/health` endpoint.
- `apps/agent-worker` skeleton.
- `apps/connector-worker` skeleton.
- `apps/outbox-relay` skeleton.
- Requested `packages/*` skeletons.
- Shared request/trace ID helper in `packages/observability`.
- Docker Compose for Postgres + pgvector and LocalStack S3/SQS placeholder.
- README local setup and verification commands.
- Basic smoke tests and dependency-boundary tests.
- Canonical UX spec path fix: `docs/ux/UX_INTERACTION_SPEC_v0.1.md` added from the existing lowercase UX spec file.

## What changed

### Root/tooling

- Added `package.json` with root scripts:
  - `dev`
  - `build`
  - `lint`
  - `format`
  - `format:check`
  - `typecheck`
  - `test`
  - `test:smoke`
- Added `pnpm-workspace.yaml`.
- Added `pnpm-lock.yaml`.
- Added `turbo.json`.
- Added `tsconfig.base.json`.
- Added `eslint.config.mjs`.
- Added `.prettierrc.json` and `.prettierignore`.
- Added `.gitignore` and `.env.example`.
- Updated `README.md` with local setup and Wave A1 scope notes.

### Apps

- Added `apps/web`:
  - Minimal Next.js App Router shell.
  - Top-level shell constrained to Today / Organizations / Pulse plus universal command/search affordance.
  - No product screens.
- Added `apps/api`:
  - Minimal NestJS + Fastify app.
  - `/health` endpoint.
  - Health service unit test.
  - HTTP-level HealthController tests.
  - Diagnostic request/trace ID header passthrough with comment that authenticated security context must not be header-sourced.
- Added `apps/agent-worker`:
  - Skeleton worker process.
  - Worker trace-context helper and tests.
- Added `apps/connector-worker`:
  - Skeleton worker process.
- Added `apps/outbox-relay`:
  - Skeleton relay process only; no outbox behavior.

### Packages

Added skeleton packages:

- `packages/core-types`
- `packages/db`
- `packages/tenancy`
- `packages/authorization`
- `packages/work-graph`
- `packages/content`
- `packages/truth-ledger`
- `packages/agent-runtime`
- `packages/capability-broker`
- `packages/integrations`
- `packages/search`
- `packages/account-operations`
- `packages/domain-profiles`
- `packages/ui`
- `packages/observability`
- `packages/testing`

All packages are placeholders or minimal skeletons. The `authorization` package exposes a placeholder `can()` shape returning `not_implemented`; it does not implement policy.

### Local infrastructure

- Added `compose.yaml` with:
  - `postgres` using `pgvector/pgvector:pg16`.
  - `localstack` for local S3/SQS placeholder.
- Removed LocalStack Docker socket mount after Claude review because S3/SQS do not need host Docker access.
- Removed deprecated LocalStack `EDGE_PORT` config.

### Tests

- Added API health service unit test.
- Added API health HTTP-level tests using Fastify injection.
- Added agent-worker request/trace context tests, including undefined-input UUID generation.
- Added dependency-boundary test scanning both package manifests and source imports for forbidden core dependencies.

## Commands run

### Preflight/tooling

```bash
git status --short --branch
git remote -v
git ls-files
git --version
gh --version
node --version
corepack --version
pnpm --version
docker --version
docker compose version
psql --version
aws --version
terraform version
codex --version
claude --version
gh auth status
aws sts get-caller-identity
codex --help
claude --help
python3 tracked-secret scan over tracked text files
```

Preflight found `corepack`, `pnpm`, `docker`, `docker compose`, `psql`, and `terraform` missing at the start. Terraform remains not installed because it is not needed for Wave A1.

### Implementation

```bash
codex exec --cd /home/ubuntu/throughline --sandbox workspace-write - < /tmp/codex_wave_a1_prompt.md
```

Codex completed normally. Its own early verification was blocked by missing host tools (`pnpm`, `corepack`, `docker`) before Hermes installed/enabled them.

### Tool installation / environment enablement

```bash
npm install -g corepack@latest pnpm@10.14.0
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 postgresql-client
```

Installed/confirmed:

```text
pnpm: 10.14.0
Docker: 29.1.3
Docker Compose: 2.40.3
psql: 16.14
```

### Verification commands

```bash
pnpm install
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:smoke
pnpm build
pnpm test
sudo docker compose up -d postgres localstack
sudo docker compose ps
psql -h 127.0.0.1 -U throughline -d throughline -c 'select 1 as ok;'
pnpm --filter @throughline/api dev
curl -H "x-request-id: local-request" -H "x-trace-id: local-trace" http://127.0.0.1:3001/health
sudo docker compose down
```

## Test results

Final verification passed:

```text
pnpm format:check: PASS
pnpm lint: PASS — 25/25 tasks successful
pnpm typecheck: PASS — 25/25 tasks successful
pnpm test:smoke: PASS — 5/5 tasks successful
pnpm build: PASS — 21/21 tasks successful
pnpm test: PASS — 25/25 tasks successful
```

Focused smoke-test detail:

```text
@throughline/api: 2 test files passed, 3 tests passed
@throughline/agent-worker: 1 test file passed, 2 tests passed
@throughline/testing: 1 test file passed, 1 test passed
```

Docker/local infra smoke:

```text
sudo docker compose up -d postgres localstack: PASS
postgres health: healthy
localstack health: healthy
psql select 1: PASS, returned ok = 1
```

API live smoke:

```text
GET /health with diagnostic headers: HTTP 200
{"status":"ok","service":"throughline-api","requestId":"local-request","traceId":"local-trace"}
```

After the smoke test, the API dev process was stopped and `docker compose down` removed the local containers and network.

## Claude Code review summary

Claude Code performed adversarial review of the Wave A1 diff.

Initial verdict:

```text
Approve with changes
```

Required fixes from Claude:

1. Remove Docker socket mount from LocalStack.
2. Fix NestJS HealthController DI bypass.
3. Add HTTP-level test for the `/health` controller.

Applied fixes:

- Removed `/var/run/docker.sock:/var/run/docker.sock` from `compose.yaml`.
- Removed deprecated `EDGE_PORT` from `compose.yaml`.
- Switched `HealthController` back to DI using `@Inject(HealthService)` constructor injection.
- Added `apps/api/src/health.controller.spec.ts` with Fastify injection tests.
- Added worker UUID fallback test.
- Added comment that diagnostic headers must not become authenticated security context.
- Made Fastify logger disabled in production.
- Added TODO that worker trace envelope must become signed before queue propagation.
- Removed unused `zod` dependency from `apps/api`.
- Extended dependency-boundary tests to scan source imports.
- Replaced `href="#"` web nav anchors with Next `Link` components.
- Clarified README that Wave A1 smoke tests do not claim the later DB/outbox/worker proof.

Second Claude review verdict:

```text
Approve
```

Claude confirmed:

- Required fixes are resolved.
- No product features beyond the Wave A1 skeleton were introduced.
- No new security/spec blocker found.

Claude non-blocking notes:

- `/health` reflects diagnostic `x-request-id` / `x-trace-id`; before A2 logging/auth, bound/sanitize any values that reach log sinks.
- `.next/` build artifacts existed locally after build but are covered by `.gitignore` and should not be committed.

## Known issues / caveats

- `terraform` is still not installed; not needed for Wave A1.
- `pnpm build` succeeds but Next.js emits a non-blocking warning:
  - `The Next.js plugin was not detected in your ESLint configuration.`
- The Wave A1 skeleton does not implement the later kickoff proof of a traced request committing a DB row, emitting an outbox event, and being processed by a worker. This is explicitly deferred because Andrew scoped Wave A1 to skeleton only.
- Docker and psql were installed on this EC2 as part of verification.
- No commit, push, or PR has been made yet.

## Next recommended wave

Next recommended wave after Andrew review/approval:

```text
Wave A2 — tenancy, identity, and RLS skeleton/implementation according to docs/IMPLEMENTATION_KICKOFF_v0.1.md and BUILD_SPEC, without broadening into ChangeSets, truth ledger, MCP adapter, extraction, or product UI screens until separately approved.
```

Before Wave A2, recommended branch hygiene:

1. Review the current Wave A1 diff.
2. Commit Wave A1 on `wave-a1-repo-foundation` if approved.
3. Push branch and open a PR to `main` if approved.
4. Do not merge until Andrew approves.
