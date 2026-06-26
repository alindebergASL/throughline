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
