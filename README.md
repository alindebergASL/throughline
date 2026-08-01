# Throughline

Throughline is an AI-native Work OS identified by active, trusted organizational memory. The
first product is Account & Partner Operations, the first domain profile is AI Solutions, and the
first loop is Engagement -> Memory -> Action.

Wave A2, Foundation Closure, B1.0, B1, and B2 Slice 1 are merged. None has been deployed. The
current branch is the bounded B2 Slice 2 trusted-objective walking slice: one Initiative turns a
manually captured engagement excerpt into a proposed Claim and an explicitly accepted Fact through
the canonical durable command buses. General ChangeSets, model extraction, Account Research MCP,
search, production auth, and broader product UI remain deferred.

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

## B2 Slice 2 local browser demo

The demo identity seam is development-only and controlled only by API startup configuration. Set
`TRUSTED_OBJECTIVE_DEMO_PERSONA` to exactly `owner` or `unavailable` before starting the API.
The API maps those values internally to fixed `AUTH_ADAPTER=dev` identities. Missing, blank, or
any other value fails closed. Browser requests contain only the
Initiative identifier and action data; they contain no identity, tenant, workspace, membership,
role, permission, policy, visibility, evidence-offset/hash, or acceptance-authority fields. Both
the API demo guard and the BFF fail closed in production. The web server has no persona or authority
configuration.

Start the local PostgreSQL service, choose a URL-safe local-only password without committing it,
and explicitly reset the fixed disposable `throughline_demo` database:

```bash
docker compose up -d postgres
export DEMO_ADMIN_DATABASE_URL="postgres://throughline:throughline_dev@localhost:5432/throughline"
export DEMO_APP_ROLE_PASSWORD="choose-a-local-demo-password"
pnpm demo:trusted-objective
```

The setup command refuses to run without `--reset` (included by the package script), accepts only a
loopback admin URL outside `throughline_demo`, drops and recreates only that fixed demo database,
applies current migrations, provisions the existing least-privilege `throughline_app` login, and
seeds only tenant/workspace/Space/person/membership/organization/Initiative/Engagement
prerequisites. It never seeds a SourceArtifact, Claim, or AcceptedFact.

Use this setup only with the disposable local Compose PostgreSQL cluster. `ALTER ROLE
throughline_app` is cluster-wide, and `DEMO_APP_ROLE_PASSWORD` rotates that shared role credential;
the change can affect other databases in the same cluster. Automated tests can re-provision the
role, but any manually configured DSNs using `throughline_app` must be updated. Full prerequisite
seeding also requires the existing product-relay service principal provisioned by the migrations.

Start the API in one terminal:

```bash
export AUTH_ADAPTER=dev
export TRUSTED_OBJECTIVE_DEMO_PERSONA=owner
export DATABASE_URL="postgres://throughline_app:${DEMO_APP_ROLE_PASSWORD}@localhost:5432/throughline_demo"
pnpm --filter @throughline/api dev
```

Start the same-origin web app for the representative owner flow in another terminal:

```bash
export THROUGHLINE_API_ORIGIN="http://127.0.0.1:3001"
pnpm --filter @throughline/web dev
```

Open the fixed URL reported by setup, or:

```text
http://localhost:3000/organizations/initiatives/70000000-0000-7000-8000-000000000204
```

After the database and two servers are running, the normal owner walking flow below needs no CLI
or direct API assistance. Every capture, proposal, acceptance, and draft action is completed in the
product UI.

### Five-minute representative-user script

1. Paste this realistic note and choose **Capture engagement note**:

   ```text
   Maya: The primary objective is to reduce average resident-service response time from twelve business days to five while preserving human review.
   Erin: Human review remains mandatory before any response is sent to a resident.
   Luis: The source systems are ServiceNow, SharePoint, and the legacy case database.
   ```

2. In the read-only source, select the complete Maya sentence and choose **Use selected excerpt**.
3. Enter `Reduce average resident-service response time from twelve business days to five while preserving human review.` and choose **Propose trusted objective**.
4. Confirm the page says **Proposed, not accepted.**, open the exact evidence, then choose **Accept objective**.
5. Inspect the complete Accepted memory: objective, excerpt/source, reason, transition, actor/time,
   and effective visibility. Choose **Draft confirmation question** and confirm **Not sent** and
   `sent: false`.

Validate unauthorized behavior with a separately configured API session. Stop both development
servers, restart the API with the exact unavailable persona, then restart the unchanged web server
and open the same fixed URL in a separate browser context:

```bash
export TRUSTED_OBJECTIVE_DEMO_PERSONA=unavailable
pnpm --filter @throughline/api dev
```

```bash
export THROUGHLINE_API_ORIGIN="http://127.0.0.1:3001"
pnpm --filter @throughline/web dev
```

The page must show only the generic unavailable state. There is no in-product identity control and
no browser URL or request field that can select either behavior.

The owner-review screenshots, browser proof, accessibility checklist, and success criteria are in
[`docs/qa/b2-slice2-trusted-objective/`](docs/qa/b2-slice2-trusted-objective/README.md).
This is deterministic engineering/demo coverage, not completed human usability testing.

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
pnpm test:security
```

`pnpm test:security` is the authoritative PostgreSQL/RLS suite. It fails before Turbo starts unless
both `TEST_DATABASE_URL` (the owner/migration connection) and `TEST_APP_DATABASE_URL` (the
application connection) are explicitly present. It never falls back to `DATABASE_URL` and never
derives one connection string from the other. For the local Compose database, load the explicit
test values from `.env.example` before running it:

```bash
set -a
. ./.env.example
set +a
pnpm test:security
```

Ordinary `pnpm test` remains usable without those variables and skips PostgreSQL-backed suites in
that case. The dedicated security command never skips them. Security tests provision
`throughline_app` login access from `TEST_APP_DATABASE_URL` through the owner connection, without
logging the credential; the canonical schema migration contains no login secret. The tests also
prove that the app pool's `current_user` is exactly `throughline_app` and that the role has
`NOBYPASSRLS`.

Run the focused Wave A1 smoke tests:

```bash
pnpm test:smoke
```

Run the repository-owned regression for disposable PostgreSQL/LocalStack harness cleanup:

```bash
pnpm test:docker-harness
```

Future direct Docker verification gates must use `scripts/throughline-docker-harness.sh` as documented
in `HERMES_RUNBOOK.md`; it records immutable container IDs, deterministically removes each exact test
container's anonymous volumes, and fails if the run leaves any new dangling volume.

Wave A2 migrations are applied in deterministic filename order through a durable
`throughline_migrations.journal`. Each filename, SHA-256 checksum, and applied timestamp is
recorded atomically with its SQL. Reapplying an unchanged migration is a no-op; changing an applied
migration's checksum fails closed. Test resets remove and recreate the application schemas and
journal deterministically.

GitHub Actions runs Node.js 22 with PostgreSQL 16/pgvector, a frozen install, formatting, lint,
typechecking, ordinary tests, build, and the serial PostgreSQL-backed security suite. CI uses
isolated PostgreSQL trust authentication and explicit passwordless test DSNs rather than a
committed reusable credential.

## Dependency notes

Production dependencies are limited to the requested Wave A stack: Next.js/React for `apps/web`,
NestJS with the Fastify adapter for `apps/api`, Drizzle plus `pg` for PostgreSQL access, Zod for
runtime SecurityContext validation, and a small Fastify helmet plugin for default HTTP hardening.
Local S3/SQS placeholders use LocalStack in Docker Compose and are not required for compile or unit
tests.

## Current proof

```text
Untrusted engagement source
  → mechanically verified claims
  → governed ChangeSet review
  → authorized AcceptedFacts
  → permission-correct cited views
```
