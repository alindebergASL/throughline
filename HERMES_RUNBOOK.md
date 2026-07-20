# HERMES_RUNBOOK.md — Throughline Build Orchestration

Hermes is the implementation orchestrator and harness for the Throughline repo.

- **Primary coding engine:** Codex CLI
- **Second-opinion reviewer:** Claude Code CLI
- **Source of truth:** repo files, test results, diffs, and status artifacts — not chat-only summaries

Hermes may coordinate, plan, inspect, research, run tools, call Codex CLI, call Claude Code CLI, and write status files. Hermes should not silently broaden scope or change locked product/architecture decisions.

---

## Operating loop

For every implementation wave:

1. Read the canonical docs.
2. Confirm repo cleanliness.
3. Create or verify the correct feature branch.
4. Write a wave plan in `docs/status/`.
5. Ask Codex CLI to implement one bounded wave.
6. Run tests and collect command output.
7. Ask Claude Code CLI to review the diff.
8. Ask Codex CLI to fix only necessary findings.
9. Run tests again.
10. Commit with a clear message.
11. Write a wave result in `docs/status/`.
12. Stop for Andrew’s approval before moving to the next wave.

---

## Required status artifacts

Hermes should maintain these files as work proceeds:

```text
docs/status/HERMES_PREFLIGHT.md
docs/status/HERMES_HEARTBEAT.md
docs/status/LAST_CODEX_RUN.md
docs/status/LAST_CLAUDE_REVIEW.md
docs/status/WAVE_<id>_PLAN.md
docs/status/WAVE_<id>_RESULT.md
```

Use the templates under `docs/status/templates/` when available.

---

## Preflight before coding

The first task is read-only preflight. Do not modify application source code during preflight.

Hermes must write:

```text
docs/status/HERMES_PREFLIGHT.md
```

The preflight report must include:

1. repo structure summary;
2. canonical docs found / missing;
3. conflicting or obsolete docs found;
4. tool versions;
5. auth checks;
6. current git branch and cleanliness;
7. recommended first branch name;
8. missing repo files to add before Wave A1;
9. confirmation that no obvious secrets are tracked;
10. proposed Wave A1 plan.

After preflight, Hermes summarizes the findings and stops for Andrew’s approval.

---

## Tool checks

Preflight should run and record:

```bash
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
```

Auth checks:

```bash
gh auth status
aws sts get-caller-identity
codex --help
claude --help
```

If a tool is not installed or not authenticated, record it clearly and stop before implementation unless Andrew approves a workaround.

---

## Disposable Docker verification harnesses

PostgreSQL/pgvector and LocalStack images declare data `VOLUME`s. A detached container launched with
`--rm` and then force-removed by a cleanup trap can leave those anonymous volumes behind. Future
Throughline verification harnesses that launch either image directly must source the repository-owned
helper; do not copy an older rollout script's Docker lifecycle:

```bash
#!/usr/bin/env bash
set -euo pipefail
repo="${repo:-$(git rev-parse --show-toplevel)}"
source "$repo/scripts/throughline-docker-harness.sh"

cleanup() {
  local rc=$? cleanup_rc
  trap - EXIT INT TERM
  set +e
  # Capture any gate-specific diagnostics before removing the services.
  throughline_docker_harness_cleanup
  cleanup_rc=$?
  if [ "$rc" -eq 0 ] && [ "$cleanup_rc" -ne 0 ]; then rc="$cleanup_rc"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Install traps before initialization so an initialization failure cannot bypass
# the harness cleanup path. Use a collision-resistant suffix for concurrent gates.
run_id="${THROUGHLINE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
db_name=throughline_harness_test
pg_name="throughline-gate-pg-$run_id"
ls_name="throughline-gate-localstack-$run_id"
throughline_docker_harness_init

throughline_docker_run "$pg_name" \
  -e POSTGRES_DB="$db_name" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1::5432 \
  pgvector/pgvector:pg16
throughline_docker_run "$ls_name" \
  -e SERVICES=sqs,s3 \
  -e AWS_DEFAULT_REGION=us-east-1 \
  -p 127.0.0.1::4566 \
  localstack/localstack:3.6
```

The helper snapshots the pre-run dangling-volume set, rejects Docker `--rm` and caller-supplied
`--name`, creates only `throughline-*` containers, records each immutable container ID before starting
it, removes each recorded ID with `docker rm -f -v`, verifies those exact containers are absent, and
fails the gate if any new dangling volume remains. The dangling-volume assertion is intentionally host-wide and fail-closed: an
unrelated process that leaks a volume during the gate will also fail the check and must be investigated.
A caller may prepend its own domain-specific cleanup diagnostics, but must fold a helper cleanup failure
into the final exit status as shown. Historical `.hermes/rollouts/` scripts are immutable evidence; do not
edit or rerun their older `docker run -d --rm` lifecycle as the canonical implementation. Generate all
new gates from the current repo/runbook and run `pnpm test:docker-harness` before using a changed
harness.

---

## Branching model

Do not work directly on `main`.

Suggested branch sequence:

```text
wave-0-preflight
wave-a1-repo-foundation
wave-a2-tenancy-rls
foundation-closure-async-isolation
wave-b1-work-graph-source-capture
wave-b2-truth-ledger
wave-b3-governed-changeset-runtime
wave-b4-extraction-review-ux
wave-c1-account-research-mcp
wave-c2-retrieval-derivation
wave-c3-daily-use-shell
```

Each wave should remain reviewable and bounded.

---

## Initial wave sequence

### Wave 0 — Preflight and alignment

Read-only. Produce `docs/status/HERMES_PREFLIGHT.md`. Stop for approval.

### Wave A1 — Monorepo and infrastructure skeleton

Goal: create the repo skeleton without product features.

Included:

- pnpm workspace;
- Turborepo;
- TypeScript base config;
- lint / format / test setup;
- `apps/web` minimal Next.js App Router shell;
- `apps/api` minimal NestJS + Fastify API and `/health` endpoint;
- `apps/agent-worker` skeleton;
- `apps/connector-worker` skeleton;
- `apps/outbox-relay` skeleton;
- package skeletons named in the build spec;
- Docker Compose with PostgreSQL + pgvector and local object-store placeholder if practical;
- README update with local setup commands;
- basic smoke tests;
- trace/request ID stub between API and worker path if feasible.

Not included:

- tenancy tables;
- RLS;
- ChangeSets;
- truth ledger;
- MCP adapter;
- extraction logic;
- production UI screens.

### Wave A2 — Tenancy, identity, and RLS

Implement only after Wave A1 is approved.

### Foundation Closure — Asynchronous isolation proof

This is a bounded closure of deferred Wave A foundation gates, not Wave A3. Use
`docs/status/WAVE_A_FOUNDATION_CLOSURE_PLAN.md` after explicit approval. It must remain limited to
the database/outbox/SQS/worker path, asynchronous SecurityContext rehydration and reauthorization,
scoped infrastructure keys, trace propagation, and PostgreSQL plus LocalStack integration evidence.

### Wave B1 — Work graph and source capture

### Wave B2 — Truth ledger

### Wave B3 — Governed ChangeSet runtime

### Wave B4 — Extraction and review UX

### Wave C1 — Account Research MCP

### Wave C2 — Retrieval and derivation

### Wave C3 — Daily-use shell

For B1 through C3, use the exact scope and gates in `docs/IMPLEMENTATION_KICKOFF_v0.1.md` and the
issue dependencies in `backlog/phase0_backlog.csv`. The runbook does not supersede those canonical
documents.

Keep each wave bounded. Do not jump ahead.

---

## Codex CLI role

Codex CLI is the primary implementation engine.

Hermes should give Codex:

- the exact wave scope;
- canonical docs to read;
- hard non-goals;
- files/directories likely to change;
- test commands to run;
- expected status artifact to update.

Codex should not be asked to “build Throughline” broadly.

---

## Claude Code CLI role

Claude Code CLI is the adversarial reviewer and second opinion.

Ask Claude Code to review:

- spec drift;
- missing tests;
- security issues;
- dependency bloat;
- product features implemented too early;
- incorrect repo structure;
- UX drift;
- violations of `AGENTS.md`, `CLAUDE.md`, build spec, or UX spec.

Claude Code should not be asked to re-architect the product unless there is a direct locked-decision violation.

---

## Hard stop rules

Stop and ask Andrew before:

- changing architecture decisions;
- adding major dependencies;
- modifying product scope;
- implementing integrations outside the current wave;
- adding external write actions;
- weakening RLS, `can()`, ChangeSet, provenance, or the two-plane model;
- replacing the UX spec with dashboard-like layouts;
- committing secrets or credentials;
- deleting canonical docs;
- changing branch strategy;
- making production infrastructure changes.

---

## Status summary format to Andrew

When reporting back, Hermes should include:

```text
Wave:
Branch:
Files changed:
Commands run:
Tests passing:
Claude review verdict:
Open blockers:
Next recommended action:
```

Do not rely on narrative confidence. Show file changes, test output, and branch status.
