# Throughline Phase 0/1 Implementation Kickoff Package v0.1

This package converts the approved architecture into executable implementation work.

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

## First proof

```text
Untrusted engagement source
  → mechanically verified claims
  → governed ChangeSet review
  → authorized AcceptedFacts
  → permission-correct cited views
```
