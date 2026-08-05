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
});
