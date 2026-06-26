# Wave A2 Plan — Tenancy, Identity, and RLS

> **For Hermes:** This is a plan-only artifact. Do not implement Wave A2 until Andrew approves this plan.

**Goal:** Establish Throughline's tenant/workspace/space identity and authorization foundation with PostgreSQL RLS as the database backstop and centralized `can()` as the application authorization surface.

**Architecture:** Wave A2 keeps Throughline inside the locked `Tenant → Workspace → recursive Space` model. It separates authenticated authorization subjects (`User`, `Membership`, service/agent principals) from graph-level `Person` records, and runs every tenant-aware repository operation through a transaction wrapper that sets RLS context with `SET LOCAL`.

**Tech Stack:** TypeScript, pnpm/Turborepo, NestJS/Fastify, Drizzle ORM with reviewed SQL migrations, PostgreSQL 16 + pgvector, Vitest integration/security tests.

---

## 1. Goal and non-goals

### Goal

Implement the Wave A2 foundation only:

- `Tenant`
- `Workspace`
- recursive `Space`
- `User`
- `Person`
- `Membership`
- `ServicePrincipal` / `AgentPrincipal` placeholders sufficient for context propagation
- `SecurityContext` hardening
- central `AuthorizationService.can()` v1 behavior
- PostgreSQL schemas, reviewed SQL migrations, RLS policies, and app-role checks
- transaction wrapper using `SET LOCAL`
- automated cross-tenant, stale-context, and principal-confusion denial tests

### Non-goals

Do not implement in Wave A2:

- truth ledger tables or behavior: `SourceArtifact`, `Claim`, `AcceptedFact`, `DerivedView`
- ChangeSets, ProposedOperations, approvals, ExecutionReceipts, or Domain Command Bus
- agent runtime state machine or skill registry
- MCP adapters, provider integrations, Account Research contract implementation, or connector credentials
- extraction, semantic search, pgvector retrieval, summaries, Pulse, or model calls
- product UI screens beyond any minimal API-health/dev diagnostics already present
- OpenFGA or another standalone Zanzibar service
- generic Solution Pack runtime
- production WorkOS AuthKit integration beyond a provider-neutral local/dev adapter seam

Wave A2 is complete when two tenants and two users can be exercised in automated tests with default-deny isolation across API/repository/SQL transaction paths.

## 2. Canonical docs read

Plan drafted after reading:

- `docs/BUILD_SPEC_v0.1.1.md`
  - Locked decisions, sections 4, 5.2, 5.3, 10.1, 15.3, 17, 18/P0-2, 27, 28.
- `docs/IMPLEMENTATION_KICKOFF_v0.1.md`
  - Wave A2 scope and gate.
- `docs/ux/UX_INTERACTION_SPEC_v0.1.md`
  - Confirms no product UI expansion in this wave.
- `docs/PHASE0_DEMO_SCRIPT.md`
  - Early proof needs Tenant, Workspace, root Space, restricted child Space, and User B denial.
- `docs/adr/ADR-015.md`
  - Provider-neutral internal identity; local deterministic dev identity adapter.
- `docs/adr/ADR-016.md`
  - Accepted: every tenant-aware repository operation uses explicit transaction + `SET LOCAL`; app roles cannot bypass RLS; FORCE RLS on tenant tables.
- `AGENTS.md`
  - Locked architecture and no broadening rules.
- `CLAUDE.md`
  - Review expectations: RLS/can(), principal-confusion, cross-tenant tests, no UI/product drift.
- `HERMES_RUNBOOK.md`
  - Wave orchestration and status-artifact discipline.

## 3. Proposed database schema and migration order

Use explicit reviewed SQL migrations in `packages/db/migrations/`. Drizzle schema files can mirror the SQL, but SQL is the reviewed source for RLS and policies.

### Migration 0001 — database schemas and extensions

Create PostgreSQL schemas only:

- `identity`
- `access`
- `ops`

Enable extensions needed now:

- `pgcrypto` for local UUID generation fallback if needed
- `vector` already supplied by pgvector image, but only enable if present; no vector tables in A2

Do not create `truth`, `agent`, `integrate`, or `search` tables in A2 except as empty schemas only if migration tooling requires stable namespace reservation. Prefer not to create unused schemas unless tests need them.

### Migration 0002 — identity tables

Create:

- `identity.tenants`
- `identity.workspaces`
- `identity.users`
- `identity.people`
- `identity.memberships`
- `identity.service_principals`
- `identity.agent_principals`
- `identity.policy_versions`

#### `identity.tenants`

Columns:

- `id uuid primary key`
- `slug text not null unique`
- `name text not null`
- `status text not null check (status in ('active','suspended','deleted'))`
- `default_access_class text not null check (...)`
- `plan_code text not null default 'dev'`
- `auth_provider_ref text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `version integer not null default 1`

Tenant rows are not workspace-scoped. RLS should still restrict them to current `app.tenant_id` for app-role reads.

#### `identity.workspaces`

Columns:

- `id uuid primary key`
- `tenant_id uuid not null references identity.tenants(id)`
- `slug text not null`
- `name text not null`
- `status text not null check (status in ('active','archived'))`
- `profile_id text not null`
- `profile_version text not null`
- `default_space_id uuid null` initially, then filled after root Space creation
- `default_access_class text not null check (...)`
- `model_policy_id text not null default 'default'`
- `retention_policy_id text null`
- timestamps/version

Indexes/constraints:

- unique `(tenant_id, slug)`
- foreign key for `default_space_id` added after `access.spaces` exists, or kept nullable with deferred validation in a later migration.

#### `identity.users`

Columns:

- `id uuid primary key`
- `auth_provider text not null`
- `auth_subject text not null`
- `primary_email text not null`
- `status text not null check (status in ('active','disabled'))`
- timestamps/version

Constraints:

- unique `(auth_provider, auth_subject)`
- unique lower-case email is optional and should not be global authority in v1.

Note: `users` are not tenant-owned because a human identity may later belong to multiple tenants. Access is granted only through memberships.

#### `identity.people`

Columns:

- `id uuid primary key`
- `tenant_id uuid not null`
- `workspace_id uuid not null`
- `display_name text not null`
- `primary_email text null`
- `title_fact_id uuid null` deferred until truth ledger
- `employer_organization_id uuid null` deferred until work graph
- `is_internal boolean not null default false`
- `external_refs jsonb not null default '[]'::jsonb`
- timestamps/version

Constraints:

- composite workspace FK `(tenant_id, workspace_id)` to workspaces if available
- no authorization granted directly to Person records

#### `identity.memberships`

Columns:

- `id uuid primary key`
- `tenant_id uuid not null`
- `workspace_id uuid not null`
- `user_id uuid not null references identity.users(id)`
- `person_id uuid null references identity.people(id)` with same tenant/workspace check
- `role text not null check (role in ('owner','admin','member','viewer'))`
- `status text not null check (status in ('invited','active','suspended'))`
- timestamps/version

Constraints:

- partial unique active membership: `(workspace_id, user_id) where status in ('invited','active')`
- check/trigger that linked `person_id` belongs to same tenant/workspace

#### `identity.service_principals` and `identity.agent_principals`

Create minimal rows to support future worker/security context references:

- `id uuid primary key`
- `tenant_id uuid not null`
- `workspace_id uuid not null`
- `name text not null`
- `purpose text` for service principals: `worker`, `connector`, `system`
- `runtime_policy_id text` for agent principals
- `status text not null check (status in ('active','disabled'))`
- timestamps/version

Do not implement agent runtime behavior.

#### `identity.policy_versions`

Minimal audit/versioning support for `SecurityContext.policyVersion`:

- `id text primary key`
- `tenant_id uuid not null`
- `workspace_id uuid not null`
- `status text not null check (status in ('active','retired'))`
- `description text not null`
- `created_at timestamptz not null default now()`

Seed a `default-v1` policy version in tests only unless a migration seed is explicitly needed.

### Migration 0003 — spaces and access relationships

Create:

- `access.spaces`
- `access.access_relationships`

#### `access.spaces`

Columns:

- `id uuid primary key`
- `tenant_id uuid not null`
- `workspace_id uuid not null`
- `parent_space_id uuid null references access.spaces(id)`
- `kind text not null check (kind in ('workspace_root','team','organization','initiative','project','knowledge'))`
- `name text not null`
- `slug text not null`
- `access_class text not null check (...)`
- `inheritance_mode text not null check (inheritance_mode in ('inherit','restricted'))`
- `archived_at timestamptz null`
- timestamps/version

Constraints:

- unique `(workspace_id, parent_space_id, slug)`
- root invariant: exactly one `workspace_root` per workspace; use partial unique index `(workspace_id) where kind='workspace_root' and archived_at is null`
- trigger/check: `parent_space_id` must be in same tenant/workspace

#### `access.access_relationships`

Columns:

- `id uuid primary key`
- `tenant_id uuid not null`
- `workspace_id uuid not null`
- `subject_type text not null check (subject_type in ('user','team','membership','service_principal','agent_principal'))`
- `subject_id uuid not null`
- `relation text not null check (relation in ('owner','manager','contributor','viewer'))`
- `resource_type text not null`
- `resource_id uuid not null`
- `source text not null check (source in ('direct','inherited','system'))`
- `created_at timestamptz not null default now()`

Do not allow `subject_type='person'`.

### Migration 0004 — RLS context helpers and policies

Add stable helper functions in a private schema, for example `ops.current_tenant_id()`.

Use `current_setting('app.tenant_id', true)` and `NULLIF(..., '')::uuid` to avoid cast crashes when unset. Policies should default deny when settings are missing.

Example helper:

```sql
CREATE SCHEMA IF NOT EXISTS ops;

CREATE FUNCTION ops.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
```

Create equivalent helpers for:

- tenant ID
- workspace ID
- user ID
- membership ID
- service principal ID
- agent principal ID
- policy version

Apply RLS:

- `identity.tenants`: `id = ops.current_tenant_id()`
- `identity.workspaces`: `tenant_id = current tenant AND id = current workspace`
- tenant/workspace tables: `tenant_id = current tenant AND workspace_id = current workspace`
- `identity.users`: readable only through active membership in current workspace; direct writes only through controlled repository methods in tests. If this is too complex for first pass, make `users` app-role inaccessible by default and expose identity resolution through security-definer functions only after review.

Use:

```sql
ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
ALTER TABLE ... FORCE ROW LEVEL SECURITY;
```

### Migration 0005 — app roles and grants

Define database roles for local/test:

- owner/migration role: can create schema and manage policy
- app role: can use schemas and CRUD only where RLS permits; no `BYPASSRLS`

In local Docker, this can be represented by SQL roles and test connection strings. In CI, tests must assert:

```sql
SELECT rolbypassrls FROM pg_roles WHERE rolname = 'throughline_app'; -- false
```

Do not depend on superuser connections for app repository tests.

### Migration 0006 — test seed helpers only

Do not seed production data. Add test helper functions/files under `packages/testing` or `tests/security` that create:

- Tenant A and Tenant B
- Workspace A and Workspace B
- User A and User B
- Person A and Person B
- active memberships
- root Spaces
- restricted child Space for Tenant A

## 4. RLS strategy and example policies

### Principles

1. RLS is default deny.
2. Missing `SET LOCAL` context sees zero tenant/workspace rows.
3. RLS enforces tenant/workspace isolation; `AuthorizationService.can()` enforces action and Space-level permissions.
4. Space filtering is still explicit in repositories. Do not rely on tenant/workspace RLS as a substitute for Space authorization.
5. The app role must not be table owner and must not have `BYPASSRLS`.
6. Every tenant/workspace table uses `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.

### Example tenant/workspace policy

```sql
CREATE POLICY tenant_workspace_isolation
ON access.spaces
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
)
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
);
```

### Example membership-visible users policy

Preferred plan:

- `identity.users` is not broadly queryable.
- Current user can read its own user row.
- Workspace admins/owners can list member identities through a repository method that joins `memberships` under the same RLS context.

Example policy:

```sql
CREATE POLICY users_self_or_workspace_member
ON identity.users
USING (
  id = ops.current_user_id()
  OR EXISTS (
    SELECT 1
    FROM identity.memberships m
    WHERE m.user_id = identity.users.id
      AND m.tenant_id = ops.current_tenant_id()
      AND m.workspace_id = ops.current_workspace_id()
      AND m.status = 'active'
  )
);
```

### Example Person policy

```sql
CREATE POLICY people_tenant_workspace_isolation
ON identity.people
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
)
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
);
```

This makes `Person` visible inside tenant/workspace only; it still does not authorize actions.

## 5. SecurityContext design

### Type changes

Update `packages/core-types/src/index.ts` to align with Build Spec section 4:

- add `actorMembershipId?: string`
- add `actorDisplayPersonId?: string`
- keep `actorUserId?: string`
- add `agentPrincipalId?: string`
- add `servicePrincipalId?: string` because ADR-016 includes service/agent principal context
- keep delegated user/membership fields
- keep `requestedSpaceIds`, `membershipIds`, `roleHints`, `dataClassCeiling`, `policyVersion`, `issuedAt`, `expiresAt`
- represent IDs as branded strings only if low-risk; otherwise keep strings for A2 and consider UUID branding later

### Validation

Add Zod schemas in the package that owns context creation, likely `packages/tenancy` or a new `packages/authorization` file. Do not let API handlers construct contexts by ad hoc object literals.

Validation requirements:

- exactly one tenant and workspace per context
- at least one principal: user/membership, service principal, or agent principal
- `expiresAt > issuedAt`
- `requestedSpaceIds` must be an array and is a ceiling/snapshot only
- `membershipIds` and `roleHints` are hints, not live authority
- diagnostic request/trace IDs remain non-authenticated metadata

### Context source

For A2 local/dev only:

- create a deterministic dev identity adapter that maps explicit test/dev headers or test fixtures to a known User/Membership.
- keep it behind a dev-only guard such as `NODE_ENV !== 'production'` or `AUTH_ADAPTER=dev`.
- never accept `tenantId`, `workspaceId`, `userId`, or `role` directly from arbitrary public headers in production code paths.

## 6. Transaction wrapper design using SET LOCAL

### Package location

Add to `packages/db`:

- `src/client.ts`
- `src/context.ts`
- `src/transaction.ts`
- `src/migrations.ts` if needed by tests

### API shape

```ts
export interface TenantTransactionOptions {
  context: SecurityContext;
}

export async function withTenantTransaction<T>(
  options: TenantTransactionOptions,
  fn: (tx: TenantDbTransaction) => Promise<T>
): Promise<T>;
```

### Behavior

Inside one explicit transaction:

1. Validate the `SecurityContext`.
2. Execute parameterized statements:
   - `SET LOCAL app.request_id = $1`
   - `SET LOCAL app.trace_id = $1`
   - `SET LOCAL app.tenant_id = $1`
   - `SET LOCAL app.workspace_id = $1`
   - `SET LOCAL app.user_id = $1` when present
   - `SET LOCAL app.membership_id = $1` when present
   - `SET LOCAL app.service_principal_id = $1` when present
   - `SET LOCAL app.agent_principal_id = $1` when present
   - `SET LOCAL app.policy_version = $1`
3. Run the repository function.
4. Commit or rollback.

Never use connection-level `SET`. Tests must prove context does not leak between transactions on a reused pooled connection.

### Driver choice

Preferred: use Drizzle with the `postgres` driver or `pg`, whichever is smallest and aligns with Drizzle migration/testing ergonomics.

Document any new production dependency in README or package docs before adding it.

## 7. AuthorizationService.can() v1 behavior

### Package location

Implement in `packages/authorization`:

- `src/types.ts`
- `src/authorization-service.ts`
- `src/space-access.ts`
- tests under `packages/authorization/src/*.spec.ts`

### Actions for A2

Keep action vocabulary intentionally small:

- `tenant.read`
- `workspace.read`
- `workspace.manage_members`
- `space.read`
- `space.create_child`
- `space.manage_access`
- `identity.me.read`
- `membership.read`

Do not add work graph, truth ledger, ChangeSet, agent, or integration actions yet.

### Decisions

Return Build Spec-compatible decisions:

```ts
export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  explanation?: string;
  policyVersion: string;
  evaluatedRelationships?: string[];
}
```

### v1 allow rules

- Missing/expired context: deny.
- Wrong tenant/workspace: deny.
- Suspended/disabled user or membership: deny.
- `owner`: may manage workspace membership and access.
- `admin`: may manage membership/access except owner-only tenant-level decisions.
- `member`: may read workspace root and spaces granted by membership/relationships.
- `viewer`: read only.
- `service_principal` / `agent_principal`: deny all except explicitly allowed internal actions added later. For A2, use only enough to prove context propagation and default deny.
- `Person`: never a subject and never sufficient for allow.

### Space access

For A2, implement recursive Space access conservatively:

- Workspace owners/admins can read all non-archived spaces in their workspace.
- Members/viewers can read workspace root.
- Direct `access_relationships` grant can allow read/manage on a Space.
- Child spaces inherit unless `inheritance_mode='restricted'`.
- Restricted child Space requires direct relationship or owner/admin role.

Avoid deep optimized recursive SQL in first pass unless needed. A simple recursive CTE is acceptable and should be tested.

## 8. User / Person / Membership distinction

Do not collapse these records.

### User

Authenticated product identity:

- auth provider
- auth subject
- primary email
- active/disabled status

A User may eventually have memberships in multiple tenants/workspaces.

### Person

Graph/work-memory human/contact:

- may be internal or external
- can represent customers and partners
- can own work graph relationships
- can appear in facts, engagements, initiatives, and sources later
- never authorizes actions directly

### Membership

Authorization bridge:

- connects User to Tenant/Workspace
- holds role and status
- may link to a Person for display/work graph continuity
- active Membership is required for user authority in a Workspace

Principal-confusion tests must prove an external Person with no active Membership cannot approve/manage/read as a user.

## 9. Tenant / Workspace / Space model

### Tenant

Customer/account boundary. Holds plan/auth-provider defaults and governs export/deletion later.

### Workspace

Policy, integration, model-usage, retention, profile, connector, and billing/work boundary. A Tenant can have multiple Workspaces later. Initial UI may expose one transparently.

### Space

Recursive work/knowledge container.

- every workspace has one root Space
- organization/initiative/project/knowledge spaces appear later
- access control is Space-aware and must be compatible with v1 Space-scoped semantic retrieval

A2 should implement only generic Spaces and the root/restricted-child behaviors needed for security tests.

## 10. API endpoints to add, if any

Keep API surface minimal and test-oriented. Do not build product UI.

Recommended A2 endpoints:

- `GET /v1/me`
  - returns current User, active Membership, Workspace, Tenant, and root Space summary for the resolved dev/test context.
- `GET /v1/workspaces/:workspaceId`
  - owner/member read; must deny cross-tenant/cross-workspace.
- `GET /v1/spaces/:spaceId`
  - uses `can(ctx, 'space.read', ...)`; must deny restricted child Space without grant.

Optional only if needed for tests:

- `POST /v1/dev/bootstrap-tenancy`
  - dev/test only, disabled outside local/test; creates deterministic test tenants/users/spaces.

Prefer test helpers over public mutation endpoints for seeding. Do not add invitations or membership-management UI/API beyond what tests require unless Andrew approves.

## 11. Test plan

### Unit tests

- `packages/core-types`: SecurityContext type/schema validation.
- `packages/authorization`: `can()` role matrix and deny reasons.
- `packages/tenancy`: dev identity adapter and context assembly behavior.
- `packages/db`: context SQL generation and transaction wrapper validation.

### Integration/security tests

Create `tests/security/` and/or package-level integration tests using local Postgres from Docker Compose.

Required commands:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:security
```

Add a root script if useful:

```json
"test:security": "turbo test --filter=@throughline/testing --filter=@throughline/db --filter=@throughline/authorization"
```

Security tests should start from migrated local Postgres and use the app role, not a superuser.

### Migration tests

- clean database migration succeeds
- app role lacks `BYPASSRLS`
- tenant tables have RLS enabled and forced
- no tenant-aware repository method can run outside `withTenantTransaction`

## 12. Cross-tenant denial test cases

A2 must include automated tests proving:

1. **No context denies:** app role querying tenant tables without `SET LOCAL` returns zero rows or errors safely.
2. **Tenant A cannot read Tenant B workspace:** repository and direct SQL through app role deny/return zero.
3. **Tenant A cannot insert Tenant B row:** `WITH CHECK` policy rejects mismatched tenant/workspace.
4. **Workspace A cannot read Workspace B in same tenant:** workspace-scoped RLS denies/returns zero.
5. **User B cannot read restricted child Space X:** root Space may be visible, restricted child absent/forbidden.
6. **Person is not principal:** a Person linked to a contact without active Membership cannot satisfy `can()`.
7. **Suspended membership denies:** existing User + suspended Membership cannot read workspace data.
8. **Stale context denies:** context with inactive policy version or expired `expiresAt` is rejected before DB work.
9. **Pooled connection context does not leak:** transaction A sets Tenant A; transaction B without context or with Tenant B cannot see Tenant A.
10. **Worker/service principal default deny:** service/agent principal has no broad read unless explicitly granted.
11. **API route denial:** `GET /v1/spaces/:spaceId` cannot leak a restricted Space by ID.
12. **Error shape denial:** denied responses must not leak names/titles/counts from unauthorized tenant/space rows.

## 13. Async/job context propagation considerations

Do not implement queue-backed signed context references yet unless needed for the A2 gate. Plan the seam now:

- `SecurityContext` is persisted or rehydratable by opaque context reference, not editable queue payload.
- Queue payloads later carry `{ contextRef, traceId, requestId }`, not tenant/user/role authority fields.
- Workers rehydrate context from DB and re-run current authorization before work.
- `requestedSpaceIds` and membership hints are audit ceilings only.
- A2 may add types/tests showing that worker skeletons cannot accept arbitrary tenant/workspace headers as authority.
- A2 should not implement AgentRun, outbox processing, or SQS semantics unless Andrew expands scope.

## 14. Risks and open questions

### Risks

1. **RLS testing can accidentally use owner/superuser.** Mitigation: create and test a non-owner app role; assert `rolbypassrls=false`.
2. **Users table is cross-tenant by nature.** Mitigation: avoid broad `users` repository reads; resolve current user through membership-bound paths.
3. **Recursive Space access can balloon.** Mitigation: implement only root + direct grant + restricted child inheritance semantics now.
4. **Dev identity can become fake production auth.** Mitigation: explicit dev adapter, disabled in production, documented non-production-only.
5. **Header-sourced context confusion.** Mitigation: diagnostic request/trace headers remain separate; identity context comes from dev adapter/test fixtures, not arbitrary request headers.
6. **Drizzle migration/RLS ergonomics.** Mitigation: reviewed SQL migrations for RLS, with Drizzle schema as typed convenience.
7. **A2 scope creep into P0-3/P0-4.** Mitigation: no Organization/Initiative/Activity/Source/Claim tables.

### Open questions for Andrew before implementation

1. Should ADR-015 be marked Accepted before A2 lands, or should A2 include a small ADR status update PR/commit?
2. Should A2 include minimal `teams` table now because `AccessRelationship.subjectType` includes `team`, or defer teams and keep the enum reserved but unused?
3. Should `ServicePrincipal` be in A2 schema because the build spec defines it, even though the kickoff bullet names only `AgentPrincipal`?
4. Should local dev identity use seeded deterministic users only, or a dev-only request header that maps to seeded users? Recommended: seeded users plus a guarded dev resolver, never raw authority headers.
5. Which DB driver should be standard with Drizzle in this repo: `postgres` or `pg`? Recommended: choose one in the A2 implementation plan and document why before adding dependency.

## 15. Proposed implementation order

Do not execute until this plan is approved. When approved, implement in small TDD steps:

1. Add DB driver and migration tooling scripts to `packages/db` and root `package.json`.
2. Add empty migration runner test that connects to local Postgres.
3. Add migration 0001 for schemas/helpers and verify clean migration.
4. Add identity table migration and migration test.
5. Add access Space/relationship migration and migration test.
6. Add app role/grants/RLS migration and assertions for `rolbypassrls=false`, RLS enabled, FORCE RLS.
7. Add TypeScript table/schema definitions matching reviewed SQL.
8. Add `SecurityContext` validation schema and tests.
9. Add transaction wrapper with `SET LOCAL` and tests for missing/no-leak context.
10. Add seed/test helpers for two tenants, two workspaces, two users, memberships, root Spaces, restricted child Space.
11. Implement `AuthorizationService.can()` v1 with role matrix tests.
12. Implement Space access helper with restricted child tests.
13. Add minimal API context resolver for dev/test and `GET /v1/me`.
14. Add minimal `GET /v1/workspaces/:workspaceId` and `GET /v1/spaces/:spaceId` if needed for API-level denial tests.
15. Add API/security tests for cross-tenant and restricted Space denial.
16. Update README and `docs/status/WAVE_A2_RESULT.md` only during implementation/result phase, not in this plan branch.
17. Ask Claude Code to review the A2 diff before fixes/PR.

## 16. Files/packages expected to change

Expected implementation files after plan approval:

### Root

- `package.json`
- `pnpm-lock.yaml`
- `README.md` only for A2 setup/test docs
- possibly `.env.example` for app-role/test DB URLs

### Database

- `packages/db/package.json`
- `packages/db/src/client.ts`
- `packages/db/src/context.ts`
- `packages/db/src/transaction.ts`
- `packages/db/src/schema/identity.ts`
- `packages/db/src/schema/access.ts`
- `packages/db/src/migrations.ts`
- `packages/db/migrations/*.sql`
- `packages/db/src/*.spec.ts`

### Core and tenancy

- `packages/core-types/src/index.ts`
- `packages/tenancy/src/index.ts`
- `packages/tenancy/src/security-context.ts`
- `packages/tenancy/src/dev-identity-adapter.ts`
- `packages/tenancy/src/*.spec.ts`

### Authorization

- `packages/authorization/src/index.ts`
- `packages/authorization/src/types.ts`
- `packages/authorization/src/authorization-service.ts`
- `packages/authorization/src/space-access.ts`
- `packages/authorization/src/*.spec.ts`

### API

- `apps/api/src/app.module.ts`
- `apps/api/src/context/*`
- `apps/api/src/me/*`
- optional `apps/api/src/workspaces/*`
- optional `apps/api/src/spaces/*`
- route tests proving denial

### Workers

- Only type/context seam updates if needed.
- Do not implement queue/job runtime in A2.

### Tests

- `tests/security/cross-tenant-denial.test.ts`
- `tests/security/rls-context.test.ts`
- `tests/security/principal-confusion.test.ts`
- `packages/testing/src/*` helpers

### Status docs

- `docs/status/WAVE_A2_PLAN.md` already exists on this planning branch.
- `docs/status/WAVE_A2_RESULT.md` should be written only after implementation is approved and completed.

## 17. What Claude Code should specifically review

Ask Claude Code to review the A2 implementation diff for:

1. **Spec drift:** preserves Tenant → Workspace → recursive Space and User/Person/Membership separation.
2. **RLS correctness:** all tenant/workspace tables use RLS and FORCE RLS; app role lacks `BYPASSRLS`; no superuser-only tests hide failures.
3. **SET LOCAL discipline:** no connection-level `SET`; no repository method bypasses transaction wrapper.
4. **Principal confusion:** `Person` is never an authorization subject; external contacts cannot approve/read by personhood.
5. **Default deny:** missing/stale/expired context denies before DB work and through RLS.
6. **Space semantics:** restricted child Space denial works and does not leak titles/counts/error details.
7. **No product drift:** no truth ledger, ChangeSets, MCP, extraction, semantic search, product UI, integrations, or agent runtime behavior.
8. **Dependency bloat:** DB/runtime validation additions are minimal and documented.
9. **Test quality:** cross-tenant denial tests cover API, repository, direct SQL through app role, and pooled context leakage.
10. **Header safety:** diagnostic request/trace headers are not identity, tenant, workspace, or permission authority.

## Stop condition

Stop here for Andrew approval. Do not ask Codex to implement and do not modify application code for Wave A2 until this plan is approved.
