import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/0003_b1_0_canonical_product_outbox.sql",
  import.meta.url
);

async function migration(): Promise<string> {
  return readFile(migrationUrl, "utf8");
}

describe("B1.0 canonical product outbox migration", () => {
  it("uses a transaction-local catalog-only search path with explicit application schemas", async () => {
    const sql = await migration();

    expect(sql.startsWith("SET LOCAL search_path TO pg_catalog;\n\nDO $role$")).toBe(true);
    expect(sql.match(/SET LOCAL search_path TO pg_catalog;/g)).toHaveLength(1);
    expect(sql.match(/FROM identity\.service_principals principal/g)).toHaveLength(2);
    expect(sql).toContain(
      "CREATE POLICY product_outbox_events_app_insert ON ops.product_outbox_events"
    );
    expect(sql).not.toMatch(/FROM\s+service_principals\s+principal/);
  });

  it("creates only the three bounded ops tables and no event ledger", async () => {
    const sql = await migration();
    expect(
      [...sql.matchAll(/CREATE TABLE IF NOT EXISTS ops\.([a-z_]+)/g)].map((match) => match[1])
    ).toEqual(["domain_command_records", "audit_events", "product_outbox_events"]);
    expect(sql).not.toContain("ops.domain_events");
    expect(sql).not.toMatch(/CREATE TABLE (?:work|content|truth|agent)\./);
  });

  it("installs immediate same-tenant/workspace command causation and the semantic key", async () => {
    const sql = await migration();
    expect(
      sql.match(/FOREIGN KEY \(tenant_id, workspace_id, causation_command_id\)/g)
    ).toHaveLength(4);
    expect(sql).toContain("REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)");
    expect(sql).not.toMatch(
      /FOREIGN KEY \(tenant_id, workspace_id, space_id, causation_command_id\)/
    );
    expect(sql).toContain("tenant_id, workspace_id, space_id, causation_command_id, event_type,");
    expect(sql).not.toMatch(/product_outbox_events_command_fk[\s\S]{0,240}DEFERRABLE/i);
  });

  it("keeps unions, versions, safe payloads, and publication terminals closed", async () => {
    const sql = await migration();
    for (const eventType of [
      "organization.created",
      "initiative.created",
      "activity.created",
      "activity.capture_added",
      "relationship.created",
      "relationship.ended",
      "content.created",
      "content.revised",
      "source_artifact.captured",
      "source_artifact.corrected",
      "source_artifact.tombstoned"
    ]) {
      expect(sql).toContain(`'${eventType}'`);
    }
    expect(sql).toContain("event_schema_version = 1 AND payload_schema_version = 1");
    expect(sql).toContain("'terminal_failed', 'terminal_unconfirmed'");
    expect(sql).toContain("publication_attempt BETWEEN 0 AND 6");
    expect(sql).toContain("ops.product_event_payload_valid");
    for (const forbiddenSafeKey of ["raw.?source", "object.?key", "credential"]) {
      expect(sql).toContain(forbiddenSafeKey);
    }
  });

  it("installs all constraints, triggers, RLS, policies, and assertions before final grants", async () => {
    const sql = await migration();
    for (const table of ["domain_command_records", "audit_events", "product_outbox_events"]) {
      expect(sql).toContain(`ALTER TABLE ops.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ops.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("domain_command_records_no_committed_reserved");
    expect(sql).toContain("audit_events_append_only_guard");
    expect(sql).toContain("product_outbox_events_transition_guard");
    const assertions = sql.indexOf("DO $assertions$");
    const appGrant = sql.indexOf("GRANT SELECT, INSERT ON ops.domain_command_records");
    const relayGrant = sql.indexOf("GRANT SELECT (\n  id, tenant_id", assertions);
    expect(assertions).toBeGreaterThan(0);
    expect(appGrant).toBeGreaterThan(assertions);
    expect(relayGrant).toBeGreaterThan(assertions);
  });

  it("adopts only matching installed B1.0 objects and makes every create collision-safe", async () => {
    const sql = await migration();
    expect(sql).toContain("DO $adopt_functions$");
    expect(sql).toContain("DO $adopt_indexes$");
    expect(sql).toContain("DO $adopt_tables$");
    expect(sql).toContain("DO $assert_table_adoption$");
    expect(sql).toContain("DO $adopt_triggers$");
    expect(sql).toContain("DO $adopt_policies$");
    expect(sql.match(/CREATE TABLE IF NOT EXISTS ops\./g)).toHaveLength(3);
    expect(sql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g)).toHaveLength(6);
    expect(sql.match(/DROP TRIGGER IF EXISTS/g)).toHaveLength(5);
    expect(sql.match(/DROP POLICY IF EXISTS/g)).toHaveLength(27);
    expect(sql).toContain("does not match the B1.0 definition");
    expect(sql).toContain("columns do not match the B1.0 definition");
    expect(sql).toContain("constraints do not match the B1.0 definition");
  });

  it("uses and removes a transactional regular schema for exact FK contract comparison", async () => {
    const sql = await migration();
    const contractSchema = "throughline_b1_0_migration_contract";
    const prepare = sql.indexOf("DO $prepare_contract_schema$");
    const createSchema = sql.indexOf(`CREATE SCHEMA ${contractSchema}`);
    const contractTables = [
      ...sql.matchAll(new RegExp(`CREATE TABLE ${contractSchema}\\.([a-z0-9_]+)`, "g"))
    ].map((match) => match[1]);
    const comparison = sql.indexOf("DO $assert_table_adoption$");
    const dropSchema = sql.indexOf(`DROP SCHEMA ${contractSchema} CASCADE`);
    const firstContractTable = sql.indexOf(
      `CREATE TABLE ${contractSchema}.b1_0_expected_domain_command_records`
    );
    const contractDefinition = sql.slice(firstContractTable, comparison);
    const cleanupAssertion = sql.indexOf("DO $assert_contract_cleanup$");
    const firstOperationalIndex = sql.indexOf(
      "CREATE INDEX IF NOT EXISTS domain_command_records_scope_created_idx"
    );
    const firstFinalGrant = sql.indexOf("GRANT USAGE ON SCHEMA identity, access, ops");

    expect(contractTables).toEqual([
      "b1_0_expected_service_principal_purpose",
      "b1_0_expected_domain_command_records",
      "b1_0_expected_audit_events",
      "b1_0_expected_product_outbox_events"
    ]);
    expect(sql).not.toContain("CREATE TEMP TABLE");
    expect(sql).not.toContain("ON COMMIT DROP");
    expect(contractDefinition.match(/ADD CONSTRAINT [a-z0-9_]+_fk/g)).toHaveLength(18);
    expect(contractDefinition.match(/REFERENCES ops\.domain_command_records/g)).toHaveLength(2);
    expect(sql).toContain(
      "B1.0 migration contract schema already exists; refusing unsafe adoption"
    );
    expect(prepare).toBeGreaterThan(0);
    expect(createSchema).toBeGreaterThan(prepare);
    expect(comparison).toBeGreaterThan(createSchema);
    expect(dropSchema).toBeGreaterThan(comparison);
    expect(cleanupAssertion).toBeGreaterThan(dropSchema);
    expect(firstOperationalIndex).toBeGreaterThan(cleanupAssertion);
    expect(firstFinalGrant).toBeGreaterThan(cleanupAssertion);
  });

  it("reports a bounded catalog-only first constraint difference while failing closed", async () => {
    const sql = await migration();
    const comparison = sql.slice(
      sql.indexOf("DO $assert_table_adoption$"),
      sql.indexOf("$assert_table_adoption$;", sql.indexOf("DO $assert_table_adoption$"))
    );
    const diagnostic = comparison.slice(comparison.indexOf("RAISE EXCEPTION USING MESSAGE"));

    expect(comparison).toContain("actual_md5=%s; expected_md5=%s");
    expect(comparison).toContain("first_missing=%s; first_unexpected=%s");
    expect(comparison).toContain("first_invalid_index_constraint=%s");
    expect(comparison).toContain("left(COALESCE(first_missing_constraint, '<none>'), 1200)");
    expect(comparison).toContain("left(COALESCE(first_unexpected_constraint, '<none>'), 1200)");
    expect(comparison).toContain("left(COALESCE(first_invalid_constraint_index, '<none>'), 1200)");
    expect(comparison.match(/pg_get_constraintdef\(constraint_record\.oid\)/g)).toHaveLength(3);
    expect(diagnostic).not.toMatch(/current_setting|request_id|traceparent|canonical_request_hash/);
    expect(comparison).toContain(
      "RAISE EXCEPTION USING MESSAGE = format(\n        'Existing table ops.%s constraints do not match the B1.0 definition"
    );
  });

  it("excludes only constraint triggers from table adoption and validates them separately", async () => {
    const sql = await migration();
    const tableAdoption = sql.slice(
      sql.indexOf("DO $assert_table_adoption$"),
      sql.indexOf("$assert_table_adoption$;", sql.indexOf("DO $assert_table_adoption$"))
    );
    const triggerAdoption = sql.slice(
      sql.indexOf("DO $adopt_triggers$"),
      sql.indexOf("$adopt_triggers$;", sql.indexOf("DO $adopt_triggers$"))
    );

    expect(tableAdoption.match(/AND constraint_record\.contype <> 't'/g)).toHaveLength(2);
    expect(tableAdoption).not.toMatch(/constraint_record\.contype (?:IN|NOT IN)/);
    expect(triggerAdoption).toContain(
      "'domain_command_records', 'domain_command_records_no_committed_reserved',\n        'reject_committed_reserved_command', 21, true, true, true"
    );
    expect(triggerAdoption).toContain("(trigger_record.tgconstraint <> 0) AS is_constraint");
    expect(triggerAdoption).toContain("trigger_record.tgdeferrable AS is_deferrable");
    expect(triggerAdoption).toContain("trigger_record.tginitdeferred AS is_initially_deferred");
    expect(triggerAdoption).toContain(
      "RAISE EXCEPTION 'Existing trigger % on ops.% does not match the B1.0 definition'"
    );
  });

  it("casts catalog name arrays to the text-array manifest type", async () => {
    const sql = await migration();
    expect(sql).toMatch(
      /ARRAY\(\s*SELECT attribute_record\.attname::text[\s\S]*?\) AS key_columns/
    );
    expect(sql).not.toMatch(/ARRAY\(\s*SELECT attribute_record\.attname\s+FROM/);
    expect(sql).toContain(
      "(CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END)::text"
    );
  });

  it("keeps function adoption fingerprints bound to the exact installed bodies", async () => {
    const sql = await migration();
    expect(sql).toContain("volatility_code, is_strict, source_md5");
    expect(sql).toContain("procedure_record.proisstrict AS is_strict");
    expect(sql).toContain("installed_function.is_strict");
    expect(sql).toContain("expected_function.is_strict");
    expect(sql).not.toMatch(/(?:\.strict\b|\bAS strict\b)/);
    const bodies = [
      ...sql.matchAll(
        /CREATE OR REPLACE FUNCTION ops\.[a-z_]+[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/g
      )
    ].map((match) => match[1] ?? "");
    expect(bodies).toHaveLength(8);
    for (const body of bodies) {
      expect(sql).toContain(createHash("md5").update(body).digest("hex"));
    }
  });

  it("gives the app only completion columns and the product relay only id locks/publication columns", async () => {
    const sql = await migration();
    expect(sql).toMatch(
      /GRANT UPDATE \(\s*state, result_resource_type, result_resource_id, safe_response, completed_at, updated_at\s*\) ON ops\.domain_command_records TO throughline_app;/
    );
    expect(sql).not.toMatch(
      /GRANT (?:ALL|DELETE).*ops\.(?:domain_command_records|audit_events|product_outbox_events)/i
    );
    for (const table of [
      "identity.tenants",
      "identity.workspaces",
      "identity.policy_versions",
      "identity.service_principals",
      "access.spaces",
      "access.access_relationships"
    ]) {
      expect(sql).toContain(`GRANT UPDATE (id) ON ${table} TO throughline_product_relay`);
    }
    expect(sql).not.toMatch(
      /GRANT UPDATE \([^)]*(?:status|purpose|relation|source|archived_at)[^)]*\) ON (?:identity|access)\./i
    );
    expect(sql).not.toMatch(
      /GRANT (?:INSERT|DELETE).*ops\.product_outbox_events TO throughline_product_relay/i
    );
    expect(sql).not.toMatch(
      /GRANT UPDATE(?:\s*\([^)]*\))? ON ops\.product_outbox_events TO throughline_app/i
    );
    expect(sql).not.toContain("product_outbox_events_app_update");
  });

  it("adds role-specific lock guards without changing Foundation role policies or grants", async () => {
    const sql = await migration();
    expect(sql).toContain("NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
    expect(sql).toContain("NOBYPASSRLS");
    for (const stem of [
      "tenants",
      "workspaces",
      "policy_versions",
      "service_principals",
      "spaces",
      "access_relationships"
    ]) {
      expect(sql).toContain(`${stem}_product_relay_lock_only`);
      expect(sql).toContain(`${stem}_product_relay_no_write`);
    }
    expect(sql).not.toMatch(/TO throughline_(?:relay|worker)/);
    expect(sql).not.toContain("ops.outbox_events");
  });

  it("preserves the exact bytes of Foundation migrations 0001 and 0002", async () => {
    const [migration1, migration2] = await Promise.all([
      readFile(new URL("../migrations/0001_wave_a2_identity_access_rls.sql", import.meta.url)),
      readFile(
        new URL("../migrations/0002_foundation_closure_async_isolation.sql", import.meta.url)
      )
    ]);
    expect(createHash("sha256").update(migration1).digest("hex")).toBe(
      "22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7"
    );
    expect(createHash("sha256").update(migration2).digest("hex")).toBe(
      "4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2"
    );
  });
});
