import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("B2 Slice 1 architecture boundaries", () => {
  it("preserves migrations 0001–0006 byte-for-byte", async () => {
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
        "cf2cd1c20e27cad0526f5896090fdf797ff748b90a02b994c2f5c2894b762897"
    };
    for (const [file, digest] of Object.entries(fixed)) {
      const bytes = await readFile(join(root, "packages/db/migrations", file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(digest);
    }
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

  it("contains no Slice 2 retention reconciliation or lifecycle execution", async () => {
    const schema = await source("packages/db/migrations/0007_b2_slice1_truth_storage.sql");
    const integrity = await source("packages/db/migrations/0008_b2_slice1_command_integrity.sql");

    expect(schema).not.toMatch(
      /fact_lifecycle|reconcile_source_retention|source_artifacts_truth_retention|b2_retention_command|retention_update|redacted_at|redaction_command_id|redaction_source_artifact_id|hash_disposition|status IN \('current','revoked'\)|status IN \('proposed','accepted','rejected'\)/
    );
    expect(schema).toContain("verified_evidence_immutable");
    expect(schema).toContain("accepted_facts_immutable");
    expect(schema).toContain("content.access_class_rank");
    expect(schema).not.toContain("truth.access_class_rank");
    expect(integrity).not.toMatch(/fact_lifecycle|Fact support and lifecycle/);
    expect(integrity).toContain("durable Fact and support");
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
