# Hermes Preflight Report

**Date:** 2026-06-26T18:25:18Z  
**Repo:** `alindebergASL/throughline` at `/home/ubuntu/throughline`  
**Remote:** `origin https://github.com/alindebergASL/throughline.git`  
**Branch:** `wave-0-preflight` for this status artifact; preflight started from clean `main` at `8331fcf`  
**Hermes version:** Hermes Agent v0.17.0 (2026.6.19), upstream `7cd5eaa6`  
**Operator:** Andrew

## 1. Repo structure summary

Current repo is a Phase 0/1 kickoff/documentation package, not yet an implementation monorepo.

Top-level tracked structure:

- `AGENTS.md`, `CLAUDE.md`, `HERMES_RUNBOOK.md`: implementation/review/runbook rules.
- `README.md`, `CHANGELOG.md`, `VALIDATION.md`: kickoff package metadata and validation notes.
- `docs/`: canonical build/kickoff/demo docs, ADRs, status templates, reference architecture copies, UX spec/mockups.
- `backlog/`: Phase 0 CSV and Markdown backlog, including `TL-001` through the Phase 0 issue set.
- `profiles/`: first domain profile, `ai-solutions.v1.json`.
- `contracts/`: provider-neutral account intelligence contract.
- `tests/fixtures/`: three synthetic transcript fixtures and expected outputs.
- `prompts/`: non-canonical kickoff prompts.

Implementation skeletons are not present yet: no `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `apps/`, `packages/`, Docker Compose file, TypeScript config, lint/format/test config, or CI config are currently tracked.

## 2. Canonical docs found / missing

All existing requested files, ADRs, and fixtures were read in full. The requested UX path is missing, but a likely same-version counterpart exists under a different filename.

| File | Status | Notes |
|---|---:|---|
| `docs/BUILD_SPEC_v0.1.1.md` | found | 2,872 lines; canonical build/spec baseline. |
| `docs/IMPLEMENTATION_KICKOFF_v0.1.md` | found | 258 lines; wave order and implementation operating model. |
| `docs/ux/UX_INTERACTION_SPEC_v0.1.md` | **missing** | Requested by Andrew/AGENTS/CLAUDE/prompts, but not tracked at this path. |
| `docs/ux/throughline_ux_interaction_spec_v0.1.md` | found counterpart | 2,234 lines; appears to be the intended UX spec. Should be renamed/copied or canonical references updated before Wave A1 implementation prompts rely on it. |
| `docs/PHASE0_DEMO_SCRIPT.md` | found | 24 lines; pass condition. |
| `backlog/phase0_backlog.csv` | found | 44 lines; Phase 0 issue table. |
| `backlog/phase0_backlog.md` | found | 304 lines; issue details. |
| `profiles/ai-solutions.v1.json` | found | 306 lines; valid published AI Solutions profile. |
| `contracts/account-intelligence-provider.ts` | found | 88 lines; read-only provider contract; provider findings map to SourceArtifacts/Claims, not AcceptedFacts. |
| `docs/adr/*.md` | found | ADR-015 through ADR-022 present. |
| `tests/fixtures/README.md` | found | Fixture overview. |
| `tests/fixtures/expected/*.json` | found | `adversarial_injection`, `conflict_workshop`, `normal_discovery`. |
| `tests/fixtures/transcripts/*.txt` | found | `adversarial_injection`, `conflict_workshop`, `normal_discovery`. |
| `AGENTS.md` | found | Throughline implementation rules. |
| `CLAUDE.md` | found | Claude Code review role/checklist. |
| `HERMES_RUNBOOK.md` | found | Hermes orchestration loop and status artifact requirements. |

ADR files present:

- `docs/adr/ADR-015.md` — Auth provider and local-development identity strategy.
- `docs/adr/ADR-016.md` — PostgreSQL transaction and RLS context.
- `docs/adr/ADR-017.md` — Source normalization, chunking, offsets, and citation verification.
- `docs/adr/ADR-018.md` — Access-class lattice and redaction/republication.
- `docs/adr/ADR-019.md` — Domain Command Bus and optimistic concurrency.
- `docs/adr/ADR-020.md` — Agent workflow durability, retries, atomic groups, and compensation.
- `docs/adr/ADR-021.md` — Initial model provider and evaluation baseline.
- `docs/adr/ADR-022.md` — Account Research MCP transport and authorization.

## 3. Conflicting or obsolete docs found

Treat these as non-canonical unless Andrew explicitly references them:

- `docs/ARCHITECTURE_BRIEF_v0.3_reference.md`
- `docs/architecture/reference/ARCHITECTURE_BRIEF_v0.3_reference.md`
- `docs/reference/ARCHITECTURE_BRIEF_v0.3_reference.md`

These appear to be archived/reference copies of an older architecture brief. They should not override `docs/BUILD_SPEC_v0.1.1.md`.

UX mockups are tracked under `docs/ux/mockups/*.png`. The UX spec explicitly says not to implement the current visual mockups as-is because they drift toward a dense enterprise dashboard.

Prompt caveat:

- `prompts/CODEX_WAVE_A1.md` is useful context but currently asks for items that are broader than Andrew’s current Wave A1 boundary, including transactional outbox proof, SQS-compatible queueing, Drizzle migration foundation, CI, and ADR-015 drafting. For this run, Codex should receive a narrowed Wave A1 prompt matching Andrew’s instruction: monorepo/infrastructure skeleton only, no product features and no truth/tenancy/RLS/ChangeSet/MCP/extraction implementation.
- `README.md` points to `prompts/CODEX_WAVE_A1.md` as the first implementation prompt; use caution until that prompt is narrowed or superseded in the actual Codex invocation.

## 4. Tool versions

```text
git: git version 2.43.0
gh: gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
node: v22.22.2
corepack: command not found
pnpm: command not found
docker: command not found
docker compose: command not found
psql: command not found
aws: aws-cli/2.34.54 Python/3.14.5 Linux/6.17.0-1017-aws exe/x86_64.ubuntu.24
terraform: command not found
codex: codex-cli 0.142.2
claude: 2.1.193 (Claude Code)
```

Tool-path check for missing tools:

```text
corepack path: not found
pnpm path: not found
docker path: not found
psql path: not found
terraform path: not found
```

## 5. Auth checks

```text
gh auth status:
- Logged in to github.com account alindebergASL
- Active account: true
- Git operations protocol: https
- Token scopes: gist, read:org, repo, workflow

aws sts get-caller-identity:
- UserId: AROAQE43J2GJPZMAZNZBW:i-0b0fdf98dff73e9e8
- Account: 010526249362
- Arn: arn:aws:sts::010526249362:assumed-role/AtlieraS3LabValidationRole/i-0b0fdf98dff73e9e8

Codex CLI available:
- `codex --version` succeeded: codex-cli 0.142.2
- `codex --help` succeeded and exposed non-interactive `exec` plus `review`, `doctor`, and `sandbox` commands.

Claude Code CLI available:
- `claude --version` succeeded: 2.1.193 (Claude Code)
- `claude --help` succeeded and supports non-interactive print mode.
```

Notes:

- SSH clone initially failed due to host key verification, but HTTPS clone succeeded and `gh auth status` is healthy for HTTPS Git operations.
- AWS credentials are available but currently identify the `AtlieraS3LabValidationRole`; do not make production Throughline infrastructure assumptions from that role.

## 6. Git status

Preflight baseline:

```text
Current branch before preflight artifact branch: main
Commit: 8331fcf Add files via upload
Remote status: main...origin/main, clean
Working tree before writing this report: clean
```

Current status artifact branch:

```text
Current branch: wave-0-preflight
Working tree after writing this report: expected to contain only docs/status/HERMES_PREFLIGHT.md as an uncommitted status artifact
Remote status: local branch, not pushed
```

No application source code was modified during preflight.

## 7. Recommended first branch

- Current preflight artifact branch: `wave-0-preflight`.
- Recommended Wave A1 implementation branch after Andrew approval: `wave-a1-repo-foundation`.

Use a feature branch; do not work directly on `main`.

## 8. Missing repo files before Wave A1

Should resolve before handing Wave A1 to Codex:

1. Canonical UX spec path mismatch:
   - Missing: `docs/ux/UX_INTERACTION_SPEC_v0.1.md`
   - Present: `docs/ux/throughline_ux_interaction_spec_v0.1.md`
   - Recommended fix: add the requested canonical filename by rename/copy, or update all canonical references consistently. This is docs-only but should be explicit because AGENTS/CLAUDE/user prompt name the missing path.

Expected to be added during Wave A1, not before it:

- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- root TypeScript/lint/format/test config
- `.gitignore` / `.dockerignore` if absent
- `apps/web`
- `apps/api`
- `apps/agent-worker`
- `apps/connector-worker`
- `apps/outbox-relay`
- all requested `packages/*` skeletons
- Docker Compose file for local Postgres + pgvector and object-store placeholder if practical
- minimal smoke tests
- README local setup updates

Environment/tooling blockers to address before or during Wave A1 verification:

- `pnpm` and `corepack` are not installed on this host.
- `docker` / `docker compose` are not installed on this host.
- `psql` is not installed on this host.
- `terraform` is not installed; likely not needed for Wave A1 unless infrastructure-as-code scope expands.

## 9. Secret scan / tracked-secret check

Commands/checks run:

```bash
git ls-files
python3 regex scan of tracked text files for private keys, AWS access keys, GitHub tokens, OpenAI/Anthropic keys, and high-entropy secret/token/password assignments
```

Result:

```text
tracked_files: 46
text_files_scanned: 41
binary_or_skipped: 5
findings: 0
```

Confirmation: no obvious secrets were found in tracked text files. The skipped files are binary PNG UX mockups; they were not regex-scanned as text, but there are no obvious textual secrets in tracked source/docs/fixtures.

## 10. Proposed Wave A1 plan

After Andrew approval:

1. Resolve/confirm the UX spec filename mismatch so Codex and Claude review against the same canonical path.
2. Create/switch to `wave-a1-repo-foundation` from the approved base.
3. Give Codex CLI a narrowed Wave A1 prompt that requires reading the canonical docs and AGENTS/CLAUDE/HERMES runbook, then implements only the repo/infrastructure skeleton.
4. Scaffold root monorepo tooling:
   - `package.json` with `packageManager` and scripts.
   - `pnpm-workspace.yaml`.
   - `turbo.json`.
   - shared `tsconfig` baseline.
   - lint / format / test setup.
5. Add minimal apps only:
   - `apps/web`: Next.js App Router shell, no product screens beyond a minimal placeholder aligned with Today / Organizations / Pulse constraints.
   - `apps/api`: NestJS + Fastify with `/health` endpoint.
   - `apps/agent-worker`, `apps/connector-worker`, `apps/outbox-relay`: worker skeletons only.
6. Add package skeletons only:
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
7. Add Docker Compose for local Postgres + pgvector and an object-store placeholder if practical, but do not implement persistence features beyond skeleton wiring.
8. Add basic smoke tests for app/package compilation and `/health` behavior.
9. Add shared trace/request ID stub if feasible without implementing the full outbox/worker product path.
10. Update README with exact local setup and verification commands.
11. Hermes runs verification independently after Codex finishes.
12. Ask Claude Code CLI to review the actual diff for:
    - spec drift;
    - dependency bloat;
    - missing tests;
    - wrong repo structure;
    - product features implemented too early;
    - security mistakes;
    - violations of `AGENTS.md`, `CLAUDE.md`, `BUILD_SPEC`, or the UX spec.
13. Apply only necessary fixes, rerun tests, and write `docs/status/WAVE_A1_RESULT.md`.
14. Stop again for Andrew approval before Wave A2.

Explicit Wave A1 non-goals to enforce:

- No tenancy tables.
- No RLS implementation.
- No ChangeSets implementation.
- No truth ledger implementation beyond package placeholder.
- No MCP adapter.
- No extraction logic.
- No production UI product screens.
- No external provider integrations.
- No generic Solution Pack runtime.

## 11. Risks or blockers

- Canonical UX spec filename mismatch is the main repo-level blocker before a clean implementation handoff.
- Host is missing `corepack`, `pnpm`, Docker, Docker Compose, and `psql`; Wave A1 verification will require installing/enabling tooling or using an approved workaround.
- The checked-in `prompts/CODEX_WAVE_A1.md` is broader than Andrew’s current Wave A1 request; using it unmodified risks implementing product/infrastructure behavior too early.
- AWS auth is present but points to an Atliera lab validation role, not a Throughline-specific account/role.

## 12. Stop / proceed recommendation

Hermes recommendation: STOP for Andrew approval before Wave A1.

Recommended approval decision:

- Approve resolving the UX spec filename mismatch, then begin `wave-a1-repo-foundation` with a narrowed Codex prompt; or
- Explicitly approve using `docs/ux/throughline_ux_interaction_spec_v0.1.md` as the canonical UX source for Wave A1 without renaming.
