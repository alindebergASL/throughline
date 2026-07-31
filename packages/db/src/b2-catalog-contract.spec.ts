import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { PgPoolClient } from "./client.js";
import {
  assertB2MigrationStateAbsent,
  assertProductValidatorDelegatesExactB1Kinds,
  validateB2CatalogContract
} from "./b2-catalog-contract.js";

const fixedPredecessors = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql",
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql"
] as const;

describe("B2 Slice 1 catalog contract unit boundary", () => {
  it("treats an exact B1 journal as pre-B2 without querying a future catalog", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PgPoolClient;
    const journal = new Map(fixedPredecessors.map((id) => [id, "checksum"]));

    await expect(validateB2CatalogContract(client, journal, new Map())).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on a missing predecessor before querying the installed catalog", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PgPoolClient;
    const journal = new Map(fixedPredecessors.slice(1).map((id) => [id, "checksum"]));

    await expect(validateB2CatalogContract(client, journal, new Map())).rejects.toThrow(
      "B2 migration journal is missing a fixed predecessor"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on a gapped B2 journal before querying the installed catalog", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PgPoolClient;
    const journal = new Map([
      ...fixedPredecessors.map((id) => [id, "checksum"] as const),
      ["0008_b2_slice1_command_integrity.sql", "checksum"] as const
    ]);

    await expect(validateB2CatalogContract(client, journal, new Map())).rejects.toThrow(
      "B2 migration journal is not an exact contiguous prefix"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("uses non-throwing probes for unjournaled B2 state", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ installed: null }], rowCount: 1 });
    const client = { query } as unknown as PgPoolClient;

    await assertB2MigrationStateAbsent(client, "0007_b2_slice1_truth_storage.sql");
    await assertB2MigrationStateAbsent(client, "0008_b2_slice1_command_integrity.sql");
    await assertB2MigrationStateAbsent(client, "0009_b2_source_truth_lifecycle_interlock.sql");

    expect(query.mock.calls[0]?.[0]).toContain("to_regnamespace('truth')");
    expect(query.mock.calls[1]?.[0]).toContain("ops.product_command_record_valid");
    expect(query.mock.calls[2]?.[0]).toContain("ops.enforce_b2_source_truth_lifecycle_interlock");
  });

  it("pins only the four Slice 1 tables and two executable commands", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    for (const table of ["accepted_facts", "claims", "fact_claims", "verified_evidence_spans"]) {
      expect(contract).toContain(`"${table}"`);
    }
    expect(contract).toContain('"claim.create.v1", "fact.accept.v1"');
    expect(contract).toContain("domain_command_records_b2_slice1_atomicity_deferred");
    expect(contract).not.toContain("command_effects_immutable");
    expect(contract).not.toContain("require_product_command_atomicity");
  });

  it("pins the staged B2 capability boundary and rejects full lifecycle objects", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    expect(contract).toContain("phase >= 2");
    expect(contract).toContain("throughline_b1_0_integrity");
    expect(contract).toContain("B2 Slice 1 truth column inventory drifted");
    expect(contract).toContain("B2 Slice 1 truth function inventory drifted");
    expect(contract).toContain("source_truth_triggers");
    expect(contract).toContain("truth.reconcile_source_retention()");
    expect(contract).toContain("reconciliation_function !== null");
    expect(contract).toContain("B2 Slice 1 truth table authority drifted");
    expect(contract).toContain("ops.enforce_b2_source_truth_lifecycle_interlock()");
    expect(contract).toContain("ERRCODE = 'TLB21'");
    expect(contract).toContain("B2 source/truth lifecycle interlock trigger inventory drifted");
  });

  it("inspects the exact installed current-Fact unique-slot index instead of its name alone", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    for (const catalogField of [
      "index_state.indisunique",
      "index_state.indisready",
      "index_state.indisvalid",
      "index_state.indnkeyatts",
      "index_state.indnatts",
      "index_state.indpred",
      "index_relation.relam"
    ]) {
      expect(contract).toContain(catalogField);
    }
    expect(contract).toContain('access_method: "btree"');
    expect(contract).toContain("predicate: \"(status = 'current'::text)\"");
    expect(contract).toContain("JSON.stringify(currentSlotIndex)");
    expect(contract).not.toContain("normalizePartialIndexPredicate");
    expect(contract).toContain(
      'throw new Error("B2 Slice 1 current-Fact unique-slot index definition drifted")'
    );
    expect(contract).not.toContain(
      "to_regclass('truth.accepted_facts_one_current_slot')::text AS current_slot"
    );
  });

  it("casts PostgreSQL name columns to text before aggregating the exact inventory", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    expect(contract).toContain(
      "array_agg(attribute.attname::text ORDER BY attribute.attnum) AS columns"
    );
    expect(contract).not.toMatch(
      /array_agg\(attribute\.attname ORDER BY attribute\.attnum\) AS columns/
    );
  });

  it("inspects PUBLIC through expanded PostgreSQL ACLs instead of role-name helpers", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    expect(contract).not.toContain("information_schema.role_table_grants");
    expect(contract).not.toContain("information_schema.usage_privileges");
    expect(contract).not.toMatch(/has_function_privilege\(\s*'PUBLIC'/);
    expect(contract).toContain("relation.relacl, acldefault('r', relation.relowner)");
    expect(contract).toContain("attribute.attacl, acldefault('c', relation.relowner)");
    expect(contract).toContain("namespace.nspacl, acldefault('n', namespace.nspowner)");
    expect(contract).toContain("procedure.proacl, acldefault('f', procedure.proowner)");
    expect(contract).toContain("acl_record.grantee = 0");
  });

  it("closes the B2 command function catalog and direct EXECUTE ACLs exactly", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    for (const identity of [
      "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)",
      "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)",
      "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)",
      "ops.require_b2_slice1_command_atomicity()"
    ]) {
      expect(contract).toContain(identity);
    }
    expect(contract).toContain("procedure.proowner = current_user::regrole");
    expect(contract).toContain("procedure.prosrc AS source");
    expect(contract).toContain("phase >= 3 ? lifecycleSource! : integritySource");
    expect(contract).toContain('"ops.require_b2_slice1_command_atomicity"');
    expect(contract).toContain("procedure.proacl, acldefault('f', procedure.proowner)");
    expect(contract).toContain("acl_record.grantee <> procedure.proowner");
    expect(contract).toContain('grantee: "throughline_product_relay"');
    expect(contract).toContain("B2 Slice 1 command function EXECUTE grants drifted");
  });

  it("closes the truth function inventory, source, security mode, search path, and ACLs", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    for (const identity of [
      "truth.enforce_claim_transition()",
      "truth.reject_mutation()",
      "truth.require_fact_accept_reservation()",
      "truth.require_reserved_command()",
      "truth.validate_claim_insert()",
      "truth.validate_fact_insert()",
      "truth.validate_fact_support()",
      "truth.verify_evidence_snapshot()",
      "access.can_read_space(uuid,text)"
    ]) {
      expect(contract).toContain(identity);
    }
    expect(contract).toContain("procedure.prosrc AS source");
    expect(contract).toContain("security_definer: false");
    expect(contract).toContain('configuration: ["search_path=pg_catalog"]');
    expect(contract).toContain("B2 Slice 1 truth function EXECUTE grants drifted");
    expect(contract).toContain("content.access_class_rank");
  });

  it("requires exact delegation to the immutable B1 catalog", async () => {
    const sql = await readFile(
      new URL("../migrations/0008_b2_slice1_command_integrity.sql", import.meta.url),
      "utf8"
    );
    expect(() => assertProductValidatorDelegatesExactB1Kinds(sql)).not.toThrow();
    expect(() =>
      assertProductValidatorDelegatesExactB1Kinds(
        sql.replace("'source.tombstone.v1'", "'future.command.v1'")
      )
    ).toThrow("exact sealed B1 command catalog");
  });
});
