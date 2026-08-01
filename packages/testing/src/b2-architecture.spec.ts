import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const initiativeLockSql = `-- Established row-lock capability for durable Initiative truth mutations.
CREATE POLICY initiatives_app_truth_lock ON work.initiatives
AS PERMISSIVE FOR UPDATE TO throughline_app
USING (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND EXISTS (
    SELECT 1 FROM access.spaces governing_space
    WHERE governing_space.tenant_id = work.initiatives.tenant_id
      AND governing_space.workspace_id = work.initiatives.workspace_id
      AND governing_space.id = work.initiatives.space_id
      AND governing_space.archived_at IS NULL
  )
)
WITH CHECK (false);

CREATE POLICY initiatives_app_permanent_no_write ON work.initiatives
AS RESTRICTIVE FOR UPDATE TO throughline_app
USING (true)
WITH CHECK (false);

GRANT UPDATE (id) ON work.initiatives TO throughline_app;
`;

describe("B2 Slice 1 architecture boundaries", () => {
  it("preserves migrations 0001–0009 byte-for-byte", async () => {
    const fixed = {
      "0001_wave_a2_identity_access_rls.sql":
        "22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7",
      "0002_foundation_closure_async_isolation.sql":
        "4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2",
      "0003_b1_0_canonical_product_outbox.sql":
        "094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63",
      "0004_b1_work_graph.sql": "e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76",
      "0005_b1_content_sources.sql":
        "b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c",
      "0006_b1_command_integrity.sql":
        "cf2cd1c20e27cad0526f5896090fdf797ff748b90a02b994c2f5c2894b762897",
      "0007_b2_slice1_truth_storage.sql":
        "0e51a502b084e23677c1a0832fc3943a6da33266eae517af2641c61452a9dba8",
      "0008_b2_slice1_command_integrity.sql":
        "84bcc710743c1850a0995763765b9dbb8506b040d965d33557459fd6eb472fcc",
      "0009_b2_source_truth_lifecycle_interlock.sql":
        "0463ee762f2af1b4fc61d551398424740f3927e7a31b478717de03c3c88e29f1"
    };
    for (const [file, digest] of Object.entries(fixed)) {
      const bytes = await readFile(join(root, "packages/db/migrations", file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(digest);
    }
  });

  it("keeps 0010 to the bounded Initiative lock capability", async () => {
    const migration = await source(
      "packages/db/migrations/0010_b2_trusted_objective_initiative_lock.sql"
    );

    expect(migration).toBe(initiativeLockSql);
    expect([...migration.matchAll(/CREATE POLICY/gi)]).toHaveLength(2);
    expect(migration).not.toMatch(
      /GRANT\s+UPDATE\s+ON|UPDATE\s*\([^)]*,|\bPUBLIC\b|WITH\s+GRANT\s+OPTION|\b(?:ALTER|DROP)\b|truth\.|fact_lifecycle|derived_view/i
    );
  });

  it("adds only the four durable truth tables needed by Claim → Fact", async () => {
    const schema = await source("packages/db/migrations/0007_b2_slice1_truth_storage.sql");
    expect([...schema.matchAll(/CREATE TABLE truth\.([a-z_]+)/g)].map((match) => match[1])).toEqual(
      ["verified_evidence_spans", "claims", "accepted_facts", "fact_claims"]
    );
    expect(schema).toContain("accepted_facts_one_current_slot");
    expect(schema).toContain("accepted_facts_support_deferred");
    expect(schema).not.toMatch(/fact_supersessions|conflict_groups|derived_view|command_effects/);
  });

  it("contains only the bounded fail-closed lifecycle interlock, not Stage 3 reconciliation", async () => {
    const schema = await source("packages/db/migrations/0007_b2_slice1_truth_storage.sql");
    const integrity = await source("packages/db/migrations/0008_b2_slice1_command_integrity.sql");
    const lifecycle = await source(
      "packages/db/migrations/0009_b2_source_truth_lifecycle_interlock.sql"
    );

    expect(schema).not.toMatch(
      /fact_lifecycle|reconcile_source_retention|source_artifacts_truth_retention|b2_retention_command|retention_update|redacted_at|redaction_command_id|redaction_source_artifact_id|hash_disposition|status IN \('current','revoked'\)|status IN \('proposed','accepted','rejected'\)/
    );
    expect(schema).toContain("verified_evidence_immutable");
    expect(schema).toContain("accepted_facts_immutable");
    expect(schema).toContain("content.access_class_rank");
    expect(schema).not.toContain("truth.access_class_rank");
    expect(integrity).not.toMatch(/fact_lifecycle|Fact support and lifecycle/);
    expect(integrity).toContain("durable Fact and support");
    expect(lifecycle).toContain("ops.enforce_b2_source_truth_lifecycle_interlock()");
    expect(lifecycle).toContain("Source lifecycle transition is unavailable");
    expect(lifecycle).toContain("RENAME COLUMN value_json TO canonical_value_text");
    expect(lifecycle).toContain("Truth mutation transaction is unavailable");
    expect([...lifecycle.matchAll(/UPDATE\s+truth\.([a-z_]+)/gi)].map((match) => match[1])).toEqual(
      ["claims", "accepted_facts"]
    );
    expect(lifecycle).not.toMatch(/DELETE\s+FROM\s+truth\.|redact/i);
  });

  it("stores acceptance-confidence provenance directly on AcceptedFact", async () => {
    const schema = await source("packages/db/migrations/0007_b2_slice1_truth_storage.sql");
    const repository = await source("packages/truth-ledger/src/repository.ts");

    for (const field of [
      "confidence_rule",
      "strongest_supporting_confidence",
      "human_lowered",
      "confidence_lowering_reason_code",
      "confidence_lowering_rationale"
    ]) {
      expect(schema).toContain(field);
      expect(repository).toContain(field);
    }
    expect(repository).not.toContain("fact_lifecycle_events");
  });

  it("executes only canonical claim.create and fact.accept", async () => {
    const implementation = await combined([
      "packages/truth-ledger/src/domain-command-bus.ts",
      "packages/truth-ledger/src/repository.ts",
      "packages/db/migrations/0008_b2_slice1_command_integrity.sql",
      "packages/db/migrations/0009_b2_source_truth_lifecycle_interlock.sql",
      "apps/api/src/b2-truth/b2-truth.controller.ts"
    ]);
    expect(implementation).toContain('"claim.create"');
    expect(implementation).toContain('"fact.accept"');
    expect(implementation).toContain('"claim.proposed"');
    expect(implementation).toContain('"fact.accepted"');
    expect(implementation).not.toMatch(/claim\.propose["']/);
    expect(implementation).not.toMatch(
      /fact\.(?:contest|uphold|supersede|revoke|emergency)|derived_view\.regenerate/
    );
  });

  it("keeps future truth execution files and fixtures absent", async () => {
    const forbiddenPaths = [
      "packages/truth-ledger/src/reconciliation.ts",
      "packages/truth-ledger/src/conflicts.ts",
      "packages/truth-ledger/src/derived-view-repository.ts",
      "packages/truth-ledger/src/derived-view-service.ts",
      "packages/truth-ledger/src/read-service.ts",
      "packages/truth-ledger/src/read-contracts.ts",
      "packages/truth-ledger/src/revision-hash.ts",
      "tests/fixtures/b2/truth-ledger-ux.v1.json",
      "tests/fixtures/truth-ledger/current_fact.json",
      "tests/fixtures/truth-ledger/source_reconciliation.json",
      "tests/fixtures/truth-ledger/supersession.json",
      "tests/fixtures/truth-ledger/unresolved_conflict.json"
    ];
    for (const path of forbiddenPaths) {
      await expect(pathExists(path), path).resolves.toBe(false);
    }
  });

  it("keeps models, agents, ChangeSets, UI, and external actions out of the path", async () => {
    const implementation = await combined([
      "packages/truth-ledger/src/domain-command-bus.ts",
      "packages/truth-ledger/src/repository.ts",
      "apps/api/src/b2-truth/b2-truth.controller.ts",
      "apps/api/src/b2-truth/b2-truth.runtime.ts"
    ]);
    expect(implementation).not.toMatch(
      /ChangeSet|AgentRun|model\.generate|OpenAI|vector search|MCP|sendEmail|scheduleMeeting/i
    );
  });

  it("keeps the authenticated API boundary internal and exposes no truth read route", async () => {
    const controller = await source("apps/api/src/b2-truth/b2-truth.controller.ts");
    expect(controller).toContain('@Controller("internal/v1")');
    expect(controller).toContain('@Post("claims")');
    expect(controller).toContain('@Post("facts")');
    expect(controller).not.toMatch(/@Get|current[_ -]?truth|summary/i);
  });

  it("keeps trusted-objective identity selection server-only and browser requests authority-free", async () => {
    const browserAndRouteSources = await combined([
      "apps/web/app/page.tsx",
      "apps/web/app/globals.css",
      "apps/web/app/organizations/initiatives/[initiativeId]/page.tsx",
      "apps/web/app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
      "apps/web/app/api/demo/initiatives/[initiativeId]/trusted-objective/route.ts",
      "apps/web/lib/trusted-objective.ts"
    ]);
    expect(browserAndRouteSources).not.toMatch(
      /\bpersona\b|persona-switch|Owner view|Unavailable view|\?persona=|x-throughline-dev-identity/i
    );

    const bff = await source("apps/web/lib/demo-bff.ts");
    expect(bff).not.toMatch(
      /TRUSTED_OBJECTIVE_DEMO_PERSONA|x-throughline-dev-identity|tenant-a-owner|tenant-b-viewer/
    );
    const guard = await source("apps/api/src/trusted-objective/trusted-objective.guard.ts");
    expect(guard).toContain("process.env.TRUSTED_OBJECTIVE_DEMO_PERSONA");
    expect(guard).toContain('return "tenant-a-owner"');
    expect(guard).toContain('return "tenant-b-viewer"');
    expect(guard).toContain('hasHeader(request.headers, "x-throughline-dev-identity")');

    const readme = await source("README.md");
    const setup = await source("scripts/setup-trusted-objective-demo.ts");
    expect(readme).toContain("TRUSTED_OBJECTIVE_DEMO_PERSONA=owner");
    expect(readme).toContain("TRUSTED_OBJECTIVE_DEMO_PERSONA=unavailable");
    expect(`${readme}\n${setup}`).not.toMatch(
      /\?persona=|persona-switch|Owner view|Unavailable view/
    );
  });

  it("owns one fail-fast, non-recursive authoritative B2 gate and invokes it once in CI", async () => {
    const manifest = JSON.parse(await source("package.json")) as {
      scripts: Record<string, string>;
    };
    const gate = manifest.scripts["test:b2"] ?? "";
    expect(gate).toContain("scripts/require-b2-test-env.ts");
    expect(gate).toContain("scripts/run-b2-gate.ts");
    expect(gate).not.toMatch(/pnpm test:(?:security|foundation|b1-0|b1)(?:\s|&|$)/);
    const runner = await source("scripts/run-b2-gate.ts");
    for (const file of [
      "b2-architecture.spec.ts",
      "command-schemas.spec.ts",
      "truth-ledger.postgres.spec.ts",
      "b2-authorization.spec.ts",
      "transaction.spec.ts",
      "b1-catalog-contract.spec.ts",
      "b2-catalog-contract.postgres.spec.ts",
      "b2-truth.postgres.spec.ts"
    ]) {
      expect(runner).toContain(file);
    }
    expect(runner).toContain("numPendingTests");
    expect(runner).toContain("unhandledErrors");

    const preflight = await source("scripts/require-b2-test-env.ts");
    expect(preflight).toContain('process.env.B2_AUTHORITATIVE_GATE !== "1"');
    expect(preflight).toContain('"TEST_DATABASE_URL"');
    expect(preflight).toContain('"TEST_APP_DATABASE_URL"');

    const workflow = await source(".github/workflows/ci.yml");
    expect(workflow.match(/pnpm test:b2/g)).toHaveLength(1);
    expect(workflow).toContain('B2_AUTHORITATIVE_GATE: "1"');
  });

  it("fails the B2 preflight before any test runner starts when configuration is absent", () => {
    const env = { ...process.env };
    delete env.B2_AUTHORITATIVE_GATE;
    delete env.TEST_DATABASE_URL;
    delete env.TEST_APP_DATABASE_URL;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/require-b2-test-env.ts"],
      { cwd: root, env, encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("test:b2 requires");
    expect(`${result.stdout}${result.stderr}`).not.toContain("RUN  v");
  });
});

async function source(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

async function combined(paths: string[]): Promise<string> {
  return (await Promise.all(paths.map(source))).join("\n");
}

async function pathExists(relativePath: string): Promise<boolean> {
  const absolute = join(root, relativePath);
  try {
    await readdir(absolute);
    return true;
  } catch {
    try {
      await readFile(absolute);
      return true;
    } catch {
      return false;
    }
  }
}
