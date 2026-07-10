# Wave A2 Approval Notes

**Date:** 2026-06-26  
**Planning branch:** `wave-a2-tenancy-identity-rls-plan`  
**Implementation branch:** `wave-a2-tenancy-identity-rls`  
**Status:** Binding implementation clarifications from Andrew. These notes refine and constrain `docs/status/WAVE_A2_PLAN.md`.

## Binding decisions

1. **ADR-015 status**
   - ADR-015 should be marked `Accepted` during A2 implementation.

2. **Teams deferred**
   - Defer Teams entirely in A2.
   - Do not create a `teams` table in A2.
   - Do not allow `subject_type = 'team'` in `access.access_relationships` until a real teams table and team membership model exist.

3. **ServicePrincipal and AgentPrincipal**
   - Include minimal `ServicePrincipal` and `AgentPrincipal` tables in A2.
   - Both principal types default-deny all actions unless an action is explicitly allowed.

4. **Local dev identity**
   - Local dev identity uses seeded deterministic users plus a guarded dev resolver.
   - Never accept `tenantId`, `workspaceId`, `userId`, `role`, or permissions directly from public headers.
   - Diagnostic request/trace headers remain non-authenticated metadata only.

5. **Database driver**
   - Use `pg` with Drizzle's node-postgres adapter.
   - Do not add both `pg` and `postgres`.

6. **No vector extension in A2**
   - Do not enable the `vector` extension in A2.
   - Pgvector/search comes later.

7. **`identity.users` RLS**
   - `identity.users` RLS should allow current-user self-read only in A2.
   - Do not implement broad workspace member user listing yet.

8. **Membership and Person linkage**
   - Active memberships should require a linked `Person`.
   - Invited memberships may allow `person_id` to be null if needed.

9. **Same-tenant/workspace integrity**
   - Prefer composite foreign keys and uniqueness constraints for same-tenant/workspace integrity where practical.
   - Use triggers only where PostgreSQL cannot express the invariant cleanly with constraints.

10. **SecurityContext hints are not authority**
    - `requestedSpaceIds`, `membershipIds`, and `roleHints` in `SecurityContext` are audit ceilings/hints only.
    - They are not live authority.
    - `AuthorizationService.can()` and repository methods must recompute current authorization from current database state.

## Scope reaffirmed

Implement Wave A2 only:

- Tenant
- Workspace
- recursive Space
- User
- Person
- Membership
- ServicePrincipal / AgentPrincipal placeholders
- SecurityContext validation
- central `AuthorizationService.can()`
- PostgreSQL schemas and reviewed SQL migrations
- app role and RLS policies
- transaction wrapper using `SET LOCAL`
- dev identity adapter
- minimal `/v1/me`, `/v1/workspaces/:id`, `/v1/spaces/:id` only if useful for denial tests
- cross-tenant, stale-context, pooled-connection, principal-confusion, and restricted-Space denial tests

Do not implement:

- Organization / Initiative / Activity
- SourceArtifact / Claim / AcceptedFact / DerivedView
- ChangeSets
- agent runtime
- MCP adapters
- extraction
- semantic search
- product UI screens
- external integrations
- OpenFGA
- generic Solution Pack runtime
- production WorkOS integration

## Required post-implementation verification

After Codex completes and after any fixes, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:security
```

Claude Code must review the full A2 diff for:

- RLS correctness
- app role lacking `BYPASSRLS`
- `SET LOCAL` discipline
- no repository bypassing `withTenantTransaction`
- no superuser-only tests hiding failures
- User / Person / Membership separation
- Person never authorizes action
- no `subject_type='team'` in database yet
- service/agent principals default deny
- restricted Space denial without title/count/error leakage
- no product scope drift
- no dependency bloat
- no header-sourced authority

## Stop rule

After implementation, verification, Claude review/fixes, and `docs/status/WAVE_A2_RESULT.md`, open a PR to `main` and stop. Do not merge. Do not start Wave A3.
