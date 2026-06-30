# Wave A2 Result — Tenancy, Identity, and RLS

**Date:** 2026-06-30  
**Branch:** `wave-a2-tenancy-identity-rls`  
**Base:** `main` at Wave A2 planning start, repo local path `/home/ubuntu/throughline`  
**Orchestrator:** Hermes Agent  
**Primary implementation engine:** Codex CLI, then Hermes fixes/verification  
**Reviewer:** Claude Code CLI (Fable requested but unavailable; default Claude Code review completed)

## Summary

Wave A2 implements Throughline's tenancy, identity, authorization, and PostgreSQL RLS foundation only. It keeps scope inside the approved `Tenant → Workspace → recursive Space` model; separates authorization subjects (`User`, `Membership`, `ServicePrincipal`, `AgentPrincipal`) from graph-level `Person`; and uses PostgreSQL RLS plus application `AuthorizationService.can()` as a defense-in-depth boundary.

The final implementation passed Hermes verification and Claude Code review. No Wave A3/product UI/agent runtime/truth-ledger/provider/MCP scope was added.

## What changed

### Root/tooling

- Added root `test:security` script:
  - `turbo test:security --filter=@throughline/db --filter=@throughline/authorization --concurrency=1`
- Added Turbo environment passthrough for database test URLs:
  - `DATABASE_URL`
  - `TEST_DATABASE_URL`
  - `TEST_APP_DATABASE_URL`
- Updated `pnpm-lock.yaml` after Wave A2 package dependency changes.
- Updated `.env.example` with owner and app-role test database URLs.

### Documentation

- Marked ADR-015 accepted.
- Updated README with Wave A2 commands/dependencies and security-test notes.

### Core types

Added Wave A2 primitives in `packages/core-types`:

- `Tenant`
- `Workspace`
- `Space`
- `User`
- `Person`
- `Membership`
- `ServicePrincipal`
- `AgentPrincipal`
- `AccessRelationship`
- `ResourceRef`
- `AuthorizationDecision`
- `SecurityContext`

### Tenancy package

- Added `SecurityContext` validation using Zod.
- Enforced exactly one principal kind per context:
  - user+membership
  - service principal
  - agent principal
- Added expiry validation.
- Added deterministic local dev identities and fixtures for A2 tests.
- Added deterministic restricted-child Space fixture for recursive inheritance tests.
- Added guarded dev identity resolver that rejects public header-sourced authority fields.
- Added SecurityContext tests.

### Database package

- Added PostgreSQL/Drizzle node-postgres support using `pg`; no `postgres` driver dependency was added.
- Added SQL migration:
  - `packages/db/migrations/0001_wave_a2_identity_access_rls.sql`
- Added schemas:
  - `identity`
  - `access`
  - `ops`
- Added Wave A2 tables:
  - `identity.tenants`
  - `identity.workspaces`
  - `identity.users`
  - `identity.people`
  - `identity.memberships`
  - `identity.service_principals`
  - `identity.agent_principals`
  - `identity.policy_versions`
  - `access.spaces`
  - `access.access_relationships`
- Added RLS helper functions under `ops` for current tenant/workspace/user/membership/service/agent/policy context.
- Enabled and forced RLS on all tenant/workspace-scoped A2 tables.
- Created `throughline_app` role with `NOBYPASSRLS`.
- Granted app role access to schemas/tables/functions while relying on RLS policies for row isolation.
- Added `withTenantTransaction()` wrapper that starts a transaction and sets context via transaction-local `set_config(..., true)` only.
- Added migration and deterministic seed helpers for tests.
- Added database security tests covering app role, RLS isolation, self-read-only `identity.users`, `SET LOCAL` leakage, and `team` subject rejection.

### Authorization package

- Replaced placeholder authorization implementation with `PostgresAuthorizationService.can()`.
- Added centralized A2 authorization decisions for:
  - tenant read
  - workspace read
  - current-user self read
  - current-membership read
  - workspace member management for owner/admin
  - space read
  - space child creation/access management for owner/admin
- Enforced default-deny for service and agent principals in A2.
- Recomputed live authorization from the database, rather than trusting context hints.
- Added target-resource checks so `tenant.read` and `workspace.manage_members` cannot allow resources outside the current context.
- Added restricted-ancestor inheritance semantics so inherited Space grants cannot pass through a restricted boundary.
- Added tests for service/agent default-deny, cross-tenant denial, wrong tenant/workspace resource denial, stale-context denial, restricted Space denial, restricted-ancestor inheritance, and Person/principal confusion.

## Binding clarification enforcement

| Binding clarification | Enforcement |
| --- | --- |
| SQL migrations define RLS/policies/roles | RLS, role creation, policies, grants, schemas, tables, and helper functions are in reviewed SQL migration `0001_wave_a2_identity_access_rls.sql`. Drizzle schema mirrors structure only. |
| App role must not have `BYPASSRLS` | Migration creates `throughline_app` with `NOBYPASSRLS`; `packages/db/src/security.spec.ts` verifies `rolbypassrls = false`. |
| Tenant-aware repository operations use `withTenantTransaction` and `SET LOCAL` inside transaction | `withTenantTransaction()` begins a transaction, calls transaction-local `set_config(..., true)`, then commits/rolls back and releases the client. Tests verify no context leaks after the transaction. |
| Tests must not pass only via superuser/owner connections | RLS assertions use `appPool` with `TEST_APP_DATABASE_URL`; owner pool is used only for migrations/seeding/admin checks. |
| Diagnostic request/trace IDs are metadata only | `requestId` and `traceId` are stored as transaction-local settings but no RLS policy or authorization query uses them as authority. |
| Do not broaden API/product surface | No A2 API/product endpoints or UI screens were added. Work stayed inside packages/db, packages/tenancy, packages/authorization, types, docs, and root tooling. |
| No Teams in A2 | No teams table was added; `access.access_relationships.subject_type` CHECK excludes `team`; security test verifies team insertion is rejected. |
| ServicePrincipal and AgentPrincipal default-deny | `AuthorizationService.can()` denies service/agent principals before DB authorization rules. Tests cover both. |
| `can()` must not allow wrong target resources | `tenant.read` denies unless the resource is the current tenant; `workspace.manage_members` denies unless the resource is the current workspace. Tests cover tenant A owner targeting tenant B/workspace B. |
| Restricted Space ancestors break inherited access | Space inheritance checks block inherited grants when any closer ancestor/target is `inheritance_mode = 'restricted'`. Tests cover root grant denial through a restricted ancestor plus boundary/direct grants. |
| Local dev identity must not trust public authority headers | Dev resolver accepts deterministic aliases and explicitly rejects tenant/workspace/user/role/permission authority headers. |
| `identity.users` self-read only | RLS policy only allows `id = ops.current_user_id()` for SELECT; test verifies tenant A sees only the current user. |
| Active memberships require linked Person | SQL CHECK requires `status <> 'active' OR person_id IS NOT NULL`; authorization also requires live membership with `person_id IS NOT NULL`. |
| No vector extension in A2 | Migration enables `pgcrypto` only; no vector extension or vector/search tables were added. |

## Verification commands and results

### Host/resource guardrail before verification

The previous Codex run had locked the host by launching heavy root checks concurrently. Hermes added an 8 GiB swapfile and used serial capped verification for this run.

Final host state after verification:

```text
Mem: 7.6Gi total, 5.4Gi available
Swap: 8.0Gi total, 0B used
Postgres container: healthy
```

### Install/format/static checks

```bash
npm exec -- pnpm install --no-frozen-lockfile
npm exec -- pnpm install --frozen-lockfile
npm exec -- pnpm format:check
throughline-safe-checks lint typecheck test build
```

Results:

```text
pnpm install --frozen-lockfile: PASS
pnpm format:check: PASS
lint: PASS — 27/27 tasks successful
typecheck: PASS — 27/27 tasks successful
test: PASS — 27/27 tasks successful
build: PASS — 21/21 tasks successful
```

The ordinary root test run intentionally skips DB-backed security tests when DB URLs are absent; `test:security` below runs those tests with the app role.

### Local PostgreSQL/security verification

```bash
sudo docker compose up --detach postgres
# wait until postgres health is healthy
set -a
. ./.env.example
set +a
npm exec -- pnpm test:security
```

Results:

```text
@throughline/db security tests: PASS — 5/5 tests passed
@throughline/authorization security tests: PASS — 12/12 tests passed
Root test:security: PASS — 5/5 Turbo tasks successful
```

### PR-readiness review fix pass

After PR #2 readiness review, Hermes applied two required authorization fixes before merge:

1. `AuthorizationService.can()` now validates the requested target resource for `tenant.read` and `workspace.manage_members` before returning allow decisions.
2. Recursive Space inheritance now treats restricted ancestors as inheritance boundaries. Root grants do not pass through a restricted ancestor; direct grants at the restricted boundary or target can authorize the expected descendant reads.

Additional focused verification before the final full run:

```text
@throughline/authorization test:security: PASS — 12/12 tests passed
@throughline/db test:security: PASS — 5/5 tests passed
```

### Security/static review checks

```bash
git diff -- . ':(exclude)pnpm-lock.yaml' | grep '^+' | grep -iE '(api_key|secret|password|token|passwd)\s*=\s*["'"'][^"'"']{6,}["'"']' || true
node dependency check for pg/postgres/zod additions
```

Results:

```text
No hardcoded-secret pattern matches in added source/docs lines outside lockfile.
packages/db depends on pg and not postgres.
packages/tenancy depends on zod.
No root postgres driver dependency was added.
```

## Claude Code review

Attempted Fable review first:

```bash
claude --model claude-fable-5 --print ...
```

Result:

```text
Claude Fable 5 is currently unavailable.
```

Fallback Claude Code review was run against a complete review bundle containing the diff, untracked file contents, relevant context, and verification summary.

Claude Code verdict:

```text
PASS
```

Claude found no blocking findings, no spec violations, no security issues, and no missing required tests. Non-blocking notes were:

1. The stale-context authorization test mutates membership status without restoring it; this was addressed in the PR-readiness fix pass by restoring the membership in a `finally` block.
2. `parseSecurityContext` is called twice per `can()` call; harmless but redundant.
3. `ResourceRef.spaceId` is forward-looking and unused in A2; minor extra type surface.
4. Invited memberships would deny generically rather than explain invite state; acceptable for A2.

Claude concluded:

```text
Minimal required changes: None. The implementation is ready to merge.
```

## Known caveats

- `pnpm test` without DB URLs skips DB-backed RLS/security tests by design. Use `pnpm test:security` with local DB URLs loaded for the authoritative RLS/app-role checks.
- Fable was unavailable during review, so the review used default Claude Code instead of `claude-fable-5`.
- Postgres was left running and healthy for local verification continuity.
- The branch is not merged.

## Final status

Wave A2 implementation is verified and review-passed. It is ready for PR review against `main`.
