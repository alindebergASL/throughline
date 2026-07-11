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
  it("adds only lock visibility for the current app user and rejects every updated row", async () => {
    const sql = await readFoundationMigration();

    expect(sql).toMatch(
      /CREATE POLICY users_current_user_lock_only ON identity\.users\s+FOR UPDATE TO throughline_app\s+USING \(id = ops\.current_user_id\(\)\)\s+WITH CHECK \(false\);/
    );
  });

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

  it("gives the worker only UPDATE(id) lock capability on every authority and reference row", async () => {
    const sql = await readFoundationMigration();

    const authorityTables = [
      "identity.tenants",
      "identity.workspaces",
      "identity.users",
      "identity.memberships",
      "identity.policy_versions",
      "identity.service_principals",
      "access.spaces",
      "access.access_relationships",
      "ops.security_context_references"
    ];
    for (const table of authorityTables) {
      expect(sql).toMatch(
        new RegExp(
          `GRANT\\s+UPDATE\\s*\\(id\\)\\s+ON\\s+${table.replace(".", "\\.")}\\s+TO\\s+throughline_worker`,
          "i"
        )
      );
      const escaped = table.replace(".", "\\.");
      const columnGrants = [
        ...sql.matchAll(
          new RegExp(
            `GRANT\\s+UPDATE\\s*\\(([^)]+)\\)\\s+ON\\s+${escaped}\\s+TO\\s+throughline_worker`,
            "gi"
          )
        )
      ].flatMap((match) =>
        match[1]!
          .split(",")
          .map((column) => column.trim().replaceAll('"', ""))
          .filter(Boolean)
      );
      expect(columnGrants, table).toEqual(["id"]);
    }

    expect(sql).not.toMatch(
      /GRANT\s+UPDATE\s+ON\s+(?:identity|access|ops)\.[a-z_]+\s+TO\s+throughline_worker/i
    );
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|DELETE)\b[\s\S]*?TO\s+throughline_worker/i);
    expect(sql).not.toMatch(
      /GRANT\s+UPDATE\s*\([^)]*\b(?:status|role|purpose|archived_at|relation|source|signing_key_id|context_snapshot)\b[^)]*\)\s+ON\s+(?:identity|access|ops)\.[a-z_]+\s+TO\s+throughline_worker/i
    );
  });

  it("uses full-scope worker lock-only UPDATE policies with impossible writes", async () => {
    const sql = await readFoundationMigration();
    const exactPolicies = [
      ["identity.tenants", ["id = ops.current_tenant_id()"]],
      [
        "identity.workspaces",
        ["tenant_id = ops.current_tenant_id()", "id = ops.current_workspace_id()"]
      ],
      ["identity.users", ["id = ops.current_user_id()"]],
      [
        "identity.memberships",
        [
          "tenant_id = ops.current_tenant_id()",
          "workspace_id = ops.current_workspace_id()",
          "id = ops.current_membership_id()",
          "user_id = ops.current_user_id()"
        ]
      ],
      [
        "identity.policy_versions",
        [
          "tenant_id = ops.current_tenant_id()",
          "workspace_id = ops.current_workspace_id()",
          "id = ops.current_policy_version()"
        ]
      ],
      [
        "identity.service_principals",
        [
          "tenant_id = ops.current_tenant_id()",
          "workspace_id = ops.current_workspace_id()",
          "id = ops.current_worker_principal_id()"
        ]
      ],
      [
        "access.spaces",
        [
          "tenant_id = ops.current_tenant_id()",
          "workspace_id = ops.current_workspace_id()",
          "id = ops.current_space_id()"
        ]
      ],
      [
        "ops.security_context_references",
        [
          "tenant_id = ops.current_tenant_id()",
          "workspace_id = ops.current_workspace_id()",
          "space_id = ops.current_space_id()",
          "id = ops.current_context_reference_id()",
          "job_id = ops.current_job_id()",
          "worker_service_principal_id = ops.current_worker_principal_id()",
          "policy_version_id = ops.current_policy_version()",
          "delegating_user_id = ops.current_user_id()",
          "delegating_membership_id = ops.current_membership_id()"
        ]
      ]
    ] as const;

    for (const [table, bindings] of exactPolicies) {
      const policy = workerUpdatePolicy(sql, table);
      expect(policy).toContain("current_user = 'throughline_worker'");
      for (const binding of bindings) expect(policy, `${table}: ${binding}`).toContain(binding);
      expect(policy).toMatch(/WITH CHECK \(false\);$/);
    }

    const relationshipPolicies = workerUpdatePolicies(sql, "access.access_relationships");
    expect(relationshipPolicies.length).toBeGreaterThanOrEqual(1);
    expect(relationshipPolicies.length).toBeLessThanOrEqual(2);
    for (const policy of relationshipPolicies) {
      for (const binding of [
        "tenant_id = ops.current_tenant_id()",
        "workspace_id = ops.current_workspace_id()",
        "resource_type = 'space'",
        "resource_id = ops.current_space_id()",
        "relation = 'contributor'",
        "source = 'direct'"
      ]) {
        expect(policy).toContain(binding);
      }
      expect(policy).toMatch(/WITH CHECK \(false\);$/);
    }
    const relationships = relationshipPolicies.join("\n");
    expect(relationships).toContain("subject_type = 'service_principal'");
    expect(relationships).toContain("subject_id = ops.current_worker_principal_id()");
    expect(relationships).toContain("subject_type = 'membership'");
    expect(relationships).toContain("subject_id = ops.current_membership_id()");
  });

  it("splits exact pending/last-effect visibility from the one-way pending mutation", async () => {
    const sql = await readFoundationMigration();

    expect(sql).toMatch(
      /CREATE POLICY foundation_test_aggregates_worker_job_select[\s\S]*?FOR SELECT TO throughline_worker[\s\S]*?tenant_id = ops\.current_tenant_id\(\)[\s\S]*?workspace_id = ops\.current_workspace_id\(\)[\s\S]*?space_id = ops\.current_space_id\(\)[\s\S]*?\(pending_job_id = ops\.current_job_id\(\) OR last_effect_job_id = ops\.current_job_id\(\)\)/
    );
    expect(sql).toMatch(
      /CREATE POLICY foundation_test_aggregates_worker_pending_update[\s\S]*?FOR UPDATE TO throughline_worker[\s\S]*?USING \([\s\S]*?tenant_id = ops\.current_tenant_id\(\)[\s\S]*?workspace_id = ops\.current_workspace_id\(\)[\s\S]*?space_id = ops\.current_space_id\(\)[\s\S]*?pending_job_id = ops\.current_job_id\(\)[\s\S]*?WITH CHECK \([\s\S]*?tenant_id = ops\.current_tenant_id\(\)[\s\S]*?workspace_id = ops\.current_workspace_id\(\)[\s\S]*?space_id = ops\.current_space_id\(\)[\s\S]*?pending_job_id IS NULL[\s\S]*?last_effect_job_id = ops\.current_job_id\(\)/
    );
    expect(sql).toMatch(
      /GRANT UPDATE \([\s\S]*?pending_job_id[\s\S]*?last_effect_job_id[\s\S]*?effect_count[\s\S]*?aggregate_version[\s\S]*?updated_at[\s\S]*?\)\s+ON ops\.foundation_test_aggregates TO throughline_worker;/
    );
  });

  it("binds exact committed-idempotency visibility to handler, aggregate version, and effect hash", async () => {
    const sql = await readFoundationMigration();

    for (const binding of [
      "tenant_id = ops.current_tenant_id()",
      "workspace_id = ops.current_workspace_id()",
      "space_id = ops.current_space_id()",
      "job_id = ops.current_job_id()",
      "context_reference_id = ops.current_context_reference_id()",
      "handler_key = ops.current_handler_key()",
      "aggregate_id = ops.current_aggregate_id()",
      "aggregate_version = ops.current_aggregate_version()",
      "effect_hash = ops.current_effect_hash()"
    ]) {
      expect(sql).toContain(binding);
    }
  });

  it("keeps the canonical migration credential-free and rejects privilege bypass mechanisms", async () => {
    const sql = await readFoundationMigration();

    expect(sql).toMatch(/ALTER ROLE throughline_worker[\s\S]*?NOLOGIN[\s\S]*?NOBYPASSRLS/);
    expect(sql).toMatch(/ALTER ROLE throughline_relay[\s\S]*?NOLOGIN[\s\S]*?NOBYPASSRLS/);
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'/i);
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).not.toMatch(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i);
    expect(sql).not.toMatch(/(?<!NO)BYPASSRLS/i);
    expect(sql).not.toMatch(
      /ALTER\s+(?:TABLE|SEQUENCE|FUNCTION)[\s\S]*?OWNER\s+TO\s+throughline_(?:worker|relay)/i
    );
    expect(sql).not.toMatch(
      /GRANT\s+UPDATE\s+ON\s+ops\.foundation_test_aggregates\s+TO\s+throughline_worker/i
    );
  });
});

function workerUpdatePolicy(sql: string, table: string): string {
  const policies = workerUpdatePolicies(sql, table);
  expect(policies, table).toHaveLength(1);
  return policies[0]!;
}

function workerUpdatePolicies(sql: string, table: string): string[] {
  const escaped = table.replace(".", "\\.");
  return [
    ...sql.matchAll(
      new RegExp(
        `CREATE POLICY [a-z_]+ ON ${escaped}\\s+FOR UPDATE TO throughline_worker[\\s\\S]*?WITH CHECK \\(false\\);`,
        "gi"
      )
    )
  ].map(([policy]) => policy);
}

async function readFoundationMigration(): Promise<string> {
  return readFile(
    new URL("../migrations/0002_foundation_closure_async_isolation.sql", import.meta.url),
    "utf8"
  );
}
