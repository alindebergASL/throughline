import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("canonical Wave A2 migration", () => {
  it("configures throughline_app without embedding a login credential", async () => {
    const sql = await readFile(
      new URL("../migrations/0001_wave_a2_identity_access_rls.sql", import.meta.url),
      "utf8"
    );

    expect(sql).toContain(
      "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL"
    );
    expect(sql).toContain("NOBYPASSRLS");
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'/i);
  });
});

describe("canonical Foundation closure migration", () => {
  it("configures dedicated relay and worker roles without login credentials", async () => {
    const sql = await readFile(
      new URL("../migrations/0002_foundation_closure_async_isolation.sql", import.meta.url),
      "utf8"
    );

    expect(sql).toContain("CREATE ROLE throughline_relay");
    expect(sql).toContain("CREATE ROLE throughline_worker");
    expect(sql).toMatch(/throughline_relay[\s\S]*?NOLOGIN[\s\S]*?NOBYPASSRLS/i);
    expect(sql).toMatch(/throughline_worker[\s\S]*?NOLOGIN[\s\S]*?NOBYPASSRLS/i);
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'/i);
  });

  it("makes every operational table subject to forced row security", async () => {
    const sql = await readFile(
      new URL("../migrations/0002_foundation_closure_async_isolation.sql", import.meta.url),
      "utf8"
    );

    for (const table of [
      "foundation_test_aggregates",
      "outbox_events",
      "security_context_references",
      "idempotency_records"
    ]) {
      expect(sql).toContain(`ALTER TABLE ops.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ops.${table} FORCE ROW LEVEL SECURITY`);
    }
  });

  it("contains only the four approved operational Foundation tables", async () => {
    const sql = await readFoundationMigration();
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS ops\.([a-z_]+)/g)].map(
      ([, table]) => table
    );

    expect(tables).toEqual([
      "security_context_references",
      "foundation_test_aggregates",
      "outbox_events",
      "idempotency_records"
    ]);
    expect(sql).not.toMatch(
      /\b(organization|initiative|activity|engagement|claim|accepted_fact)\b/i
    );
  });

  it("binds operational rows to exact tenant/workspace/Space and job references", async () => {
    const sql = await readFoundationMigration();

    expect(sql).toContain("UNIQUE (tenant_id, workspace_id, space_id, id)");
    expect(sql).toContain("UNIQUE (tenant_id, workspace_id, space_id, job_id)");
    expect(sql).toContain("UNIQUE (tenant_id, workspace_id, space_id, job_id, handler_key)");
    expect(sql).toContain(
      "FOREIGN KEY (context_reference_id, job_id, tenant_id, workspace_id, space_id)"
    );
    expect(sql).toContain("REFERENCES access.spaces(tenant_id, workspace_id, id)");
  });

  it("keeps relay and worker grants narrow and transaction-scope policies fail closed", async () => {
    const sql = await readFoundationMigration();

    expect(sql).toContain("current_user = 'throughline_relay'");
    expect(sql).toContain("current_user = 'throughline_worker'");
    expect(sql).toContain("relay_service_principal_id = ops.current_service_principal_id()");
    expect(sql).toContain("worker_service_principal_id = ops.current_worker_principal_id()");
    expect(sql).toContain("id = ops.current_context_reference_id()");
    expect(sql).toContain("job_id = ops.current_job_id()");
    expect(sql).toMatch(
      /GRANT UPDATE \([\s\S]*?publication_attempts[\s\S]*?terminal_failure_code[\s\S]*?\) ON ops\.outbox_events TO throughline_relay;/
    );
    expect(sql).not.toMatch(
      /GRANT (?:ALL|INSERT|DELETE).*ops\.outbox_events TO throughline_relay/i
    );
    expect(sql).not.toMatch(/GRANT .* ON ALL TABLES.*throughline_(?:relay|worker)/i);
  });
});

async function readFoundationMigration(): Promise<string> {
  return readFile(
    new URL("../migrations/0002_foundation_closure_async_isolation.sql", import.meta.url),
    "utf8"
  );
}
