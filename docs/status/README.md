# Throughline Status Artifacts

Hermes writes build status here so progress is inspectable in the repo rather than relying on chat-only summaries.

Expected files:

```text
HERMES_PREFLIGHT.md
HERMES_HEARTBEAT.md
LAST_CODEX_RUN.md
LAST_CLAUDE_REVIEW.md
WAVE_<id>_PLAN.md
WAVE_<id>_RESULT.md
```

Use the templates in `docs/status/templates/`.

Do not treat these files as product documentation. They are operational build records.

Current implementation status: B2 Slice 1 is merged. The active branch is the bounded B2 Slice 2
trusted-objective browser walking slice; no human usability-testing completion is claimed.
