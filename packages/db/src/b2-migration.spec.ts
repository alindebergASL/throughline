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
const objectiveRecoveryUrl = new URL(
  "../migrations/0011_b2_primary_objective_proposal_recovery.sql",
  import.meta.url
);
const factLifecycleUrl = new URL("../migrations/0012_b2_fact_lifecycle.sql", import.meta.url);
const migrationFunctionBody = (migration: string, identity: string): string | undefined => {
  const escapedIdentity = identity.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return migration.match(
    new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION ${escapedIdentity}\\([^)]*\\)[\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
    )
  )?.[1];
};
const exact0012FunctionBodyDigests = {
  "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)":
    "144d82c83595006551ae90b66cb279e0605054470a3b82f89d7d13e53f12475a",
  "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)":
    "6d0c4b56de9120cb11375c7cceb92a7871adf2c3cd122e3eaa3c964dd1ea81f0",
  "ops.b2_slice1_safe_request_valid(text,jsonb)":
    "411d840a4103fad18a06842df04cf9edca89aeeba166b6b5726fbd183d586eef",
  "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)":
    "e5c46c5b0d47712951dce2d60e55f28bca1e7cca795658c196836b7e8fe7affa",
  "ops.require_b2_slice1_command_atomicity()":
    "2ed3c76136938f08846defd78c14ed84d5c50ac915a9fb946b25fbed17819f48",
  "truth.enforce_claim_transition()":
    "0bef1037a525126dad73b202c4dd59cd8be26fed48d6fb36657afd59b140bf48",
  "truth.enforce_fact_lifecycle_transition()":
    "967ec9269eb34f79e35ba6113f22ec29ba1c5d74819546b4716d982b59336a10",
  "truth.reject_statement_mutation()":
    "e8a66bfefb5d061c9981613e9e581872595c6f3fff384c20cd5513d7503902ae",
  "truth.require_fact_accept_reservation()":
    "6e3a8170aeb14d4cf474c3ed0acf9b122efa7d732e1530bad205a8c4d17190bb",
  "truth.require_fact_lifecycle_command()":
    "9ab571a5144343140ed4511d70c9e2127ec3b68b9c97fdd249c4cfe04e5b0e07",
  "truth.require_fact_lifecycle_event()":
    "16e0ece019be747f0ac189bdb092b622ae37d6183990dd2b54e9d02a126135c9",
  "truth.require_reserved_command()":
    "5d5ebd2c3623d64c51f6a393ddcf593149cd3ef5d0e474a157e86ca534d83c36",
  "truth.validate_fact_insert()":
    "0b8110b64ae04d0c3140d3a338f5d0d056695d5612080ba6b6d94abd1464f8ef",
  "truth.validate_fact_support()":
    "a8ad48c8b431bf21e11f6468f40e34eeb148d1fe50fa1637602e2e9f7c02f046",
  "truth.validate_fact_lifecycle_event()":
    "40a11b34d6a9cdb43a496523b81c3bade3b340600a6b21b4e97453e1dc55b550"
} as const;
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
      ],
      [
        "0010_b2_trusted_objective_initiative_lock.sql",
        "1fac8f65c9dd80262ea577f1109ca1e6fa4822983cb62ac52868b138e375bb93"
      ],
      [
        "0011_b2_primary_objective_proposal_recovery.sql",
        "e1160864d02eff6baa56f326bba93a6b79e98904b604fd7f5823672c7885f1f2"
      ]
    ] as const;
    for (const [file, digest] of expected) {
      const bytes = await readFile(new URL(`../migrations/${file}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(digest);
    }
    const runner = await readFile(new URL("./migrations.ts", import.meta.url), "utf8");
    expect(runner).toMatch(
      /case 0:[\s\S]*?validateB1CatalogContract[\s\S]*?case 1:[\s\S]*?additiveB2Phase: 1[\s\S]*?case 2:[\s\S]*?additiveB2Phase: 2[\s\S]*?case 3:[\s\S]*?additiveB2Phase: 3[\s\S]*?case 4:[\s\S]*?additiveB2Phase: 4[\s\S]*?case 5:[\s\S]*?additiveB2Phase: 5[\s\S]*?case 6:[\s\S]*?additiveB2Phase: 6[\s\S]*?validateB2CatalogContract/
    );
    const b1Contract = await readFile(new URL("./b1-catalog-contract.ts", import.meta.url), "utf8");
    expect.soft(b1Contract).toMatch(/type AdditiveB2Phase = 0 \| 1 \| 2 \| 3 \| 4 \| 5 \| 6;/);
    expect
      .soft(b1Contract)
      .toContain('const B2_FACT_LIFECYCLE_MIGRATION_ID = "0012_b2_fact_lifecycle.sql";');
    expect(b1Contract).toContain("A staged B2 catalog requires the exact complete B1 predecessor");
    expect(b1Contract).not.toContain("source_artifacts_truth_retention");
    expect(b1Contract).toContain("Fixed staged B2 command integrity contract parser failed");
    const commandIntegrityContract = b1Contract.match(
      /async function validateCommandIntegrityObjects[\s\S]*?\n}\n\nconst integrityPolicyContracts/
    )?.[0];
    expect(commandIntegrityContract).toBeDefined();
    expect(commandIntegrityContract).toContain("if (additiveB2Phase >= 5)");
    expect(commandIntegrityContract).toContain("B2_OBJECTIVE_RECOVERY_MIGRATION_ID");
    expect(commandIntegrityContract).toContain(
      "Fixed objective recovery command trigger contract parser failed"
    );
    expect(commandIntegrityContract).toContain(
      'dropB2TriggerStatement.replace("ops.domain_command_records", expectedRelation)'
    );
    expect(commandIntegrityContract).toContain(
      '"ON ops.domain_command_records",\n        `ON ${expectedRelation}`'
    );
    expect.soft(commandIntegrityContract).toContain("if (additiveB2Phase >= 6)");
    expect.soft(commandIntegrityContract).toContain("B2_FACT_LIFECYCLE_MIGRATION_ID");
    expect.soft(commandIntegrityContract).toContain("factLifecycleConstraintStatement");
    expect.soft(commandIntegrityContract).toContain("dropPhase5B2TriggerStatement");
    expect.soft(commandIntegrityContract).toContain("replacementPhase6B2TriggerStatement");
    expect
      .soft(commandIntegrityContract)
      .toContain("Fixed Fact lifecycle command integrity contract parser failed");
    const phase6Dispatch = runner.match(/case 6:[\s\S]*?(?=\n[ ]{4}case \d+:|\n[ ]{2}})/)?.[0];
    expect.soft(phase6Dispatch).toBeDefined();
    expect.soft(phase6Dispatch).toMatch(/additiveB2Phase:\s*6\s*\n/);
    expect.soft(phase6Dispatch).not.toMatch(/\bas\b|unknown/);
    const integrityCapabilityContract = b1Contract.match(
      /const objectiveRecoveryIntegrityRelations[\s\S]*?async function validateIntegrityPredecessorAccess[\s\S]*?\n}/
    )?.[0];
    expect(integrityCapabilityContract).toBeDefined();
    expect(integrityCapabilityContract).toContain(
      '"truth.initiative_objective_proposal_recoveries"'
    );
    expect(integrityCapabilityContract).toContain(
      '"truth.initiative_objective_support_attestations"'
    );
    expect(integrityCapabilityContract).toContain('name: "objective_recovery_integrity_select"');
    expect(integrityCapabilityContract).toContain('name: "objective_support_integrity_select"');
    expect(integrityCapabilityContract).toContain("if (additiveB2Phase >= 5)");
    expect(integrityCapabilityContract).toContain(
      "expectedPredecessorAcl(integrityInstalled, additiveB2Phase)"
    );
    expect(integrityCapabilityContract).toContain(
      'predecessorAclRows(relation, "table", [], "throughline_app", ["INSERT", "SELECT"])'
    );
    expect
      .soft(integrityCapabilityContract)
      .toContain(
        'const factLifecycleIntegrityRelations = ["truth.fact_lifecycle_events"] as const;'
      );
    expect.soft(integrityCapabilityContract).toContain('name: "fact_lifecycle_integrity_select"');
    expect.soft(integrityCapabilityContract).toContain("if (additiveB2Phase >= 6)");
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

  it("adds a bounded immutable objective-proposal recovery ledger and no generic lifecycle", async () => {
    const sql = await readFile(objectiveRecoveryUrl, "utf8");
    expect([...sql.matchAll(/CREATE TABLE truth\.([a-z_]+)/g)].map((match) => match[1])).toEqual([
      "initiative_objective_support_attestations",
      "initiative_objective_proposal_recoveries"
    ]);
    expect(sql).toContain("claims_one_active_primary_objective_proposal");
    expect(sql).toContain("DROP CONSTRAINT claims_status_check");
    expect(sql).toContain("status IN ('proposed','accepted','rejected','superseded')");
    expect(sql).toContain("status IN ('accepted','rejected','superseded') AND version = 2");
    expect(sql).toContain("(to_jsonb(NEW) - ARRAY['status','version','updated_at'])");
    expect(sql).toContain("objective_support_immutable");
    expect(sql).toContain("objective_recovery_immutable");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).not.toMatch(
      /CREATE TABLE truth\.(?:claim_lifecycle|fact_lifecycle|fact_supersessions|conflict_groups)|DELETE FROM truth\.|UPDATE truth\.accepted_facts/
    );
  });

  it("fails acceptance closed on support while allowing unconfirmed legacy proposals to terminalize", async () => {
    const sql = await readFile(objectiveRecoveryUrl, "utf8");
    expect(sql).toContain("objective acceptance requires human support confirmation");
    expect(sql).toContain("claim_record.status IN ('proposed','accepted')");
    expect(sql).toContain("claim_record.status IN ('rejected','superseded')");
    expect(sql).toContain("attestation_count IN (0, 1)");
    expect(sql).toContain("row_data jsonb := to_jsonb(NEW)");
    expect(sql).toContain("WHEN 'claims' THEN row_data ->> 'id'");
    const recoveryValidator = sql.slice(
      sql.indexOf("CREATE FUNCTION truth.validate_objective_recovery()"),
      sql.indexOf("CREATE FUNCTION truth.require_objective_recovery_for_terminal_claim()")
    );
    expect(recoveryValidator).toContain("IF NEW.disposition = 'reworked' THEN");
    expect(recoveryValidator).toContain("IF predecessor.status <> 'superseded'");
    expect(recoveryValidator).toContain("ELSIF NEW.disposition IN ('withdrawn','rejected') THEN");
    expect(recoveryValidator).toContain("IF predecessor.status <> 'rejected'");
    const withdrawalBranch = recoveryValidator.slice(
      recoveryValidator.indexOf("ELSIF NEW.disposition IN ('withdrawn','rejected') THEN"),
      recoveryValidator.indexOf("  ELSE", recoveryValidator.indexOf("ELSIF NEW.disposition"))
    );
    expect(withdrawalBranch).not.toMatch(/successor\.(?:id|subject_id|predicate|status|version)/);
    expect(recoveryValidator).not.toMatch(/NEW\.disposition = 'reworked' AND \([\s\S]*successor\./);
    expect(sql).toContain("attestation.confirmed_by_user_id = claim_record.created_by_user_id");
    expect(sql).toContain("attestation.causation_command_id = claim_record.causation_command_id");
    const deferredRecovery = sql.slice(
      sql.indexOf("CREATE FUNCTION truth.validate_objective_recovery()"),
      sql.indexOf("CREATE OR REPLACE FUNCTION truth.require_reserved_command()")
    );
    expect(deferredRecovery).toContain("command.state = 'completed'");
    const immediateGuards = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION truth.require_reserved_command()"),
      sql.indexOf("CREATE OR REPLACE FUNCTION truth.enforce_claim_transition()")
    );
    expect(immediateGuards.indexOf("ERRCODE = 'TLB22'")).toBeLessThan(
      immediateGuards.indexOf("command.state = 'reserved'")
    );
    expect(immediateGuards).toContain("MESSAGE = 'Truth mutation transaction is unavailable'");
    expect(immediateGuards).toContain("command.state = 'reserved'");
  });

  it("pins exact recovery audit/outbox vocabulary and excludes objective/source text", async () => {
    const sql = await readFile(objectiveRecoveryUrl, "utf8");
    for (const value of [
      "initiative.primary_objective.withdraw",
      "initiative.primary_objective.rework",
      "initiative.primary_objective.proposal_withdrawn",
      "initiative.primary_objective.proposal_rejected",
      "initiative.primary_objective.proposal_reworked",
      "predecessorClaimId",
      "successorClaimId",
      "evidenceSpanId",
      "supportAttestationId",
      "recoveryId",
      "reasonCode"
    ]) {
      expect(sql).toContain(value);
    }
    const atomicity = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION ops.require_b2_slice1_command_atomicity")
    );
    const eventPayloadValidator = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION ops.b2_slice1_event_payload_valid"),
      sql.indexOf("CREATE OR REPLACE FUNCTION ops.b2_slice1_audit_detail_valid")
    );
    const safeRequestValidator = sql.slice(
      sql.indexOf("CREATE FUNCTION ops.b2_slice1_safe_request_valid"),
      sql.indexOf(
        "ALTER TABLE ops.domain_command_records",
        sql.indexOf("CREATE FUNCTION ops.b2_slice1_safe_request_valid")
      )
    );
    expect(safeRequestValidator).toContain("octet_length(request_value::text) > 8192");
    expect(safeRequestValidator).not.toContain("ops.product_safe_json(request_value)");
    expect(safeRequestValidator).not.toMatch(/sourceExcerpt|sourceText|objectiveText/);
    expect(safeRequestValidator).toContain(
      "'expectedLatestClaimId','expectedLatestClaimStatus','expectedLatestClaimVersion',"
    );
    expect(safeRequestValidator).toContain(
      "jsonb_typeof(request_value -> 'expectedLatestClaimId') = 'null'"
    );
    expect(safeRequestValidator).toContain("RETURN COALESCE((request_keys = ARRAY[");
    expect(safeRequestValidator).toContain(
      "RETURN COALESCE((request_value ->> 'subjectType' IN ('activity','initiative')"
    );
    expect(safeRequestValidator).toContain("), false) THEN RETURN false; END IF;");
    expect(sql).not.toContain("command_request ->> 'subjectType' <> NEW.subject_type");
    expect(sql).not.toContain("command_request ->> 'sourceArtifactId' <> NEW.source_artifact_id");
    expect(eventPayloadValidator).toContain(
      "ARRAY['claimId','evidenceSpanId','supportAttestationId']"
    );
    expect(eventPayloadValidator).toContain(
      "ARRAY['claimId','claimVersion','disposition','reasonCode','recoveryId']"
    );
    expect(eventPayloadValidator).toContain(
      "'needs_rework','unsupported','incorrect','duplicate','not_useful','sensitive','other'"
    );
    expect(eventPayloadValidator).toContain(
      "'disposition','evidenceSpanId','predecessorClaimId','predecessorVersion','reasonCode',\n" +
        "        'recoveryId','successorClaimId','successorVersion','supportAttestationId'"
    );
    expect(eventPayloadValidator).toContain("payload_value ->> 'reasonCode' = 'reworked'");
    expect(atomicity).toContain("audit_count <> 1 OR outbox_count <> 1");
    expect(atomicity).toContain("audit.safe_detail = expected_audit_detail");
    expect(atomicity).toContain("event.payload = expected_event_payload");
    expect(atomicity).toContain("caused_claim_count <> 1");
    expect(atomicity).toContain("caused_recovery_count <> 1");
    expect(atomicity).toContain("caused_attestation_count <> 1");
    expect(atomicity).toContain("NEW.safe_request ->> 'predecessorClaimId'");
    expect(atomicity).toContain("claim.create objective generation is stale");
    expect(atomicity).toContain("latest_predecessor_claim_id IS DISTINCT FROM");
    expect(sql).toContain("UNIQUE (tenant_id, workspace_id, causation_command_id)");
    expect(sql).toContain("domain_command_records_b2_safe_request_check");
    expect(sql).toContain("ADD COLUMN safe_request_adopted boolean NOT NULL DEFAULT false");
    expect(sql).toContain(
      "SET safe_request = reconstructable.safe_request,\n       safe_request_adopted = true"
    );
    expect(sql).toContain("'supportConfirmed', false");
    expect(sql).toContain("AND NOT safe_request_adopted");
    expect(sql).toContain("AND safe_request_adopted");
    expect(sql).toContain("jsonb_set(safe_request, '{supportConfirmed}', 'true'::jsonb, false)");
    expect(sql.match(/b2_slice1_safe_request_valid\([\s\S]*?\) IS TRUE/g)).toHaveLength(5);
    expect(sql).toContain("GRANT INSERT (safe_request) ON ops.domain_command_records");
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE) \(safe_request_adopted\)/);
    expect(sql).toContain(
      "'normalizationVersion','predecessorClaimId','predicate','sourceArtifactId'"
    );
    expect(atomicity).not.toMatch(/sourceExcerpt|sourceText|objectiveText/);
  });

  it("adds only bounded ordinary Fact supersession and revocation durability", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");

    expect([...sql.matchAll(/CREATE TABLE truth\.([a-z_]+)/g)].map((match) => match[1])).toEqual([
      "fact_lifecycle_events"
    ]);
    for (const required of [
      "predecessor_fact_id",
      "successor_fact_id",
      "transition_kind",
      "from_status",
      "to_status",
      "reason_code",
      "reason_rationale",
      "authority_basis",
      "acted_by_user_id",
      "acted_by_membership_id",
      "policy_version",
      "causation_command_id",
      "recorded_at",
      "version"
    ]) {
      expect(sql).toContain(required);
    }
    expect(sql).toContain("status IN ('current','superseded','revoked')");
    expect(sql).toMatch(
      /status = 'current'[\s\S]*?version = 1[\s\S]*?status IN \('superseded','revoked'\)[\s\S]*?version = 2/
    );
    expect(sql).toMatch(
      /transition_kind = 'supersede'[\s\S]*?successor_fact_id IS NOT NULL[\s\S]*?transition_kind = 'revoke'[\s\S]*?successor_fact_id IS NULL/
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(tenant_id, workspace_id, space_id, predecessor_fact_id\)[\s\S]*?REFERENCES truth\.accepted_facts\(tenant_id, workspace_id, space_id, id\)[\s\S]*?MATCH FULL[\s\S]*?ON UPDATE RESTRICT ON DELETE RESTRICT[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(tenant_id, workspace_id, space_id, successor_fact_id\)[\s\S]*?REFERENCES truth\.accepted_facts\(tenant_id, workspace_id, space_id, id\)[\s\S]*?ON UPDATE RESTRICT ON DELETE RESTRICT[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    );
    expect(sql).toMatch(
      /to_jsonb\(NEW\) - ARRAY\[\s*'status','last_causation_command_id','updated_at','version'\s*\][\s\S]*?to_jsonb\(OLD\) - ARRAY\[\s*'status','last_causation_command_id','updated_at','version'\s*\]/
    );
    expect(sql).not.toMatch(/DROP (?:INDEX|TRIGGER) (?:truth\.)?accepted_facts_one_current_slot/);
    expect(sql).not.toMatch(
      /DROP TRIGGER (?:claims_delete_guard|fact_claims_immutable|verified_evidence_immutable)/
    );
    expect(sql).toMatch(
      /CREATE TRIGGER fact_lifecycle_immutable\s+BEFORE (?:DELETE OR UPDATE|UPDATE OR DELETE) ON truth\.fact_lifecycle_events/
    );
    expect(sql).toMatch(
      /CREATE TRIGGER fact_lifecycle_truncate_guard\s+BEFORE TRUNCATE ON truth\.fact_lifecycle_events\s+FOR EACH STATEMENT/
    );

    expect(sql).toContain("ALTER TABLE truth.fact_lifecycle_events ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE truth.fact_lifecycle_events FORCE ROW LEVEL SECURITY");
    for (const policy of [
      "accepted_facts_lifecycle_update",
      "fact_lifecycle_select",
      "fact_lifecycle_insert",
      "fact_lifecycle_integrity_select"
    ]) {
      expect(sql).toContain(`CREATE POLICY ${policy}`);
    }
    expect(sql).toMatch(/GRANT SELECT, INSERT ON truth\.fact_lifecycle_events TO throughline_app;/);
    expect(sql).toMatch(
      /GRANT UPDATE \(status, last_causation_command_id, updated_at, version\)[\s\S]*?truth\.accepted_facts TO throughline_app;/
    );
    expect(sql).not.toMatch(
      /GRANT (?:UPDATE|DELETE|TRUNCATE) ON truth\.fact_lifecycle_events|GRANT (?:UPDATE|DELETE|TRUNCATE) ON truth\.accepted_facts|GRANT[^;]*?TO (?:PUBLIC|throughline_worker|throughline_relay|throughline_product_relay);/
    );

    for (const command of ["fact.supersede.v1", "fact.revoke.v1"]) {
      expect(sql).toContain(command);
    }
    expect(sql).toContain("domain_command_records_b2_slice1_atomicity_deferred");
    expect(sql).toContain("audit_count <> 1 OR outbox_count <> 1");
    expect(sql).toContain("fact.superseded");
    expect(sql).toContain("fact.revoked");
    expect(sql).toContain("caused_lifecycle_count <> 1");
    expect(sql).toContain("predecessor_fact_count <> 1");
    expect(sql).toContain("successor_fact_count <> 1");
    expect(sql).toContain("successor_fact_id_value uuid;");
    expect(sql).not.toContain("successor_fact_id uuid;");
    expect(sql).toContain("lifecycle.successor_fact_id = successor_fact_id_value");
    expect(sql).toContain("'replacementFactId', successor_fact_id_value");
    expect(sql).toMatch(/fact\.revoke\.v1[\s\S]*?successor_fact_count <> 0/);
    expect(sql).not.toMatch(
      /fact\.(?:contest|uphold|emergency(?:[._][a-z0-9_]+)*|source(?:[._][a-z0-9_]+)*reconcil[a-z_]*)\.v\d+|(?:derived_view|derived_views)(?:\.[a-z0-9_]+)*\.v\d+|(?:contest|uphold|emergency|derived_view|source_reconcil)[a-z_]*_(?:event|command|record|store|view)s?|reconcile_source_retention|source_artifacts_truth_retention/i
    );
  });

  it("locks and consumes the durable supersede subject version without adding owner authorization", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const transition = migrationFunctionBody(sql, "truth.enforce_fact_lifecycle_transition");

    expect(transition).toBeDefined();
    expect(transition).toMatch(
      /IF OLD\.subject_type = 'activity' THEN[\s\S]*?SELECT subject\.version INTO subject_version[\s\S]*?FROM work\.activities subject[\s\S]*?FOR SHARE;[\s\S]*?ELSE[\s\S]*?SELECT subject\.version INTO subject_version[\s\S]*?FROM work\.initiatives subject[\s\S]*?FOR SHARE;/
    );
    expect(transition).toContain(
      "(command.safe_request #>> '{subject,expectedVersion}')::integer = subject_version"
    );
    expect(transition).toContain("MESSAGE = 'fact supersede subject version is stale'");
    expect(transition).not.toMatch(
      /owner_person_id|membership\.person_id|activity_owner|initiative_owner/
    );
  });

  it("requires every supersede replacement Claim to consume its requested pre-transition version", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const transition = migrationFunctionBody(sql, "truth.enforce_claim_transition");

    expect(transition).toBeDefined();
    expect(transition).toContain("command.command_kind IN ('fact.accept.v1','fact.supersede.v1')");
    expect(transition).toMatch(
      /command_kind_value = 'fact\.supersede\.v1'[\s\S]*?jsonb_array_elements\(command_request -> 'replacementClaims'\)[\s\S]*?claim_ref ->> 'claimId' = OLD\.id::text[\s\S]*?\(claim_ref ->> 'expectedVersion'\)::integer = OLD\.version/
    );
    expect(transition).toContain("MESSAGE = 'fact supersede replacement Claim version is stale'");
    expect(transition).toContain(
      "MESSAGE = 'fact supersede support set does not match replacementClaims'"
    );
  });

  it("accepts exactly the base supersede request or its confidenceLowering alternative", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const validator = migrationFunctionBody(sql, "ops.b2_slice1_safe_request_valid");

    expect(validator).toBeDefined();
    expect(validator).toMatch(
      /RETURN COALESCE\(\(\(\s*request_keys = ARRAY\['expectedFactVersion','factId','reason','replacementClaims','subject'\]\s+OR request_keys = ARRAY\[\s*'confidenceLowering','expectedFactVersion','factId','reason','replacementClaims','subject'\s*\]\s*\)\s+AND jsonb_typeof\(request_value -> 'factId'\) = 'string'\s+AND jsonb_typeof\(request_value -> 'expectedFactVersion'\) = 'number'\s+AND ops\.is_uuid_v7[\s\S]*?AND \(NOT \(request_value \? 'confidenceLowering'\) OR \([\s\S]*?AND length\(request_value #>> '\{confidenceLowering,reason,rationale\}'\)\s+BETWEEN 1 AND 2000\s*\)\)\), false\);/
    );
    expect(validator).toContain("jsonb_typeof(request_value -> 'confidenceLowering') = 'object'");
    expect(validator).toMatch(
      /jsonb_object_keys\(request_value -> 'confidenceLowering'\)[\s\S]*?= ARRAY\['confidence','reason'\]/
    );
    expect(validator).toMatch(
      /request_value #>> '\{confidenceLowering,confidence\}' IN\s+\('confirmed','strong','weak','unknown'\)/
    );
    expect(validator).toMatch(
      /jsonb_object_keys\(request_value #> '\{confidenceLowering,reason\}'\)[\s\S]*?= ARRAY\['code','rationale'\]/
    );
    expect(validator).toMatch(
      /request_value #>> '\{confidenceLowering,reason,code\}' IN \(\s*'conservative_human_judgment','evidence_quality','residual_uncertainty'\s*\)/
    );
    expect(validator).toMatch(
      /request_value #>> '\{confidenceLowering,reason,rationale\}' =\s*normalize\(request_value #>> '\{confidenceLowering,reason,rationale\}', NFC\)/
    );
    expect(validator).toMatch(
      /length\(request_value #>> '\{confidenceLowering,reason,rationale\}'\)\s+BETWEEN 1 AND 2000/
    );
    expect(validator).toContain("EXCEPTION WHEN OTHERS THEN RETURN false;");
    expect(validator).not.toMatch(/(?:request_value|request_keys)[^\n]*conflict/);
  });

  it("binds executable successor confidence and lowering provenance at INSERT time", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const reservation = migrationFunctionBody(sql, "truth.require_reserved_command");

    expect(reservation).toBeDefined();
    expect(reservation).toMatch(
      /ELSIF TG_TABLE_NAME = 'accepted_facts' THEN\s+IF actual_kind = 'fact\.supersede\.v1' AND/
    );
    expect(reservation).toContain("command_request ? 'confidenceLowering'");
    expect(reservation).toMatch(
      /command_request #>> '\{confidenceLowering,confidence\}' IS DISTINCT FROM\s+row_data ->> 'confidence'[\s\S]*?\(row_data ->> 'human_lowered'\)::boolean IS DISTINCT FROM true[\s\S]*?command_request #>> '\{confidenceLowering,reason,code\}' IS DISTINCT FROM\s+row_data ->> 'confidence_lowering_reason_code'[\s\S]*?command_request #>> '\{confidenceLowering,reason,rationale\}' IS DISTINCT FROM\s+row_data ->> 'confidence_lowering_rationale'/
    );
    expect(reservation).toMatch(
      /NOT \(command_request \? 'confidenceLowering'\)[\s\S]*?row_data ->> 'confidence' IS DISTINCT FROM\s+row_data ->> 'strongest_supporting_confidence'[\s\S]*?\(row_data ->> 'human_lowered'\)::boolean IS DISTINCT FROM false[\s\S]*?row_data ->> 'confidence_lowering_reason_code' IS NOT NULL[\s\S]*?row_data ->> 'confidence_lowering_rationale' IS NOT NULL/
    );
    expect(reservation).toContain(
      "RAISE EXCEPTION 'truth mutation requires its exact reserved command'"
    );
  });

  it("keeps the shared reservation trigger shape-safe for every attached truth row", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const reservation = migrationFunctionBody(sql, "truth.require_reserved_command");

    expect(reservation).toBeDefined();
    expect(reservation).toContain("row_data jsonb := to_jsonb(NEW)");
    expect(
      [...reservation!.matchAll(/\bNEW\.([a-z][a-z0-9_]*)/g)].map((match) => match[1])
    ).toEqual([]);
    for (const field of [
      "tenant_id",
      "workspace_id",
      "space_id",
      "subject_type",
      "subject_id",
      "predicate",
      "last_causation_command_id"
    ]) {
      expect(reservation).toContain(`row_data ->> '${field}'`);
    }
  });

  it("positively binds successor insertion to the exact terminalized predecessor", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const reservation = migrationFunctionBody(sql, "truth.require_reserved_command");
    const authority = migrationFunctionBody(sql, "truth.validate_fact_insert");

    expect(reservation).toBeDefined();
    const successorReservation = reservation!.slice(
      reservation!.indexOf("ELSIF TG_TABLE_NAME = 'accepted_facts' THEN")
    );
    expect(successorReservation).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM truth\.accepted_facts predecessor[\s\S]*?predecessor\.tenant_id = \(row_data ->> 'tenant_id'\)::uuid[\s\S]*?predecessor\.workspace_id = \(row_data ->> 'workspace_id'\)::uuid[\s\S]*?predecessor\.space_id = \(row_data ->> 'space_id'\)::uuid[\s\S]*?predecessor\.id::text = command_request ->> 'factId'[\s\S]*?predecessor\.subject_type = row_data ->> 'subject_type'[\s\S]*?predecessor\.subject_id = \(row_data ->> 'subject_id'\)::uuid[\s\S]*?predecessor\.predicate = row_data ->> 'predicate'[\s\S]*?predecessor\.status = 'superseded'[\s\S]*?predecessor\.version = 2[\s\S]*?predecessor\.last_causation_command_id =\s*\(row_data ->> 'last_causation_command_id'\)::uuid/
    );
    expect(successorReservation).toContain(
      "RAISE EXCEPTION 'truth mutation requires its exact reserved command'"
    );

    expect(authority).toBeDefined();
    expect(authority).toMatch(
      /command_kind_value = 'fact\.supersede\.v1'[\s\S]*?NOT EXISTS \(\s*SELECT 1 FROM truth\.accepted_facts predecessor[\s\S]*?predecessor\.id::text = command_request ->> 'factId'[\s\S]*?predecessor\.status = 'superseded'[\s\S]*?predecessor\.version = 2[\s\S]*?predecessor\.last_causation_command_id = NEW\.last_causation_command_id/
    );
  });

  it("collides only with a current Fact while preserving terminal coordinate history", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const authority = migrationFunctionBody(sql, "truth.validate_fact_insert");

    expect(authority).toBeDefined();
    expect(authority).toMatch(
      /command_kind_value = 'fact\.accept\.v1'[\s\S]*?EXISTS \(\s*SELECT 1 FROM truth\.accepted_facts current_fact[\s\S]*?current_fact\.tenant_id = NEW\.tenant_id[\s\S]*?current_fact\.workspace_id = NEW\.workspace_id[\s\S]*?current_fact\.space_id = NEW\.space_id[\s\S]*?current_fact\.subject_type = NEW\.subject_type[\s\S]*?current_fact\.subject_id = NEW\.subject_id[\s\S]*?current_fact\.predicate = NEW\.predicate[\s\S]*?current_fact\.status = 'current'/
    );
    expect(authority).not.toMatch(
      /EXISTS \(\s*SELECT 1 FROM truth\.accepted_facts prior[\s\S]*?AND NOT \(command_kind_value = 'fact\.supersede\.v1'/
    );
  });

  it("rejects every accepted or successor Fact below its current non-archived Space class", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const authority = migrationFunctionBody(sql, "truth.validate_fact_insert");

    expect(authority).toBeDefined();
    expect(authority).toMatch(
      /SELECT space\.access_class INTO current_space_access_class[\s\S]*?FROM access\.spaces space[\s\S]*?space\.tenant_id = NEW\.tenant_id[\s\S]*?space\.workspace_id = NEW\.workspace_id[\s\S]*?space\.id = NEW\.space_id[\s\S]*?space\.archived_at IS NULL[\s\S]*?FOR SHARE/
    );
    expect(authority).toContain("current_space_access_class IS NULL");
    expect(authority).toMatch(
      /content\.access_class_rank\(NEW\.access_class\)\s*<\s*content\.access_class_rank\(current_space_access_class\)/
    );
    expect(authority).toContain(
      "RAISE EXCEPTION 'fact access class is below current Space classification'"
    );
    const spaceCheck = authority!.indexOf("current_space_access_class IS NULL");
    expect(spaceCheck).toBeGreaterThan(-1);
    expect(spaceCheck).toBeLessThan(authority!.indexOf("command_kind_value = 'fact.accept.v1'"));
    expect(spaceCheck).toBeLessThan(authority!.indexOf("command_kind_value = 'fact.supersede.v1'"));
  });

  it("requires exact Fact classification from current Space plus persisted Claim evidence", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const support = migrationFunctionBody(sql, "truth.validate_fact_support");

    expect(support).toBeDefined();
    expect(support).toContain("row_data jsonb := to_jsonb(NEW)");
    expect(support).toContain("WHEN 'accepted_facts' THEN row_data ->> 'id'");
    expect(support).toContain("WHEN 'fact_claims' THEN row_data ->> 'fact_id'");
    expect(support).toMatch(
      /SELECT content\.access_class_rank\(space\.access_class\)[\s\S]*?FROM access\.spaces space[\s\S]*?space\.tenant_id = fact_record\.tenant_id[\s\S]*?space\.workspace_id = fact_record\.workspace_id[\s\S]*?space\.id = fact_record\.space_id[\s\S]*?space\.archived_at IS NULL/
    );
    expect(support).toMatch(
      /LEFT JOIN truth\.verified_evidence_spans evidence[\s\S]*?evidence\.id = claim\.verified_evidence_span_id/
    );
    expect(support).toContain("evidence.access_class <> claim.access_class");
    expect(support).toMatch(
      /max\(GREATEST\([\s\S]*?content\.access_class_rank\(claim\.access_class\)[\s\S]*?content\.access_class_rank\(evidence\.access_class\)[\s\S]*?INTO support_count, invalid_count, strongest_rank, support_access/
    );
    expect(support).toContain("required_access := GREATEST(required_access, support_access)");
    expect(support).toContain(
      "content.access_class_rank(fact_record.access_class) <> required_access"
    );
    expect(support).toContain("RAISE EXCEPTION 'accepted fact support is invalid'");
  });

  it("classifies lifecycle rows by predecessor and optional successor visibility", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const policySql = (name: string) =>
      sql.slice(
        sql.indexOf(`CREATE POLICY ${name}`),
        sql.indexOf(";", sql.indexOf(`CREATE POLICY ${name}`)) + 1
      );

    for (const name of ["fact_lifecycle_select", "fact_lifecycle_insert"]) {
      const policy = policySql(name);
      expect(policy).toMatch(
        /EXISTS \(\s*SELECT 1 FROM truth\.accepted_facts predecessor[\s\S]*?predecessor\.tenant_id = fact_lifecycle_events\.tenant_id[\s\S]*?predecessor\.workspace_id = fact_lifecycle_events\.workspace_id[\s\S]*?predecessor\.space_id = fact_lifecycle_events\.space_id[\s\S]*?predecessor\.id = fact_lifecycle_events\.predecessor_fact_id[\s\S]*?access\.can_read_space\(fact_lifecycle_events\.space_id, predecessor\.access_class\)/
      );
      expect(policy).toMatch(
        /successor_fact_id IS NULL OR EXISTS \(\s*SELECT 1 FROM truth\.accepted_facts successor[\s\S]*?successor\.tenant_id = fact_lifecycle_events\.tenant_id[\s\S]*?successor\.workspace_id = fact_lifecycle_events\.workspace_id[\s\S]*?successor\.space_id = fact_lifecycle_events\.space_id[\s\S]*?successor\.id = fact_lifecycle_events\.successor_fact_id[\s\S]*?access\.can_read_space\(fact_lifecycle_events\.space_id, successor\.access_class\)/
      );
    }
  });

  it("rebinds successor confidence in deferred atomicity without recalculating support", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const atomicity = migrationFunctionBody(sql, "ops.require_b2_slice1_command_atomicity");

    expect(atomicity).toBeDefined();
    expect(atomicity).toContain("successor_confidence text;");
    expect(atomicity).toContain("successor_strongest_confidence text;");
    expect(atomicity).toContain("successor_human_lowered boolean;");
    expect(atomicity).toContain("successor_lowering_reason_code text;");
    expect(atomicity).toContain("successor_lowering_rationale text;");
    expect(atomicity).not.toContain("actual_strongest_support_rank");
    expect(atomicity).not.toContain("requested_confidence_rank");
    expect(atomicity).not.toContain("max(CASE claim.confidence");
    expect(atomicity).not.toContain(
      "fact supersede confidenceLowering must be strictly lower than strongest support"
    );
    expect(atomicity).toContain("IF NEW.safe_request ? 'confidenceLowering' THEN");
    expect(atomicity).toMatch(
      /successor_confidence IS DISTINCT FROM\s+NEW\.safe_request #>> '\{confidenceLowering,confidence\}'[\s\S]*?successor_human_lowered IS DISTINCT FROM true[\s\S]*?successor_lowering_reason_code IS DISTINCT FROM\s+NEW\.safe_request #>> '\{confidenceLowering,reason,code\}'[\s\S]*?successor_lowering_rationale IS DISTINCT FROM\s+NEW\.safe_request #>> '\{confidenceLowering,reason,rationale\}'/
    );
    expect(atomicity).toContain(
      "MESSAGE = 'fact supersede successor confidence does not match confidenceLowering'"
    );
    expect(atomicity).toMatch(
      /successor_confidence IS DISTINCT FROM successor_strongest_confidence[\s\S]*?successor_human_lowered IS DISTINCT FROM false[\s\S]*?successor_lowering_reason_code IS NOT NULL[\s\S]*?successor_lowering_rationale IS NOT NULL/
    );
    expect(atomicity).toContain(
      "MESSAGE = 'fact supersede successor confidence requires confidenceLowering'"
    );
  });

  it("matches parseSortedClaimRefs and reconstructs the exact successor support request", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const validator = migrationFunctionBody(sql, "ops.b2_slice1_safe_request_valid");
    const atomicity = migrationFunctionBody(sql, "ops.require_b2_slice1_command_atomicity");

    expect(validator).toBeDefined();
    expect(validator).toContain(
      "jsonb_array_length(request_value -> 'replacementClaims') BETWEEN 1 AND 100"
    );
    expect(validator).toContain("jsonb_typeof(claim_ref -> 'claimId') <> 'string'");
    expect(validator).toContain("jsonb_typeof(claim_ref -> 'expectedVersion') <> 'number'");
    expect(validator).toContain(
      "'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'"
    );
    expect(validator).toMatch(
      /jsonb_array_elements\(request_value -> 'replacementClaims'\)[\s\S]*?WITH ORDINALITY AS replacement\(claim_ref, ordinal\)/
    );
    expect(validator).toContain("array_agg(claim_ref ->> 'claimId' ORDER BY ordinal) =");
    expect(validator).toContain(
      "array_agg(claim_ref ->> 'claimId' ORDER BY claim_ref ->> 'claimId')"
    );

    expect(atomicity).toBeDefined();
    expect(atomicity).toContain("canonical_replacement_claims jsonb;");
    expect(atomicity).toMatch(
      /jsonb_agg\([\s\S]*?'claimId', support\.claim_id,[\s\S]*?'expectedVersion', claim\.version - 1[\s\S]*?ORDER BY support\.claim_id[\s\S]*?INTO canonical_replacement_claims/
    );
    expect(atomicity).toMatch(
      /canonical_replacement_claims IS DISTINCT FROM\s+NEW\.safe_request -> 'replacementClaims'/
    );
    expect(atomicity).toContain(
      "MESSAGE = 'fact supersede support set does not match replacementClaims'"
    );
  });

  it("requires exact JSON scalar types across the phase-6 lifecycle envelope", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const safeRequest = migrationFunctionBody(sql, "ops.b2_slice1_safe_request_valid");
    const productResponse = migrationFunctionBody(sql, "ops.product_command_record_valid");
    const eventPayload = migrationFunctionBody(sql, "ops.b2_slice1_event_payload_valid");

    expect(safeRequest).toBeDefined();
    const revokeRequest = safeRequest!.slice(
      safeRequest!.indexOf("IF command_kind_value = 'fact.revoke.v1' THEN"),
      safeRequest!.indexOf(
        "    END IF;\n    RETURN COALESCE",
        safeRequest!.indexOf("IF command_kind_value = 'fact.revoke.v1' THEN")
      )
    );
    const supersedeRequest = safeRequest!.slice(
      safeRequest!.indexOf(
        "    RETURN COALESCE",
        safeRequest!.indexOf("IF command_kind_value = 'fact.revoke.v1' THEN")
      ),
      safeRequest!.indexOf(
        "  IF command_kind_value = 'initiative.primary_objective.withdraw.v1' THEN"
      )
    );
    for (const requestBranch of [revokeRequest, supersedeRequest]) {
      expect(requestBranch).toContain("jsonb_typeof(request_value -> 'factId') = 'string'");
      expect(requestBranch).toContain(
        "jsonb_typeof(request_value -> 'expectedFactVersion') = 'number'"
      );
      expect(requestBranch).toContain("jsonb_typeof(request_value #> '{reason,code}') = 'string'");
      expect(requestBranch).toContain(
        "jsonb_typeof(request_value #> '{reason,rationale}') = 'string'"
      );
    }
    expect(supersedeRequest).toContain(
      "jsonb_typeof(request_value #> '{subject,type}') = 'string'"
    );
    expect(supersedeRequest).toContain("jsonb_typeof(request_value #> '{subject,id}') = 'string'");
    expect(supersedeRequest).toContain(
      "jsonb_typeof(request_value #> '{subject,expectedVersion}') = 'number'"
    );

    expect(productResponse).toBeDefined();
    const revokeResponse = productResponse!.slice(
      productResponse!.indexOf("IF command_kind_value = 'fact.revoke.v1' THEN"),
      productResponse!.indexOf("ELSIF command_kind_value = 'fact.supersede.v1' THEN")
    );
    const supersedeResponse = productResponse!.slice(
      productResponse!.indexOf("ELSIF command_kind_value = 'fact.supersede.v1' THEN"),
      productResponse!.indexOf("ELSIF command_kind_value = 'claim.create.v1' THEN")
    );
    for (const responseBranch of [revokeResponse, supersedeResponse]) {
      expect(responseBranch).toContain("jsonb_typeof(response -> 'factId') = 'string'");
      expect(responseBranch).toContain("jsonb_typeof(response -> 'status') = 'string'");
      expect(responseBranch).toContain("jsonb_typeof(response -> 'version') = 'number'");
    }
    expect(supersedeResponse).toContain("jsonb_typeof(response -> 'replacementFactId') = 'string'");
    expect(supersedeResponse).toContain(
      "jsonb_typeof(response -> 'replacementFactVersion') = 'number'"
    );
    expect(supersedeResponse).toContain(
      "jsonb_typeof(response -> 'replacementFactStatus') = 'string'"
    );

    expect(eventPayload).toBeDefined();
    const supersededEvent = eventPayload!.slice(
      eventPayload!.indexOf("WHEN 'fact.superseded' THEN"),
      eventPayload!.indexOf("WHEN 'fact.revoked' THEN")
    );
    const revokedEvent = eventPayload!.slice(
      eventPayload!.indexOf("WHEN 'fact.revoked' THEN"),
      eventPayload!.indexOf("WHEN 'fact.accepted' THEN")
    );
    for (const eventBranch of [supersededEvent, revokedEvent]) {
      expect(eventBranch).toContain("jsonb_typeof(payload_value -> 'factId') = 'string'");
      expect(eventBranch).toContain("jsonb_typeof(payload_value -> 'factVersion') = 'number'");
      expect(eventBranch).toContain("jsonb_typeof(payload_value -> 'reasonCode') = 'string'");
      expect(eventBranch).toContain("jsonb_typeof(payload_value -> 'status') = 'string'");
    }
    expect(supersededEvent).toContain(
      "jsonb_typeof(payload_value -> 'replacementFactId') = 'string'"
    );
    expect(supersededEvent).toContain(
      "jsonb_typeof(payload_value -> 'replacementFactVersion') = 'number'"
    );
  });

  it("binds support insertion and supersede response identity to the exact successor", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const supportReservation = migrationFunctionBody(sql, "truth.require_fact_accept_reservation");
    const atomicity = migrationFunctionBody(sql, "ops.require_b2_slice1_command_atomicity");

    expect(supportReservation).toBeDefined();
    expect(supportReservation).toMatch(
      /fact\.id = NEW\.fact_id\s+AND fact\.status = 'current'\s+AND fact\.version = 1\s+AND command\.command_kind IN \('fact\.accept\.v1','fact\.supersede\.v1'\)/
    );
    expect(supportReservation).toContain(
      "RAISE EXCEPTION 'fact support requires its exact reserved command'"
    );

    expect(atomicity).toBeDefined();
    expect(atomicity).toMatch(
      /\(NEW\.safe_response ->> 'replacementFactId'\)::uuid IS DISTINCT FROM\s+successor_fact_id_value/
    );
    expect(atomicity).toContain("MESSAGE = 'fact supersede response does not match successor'");
    expect(atomicity!.indexOf("fact supersede response does not match successor")).toBeLessThan(
      atomicity!.indexOf("SELECT count(*) INTO audit_count")
    );
  });

  it("pins every function body created or replaced by 0012 with independent fixed digests", async () => {
    const sql = await readFile(factLifecycleUrl, "utf8");
    const createdFunctionNames = [...sql.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION ([^(]+)\(/gm)]
      .map((match) => match[1]!)
      .sort();
    const expectedFunctionNames = Object.keys(exact0012FunctionBodyDigests)
      .map((identity) => identity.slice(0, identity.indexOf("(")))
      .sort();

    expect(createdFunctionNames).toEqual(expectedFunctionNames);
    expect(
      Object.fromEntries(
        Object.entries(exact0012FunctionBodyDigests).map(([identity]) => {
          const body = migrationFunctionBody(sql, identity.slice(0, identity.indexOf("(")));
          expect(body, identity).toBeDefined();
          return [
            identity,
            createHash("sha256").update(body!.trim().replace(/\s+/g, " ")).digest("hex")
          ];
        })
      )
    ).toEqual(exact0012FunctionBodyDigests);
  });
});
