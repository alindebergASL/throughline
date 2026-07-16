import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DomainNotificationEnvelope, SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext, devFixtures, DEV_POLICY_VERSION } from "@throughline/tenancy";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations as applyRepositoryMigrations,
  type MigrationRunResult
} from "./migrations.js";
import {
  ProductDomainInvariantError,
  ProductDomainTransactionRepositories,
  hashCanonicalCommandRequest,
  type DomainCommandReservationInput
} from "./product-domain-repositories.js";
import { provisionProductRelayDirectManagerAccess } from "./product-relay-provisioning.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { provisionTestAppRole, provisionTestProductRelayRole } from "./test-database.js";
import { withTenantTransaction, type TenantDbTransaction } from "./transaction.js";
import { PRODUCT_AUDIT_DETAIL_TEST_VECTORS } from "./audit-safe-detail-test-vectors.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const productRelayUrl = process.env.TEST_PRODUCT_RELAY_DATABASE_URL;
const authoritative = process.env.B1_0_AUTHORITATIVE_GATE === "1";
const configured = Boolean(ownerUrl && appUrl && productRelayUrl);
const maybeDescribe = configured || authoritative ? describe.sequential : describe.skip;

const migrationIds = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql"
] as const;

function applyMigrations(pool: pg.Pool, options: { reset?: boolean } = {}) {
  return applyRepositoryMigrations(pool, {
    ...options,
    through: migrationIds[2]
  });
}
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const ids = {
  commandA: "71000000-0000-7000-8000-000000000001",
  commandB: "71000000-0000-7000-8000-000000000002",
  commandRollback: "71000000-0000-7000-8000-000000000003",
  commandConcurrent: "71000000-0000-7000-8000-000000000004",
  commandReserved: "71000000-0000-7000-8000-000000000005",
  commandWrongSpace: "71000000-0000-7000-8000-000000000006",
  auditA: "72000000-0000-7000-8000-000000000001",
  auditCross: "72000000-0000-7000-8000-000000000002",
  auditRollback: "72000000-0000-7000-8000-000000000003",
  eventA: "73000000-0000-7000-8000-000000000001",
  eventCross: "73000000-0000-7000-8000-000000000002",
  eventRollback: "73000000-0000-7000-8000-000000000003",
  aggregateA: "74000000-0000-7000-8000-000000000001",
  aggregateB: "74000000-0000-7000-8000-000000000002",
  aggregateRollback: "74000000-0000-7000-8000-000000000003",
  aggregateConcurrent: "74000000-0000-7000-8000-000000000004"
} as const;

type ExactPolicyExpectation = {
  checkExpression: string | null;
  command: "ALL" | "INSERT" | "SELECT" | "UPDATE";
  name: string;
  permissive: boolean;
  role: "throughline_app" | "throughline_b1_0_integrity" | "throughline_product_relay";
  schema: "access" | "identity" | "ops";
  table: string;
  usingExpression: string | null;
};

const appWorkspaceScope = `tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()`;
const workspaceIdentityScope = `tenant_id = ops.current_tenant_id()
  AND id = ops.current_workspace_id()`;
const appSpaceScope = `${appWorkspaceScope}
  AND space_id = ops.current_space_id()`;
const commandAppScope = `${appWorkspaceScope}
  AND reservation_space_id = ops.current_space_id()
  AND actor_user_id = ops.current_user_id()
  AND actor_membership_id = ops.current_membership_id()
  AND policy_version_id = ops.current_policy_version()`;
const productRelayScope = `current_user = 'throughline_product_relay'
  AND tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND relay_service_principal_id = ops.current_service_principal_id()
  AND policy_version_id = ops.current_policy_version()`;

function exactPolicy(
  schema: ExactPolicyExpectation["schema"],
  table: string,
  name: string,
  command: ExactPolicyExpectation["command"],
  role: ExactPolicyExpectation["role"],
  usingExpression: string | null,
  checkExpression: string | null,
  permissive = true
): ExactPolicyExpectation {
  return {
    schema,
    table,
    name,
    command,
    role,
    usingExpression,
    checkExpression,
    permissive
  };
}

const productRelayAuthorityPolicies = [
  {
    schema: "identity",
    table: "tenants",
    select: `current_user = 'throughline_product_relay'
      AND id = ops.current_tenant_id()`,
    lock: `current_user = 'throughline_product_relay'
      AND id = ops.current_tenant_id() AND status = 'active'`
  },
  {
    schema: "identity",
    table: "workspaces",
    select: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id()`,
    lock: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND id = ops.current_workspace_id() AND status = 'active'`
  },
  {
    schema: "identity",
    table: "policy_versions",
    select: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND id = ops.current_policy_version()`,
    lock: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND id = ops.current_policy_version() AND status = 'active'`
  },
  {
    schema: "identity",
    table: "service_principals",
    select: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND id = ops.current_service_principal_id()`,
    lock: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND id = ops.current_service_principal_id()
      AND purpose = 'product_notification_relay' AND status = 'active'`
  },
  {
    schema: "access",
    table: "spaces",
    select: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND id = ops.current_space_id()`,
    lock: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND id = ops.current_space_id() AND archived_at IS NULL`
  },
  {
    schema: "access",
    table: "access_relationships",
    select: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND subject_type = 'service_principal'
      AND subject_id = ops.current_service_principal_id()
      AND relation = 'manager' AND resource_type = 'space'
      AND resource_id = ops.current_space_id() AND source = 'direct'`,
    lock: `current_user = 'throughline_product_relay'
      AND tenant_id = ops.current_tenant_id()
      AND workspace_id = ops.current_workspace_id()
      AND subject_type = 'service_principal'
      AND subject_id = ops.current_service_principal_id()
      AND relation = 'manager' AND resource_type = 'space'
      AND resource_id = ops.current_space_id() AND source = 'direct'`
  }
] as const;

const exactPolicyCatalog: ExactPolicyExpectation[] = [
  exactPolicy(
    "identity",
    "tenants",
    "tenants_current_tenant",
    "ALL",
    "throughline_app",
    "id = ops.current_tenant_id()",
    "id = ops.current_tenant_id()"
  ),
  exactPolicy(
    "identity",
    "workspaces",
    "workspaces_current_workspace",
    "ALL",
    "throughline_app",
    workspaceIdentityScope,
    workspaceIdentityScope
  ),
  ...(["service_principals", "policy_versions"] as const).map((table) =>
    exactPolicy(
      "identity",
      table,
      `${table}_current_workspace`,
      "ALL",
      "throughline_app",
      appWorkspaceScope,
      appWorkspaceScope
    )
  ),
  ...(["spaces", "access_relationships"] as const).map((table) =>
    exactPolicy(
      "access",
      table,
      `${table}_current_workspace`,
      "ALL",
      "throughline_app",
      appWorkspaceScope,
      appWorkspaceScope
    )
  ),
  exactPolicy(
    "ops",
    "domain_command_records",
    "domain_command_records_app_select",
    "SELECT",
    "throughline_app",
    `${appWorkspaceScope}\n  AND reservation_space_id = ops.current_space_id()`,
    null
  ),
  exactPolicy(
    "ops",
    "domain_command_records",
    "domain_command_records_integrity_select",
    "SELECT",
    "throughline_b1_0_integrity",
    "true",
    null
  ),
  exactPolicy(
    "ops",
    "domain_command_records",
    "domain_command_records_app_insert",
    "INSERT",
    "throughline_app",
    null,
    `${commandAppScope}
      AND state = 'reserved'
      AND result_resource_type IS NULL AND result_resource_id IS NULL
      AND safe_response IS NULL AND completed_at IS NULL
      AND updated_at = created_at`
  ),
  exactPolicy(
    "ops",
    "domain_command_records",
    "domain_command_records_app_complete",
    "UPDATE",
    "throughline_app",
    commandAppScope,
    commandAppScope
  ),
  exactPolicy(
    "ops",
    "audit_events",
    "audit_events_app_select",
    "SELECT",
    "throughline_app",
    appSpaceScope,
    null
  ),
  exactPolicy(
    "ops",
    "audit_events",
    "audit_events_app_insert",
    "INSERT",
    "throughline_app",
    null,
    `${appSpaceScope}
      AND actor_user_id = ops.current_user_id()
      AND actor_membership_id = ops.current_membership_id()
      AND policy_version_id = ops.current_policy_version()`
  ),
  exactPolicy(
    "ops",
    "product_outbox_events",
    "product_outbox_events_app_select",
    "SELECT",
    "throughline_app",
    appSpaceScope,
    null
  ),
  exactPolicy(
    "ops",
    "product_outbox_events",
    "product_outbox_events_app_insert",
    "INSERT",
    "throughline_app",
    null,
    `${appSpaceScope}
      AND policy_version_id = ops.current_policy_version()
      AND EXISTS (
        SELECT 1 FROM identity.service_principals principal
        WHERE principal.tenant_id = product_outbox_events.tenant_id
          AND principal.workspace_id = product_outbox_events.workspace_id
          AND principal.id = product_outbox_events.relay_service_principal_id
          AND principal.purpose = 'product_notification_relay'
          AND principal.status = 'active'
      )
      AND publication_state = 'pending' AND publication_attempt = 0
      AND next_attempt_at = created_at
      AND claimed_at IS NULL AND claimed_by IS NULL
      AND claim_token IS NULL AND claim_expires_at IS NULL
      AND last_outcome_code IS NULL
      AND published_at IS NULL AND published_message_id IS NULL
      AND terminal_at IS NULL`
  ),
  exactPolicy(
    "ops",
    "product_outbox_events",
    "product_outbox_events_product_relay_select",
    "SELECT",
    "throughline_product_relay",
    productRelayScope,
    null
  ),
  exactPolicy(
    "ops",
    "product_outbox_events",
    "product_outbox_events_product_relay_update",
    "UPDATE",
    "throughline_product_relay",
    productRelayScope,
    productRelayScope
  ),
  ...productRelayAuthorityPolicies.flatMap(({ schema, table, select, lock }) => [
    exactPolicy(
      schema,
      table,
      `${table}_product_relay_select`,
      "SELECT",
      "throughline_product_relay",
      select,
      null
    ),
    exactPolicy(
      schema,
      table,
      `${table}_product_relay_lock_only`,
      "UPDATE",
      "throughline_product_relay",
      lock,
      "false"
    ),
    exactPolicy(
      schema,
      table,
      `${table}_product_relay_no_write`,
      "UPDATE",
      "throughline_product_relay",
      "true",
      "false",
      false
    )
  ])
];

maybeDescribe("B1.0 real PostgreSQL product-domain prerequisite", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  const productRelayPool = new pg.Pool({ connectionString: productRelayUrl });
  let cleanApply: MigrationRunResult;
  let migrationRoleCanLogin: boolean;
  let productRelayPrincipalId: string;
  let productRelayRelationshipId: string;

  beforeAll(async () => {
    if (!configured) throw new Error("Authoritative B1.0 PostgreSQL configuration is missing");
    assertDistinctUrls(ownerUrl!, appUrl!, productRelayUrl!);
    cleanApply = await applyMigrations(ownerPool, { reset: true });
    migrationRoleCanLogin = await readProductRelayCanLogin();
    await provisionAndSeed();
  });

  afterAll(async () => {
    await productRelayPool.end();
    await appPool.end();
    await ownerPool.end();
  });

  async function provisionAndSeed(): Promise<void> {
    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestProductRelayRole(ownerPool, productRelayUrl!);
    await seedWaveA2DeterministicData(ownerPool);
    const provisioned = await withOwnerTransaction(ownerPool, (tx) =>
      provisionProductRelayDirectManagerAccess(tx, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA
      })
    );
    productRelayPrincipalId = provisioned.principalId;
    productRelayRelationshipId = provisioned.id;
  }

  async function readProductRelayCanLogin(): Promise<boolean> {
    const result = await ownerPool.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'throughline_product_relay'"
    );
    return result.rows[0]?.rolcanlogin ?? true;
  }

  async function expectContractSchemaAbsent(): Promise<void> {
    const result = await ownerPool.query<{ schema_name: string | null }>(`
      SELECT to_regnamespace('throughline_b1_0_migration_contract')::text AS schema_name
    `);
    expect(result.rows[0]).toEqual({ schema_name: null });
  }

  async function expectExactPolicyCatalog(): Promise<void> {
    const client = await ownerPool.connect();
    const contractPolicyName = "throughline_b1_0_expected_policy_catalog_test";
    try {
      await client.query("BEGIN");
      const catalog = await client.query<{
        command: string;
        name: string;
        permissive: boolean;
        roles: string[];
        schema_name: string;
        table_name: string;
      }>(`
        WITH RECURSIVE applicable_role(role_oid) AS (
          SELECT seed.role_oid
          FROM (
            SELECT 0::oid AS role_oid
            UNION ALL
            SELECT oid FROM pg_roles
            WHERE rolname IN (
              'throughline_app', 'throughline_product_relay', 'throughline_b1_0_integrity'
            )
          ) AS seed
          UNION
          SELECT membership.roleid
          FROM pg_auth_members AS membership
          JOIN applicable_role AS member_role ON member_role.role_oid = membership.member
        )
        SELECT namespace_record.nspname AS schema_name,
               relation_record.relname AS table_name,
               policy_record.polname AS name,
               policy_record.polcmd::text AS command,
               policy_record.polpermissive AS permissive,
               ARRAY(
                 SELECT (CASE
                   WHEN role_oid = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(role_oid)
                 END)::text
                 FROM unnest(policy_record.polroles) AS role_oid
                 ORDER BY (CASE
                   WHEN role_oid = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(role_oid)
                 END)::text COLLATE "C"
               ) AS roles
        FROM pg_policy AS policy_record
        JOIN pg_class AS relation_record ON relation_record.oid = policy_record.polrelid
        JOIN pg_namespace AS namespace_record ON namespace_record.oid = relation_record.relnamespace
        WHERE (namespace_record.nspname, relation_record.relname) IN (
          ('identity', 'tenants'),
          ('identity', 'workspaces'),
          ('identity', 'policy_versions'),
          ('identity', 'service_principals'),
          ('access', 'spaces'),
          ('access', 'access_relationships'),
          ('ops', 'domain_command_records'),
          ('ops', 'audit_events'),
          ('ops', 'product_outbox_events')
        )
          AND (
            namespace_record.nspname = 'ops'
            OR policy_record.polroles && ARRAY(SELECT role_oid FROM applicable_role)
          )
        ORDER BY namespace_record.nspname COLLATE "C",
                 relation_record.relname COLLATE "C",
                 policy_record.polname COLLATE "C"
      `);
      const commandCode = { ALL: "*", INSERT: "a", SELECT: "r", UPDATE: "w" } as const;
      const expectedCatalog = exactPolicyCatalog
        .map((policy) => ({
          schema_name: policy.schema,
          table_name: policy.table,
          name: policy.name,
          command: commandCode[policy.command],
          permissive: policy.permissive,
          roles: [policy.role]
        }))
        .sort((left, right) =>
          `${left.schema_name}.${left.table_name}.${left.name}` <
          `${right.schema_name}.${right.table_name}.${right.name}`
            ? -1
            : 1
        );
      expect(catalog.rows).toEqual(expectedCatalog);

      for (const policy of exactPolicyCatalog) {
        const relation = `${quotedIdentifier(policy.schema)}.${quotedIdentifier(policy.table)}`;
        const usingClause =
          policy.usingExpression === null ? "" : ` USING (${policy.usingExpression})`;
        const checkClause =
          policy.checkExpression === null ? "" : ` WITH CHECK (${policy.checkExpression})`;
        await client.query(
          `CREATE POLICY ${quotedIdentifier(contractPolicyName)} ON ${relation} ` +
            `AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"} ` +
            `FOR ${policy.command} TO ${quotedIdentifier(policy.role)}` +
            usingClause +
            checkClause
        );
        const definitions = await client.query<{
          check_tree: string | null;
          command: string;
          name: string;
          permissive: boolean;
          roles: string[];
          using_tree: string | null;
        }>(
          `SELECT policy_record.polname AS name,
                  policy_record.polcmd::text AS command,
                  policy_record.polpermissive AS permissive,
                  ARRAY(
                    SELECT (CASE
                      WHEN role_oid = 0 THEN 'PUBLIC'
                      ELSE pg_get_userbyid(role_oid)
                    END)::text
                    FROM unnest(policy_record.polroles) AS role_oid
                    ORDER BY (CASE
                      WHEN role_oid = 0 THEN 'PUBLIC'
                      ELSE pg_get_userbyid(role_oid)
                    END)::text COLLATE "C"
                  ) AS roles,
                  pg_get_expr(policy_record.polqual, policy_record.polrelid, false) AS using_tree,
                  pg_get_expr(policy_record.polwithcheck, policy_record.polrelid, false) AS check_tree
           FROM pg_policy AS policy_record
           WHERE policy_record.polrelid = $1::regclass
             AND policy_record.polname = ANY($2::text[])`,
          [`${policy.schema}.${policy.table}`, [policy.name, contractPolicyName]]
        );
        const installed = definitions.rows.find(({ name }) => name === policy.name);
        const contract = definitions.rows.find(({ name }) => name === contractPolicyName);
        expect(installed, policy.name).toBeDefined();
        expect(contract, policy.name).toBeDefined();
        expect({ ...installed, name: contractPolicyName }, policy.name).toEqual(contract);
        await client.query(`DROP POLICY ${quotedIdentifier(contractPolicyName)} ON ${relation}`);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("clean-applies, journals, repeats, rejects checksum drift, and resets 0003 naturally", async () => {
    expect(cleanApply).toEqual({ applied: migrationIds, skipped: [] });
    await expectContractSchemaAbsent();
    const repeated = await applyMigrations(ownerPool);
    expect(repeated).toEqual({ applied: [], skipped: migrationIds });

    const journal = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    );
    expect(journal.rows.map(({ id }) => id)).toEqual(migrationIds);
    for (const row of journal.rows) {
      const sql = await readFile(new URL(`../migrations/${row.id}`, import.meta.url));
      expect(row.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
    }

    const migrationId = migrationIds[2];
    const checksum = journal.rows[2]!.checksum;
    await ownerPool.query("UPDATE throughline_migrations.journal SET checksum = $2 WHERE id = $1", [
      migrationId,
      "0".repeat(64)
    ]);
    await expect(applyMigrations(ownerPool)).rejects.toThrow(
      `Migration checksum mismatch for ${migrationId}`
    );
    await ownerPool.query("UPDATE throughline_migrations.journal SET checksum = $2 WHERE id = $1", [
      migrationId,
      checksum
    ]);

    await expect(applyMigrations(ownerPool, { reset: true })).resolves.toEqual({
      applied: migrationIds,
      skipped: []
    });
    migrationRoleCanLogin = await readProductRelayCanLogin();
    await provisionAndSeed();
  });

  it("adopts the installed schema with a missing journal without replacing tables or data", async () => {
    const beforeRelations = await ownerPool.query<{ name: string; oid: string }>(`
      SELECT relation.relname AS name, relation.oid::text AS oid
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops'
        AND relation.relname IN ('domain_command_records', 'audit_events', 'product_outbox_events')
      ORDER BY relation.relname
    `);
    const beforeRows = await ownerPool.query<{
      access_relationships: string;
      service_principals: string;
      tenants: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM identity.tenants) AS tenants,
        (SELECT count(*)::text FROM identity.service_principals) AS service_principals,
        (SELECT count(*)::text FROM access.access_relationships) AS access_relationships
    `);

    await ownerPool.query("DELETE FROM throughline_migrations.journal");
    const adopted = await applyMigrations(ownerPool);
    const repeated = await applyMigrations(ownerPool);

    const afterRelations = await ownerPool.query<{ name: string; oid: string }>(`
      SELECT relation.relname AS name, relation.oid::text AS oid
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops'
        AND relation.relname IN ('domain_command_records', 'audit_events', 'product_outbox_events')
      ORDER BY relation.relname
    `);
    const afterRows = await ownerPool.query<{
      access_relationships: string;
      service_principals: string;
      tenants: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM identity.tenants) AS tenants,
        (SELECT count(*)::text FROM identity.service_principals) AS service_principals,
        (SELECT count(*)::text FROM access.access_relationships) AS access_relationships
    `);

    expect(adopted).toEqual({ applied: migrationIds, skipped: [] });
    expect(repeated).toEqual({ applied: [], skipped: migrationIds });
    expect(afterRelations.rows).toEqual(beforeRelations.rows);
    expect(afterRows.rows).toEqual(beforeRows.rows);
    await expectContractSchemaAbsent();

    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestProductRelayRole(ownerPool, productRelayUrl!);
  });

  it("fails closed on wrong same-name index, constraint, trigger, and policy definitions", async () => {
    const migrationId = migrationIds[2];
    await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
      migrationId
    ]);

    async function expectRejectedDefinition(
      mutate: () => Promise<unknown>,
      restore: () => Promise<unknown>,
      message: string
    ): Promise<void> {
      await mutate();
      try {
        await expect(applyMigrations(ownerPool)).rejects.toThrow(message);
        const journal = await ownerPool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM throughline_migrations.journal WHERE id = $1",
          [migrationId]
        );
        expect(journal.rows[0]?.count).toBe("0");
        await expectContractSchemaAbsent();
      } finally {
        await restore();
      }
    }

    await expectRejectedDefinition(
      async () => {
        await ownerPool.query(
          "DROP INDEX identity.service_principals_product_notification_relay_unique"
        );
        await ownerPool.query(`
          CREATE UNIQUE INDEX service_principals_product_notification_relay_unique
          ON identity.service_principals (tenant_id)
          WHERE purpose = 'product_notification_relay'
        `);
      },
      async () => {
        await ownerPool.query(
          "DROP INDEX IF EXISTS identity.service_principals_product_notification_relay_unique"
        );
        await ownerPool.query(`
          CREATE UNIQUE INDEX service_principals_product_notification_relay_unique
          ON identity.service_principals (tenant_id, workspace_id)
          WHERE purpose = 'product_notification_relay'
        `);
      },
      "Existing index identity.service_principals_product_notification_relay_unique does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      async () => {
        await ownerPool.query("DROP INDEX ops.audit_events_resource_created_idx");
        await ownerPool.query(`
          CREATE INDEX audit_events_resource_created_idx
          ON ops.audit_events (
            tenant_id, workspace_id, space_id, resource_type text_pattern_ops,
            resource_id, created_at
          )
        `);
      },
      async () => {
        await ownerPool.query("DROP INDEX ops.audit_events_resource_created_idx");
        await ownerPool.query(`
          CREATE INDEX audit_events_resource_created_idx
          ON ops.audit_events (
            tenant_id, workspace_id, space_id, resource_type, resource_id, created_at
          )
        `);
      },
      "Existing index ops.audit_events_resource_created_idx does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      async () => {
        await ownerPool.query(
          "DROP INDEX identity.service_principals_product_notification_relay_unique"
        );
        await ownerPool.query(`
          CREATE UNIQUE INDEX service_principals_product_notification_relay_unique
          ON identity.service_principals (tenant_id DESC, workspace_id)
          WHERE purpose = 'product_notification_relay'
        `);
      },
      async () => {
        await ownerPool.query(
          "DROP INDEX identity.service_principals_product_notification_relay_unique"
        );
        await ownerPool.query(`
          CREATE UNIQUE INDEX service_principals_product_notification_relay_unique
          ON identity.service_principals (tenant_id, workspace_id)
          WHERE purpose = 'product_notification_relay'
        `);
      },
      "Existing index identity.service_principals_product_notification_relay_unique does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      async () => {
        await ownerPool.query(
          "DROP INDEX identity.service_principals_product_notification_relay_unique"
        );
        await ownerPool.query(`
          CREATE UNIQUE INDEX service_principals_product_notification_relay_unique
          ON identity.service_principals (tenant_id, workspace_id)
          WHERE purpose = 'PRODUCT_NOTIFICATION_RELAY'
        `);
      },
      async () => {
        await ownerPool.query(
          "DROP INDEX identity.service_principals_product_notification_relay_unique"
        );
        await ownerPool.query(`
          CREATE UNIQUE INDEX service_principals_product_notification_relay_unique
          ON identity.service_principals (tenant_id, workspace_id)
          WHERE purpose = 'product_notification_relay'
        `);
      },
      "Existing index identity.service_principals_product_notification_relay_unique does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      async () => {
        await ownerPool.query(`
          ALTER TABLE ops.product_outbox_events
          DROP CONSTRAINT product_outbox_events_attempt_check,
          ADD CONSTRAINT product_outbox_events_attempt_check
            CHECK (publication_attempt BETWEEN 0 AND 5)
        `);
      },
      () =>
        ownerPool.query(`
          ALTER TABLE ops.product_outbox_events
          DROP CONSTRAINT product_outbox_events_attempt_check,
          ADD CONSTRAINT product_outbox_events_attempt_check
            CHECK (publication_attempt BETWEEN 0 AND 6)
        `),
      "Existing table ops.product_outbox_events constraints do not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      async () => {
        await ownerPool.query(
          "DROP TRIGGER domain_command_records_transition_guard ON ops.domain_command_records"
        );
        await ownerPool.query(`
          CREATE TRIGGER domain_command_records_transition_guard
          BEFORE UPDATE ON ops.domain_command_records
          FOR EACH ROW EXECUTE FUNCTION ops.enforce_domain_command_transition()
        `);
      },
      async () => {
        await ownerPool.query(
          "DROP TRIGGER domain_command_records_transition_guard ON ops.domain_command_records"
        );
        await ownerPool.query(`
          CREATE TRIGGER domain_command_records_transition_guard
          BEFORE INSERT OR UPDATE OR DELETE ON ops.domain_command_records
          FOR EACH ROW EXECUTE FUNCTION ops.enforce_domain_command_transition()
        `);
      },
      "Existing trigger domain_command_records_transition_guard on ops.domain_command_records does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      () =>
        ownerPool.query(`
          ALTER POLICY tenants_product_relay_select ON identity.tenants
          USING (false)
        `),
      () =>
        ownerPool.query(`
          ALTER POLICY tenants_product_relay_select ON identity.tenants
          USING (
            current_user = 'throughline_product_relay'
            AND id = ops.current_tenant_id()
          )
        `),
      "Existing policy tenants_product_relay_select on identity.tenants does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      () =>
        ownerPool.query(`
          ALTER POLICY service_principals_product_relay_lock_only
          ON identity.service_principals
          USING (
            current_user = 'throughline_product_relay'
            AND tenant_id = ops.current_tenant_id()
            AND workspace_id = ops.current_workspace_id()
            AND id = ops.current_service_principal_id()
            AND purpose = 'PRODUCT_NOTIFICATION_RELAY' AND status = 'active'
          )
        `),
      () =>
        ownerPool.query(`
          ALTER POLICY service_principals_product_relay_lock_only
          ON identity.service_principals
          USING (
            current_user = 'throughline_product_relay'
            AND tenant_id = ops.current_tenant_id()
            AND workspace_id = ops.current_workspace_id()
            AND id = ops.current_service_principal_id()
            AND purpose = 'product_notification_relay' AND status = 'active'
          )
        `),
      "Existing policy service_principals_product_relay_lock_only on identity.service_principals does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      () =>
        ownerPool.query(`
          CREATE POLICY b1_0_unexpected_public_policy ON ops.audit_events
          FOR SELECT TO PUBLIC USING (true)
        `),
      () => ownerPool.query("DROP POLICY b1_0_unexpected_public_policy ON ops.audit_events"),
      "Unexpected RLS policy is applicable to a B1.0 protected role"
    );

    await expectRejectedDefinition(
      () =>
        ownerPool.query(`
          CREATE POLICY b1_0_unexpected_app_policy ON identity.tenants
          FOR SELECT TO throughline_app USING (true)
        `),
      () => ownerPool.query("DROP POLICY b1_0_unexpected_app_policy ON identity.tenants"),
      "Unexpected RLS policy is applicable to a B1.0 protected role"
    );

    await expectRejectedDefinition(
      async () => {
        await ownerPool.query("CREATE ROLE b1_0_policy_parent NOLOGIN");
        await ownerPool.query("CREATE ROLE b1_0_policy_intermediate NOLOGIN");
        await ownerPool.query("GRANT b1_0_policy_parent TO b1_0_policy_intermediate");
        await ownerPool.query("GRANT b1_0_policy_intermediate TO throughline_app");
        await ownerPool.query(`
          CREATE POLICY b1_0_inherited_policy ON identity.tenants
          FOR SELECT TO b1_0_policy_parent USING (true)
        `);
      },
      async () => {
        await ownerPool.query("DROP POLICY b1_0_inherited_policy ON identity.tenants");
        await ownerPool.query("REVOKE b1_0_policy_intermediate FROM throughline_app");
        await ownerPool.query("REVOKE b1_0_policy_parent FROM b1_0_policy_intermediate");
        await ownerPool.query("DROP ROLE b1_0_policy_intermediate");
        await ownerPool.query("DROP ROLE b1_0_policy_parent");
      },
      "Unexpected B1.0 runtime or integrity role membership path"
    );

    await expectRejectedDefinition(
      () =>
        ownerPool.query(`
          CREATE TRIGGER domain_command_records_transition_guard
          BEFORE UPDATE ON identity.tenants
          FOR EACH ROW EXECUTE FUNCTION ops.reject_audit_event_mutation()
        `),
      () =>
        ownerPool.query("DROP TRIGGER domain_command_records_transition_guard ON identity.tenants"),
      "Unexpected trigger is applicable to the B1.0 catalog"
    );

    await expectRejectedDefinition(
      () =>
        ownerPool.query(`
          CREATE RULE b1_0_unexpected_rule AS
          ON DELETE TO identity.tenants DO INSTEAD NOTHING
        `),
      () => ownerPool.query("DROP RULE b1_0_unexpected_rule ON identity.tenants"),
      "Unexpected rewrite rule is applicable to the B1.0 catalog"
    );

    await expectRejectedDefinition(
      () =>
        ownerPool.query(
          "GRANT SELECT (claim_token) ON ops.product_outbox_events TO throughline_app"
        ),
      () =>
        ownerPool.query(
          "REVOKE SELECT (claim_token) ON ops.product_outbox_events FROM throughline_app"
        ),
      "Existing grants do not match the exact B1.0 privilege catalog"
    );

    await expectRejectedDefinition(
      () => ownerPool.query("ALTER TABLE ops.audit_events OWNER TO throughline_b1_0_integrity"),
      () => ownerPool.query("ALTER TABLE ops.audit_events OWNER TO CURRENT_USER"),
      "Existing index ops.audit_events_resource_created_idx does not match the B1.0 definition"
    );

    await expectRejectedDefinition(
      () => ownerPool.query("ALTER TABLE identity.tenants OWNER TO throughline_b1_0_integrity"),
      () => ownerPool.query("ALTER TABLE identity.tenants OWNER TO CURRENT_USER"),
      "Existing protected authority table security shape does not match B1.0"
    );

    await expectRejectedDefinition(
      () => ownerPool.query("ALTER TABLE identity.workspaces DISABLE ROW LEVEL SECURITY"),
      () =>
        ownerPool.query(`
          ALTER TABLE identity.workspaces ENABLE ROW LEVEL SECURITY;
          ALTER TABLE identity.workspaces FORCE ROW LEVEL SECURITY
        `),
      "Existing protected authority table security shape does not match B1.0"
    );

    await expectRejectedDefinition(
      () => ownerPool.query("ALTER SCHEMA access OWNER TO throughline_b1_0_integrity"),
      () => ownerPool.query("ALTER SCHEMA access OWNER TO CURRENT_USER"),
      "Existing protected schema ownership does not match B1.0"
    );

    for (const functionMutation of [
      {
        mutate: () =>
          ownerPool.query("ALTER FUNCTION ops.product_safe_json(jsonb) OWNER TO CURRENT_USER"),
        restore: () =>
          ownerPool.query(
            "ALTER FUNCTION ops.product_safe_json(jsonb) OWNER TO throughline_b1_0_integrity"
          )
      },
      {
        mutate: () =>
          ownerPool.query("ALTER FUNCTION ops.product_safe_json(jsonb) SET search_path = public"),
        restore: () =>
          ownerPool.query(
            "ALTER FUNCTION ops.product_safe_json(jsonb) SET search_path = pg_catalog"
          )
      },
      {
        mutate: () =>
          ownerPool.query("GRANT EXECUTE ON FUNCTION ops.product_safe_json(jsonb) TO PUBLIC"),
        restore: () =>
          ownerPool.query("REVOKE EXECUTE ON FUNCTION ops.product_safe_json(jsonb) FROM PUBLIC")
      },
      {
        mutate: () =>
          ownerPool.query("ALTER FUNCTION ops.product_safe_json(jsonb) SECURITY DEFINER"),
        restore: () =>
          ownerPool.query("ALTER FUNCTION ops.product_safe_json(jsonb) SECURITY INVOKER")
      }
    ]) {
      await expectRejectedDefinition(
        functionMutation.mutate,
        functionMutation.restore,
        "Existing function ops.product_safe_json(jsonb) does not match the B1.0 definition"
      );
    }

    await expectRejectedDefinition(
      () =>
        ownerPool.query(
          "GRANT EXECUTE ON FUNCTION ops.reject_committed_reserved_command() TO throughline_app"
        ),
      () =>
        ownerPool.query(
          "REVOKE EXECUTE ON FUNCTION ops.reject_committed_reserved_command() FROM throughline_app"
        ),
      "Existing function ops.reject_committed_reserved_command() does not match the B1.0 definition"
    );

    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [migrationId],
      skipped: migrationIds.slice(0, 2)
    });
    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestProductRelayRole(ownerPool, productRelayUrl!);
  }, 60_000);

  it("installs exact forced-RLS catalogs, immediate causation FKs, policies, and grants", async () => {
    const catalogOwner = await ownerPool.query<{ current_user: string }>("SELECT current_user");
    const tables = await ownerPool.query<{
      owner_name: string;
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relation.relname AS table_name, relation.relrowsecurity, relation.relforcerowsecurity,
             pg_get_userbyid(relation.relowner) AS owner_name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops'
        AND relation.relname IN ('domain_command_records', 'audit_events', 'product_outbox_events')
      ORDER BY relation.relname
    `);
    expect(tables.rows).toEqual(
      ["audit_events", "domain_command_records", "product_outbox_events"].map((table_name) => ({
        table_name,
        owner_name: catalogOwner.rows[0]!.current_user,
        relrowsecurity: true,
        relforcerowsecurity: true
      }))
    );

    const authorityOwners = await ownerPool.query<{
      owner_name: string;
      relforcerowsecurity: boolean;
      relrowsecurity: boolean;
      schema_name: string;
      table_name: string;
    }>(`
      SELECT namespace.nspname AS schema_name, relation.relname AS table_name,
             pg_get_userbyid(relation.relowner) AS owner_name,
             relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE (namespace.nspname, relation.relname) IN (
        ('identity', 'tenants'),
        ('identity', 'workspaces'),
        ('identity', 'policy_versions'),
        ('identity', 'service_principals'),
        ('access', 'spaces'),
        ('access', 'access_relationships')
      )
      ORDER BY namespace.nspname, relation.relname
    `);
    expect(authorityOwners.rows).toEqual(
      [
        ["access", "access_relationships"],
        ["access", "spaces"],
        ["identity", "policy_versions"],
        ["identity", "service_principals"],
        ["identity", "tenants"],
        ["identity", "workspaces"]
      ].map(([schema_name, table_name]) => ({
        schema_name,
        table_name,
        owner_name: catalogOwner.rows[0]!.current_user,
        relrowsecurity: true,
        relforcerowsecurity: true
      }))
    );

    const schemaOwners = await ownerPool.query<{ owner_name: string; schema_name: string }>(`
      SELECT nspname AS schema_name, pg_get_userbyid(nspowner) AS owner_name
      FROM pg_namespace
      WHERE nspname IN ('identity', 'access', 'ops')
      ORDER BY nspname
    `);
    expect(schemaOwners.rows).toEqual(
      ["access", "identity", "ops"].map((schema_name) => ({
        schema_name,
        owner_name: catalogOwner.rows[0]!.current_user
      }))
    );

    const indexOwners = await ownerPool.query<{
      index_name: string;
      owner_name: string;
      schema_name: string;
    }>(`
      SELECT namespace.nspname AS schema_name, relation.relname AS index_name,
             pg_get_userbyid(relation.relowner) AS owner_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind = 'i' AND relation.relname IN (
        'service_principals_product_notification_relay_unique',
        'domain_command_records_scope_created_idx',
        'audit_events_resource_created_idx',
        'audit_events_command_idx',
        'product_outbox_events_publishable_idx',
        'product_outbox_events_scope_created_idx'
      )
      ORDER BY namespace.nspname, relation.relname
    `);
    expect(indexOwners.rows).toEqual(
      [
        ["identity", "service_principals_product_notification_relay_unique"],
        ["ops", "audit_events_command_idx"],
        ["ops", "audit_events_resource_created_idx"],
        ["ops", "domain_command_records_scope_created_idx"],
        ["ops", "product_outbox_events_publishable_idx"],
        ["ops", "product_outbox_events_scope_created_idx"]
      ].map(([schema_name, index_name]) => ({
        schema_name,
        index_name,
        owner_name: catalogOwner.rows[0]!.current_user
      }))
    );

    const role = await ownerPool.query<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(`
      SELECT rolcanlogin, rolbypassrls, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
             rolreplication
      FROM pg_roles WHERE rolname = 'throughline_product_relay'
    `);
    expect(role.rows[0]).toEqual({
      rolcanlogin: true,
      rolbypassrls: false,
      rolinherit: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false
    });
    expect(migrationRoleCanLogin).toBe(false);

    const integrityRole = await ownerPool.query<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(`
      SELECT rolcanlogin, rolbypassrls, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
             rolreplication
      FROM pg_roles WHERE rolname = 'throughline_b1_0_integrity'
    `);
    expect(integrityRole.rows[0]).toEqual({
      rolcanlogin: false,
      rolbypassrls: false,
      rolinherit: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false
    });

    const functions = await ownerPool.query<{
      execute_acl: string[];
      name: string;
      owner_name: string;
      proconfig: string[];
      security_definer: boolean;
    }>(`
      SELECT procedure_record.proname AS name,
             pg_get_userbyid(procedure_record.proowner) AS owner_name,
             procedure_record.proconfig,
             procedure_record.prosecdef AS security_definer,
             ARRAY(
               SELECT format(
                 '%s:%s',
                 CASE WHEN acl_record.grantee = 0
                   THEN 'PUBLIC' ELSE pg_get_userbyid(acl_record.grantee) END,
                 CASE WHEN acl_record.is_grantable THEN 'true' ELSE 'false' END
               )
               FROM aclexplode(COALESCE(
                 procedure_record.proacl,
                 acldefault('f', procedure_record.proowner)
               )) AS acl_record
               WHERE acl_record.privilege_type = 'EXECUTE'
                 AND acl_record.grantee <> procedure_record.proowner
               ORDER BY 1
             ) AS execute_acl
      FROM pg_proc AS procedure_record
      JOIN pg_namespace AS namespace_record
        ON namespace_record.oid = procedure_record.pronamespace
      WHERE namespace_record.nspname = 'ops'
        AND procedure_record.proname IN (
          'is_uuid_v7', 'product_safe_json', 'product_event_payload_valid',
          'product_audit_detail_valid', 'enforce_domain_command_transition',
          'reject_committed_reserved_command', 'reject_audit_event_mutation',
          'enforce_product_outbox_transition', 'validate_product_outbox_relay_binding'
        )
      ORDER BY procedure_record.proname
    `);
    const appAndRelay = ["throughline_app:false", "throughline_product_relay:false"];
    expect(functions.rows).toEqual([
      functionCatalog("enforce_domain_command_transition", []),
      functionCatalog("enforce_product_outbox_transition", []),
      functionCatalog("is_uuid_v7", appAndRelay),
      functionCatalog("product_audit_detail_valid", ["throughline_app:false"]),
      functionCatalog("product_event_payload_valid", appAndRelay),
      functionCatalog("product_safe_json", appAndRelay),
      functionCatalog("reject_audit_event_mutation", []),
      functionCatalog("reject_committed_reserved_command", [], true),
      functionCatalog("validate_product_outbox_relay_binding", [])
    ]);

    const protectedMemberships = await ownerPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_auth_members AS membership
      JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      JOIN pg_roles AS member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname IN (
        'throughline_app', 'throughline_product_relay', 'throughline_b1_0_integrity'
      ) OR member_role.rolname IN (
        'throughline_app', 'throughline_product_relay', 'throughline_b1_0_integrity'
      )
    `);
    expect(protectedMemberships.rows[0]?.count).toBe("0");

    const rewriteRules = await ownerPool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_rewrite
      WHERE ev_class IN (
        'identity.tenants'::regclass,
        'identity.workspaces'::regclass,
        'identity.policy_versions'::regclass,
        'identity.service_principals'::regclass,
        'access.spaces'::regclass,
        'access.access_relationships'::regclass,
        'ops.domain_command_records'::regclass,
        'ops.audit_events'::regclass,
        'ops.product_outbox_events'::regclass
      )
    `);
    expect(rewriteRules.rows[0]?.count).toBe("0");

    const causationFks = await ownerPool.query<{
      name: string;
      convalidated: boolean;
      condeferrable: boolean;
      definition: string;
    }>(`
      SELECT conname AS name, convalidated, condeferrable, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname IN ('audit_events_command_fk', 'product_outbox_events_command_fk')
      ORDER BY conname
    `);
    expect(causationFks.rows).toHaveLength(2);
    for (const foreignKey of causationFks.rows) {
      expect(foreignKey).toMatchObject({ convalidated: true, condeferrable: false });
      expect(foreignKey.definition).toContain(
        "FOREIGN KEY (tenant_id, workspace_id, causation_command_id)"
      );
    }

    const triggers = await ownerPool.query<{
      deferrable: boolean;
      enabled: string;
      function_name: string;
      initially_deferred: boolean;
      is_constraint: boolean;
      name: string;
      table_name: string;
      trigger_type: number;
    }>(`
      SELECT trigger_record.tgname AS name, table_record.relname AS table_name,
             function_record.proname AS function_name,
             trigger_record.tgtype::integer AS trigger_type,
             (trigger_record.tgconstraint <> 0) AS is_constraint,
             trigger_record.tgdeferrable AS deferrable,
             trigger_record.tginitdeferred AS initially_deferred,
             trigger_record.tgenabled::text AS enabled
      FROM pg_trigger AS trigger_record
      JOIN pg_class AS table_record ON table_record.oid = trigger_record.tgrelid
      JOIN pg_proc AS function_record ON function_record.oid = trigger_record.tgfoid
      WHERE NOT tgisinternal AND trigger_record.tgrelid IN (
        'identity.tenants'::regclass,
        'identity.workspaces'::regclass,
        'identity.policy_versions'::regclass,
        'identity.service_principals'::regclass,
        'access.spaces'::regclass,
        'access.access_relationships'::regclass,
        'ops.domain_command_records'::regclass,
        'ops.audit_events'::regclass,
        'ops.product_outbox_events'::regclass
      ) ORDER BY trigger_record.tgname, table_record.relname
    `);
    expect(triggers.rows).toEqual([
      triggerCatalog(
        "audit_events_append_only_guard",
        "audit_events",
        "reject_audit_event_mutation",
        27
      ),
      triggerCatalog(
        "domain_command_records_no_committed_reserved",
        "domain_command_records",
        "reject_committed_reserved_command",
        21,
        true
      ),
      triggerCatalog(
        "domain_command_records_transition_guard",
        "domain_command_records",
        "enforce_domain_command_transition",
        31
      ),
      triggerCatalog(
        "product_outbox_events_relay_binding_guard",
        "product_outbox_events",
        "validate_product_outbox_relay_binding",
        7
      ),
      triggerCatalog(
        "product_outbox_events_transition_guard",
        "product_outbox_events",
        "enforce_product_outbox_transition",
        31
      )
    ]);

    const policyNames = await ownerPool.query<{ policyname: string }>(`
      SELECT policyname FROM pg_policies
      WHERE policyname LIKE '%product_relay%' OR policyname LIKE 'product_outbox_events_%'
      ORDER BY policyname
    `);
    for (const required of [
      "product_outbox_events_app_insert",
      "product_outbox_events_app_select",
      "product_outbox_events_product_relay_select",
      "product_outbox_events_product_relay_update",
      "tenants_product_relay_lock_only",
      "tenants_product_relay_no_write",
      "access_relationships_product_relay_lock_only",
      "access_relationships_product_relay_no_write"
    ]) {
      expect(policyNames.rows.map(({ policyname }) => policyname)).toContain(required);
    }

    const b1Policies = await ownerPool.query<{
      cmd: string;
      permissive: string;
      policyname: string;
      roles: string[];
      tablename: string;
    }>(`
      SELECT tablename, policyname, permissive, roles::text[] AS roles, cmd
      FROM pg_policies
      WHERE schemaname = 'ops'
        AND tablename IN ('domain_command_records', 'audit_events', 'product_outbox_events')
      ORDER BY tablename, policyname
    `);
    expect(b1Policies.rows).toEqual([
      policyCatalog("audit_events", "audit_events_app_insert", "throughline_app", "INSERT"),
      policyCatalog("audit_events", "audit_events_app_select", "throughline_app", "SELECT"),
      policyCatalog(
        "domain_command_records",
        "domain_command_records_app_complete",
        "throughline_app",
        "UPDATE"
      ),
      policyCatalog(
        "domain_command_records",
        "domain_command_records_app_insert",
        "throughline_app",
        "INSERT"
      ),
      policyCatalog(
        "domain_command_records",
        "domain_command_records_app_select",
        "throughline_app",
        "SELECT"
      ),
      policyCatalog(
        "domain_command_records",
        "domain_command_records_integrity_select",
        "throughline_b1_0_integrity",
        "SELECT"
      ),
      policyCatalog(
        "product_outbox_events",
        "product_outbox_events_app_insert",
        "throughline_app",
        "INSERT"
      ),
      policyCatalog(
        "product_outbox_events",
        "product_outbox_events_app_select",
        "throughline_app",
        "SELECT"
      ),
      policyCatalog(
        "product_outbox_events",
        "product_outbox_events_product_relay_select",
        "throughline_product_relay",
        "SELECT"
      ),
      policyCatalog(
        "product_outbox_events",
        "product_outbox_events_product_relay_update",
        "throughline_product_relay",
        "UPDATE"
      )
    ]);

    const lockPolicies = await ownerPool.query<{
      policyname: string;
      permissive: string;
      cmd: string;
      with_check: string | null;
    }>(`
      SELECT policyname, permissive, cmd, with_check
      FROM pg_policies
      WHERE policyname LIKE '%_product_relay_lock_only'
         OR policyname LIKE '%_product_relay_no_write'
      ORDER BY policyname
    `);
    expect(lockPolicies.rows).toHaveLength(12);
    for (const policy of lockPolicies.rows) {
      expect(policy.cmd).toBe("UPDATE");
      expect(policy.with_check).toBe("false");
      expect(policy.permissive).toBe(
        policy.policyname.endsWith("_no_write") ? "RESTRICTIVE" : "PERMISSIVE"
      );
    }
    await expectExactPolicyCatalog();

    const appCommandUpdateColumns = await ownerPool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'throughline_app' AND table_schema = 'ops'
        AND table_name = 'domain_command_records' AND privilege_type = 'UPDATE'
      ORDER BY column_name
    `);
    expect(appCommandUpdateColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "completed_at",
      "result_resource_id",
      "result_resource_type",
      "safe_response",
      "state",
      "updated_at"
    ]);

    const appCommandInsertColumns = await ownerPool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'throughline_app' AND table_schema = 'ops'
        AND table_name = 'domain_command_records' AND privilege_type = 'INSERT'
      ORDER BY column_name
    `);
    expect(appCommandInsertColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "actor_membership_id",
      "actor_user_id",
      "agent_principal_id",
      "canonical_request_hash",
      "command_kind",
      "command_schema_version",
      "delegating_membership_id",
      "delegating_user_id",
      "id",
      "idempotency_key",
      "policy_version_id",
      "request_id",
      "reservation_space_id",
      "tenant_id",
      "traceparent",
      "tracestate",
      "workspace_id"
    ]);

    const immutableOutboxColumns = [
      "aggregate_id",
      "aggregate_type",
      "aggregate_version",
      "causation_command_id",
      "event_schema_version",
      "event_type",
      "id",
      "payload",
      "payload_schema_version",
      "policy_version_id",
      "relay_service_principal_id",
      "request_id",
      "space_id",
      "tenant_id",
      "traceparent",
      "tracestate",
      "workspace_id"
    ];
    const appOutboxColumns = await ownerPool.query<{
      column_name: string;
      privilege_type: string;
    }>(`
      SELECT privilege_type, column_name FROM information_schema.column_privileges
      WHERE grantee = 'throughline_app' AND table_schema = 'ops'
        AND table_name = 'product_outbox_events'
      ORDER BY privilege_type, column_name
    `);
    expect(appOutboxColumns.rows).toEqual(
      ["INSERT", "SELECT"].flatMap((privilege_type) =>
        immutableOutboxColumns.map((column_name) => ({ privilege_type, column_name }))
      )
    );

    const integrityColumns = await ownerPool.query<{
      column_name: string;
      privilege_type: string;
    }>(`
      SELECT privilege_type, column_name FROM information_schema.column_privileges
      WHERE grantee = 'throughline_b1_0_integrity' AND table_schema = 'ops'
        AND table_name = 'domain_command_records'
      ORDER BY privilege_type, column_name
    `);
    expect(integrityColumns.rows).toEqual(
      ["id", "state", "tenant_id", "workspace_id"].map((column_name) => ({
        privilege_type: "SELECT",
        column_name
      }))
    );

    const protectedTableGrants = await ownerPool.query<{
      grantee: string;
      privilege_type: string;
      table_name: string;
    }>(`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE table_schema = 'ops'
        AND table_name IN ('domain_command_records', 'audit_events', 'product_outbox_events')
        AND grantee IN (
          'PUBLIC', 'throughline_app', 'throughline_product_relay',
          'throughline_b1_0_integrity'
        )
      ORDER BY grantee, table_name, privilege_type
    `);
    expect(protectedTableGrants.rows).toEqual([
      { grantee: "throughline_app", table_name: "audit_events", privilege_type: "INSERT" },
      { grantee: "throughline_app", table_name: "audit_events", privilege_type: "SELECT" },
      {
        grantee: "throughline_app",
        table_name: "domain_command_records",
        privilege_type: "SELECT"
      }
    ]);

    const updateColumns = await ownerPool.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(`
      SELECT table_schema, table_name, column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'throughline_product_relay' AND privilege_type = 'UPDATE'
      ORDER BY table_schema, table_name, column_name
    `);
    expect(updateColumns.rows.filter(({ table_schema }) => table_schema !== "ops")).toEqual(
      [
        ["access", "access_relationships"],
        ["access", "spaces"],
        ["identity", "policy_versions"],
        ["identity", "service_principals"],
        ["identity", "tenants"],
        ["identity", "workspaces"]
      ].map(([table_schema, table_name]) => ({ table_schema, table_name, column_name: "id" }))
    );
    expect(
      updateColumns.rows.filter(({ table_name }) => table_name === "product_outbox_events")
    ).toEqual(
      [
        "claim_expires_at",
        "claim_token",
        "claimed_at",
        "claimed_by",
        "last_outcome_code",
        "next_attempt_at",
        "publication_attempt",
        "publication_state",
        "published_at",
        "published_message_id",
        "terminal_at"
      ].map((column_name) => ({
        table_schema: "ops",
        table_name: "product_outbox_events",
        column_name
      }))
    );

    const selectColumns = await ownerPool.query<{
      column_name: string;
      table_name: string;
      table_schema: string;
    }>(`
      SELECT table_schema, table_name, column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'throughline_product_relay' AND privilege_type = 'SELECT'
      ORDER BY table_schema, table_name, column_name
    `);
    const expectedProductRelaySelect = [
      [
        "access",
        "access_relationships",
        [
          "id",
          "relation",
          "resource_id",
          "resource_type",
          "source",
          "subject_id",
          "subject_type",
          "tenant_id",
          "workspace_id"
        ]
      ],
      ["access", "spaces", ["archived_at", "id", "tenant_id", "workspace_id"]],
      ["identity", "policy_versions", ["id", "status", "tenant_id", "workspace_id"]],
      ["identity", "service_principals", ["id", "purpose", "status", "tenant_id", "workspace_id"]],
      ["identity", "tenants", ["id", "status"]],
      ["identity", "workspaces", ["id", "status", "tenant_id"]],
      [
        "ops",
        "product_outbox_events",
        [
          "aggregate_id",
          "aggregate_type",
          "aggregate_version",
          "causation_command_id",
          "claim_expires_at",
          "claim_token",
          "claimed_at",
          "claimed_by",
          "created_at",
          "event_schema_version",
          "event_type",
          "id",
          "last_outcome_code",
          "next_attempt_at",
          "payload",
          "payload_schema_version",
          "policy_version_id",
          "publication_attempt",
          "publication_state",
          "published_at",
          "published_message_id",
          "relay_service_principal_id",
          "request_id",
          "space_id",
          "tenant_id",
          "terminal_at",
          "traceparent",
          "tracestate",
          "workspace_id"
        ]
      ]
    ] as const;
    expect(selectColumns.rows).toEqual(
      expectedProductRelaySelect.flatMap(([table_schema, table_name, columns]) =>
        columns.map((column_name) => ({ table_schema, table_name, column_name }))
      )
    );

    const protectedSchemaGrants = await ownerPool.query<{
      grantee: string;
      privilege_type: string;
      schema_name: string;
    }>(`
      SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END
               AS grantee,
             namespace.nspname AS schema_name,
             acl.privilege_type
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
      WHERE namespace.nspname IN ('identity', 'access', 'ops')
        AND (
          acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN (
            'throughline_app', 'throughline_product_relay', 'throughline_b1_0_integrity'
          )
        )
        AND acl.grantee <> namespace.nspowner
      ORDER BY grantee, schema_name, privilege_type
    `);
    expect(protectedSchemaGrants.rows).toEqual([
      { grantee: "throughline_app", schema_name: "access", privilege_type: "USAGE" },
      { grantee: "throughline_app", schema_name: "identity", privilege_type: "USAGE" },
      { grantee: "throughline_app", schema_name: "ops", privilege_type: "USAGE" },
      {
        grantee: "throughline_b1_0_integrity",
        schema_name: "ops",
        privilege_type: "USAGE"
      },
      { grantee: "throughline_product_relay", schema_name: "access", privilege_type: "USAGE" },
      {
        grantee: "throughline_product_relay",
        schema_name: "identity",
        privilege_type: "USAGE"
      },
      { grantee: "throughline_product_relay", schema_name: "ops", privilege_type: "USAGE" }
    ]);

    const isolation = await ownerPool.query<{
      foundation_relay_product: boolean;
      foundation_worker_product: boolean;
      product_foundation: boolean;
      product_insert: boolean;
      product_delete: boolean;
      product_command_insert: boolean;
      product_audit_insert: boolean;
      product_command_update: boolean;
    }>(`
      SELECT
        has_table_privilege('throughline_relay', 'ops.product_outbox_events', 'SELECT')
          AS foundation_relay_product,
        has_table_privilege('throughline_worker', 'ops.product_outbox_events', 'SELECT')
          AS foundation_worker_product,
        has_table_privilege('throughline_product_relay', 'ops.outbox_events', 'SELECT')
          AS product_foundation,
        has_table_privilege('throughline_product_relay', 'ops.product_outbox_events', 'INSERT')
          AS product_insert,
        has_table_privilege('throughline_product_relay', 'ops.product_outbox_events', 'DELETE')
          AS product_delete,
        has_table_privilege('throughline_product_relay', 'ops.domain_command_records', 'INSERT')
          AS product_command_insert,
        has_table_privilege('throughline_product_relay', 'ops.audit_events', 'INSERT')
          AS product_audit_insert,
        has_table_privilege('throughline_product_relay', 'ops.domain_command_records', 'UPDATE')
          AS product_command_update
    `);
    expect(isolation.rows[0]).toEqual({
      foundation_relay_product: false,
      foundation_worker_product: false,
      product_foundation: false,
      product_insert: false,
      product_delete: false,
      product_command_insert: false,
      product_audit_insert: false,
      product_command_update: false
    });
    await expect(ownerPool.query("SELECT 1 FROM ops.domain_events")).rejects.toMatchObject({
      code: "42P01"
    });
  }, 60_000);

  it("provisions one notification-only principal and one exact direct-manager Space grant", async () => {
    const repeated = await withOwnerTransaction(ownerPool, (tx) =>
      provisionProductRelayDirectManagerAccess(tx, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA
      })
    );
    expect(repeated).toEqual({
      id: productRelayRelationshipId,
      principalId: productRelayPrincipalId,
      created: false
    });
    const principals = await ownerPool.query<{ id: string; purpose: string; status: string }>(
      `
      SELECT id, purpose, status FROM identity.service_principals
      WHERE tenant_id = $1 AND workspace_id = $2 AND purpose = 'product_notification_relay'
    `,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    expect(principals.rows).toEqual([
      { id: productRelayPrincipalId, purpose: "product_notification_relay", status: "active" }
    ]);
    const grants = await ownerPool.query<{ resource_id: string; relation: string; source: string }>(
      `
      SELECT resource_id, relation, source FROM access.access_relationships
      WHERE subject_type = 'service_principal' AND subject_id = $1
    `,
      [productRelayPrincipalId]
    );
    expect(grants.rows).toEqual([
      { resource_id: devFixtures.restrictedSpaceA, relation: "manager", source: "direct" }
    ]);
  });

  it("fails closed with no context or a confused Foundation principal", async () => {
    await expect(
      appPool.query("SELECT count(*)::text AS count FROM ops.domain_command_records")
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      appPool.query("INSERT INTO ops.domain_command_records (id) VALUES ($1)", [ids.commandA])
    ).rejects.toBeDefined();

    const wrongPrincipalContext = productContext(devFixtures.relayServicePrincipalA);
    await expect(
      withTenantTransaction({ pool: productRelayPool, context: wrongPrincipalContext }, (tx) =>
        tx.query("SELECT id FROM ops.product_outbox_events")
      )
    ).resolves.toMatchObject({ rows: [] });
  });

  it("commits command, audit, and outbox atomically and replays exact trusted data", async () => {
    const fixture = commandFixture("A", ids.commandA, ids.aggregateA);
    const first = await executeFixture(fixture, ids.auditA, ids.eventA);
    expect(first).toMatchObject({ reservation: { status: "reserved" }, outbox: { replay: false } });

    const ownerCount = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ops.product_outbox_events WHERE id = $1",
      [ids.eventA]
    );
    expect(ownerCount.rows[0]?.count).toBe("1");
    const initial = await ownerPool.query<{
      claim_expires_at: Date | null;
      claim_token: string | null;
      claimed_at: Date | null;
      claimed_by: string | null;
      created_at: Date;
      last_outcome_code: string | null;
      next_attempt_at: Date;
      publication_attempt: number;
      publication_state: string;
      published_at: Date | null;
      published_message_id: string | null;
      terminal_at: Date | null;
    }>(
      `SELECT created_at, publication_state, publication_attempt, next_attempt_at,
              claimed_at, claimed_by, claim_token, claim_expires_at, last_outcome_code,
              published_at, published_message_id, terminal_at
       FROM ops.product_outbox_events WHERE id = $1`,
      [ids.eventA]
    );
    expect(initial.rows[0]).toEqual({
      created_at: initial.rows[0]!.created_at,
      publication_state: "pending",
      publication_attempt: 0,
      next_attempt_at: initial.rows[0]!.created_at,
      claimed_at: null,
      claimed_by: null,
      claim_token: null,
      claim_expires_at: null,
      last_outcome_code: null,
      published_at: null,
      published_message_id: null,
      terminal_at: null
    });
    await expect(
      appPool.query("SELECT id FROM ops.product_outbox_events WHERE id = $1", [ids.eventA])
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.rootSpaceB, "tenant-b-viewer") },
        (tx) => tx.query("SELECT id FROM ops.product_outbox_events WHERE id = $1", [ids.eventA])
      )
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      withTenantTransaction(
        { pool: productRelayPool, context: productContext(devFixtures.relayServicePrincipalA) },
        (tx) => tx.query("SELECT id FROM ops.product_outbox_events WHERE id = $1", [ids.eventA])
      )
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      withTenantTransaction(
        { pool: productRelayPool, context: productContext(productRelayPrincipalId) },
        (tx) => tx.query("SELECT id FROM ops.product_outbox_events WHERE id = $1", [ids.eventA])
      )
    ).resolves.toMatchObject({ rows: [{ id: ids.eventA }] });

    const replay = await withTenantTransaction(
      { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
      async (tx) => {
        const repositories = new ProductDomainTransactionRepositories(tx);
        const reservation = await repositories.commands.reserve(fixture.reservation);
        const outbox = await repositories.outbox.insertOrReplay({
          envelope: envelopeFor(fixture, ids.eventA),
          relayServicePrincipalId: productRelayPrincipalId,
          policyVersionId: DEV_POLICY_VERSION
        });
        return { reservation, outbox };
      }
    );
    expect(replay).toMatchObject({ reservation: { status: "replay" }, outbox: { replay: true } });

    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) =>
          new ProductDomainTransactionRepositories(tx).commands.reserve({
            ...fixture.reservation,
            canonicalRequestHash: hashCanonicalCommandRequest({ trusted: "different" })
          })
      )
    ).rejects.toBeInstanceOf(ProductDomainInvariantError);
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) =>
          new ProductDomainTransactionRepositories(tx).outbox.insertOrReplay({
            envelope: { ...envelopeFor(fixture, ids.eventA), requestId: "trusted-difference" },
            relayServicePrincipalId: productRelayPrincipalId,
            policyVersionId: DEV_POLICY_VERSION
          })
      )
    ).rejects.toBeInstanceOf(ProductDomainInvariantError);
  });

  it("rejects orphan and cross-scope audit/outbox causation structurally", async () => {
    const fixtureB = commandFixture("B", ids.commandB, ids.aggregateB, {
      tenantId: devFixtures.tenantB,
      workspaceId: devFixtures.workspaceB,
      spaceId: devFixtures.rootSpaceB,
      userId: devFixtures.userB,
      membershipId: devFixtures.membershipBViewer
    });
    await completeCommandOnly(fixtureB, userContext(devFixtures.rootSpaceB, "tenant-b-viewer"));

    for (const causationId of ["75000000-0000-7000-8000-000000000099", ids.commandB]) {
      await expect(
        withTenantTransaction(
          { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
          (tx) => insertRawAudit(tx, ids.auditCross, causationId, ids.aggregateA)
        )
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        withTenantTransaction(
          { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
          (tx) => insertRawOutbox(tx, ids.eventCross, causationId, ids.aggregateA)
        )
      ).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("keeps the TypeScript and PostgreSQL audit safe-detail languages identical", async () => {
    for (const vector of PRODUCT_AUDIT_DETAIL_TEST_VECTORS) {
      const result = await appPool.query<{ valid: boolean }>(
        `SELECT ops.product_audit_detail_valid($1, $2, $3, $4::uuid, $5::jsonb) AS valid`,
        [
          vector.action,
          vector.resourceType,
          vector.auditSchemaVersion,
          vector.resourceId,
          JSON.stringify(vector.safeDetail)
        ]
      );
      expect(result.rows[0]?.valid, vector.name).toBe(vector.valid);
    }
    await expect(
      appPool.query<{ valid: boolean }>(
        `SELECT ops.product_audit_detail_valid(
           'unknown.action', 'organization', 1, $1::uuid, $2::jsonb
         ) AS valid`,
        [ids.aggregateA, JSON.stringify({ organizationId: ids.aggregateA })]
      )
    ).resolves.toMatchObject({ rows: [{ valid: false }] });

    const unsafeVectors = PRODUCT_AUDIT_DETAIL_TEST_VECTORS.filter((vector) =>
      vector.name.startsWith("rejects forbidden or unknown key")
    );
    for (const [index, vector] of unsafeVectors.entries()) {
      const unsafeKey = Object.keys(vector.safeDetail as Record<string, unknown>).find(
        (key) => key !== "organizationId"
      );
      if (!unsafeKey) throw new Error("Unsafe audit vector did not contain an extra key");
      await expect(
        withTenantTransaction(
          { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
          (tx) =>
            insertRawAudit(tx, b1Uuid7(8800 + index), ids.commandA, ids.aggregateA, {
              organizationId: ids.aggregateA,
              [unsafeKey]: "must-not-persist"
            })
        )
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) => insertRawAudit(tx, b1Uuid7(8899), ids.commandA, ids.aggregateA, {})
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) =>
          insertRawAudit(tx, b1Uuid7(8898), ids.commandA, ids.aggregateA, {
            organizationId: null
          })
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps outbox lifecycle columns secret and rejects every forged initial state", async () => {
    for (const column of [
      "created_at",
      "publication_state",
      "publication_attempt",
      "next_attempt_at",
      "claimed_at",
      "claimed_by",
      "claim_token",
      "claim_expires_at",
      "last_outcome_code",
      "published_at",
      "published_message_id",
      "terminal_at"
    ] as const) {
      await expect(
        withTenantTransaction(
          { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
          (tx) =>
            tx.query(`SELECT ${column} FROM ops.product_outbox_events WHERE id = $1`, [ids.eventA])
        )
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) => tx.query("SELECT * FROM ops.product_outbox_events WHERE id = $1", [ids.eventA])
      )
    ).rejects.toMatchObject({ code: "42501" });

    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    const forgedStates: ForgedOutboxLifecycle[] = [
      forgedLifecycle("pending", 1, now),
      {
        ...forgedLifecycle("claimed", 1, now),
        claimedAt: now,
        claimedBy: "forged-relay",
        claimToken: "A".repeat(43),
        claimExpiresAt: later
      },
      {
        ...forgedLifecycle("retry_wait", 1, later),
        lastOutcomeCode: "forged_retry"
      },
      {
        ...forgedLifecycle("published", 1, now),
        publishedAt: now,
        publishedMessageId: "forged-message"
      },
      {
        ...forgedLifecycle("terminal_failed", 6, now),
        lastOutcomeCode: "forged_terminal",
        terminalAt: now
      },
      {
        ...forgedLifecycle("terminal_unconfirmed", 6, now),
        lastOutcomeCode: "forged_terminal",
        terminalAt: now
      }
    ];

    for (const [index, lifecycle] of forgedStates.entries()) {
      const appStatement = forgedOutboxStatement(
        b1Uuid7(8100 + index),
        b1Uuid7(8200 + index),
        lifecycle,
        productRelayPrincipalId
      );
      await expect(
        withTenantTransaction(
          { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
          (tx) => tx.query(appStatement.text, appStatement.values)
        )
      ).rejects.toMatchObject({ code: "42501" });

      const ownerStatement = forgedOutboxStatement(
        b1Uuid7(8300 + index),
        b1Uuid7(8400 + index),
        lifecycle,
        productRelayPrincipalId
      );
      await expect(
        ownerPool.query(ownerStatement.text, [...ownerStatement.values])
      ).rejects.toThrow(/must be inserted in pending state/);
    }

    for (const [claimToken, claimExpiry] of [
      [null, new Date(Date.now() + 60_000)],
      ["A".repeat(43), null]
    ] as const) {
      await expect(
        withTenantTransaction(
          { pool: productRelayPool, context: productContext(productRelayPrincipalId) },
          (tx) =>
            tx.query(
              `UPDATE ops.product_outbox_events
               SET publication_state = 'claimed', publication_attempt = 1,
                   claimed_at = clock_timestamp(), claimed_by = 'forged-relay',
                   claim_token = $2, claim_expires_at = $3
               WHERE id = $1`,
              [ids.eventA, claimToken, claimExpiry]
            )
        )
      ).rejects.toThrow(/invalid product outbox claim transition/);
    }
    await expect(
      ownerPool.query(
        `SELECT publication_state, publication_attempt
         FROM ops.product_outbox_events WHERE id = $1`,
        [ids.eventA]
      )
    ).resolves.toMatchObject({
      rows: [{ publication_state: "pending", publication_attempt: 0 }]
    });
  });

  it("rejects owner/app audit mutation and command reopen/reset/delete", async () => {
    await expect(
      ownerPool.query("UPDATE ops.audit_events SET request_id = 'owner-change' WHERE id = $1", [
        ids.auditA
      ])
    ).rejects.toThrow(/append-only/);
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) =>
          tx.query("UPDATE ops.audit_events SET request_id = request_id WHERE id = $1", [
            ids.auditA
          ])
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) => tx.query("DELETE FROM ops.audit_events WHERE id = $1", [ids.auditA])
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      ownerPool.query(
        "UPDATE ops.product_outbox_events SET payload = payload || '{\"extra\":true}'::jsonb WHERE id = $1",
        [ids.eventA]
      )
    ).rejects.toThrow(/envelope identity is immutable/);
    await expect(
      ownerPool.query("UPDATE ops.domain_command_records SET state = 'reserved' WHERE id = $1", [
        ids.commandA
      ])
    ).rejects.toThrow(/reserved-to-completed/);
    await expect(
      ownerPool.query("DELETE FROM ops.domain_command_records WHERE id = $1", [ids.commandA])
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("rejects direct completed command inserts for both application and catalog owners", async () => {
    const appStatement = completedCommandInsertStatement(b1Uuid7(8501), "direct-app-completed");
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) => tx.query(appStatement.text, appStatement.values)
      )
    ).rejects.toMatchObject({ code: "42501" });

    const ownerStatement = completedCommandInsertStatement(b1Uuid7(8502), "direct-owner-completed");
    await expect(ownerPool.query(ownerStatement.text, [...ownerStatement.values])).rejects.toThrow(
      /must be inserted in reserved state/
    );
  });

  it("rejects a committed reserved command and wrong-Space application writes", async () => {
    const reserved = commandFixture("reserved", ids.commandReserved, ids.aggregateConcurrent);
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) => new ProductDomainTransactionRepositories(tx).commands.reserve(reserved.reservation)
      )
    ).rejects.toThrow(/reservation must complete before commit/);
    const absent = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ops.domain_command_records WHERE id = $1",
      [ids.commandReserved]
    );
    expect(absent.rows[0]?.count).toBe("0");

    const wrongSpace = commandFixture(
      "wrong-space",
      ids.commandWrongSpace,
      ids.aggregateConcurrent
    );
    wrongSpace.reservation.reservationSpaceId = devFixtures.rootSpaceA;
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        (tx) =>
          new ProductDomainTransactionRepositories(tx).commands.reserve(wrongSpace.reservation)
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot hide a committed reservation by changing, clearing, or omitting transaction context", async () => {
    const contextMutations: Array<(tx: TenantDbTransaction) => Promise<unknown>> = [
      (tx) => tx.query("SELECT set_config('app.space_id', $1, true)", [devFixtures.rootSpaceA]),
      (tx) => tx.query("RESET app.space_id"),
      async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [devFixtures.tenantB]);
        await tx.query("SELECT set_config('app.workspace_id', $1, true)", [devFixtures.workspaceB]);
        return tx.query("SELECT set_config('app.space_id', $1, true)", [devFixtures.rootSpaceB]);
      },
      (tx) => tx.query("SELECT set_config('app.space_id', '', true)"),
      (tx) => tx.query("RESET ALL")
    ];

    for (const [index, mutateContext] of contextMutations.entries()) {
      const commandId = b1Uuid7(8600 + index);
      const fixture = commandFixture(`context-${index}`, commandId, b1Uuid7(8700 + index));
      await expect(
        withTenantTransaction(
          { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
          async (tx) => {
            await new ProductDomainTransactionRepositories(tx).commands.reserve(
              fixture.reservation
            );
            await mutateContext(tx);
          }
        )
      ).rejects.toThrow(/reservation must complete before commit/);
      const absent = await ownerPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ops.domain_command_records WHERE id = $1",
        [commandId]
      );
      expect(absent.rows[0]?.count).toBe("0");
    }

    const completed = commandFixture("context-completed", b1Uuid7(8680), b1Uuid7(8780));
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        async (tx) => {
          const commands = new ProductDomainTransactionRepositories(tx).commands;
          await commands.reserve(completed.reservation);
          await commands.complete(completionFor(completed));
          await tx.query("RESET ALL");
        }
      )
    ).resolves.toBeUndefined();
    const completedRow = await ownerPool.query<{ state: string }>(
      "SELECT state FROM ops.domain_command_records WHERE id = $1",
      [completed.reservation.id]
    );
    expect(completedRow.rows).toEqual([{ state: "completed" }]);
  });

  it("reuses one pooled application connection without leaking scope between transactions", async () => {
    const pooledApp = new pg.Pool({ connectionString: appUrl, max: 1 });
    const fixture = commandFixture("pooled-context", b1Uuid7(8690), b1Uuid7(8790));
    try {
      const tenantB = await withTenantTransaction(
        {
          pool: pooledApp,
          context: userContext(devFixtures.rootSpaceB, "tenant-b-viewer")
        },
        (tx) =>
          tx.query<{ command_count: string; pid: number; tenant_id: string }>(
            `SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id') AS tenant_id,
                    (SELECT count(*)::text FROM ops.domain_command_records WHERE id = $1)
                      AS command_count`,
            [ids.commandA]
          )
      );
      expect(tenantB.rows[0]).toMatchObject({
        tenant_id: devFixtures.tenantB,
        command_count: "0"
      });

      const tenantA = await withTenantTransaction(
        { pool: pooledApp, context: userContext(devFixtures.restrictedSpaceA) },
        async (tx) => {
          const commands = new ProductDomainTransactionRepositories(tx).commands;
          await commands.reserve(fixture.reservation);
          await commands.complete(completionFor(fixture));
          return tx.query<{ pid: number; tenant_id: string }>(
            "SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id') AS tenant_id"
          );
        }
      );
      expect(tenantA.rows[0]).toMatchObject({ tenant_id: devFixtures.tenantA });
      expect(tenantA.rows[0]?.pid).toBe(tenantB.rows[0]?.pid);

      const tenantBAgain = await withTenantTransaction(
        {
          pool: pooledApp,
          context: userContext(devFixtures.rootSpaceB, "tenant-b-viewer")
        },
        (tx) =>
          tx.query<{ command_count: string; pid: number }>(
            `SELECT pg_backend_pid() AS pid,
                    (SELECT count(*)::text FROM ops.domain_command_records WHERE id = $1)
                      AS command_count`,
            [fixture.reservation.id]
          )
      );
      expect(tenantBAgain.rows[0]).toEqual({
        pid: tenantB.rows[0]!.pid,
        command_count: "0"
      });

      const outsideTransaction = await pooledApp.query<{
        command_count: string;
        tenant_id: string | null;
      }>(
        `SELECT current_setting('app.tenant_id', true) AS tenant_id,
                (SELECT count(*)::text FROM ops.domain_command_records) AS command_count`
      );
      expect(["", null]).toContain(outsideTransaction.rows[0]?.tenant_id ?? null);
      expect(outsideTransaction.rows[0]?.command_count).toBe("0");
    } finally {
      await pooledApp.end();
    }
  });

  it("rolls back the entire fixed repository composition", async () => {
    const fixture = commandFixture("rollback", ids.commandRollback, ids.aggregateRollback);
    await expect(
      withTenantTransaction(
        { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
        async (tx) => {
          const repositories = new ProductDomainTransactionRepositories(tx);
          await repositories.commands.reserve(fixture.reservation);
          await repositories.audit.insert(auditFor(fixture, ids.auditRollback));
          await repositories.outbox.insertOrReplay({
            envelope: envelopeFor(fixture, ids.eventRollback),
            relayServicePrincipalId: productRelayPrincipalId,
            policyVersionId: DEV_POLICY_VERSION
          });
          throw new Error("fixture rollback");
        }
      )
    ).rejects.toThrow("fixture rollback");
    const counts = await ownerPool.query<{ commands: string; audits: string; outbox: string }>(
      `
      SELECT
        (SELECT count(*)::text FROM ops.domain_command_records WHERE id = $1) AS commands,
        (SELECT count(*)::text FROM ops.audit_events WHERE id = $2) AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events WHERE id = $3) AS outbox
    `,
      [ids.commandRollback, ids.auditRollback, ids.eventRollback]
    );
    expect(counts.rows[0]).toEqual({ commands: "0", audits: "0", outbox: "0" });
  });

  it("serializes concurrent reservation and yields one completed replay", async () => {
    const fixture = commandFixture("concurrent", ids.commandConcurrent, ids.aggregateConcurrent);
    let releaseFirst!: () => void;
    let markReserved!: () => void;
    const released = new Promise<void>((resolve) => (releaseFirst = resolve));
    const reserved = new Promise<void>((resolve) => (markReserved = resolve));

    const first = withTenantTransaction(
      { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
      async (tx) => {
        const repository = new ProductDomainTransactionRepositories(tx).commands;
        const result = await repository.reserve(fixture.reservation);
        markReserved();
        await released;
        await repository.complete(completionFor(fixture));
        return result;
      }
    );
    await reserved;
    let secondSettled = false;
    const second = withTenantTransaction(
      { pool: appPool, context: userContext(devFixtures.restrictedSpaceA) },
      (tx) => new ProductDomainTransactionRepositories(tx).commands.reserve(fixture.reservation)
    ).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondSettled).toBe(false);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "reserved" });
    await expect(second).resolves.toMatchObject({ status: "replay" });
  });

  function commandFixture(
    suffix: string,
    commandId: string,
    aggregateId: string,
    scope: {
      tenantId: string;
      workspaceId: string;
      spaceId: string;
      userId: string;
      membershipId: string;
    } = {
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.restrictedSpaceA,
      userId: devFixtures.userA,
      membershipId: devFixtures.membershipAOwner
    }
  ) {
    const canonicalRequestHash = hashCanonicalCommandRequest({ suffix, aggregateId });
    const reservation: DomainCommandReservationInput = {
      id: commandId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      reservationSpaceId: scope.spaceId,
      commandKind: "b1_0.fixture.v1",
      commandSchemaVersion: 1,
      idempotencyKey: `fixture-${suffix}`,
      canonicalRequestHash,
      actorUserId: scope.userId,
      actorMembershipId: scope.membershipId,
      policyVersionId: DEV_POLICY_VERSION,
      requestId: `request-${suffix}`,
      traceparent
    };
    return { suffix, aggregateId, reservation };
  }

  async function executeFixture(
    fixture: ReturnType<typeof commandFixture>,
    auditId: string,
    eventId: string
  ) {
    return withTenantTransaction(
      { pool: appPool, context: userContext(fixture.reservation.reservationSpaceId) },
      async (tx) => {
        const repositories = new ProductDomainTransactionRepositories(tx);
        const reservation = await repositories.commands.reserve(fixture.reservation);
        await repositories.audit.insert(auditFor(fixture, auditId));
        const outbox = await repositories.outbox.insertOrReplay({
          envelope: envelopeFor(fixture, eventId),
          relayServicePrincipalId: productRelayPrincipalId,
          policyVersionId: DEV_POLICY_VERSION
        });
        await repositories.commands.complete(completionFor(fixture));
        return { reservation, outbox };
      }
    );
  }

  async function completeCommandOnly(
    fixture: ReturnType<typeof commandFixture>,
    context: SecurityContext
  ): Promise<void> {
    await withTenantTransaction({ pool: appPool, context }, async (tx) => {
      const commands = new ProductDomainTransactionRepositories(tx).commands;
      await commands.reserve(fixture.reservation);
      await commands.complete(completionFor(fixture));
    });
  }

  function completionFor(fixture: ReturnType<typeof commandFixture>) {
    return {
      commandId: fixture.reservation.id,
      tenantId: fixture.reservation.tenantId,
      workspaceId: fixture.reservation.workspaceId,
      reservationSpaceId: fixture.reservation.reservationSpaceId,
      commandKind: fixture.reservation.commandKind,
      idempotencyKey: fixture.reservation.idempotencyKey,
      canonicalRequestHash: fixture.reservation.canonicalRequestHash,
      resultResourceType: "organization",
      resultResourceId: fixture.aggregateId,
      safeResponse: { organizationId: fixture.aggregateId }
    };
  }

  function auditFor(fixture: ReturnType<typeof commandFixture>, auditId: string) {
    return {
      id: auditId,
      tenantId: fixture.reservation.tenantId,
      workspaceId: fixture.reservation.workspaceId,
      spaceId: fixture.reservation.reservationSpaceId,
      causationCommandId: fixture.reservation.id,
      action: "organization.create" as const,
      resourceType: "organization" as const,
      resourceId: fixture.aggregateId,
      actorUserId: fixture.reservation.actorUserId,
      actorMembershipId: fixture.reservation.actorMembershipId,
      policyVersionId: DEV_POLICY_VERSION,
      requestId: fixture.reservation.requestId,
      traceparent,
      auditSchemaVersion: 1 as const,
      safeDetail: { organizationId: fixture.aggregateId }
    };
  }

  function envelopeFor(
    fixture: ReturnType<typeof commandFixture>,
    eventId: string
  ): DomainNotificationEnvelope {
    return {
      eventId,
      eventType: "organization.created",
      eventSchemaVersion: 1,
      payloadSchemaVersion: 1,
      tenantId: fixture.reservation.tenantId,
      workspaceId: fixture.reservation.workspaceId,
      spaceId: fixture.reservation.reservationSpaceId,
      aggregateType: "organization",
      aggregateId: fixture.aggregateId,
      aggregateVersion: 1,
      causationCommandId: fixture.reservation.id,
      payload: { organizationId: fixture.aggregateId },
      requestId: fixture.reservation.requestId,
      traceparent
    };
  }

  async function insertRawAudit(
    tx: TenantDbTransaction,
    auditId: string,
    causationCommandId: string,
    resourceId: string,
    safeDetail: unknown = { organizationId: resourceId }
  ) {
    return tx.query(
      `INSERT INTO ops.audit_events (
         id, tenant_id, workspace_id, space_id, causation_command_id,
         action, resource_type, resource_id, actor_user_id, actor_membership_id,
         policy_version_id, request_id, traceparent, audit_schema_version, safe_detail
       ) VALUES (
         $1, $2, $3, $4, $5,
         'organization.create', 'organization', $6, $7, $8,
         $9, 'cross-scope', $10, 1, $11::jsonb
       )`,
      [
        auditId,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.restrictedSpaceA,
        causationCommandId,
        resourceId,
        devFixtures.userA,
        devFixtures.membershipAOwner,
        DEV_POLICY_VERSION,
        traceparent,
        JSON.stringify(safeDetail)
      ]
    );
  }

  async function insertRawOutbox(
    tx: TenantDbTransaction,
    eventId: string,
    causationCommandId: string,
    aggregateId: string
  ) {
    return tx.query(
      `INSERT INTO ops.product_outbox_events (
         id, tenant_id, workspace_id, space_id, relay_service_principal_id, policy_version_id,
         event_type, event_schema_version, payload_schema_version, aggregate_type, aggregate_id,
         aggregate_version, causation_command_id, payload, request_id, traceparent
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         'organization.created', 1, 1, 'organization', $7,
         1, $8, $9::jsonb, 'cross-scope', $10
       )`,
      [
        eventId,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.restrictedSpaceA,
        productRelayPrincipalId,
        DEV_POLICY_VERSION,
        aggregateId,
        causationCommandId,
        JSON.stringify({ organizationId: aggregateId }),
        traceparent
      ]
    );
  }
});

function userContext(
  spaceId: string,
  identity: "tenant-a-owner" | "tenant-b-viewer" = "tenant-a-owner"
): SecurityContext {
  return { ...createDevSecurityContext(identity), requestedSpaceIds: [spaceId] };
}

function productContext(servicePrincipalId: string): SecurityContext {
  const now = new Date();
  return {
    requestId: "b1-0-product-test",
    traceId: "b1-0-product-test",
    tenantId: devFixtures.tenantA,
    workspaceId: devFixtures.workspaceA,
    servicePrincipalId,
    requestedSpaceIds: [devFixtures.restrictedSpaceA],
    membershipIds: [],
    roleHints: [],
    dataClassCeiling: "confidential",
    policyVersion: DEV_POLICY_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString()
  };
}

async function withOwnerTransaction<T>(
  pool: pg.Pool,
  operation: (tx: TenantDbTransaction) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx: TenantDbTransaction = {
      client,
      query: (text, values) => client.query(text, values ? [...values] : undefined)
    };
    const result = await operation(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertDistinctUrls(...values: string[]): void {
  if (new Set(values.map((value) => new URL(value).href)).size !== values.length) {
    throw new Error("B1.0 PostgreSQL role URLs must be distinct");
  }
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function functionCatalog(name: string, executeAcl: string[], securityDefiner = false) {
  return {
    name,
    owner_name: "throughline_b1_0_integrity",
    proconfig: ["search_path=pg_catalog"],
    security_definer: securityDefiner,
    execute_acl: executeAcl
  };
}

function triggerCatalog(
  name: string,
  tableName: string,
  functionName: string,
  triggerType: number,
  constraint = false
) {
  return {
    name,
    table_name: tableName,
    function_name: functionName,
    trigger_type: triggerType,
    is_constraint: constraint,
    deferrable: constraint,
    initially_deferred: constraint,
    enabled: "O"
  };
}

function policyCatalog(tableName: string, policyName: string, role: string, command: string) {
  return {
    tablename: tableName,
    policyname: policyName,
    permissive: "PERMISSIVE",
    roles: [role],
    cmd: command
  };
}

interface ForgedOutboxLifecycle {
  publicationState:
    | "pending"
    | "claimed"
    | "retry_wait"
    | "published"
    | "terminal_failed"
    | "terminal_unconfirmed";
  publicationAttempt: number;
  nextAttemptAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  lastOutcomeCode: string | null;
  publishedAt: Date | null;
  publishedMessageId: string | null;
  terminalAt: Date | null;
}

function forgedLifecycle(
  publicationState: ForgedOutboxLifecycle["publicationState"],
  publicationAttempt: number,
  nextAttemptAt: Date
): ForgedOutboxLifecycle {
  return {
    publicationState,
    publicationAttempt,
    nextAttemptAt,
    claimedAt: null,
    claimedBy: null,
    claimToken: null,
    claimExpiresAt: null,
    lastOutcomeCode: null,
    publishedAt: null,
    publishedMessageId: null,
    terminalAt: null
  };
}

function forgedOutboxStatement(
  eventId: string,
  aggregateId: string,
  lifecycle: ForgedOutboxLifecycle,
  relayServicePrincipalId: string
): { text: string; values: readonly unknown[] } {
  return {
    text: `INSERT INTO ops.product_outbox_events (
             id, tenant_id, workspace_id, space_id, relay_service_principal_id, policy_version_id,
             event_type, event_schema_version, payload_schema_version, aggregate_type, aggregate_id,
             aggregate_version, causation_command_id, payload, request_id, traceparent,
             publication_state, publication_attempt, next_attempt_at,
             claimed_at, claimed_by, claim_token, claim_expires_at, last_outcome_code,
             published_at, published_message_id, terminal_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             'organization.created', 1, 1, 'organization', $7,
             1, $8, $9::jsonb, $10, $11,
             $12, $13, $14,
             $15, $16, $17, $18, $19,
             $20, $21, $22
           )`,
    values: [
      eventId,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      relayServicePrincipalId,
      DEV_POLICY_VERSION,
      aggregateId,
      ids.commandA,
      JSON.stringify({ organizationId: aggregateId }),
      `forged-${eventId}`,
      traceparent,
      lifecycle.publicationState,
      lifecycle.publicationAttempt,
      lifecycle.nextAttemptAt,
      lifecycle.claimedAt,
      lifecycle.claimedBy,
      lifecycle.claimToken,
      lifecycle.claimExpiresAt,
      lifecycle.lastOutcomeCode,
      lifecycle.publishedAt,
      lifecycle.publishedMessageId,
      lifecycle.terminalAt
    ]
  };
}

function completedCommandInsertStatement(
  commandId: string,
  idempotencyKey: string
): { text: string; values: readonly unknown[] } {
  const resultId = b1Uuid7(8999);
  return {
    text: `INSERT INTO ops.domain_command_records (
             id, tenant_id, workspace_id, reservation_space_id, command_kind,
             command_schema_version, idempotency_key, canonical_request_hash,
             actor_user_id, actor_membership_id, delegating_user_id, delegating_membership_id,
             agent_principal_id, policy_version_id, request_id, traceparent, tracestate,
             state, result_resource_type, result_resource_id, safe_response, completed_at
           ) VALUES (
             $1, $2, $3, $4, 'b1_0.fixture.v1',
             1, $5, $6,
             $7, $8, NULL, NULL,
             NULL, $9, $10, $11, NULL,
             'completed', 'organization', $12, $13::jsonb, $14
           )`,
    values: [
      commandId,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      idempotencyKey,
      hashCanonicalCommandRequest({ idempotencyKey }),
      devFixtures.userA,
      devFixtures.membershipAOwner,
      DEV_POLICY_VERSION,
      `request-${idempotencyKey}`,
      traceparent,
      resultId,
      JSON.stringify({ organizationId: resultId }),
      new Date()
    ]
  };
}

function b1Uuid7(sequence: number): string {
  return `79000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}
