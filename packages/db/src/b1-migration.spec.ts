import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const urls = [
  new URL("../migrations/0004_b1_work_graph.sql", import.meta.url),
  new URL("../migrations/0005_b1_content_sources.sql", import.meta.url),
  new URL("../migrations/0006_b1_command_integrity.sql", import.meta.url)
] as const;
const runnerUrl = new URL("./migrations.ts", import.meta.url);
const catalogContractUrl = new URL("./b1-catalog-contract.ts", import.meta.url);

async function migrations() {
  return Promise.all(urls.map((url) => readFile(url, "utf8")));
}

describe("Wave B1 additive migration contract", () => {
  it("validates the global exact journal prefix and journal-derived B1 phase before migration selection", async () => {
    const [runner, contract] = await Promise.all([
      readFile(runnerUrl, "utf8"),
      readFile(catalogContractUrl, "utf8")
    ]);
    expect(runner.indexOf("validateMigrationJournal")).toBeLessThan(
      runner.indexOf("const files = allFiles.filter")
    );
    expect(contract).toContain("const migrationIds = [...checksums.keys()].sort()");
    expect(contract).toContain("const expectedJournalPrefix = migrationIds.slice");
    expect(contract).toContain(
      "Migration journal is not an exact contiguous prefix of the known migration catalog"
    );
    expect(contract).toContain("Migration journal order does not match the fixed migration order");
    expect(contract.indexOf("expectedJournalPrefix")).toBeLessThan(
      contract.indexOf("const b1Rows")
    );
    expect(runner).toMatch(
      /if \(recordedChecksum\)[\s\S]*?validateB1CatalogContract[\s\S]*?result\.skipped\.push/
    );
    expect(runner).toMatch(
      /BEGIN[\s\S]*?validateB1CatalogContract[\s\S]*?assertB1MigrationStateAbsent[\s\S]*?client\.query\(sql\)[\s\S]*?validateB1CatalogContract[\s\S]*?INSERT INTO throughline_migrations\.journal/
    );
    for (const closedSurface of [
      "Unexpected migration journal id",
      "Migration journal is not an exact contiguous prefix of the known migration catalog",
      "Migration journal order does not match the fixed migration order",
      "B1 migration journal is not an exact contiguous prefix",
      "B1 migration journal order does not match the fixed migration order",
      "pre-0004 B1 state absence",
      "closed work/content relation inventory",
      "direct, PUBLIC, column, and grant-option privileges",
      "function overload inventory",
      "Unexpected rewrite rule",
      "protected B1 role attributes"
    ]) {
      expect(contract).toContain(closedSurface);
    }
    expect(contract).toContain('"exact domain command constraint inventory"');
    expect(contract).toContain('"exact domain command user-trigger inventory"');
    expect(contract).toContain('"exact domain command rewrite-rule inventory"');
    expect(contract).not.toContain(
      "constraint_record.conname = 'domain_command_records_b1_shape_check'"
    );
    expect(contract).not.toContain("constraint_record.conname LIKE 'domain_command_records_b1_%'");
  });

  it("compares canonical table and column ACL tuples bidirectionally as SQL sets", async () => {
    const contract = await readFile(catalogContractUrl, "utf8");
    expect(contract).toContain("relation_record.relacl");
    expect(contract).toContain("attribute_record.attacl");
    expect(contract).toContain("acl_record.grantor");
    expect(contract).toContain("'table'::text AS scope");
    expect(contract).toContain("'column'::text AS scope");
    expect(contract).toMatch(
      /missing_acl AS \([\s\S]*?SELECT \* FROM expected_acl[\s\S]*?EXCEPT[\s\S]*?SELECT \* FROM actual_acl/
    );
    expect(contract).toMatch(
      /unexpected_acl AS \([\s\S]*?SELECT \* FROM actual_acl[\s\S]*?EXCEPT[\s\S]*?SELECT \* FROM expected_acl/
    );
    expect(contract).toMatch(/missing_diagnostic AS \([\s\S]*?LIMIT 1[\s\S]*?\)/);
    expect(contract).toMatch(/unexpected_diagnostic AS \([\s\S]*?LIMIT 1[\s\S]*?\)/);
    expect(contract).not.toContain("information_schema.column_privileges");
    expect(contract).not.toMatch(/JSON\.stringify\(actual\).*JSON\.stringify\(expected\)/);
  });

  it("compares schema and function grant options as typed booleans", async () => {
    const contract = await readFile(catalogContractUrl, "utf8");
    const schemaSecurity = contract.match(
      /async function validateSchemaSecurity[\s\S]*?\n}\n\nfunction functionSource/
    )?.[0];
    const functionSecurity = contract.match(
      /async function validateFunctions[\s\S]*?\n}\n\nasync function validateCommandIntegrityObjects/
    )?.[0];

    expect(schemaSecurity).toBeDefined();
    expect(schemaSecurity).toContain("acl_record.is_grantable AS grantable");
    expect(schemaSecurity).toContain('grantee: "throughline_app"');
    expect(schemaSecurity).toContain('grantee: "throughline_b1_0_integrity"');
    expect(schemaSecurity).toContain("...(integrityInstalled");
    expect(schemaSecurity).toContain("grantable: false");
    expect(schemaSecurity).toContain("pg_get_userbyid(namespace_record.nspowner) AS owner");
    expect(schemaSecurity).toContain("CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'");
    expect(schemaSecurity).toContain("acl_record.grantee <> namespace_record.nspowner");
    expect(schemaSecurity).not.toContain("format(");
    expect(schemaSecurity).not.toContain("USAGE:false");

    expect(functionSecurity).toBeDefined();
    expect(functionSecurity).toContain("acl_record.is_grantable AS grantable");
    expect(functionSecurity).toContain("grantable: false");
    expect(functionSecurity).toContain("CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'");
    expect(functionSecurity).not.toContain("format(");
  });

  it("treats null and empty column ACLs as no grants without masking real ACL arrays", async () => {
    const contract = await readFile(catalogContractUrl, "utf8");
    const safeColumnAclExpansions = contract.match(
      /aclexplode\(\s*CASE WHEN cardinality\(attribute_record\.attacl\) = 0 THEN NULL::aclitem\[\]\s*ELSE attribute_record\.attacl END\s*\)/g
    );
    expect(safeColumnAclExpansions).toHaveLength(2);
    expect(contract).not.toContain(
      "aclexplode(COALESCE(attribute_record.attacl, '{}'::aclitem[]))"
    );
  });

  it("closes every work/content pg_class kind and every command-table catalog inventory", async () => {
    const contract = await readFile(catalogContractUrl, "utf8");
    const schemaSecurity = contract.match(
      /async function validateSchemaSecurity[\s\S]*?\n}\n\nfunction functionSource/
    )?.[0];
    const commandSecurity = contract.match(
      /async function validateCommandIntegrityObjects[\s\S]*?\n}\n\nconst integrityPolicyContracts/
    )?.[0];
    expect(schemaSecurity).toBeDefined();
    const installedInventoryQuery = schemaSecurity?.match(
      /const installedObjects[\s\S]*?const scratchObjects/
    )?.[0];
    expect(installedInventoryQuery).toBeDefined();
    expect(installedInventoryQuery).toContain("relation_record.relkind::text AS kind");
    expect(installedInventoryQuery).not.toMatch(
      /WHERE[\s\S]*?relation_record\.relkind\s*(?:=|IN\b)/i
    );
    expect(commandSecurity).toBeDefined();
    expect(commandSecurity).toContain("WHERE constraint_record.conrelid = $1::regclass");
    expect(commandSecurity).not.toContain("constraint_record.conname =");
    expect(commandSecurity).not.toContain("startsWith");
    expect(commandSecurity).toContain("rewrite_record.rulename <> '_RETURN'");
    expect(commandSecurity).toContain('triggerCatalog(client, "ops.domain_command_records")');
  });

  it("compares the explicit predecessor table and column authority contract in both directions", async () => {
    const contract = await readFile(catalogContractUrl, "utf8");
    const predecessor = contract.match(
      /const predecessorAclRelations[\s\S]*?async function validateIntegrityPredecessorAccess[\s\S]*?\n}/
    )?.[0];
    expect(predecessor).toBeDefined();
    for (const relation of [
      "access.access_relationships",
      "access.spaces",
      "identity.policy_versions",
      "identity.service_principals",
      "identity.tenants",
      "identity.workspaces",
      "ops.audit_events",
      "ops.domain_command_records",
      "ops.product_outbox_events"
    ]) {
      expect(predecessor).toContain(relation);
    }
    expect(predecessor).toContain("acl_record.grantor");
    expect(predecessor).toContain("acl_record.is_grantable AS grantable");
    expect(predecessor).toContain("SELECT * FROM expected_acl");
    expect(predecessor).toContain("SELECT * FROM actual_acl");
    expect(predecessor).toContain("EXCEPT");
  });

  it("creates the exact normalized work graph with Engagement only as Activity subtype", async () => {
    const [work] = await migrations();
    expect([...work!.matchAll(/CREATE TABLE work\.([a-z_]+)/g)].map((match) => match[1])).toEqual([
      "organizations",
      "organization_domains",
      "initiatives",
      "initiative_organizations",
      "initiative_people",
      "activities",
      "activity_organizations",
      "activity_initiatives",
      "activity_attendees",
      "relationships"
    ]);
    expect(work).toContain("CHECK (subtype = profile_template_key)");
    expect(work).not.toMatch(/CREATE TABLE work\.engagement/i);
    expect(work).toContain("initiative_organizations_one_primary_unique");
    expect(work).toContain("CREATE TRIGGER initiative_organizations_end_only");
    expect(work).toContain("CREATE TRIGGER initiative_people_end_only");
    expect(work).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(work).toContain("derived_space := COALESCE(subject_space, object_space)");
    expect(work).toContain("relationship context must be Space-bearing");
  });

  it("creates immutable source snapshots, scalar chunks, correction chains, and governed tombstones", async () => {
    const [, content] = await migrations();
    expect(
      [...content!.matchAll(/CREATE TABLE (?:content|work)\.([a-z_]+)/g)].map((match) => match[1])
    ).toEqual([
      "content_items",
      "content_revisions",
      "source_artifacts",
      "source_chunks",
      "activity_sources"
    ]);
    for (const required of [
      "untrusted_user_content",
      "full_snapshot",
      "source-normalization.v1",
      "source-chunking.v1",
      "source correction predecessor is not a live terminal leaf",
      "source chunks do not reconstruct the normalized artifact",
      "erase_on_tombstone",
      "tombstoned source retains chunks"
    ])
      expect(content).toContain(required);
    expect(content).toContain("UNIQUE (tenant_id, workspace_id, supersedes_source_id)");
    expect(content).toContain("CREATE TRIGGER source_artifacts_no_delete");
    expect(content).toContain("CREATE TRIGGER source_chunks_no_update");
  });

  it("enables and forces RLS with exact app Space checks on every B1 table", async () => {
    const [work, content] = await migrations();
    expect(work).toContain("ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY");
    expect(work).toContain("ALTER TABLE work.%I FORCE ROW LEVEL SECURITY");
    expect(content).toContain("ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY");
    expect(content).toContain("ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY");
    for (const sql of [work!, content!]) {
      expect(sql).toContain("space_id = ops.current_space_id()");
      expect(sql).toContain("REVOKE ALL ON ALL TABLES");
      expect(sql).not.toMatch(
        /GRANT .* TO (?:throughline_relay|throughline_worker|throughline_product_relay)/
      );
    }
  });

  it("grants only the Activity id lock column behind two exact no-write UPDATE policies", async () => {
    const [work] = await migrations();
    expect(work).toContain("GRANT UPDATE (id) ON work.activities TO throughline_app;");
    expect(work).not.toMatch(/GRANT UPDATE ON work\.activities/);
    expect(work).toMatch(
      /CREATE POLICY activities_app_source_capture_lock ON work\.activities\s+AS PERMISSIVE FOR UPDATE TO throughline_app[\s\S]*?tenant_id = ops\.current_tenant_id\(\)[\s\S]*?workspace_id = ops\.current_workspace_id\(\)[\s\S]*?space_id = ops\.current_space_id\(\)[\s\S]*?status IN \('planned', 'in_progress', 'captured', 'review_pending', 'completed'\)[\s\S]*?governing_space\.archived_at IS NULL[\s\S]*?WITH CHECK \(false\);/
    );
    expect(work).toMatch(
      /CREATE POLICY activities_app_permanent_no_write ON work\.activities\s+AS RESTRICTIVE FOR UPDATE TO throughline_app\s+USING \(true\)\s+WITH CHECK \(false\);/
    );
    expect(
      [...work!.matchAll(/CREATE POLICY ([a-z_]+) ON work\.activities[\s\S]*?FOR UPDATE/g)].map(
        (match) => match[1]
      )
    ).toEqual(["activities_app_source_capture_lock", "activities_app_permanent_no_write"]);
  });

  it("adds only B1 result and atomicity integrity to the canonical B1.0 command tables", async () => {
    const [, , integrity] = await migrations();
    expect(integrity).not.toMatch(/CREATE TABLE/);
    expect(integrity).not.toMatch(/CREATE TABLE\s+ops\.domain_events/i);
    expect(integrity).toContain("to_regclass('ops.domain_events') IS NOT NULL");
    expect(integrity).toContain("domain_command_records_b1_shape_check");
    expect(integrity).toContain("domain_command_records_b1_atomicity_deferred");
    expect(integrity).toContain("exactly one matching audit and product notification");
    expect(integrity).toContain("throughline_b1_0_integrity");
    expect(integrity).toContain(
      "IF command_kind_value = 'b1_0.fixture.v1' THEN RETURN true; END IF;"
    );
    expect(integrity).toContain("THEN RETURN false; END IF;");
    expect(integrity).not.toMatch(/NOT IN \([\s\S]*?\) THEN RETURN true;/);
    expect(integrity).toContain("WHEN 'b1_0.fixture.v1' THEN RETURN NULL;");
    for (const kind of [
      "organization.create.v1",
      "initiative.create.v1",
      "activity.create.v1",
      "relationship.create.v1",
      "relationship.end.v1",
      "content.create.v1",
      "content.revise.v1",
      "source.capture.v1",
      "source.correct.v1",
      "source.tombstone.v1"
    ])
      expect(integrity).toContain(`'${kind}'`);
  });

  it("keeps the B1 command-kind surface closed and separates create from revise result shape", async () => {
    const [, , integrity] = await migrations();
    const recordValidator = integrity?.match(
      /CREATE FUNCTION ops\.b1_command_record_valid[\s\S]*?\n\$function\$;/
    )?.[0];
    expect(recordValidator).toBeDefined();
    expect(recordValidator).toContain("version_value := (response ->> 'version')::numeric;");
    expect(recordValidator).toContain("trunc(version_value) <> version_value");
    expect(recordValidator).toContain("trunc(counter_value) <> counter_value");
    expect(recordValidator).toContain("version_value > 2147483647");
    expect(recordValidator).toContain("counter_value > 2147483647");
    expect(recordValidator).not.toContain("::integer");
    expect(integrity).toMatch(
      /command_kind_value = 'content\.create\.v1'[\s\S]*?counter_value = 1 AND version_value = 1/
    );
    expect(recordValidator).toMatch(
      /command_kind_value IN \('content\.create\.v1','content\.revise\.v1'\)[\s\S]*?revisionNumber'[\s\S]*?counter_value < 1[\s\S]*?RETURN true;/
    );
    for (const rejected of ["source.capture.v2", "source.captuer.v1", "unknown.command.v1"]) {
      expect(integrity).not.toContain(`'${rejected}'`);
    }
  });

  it("contains no out-of-scope truth, agent, integration, model, or event-sourcing surface", async () => {
    const sql = (await migrations()).join("\n");
    expect(sql).not.toMatch(/\b(?:claims|accepted_facts|derived_views|change_sets|agent_runs)\b/i);
    expect(sql).not.toMatch(/mcp|embedding|vector|model_call|kanban/i);
    expect(sql).not.toMatch(/CREATE (?:SCHEMA|TABLE) (?:provider|integration)/i);
    expect(sql).not.toMatch(/CREATE (?:SCHEMA|TABLE) (?:truth|integration|agent)\b/i);
  });
});
