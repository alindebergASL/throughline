import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertProductValidatorDelegatesExactB1Kinds } from "./b2-catalog-contract.js";

const schemaUrl = new URL("../migrations/0007_b2_slice1_truth_storage.sql", import.meta.url);
const integrityUrl = new URL("../migrations/0008_b2_slice1_command_integrity.sql", import.meta.url);
const lifecycleUrl = new URL(
  "../migrations/0009_b2_source_truth_lifecycle_interlock.sql",
  import.meta.url
);
const initiativeLockUrl = new URL(
  "../migrations/0010_b2_trusted_objective_initiative_lock.sql",
  import.meta.url
);
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
      ],
      [
        "0007_b2_slice1_truth_storage.sql",
        "0e51a502b084e23677c1a0832fc3943a6da33266eae517af2641c61452a9dba8"
      ],
      [
        "0008_b2_slice1_command_integrity.sql",
        "84bcc710743c1850a0995763765b9dbb8506b040d965d33557459fd6eb472fcc"
      ],
      [
        "0009_b2_source_truth_lifecycle_interlock.sql",
        "0463ee762f2af1b4fc61d551398424740f3927e7a31b478717de03c3c88e29f1"
      ]
    ] as const;
    for (const [file, digest] of expected) {
      const bytes = await readFile(new URL(`../migrations/${file}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(digest);
    }
    const runner = await readFile(new URL("./migrations.ts", import.meta.url), "utf8");
    expect(runner).toMatch(
      /case 0:[\s\S]*?validateB1CatalogContract[\s\S]*?case 1:[\s\S]*?additiveB2Phase: 1[\s\S]*?case 2:[\s\S]*?additiveB2Phase: 2[\s\S]*?case 3:[\s\S]*?additiveB2Phase: 3[\s\S]*?case 4:[\s\S]*?additiveB2Phase: 4[\s\S]*?validateB2CatalogContract/
    );
    const b1Contract = await readFile(new URL("./b1-catalog-contract.ts", import.meta.url), "utf8");
    expect(b1Contract).toContain("A staged B2 catalog requires the exact complete B1 predecessor");
    expect(b1Contract).not.toContain("source_artifacts_truth_retention");
    expect(b1Contract).toContain("Fixed staged B2 command integrity contract parser failed");
  });

  it("adds only the established Initiative row-lock capability", async () => {
    const sql = await readFile(initiativeLockUrl, "utf8");

    expect(sql).toBe(initiativeLockSql);
    expect([...sql.matchAll(/\bGRANT\b/gi)]).toHaveLength(1);
    expect([...sql.matchAll(/CREATE POLICY/gi)]).toHaveLength(2);
    expect(sql).toMatch(
      /CREATE POLICY initiatives_app_truth_lock ON work\.initiatives\s+AS PERMISSIVE FOR UPDATE TO throughline_app[\s\S]*?WITH CHECK \(false\);/
    );
    expect(sql).toMatch(
      /CREATE POLICY initiatives_app_permanent_no_write ON work\.initiatives\s+AS RESTRICTIVE FOR UPDATE TO throughline_app\s+USING \(true\)\s+WITH CHECK \(false\);/
    );
    expect(sql).not.toMatch(
      /GRANT\s+UPDATE\s+ON|UPDATE\s*\([^)]*,|\b(?:PUBLIC|throughline_worker|throughline_product_relay)\b|WITH\s+GRANT\s+OPTION|\b(?:ALTER|DROP|INSERT|DELETE|TRUNCATE)\b|truth\.|fact_lifecycle|derived_view|reconcile_source_retention/i
    );
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
    expect(sql).toContain("value_json jsonb NOT NULL");
    expect(sql).not.toContain("canonical_value_text");
    expect(sql).not.toMatch(
      /fact_lifecycle|reconcile_source_retention|source_artifacts_truth_retention|b2_retention_command|redacted_at|redaction_|hash_disposition|status IN \('current','revoked'\)|status IN \('proposed','accepted','rejected'\)/
    );
    expect(sql).not.toMatch(/conflict|supersession|derived_view|command_effect/);
  });

  it("adds only the fail-closed Stage 1 source/truth lifecycle interlock", async () => {
    const sql = await readFile(lifecycleUrl, "utf8");
    expect(sql).toContain("ops.enforce_b2_source_truth_lifecycle_interlock()");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog");
    expect(sql).toContain("OWNER TO throughline_b1_0_integrity");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("truth.verified_evidence_spans");
    expect(sql).toContain("Source lifecycle transition is unavailable");
    expect(sql).toContain("ERRCODE = 'TLB21'");
    expect(sql).toContain("ERRCODE = 'TLB22'");
    expect(sql).toContain("LOCK TABLE content.source_artifacts, content.source_chunks");
    expect(sql).toContain("RENAME COLUMN value_json TO canonical_value_text");
    expect(sql).toContain("ALTER COLUMN canonical_value_text TYPE text");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION truth.require_reserved_command()");
    expect(sql).toContain("row_data jsonb := to_jsonb(NEW)");
    expect(sql).toContain("source_artifacts_z_b2_correction_interlock");
    expect(sql).toContain("source_artifacts_z_b2_tombstone_interlock");
    expect(sql).toContain("source_chunks_z_b2_delete_interlock");
    expect([...sql.matchAll(/UPDATE\s+truth\.([a-z_]+)/gi)].map((match) => match[1])).toEqual([
      "claims",
      "accepted_facts"
    ]);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+truth\.|fact_lifecycle|redact/i);
  });

  it("serializes evidence admission and lifecycle lookup with one exact per-source lock", async () => {
    const sql = await readFile(lifecycleUrl, "utf8");
    const functionSource = (qualifiedName: string) =>
      sql.match(
        new RegExp(
          `CREATE OR REPLACE FUNCTION ${qualifiedName.replaceAll(".", "\\.")}\\(\\)[\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
        )
      )?.[1];
    const evidenceSource = functionSource("truth.verify_evidence_snapshot");
    const lifecycleSource = functionSource("ops.enforce_b2_source_truth_lifecycle_interlock");
    const advisoryLock = evidenceSource?.match(
      /PERFORM pg_catalog\.pg_advisory_xact_lock\([\s\S]*?\n {2}\);/
    )?.[0];

    expect(evidenceSource).toBeDefined();
    expect(lifecycleSource).toBeDefined();
    expect(advisoryLock).toContain("'throughline:b2:source-truth:'");
    expect(lifecycleSource).toContain(advisoryLock);
    expect(evidenceSource!.indexOf(advisoryLock!)).toBeLessThan(
      evidenceSource!.indexOf("SELECT source.version")
    );
    expect(lifecycleSource!.indexOf(advisoryLock!)).toBeLessThan(
      lifecycleSource!.indexOf("EXISTS (")
    );
    expect(sql.match(/'throughline:b2:source-truth:'/g)).toHaveLength(2);
    const chunkRead = evidenceSource!.slice(
      evidenceSource!.indexOf("SELECT chunk.source_artifact_id"),
      evidenceSource!.indexOf("IF source_record IS NULL")
    );
    expect(chunkRead).not.toMatch(/\bFOR (?:UPDATE|SHARE)\b/);
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

  it("replaces the immutable 0008 atomicity function without a PL/pgSQL name collision", async () => {
    const immutableIntegrity = await readFile(integrityUrl, "utf8");
    const additiveLifecycle = await readFile(lifecycleUrl, "utf8");

    expect(immutableIntegrity).toContain("event.aggregate_version = aggregate_version");
    expect(additiveLifecycle).toContain(
      "CREATE OR REPLACE FUNCTION ops.require_b2_slice1_command_atomicity()"
    );
    expect(additiveLifecycle).toContain("expected_aggregate_version integer");
    expect(additiveLifecycle).toContain("event.aggregate_version = expected_aggregate_version");
    expect(additiveLifecycle).not.toMatch(/\bevent\.aggregate_version\s*=\s*aggregate_version\b/);
    expect(additiveLifecycle).toContain("SECURITY DEFINER");
    expect(additiveLifecycle).toContain("SET search_path = pg_catalog");
    expect(additiveLifecycle).toContain(
      "ALTER FUNCTION ops.require_b2_slice1_command_atomicity()\n  OWNER TO throughline_b1_0_integrity"
    );
    expect(additiveLifecycle).toContain(
      "REVOKE ALL ON FUNCTION ops.require_b2_slice1_command_atomicity() FROM PUBLIC"
    );
  });

  it("replaces shared Fact-support trigger field selection with relation-agnostic row data", async () => {
    const additiveLifecycle = await readFile(lifecycleUrl, "utf8");
    const functionDefinition = additiveLifecycle.match(
      /CREATE OR REPLACE FUNCTION truth\.validate_fact_support\(\)[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
    );
    const functionSource = functionDefinition?.[1];

    expect(functionSource).toBeDefined();
    expect(functionSource).toContain("row_data jsonb := to_jsonb(NEW)");
    expect(functionSource).toContain("WHEN 'accepted_facts' THEN row_data ->> 'id'");
    expect(functionSource).toContain("WHEN 'fact_claims' THEN row_data ->> 'fact_id'");
    expect(functionSource).not.toMatch(/\bNEW\.(?:id|fact_id)\b/);
    expect(functionDefinition?.[0]).toContain("SET search_path = pg_catalog");
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
