import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createAsyncContextReferenceCodec,
  devFixtures,
  DEV_POLICY_VERSION
} from "@throughline/tenancy";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { provisionTestAppRole, provisionTestFoundationRoles } from "./test-database.js";
import { bootstrapWorkerContextReference } from "./worker-bootstrap.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const relayUrl = process.env.TEST_RELAY_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const maybeDescribe =
  ownerUrl && appUrl && relayUrl && workerUrl ? describe.sequential : describe.skip;

const migrationIds = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql"
];

const ids = {
  aggregateA: "70000000-0000-7000-8000-000000000001",
  aggregateB: "70000000-0000-7000-8000-000000000002",
  eventA: "70000000-0000-7000-8000-000000000011",
  eventB: "70000000-0000-7000-8000-000000000012",
  jobA: "70000000-0000-7000-8000-000000000021",
  jobB: "70000000-0000-7000-8000-000000000022",
  referenceA: "70000000-0000-7000-8000-000000000031",
  referenceB: "70000000-0000-7000-8000-000000000032",
  relayA: "70000000-0000-7000-8000-000000000041",
  relayB: "70000000-0000-7000-8000-000000000042",
  workerA: "70000000-0000-7000-8000-000000000051",
  workerB: "70000000-0000-7000-8000-000000000052",
  delegatorUserA: "70000000-0000-7000-8000-000000000081",
  delegatorPersonA: "70000000-0000-7000-8000-000000000082",
  delegatorMembershipA: "70000000-0000-7000-8000-000000000083",
  delegatorGrantA: "70000000-0000-7000-8000-000000000084"
} as const;

const bootstrapSigningKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const contextCredentialMarker = `request-${ids.jobA}`;
const fixedHandlerKey = "foundation.worker.consume.v1";
const fixedEffectHash = createHash("sha256")
  .update("foundation-worker-effect:aggregate-a:version-1-to-2")
  .digest("hex");

const relayAuthorityContracts = [
  {
    schema: "identity",
    table: "tenants",
    policyStem: "tenants",
    using:
      "current_user = 'throughline_relay' AND id = ops.current_tenant_id() AND status = 'active'"
  },
  {
    schema: "identity",
    table: "workspaces",
    policyStem: "workspaces",
    using:
      "current_user = 'throughline_relay' AND tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id() AND status = 'active'"
  },
  {
    schema: "identity",
    table: "policy_versions",
    policyStem: "policy_versions",
    using:
      "current_user = 'throughline_relay' AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id() AND id = ops.current_policy_version() AND status = 'active'"
  },
  {
    schema: "identity",
    table: "service_principals",
    policyStem: "service_principals",
    using:
      "current_user = 'throughline_relay' AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id() AND id = ops.current_service_principal_id() AND purpose = 'system' AND status = 'active'"
  },
  {
    schema: "access",
    table: "spaces",
    policyStem: "spaces",
    using:
      "current_user = 'throughline_relay' AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id() AND id = ops.current_space_id() AND archived_at IS NULL"
  },
  {
    schema: "access",
    table: "access_relationships",
    policyStem: "access_relationships",
    using:
      "current_user = 'throughline_relay' AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id() AND resource_type = 'space' AND resource_id = ops.current_space_id() AND subject_type = 'service_principal' AND subject_id = ops.current_service_principal_id() AND relation = 'manager' AND source = 'direct'"
  }
] as const;

maybeDescribe("Foundation operational schema security", () => {
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  const relayPool = new pg.Pool({ connectionString: relayUrl });
  const workerPool = new pg.Pool({ connectionString: workerUrl });

  beforeAll(async () => {
    assertDistinctRuntimeDsns(ownerUrl!, appUrl!, relayUrl!, workerUrl!);
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestFoundationRoles(ownerPool, relayUrl!, workerUrl!);
    await seedWaveA2DeterministicData(ownerPool);
    await seedFoundationRows(ownerPool);
  });

  afterAll(async () => {
    await workerPool.end();
    await relayPool.end();
    await appPool.end();
    await ownerPool.end();
  });

  it("applies 0001 then 0002, repeats unchanged migrations, and records true checksums", async () => {
    const journal = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    );

    expect(journal.rows.map(({ id }) => id)).toEqual(migrationIds);
    for (const row of journal.rows) {
      const sql = await readFile(new URL(`../migrations/${row.id}`, import.meta.url), "utf8");
      expect(row.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
    }
    await expect(applyMigrations(ownerPool)).resolves.toEqual({
      applied: [],
      skipped: migrationIds
    });
  });

  it("resets deterministically to NOLOGIN NOBYPASSRLS roles before disposable test provisioning", async () => {
    await applyMigrations(ownerPool, { reset: true });
    const roles = await ownerPool.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      password_is_null: boolean;
    }>(`
      SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole,
             rolinherit, rolreplication,
             rolpassword IS NULL AS password_is_null
      FROM pg_authid
      WHERE rolname IN ('throughline_relay', 'throughline_worker')
      ORDER BY rolname
    `);
    expect(roles.rows).toEqual([
      {
        rolname: "throughline_relay",
        rolcanlogin: false,
        rolbypassrls: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        password_is_null: true
      },
      {
        rolname: "throughline_worker",
        rolcanlogin: false,
        rolbypassrls: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        password_is_null: true
      }
    ]);

    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestFoundationRoles(ownerPool, relayUrl!, workerUrl!);
    await seedWaveA2DeterministicData(ownerPool);
    await seedFoundationRows(ownerPool);
  });

  it("connects runtime pools only as their disposable least-privilege roles", async () => {
    for (const [pool, expectedUser] of [
      [relayPool, "throughline_relay"],
      [workerPool, "throughline_worker"]
    ] as const) {
      const identity = await pool.query<{
        current_user: string;
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(`
        SELECT current_user, rolbypassrls, rolsuper
        FROM pg_roles
        WHERE rolname = current_user
      `);
      expect(identity.rows[0]).toEqual({
        current_user: expectedUser,
        rolbypassrls: false,
        rolsuper: false
      });
    }

    const elevatedMemberships = await ownerPool.query<{ member_name: string }>(`
      SELECT member.rolname AS member_name
      FROM pg_auth_members AS membership
      JOIN pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname IN ('throughline_relay', 'throughline_worker')
    `);
    const ownedRelations = await ownerPool.query<{ owner_name: string }>(`
      SELECT DISTINCT pg_get_userbyid(relation.relowner) AS owner_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('identity', 'access', 'ops')
        AND pg_get_userbyid(relation.relowner) IN ('throughline_relay', 'throughline_worker')
    `);
    expect(elevatedMemberships.rows).toEqual([]);
    expect(ownedRelations.rows).toEqual([]);
  });

  it("enables and forces RLS on all four operational tables", async () => {
    const result = await ownerPool.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relation.relname AS table_name, relation.relrowsecurity, relation.relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops'
        AND relation.relname IN (
          'foundation_test_aggregates', 'outbox_events',
          'security_context_references', 'idempotency_records'
        )
      ORDER BY relation.relname
    `);
    expect(result.rows).toEqual(
      [
        "foundation_test_aggregates",
        "idempotency_records",
        "outbox_events",
        "security_context_references"
      ].map((table_name) => ({ table_name, relrowsecurity: true, relforcerowsecurity: true }))
    );
  });

  it("declares the required exact-scope and idempotency unique keys", async () => {
    const definitions = await ownerPool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'ops.foundation_test_aggregates'::regclass,
        'ops.outbox_events'::regclass,
        'ops.security_context_references'::regclass,
        'ops.idempotency_records'::regclass
      )
      ORDER BY conname
    `);
    const joined = definitions.rows.map(({ definition }) => definition).join("\n");
    expect(joined).toContain("UNIQUE (tenant_id, workspace_id, space_id, id)");
    expect(joined).toContain("UNIQUE (tenant_id, workspace_id, space_id, job_id)");
    expect(joined).toContain("UNIQUE (tenant_id, workspace_id, space_id, job_id, handler_key)");
    expect(joined).toContain(
      "FOREIGN KEY (context_reference_id, job_id, tenant_id, workspace_id, space_id)"
    );
  });

  it("shows no operational rows to the app role without transaction-local scope", async () => {
    const counts = await appPool.query<{ relation_name: string; row_count: number }>(`
      SELECT 'foundation_test_aggregates' AS relation_name, count(*)::integer AS row_count
      FROM ops.foundation_test_aggregates
      UNION ALL SELECT 'outbox_events', count(*)::integer FROM ops.outbox_events
      UNION ALL SELECT 'security_context_references', count(*)::integer FROM ops.security_context_references
      UNION ALL SELECT 'idempotency_records', count(*)::integer FROM ops.idempotency_records
      ORDER BY relation_name
    `);
    expect(counts.rows).toEqual(
      [
        "foundation_test_aggregates",
        "idempotency_records",
        "outbox_events",
        "security_context_references"
      ].map((relation_name) => ({ relation_name, row_count: 0 }))
    );
  });

  it("denies app writes to every operational table across tenant/workspace/Space scope", async () => {
    const crossScope = [devFixtures.tenantB, devFixtures.workspaceB, devFixtures.rootSpaceB];
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.foundation_test_aggregates
         (id, tenant_id, workspace_id, space_id, proof_key)
       VALUES ($1, $2, $3, $4, 'cross-scope-denied')`,
      [crypto.randomUUID(), ...crossScope]
    );
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.security_context_references
         (id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
          delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
          issued_at, expires_at, signing_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}',
               clock_timestamp(), clock_timestamp() + interval '10 minutes', 'test-key')`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        ...crossScope,
        ids.workerB,
        devFixtures.userB,
        devFixtures.membershipBViewer,
        DEV_POLICY_VERSION
      ]
    );
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.outbox_events
         (id, event_type, tenant_id, workspace_id, space_id, aggregate_type, aggregate_id,
          aggregate_version, causation_id, request_id, traceparent, job_id,
          relay_service_principal_id, context_reference_id, signed_context_reference)
       VALUES ($1, 'foundation.proof.requested', $2, $3, $4, 'foundation_test_aggregate',
               $5, 1, $6, 'cross-scope', '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
               $6, $7, $8, 'opaque-test-token')`,
      [crypto.randomUUID(), ...crossScope, ids.aggregateB, ids.jobB, ids.relayB, ids.referenceB]
    );
    await expectAppInsertDenied(
      appPool,
      `INSERT INTO ops.idempotency_records
         (id, tenant_id, workspace_id, space_id, job_id, handler_key, context_reference_id,
          aggregate_id, aggregate_version, effect_hash)
       VALUES ($1, $2, $3, $4, $5, 'cross-scope', $6, $7, 1, $8)`,
      [crypto.randomUUID(), ...crossScope, ids.jobB, ids.referenceB, ids.aggregateB, "0".repeat(64)]
    );
  });

  it("binds relay visibility to one exact scope and relay service principal", async () => {
    expect(await scopedRelayEventIds(relayPool, {})).toEqual([]);
    expect(
      await scopedRelayEventIds(relayPool, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        servicePrincipalId: ids.relayA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([ids.eventA]);
    expect(
      await scopedRelayEventIds(relayPool, {
        tenantId: devFixtures.tenantB,
        workspaceId: devFixtures.workspaceB,
        spaceId: devFixtures.rootSpaceB,
        servicePrincipalId: ids.relayA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([]);
  });

  it("gives relay exact column grants and prevents immutable event mutation", async () => {
    const privileges = await ownerPool.query<{ privilege_type: string; column_name: string }>(`
      SELECT privilege_type, column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'throughline_relay'
        AND table_schema = 'ops'
        AND table_name = 'outbox_events'
      ORDER BY privilege_type, column_name
    `);
    expect(
      privileges.rows
        .filter(({ privilege_type }) => privilege_type === "UPDATE")
        .map(({ column_name }) => column_name)
    ).toEqual([
      "claim_expires_at",
      "claim_token",
      "claimed_at",
      "claimed_by",
      "last_retry_code",
      "next_attempt_at",
      "publication_attempts",
      "published_at",
      "published_message_id",
      "terminal_failed_at",
      "terminal_failure_code"
    ]);
    await expect(
      relayPool.query("UPDATE ops.outbox_events SET event_type = 'forbidden'")
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      relayPool.query("INSERT INTO ops.outbox_events (id) VALUES ($1)", [crypto.randomUUID()])
    ).rejects.toMatchObject({ code: "42501" });
    await expect(relayPool.query("DELETE FROM ops.outbox_events")).rejects.toMatchObject({
      code: "42501"
    });
  });

  it("proves relay authority relations and descendants cannot escape forced RLS or ownership", async () => {
    const relations = await ownerPool.query<{
      rootName: string;
      relationName: string;
      relationKind: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      ownerName: string;
      depth: number;
    }>(`
      WITH RECURSIVE roots(root_oid) AS (
        SELECT unnest(ARRAY[${relayAuthorityContracts
          .map(({ schema, table }) => `'${schema}.${table}'::regclass`)
          .join(", ")}])
      ), descendants(root_oid, relation_oid, depth) AS (
        SELECT root_oid, root_oid, 0 FROM roots
        UNION ALL
        SELECT descendants.root_oid, inheritance.inhrelid, descendants.depth + 1
        FROM descendants
        JOIN pg_inherits AS inheritance ON inheritance.inhparent = descendants.relation_oid
      )
      SELECT descendants.root_oid::regclass::text AS "rootName",
             descendants.relation_oid::regclass::text AS "relationName",
             relation.relkind AS "relationKind",
             relation.relrowsecurity, relation.relforcerowsecurity,
             pg_get_userbyid(relation.relowner) AS "ownerName", descendants.depth
      FROM descendants
      JOIN pg_class AS relation ON relation.oid = descendants.relation_oid
      ORDER BY "rootName", descendants.depth, "relationName"
    `);
    expect(relations.rows).toHaveLength(relayAuthorityContracts.length);
    expect(relations.rows.map(({ relationName }) => relationName).sort()).toEqual(
      relayAuthorityContracts.map(({ schema, table }) => `${schema}.${table}`).sort()
    );
    for (const relation of relations.rows) {
      expect(relation.depth, relation.relationName).toBe(0);
      expect(relation.relationKind, relation.relationName).toBe("r");
      expect(relation.relrowsecurity, relation.relationName).toBe(true);
      expect(relation.relforcerowsecurity, relation.relationName).toBe(true);
      expect(relation.ownerName, relation.relationName).not.toBe("throughline_relay");
    }
  });

  it("proves relay has no privileged or inherited role path", async () => {
    const role = await ownerPool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolinherit: boolean;
    }>(`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit
      FROM pg_roles WHERE rolname = 'throughline_relay'
    `);
    expect(role.rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolinherit: false
      }
    ]);

    const memberships = await ownerPool.query<{ grantedRole: string; depth: number }>(`
      WITH RECURSIVE effective_roles(role_oid, depth) AS (
        SELECT oid, 0 FROM pg_roles WHERE rolname = 'throughline_relay'
        UNION
        SELECT membership.roleid, effective_roles.depth + 1
        FROM effective_roles
        JOIN pg_auth_members AS membership ON membership.member = effective_roles.role_oid
      )
      SELECT role.rolname AS "grantedRole", effective_roles.depth
      FROM effective_roles
      JOIN pg_roles AS role ON role.oid = effective_roles.role_oid
      WHERE effective_roles.depth > 0
      ORDER BY effective_roles.depth, role.rolname
    `);
    expect(memberships.rows).toEqual([]);
  });

  it("proves relay UPDATE(id) is the only effective authority write privilege", async () => {
    // Result-ready bounded residual: UPDATE(id) also permits stronger row-lock clauses on rows
    // visible through RLS. This is accepted only while RelayOutboxRepository and its authorization
    // service remain fixed, fully parameterized, and expose no arbitrary SQL callback.
    const effective = await ownerPool.query<{
      relationName: string;
      columnName: string;
      tableUpdate: boolean;
      columnUpdate: boolean;
    }>(`
      WITH authority_relations AS (
        SELECT unnest(ARRAY[${relayAuthorityContracts
          .map(({ schema, table }) => `'${schema}.${table}'::regclass`)
          .join(", ")}]) AS relation_oid
      )
      SELECT relation_oid::regclass::text AS "relationName", attribute.attname AS "columnName",
             has_table_privilege('throughline_relay', relation_oid, 'UPDATE') AS "tableUpdate",
             has_column_privilege('throughline_relay', relation_oid, attribute.attnum, 'UPDATE')
               AS "columnUpdate"
      FROM authority_relations
      JOIN pg_attribute AS attribute ON attribute.attrelid = relation_oid
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY "relationName", attribute.attnum
    `);
    for (const row of effective.rows) {
      expect(row.tableUpdate, row.relationName).toBe(false);
      expect(row.columnUpdate, `${row.relationName}.${row.columnName}`).toBe(
        row.columnName === "id"
      );
    }

    const aclUpdatePaths = await ownerPool.query<{
      relationName: string;
      columnName: string | null;
      grantee: string;
      grantable: boolean;
    }>(`
      WITH RECURSIVE effective_roles(role_oid) AS (
        SELECT oid FROM pg_roles WHERE rolname = 'throughline_relay'
        UNION
        SELECT membership.roleid
        FROM effective_roles
        JOIN pg_auth_members AS membership ON membership.member = effective_roles.role_oid
      ), authority_relations AS (
        SELECT unnest(ARRAY[${relayAuthorityContracts
          .map(({ schema, table }) => `'${schema}.${table}'::regclass`)
          .join(", ")}]) AS relation_oid
      ), table_acl AS (
        SELECT relation.oid AS relation_oid, NULL::text AS column_name, acl.grantee,
               acl.is_grantable
        FROM authority_relations
        JOIN pg_class AS relation ON relation.oid = authority_relations.relation_oid
        CROSS JOIN LATERAL unnest(
          coalesce(relation.relacl, acldefault('r', relation.relowner))
        ) AS acl_item
        CROSS JOIN LATERAL aclexplode(ARRAY[acl_item]) acl
        WHERE acl.privilege_type = 'UPDATE'
      ), column_acl AS (
        SELECT relation_oid, attribute.attname, acl.grantee, acl.is_grantable
        FROM authority_relations
        JOIN pg_attribute AS attribute ON attribute.attrelid = relation_oid
        CROSS JOIN LATERAL unnest(coalesce(attribute.attacl, '{}'::aclitem[])) AS acl_item
        CROSS JOIN LATERAL aclexplode(ARRAY[acl_item]) acl
        WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
          AND acl.privilege_type = 'UPDATE'
      )
      SELECT relation_oid::regclass::text AS "relationName", column_name AS "columnName",
             CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END AS grantee,
             is_grantable AS grantable
      FROM (SELECT * FROM table_acl UNION ALL SELECT * FROM column_acl) AS paths
      WHERE grantee = 0 OR grantee IN (SELECT role_oid FROM effective_roles)
      ORDER BY "relationName", "columnName" NULLS FIRST, grantee
    `);
    expect(aclUpdatePaths.rows).toEqual(
      relayAuthorityContracts
        .map(({ schema, table }) => ({
          relationName: `${schema}.${table}`,
          columnName: "id",
          grantee: "throughline_relay",
          grantable: false
        }))
        .sort((left, right) => left.relationName.localeCompare(right.relationName))
    );

    const informationSchemaPaths = await ownerPool.query<{
      relationName: string;
      columnName: string;
      grantee: string;
      grantable: string;
    }>(
      `
      WITH RECURSIVE effective_roles(role_name, role_oid) AS (
        SELECT rolname, oid FROM pg_roles WHERE rolname = 'throughline_relay'
        UNION
        SELECT granted.rolname, granted.oid
        FROM effective_roles
        JOIN pg_auth_members AS membership ON membership.member = effective_roles.role_oid
        JOIN pg_roles AS granted ON granted.oid = membership.roleid
      )
      SELECT format('%I.%I', privilege.table_schema, privilege.table_name) AS "relationName",
             privilege.column_name AS "columnName", privilege.grantee,
             privilege.is_grantable AS grantable
      FROM information_schema.column_privileges AS privilege
      WHERE privilege.privilege_type = 'UPDATE'
        AND (
          privilege.grantee = 'PUBLIC'
          OR privilege.grantee IN (SELECT role_name FROM effective_roles)
        )
        AND format('%I.%I', privilege.table_schema, privilege.table_name) = ANY($1::text[])
      ORDER BY "relationName", "columnName", privilege.grantee
    `,
      [relayAuthorityContracts.map(({ schema, table }) => `${schema}.${table}`)]
    );
    expect(informationSchemaPaths.rows).toEqual(
      relayAuthorityContracts
        .map(({ schema, table }) => ({
          relationName: `${schema}.${table}`,
          columnName: "id",
          grantee: "throughline_relay",
          grantable: "NO"
        }))
        .sort((left, right) => left.relationName.localeCompare(right.relationName))
    );

    const tableUpdatePaths = await ownerPool.query<{ relationName: string; grantee: string }>(
      `
      WITH RECURSIVE effective_roles(role_name, role_oid) AS (
        SELECT rolname, oid FROM pg_roles WHERE rolname = 'throughline_relay'
        UNION
        SELECT granted.rolname, granted.oid
        FROM effective_roles
        JOIN pg_auth_members AS membership ON membership.member = effective_roles.role_oid
        JOIN pg_roles AS granted ON granted.oid = membership.roleid
      )
      SELECT format('%I.%I', privilege.table_schema, privilege.table_name) AS "relationName",
             privilege.grantee
      FROM information_schema.table_privileges AS privilege
      WHERE privilege.privilege_type = 'UPDATE'
        AND (
          privilege.grantee = 'PUBLIC'
          OR privilege.grantee IN (SELECT role_name FROM effective_roles)
        )
        AND format('%I.%I', privilege.table_schema, privilege.table_name) = ANY($1::text[])
      ORDER BY "relationName", privilege.grantee
    `,
      [relayAuthorityContracts.map(({ schema, table }) => `${schema}.${table}`)]
    );
    expect(tableUpdatePaths.rows).toEqual([]);
  });

  it("proves relay has no other effective authority mutation or schema-create path", async () => {
    for (const { schema, table } of relayAuthorityContracts) {
      const relation = `${schema}.${table}`;
      for (const privilege of ["INSERT", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES"]) {
        const result = await ownerPool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('throughline_relay', $1, $2) AS allowed",
          [relation, privilege]
        );
        expect(result.rows[0]?.allowed, `${relation}: ${privilege}`).toBe(false);
      }
      const schemaCreate = await ownerPool.query<{ allowed: boolean }>(
        "SELECT has_schema_privilege('throughline_relay', $1, 'CREATE') AS allowed",
        [schema]
      );
      expect(schemaCreate.rows[0]?.allowed, `${schema}: CREATE`).toBe(false);
    }

    const unsafeHooks = await ownerPool.query<{ objectName: string }>(`
      WITH authority_relations AS (
        SELECT unnest(ARRAY[${relayAuthorityContracts
          .map(({ schema, table }) => `'${schema}.${table}'::regclass`)
          .join(", ")}]) AS relation_oid
      )
      SELECT format('%s trigger %I', trigger.tgrelid::regclass, trigger.tgname) AS "objectName"
      FROM authority_relations
      JOIN pg_trigger AS trigger ON trigger.tgrelid = relation_oid
      WHERE NOT trigger.tgisinternal
        AND (trigger.tgtype & 2) = 2
        AND (trigger.tgtype & 16) = 16
      UNION ALL
      SELECT format('%s rule %I', rewrite.ev_class::regclass, rewrite.rulename)
      FROM authority_relations
      JOIN pg_rewrite AS rewrite ON rewrite.ev_class = relation_oid
      WHERE rewrite.rulename <> '_RETURN'
      ORDER BY 1
    `);
    expect(unsafeHooks.rows).toEqual([]);
  });

  it("enumerates the exact twelve effective relay UPDATE policies and their expressions", async () => {
    const policies = await ownerPool.query<{
      relationName: string;
      policyName: string;
      command: string;
      permissive: boolean;
      roles: string[];
      usingExpression: string | null;
      checkExpression: string | null;
    }>(`
      WITH RECURSIVE effective_roles(role_oid) AS (
        SELECT oid FROM pg_roles WHERE rolname = 'throughline_relay'
        UNION
        SELECT membership.roleid
        FROM effective_roles
        JOIN pg_auth_members AS membership ON membership.member = effective_roles.role_oid
      ), authority_relations AS (
        SELECT unnest(ARRAY[${relayAuthorityContracts
          .map(({ schema, table }) => `'${schema}.${table}'::regclass`)
          .join(", ")}]) AS relation_oid
      )
      SELECT policy.polrelid::regclass::text AS "relationName", policy.polname AS "policyName",
             policy.polcmd AS command, policy.polpermissive AS permissive,
             ARRAY(
               SELECT (CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END)::text
               FROM unnest(policy.polroles) AS role_oid ORDER BY 1
             ) AS roles,
             pg_get_expr(policy.polqual, policy.polrelid) AS "usingExpression",
             pg_get_expr(policy.polwithcheck, policy.polrelid) AS "checkExpression"
      FROM authority_relations
      JOIN pg_policy AS policy ON policy.polrelid = authority_relations.relation_oid
      WHERE policy.polcmd IN ('*', 'w')
        AND (
          0 = ANY(policy.polroles)
          OR policy.polroles && ARRAY(SELECT role_oid FROM effective_roles)::oid[]
        )
      ORDER BY "relationName", "policyName"
    `);
    expect(policies.rows).toHaveLength(12);
    for (const contract of relayAuthorityContracts) {
      const relationName = `${contract.schema}.${contract.table}`;
      const applicable = policies.rows.filter((policy) => policy.relationName === relationName);
      expect(applicable, relationName).toHaveLength(2);
      expect(
        applicable.every(({ command }) => command === "w"),
        relationName
      ).toBe(true);
      expect(
        applicable.every(({ roles }) => roles.join(",") === "throughline_relay"),
        relationName
      ).toBe(true);

      const scoped = applicable.find(
        ({ policyName }) => policyName === `${contract.policyStem}_relay_lock_only`
      );
      expect(scoped, `${relationName} scoped`).toBeDefined();
      expect(scoped?.permissive).toBe(true);
      expect(normalizePolicyExpression(scoped?.usingExpression)).toBe(
        normalizePolicyExpression(contract.using)
      );
      expect(normalizePolicyExpression(scoped?.checkExpression)).toBe("false");

      const guard = applicable.find(
        ({ policyName }) => policyName === `${contract.policyStem}_relay_no_write`
      );
      expect(guard, `${relationName} guard`).toBeDefined();
      expect(guard?.permissive).toBe(false);
      expect(normalizePolicyExpression(guard?.usingExpression)).toBe("true");
      expect(normalizePolicyExpression(guard?.checkExpression)).toBe("false");
      expect(
        applicable.some(({ permissive }) => permissive) &&
          applicable.some(
            ({ permissive, checkExpression }) =>
              !permissive && normalizePolicyExpression(checkExpression) === "false"
          ),
        `${relationName} future permissive-policy guard`
      ).toBe(true);
    }
  });

  it("lets relay FOR SHARE-lock each exact authority predicate row", async () => {
    const client = await relayPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, relayAuthoritySettings());
      for (const [table, predicate, values] of relayAuthorityRows()) {
        const locked = await client.query<{ id: string }>(
          `SELECT id FROM ${table} WHERE ${predicate} FOR SHARE`,
          [...values]
        );
        expect(locked.rowCount, table).toBe(1);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it.each(relayAuthorityRows())(
    "proves relay FOR SHARE holds a real tuple lock on %s",
    async (table, predicate, values, mutation) => {
      const relay = await relayPool.connect();
      const owner = await ownerPool.connect();
      let mutationPromise: Promise<unknown> | undefined;
      try {
        await relay.query("BEGIN");
        await setLocal(relay, relayAuthoritySettings());
        await expect(
          relay.query(`SELECT id FROM ${table} WHERE ${predicate} FOR SHARE`, [...values])
        ).resolves.toMatchObject({ rowCount: 1 });

        await owner.query("BEGIN");
        const ownerPid = await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        mutationPromise = owner.query(`UPDATE ${table} SET ${mutation} WHERE ${predicate}`, [
          ...values
        ]);
        await expect(
          waitForBlockedBackend(ownerPool, ownerPid.rows[0]!.pid)
        ).resolves.toBeUndefined();

        await relay.query("ROLLBACK");
        await expect(mutationPromise).resolves.toMatchObject({ rowCount: 1 });
        await owner.query("ROLLBACK");
      } finally {
        await relay.query("ROLLBACK").catch(() => undefined);
        await owner.query("ROLLBACK").catch(() => undefined);
        await Promise.allSettled(mutationPromise ? [mutationPromise] : []);
        relay.release();
        owner.release();
      }
    }
  );

  it("default-denies relay no-op updates, rejects mutable updates with 42501, and persists no change", async () => {
    const before = await relayAuthoritySnapshot(ownerPool);

    for (const [table, predicate, values, mutation] of relayAuthorityRows()) {
      await expectRelayStatementDenied(
        relayPool,
        `UPDATE ${table} SET id = id WHERE ${predicate}`,
        values,
        relayAuthoritySettings()
      );
      await expectRelayStatementDenied(
        relayPool,
        `UPDATE ${table} SET ${mutation} WHERE ${predicate}`,
        values,
        relayAuthoritySettings()
      );
    }

    await expect(relayAuthoritySnapshot(ownerPool)).resolves.toEqual(before);
  });

  it.each(relayAuthorityRows())(
    "denies every SQL write surface and preserves the full row digest for %s",
    async (table, predicate, values) => {
      const before = await relationDigest(ownerPool, table);
      const columns = await authorityColumnNames(ownerPool, table);
      const existing = await ownerPool.query<{ id: string }>(
        `SELECT id::text AS id FROM ${table} WHERE ${predicate}`,
        [...values]
      );
      expect(existing.rows, table).toHaveLength(1);
      const existingId = existing.rows[0]!.id;
      const conflictTarget =
        table === "identity.policy_versions" ? "(tenant_id, workspace_id, id)" : "(id)";
      const differentId = crypto.randomUUID();
      const statements: Array<readonly [string, readonly unknown[]]> = [
        [`UPDATE ${table} SET id = id WHERE ${predicate}`, values],
        [
          `UPDATE ${table} SET id = $${values.length + 1} WHERE ${predicate}`,
          [...values, differentId]
        ],
        [`DELETE FROM ${table} WHERE ${predicate}`, values],
        [`TRUNCATE TABLE ${table}`, []],
        [
          `MERGE INTO ${table} AS target USING (VALUES ($1::text)) AS source(id)
           ON target.id::text = source.id
           WHEN MATCHED THEN UPDATE SET id = target.id`,
          [existingId]
        ],
        [`INSERT INTO ${table} (id) VALUES ($1)`, [differentId]],
        [
          `INSERT INTO ${table}
           SELECT * FROM ${table} WHERE id::text = $1
           ON CONFLICT ${conflictTarget} DO UPDATE SET id = EXCLUDED.id`,
          [existingId]
        ]
      ];
      for (const column of columns.filter((column) => column !== "id")) {
        statements.push([`UPDATE ${table} SET ${column} = ${column} WHERE ${predicate}`, values]);
        statements.push([
          `UPDATE ${table} SET id = id, ${column} = ${column} WHERE ${predicate}`,
          values
        ]);
      }

      for (const [sql, parameters] of statements) {
        await expectRelayStatementDenied(relayPool, sql, parameters, relayAuthoritySettings());
      }
      await expect(relationDigest(ownerPool, table)).resolves.toBe(before);
      await expect(relayPool.query("SELECT current_user AS role")).resolves.toMatchObject({
        rows: [{ role: "throughline_relay" }]
      });
    }
  );

  it("keeps cross-scope authority rows invisible to relay FOR SHARE locks", async () => {
    const client = await relayPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, relayAuthoritySettings());
      for (const [table, predicate, values] of relayCrossScopeAuthorityRows()) {
        const locked = await client.query(`SELECT id FROM ${table} WHERE ${predicate} FOR SHARE`, [
          ...values
        ]);
        expect(locked.rows, table).toEqual([]);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it.each(relayAuthorityRows())(
    "fails closed for missing, malformed, stale, and wrong context on %s",
    async (table, predicate, values) => {
      for (const requiredSetting of relayRequiredSettings(table)) {
        const missing = { ...relayAuthoritySettings(), [requiredSetting]: undefined };
        await expectRelayLockRows(relayPool, table, predicate, values, missing, 0);

        const malformed = relayAuthoritySettings();
        await expectMalformedRelayContextClosed(
          relayPool,
          table,
          predicate,
          values,
          requiredSetting,
          malformed
        );

        const wrong = {
          ...relayAuthoritySettings(),
          [requiredSetting]: wrongRelaySetting(requiredSetting)
        };
        await expectRelayLockRows(relayPool, table, predicate, values, wrong, 0);
      }

      try {
        await setRelayAuthorityLiveState(ownerPool, table, false);
        await expectRelayLockRows(relayPool, table, predicate, values, relayAuthoritySettings(), 0);
      } finally {
        await setRelayAuthorityLiveState(ownerPool, table, true);
      }
    }
  );

  it("allows relay claim metadata updates only inside its exact transaction-local scope", async () => {
    const client = await relayPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        servicePrincipalId: ids.relayA,
        policyVersion: DEV_POLICY_VERSION
      });
      const claimed = await client.query<{ id: string }>(
        `UPDATE ops.outbox_events
         SET publication_attempts = publication_attempts + 1,
             claimed_at = clock_timestamp(),
             claimed_by = 'relay-test',
             claim_token = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
             claim_expires_at = clock_timestamp() + interval '30 seconds'
         RETURNING id`
      );
      expect(claimed.rows).toEqual([{ id: ids.eventA }]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("denies relay product/identity reads beyond exact authority columns", async () => {
    await expect(relayPool.query("SELECT primary_email FROM identity.users")).rejects.toMatchObject(
      { code: "42501" }
    );
    await expect(relayPool.query("SELECT display_name FROM identity.people")).rejects.toMatchObject(
      {
        code: "42501"
      }
    );
    await expect(
      relayPool.query("SELECT proof_key FROM ops.foundation_test_aggregates")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("binds worker bootstrap lookup to exact signed-claim settings", async () => {
    expect(await scopedWorkerReferenceIds(workerPool, {})).toEqual([]);
    expect(
      await scopedWorkerReferenceIds(workerPool, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([ids.referenceA]);
    expect(
      await scopedWorkerReferenceIds(workerPool, {
        tenantId: devFixtures.tenantB,
        workspaceId: devFixtures.workspaceB,
        spaceId: devFixtures.rootSpaceB,
        jobId: ids.jobB,
        referenceId: ids.referenceB,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([]);
  });

  it("fails closed through the fixed bootstrap for missing, wrong, forged, cross-tenant, unknown, revoked, and expired bindings", async () => {
    const codec = createAsyncContextReferenceCodec({
      verificationKeys: new Map([["test-key", bootstrapSigningKey]]),
      activeKeyId: "test-key",
      clock: () => new Date()
    });
    const baseClaims = {
      referenceId: ids.referenceA,
      jobId: ids.jobA,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.rootSpaceA,
      workerServicePrincipalId: ids.workerA,
      policyVersionId: DEV_POLICY_VERSION
    } as const;
    const { token } = codec.issue({ ...baseClaims, ttlSeconds: 600 });
    const expected = {
      jobId: baseClaims.jobId,
      tenantId: baseClaims.tenantId,
      workspaceId: baseClaims.workspaceId,
      spaceId: baseClaims.spaceId,
      workerServicePrincipalId: baseClaims.workerServicePrincipalId,
      policyVersionId: baseClaims.policyVersionId
    };

    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token, codec, expected })
    ).resolves.toMatchObject({ id: ids.referenceA });

    for (const [pool, connectionString] of [
      [ownerPool, ownerUrl!],
      [appPool, appUrl!]
    ] as const) {
      let error: unknown;
      try {
        await bootstrapWorkerContextReference({ pool, token, codec, expected });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "WorkerContextBootstrapError",
        message: "Worker context bootstrap failed"
      });
      const rendered = `${String(error)} ${JSON.stringify(error)}`;
      expect(rendered).not.toContain(token);
      expect(rendered).not.toContain(bootstrapSigningKey.toString("utf8"));
      expect(rendered).not.toContain(contextCredentialMarker);
      expect(rendered).not.toContain(connectionString);
    }
    expect(
      await scopedWorkerReferenceIds(workerPool, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      })
    ).toEqual([]);

    const wrongWorker = codec.issue({
      ...baseClaims,
      workerServicePrincipalId: ids.workerB,
      ttlSeconds: 600
    });
    await expect(
      bootstrapWorkerContextReference({
        pool: workerPool,
        token: wrongWorker.token,
        codec,
        expected: { ...expected, workerServicePrincipalId: ids.workerB }
      })
    ).resolves.toBeNull();

    const tokenParts = token.split(".");
    const payload = JSON.parse(
      Buffer.from(tokenParts[4]!, "base64url").toString("utf8")
    ) as unknown[];
    payload[3] = devFixtures.tenantB;
    tokenParts[4] = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    await expect(
      bootstrapWorkerContextReference({
        pool: workerPool,
        token: tokenParts.join("."),
        codec,
        expected
      })
    ).resolves.toBeNull();

    const crossTenant = codec.issue({
      ...baseClaims,
      tenantId: devFixtures.tenantB,
      workspaceId: devFixtures.workspaceB,
      spaceId: devFixtures.rootSpaceB,
      ttlSeconds: 600
    });
    await expect(
      bootstrapWorkerContextReference({
        pool: workerPool,
        token: crossTenant.token,
        codec,
        expected: {
          ...expected,
          tenantId: devFixtures.tenantB,
          workspaceId: devFixtures.workspaceB,
          spaceId: devFixtures.rootSpaceB
        }
      })
    ).resolves.toBeNull();

    const unknown = codec.issue({
      ...baseClaims,
      referenceId: "70000000-0000-7000-8000-000000000039",
      ttlSeconds: 600
    });
    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token: unknown.token, codec, expected })
    ).resolves.toBeNull();

    await ownerPool.query(
      `UPDATE ops.security_context_references
       SET status = 'revoked', revoked_at = clock_timestamp(), revocation_reason = 'test'
       WHERE id = $1`,
      [ids.referenceA]
    );
    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token, codec, expected })
    ).resolves.toBeNull();
    await ownerPool.query(
      `UPDATE ops.security_context_references
       SET status = 'active', revoked_at = NULL, revocation_reason = NULL,
           issued_at = clock_timestamp() - interval '20 minutes',
           expires_at = clock_timestamp() - interval '5 minutes'
       WHERE id = $1`,
      [ids.referenceA]
    );
    await expect(
      bootstrapWorkerContextReference({ pool: workerPool, token, codec, expected })
    ).resolves.toBeNull();
    await ownerPool.query(
      `UPDATE ops.security_context_references
       SET issued_at = clock_timestamp(), expires_at = clock_timestamp() + interval '15 minutes'
       WHERE id = $1`,
      [ids.referenceA]
    );
  });

  it("prevents worker access to outbox and unrelated identity/domain surfaces", async () => {
    await expect(workerPool.query("SELECT id FROM ops.outbox_events")).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      workerPool.query("SELECT primary_email FROM identity.users")
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerPool.query("DELETE FROM ops.foundation_test_aggregates")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("grants UPDATE(id) as the only worker UPDATE column on every authority table", async () => {
    for (const [schema, table] of [
      ["identity", "tenants"],
      ["identity", "workspaces"],
      ["identity", "users"],
      ["identity", "memberships"],
      ["identity", "policy_versions"],
      ["identity", "service_principals"],
      ["access", "spaces"],
      ["access", "access_relationships"],
      ["ops", "security_context_references"]
    ] as const) {
      const grants = await ownerPool.query<{ columnName: string }>(
        `SELECT column_name AS "columnName"
         FROM information_schema.column_privileges
         WHERE grantee = 'throughline_worker'
           AND privilege_type = 'UPDATE'
           AND table_schema = $1
           AND table_name = $2
         ORDER BY column_name`,
        [schema, table]
      );
      expect(grants.rows, `${schema}.${table}`).toEqual([{ columnName: "id" }]);
    }
  });

  it("keeps throughline_worker outside pg_signal_backend", async () => {
    const membership = await ownerPool.query<{
      directMembership: boolean;
      effectiveMember: boolean;
    }>(`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_auth_members memberships
          JOIN pg_roles granted ON granted.oid = memberships.roleid
          JOIN pg_roles member ON member.oid = memberships.member
          WHERE granted.rolname = 'pg_signal_backend'
            AND member.rolname = 'throughline_worker'
        ) AS "directMembership",
        pg_has_role('throughline_worker', 'pg_signal_backend', 'MEMBER') AS "effectiveMember"
    `);
    expect(membership.rows).toEqual([{ directMembership: false, effectiveMember: false }]);
  });

  it("allows fixed same-role cancellation but cannot cancel app, relay, or owner backends", async () => {
    const canceller = await workerPool.connect();
    const workerTarget = await workerPool.connect();
    const protectedTargets = await Promise.all([
      appPool.connect(),
      relayPool.connect(),
      ownerPool.connect()
    ]);
    try {
      const workerIdentity = await workerTarget.query<{ pid: number }>(
        'SELECT pg_backend_pid()::integer AS "pid"'
      );
      const sleeping = workerTarget.query("SELECT pg_sleep(5)").catch((error: unknown) => error);
      await waitForActiveBackend(ownerPool, workerIdentity.rows[0]!.pid);
      await expect(
        canceller.query<{ cancelled: boolean }>(
          "SELECT pg_catalog.pg_cancel_backend($1) AS cancelled",
          [workerIdentity.rows[0]!.pid]
        )
      ).resolves.toMatchObject({ rows: [{ cancelled: true }] });
      expect(await sleeping).toMatchObject({ code: "57014" });
      await expect(workerTarget.query("SELECT 1 AS alive")).resolves.toMatchObject({
        rows: [{ alive: 1 }]
      });

      for (const target of protectedTargets) {
        const identity = await target.query<{ pid: number }>(
          'SELECT pg_backend_pid()::integer AS "pid"'
        );
        const attempt = await canceller
          .query<{ cancelled: boolean }>("SELECT pg_catalog.pg_cancel_backend($1) AS cancelled", [
            identity.rows[0]!.pid
          ])
          .then((result) => result.rows[0]?.cancelled ?? false)
          .catch((error: unknown) => {
            expect(error).toMatchObject({ code: "42501" });
            return false;
          });
        expect(attempt).toBe(false);
        await expect(target.query("SELECT 1 AS alive")).resolves.toMatchObject({
          rows: [{ alive: 1 }]
        });
      }
    } finally {
      canceller.release();
      workerTarget.release();
      for (const target of protectedTargets) target.release();
    }
  });

  it("lets the worker row-lock every exact live-authority row without granting mutation", async () => {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        userId: ids.delegatorUserA,
        membershipId: ids.delegatorMembershipA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      });

      for (const [table, predicate, values] of [
        [
          "ops.security_context_references",
          "id = $1 AND job_id = $2 AND tenant_id = $3 AND workspace_id = $4 AND space_id = $5 AND worker_service_principal_id = $6 AND policy_version_id = $7 AND delegating_user_id = $8 AND delegating_membership_id = $9 AND status = 'active' AND revoked_at IS NULL AND expires_at > clock_timestamp()",
          [
            ids.referenceA,
            ids.jobA,
            devFixtures.tenantA,
            devFixtures.workspaceA,
            devFixtures.rootSpaceA,
            ids.workerA,
            DEV_POLICY_VERSION,
            ids.delegatorUserA,
            ids.delegatorMembershipA
          ]
        ],
        ["identity.tenants", "id = $1 AND status = 'active'", [devFixtures.tenantA]],
        [
          "identity.workspaces",
          "tenant_id = $1 AND id = $2 AND status = 'active'",
          [devFixtures.tenantA, devFixtures.workspaceA]
        ],
        [
          "identity.policy_versions",
          "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active'",
          [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
        ],
        [
          "identity.service_principals",
          "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND purpose = 'worker' AND status = 'active'",
          [devFixtures.tenantA, devFixtures.workspaceA, ids.workerA]
        ],
        ["identity.users", "id = $1 AND status = 'active'", [ids.delegatorUserA]],
        [
          "identity.memberships",
          "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND user_id = $4 AND status = 'active'",
          [
            devFixtures.tenantA,
            devFixtures.workspaceA,
            ids.delegatorMembershipA,
            ids.delegatorUserA
          ]
        ],
        [
          "access.spaces",
          "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL",
          [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.rootSpaceA]
        ],
        [
          "access.access_relationships",
          "tenant_id = $1 AND workspace_id = $2 AND subject_type = 'service_principal' AND subject_id = $3 AND resource_type = 'space' AND resource_id = $4 AND relation = 'contributor' AND source = 'direct'",
          [devFixtures.tenantA, devFixtures.workspaceA, ids.workerA, devFixtures.rootSpaceA]
        ],
        [
          "access.access_relationships",
          "tenant_id = $1 AND workspace_id = $2 AND subject_type = 'membership' AND subject_id = $3 AND resource_type = 'space' AND resource_id = $4 AND relation = 'contributor' AND source = 'direct'",
          [
            devFixtures.tenantA,
            devFixtures.workspaceA,
            ids.delegatorMembershipA,
            devFixtures.rootSpaceA
          ]
        ]
      ] as const) {
        const locked = await client.query<{ id: string }>(
          `SELECT id FROM ${table} WHERE ${predicate} FOR UPDATE`,
          [...values]
        );
        expect(locked.rowCount, table).toBe(1);
        await expect(
          client.query(`UPDATE ${table} SET id = id WHERE ${predicate}`, [...values])
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await setLocal(client, {
          tenantId: devFixtures.tenantA,
          workspaceId: devFixtures.workspaceA,
          spaceId: devFixtures.rootSpaceA,
          userId: ids.delegatorUserA,
          membershipId: ids.delegatorMembershipA,
          jobId: ids.jobA,
          referenceId: ids.referenceA,
          workerPrincipalId: ids.workerA,
          policyVersion: DEV_POLICY_VERSION
        });
        await expect(
          client.query(`DELETE FROM ${table} WHERE ${predicate}`, [...values])
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await setLocal(client, {
          tenantId: devFixtures.tenantA,
          workspaceId: devFixtures.workspaceA,
          spaceId: devFixtures.rootSpaceA,
          userId: ids.delegatorUserA,
          membershipId: ids.delegatorMembershipA,
          jobId: ids.jobA,
          referenceId: ids.referenceA,
          workerPrincipalId: ids.workerA,
          policyVersion: DEV_POLICY_VERSION
        });
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it.each([
    ["tenant status", "identity.tenants", "status = 'suspended'", devFixtures.tenantA],
    ["workspace status", "identity.workspaces", "status = 'archived'", devFixtures.workspaceA],
    ["user status", "identity.users", "status = 'disabled'", ids.delegatorUserA],
    ["membership status", "identity.memberships", "status = 'suspended'", ids.delegatorMembershipA],
    ["membership role", "identity.memberships", "role = 'owner'", ids.delegatorMembershipA],
    ["policy status", "identity.policy_versions", "status = 'retired'", DEV_POLICY_VERSION],
    ["service-principal purpose", "identity.service_principals", "purpose = 'system'", ids.workerA],
    ["service-principal status", "identity.service_principals", "status = 'disabled'", ids.workerA],
    ["Space archive", "access.spaces", "archived_at = clock_timestamp()", devFixtures.rootSpaceA],
    [
      "relationship relation",
      "access.access_relationships",
      "relation = 'owner'",
      ids.delegatorGrantA
    ],
    [
      "relationship source",
      "access.access_relationships",
      "source = 'system'",
      ids.delegatorGrantA
    ],
    ["reference status", "ops.security_context_references", "status = 'revoked'", ids.referenceA]
  ] as const)("rejects worker authority mutation: %s", async (_name, table, mutation, id) => {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, workerAuthoritySettings());
      await expect(
        client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id])
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        client.query(`UPDATE ${table} SET ${mutation} WHERE id = $1`, [id])
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("keeps cross-tenant/workspace/Space authority and reference rows invisible to worker locks", async () => {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        userId: ids.delegatorUserA,
        membershipId: ids.delegatorMembershipA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION
      });
      for (const [table, id] of [
        ["identity.tenants", devFixtures.tenantB],
        ["identity.workspaces", devFixtures.workspaceB],
        ["identity.users", devFixtures.userB],
        ["identity.memberships", devFixtures.membershipBViewer],
        ["identity.service_principals", ids.workerB],
        ["access.spaces", devFixtures.rootSpaceB],
        ["ops.security_context_references", ids.referenceB]
      ]) {
        const result = await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        expect(result.rows, table).toEqual([]);
      }
      const crossPolicy = await client.query(
        "SELECT id FROM identity.policy_versions WHERE tenant_id = $1 FOR UPDATE",
        [devFixtures.tenantB]
      );
      const crossGrant = await client.query(
        "SELECT id FROM access.access_relationships WHERE tenant_id = $1 FOR UPDATE",
        [devFixtures.tenantB]
      );
      expect(crossPolicy.rows).toEqual([]);
      expect(crossGrant.rows).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("allows worker proof/idempotency writes only for the exact bound job and reference", async () => {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await setLocal(client, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.rootSpaceA,
        jobId: ids.jobA,
        referenceId: ids.referenceA,
        workerPrincipalId: ids.workerA,
        policyVersion: DEV_POLICY_VERSION,
        userId: ids.delegatorUserA,
        membershipId: ids.delegatorMembershipA,
        handlerKey: fixedHandlerKey,
        aggregateId: ids.aggregateA,
        aggregateVersion: "2",
        effectHash: fixedEffectHash
      });
      const before = await client.query(
        `SELECT id FROM ops.idempotency_records
         WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
           AND job_id = $4 AND context_reference_id = $5
           AND handler_key = $6 AND aggregate_id = $7
           AND aggregate_version = $8 AND effect_hash = $9`,
        [
          devFixtures.tenantA,
          devFixtures.workspaceA,
          devFixtures.rootSpaceA,
          ids.jobA,
          ids.referenceA,
          fixedHandlerKey,
          ids.aggregateA,
          2,
          fixedEffectHash
        ]
      );
      expect(before.rows).toEqual([]);
      const updated = await client.query<{ id: string }>(
        `UPDATE ops.foundation_test_aggregates
         SET pending_job_id = NULL,
             last_effect_job_id = $1,
             effect_count = effect_count + 1,
             aggregate_version = aggregate_version + 1,
             updated_at = clock_timestamp()
         WHERE id = $2 AND tenant_id = $3 AND workspace_id = $4 AND space_id = $5
           AND pending_job_id = $1 AND aggregate_version = $6
         RETURNING id`,
        [
          ids.jobA,
          ids.aggregateA,
          devFixtures.tenantA,
          devFixtures.workspaceA,
          devFixtures.rootSpaceA,
          1
        ]
      );
      expect(updated.rows).toEqual([{ id: ids.aggregateA }]);
      await expect(
        client.query(
          `INSERT INTO ops.idempotency_records
             (id, tenant_id, workspace_id, space_id, job_id, handler_key,
              context_reference_id, aggregate_id, aggregate_version, effect_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2, $9)`,
          [
            crypto.randomUUID(),
            devFixtures.tenantA,
            devFixtures.workspaceA,
            devFixtures.rootSpaceA,
            ids.jobA,
            fixedHandlerKey,
            ids.referenceA,
            ids.aggregateA,
            fixedEffectHash
          ]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rolls migration 0002 back with its journal record", async () => {
    const migrationId = migrationIds[1]!;
    await ownerPool.query("DELETE FROM throughline_migrations.journal WHERE id = $1", [
      migrationId
    ]);
    await ownerPool.query("DROP POLICY outbox_events_app_scope ON ops.outbox_events");

    try {
      await ownerPool.query(`
        CREATE FUNCTION throughline_migrations.reject_foundation_journal_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
          IF NEW.id = '0002_foundation_closure_async_isolation.sql' THEN
            RAISE EXCEPTION 'intentional Foundation journal failure';
          END IF;
          RETURN NEW;
        END
        $trigger$
      `);
      await ownerPool.query(`
        CREATE TRIGGER reject_foundation_journal_insert
        BEFORE INSERT ON throughline_migrations.journal
        FOR EACH ROW
        EXECUTE FUNCTION throughline_migrations.reject_foundation_journal_insert()
      `);

      await expect(applyMigrations(ownerPool)).rejects.toThrow(
        "intentional Foundation journal failure"
      );
      const rolledBack = await ownerPool.query<{ journal_count: string; policy_count: string }>(`
        SELECT
          (SELECT count(*)::text FROM throughline_migrations.journal WHERE id = '${migrationId}')
            AS journal_count,
          (SELECT count(*)::text FROM pg_policies
           WHERE schemaname = 'ops' AND tablename = 'outbox_events'
             AND policyname = 'outbox_events_app_scope') AS policy_count
      `);
      expect(rolledBack.rows[0]).toEqual({ journal_count: "0", policy_count: "0" });
    } finally {
      await ownerPool.query(
        "DROP TRIGGER IF EXISTS reject_foundation_journal_insert ON throughline_migrations.journal"
      );
      await ownerPool.query(
        "DROP FUNCTION IF EXISTS throughline_migrations.reject_foundation_journal_insert()"
      );
      await applyMigrations(ownerPool);
    }
  });
});

function assertDistinctRuntimeDsns(
  owner: string,
  app: string,
  relay: string,
  worker: string
): void {
  const users = [owner, app, relay, worker].map((value) =>
    decodeURIComponent(new URL(value).username)
  );
  expect(new Set(users).size).toBe(4);
  expect(users.slice(1)).toEqual(["throughline_app", "throughline_relay", "throughline_worker"]);
}

async function seedFoundationRows(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO identity.users (id, auth_provider, auth_subject, primary_email, status)
     VALUES ($1, 'dev', 'foundation-member-a', 'foundation-member-a@example.com', 'active')`,
    [ids.delegatorUserA]
  );
  await pool.query(
    `INSERT INTO identity.people
       (id, tenant_id, workspace_id, display_name, primary_email, is_internal)
     VALUES ($1,$2,$3,'Foundation Member A','foundation-member-a@example.com',true)`,
    [ids.delegatorPersonA, devFixtures.tenantA, devFixtures.workspaceA]
  );
  await pool.query(
    `INSERT INTO identity.memberships
       (id, tenant_id, workspace_id, user_id, person_id, role, status)
     VALUES ($1,$2,$3,$4,$5,'member','active')`,
    [
      ids.delegatorMembershipA,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      ids.delegatorUserA,
      ids.delegatorPersonA
    ]
  );
  await pool.query(
    `INSERT INTO identity.service_principals (id, tenant_id, workspace_id, name, purpose, status)
     VALUES
       ($1, $2, $3, 'Relay A', 'system', 'active'), ($4, $5, $6, 'Relay B', 'system', 'active'),
       ($7, $2, $3, 'Worker A', 'worker', 'active'), ($8, $5, $6, 'Worker B', 'worker', 'active')`,
    [
      ids.relayA,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      ids.relayB,
      devFixtures.tenantB,
      devFixtures.workspaceB,
      ids.workerA,
      ids.workerB
    ]
  );
  await pool.query(
    `INSERT INTO access.access_relationships
       (id, tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
     VALUES
       (gen_random_uuid(), $1, $2, 'service_principal', $3, 'manager', 'space', $4, 'direct'),
       (gen_random_uuid(), $5, $6, 'service_principal', $7, 'manager', 'space', $8, 'direct'),
       (gen_random_uuid(), $1, $2, 'service_principal', $9, 'contributor', 'space', $4, 'direct'),
       (gen_random_uuid(), $5, $6, 'service_principal', $10, 'contributor', 'space', $8, 'direct'),
       ($11, $1, $2, 'membership', $12, 'contributor', 'space', $4, 'direct')`,
    [
      devFixtures.tenantA,
      devFixtures.workspaceA,
      ids.relayA,
      devFixtures.rootSpaceA,
      devFixtures.tenantB,
      devFixtures.workspaceB,
      ids.relayB,
      devFixtures.rootSpaceB,
      ids.workerA,
      ids.workerB,
      ids.delegatorGrantA,
      ids.delegatorMembershipA
    ]
  );
  for (const fixture of [
    {
      tenant: devFixtures.tenantA,
      workspace: devFixtures.workspaceA,
      space: devFixtures.rootSpaceA,
      aggregate: ids.aggregateA,
      event: ids.eventA,
      job: ids.jobA,
      reference: ids.referenceA,
      relay: ids.relayA,
      worker: ids.workerA,
      user: ids.delegatorUserA,
      membership: ids.delegatorMembershipA
    },
    {
      tenant: devFixtures.tenantB,
      workspace: devFixtures.workspaceB,
      space: devFixtures.rootSpaceB,
      aggregate: ids.aggregateB,
      event: ids.eventB,
      job: ids.jobB,
      reference: ids.referenceB,
      relay: ids.relayB,
      worker: ids.workerB,
      user: devFixtures.userB,
      membership: devFixtures.membershipBViewer
    }
  ]) {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 15 * 60 * 1_000);
    const contextSnapshot = {
      requestId: `request-${fixture.job}`,
      traceId: `trace-${fixture.job}`,
      tenantId: fixture.tenant,
      workspaceId: fixture.workspace,
      servicePrincipalId: fixture.worker,
      delegatedByUserId: fixture.user,
      delegatedByMembershipId: fixture.membership,
      requestedSpaceIds: [fixture.space],
      membershipIds: [fixture.membership],
      roleHints: ["member"],
      dataClassCeiling: "workspace",
      policyVersion: DEV_POLICY_VERSION,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    await pool.query(
      `INSERT INTO ops.security_context_references
        (id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
         delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
         issued_at, expires_at, status, signing_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active','test-key')`,
      [
        fixture.reference,
        fixture.job,
        fixture.tenant,
        fixture.workspace,
        fixture.space,
        fixture.worker,
        fixture.user,
        fixture.membership,
        DEV_POLICY_VERSION,
        contextSnapshot,
        issuedAt,
        expiresAt
      ]
    );
    await pool.query(
      `INSERT INTO ops.foundation_test_aggregates
         (id, tenant_id, workspace_id, space_id, proof_key, pending_job_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        fixture.aggregate,
        fixture.tenant,
        fixture.workspace,
        fixture.space,
        `proof-${fixture.job}`,
        fixture.job
      ]
    );
    await pool.query(
      `INSERT INTO ops.outbox_events
        (id,event_type,tenant_id,workspace_id,space_id,aggregate_type,aggregate_id,aggregate_version,
         causation_id,request_id,traceparent,job_id,relay_service_principal_id,
         context_reference_id,signed_context_reference)
       VALUES ($1,'foundation.proof.requested',$2,$3,$4,'foundation_test_aggregate',$5,1,
         $6,'request-test','00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',$6,$7,$8,'opaque-test-token')`,
      [
        fixture.event,
        fixture.tenant,
        fixture.workspace,
        fixture.space,
        fixture.aggregate,
        fixture.job,
        fixture.relay,
        fixture.reference
      ]
    );
  }
}

type ScopeSettings = {
  tenantId?: string;
  workspaceId?: string;
  spaceId?: string;
  servicePrincipalId?: string;
  policyVersion?: string;
  jobId?: string;
  referenceId?: string;
  workerPrincipalId?: string;
  userId?: string;
  membershipId?: string;
  handlerKey?: string;
  aggregateId?: string;
  aggregateVersion?: string;
  effectHash?: string;
};

type RelayAuthorityRow = readonly [
  table: string,
  predicate: string,
  values: readonly string[],
  mutation: string
];

function relayAuthoritySettings(): ScopeSettings {
  return {
    tenantId: devFixtures.tenantA,
    workspaceId: devFixtures.workspaceA,
    spaceId: devFixtures.rootSpaceA,
    servicePrincipalId: ids.relayA,
    policyVersion: DEV_POLICY_VERSION
  };
}

function relayAuthorityRows(): readonly RelayAuthorityRow[] {
  return [
    [
      "identity.tenants",
      "id = $1 AND status = 'active'",
      [devFixtures.tenantA],
      "status = 'suspended'"
    ],
    [
      "identity.workspaces",
      "tenant_id = $1 AND id = $2 AND status = 'active'",
      [devFixtures.tenantA, devFixtures.workspaceA],
      "status = 'archived'"
    ],
    [
      "identity.policy_versions",
      "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active'",
      [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION],
      "status = 'retired'"
    ],
    [
      "identity.service_principals",
      "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND purpose = 'system' AND status = 'active'",
      [devFixtures.tenantA, devFixtures.workspaceA, ids.relayA],
      "status = 'disabled'"
    ],
    [
      "access.spaces",
      "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL",
      [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.rootSpaceA],
      "archived_at = clock_timestamp()"
    ],
    [
      "access.access_relationships",
      "tenant_id = $1 AND workspace_id = $2 AND subject_type = 'service_principal' AND subject_id = $3 AND resource_type = 'space' AND resource_id = $4 AND relation = 'manager' AND source = 'direct'",
      [devFixtures.tenantA, devFixtures.workspaceA, ids.relayA, devFixtures.rootSpaceA],
      "relation = 'owner'"
    ]
  ];
}

function relayCrossScopeAuthorityRows(): readonly RelayAuthorityRow[] {
  return [
    [
      "identity.tenants",
      "id = $1 AND status = 'active'",
      [devFixtures.tenantB],
      "status = 'suspended'"
    ],
    [
      "identity.workspaces",
      "tenant_id = $1 AND id = $2 AND status = 'active'",
      [devFixtures.tenantB, devFixtures.workspaceB],
      "status = 'archived'"
    ],
    [
      "identity.policy_versions",
      "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active'",
      [devFixtures.tenantB, devFixtures.workspaceB, DEV_POLICY_VERSION],
      "status = 'retired'"
    ],
    [
      "identity.service_principals",
      "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND purpose = 'system' AND status = 'active'",
      [devFixtures.tenantB, devFixtures.workspaceB, ids.relayB],
      "status = 'disabled'"
    ],
    [
      "access.spaces",
      "tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL",
      [devFixtures.tenantB, devFixtures.workspaceB, devFixtures.rootSpaceB],
      "archived_at = clock_timestamp()"
    ],
    [
      "access.access_relationships",
      "tenant_id = $1 AND workspace_id = $2 AND subject_type = 'service_principal' AND subject_id = $3 AND resource_type = 'space' AND resource_id = $4 AND relation = 'manager' AND source = 'direct'",
      [devFixtures.tenantB, devFixtures.workspaceB, ids.relayB, devFixtures.rootSpaceB],
      "relation = 'owner'"
    ]
  ];
}

async function relayAuthoritySnapshot(pool: pg.Pool): Promise<Record<string, unknown>[]> {
  const snapshot = await pool.query<Record<string, unknown>>(`
    SELECT 'identity.tenants' AS table_name, id::text, status::text AS mutable_value
    FROM identity.tenants WHERE id = '${devFixtures.tenantA}'
    UNION ALL
    SELECT 'identity.workspaces', id::text, status::text
    FROM identity.workspaces WHERE id = '${devFixtures.workspaceA}'
    UNION ALL
    SELECT 'identity.policy_versions', id::text, status::text
    FROM identity.policy_versions
    WHERE tenant_id = '${devFixtures.tenantA}' AND workspace_id = '${devFixtures.workspaceA}'
      AND id = '${DEV_POLICY_VERSION}'
    UNION ALL
    SELECT 'identity.service_principals', id::text, status::text
    FROM identity.service_principals WHERE id = '${ids.relayA}'
    UNION ALL
    SELECT 'access.spaces', id::text, coalesce(archived_at::text, '<null>')
    FROM access.spaces WHERE id = '${devFixtures.rootSpaceA}'
    UNION ALL
    SELECT 'access.access_relationships', id::text, relation::text
    FROM access.access_relationships
    WHERE tenant_id = '${devFixtures.tenantA}' AND workspace_id = '${devFixtures.workspaceA}'
      AND subject_type = 'service_principal' AND subject_id = '${ids.relayA}'
      AND resource_type = 'space' AND resource_id = '${devFixtures.rootSpaceA}'
      AND source = 'direct'
    ORDER BY table_name
  `);
  return snapshot.rows;
}

async function relationDigest(pool: pg.Pool, table: string): Promise<string> {
  const result = await pool.query<{ digest: string }>(`
    SELECT encode(
      digest(
        coalesce(jsonb_agg(to_jsonb(authority_row) ORDER BY to_jsonb(authority_row)::text)::text, '[]'),
        'sha256'
      ),
      'hex'
    ) AS digest
    FROM ${table} AS authority_row
  `);
  return result.rows[0]!.digest;
}

async function authorityColumnNames(pool: pg.Pool, table: string): Promise<string[]> {
  const [schema, relation] = table.split(".") as [string, string];
  const result = await pool.query<{ columnName: string }>(
    `SELECT attribute.attname AS "columnName"
     FROM pg_attribute AS attribute
     WHERE attribute.attrelid = format('%I.%I', $1::text, $2::text)::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
     ORDER BY attribute.attnum`,
    [schema, relation]
  );
  return result.rows.map(({ columnName }) => columnName);
}

async function expectRelayStatementDenied(
  pool: pg.Pool,
  sql: string,
  parameters: readonly unknown[],
  settings: ScopeSettings
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    await expect(client.query(sql, [...parameters]), sql).rejects.toMatchObject({ code: "42501" });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  await expect(pool.query("SELECT 1 AS reusable")).resolves.toMatchObject({
    rows: [{ reusable: 1 }]
  });
}

async function expectRelayLockRows(
  pool: pg.Pool,
  table: string,
  predicate: string,
  values: readonly string[],
  settings: ScopeSettings,
  expectedRows: number
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    const result = await client.query(`SELECT id FROM ${table} WHERE ${predicate} FOR SHARE`, [
      ...values
    ]);
    expect(result.rowCount, table).toBe(expectedRows);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

type RelaySettingKey =
  | "tenantId"
  | "workspaceId"
  | "spaceId"
  | "servicePrincipalId"
  | "policyVersion";

function relayRequiredSettings(table: string): readonly RelaySettingKey[] {
  if (table === "identity.tenants") return ["tenantId"];
  if (table === "identity.workspaces") return ["tenantId", "workspaceId"];
  if (table === "identity.policy_versions") {
    return ["tenantId", "workspaceId", "policyVersion"];
  }
  if (table === "identity.service_principals") {
    return ["tenantId", "workspaceId", "servicePrincipalId"];
  }
  if (table === "access.spaces") return ["tenantId", "workspaceId", "spaceId"];
  return ["tenantId", "workspaceId", "spaceId", "servicePrincipalId"];
}

function wrongRelaySetting(key: RelaySettingKey): string {
  const wrong = {
    tenantId: devFixtures.tenantB,
    workspaceId: devFixtures.workspaceB,
    spaceId: devFixtures.rootSpaceB,
    servicePrincipalId: ids.relayB,
    policyVersion: "stale-policy-v0"
  } satisfies Record<RelaySettingKey, string>;
  return wrong[key];
}

async function expectMalformedRelayContextClosed(
  pool: pg.Pool,
  table: string,
  predicate: string,
  values: readonly string[],
  key: RelaySettingKey,
  settings: ScopeSettings
): Promise<void> {
  const settingNames = {
    tenantId: "app.tenant_id",
    workspaceId: "app.workspace_id",
    spaceId: "app.space_id",
    servicePrincipalId: "app.service_principal_id",
    policyVersion: "app.policy_version"
  } satisfies Record<RelaySettingKey, string>;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    await client.query("SELECT set_config($1, $2, true)", [
      settingNames[key],
      key === "policyVersion" ? "malformed-policy" : "not-a-uuid"
    ]);
    try {
      const result = await client.query(`SELECT id FROM ${table} WHERE ${predicate} FOR SHARE`, [
        ...values
      ]);
      expect(result.rows, `${table}: ${key}`).toEqual([]);
    } catch (error) {
      expect(error, `${table}: ${key}`).toMatchObject({ code: "22P02" });
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function setRelayAuthorityLiveState(
  pool: pg.Pool,
  table: string,
  active: boolean
): Promise<void> {
  const mutations: Record<string, readonly [string, readonly unknown[]]> = {
    "identity.tenants": [
      "UPDATE identity.tenants SET status = $2 WHERE id = $1",
      [devFixtures.tenantA, active ? "active" : "suspended"]
    ],
    "identity.workspaces": [
      "UPDATE identity.workspaces SET status = $2 WHERE id = $1",
      [devFixtures.workspaceA, active ? "active" : "archived"]
    ],
    "identity.policy_versions": [
      `UPDATE identity.policy_versions SET status = $4
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        DEV_POLICY_VERSION,
        active ? "active" : "retired"
      ]
    ],
    "identity.service_principals": [
      "UPDATE identity.service_principals SET status = $2 WHERE id = $1",
      [ids.relayA, active ? "active" : "disabled"]
    ],
    "access.spaces": [
      `UPDATE access.spaces
       SET archived_at = CASE WHEN $2::boolean THEN NULL ELSE clock_timestamp() END
       WHERE id = $1`,
      [devFixtures.rootSpaceA, active]
    ],
    "access.access_relationships": [
      `UPDATE access.access_relationships SET relation = $5
       WHERE tenant_id = $1 AND workspace_id = $2
         AND subject_type = 'service_principal' AND subject_id = $3
         AND resource_type = 'space' AND resource_id = $4 AND source = 'direct'`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        ids.relayA,
        devFixtures.rootSpaceA,
        active ? "manager" : "owner"
      ]
    ]
  };
  const mutation = mutations[table];
  if (!mutation) throw new Error(`Unknown relay authority table: ${table}`);
  const result = await pool.query(mutation[0], [...mutation[1]]);
  expect(result.rowCount, `${table}: live=${active}`).toBe(1);
}

async function waitForBlockedBackend(pool: pg.Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blockers: number[] }>(
      "SELECT pg_blocking_pids($1)::integer[] AS blockers",
      [pid]
    );
    if ((result.rows[0]?.blockers.length ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not expose the expected tuple-lock blocker`);
}

function normalizePolicyExpression(expression: string | null | undefined): string {
  return (expression ?? "")
    .toLowerCase()
    .replace(/::(?:text|name)\b/g, "")
    .replace(/[()\s]/g, "");
}

async function setLocal(client: pg.PoolClient, settings: ScopeSettings): Promise<void> {
  const pairs: Array<[string, string | undefined]> = [
    ["app.tenant_id", settings.tenantId],
    ["app.workspace_id", settings.workspaceId],
    ["app.space_id", settings.spaceId],
    ["app.service_principal_id", settings.servicePrincipalId],
    ["app.policy_version", settings.policyVersion],
    ["app.job_id", settings.jobId],
    ["app.context_reference_id", settings.referenceId],
    ["app.worker_principal_id", settings.workerPrincipalId],
    ["app.user_id", settings.userId],
    ["app.membership_id", settings.membershipId],
    ["app.handler_key", settings.handlerKey],
    ["app.aggregate_id", settings.aggregateId],
    ["app.aggregate_version", settings.aggregateVersion],
    ["app.effect_hash", settings.effectHash]
  ];
  for (const [name, value] of pairs)
    await client.query("SELECT set_config($1, $2, true)", [name, value ?? ""]);
}

function workerAuthoritySettings(): ScopeSettings {
  return {
    tenantId: devFixtures.tenantA,
    workspaceId: devFixtures.workspaceA,
    spaceId: devFixtures.rootSpaceA,
    userId: ids.delegatorUserA,
    membershipId: ids.delegatorMembershipA,
    jobId: ids.jobA,
    referenceId: ids.referenceA,
    workerPrincipalId: ids.workerA,
    policyVersion: DEV_POLICY_VERSION
  };
}

async function waitForActiveBackend(pool: pg.Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active'
       ) AS active`,
      [pid]
    );
    if (result.rows[0]?.active) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${pid} did not become active`);
}

async function scopedRelayEventIds(pool: pg.Pool, settings: ScopeSettings): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    const result = await client.query<{ id: string }>(
      "SELECT id FROM ops.outbox_events ORDER BY id"
    );
    await client.query("ROLLBACK");
    return result.rows.map(({ id }) => id);
  } finally {
    client.release();
  }
}

async function scopedWorkerReferenceIds(pool: pg.Pool, settings: ScopeSettings): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    const result = await client.query<{ id: string }>(
      "SELECT id FROM ops.security_context_references ORDER BY id"
    );
    await client.query("ROLLBACK");
    return result.rows.map(({ id }) => id);
  } finally {
    client.release();
  }
}

async function expectAppInsertDenied(
  pool: pg.Pool,
  statement: string,
  values: unknown[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, {
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.rootSpaceA
    });
    await expect(client.query(statement, values)).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}
