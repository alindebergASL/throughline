import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const urls = [
  new URL("../migrations/0004_b1_work_graph.sql", import.meta.url),
  new URL("../migrations/0005_b1_content_sources.sql", import.meta.url),
  new URL("../migrations/0006_b1_command_integrity.sql", import.meta.url)
] as const;

async function migrations() {
  return Promise.all(urls.map((url) => readFile(url, "utf8")));
}

describe("Wave B1 additive migration contract", () => {
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
    expect(integrity).toContain("THEN RETURN true; END IF;");
    expect(integrity).toContain("ELSE RETURN NULL;");
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

  it("contains no out-of-scope truth, agent, integration, model, or event-sourcing surface", async () => {
    const sql = (await migrations()).join("\n");
    expect(sql).not.toMatch(/\b(?:claims|accepted_facts|derived_views|change_sets|agent_runs)\b/i);
    expect(sql).not.toMatch(/mcp|embedding|vector|model_call|kanban/i);
    expect(sql).not.toMatch(/CREATE (?:SCHEMA|TABLE) (?:provider|integration)/i);
    expect(sql).not.toMatch(/CREATE (?:SCHEMA|TABLE) (?:truth|integration|agent)\b/i);
  });
});
