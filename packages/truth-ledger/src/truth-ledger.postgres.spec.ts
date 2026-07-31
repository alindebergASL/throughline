import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schemaUrl = new URL("../../db/migrations/0007_b2_slice1_truth_storage.sql", import.meta.url);
const integrityUrl = new URL(
  "../../db/migrations/0008_b2_slice1_command_integrity.sql",
  import.meta.url
);
const lifecycleUrl = new URL(
  "../../db/migrations/0009_b2_source_truth_lifecycle_interlock.sql",
  import.meta.url
);

describe("B2 Slice 1 PostgreSQL truth invariants", () => {
  it("pins exact evidence, Claim, Fact, support, and acceptance provenance persistence", async () => {
    const sql = await readFile(schemaUrl, "utf8");
    expect([...sql.matchAll(/CREATE TABLE truth\.([a-z_]+)/g)].map((match) => match[1])).toEqual([
      "verified_evidence_spans",
      "claims",
      "accepted_facts",
      "fact_claims"
    ]);
    expect(sql).toContain("accepted_facts_one_current_slot");
    expect(sql).toContain("status text NOT NULL CHECK (status = 'current')");
    expect(sql).toContain("confidence_rule text NOT NULL");
    expect(sql).toContain("strongest_supporting_confidence text NOT NULL");
    expect(sql).toContain("human_lowered boolean NOT NULL");
    expect(sql).toContain("confidence_lowering_reason_code text");
    expect(sql).toContain("confidence_lowering_rationale text");
    expect(sql).toContain("value_json jsonb NOT NULL");
    expect(sql).not.toContain("canonical_value_text");
    const lifecycle = await readFile(lifecycleUrl, "utf8");
    expect(lifecycle).toContain("RENAME COLUMN value_json TO canonical_value_text");
    expect(lifecycle).toContain("ALTER COLUMN canonical_value_text TYPE text");
    expect(sql).not.toMatch(/fact_lifecycle|redacted_at|redaction_|hash_disposition/);
    expect(sql).not.toMatch(/conflict_groups|fact_supersessions|derived_view|command_effects/);
  });

  it("pins mechanical scalar-span and live source snapshot checks", async () => {
    const sql = await readFile(schemaUrl, "utf8");
    expect(sql).toContain("source_record.version <> NEW.source_version");
    expect(sql).toContain("chunk_record.source_artifact_id <> NEW.source_artifact_id");
    expect(sql).toContain("NEW.source_end_offset > char_length(chunk_record.normalized_text)");
    expect(sql).toContain("FROM NEW.source_start_offset + 1");
    expect(sql).toContain("<> NEW.source_excerpt");
    expect(sql).toContain("NEW.excerpt_hash <> encode(public.digest");
    expect(sql).toContain("NEW.value_hash <> encode(public.digest");
    expect(sql).toContain("source.deleted_at");
    expect(sql).toContain("successor.supersedes_source_id");
  });

  it("pins forced RLS, exact command guards, immutable lineage, audit, and outbox", async () => {
    const schema = await readFile(schemaUrl, "utf8");
    const integrity = await readFile(integrityUrl, "utf8");
    for (const table of ["verified_evidence_spans", "claims", "accepted_facts", "fact_claims"]) {
      expect(schema).toContain(`ALTER TABLE truth.${table} ENABLE ROW LEVEL SECURITY`);
      expect(schema).toContain(`ALTER TABLE truth.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("claim acceptance requires its reserved fact.accept command");
    expect(schema).toContain("truth lineage is immutable");
    expect(integrity).toContain(
      "claim.create result does not match its durable Claim and evidence"
    );
    expect(integrity).toContain("fact.accept result does not match its durable Fact and support");
    expect(integrity).toContain("audit.safe_detail = expected_audit_detail");
    expect(integrity).toContain("event.payload = expected_event_payload");
    expect(integrity).toContain("truth command requires exact audit and product outbox rows");
  });

  it("fails source lifecycle closed without implementing Stage 3 reconciliation", async () => {
    const schema = await readFile(schemaUrl, "utf8");
    const integrity = await readFile(integrityUrl, "utf8");
    const lifecycle = await readFile(lifecycleUrl, "utf8");
    expect(schema).not.toMatch(
      /source_artifacts_truth_retention|reconcile_source_retention|fact_lifecycle|b2_retention_command|redacted_at|redaction_|hash_disposition|status = 'revoked'|status = 'rejected'/
    );
    expect(integrity).not.toMatch(/fact_lifecycle|Fact support and lifecycle/);
    expect(integrity).not.toContain("fact.revoke.v1");
    expect(integrity).not.toMatch(/'valueHash'|'supportingClaimsHash'/);
    expect(lifecycle).toContain("truth.verified_evidence_spans");
    expect(lifecycle).toContain("Source lifecycle transition is unavailable");
    expect(lifecycle).toContain("ERRCODE = 'TLB21'");
    expect(lifecycle).toContain("SECURITY DEFINER");
    expect([...lifecycle.matchAll(/UPDATE\s+truth\.([a-z_]+)/gi)].map((match) => match[1])).toEqual(
      ["claims", "accepted_facts"]
    );
    expect(lifecycle).not.toMatch(/DELETE\s+FROM\s+truth\./i);
  });
});
