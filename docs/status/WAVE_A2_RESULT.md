# Wave A2 Result — Tenancy, Identity, and RLS

**Date:** 2026-06-30  
**Branch:** `wave-a2-tenancy-identity-rls`  
**Base:** `main` at Wave A2 planning start, repo local path `/home/ubuntu/throughline`  
**Orchestrator:** Hermes Agent  
**Primary implementation engine:** Codex CLI, then Hermes fixes/verification  
**Reviewer:** Claude Code CLI (Fable requested but unavailable; default Claude Code review completed)

## Summary

Wave A2 implements Throughline's tenancy, identity, authorization, and PostgreSQL RLS foundation only. It keeps scope inside the approved `Tenant → Workspace → recursive Space` model; separates authorization subjects (`User`, `Membership`, `ServicePrincipal`, `AgentPrincipal`) from graph-level `Person`; and uses PostgreSQL RLS plus application `AuthorizationService.can()` as a defense-in-depth boundary.

The implementation at the original A2 result point passed Hermes verification and Claude Code
review. PR #2 then received a focused merge-gate hardening pass on 2026-07-09; the historical
verification and review evidence below predates that pass unless a section explicitly says
otherwise. No Wave A3/product UI/agent runtime/truth-ledger/provider/MCP scope was added.

## What changed

### Root/tooling

- Added root `test:security` script:
  - requires explicit `TEST_DATABASE_URL` and `TEST_APP_DATABASE_URL` before Turbo starts;
  - runs DB and authorization security suites serially with no `DATABASE_URL` fallback.
- Added Turbo environment passthrough for database test URLs:
  - `DATABASE_URL`
  - `TEST_DATABASE_URL`
  - `TEST_APP_DATABASE_URL`
- Updated `pnpm-lock.yaml` after Wave A2 package dependency changes.
- Updated `.env.example` with owner and app-role test database URLs.
- Added GitHub Actions verification on Node.js 22 and PostgreSQL 16/pgvector, including frozen
  install, format, lint, typecheck, ordinary tests, build, and serial `test:security`.

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
- Enforced a strict principal XOR, including rejection of partial user principals even when a
  service or agent principal is present:
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
- Created/configured `throughline_app` with `NOBYPASSRLS` and no canonical migration login secret.
- Granted app role access to schemas/tables/functions while relying on RLS policies for row isolation.
- Added `withTenantTransaction()` wrapper that starts a transaction and sets context via transaction-local `set_config(..., true)` only.
- Replaced raw migration replay with a deterministic, advisory-locked migration journal that
  records filename, SHA-256 checksum, and applied timestamp atomically with each migration;
  repeated unchanged applies are no-ops and checksum drift fails closed.
- Added deterministic seed helpers and test-only app-role login provisioning. Any test password is
  derived only from `TEST_APP_DATABASE_URL` and is never logged.
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
- Required the context policy version to exist live for the current tenant/workspace with
  `status='active'` before any allow or service/agent default-deny decision.
- Recomputed live authorization from the database, rather than trusting context hints.
- Added target-resource checks so `tenant.read` and `workspace.manage_members` cannot allow resources outside the current context.
- Added restricted-ancestor inheritance semantics so inherited Space grants cannot pass through a restricted boundary.
- Added tests for service/agent default-deny, cross-tenant denial, wrong tenant/workspace resource denial, stale-context denial, restricted Space denial, restricted-ancestor inheritance, and Person/principal confusion.

## Binding clarification enforcement

| Binding clarification | Enforcement |
| --- | --- |
| SQL migrations define RLS/policies/roles | RLS, role creation, policies, grants, schemas, tables, and helper functions are in reviewed SQL migration `0001_wave_a2_identity_access_rls.sql`. Drizzle schema mirrors structure only. |
| App role must not have `BYPASSRLS` | Migration creates/configures `throughline_app` with `NOBYPASSRLS`; the app-pool test verifies both `current_user = 'throughline_app'` and `rolbypassrls = false`. |
| Tenant-aware repository operations use `withTenantTransaction` and `SET LOCAL` inside transaction | `withTenantTransaction()` begins a transaction, calls transaction-local `set_config(..., true)`, then commits/rolls back and releases the client. Tests verify no context leaks after the transaction. |
| Tests must not pass only via superuser/owner connections | RLS assertions use `appPool` with explicit `TEST_APP_DATABASE_URL`; owner pool is used only for migrations/seeding/admin checks and test-only role provisioning. |
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

The results in the original subsections below describe the pre-hardening A2 head. First- and
second-hardening-pass commands and results are recorded separately and must not be inferred from
the earlier counts.

### First PR #2 merge-gate hardening verification (2026-07-09)

Fresh commands completed on the hardening working tree:

```text
npm exec -- pnpm format:check: PASS — all files match Prettier style
npm exec -- pnpm lint: PASS — 27/27 Turbo tasks successful
npm exec -- pnpm typecheck: PASS — 27/27 Turbo tasks successful
env -u TEST_DATABASE_URL -u TEST_APP_DATABASE_URL -u DATABASE_URL npm exec -- pnpm test:
  PASS — 27/27 Turbo tasks successful; DB-backed suites skipped as designed
npm exec -- pnpm build: PASS — 21/21 Turbo tasks successful
npm exec -- pnpm test:security with explicit owner/app DSNs:
  PASS — DB 7/7, authorization 14/14, Turbo 5/5
```

The fail-closed preflight was also exercised with no explicit security DSNs and with only
`TEST_DATABASE_URL` present. Both commands exited 1 before Turbo, naming the missing explicit test
DSN(s). With both explicit DSNs loaded, the authoritative PostgreSQL-backed suite ran without skips
and proved migration repeatability/checksum enforcement, the effective `throughline_app` role,
`NOBYPASSRLS`, RLS isolation, active-policy enforcement, pooled-context cleanup, and authorization
denial behavior.

### Second PR #2 merge-gate fix pass verification (2026-07-09)

Fresh commands completed on the second-pass working tree:

```text
npm exec -- pnpm install --frozen-lockfile: PASS
npm exec -- pnpm format:check: PASS — all matched files use Prettier style
npm exec -- pnpm lint: PASS — 27/27 Turbo tasks
npm exec -- pnpm typecheck: PASS — 27/27 Turbo tasks
env -u DATABASE_URL -u TEST_DATABASE_URL -u TEST_APP_DATABASE_URL npm exec -- pnpm test:
  PASS — 27/27 Turbo tasks; DB-backed suites skipped as designed
npm exec -- pnpm build: PASS — 21/21 Turbo tasks
npm exec -- pnpm test:security with no explicit DSNs:
  expected exit 1 before Turbo
npm exec -- pnpm test:security with explicit DSNs:
  PASS — DB 15/15, authorization 14/14, Turbo 5/5
```

The 15-test PostgreSQL DB suite now proves legacy app-role login/password cleanup before explicit
test provisioning, true journal filename/checksum/timestamp metadata, atomic rollback when journal
insert fails, advisory-lock serialization of concurrent callers, deterministic repeated resets,
pre-journal parent-schema adoption followed by a no-op, fail-closed rejection of an unexpected
same-name adoption constraint, search-path-independent structural FK adoption under PostgreSQL 16,
explicit source/target cardinality enforcement when expected columns are absent, app-role identity,
RLS isolation, pooled context cleanup, and Teams-subject rejection. The full root and security gates
passed after the final second-pass edits.

### Final A2 transaction-boundary and RLS-evidence closeout (2026-07-10)

The DB transaction boundary now parses the `SecurityContext`, rejects an elapsed context with the
stable `SecurityContext has expired` error, and only then acquires a pool connection. The focused
unit regression uses a structurally valid context with `issuedAt < expiresAt <= now` and proves that
neither `pool.connect()` nor the transaction callback runs. `PostgresAuthorizationService.can()`
also has a no-database regression proving the same elapsed context returns `context_expired` before
pool access. The pre-existing `expiresAt === issuedAt` tenancy test is now named as non-positive
lifetime validation rather than elapsed-context enforcement.

The PostgreSQL suite adds explicit evidence for all ten A2 protected tables:

- every table is present in the catalog with both `relrowsecurity=true` and
  `relforcerowsecurity=true`;
- `throughline_app`, outside a tenant transaction and with no `app.*` tenant/workspace context,
  sees zero rows across all ten protected tables;
- a Tenant B/workspace B Space insert under Tenant A context is rejected by RLS `WITH CHECK` with
  SQLSTATE `42501`, and an owner query proves no row persisted.

Fresh final-closeout local commands:

```text
npm exec -- pnpm install --frozen-lockfile: PASS
npm exec -- pnpm format:check: PASS
npm exec -- pnpm lint: PASS — 27/27 Turbo tasks
npm exec -- pnpm typecheck: PASS — 27/27 Turbo tasks
env -u DATABASE_URL -u TEST_DATABASE_URL -u TEST_APP_DATABASE_URL npm exec -- pnpm test:
  PASS — 27/27 Turbo tasks; DB-backed suites skipped as designed, ordinary boundary tests ran
npm exec -- pnpm build: PASS — 21/21 Turbo tasks
npm exec -- pnpm test:security with no explicit DSNs:
  expected exit 1 before Turbo
npm exec -- pnpm test:security with explicit DSNs:
  PASS — DB 18/18, authorization 15/15, Turbo 5/5
```

No migration SQL changed in this final closeout pass.

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

That conclusion applies to the pre-hardening diff and is not a review verdict for the 2026-07-09
merge-gate changes.

## Known caveats at the pre-merge closeout

This section preserves the historical caveats recorded before the final exact-head review and
merge. The authoritative post-merge state is recorded in **Final Merge Checkpoint** below.

- `pnpm test` without explicit security DSNs skips DB-backed RLS/security tests by design.
  `pnpm test:security` is authoritative and fails immediately unless both `TEST_DATABASE_URL` and
  `TEST_APP_DATABASE_URL` are explicitly set; it never falls back to `DATABASE_URL`.
- In the original review, Fable was unavailable, so default Claude Code was used instead of
  `claude-fable-5`. The merge-gate hardening requires a new independent exact-head review.
- At this pre-merge checkpoint, the branch had not yet been merged or deployed.

## Pre-merge status (historical)

At this checkpoint, Wave A2 remained limited to tenancy, identity, authorization, and RLS. The migration-specific PASS at
`51b8b6b19b0c39990ff41e4532f0b78193347aec` remains valid for that exact migration scope. The final
closeout adds elapsed-context enforcement at the DB boundary and the missing catalog, no-context,
and mismatched-write RLS evidence without changing migration SQL. PR #2 remains held pending a new
exact-head CI result, an independent incremental exact-head review, and explicit merge authorization.

## Final Merge Checkpoint

PR #2 was squash-merged into `main` after explicit authorization and a fresh fail-closed
pre-merge check.

```text
Authorized PR head: a038a60879fd423684dcb01c39e28666924da682
Merged at: 2026-07-10T04:42:32Z
Merged main: b6b2e41a933fcf18587d721d1e3233c490729d18
Authorized-head and merged-main tree: 6a1cee1819d976998a86f0bb2bc050d992d147b2
Final PR-head CI: 29062645164 — completed / success
Post-merge main CI: 29069663250 — completed / success
Independent exact-head review: PASS — no blocking findings
```

The authorized PR head and merged `main` have the identical tree recorded above. GitHub reports
PR #2 as `MERGED`; the post-merge CI run passed on the exact merged-main SHA.

The scoped A2 implementation—tenancy, identity, centralized authorization, transaction-local RLS
context, and PostgreSQL default-deny evidence—is merged. This does **not** claim that the broader
canonical Wave A foundation is closed. The transactional API/database/outbox path, SQS relay,
idempotent worker consumption, signed asynchronous context reference and rehydration, live worker
reauthorization, queue/cache/object-key isolation, and end-to-end OpenTelemetry propagation remain
deferred to an explicitly approved Foundation Closure implementation.

No deployment was performed. B1 was not started.
