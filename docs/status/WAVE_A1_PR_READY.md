# Wave A1 PR Ready

**Date:** 2026-06-26  
**Branch:** `wave-a1-repo-foundation`  
**PR:** https://github.com/alindebergASL/throughline/pull/1  
**Implementation commit hash:** `21e8343081648601bf4fdff3d306129509ac4535`  
**Status:** PR opened for Andrew review. Do not merge yet. Do not start Wave A2 implementation.

## Final test results

Final branch hygiene and verification commands were run before opening the PR:

```bash
git status --short
git status --ignored --short | head -100
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Results:

```text
pnpm format:check: PASS
pnpm lint: PASS — 25/25 tasks successful
pnpm typecheck: PASS — 25/25 tasks successful
pnpm test: PASS — 25/25 tasks successful
pnpm build: PASS — 21/21 tasks successful
```

Earlier Wave A1 verification in `docs/status/WAVE_A1_RESULT.md` also recorded:

```text
pnpm test:smoke: PASS — 5/5 tasks successful
Docker Compose Postgres + LocalStack smoke: PASS
psql select 1: PASS
live API /health smoke: PASS — HTTP 200
```

## Final git hygiene

Pre-PR hygiene confirmed:

- `git status --short --branch` was clean before this PR-ready status file was added.
- Ignored generated artifacts were present locally but ignored as expected:
  - `.turbo/`
  - `node_modules/`
  - `dist/`
  - `.next/`
  - `*.tsbuildinfo`
- No generated artifacts, Docker volumes, caches, or `.env` files were staged.
- `docs/ux/UX_INTERACTION_SPEC_v0.1.md` exists at the canonical path.
- Root `README.md` contains local setup and Wave A1 scope notes.
- Status docs remain under `docs/status/`.
- Diagnostic request/trace IDs are explicitly marked as non-authenticated diagnostic context only.

## Known caveats

- `pnpm build` succeeds, but Next.js emits a non-blocking warning that the Next.js ESLint plugin was not detected.
- Terraform is still not installed and was not needed for Wave A1.
- Wave A1 smoke tests verify the skeleton only. They do not claim the later kickoff proof of a traced request committing a DB row, emitting an outbox event, and being processed by a worker.

## Claude Code required fixes status

Claude Code initial verdict was `Approve with changes`. Required fixes remain applied:

1. **Remove Docker socket mount from LocalStack:** applied in `compose.yaml`.
2. **Fix NestJS HealthController DI bypass:** applied via constructor injection in `apps/api/src/health.controller.ts`.
3. **Add HTTP-level `/health` test:** applied in `apps/api/src/health.controller.spec.ts`.

Claude Code second verdict was `Approve`.

## Recommended Wave A2 planning prompt

Use this only after Wave A1 PR review/merge approval. Do not start A2 implementation yet.

```text
Hermes, plan Wave A2 for Throughline. Do not code yet.

Use the canonical docs and ADRs as source of truth:
- docs/BUILD_SPEC_v0.1.1.md
- docs/IMPLEMENTATION_KICKOFF_v0.1.md
- docs/ux/UX_INTERACTION_SPEC_v0.1.md
- docs/PHASE0_DEMO_SCRIPT.md
- docs/adr/*.md
- backlog/phase0_backlog.csv
- backlog/phase0_backlog.md
- AGENTS.md / CLAUDE.md / HERMES_RUNBOOK.md if present

Wave A2 should be narrow and security-heavy:
- Tenant
- Workspace
- recursive Space
- User
- Person
- Membership
- SecurityContext
- transaction wrapper
- SET LOCAL RLS context
- central can()
- baseline RLS policies
- cross-tenant denial tests

Do not implement truth ledger, ChangeSets, MCP, extraction, provider integrations, or product UI screens.

Produce a Wave A2 plan only, including files likely to change, tests, security invariants, and review checkpoints. Stop for Andrew approval before coding.
```
