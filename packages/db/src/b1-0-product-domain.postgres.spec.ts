import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DomainNotificationEnvelope, SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext, devFixtures, DEV_POLICY_VERSION } from "@throughline/tenancy";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, type MigrationRunResult } from "./migrations.js";
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
      () =>
        ownerPool.query(
          "DROP INDEX IF EXISTS identity.service_principals_product_notification_relay_unique"
        ),
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
          BEFORE UPDATE OR DELETE ON ops.domain_command_records
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

    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [migrationId],
      skipped: migrationIds.slice(0, 2)
    });
    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestProductRelayRole(ownerPool, productRelayUrl!);
  });

  it("installs exact forced-RLS catalogs, immediate causation FKs, policies, and grants", async () => {
    const tables = await ownerPool.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relation.relname AS table_name, relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops'
        AND relation.relname IN ('domain_command_records', 'audit_events', 'product_outbox_events')
      ORDER BY relation.relname
    `);
    expect(tables.rows).toEqual(
      ["audit_events", "domain_command_records", "product_outbox_events"].map((table_name) => ({
        table_name,
        relrowsecurity: true,
        relforcerowsecurity: true
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

    const triggers = await ownerPool.query<{ name: string }>(`
      SELECT tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN (
        'domain_command_records_transition_guard',
        'domain_command_records_no_committed_reserved',
        'audit_events_append_only_guard',
        'product_outbox_events_transition_guard',
        'product_outbox_events_relay_binding_guard'
      ) ORDER BY tgname
    `);
    expect(triggers.rows.map(({ name }) => name)).toEqual([
      "audit_events_append_only_guard",
      "domain_command_records_no_committed_reserved",
      "domain_command_records_transition_guard",
      "product_outbox_events_relay_binding_guard",
      "product_outbox_events_transition_guard"
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
  });

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
      auditSchemaVersion: 1,
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
    resourceId: string
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
        JSON.stringify({ organizationId: resourceId })
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
