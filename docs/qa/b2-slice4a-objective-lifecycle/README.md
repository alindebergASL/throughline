# B2 Slice 4A objective lifecycle — Task 4A.1 RED evidence

Recorded: `2026-08-05T20:21:31Z`

## Status

**Task 4A.1 RED contract: PASS.**

This packet records the reviewed failing contract that must be satisfied by Task 4A.2. It does **not** claim that migration `0012_b2_fact_lifecycle.sql`, phase-6 catalog bytes, connected PostgreSQL behavior, lifecycle commands, API/UI walking paths, or production deployment exist.

Task 4A.2 remained unstarted when this evidence was recorded.

## Authority and immutable starting point

The owner authorized merging PR #13 at exact source SHA `45e6dbe1662bb5916bd9b4512a65007a28878b4a` and beginning Slice 4A only after post-merge CI passed.

The exact merged and CI-green starting point for Slice 4A is:

| Field | Value |
| --- | --- |
| Branch | `feat/b2-slice4a-objective-lifecycle` |
| Starting/main SHA | `345eedd38f0073a5b96955cd1287a4f9d9bfd7f9` |
| Starting tree | `eecbf825e8e011d1ca9d9d506ccf50e12eb4d984` |
| Starting parent | `bd8b9fe36b7ea7c815ae640ca5ccd5fe12421df8` |
| Post-merge CI run | `31029030579` — success |
| PR #13 merge checkpoint | `https://github.com/alindebergASL/throughline/pull/13#issuecomment-5195211571` |

The Task 4A.1 test-only diff was reviewed at SHA-256:

```text
ac7392a9adf5fc2fb247332f3231617bccec440792f2f44601589de900cdda82
```

That digest covers only the three test paths listed below, before this evidence file was added.

## Bounded scope

The reviewed Task 4A.1 contract diff changes only the three test paths below; this README is the sole additional evidence file.

- `packages/db/src/b2-migration.spec.ts`
- `packages/db/src/b2-catalog-contract.spec.ts`
- `packages/db/src/b2-catalog-contract.postgres.spec.ts`

The contract requires the future Task 4A.2 implementation to add only the bounded ordinary Fact lifecycle foundation:

- `fact.supersede.v1` and `fact.revoke.v1`;
- current → superseded/revoked state/version progression;
- immutable predecessor Fact value, evidence, support, coordinates, acceptance, and history;
- explicit supersession A→B lineage and revocation without a successor;
- exact one-current-slot preservation;
- bounded reason, authority, actor, command, and transaction-time evidence;
- exact Tenant/Workspace/Space RLS and restricted-role behavior;
- narrow ACLs and no role/BYPASSRLS escape;
- exact command, audit, outbox, payload-privacy, and commit-time atomicity behavior;
- replay/adoption safety from an exact populated migration-0011 database.

Explicitly excluded:

- `fact.contest`, `fact.uphold`, emergency lifecycle, or source reconciliation;
- derived-view storage or regeneration;
- Activity Outcome product UI;
- models, providers, extraction, search, external sends/actions, or production deployment.

## Immutable predecessor migration bytes

The RED contract pins migrations `0001`–`0011` byte-for-byte. Live SHA-256 values at the starting point were:

| Migration | SHA-256 |
| --- | --- |
| `0001_wave_a2_identity_access_rls.sql` | `22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7` |
| `0002_foundation_closure_async_isolation.sql` | `4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2` |
| `0003_b1_0_canonical_product_outbox.sql` | `094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63` |
| `0004_b1_work_graph.sql` | `e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76` |
| `0005_b1_content_sources.sql` | `b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c` |
| `0006_b1_command_integrity.sql` | `cf2cd1c20e27cad0526f5896090fdf797ff748b90a02b994c2f5c2894b762897` |
| `0007_b2_slice1_truth_storage.sql` | `0e51a502b084e23677c1a0832fc3943a6da33266eae517af2641c61452a9dba8` |
| `0008_b2_slice1_command_integrity.sql` | `84bcc710743c1850a0995763765b9dbb8506b040d965d33557459fd6eb472fcc` |
| `0009_b2_source_truth_lifecycle_interlock.sql` | `0463ee762f2af1b4fc61d551398424740f3927e7a31b478717de03c3c88e29f1` |
| `0010_b2_trusted_objective_initiative_lock.sql` | `1fac8f65c9dd80262ea577f1109ca1e6fa4822983cb62ac52868b138e375bb93` |
| `0011_b2_primary_objective_proposal_recovery.sql` | `e1160864d02eff6baa56f326bba93a6b79e98904b604fd7f5823672c7885f1f2` |

No predecessor migration was edited.

## Focused RED

Command:

```bash
pnpm --filter @throughline/db exec vitest run \
  src/b2-migration.spec.ts \
  src/b2-catalog-contract.spec.ts \
  --poolOptions.threads.singleThread --no-file-parallelism
```

Independently reproduced result:

```text
Test Files  2 failed (2)
Tests       7 failed | 31 passed (38)
```

The seven failures are intentional and attributable to absent Task 4A.2 production bytes:

1. `B2_MIGRATION_IDS` does not yet include `0012_b2_fact_lifecycle.sql`.
2. No migration-0012 unjournaled-state probe exists.
3. Phase 6 still returns the phase-5 catalog rather than the required relation/policy/constraint/index delta.
4. `truth.fact_lifecycle_events` is absent from the phase-6 exact catalog.
5. The complete lifecycle function inventory/source contract is absent.
6. `migrations.ts` has no phase-6 dispatch with `additiveB2Phase: 6`.
7. `packages/db/migrations/0012_b2_fact_lifecycle.sql` does not exist.

No failure was caused by syntax, type errors, imports, fixture setup, environment configuration, or a predecessor regression.

## Supporting checks

The following independently passed against the final Task 4A.1 test diff:

```bash
pnpm --filter @throughline/db typecheck
pnpm --filter @throughline/db exec eslint \
  src/b2-migration.spec.ts \
  src/b2-catalog-contract.spec.ts \
  src/b2-catalog-contract.postgres.spec.ts
pnpm exec prettier --check \
  packages/db/src/b2-migration.spec.ts \
  packages/db/src/b2-catalog-contract.spec.ts \
  packages/db/src/b2-catalog-contract.postgres.spec.ts
git diff --check
```

Guards also passed:

- exact three-path allowlist;
- empty staging area;
- unchanged starting HEAD/tree;
- no production or migration source;
- no commit, push, PR, merge, deployment, database, service, or other external effect.

## Connected-test limitation

With `TEST_DATABASE_URL`, `TEST_APP_DATABASE_URL`, and `B2_AUTHORITATIVE_GATE` explicitly unset, the connected test file collected successfully as:

```text
Test Files  1 skipped (1)
Tests       1 skipped (1)
```

This is **collection evidence only**, not PostgreSQL behavioral proof. No database credentials were accessed or invented and no database was contacted during Task 4A.1.

Connected PostgreSQL GREEN proof must be produced during Task 4A.2 using repository `applyMigrations`, explicit disposable test DSNs, and the authoritative B2 gate. SQL must never be applied manually.

## Review and correction history

The test contract was not accepted on the first attempt.

1. Initial review: **HOLD / REQUEST_CHANGES**
   - exact FK/constraint/trigger/RLS semantics insufficiently pinned;
   - ACL, role escape, function semantics, command/audit/outbox privacy, immutability, and adoption behavior incomplete.
2. First correction review: **HOLD** plus one timed-out adversarial review.
   - two forward-GREEN migration calls were unbounded;
   - the timed-out review was not counted as approval, but recoverable concrete findings were corrected.
3. Second review: **PASS / REQUEST_CHANGES**
   - specification contract passed;
   - adversarial review found revoke-only atomicity/privacy coverage.
4. Final correction review: **PASS / APPROVED**
   - exact supersede response/audit/outbox privacy negatives added;
   - nine supersede lifecycle/audit/outbox rollback faults added;
   - command-specific full-state digest and transaction harness corrected;
   - prior migration, security, immutability, adoption, and scope properties remained intact.

Final exact-diff review evidence:

- specification regression: `PASS`;
- adversarial database/security closure: `APPROVED`;
- reviewed test diff SHA-256: `ac7392a9adf5fc2fb247332f3231617bccec440792f2f44601589de900cdda82`.

## Next gate

Task 4A.2 may add the bounded migration and schema/catalog implementation needed to turn this RED contract GREEN.

This evidence grants no authority to merge a future Slice 4A PR or deploy production. Those remain separate explicit owner seams.
