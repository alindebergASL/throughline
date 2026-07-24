import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertProductValidatorDelegatesExactB1Kinds } from "./b2-catalog-contract.js";

const schemaUrl = new URL("../migrations/0007_b2_slice1_truth_storage.sql", import.meta.url);
const integrityUrl = new URL("../migrations/0008_b2_slice1_command_integrity.sql", import.meta.url);

describe("B2 Slice 1 additive migration contract", () => {
  it("pins exact immutable predecessors and the journal-aware validation phases", async () => {
    const expected = [
      [
        "0001_wave_a2_identity_access_rls.sql",
        "22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7"
      ],
      [
        "0002_foundation_closure_async_isolation.sql",
        "4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2"
      ],
      [
        "0003_b1_0_canonical_product_outbox.sql",
        "094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63"
      ],
      [
        "0004_b1_work_graph.sql",
        "e3c94ed9ca9c8d5dac8791d5e35c290933c69ada8da842d9242eb2e2c2f58d76"
      ],
      [
        "0005_b1_content_sources.sql",
        "b917adfd0acf987904156ade0c0593f6f3c27d8cf516c78c75af17072b99a19c"
      ],
      [
        "0006_b1_command_integrity.sql",
        "cf2cd1c20e27cad0526f5896090fdf797ff748b90a02b994c2f5c2894b762897"
      ]
    ] as const;
    for (const [file, digest] of expected) {
      const bytes = await readFile(new URL(`../migrations/${file}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(digest);
    }
    const runner = await readFile(new URL("./migrations.ts", import.meta.url), "utf8");
    expect(runner).toMatch(
      /case 0:[\s\S]*?validateB1CatalogContract[\s\S]*?case 1:[\s\S]*?validateB1CatalogContract[\s\S]*?additiveB2Phase: 1[\s\S]*?validateB2CatalogContract[\s\S]*?case 2:[\s\S]*?validateB1CatalogContract[\s\S]*?additiveB2Phase: 2[\s\S]*?validateB2CatalogContract/
    );
    const b1Contract = await readFile(new URL("./b1-catalog-contract.ts", import.meta.url), "utf8");
    expect(b1Contract).toContain("A staged B2 catalog requires the exact complete B1 predecessor");
    expect(b1Contract).not.toContain("source_artifacts_truth_retention");
    expect(b1Contract).toContain("Fixed staged B2 command integrity contract parser failed");
  });

  it("creates exactly the durable Claim-to-Fact persistence surface", async () => {
    const sql = await readFile(schemaUrl, "utf8");
    const tables = [...sql.matchAll(/CREATE TABLE truth\.([a-z_]+)/g)].map((match) => match[1]);
    expect(tables).toEqual(["verified_evidence_spans", "claims", "accepted_facts", "fact_claims"]);
    expect(sql).toContain("accepted_facts_one_current_slot");
    expect(sql).toContain("accepted_facts_support_deferred");
    expect(sql).toContain("fact_claims_support_deferred");
    expect(sql).toContain("source evidence snapshot is unavailable or invalid");
    expect(sql).toContain("substring(");
    expect(sql).toContain("source_start_offset + 1");
    expect(sql).toContain("confidence_rule");
    expect(sql).toContain("strongest_supporting_confidence");
    expect(sql).toContain("human_lowered");
    expect(sql).toContain("confidence_lowering_reason_code");
    expect(sql).toContain("confidence_lowering_rationale");
    expect(sql).toContain("content.access_class_rank");
    expect(sql).not.toMatch(
      /fact_lifecycle|reconcile_source_retention|source_artifacts_truth_retention|b2_retention_command|redacted_at|redaction_|hash_disposition|status IN \('current','revoked'\)|status IN \('proposed','accepted','rejected'\)/
    );
    expect(sql).not.toMatch(/conflict|supersession|derived_view|command_effect/);
  });

  it("closes executable persistence over only claim.create and fact.accept", async () => {
    const sql = await readFile(integrityUrl, "utf8");
    expect(() => assertProductValidatorDelegatesExactB1Kinds(sql)).not.toThrow();
    expect(sql).toContain("'claim.create.v1','fact.accept.v1'");
    expect(sql).toContain("domain_command_records_b2_slice1_atomicity_deferred");
    expect(sql).toContain("exact audit and product outbox rows");
    expect(sql).toContain("durable Fact and support");
    expect(sql).not.toMatch(/fact_lifecycle|Fact support and lifecycle/);
    expect(sql).not.toMatch(/'valueHash'|'supportingClaimsHash'/);
    for (const future of [
      "fact.contest.v1",
      "fact.uphold.v1",
      "fact.supersede.v1",
      "fact.revoke.v1",
      "fact.emergency_contest.v1",
      "fact.emergency_revoke.v1",
      "derived_view.regenerate.v1"
    ]) {
      expect(sql).not.toContain(future);
    }
  });

  it("preserves the B1 validator and gives B1 and B2 separate deferred triggers", async () => {
    const sql = await readFile(integrityUrl, "utf8");
    expect(sql).toContain("RETURN ops.b1_command_record_valid(");
    expect(sql).toContain("domain_command_records_b1_atomicity_deferred");
    expect(sql).toContain("ops.require_b1_command_atomicity()");
    expect(sql).toContain("ops.require_b2_slice1_command_atomicity()");
    expect(sql).not.toMatch(/CREATE TABLE\s+ops\.domain_events/i);
  });

  it("grants each B2 command validator only to the runtime role that invokes it", async () => {
    const sql = await readFile(integrityUrl, "utf8");
    const executeGrantsFor = (role: string) =>
      [...sql.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION([^;]*?)TO ${role};`, "g"))].flatMap(
        (match) =>
          [...(match[1] ?? "").matchAll(/ops\.[a-z0-9_]+\([^)]*\)/g)].map((functionMatch) =>
            functionMatch[0]!.replaceAll(/\s+/g, "")
          )
      );

    expect(executeGrantsFor("throughline_app")).toEqual([
      "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)",
      "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)",
      "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)"
    ]);
    expect(executeGrantsFor("throughline_product_relay")).toEqual([
      "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)"
    ]);
    expect(executeGrantsFor("throughline_relay")).toEqual([]);
    expect(executeGrantsFor("throughline_worker")).toEqual([]);
  });
});
