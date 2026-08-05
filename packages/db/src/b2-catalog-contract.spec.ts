import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { PgPoolClient } from "./client.js";
import {
  assertB2InitiativeLockMigrationSource,
  assertB2MigrationStateAbsent,
  assertProductValidatorDelegatesExactB1Kinds,
  validateB2CatalogContract
} from "./b2-catalog-contract.js";
import { exactTruthCatalogForPhase } from "./b2-exact-catalog.js";

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
    await assertB2MigrationStateAbsent(client, "0010_b2_trusted_objective_initiative_lock.sql");
    await assertB2MigrationStateAbsent(client, "0011_b2_primary_objective_proposal_recovery.sql");

    expect(query.mock.calls[0]?.[0]).toContain("to_regnamespace('truth')");
    expect(query.mock.calls[1]?.[0]).toContain("ops.product_command_record_valid");
    expect(query.mock.calls[2]?.[0]).toContain("ops.enforce_b2_source_truth_lifecycle_interlock");
    expect(query.mock.calls[3]?.[0]).toContain("has_column_privilege");
    expect(query.mock.calls[3]?.[0]).toContain("work.initiatives");
    expect(query.mock.calls[3]?.[0]).toContain("'id','UPDATE'");
    expect(query.mock.calls[3]?.[0]).toContain("FROM pg_policy");
    expect(query.mock.calls[3]?.[0]).toContain("to_regclass('work.initiatives')");
    expect(query.mock.calls[3]?.[1]).toEqual([
      ["initiatives_app_truth_lock", "initiatives_app_permanent_no_write"]
    ]);
    expect(query.mock.calls[4]?.[0]).toContain("truth.initiative_objective_support_attestations");
  });

  it("rejects an unjournaled Initiative lock capability", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ installed: true }], rowCount: 1 });
    const client = { query } as unknown as PgPoolClient;

    await expect(
      assertB2MigrationStateAbsent(client, "0010_b2_trusted_objective_initiative_lock.sql")
    ).rejects.toThrow(
      "B2 migration state already exists without journal row for 0010_b2_trusted_objective_initiative_lock.sql"
    );
  });

  it("accepts only the exact phase-4 Initiative lock migration source", async () => {
    const source = await readFile(
      new URL("../migrations/0010_b2_trusted_objective_initiative_lock.sql", import.meta.url),
      "utf8"
    );

    expect(() => assertB2InitiativeLockMigrationSource(source)).not.toThrow();
    for (const mutation of [
      `${source}GRANT SELECT ON work.initiatives TO throughline_worker;\n`,
      source.replace("UPDATE (id)", "UPDATE (id, title)"),
      source.replace("UPDATE (id)", "UPDATE"),
      source.replaceAll("throughline_app", "PUBLIC"),
      source.replace(
        "GRANT UPDATE (id) ON work.initiatives TO throughline_app;",
        "GRANT UPDATE (id) ON work.initiatives TO throughline_app WITH GRANT OPTION;"
      ),
      source.replace("tenant_id = ops.current_tenant_id() AND ", ""),
      source.replace("workspace_id = ops.current_workspace_id()\n", "true\n"),
      source.replace("AND space_id = ops.current_space_id()\n", ""),
      source.replace("AND governing_space.archived_at IS NULL\n", ""),
      source.replace("WITH CHECK (false);", "WITH CHECK (true);"),
      source.replace(
        /CREATE POLICY initiatives_app_permanent_no_write[\s\S]*?WITH CHECK \(false\);\n\n/,
        ""
      ),
      source.replace("AS RESTRICTIVE FOR UPDATE", "AS PERMISSIVE FOR UPDATE"),
      source.replace("FOR UPDATE TO throughline_app", "FOR ALL TO throughline_app"),
      `${source}CREATE TABLE truth.future_store (id uuid);\n`,
      `${source}-- fact_lifecycle future work\n`
    ]) {
      expect(() => assertB2InitiativeLockMigrationSource(mutation)).toThrow(
        "B2 Initiative lock migration source drifted"
      );
    }
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

  it("adds only the objective recovery catalog without generalized Claim or Fact lifecycle", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const migration = await readFile(
      new URL("../migrations/0011_b2_primary_objective_proposal_recovery.sql", import.meta.url),
      "utf8"
    );

    for (const bounded of [
      "initiative_objective_support_attestations",
      "initiative_objective_proposal_recoveries",
      "initiative.primary_objective.withdraw.v1",
      "initiative.primary_objective.rework.v1",
      "claims_one_active_primary_objective_proposal"
    ]) {
      expect(contract).toContain(bounded);
      expect(migration).toContain(bounded);
    }
    expect(migration).not.toMatch(
      /fact\.(?:contest|uphold|supersede|revoke)|derived_view\.regenerate|CREATE TABLE truth\.(?:conflict|fact_lifecycle|claim_lifecycle)/
    );
  });

  it("compares every phase-5 constraint and index by exact normalized catalog definition", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const objectiveCatalog = contract.slice(
      contract.indexOf("async function validateObjectiveRecoveryCatalog"),
      contract.indexOf("async function validateTruthTables")
    );
    expect(objectiveCatalog).toContain("pg_get_constraintdef(constraint_record.oid, false)");
    expect(objectiveCatalog).toContain("pg_get_indexdef(index_record.indexrelid, 0, false)");
    expect(objectiveCatalog).toContain("exactObjectiveRecoveryConstraints(");
    expect(objectiveCatalog).toContain("exactObjectiveRecoveryIndexes()");
    expect(objectiveCatalog).toContain("FOREIGN KEY (tenant_id, workspace_id, space_id");
    expect(objectiveCatalog).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(objectiveCatalog).toContain("PRIMARY KEY (id)");
    expect(objectiveCatalog).toContain("UNIQUE (tenant_id, workspace_id, causation_command_id)");
    expect(objectiveCatalog).toContain("CHECK ((version = 1))");
    expect(objectiveCatalog).not.toMatch(/active_index_(?:definition|predicate).*\.includes/);
  });

  it("closes every non-index truth relation and ACL without expected-name filtering", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const relationInventory = contract.slice(
      contract.indexOf("async function validateTruthTables"),
      contract.indexOf("async function validateTruthColumnsAndConstraints")
    );
    const aclInventory = contract.slice(
      contract.indexOf("async function validateTruthSecurity"),
      contract.indexOf("async function validateTruthFunctions")
    );

    for (const inventory of [relationInventory, aclInventory]) {
      expect(inventory).toContain("relation.relkind NOT IN ('i','I')");
      expect(inventory).not.toContain("relation.relname = ANY");
    }
    expect(relationInventory).toContain(
      "CASE WHEN relation.relowner = current_user::regrole THEN 'migration_owner'"
    );
    expect(relationInventory).toContain("ELSE pg_get_userbyid(relation.relowner) END AS owner");
  });

  it("encodes the canonical phase catalog as compact exact deltas", () => {
    expect(
      [1, 2, 3, 4, 5].map((phase) => {
        const catalog = exactTruthCatalogForPhase(phase);
        return [
          catalog.relations.length,
          catalog.policies.length,
          catalog.constraints.length,
          catalog.indexes.length
        ];
      })
    ).toEqual([
      [4, 9, 70, 13],
      [4, 13, 70, 13],
      [4, 13, 68, 13],
      [4, 13, 68, 13],
      [6, 19, 100, 23]
    ]);
    expect(exactTruthCatalogForPhase(5).relations.map(({ owner }) => owner)).toEqual(
      Array(6).fill("migration_owner")
    );
  });

  it("uses exact policy, constraint, index, and safe-request function rows", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    expect(contract).toContain("pg_get_expr(policy.polqual, policy.polrelid) AS using_expression");
    expect(contract).toContain("JSON.stringify(result.rows) !== JSON.stringify(expectedPolicies)");
    for (const field of [
      "constraint_record.conname AS name",
      "constraint_record.contype::text AS type",
      "constraint_record.condeferrable AS deferrable",
      "constraint_record.condeferred AS initially_deferred",
      "constraint_record.convalidated AS validated",
      "index_record.indisunique AS unique",
      "index_record.indisprimary AS primary",
      "index_record.indisvalid AS valid",
      "index_record.indisready AS ready",
      "index_record.indislive AS live",
      "pg_get_indexdef(index_record.indexrelid, 0, false) AS definition"
    ]) {
      expect(contract).toContain(field);
    }
    expect(contract).toContain("safeRequestIdentity");
    expect(contract).toContain(
      'migrationFunctionSource(recoverySource!, "ops.b2_slice1_safe_request_valid")'
    );
  });

  it("pins complete canonical truth trigger definitions including timing, events, and arguments", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const triggerContract = contract.slice(
      contract.indexOf("async function validateTruthConstraintsAndTriggers"),
      contract.indexOf("const currentSlotIndexes")
    );

    expect(triggerContract).toContain("pg_get_triggerdef(trigger_record.oid, true) AS definition");
    expect(triggerContract).toContain('timing_and_events: "AFTER INSERT OR UPDATE"');
    expect(triggerContract).toContain('timing_and_events: "BEFORE DELETE OR UPDATE"');
    expect(triggerContract).toContain('arguments: ["fact.accept.v1"]');
    expect(triggerContract).toContain('arguments: ["claim.create-or-rework.v1"]');
    expect(triggerContract).toContain('CREATE ${contract.deferred ? "CONSTRAINT " : ""}TRIGGER');
    expect(triggerContract).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(triggerContract).toContain("FOR EACH ROW EXECUTE FUNCTION");
  });

  it("keeps migration-adopted request provenance distinct from native confirmation", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const migration = await readFile(
      new URL("../migrations/0011_b2_primary_objective_proposal_recovery.sql", import.meta.url),
      "utf8"
    );

    expect(migration).toContain("safe_request_adopted boolean NOT NULL DEFAULT false");
    expect(migration).toContain("'supportConfirmed', false");
    expect(migration).toContain("jsonb_set(safe_request, '{supportConfirmed}', 'true'::jsonb");
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE) \(safe_request_adopted\)/);
    expect(contract).toContain("app_can_insert_safe_request_adopted");
    expect(contract).toContain("app_can_update_safe_request_adopted");
    expect(contract).toContain('safe_request_adopted_default !== "false"');
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
