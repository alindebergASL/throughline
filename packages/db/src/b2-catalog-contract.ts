import type { PgPoolClient } from "./client.js";

export const B2_MIGRATION_IDS = [
  "0007_b2_slice1_truth_storage.sql",
  "0008_b2_slice1_command_integrity.sql"
] as const;

export type B2MigrationId = (typeof B2_MIGRATION_IDS)[number];

const fixedPredecessors = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql",
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql"
] as const;

const truthTables = [
  "accepted_facts",
  "claims",
  "fact_claims",
  "fact_lifecycle_events",
  "verified_evidence_spans"
] as const;

const b1CommandKinds = [
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
] as const;

const b2Slice1CommandKinds = ["claim.create.v1", "fact.accept.v1"] as const;

export async function assertB2MigrationStateAbsent(
  client: PgPoolClient,
  migrationId: B2MigrationId
): Promise<void> {
  const installed =
    migrationId === "0007_b2_slice1_truth_storage.sql"
      ? await client.query("SELECT to_regnamespace('truth')::text AS installed")
      : await client.query(
          "SELECT to_regprocedure('ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)')::text AS installed"
        );
  if (installed.rows[0]?.installed) {
    throw new Error(`B2 migration state already exists without journal row for ${migrationId}`);
  }
}

export async function validateB2CatalogContract(
  client: PgPoolClient,
  journal: ReadonlyMap<string, string>,
  migrationSources: ReadonlyMap<string, string>
): Promise<void> {
  for (const predecessor of fixedPredecessors) {
    if (!journal.has(predecessor)) {
      throw new Error("B2 migration journal is missing a fixed predecessor");
    }
  }
  const phase = B2_MIGRATION_IDS.filter((id) => journal.has(id)).length;
  if (B2_MIGRATION_IDS.some((id, index) => journal.has(id) !== index < phase)) {
    throw new Error("B2 migration journal is not an exact contiguous prefix");
  }
  if (phase === 0) return;

  assertNarrowMigrationSources(migrationSources, phase);
  await validateTruthTables(client);
  await validateTruthPolicies(client);
  await validateTruthSecurity(client);
  await validateTruthConstraintsAndTriggers(client);
  await validateCommandBoundary(client, phase);
}

function assertNarrowMigrationSources(
  migrationSources: ReadonlyMap<string, string>,
  phase: number
): void {
  const schema = migrationSources.get("0007_b2_slice1_truth_storage.sql");
  const integrity = migrationSources.get("0008_b2_slice1_command_integrity.sql");
  if (!schema || !integrity) throw new Error("Missing fixed B2 migration source");
  for (const table of truthTables) {
    if (!schema.includes(`CREATE TABLE truth.${table}`)) {
      throw new Error(`B2 truth schema omits ${table}`);
    }
  }
  for (const forbidden of [
    "fact_supersessions",
    "conflict_groups",
    "derived_view",
    "command_effects"
  ]) {
    if (schema.includes(forbidden) || integrity.includes(forbidden)) {
      throw new Error(`B2 Slice 1 migration contains future persistence: ${forbidden}`);
    }
  }
  if (phase === 2) {
    for (const kind of b2Slice1CommandKinds) {
      if (!integrity.includes(`'${kind}'`)) {
        throw new Error(`B2 Slice 1 command catalog omits ${kind}`);
      }
    }
    for (const forbidden of [
      "fact.contest.v1",
      "fact.uphold.v1",
      "fact.supersede.v1",
      "fact.revoke.v1",
      "fact.emergency_contest.v1",
      "fact.emergency_revoke.v1",
      "derived_view.regenerate.v1"
    ]) {
      if (integrity.includes(forbidden)) {
        throw new Error(`B2 Slice 1 command catalog executes future kind ${forbidden}`);
      }
    }
  }
}

async function validateTruthTables(client: PgPoolClient): Promise<void> {
  const result = await client.query<{
    name: string;
    rls: boolean;
    forced_rls: boolean;
    persistence: string;
  }>(
    `SELECT relation.relname AS name, relation.relrowsecurity AS rls,
            relation.relforcerowsecurity AS forced_rls,
            relation.relpersistence::text AS persistence
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth' AND relation.relkind = 'r'
      ORDER BY relation.relname`
  );
  if (
    result.rows.length !== truthTables.length ||
    result.rows.some(
      (row, index) =>
        row.name !== truthTables[index] || !row.rls || !row.forced_rls || row.persistence !== "p"
    )
  ) {
    throw new Error("B2 Slice 1 truth table inventory or forced RLS drifted");
  }
}

async function validateTruthPolicies(client: PgPoolClient): Promise<void> {
  const result = await client.query<{
    table_name: string;
    operation: string;
    using_expression: string | null;
    check_expression: string | null;
  }>(
    `SELECT tablename AS table_name, cmd AS operation, qual AS using_expression,
            with_check AS check_expression
       FROM pg_policies
      WHERE schemaname = 'truth' AND roles = '{throughline_app}'
      ORDER BY tablename, cmd`
  );
  for (const table of truthTables) {
    const select = result.rows.find(
      (policy) => policy.table_name === table && policy.operation === "SELECT"
    );
    const insert = result.rows.find(
      (policy) => policy.table_name === table && policy.operation === "INSERT"
    );
    if (
      !select?.using_expression?.includes("access.can_read_space") ||
      !insert?.check_expression?.includes("access.can_read_space") ||
      !insert.check_expression.includes("space_id = ops.current_space_id()")
    ) {
      throw new Error(`B2 Slice 1 truth policy is incomplete for ${table}`);
    }
  }
}

async function validateTruthSecurity(client: PgPoolClient): Promise<void> {
  const result = await client.query<{
    public_table_privileges: string;
    public_schema_privileges: string;
    relay_read: boolean;
    worker_read: boolean;
    product_relay_read: boolean;
    app_can_read_space: boolean;
    public_can_read_space: boolean;
  }>(
    `WITH public_table_privileges AS (
       SELECT 1
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(
         relation.relacl, acldefault('r', relation.relowner)
       )) acl_record
       WHERE namespace.nspname = 'truth'
         AND relation.relkind = 'r'
         AND acl_record.grantee = 0
       UNION ALL
       SELECT 1
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(
         attribute.attacl, acldefault('c', relation.relowner)
       )) acl_record
       WHERE namespace.nspname = 'truth'
         AND relation.relkind = 'r'
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl_record.grantee = 0
     )
     SELECT
       (SELECT count(*)::text FROM public_table_privileges) AS public_table_privileges,
       (SELECT count(*)::text
          FROM pg_namespace namespace
          CROSS JOIN LATERAL aclexplode(COALESCE(
            namespace.nspacl, acldefault('n', namespace.nspowner)
          )) acl_record
         WHERE namespace.nspname = 'truth'
           AND acl_record.grantee = 0) AS public_schema_privileges,
       has_table_privilege(
         'throughline_relay','truth.accepted_facts','SELECT'
       ) AS relay_read,
       has_table_privilege(
         'throughline_worker','truth.accepted_facts','SELECT'
       ) AS worker_read,
       has_table_privilege(
         'throughline_product_relay','truth.claims','SELECT'
       ) AS product_relay_read,
       has_function_privilege(
         'throughline_app','access.can_read_space(uuid,text)','EXECUTE'
       ) AS app_can_read_space,
       EXISTS (
         SELECT 1
         FROM pg_proc procedure
         CROSS JOIN LATERAL aclexplode(COALESCE(
           procedure.proacl, acldefault('f', procedure.proowner)
         )) acl_record
         WHERE procedure.oid = to_regprocedure('access.can_read_space(uuid,text)')
           AND acl_record.grantee = 0
           AND acl_record.privilege_type = 'EXECUTE'
       ) AS public_can_read_space`
  );
  const row = result.rows[0];
  if (
    !row ||
    row.public_table_privileges !== "0" ||
    row.public_schema_privileges !== "0" ||
    row.relay_read ||
    row.worker_read ||
    row.product_relay_read ||
    !row.app_can_read_space ||
    row.public_can_read_space
  ) {
    throw new Error("B2 Slice 1 truth role isolation drifted");
  }
}

async function validateTruthConstraintsAndTriggers(client: PgPoolClient): Promise<void> {
  const expectedTriggers = [
    "accepted_facts_command_guard",
    "accepted_facts_insert_guard",
    "accepted_facts_retention_guard",
    "accepted_facts_support_deferred",
    "claims_command_guard",
    "claims_delete_guard",
    "claims_insert_guard",
    "claims_transition_guard",
    "fact_claims_command_guard",
    "fact_claims_immutable",
    "fact_claims_support_deferred",
    "fact_lifecycle_command_guard",
    "fact_lifecycle_events_immutable",
    "fact_lifecycle_insert_guard",
    "verified_evidence_command_guard",
    "verified_evidence_retention_guard",
    "verified_evidence_snapshot_guard"
  ];
  const triggers = await client.query<{ name: string }>(
    `SELECT trigger_record.tgname AS name
       FROM pg_trigger trigger_record
       JOIN pg_class relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth' AND NOT trigger_record.tgisinternal
      ORDER BY trigger_record.tgname`
  );
  if (
    triggers.rows.length !== expectedTriggers.length ||
    triggers.rows.some((row, index) => row.name !== expectedTriggers[index])
  ) {
    throw new Error("B2 Slice 1 truth trigger inventory drifted");
  }
  const constraints = await client.query<{
    current_slot: string | null;
    fact_support_deferred: boolean;
    claim_support_deferred: boolean;
  }>(
    `SELECT
       to_regclass('truth.accepted_facts_one_current_slot')::text AS current_slot,
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass('truth.accepted_facts')
            AND tgname = 'accepted_facts_support_deferred'
            AND tgdeferrable AND tginitdeferred
       ) AS fact_support_deferred,
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass('truth.fact_claims')
            AND tgname = 'fact_claims_support_deferred'
            AND tgdeferrable AND tginitdeferred
       ) AS claim_support_deferred`
  );
  if (
    !constraints.rows[0]?.current_slot ||
    !constraints.rows[0].fact_support_deferred ||
    !constraints.rows[0].claim_support_deferred
  ) {
    throw new Error("B2 Slice 1 current-slot or support constraint drifted");
  }

  const retention = await client.query<{
    trigger_name: string | null;
    function_owner: string | null;
    command_context_read: boolean;
    public_execute: boolean;
  }>(
    `SELECT
       (SELECT trigger_record.tgname
          FROM pg_trigger trigger_record
         WHERE trigger_record.tgrelid = to_regclass('content.source_artifacts')
           AND trigger_record.tgname = 'source_artifacts_truth_retention'
           AND NOT trigger_record.tgisinternal) AS trigger_name,
       (SELECT pg_get_userbyid(procedure.proowner)
          FROM pg_proc procedure
         WHERE procedure.oid = to_regprocedure(
           'truth.reconcile_source_retention()'
         )) AS function_owner,
       has_column_privilege(
         'throughline_b1_0_integrity','ops.domain_command_records',
         'reservation_space_id','SELECT'
       ) AND has_column_privilege(
         'throughline_b1_0_integrity','ops.domain_command_records',
         'command_kind','SELECT'
       ) AND has_column_privilege(
         'throughline_b1_0_integrity','ops.domain_command_records',
         'actor_user_id','SELECT'
       ) AND has_column_privilege(
         'throughline_b1_0_integrity','ops.domain_command_records',
         'actor_membership_id','SELECT'
       ) AND has_column_privilege(
         'throughline_b1_0_integrity','ops.domain_command_records',
         'policy_version_id','SELECT'
       ) AS command_context_read,
       EXISTS (
         SELECT 1
         FROM pg_proc procedure
         CROSS JOIN LATERAL aclexplode(COALESCE(
           procedure.proacl, acldefault('f', procedure.proowner)
         )) acl_record
         WHERE procedure.oid = to_regprocedure('truth.reconcile_source_retention()')
           AND acl_record.grantee = 0
           AND acl_record.privilege_type = 'EXECUTE'
       ) AS public_execute`
  );
  if (
    retention.rows[0]?.trigger_name !== "source_artifacts_truth_retention" ||
    retention.rows[0].function_owner !== "throughline_b1_0_integrity" ||
    !retention.rows[0].command_context_read ||
    retention.rows[0].public_execute
  ) {
    throw new Error("B2 Slice 1 source-retention reconciliation boundary drifted");
  }
}

async function validateCommandBoundary(client: PgPoolClient, phase: number): Promise<void> {
  const boundary = await client.query<{
    b1_constraint: string | null;
    product_constraint: string | null;
    b1_trigger: string | null;
    b2_trigger: string | null;
    product_validator: string | null;
    b2_atomicity: string | null;
  }>(
    `SELECT
       (SELECT conname FROM pg_constraint
         WHERE conrelid = to_regclass('ops.domain_command_records')
           AND conname = 'domain_command_records_b1_shape_check') AS b1_constraint,
       (SELECT conname FROM pg_constraint
         WHERE conrelid = to_regclass('ops.domain_command_records')
           AND conname = 'domain_command_records_product_shape_check') AS product_constraint,
       (SELECT tgname FROM pg_trigger
         WHERE tgrelid = to_regclass('ops.domain_command_records')
           AND tgname = 'domain_command_records_b1_atomicity_deferred'
           AND NOT tgisinternal) AS b1_trigger,
       (SELECT tgname FROM pg_trigger
         WHERE tgrelid = to_regclass('ops.domain_command_records')
           AND tgname = 'domain_command_records_b2_slice1_atomicity_deferred'
           AND NOT tgisinternal) AS b2_trigger,
       to_regprocedure(
         'ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)'
       )::text AS product_validator,
       to_regprocedure('ops.require_b2_slice1_command_atomicity()')::text AS b2_atomicity`
  );
  const row = boundary.rows[0];
  if (phase === 1) {
    if (
      row?.b1_constraint !== "domain_command_records_b1_shape_check" ||
      row.b1_trigger !== "domain_command_records_b1_atomicity_deferred" ||
      row.product_constraint !== null ||
      row.b2_trigger !== null ||
      row.product_validator !== null ||
      row.b2_atomicity !== null
    ) {
      throw new Error("B2 schema phase changed the sealed B1 command boundary");
    }
    return;
  }
  if (
    row?.b1_constraint !== null ||
    row?.product_constraint !== "domain_command_records_product_shape_check" ||
    row?.b1_trigger !== "domain_command_records_b1_atomicity_deferred" ||
    row?.b2_trigger !== "domain_command_records_b2_slice1_atomicity_deferred" ||
    !row.product_validator ||
    !row.b2_atomicity
  ) {
    throw new Error("B2 Slice 1 product command boundary is incomplete");
  }

  const validator = await client.query<{ definition: string }>(
    `SELECT pg_get_functiondef(
       'ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)'::regprocedure
     ) AS definition`
  );
  assertProductValidatorDelegatesExactB1Kinds(validator.rows[0]?.definition ?? "");
  await validateCommandFunctionSecurity(client);
  const probes = await client.query<{
    b1_valid: boolean;
    claim_valid: boolean;
    fact_valid: boolean;
    future_invalid: boolean;
    malformed_invalid: boolean;
  }>(
    `SELECT
       ops.product_command_record_valid(
         'relationship.create.v1', 1, 'completed', 'relationship',
         '0190a000-0000-7000-8000-000000000301'::uuid,
         '{"relationshipId":"0190a000-0000-7000-8000-000000000301",
           "spaceId":"11111111-1111-4111-8111-111111111114","version":1}'::jsonb
       ) AS b1_valid,
       ops.product_command_record_valid(
         'claim.create.v1', 1, 'completed', 'claim',
         '0190a000-0000-7000-8000-000000000302'::uuid,
         '{"claimId":"0190a000-0000-7000-8000-000000000302",
           "status":"proposed","version":1}'::jsonb
       ) AS claim_valid,
       ops.product_command_record_valid(
         'fact.accept.v1', 1, 'completed', 'accepted_fact',
         '0190a000-0000-7000-8000-000000000303'::uuid,
         '{"acceptedClaimIds":["0190a000-0000-7000-8000-000000000302"],
           "factId":"0190a000-0000-7000-8000-000000000303",
           "status":"current","version":1}'::jsonb
       ) AS fact_valid,
       NOT ops.product_command_record_valid(
         'fact.revoke.v1', 1, 'reserved', NULL, NULL, NULL
       ) AS future_invalid,
       NOT ops.product_command_record_valid(
         'claim.create.v1', 1, 'completed', 'claim',
         '0190a000-0000-7000-8000-000000000302'::uuid,
         '{"claimId":"0190a000-0000-7000-8000-000000000302",
           "status":"proposed","version":1,"extra":true}'::jsonb
       ) AS malformed_invalid`
  );
  const probe = probes.rows[0];
  if (
    !probe?.b1_valid ||
    !probe.claim_valid ||
    !probe.fact_valid ||
    !probe.future_invalid ||
    !probe.malformed_invalid
  ) {
    throw new Error("B2 Slice 1 product command shape validator drifted");
  }
}

async function validateCommandFunctionSecurity(client: PgPoolClient): Promise<void> {
  const functionIdentities = [
    "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)",
    "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)",
    "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)",
    "ops.require_b2_slice1_command_atomicity()"
  ] as const;
  const functions = await client.query<Record<string, unknown>>(
    `SELECT procedure.oid::regprocedure::text AS identity,
            pg_get_function_result(procedure.oid) AS result,
            language.lanname AS language,
            CASE
              WHEN procedure.proowner = current_user::regrole THEN 'migration_owner'
              ELSE pg_get_userbyid(procedure.proowner)
            END AS owner,
            procedure.prosecdef AS security_definer,
            procedure.proisstrict AS strict,
            procedure.provolatile::text AS volatility,
            procedure.proleakproof AS leakproof,
            procedure.proparallel::text AS parallel,
            procedure.prokind::text AS kind,
            COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration
       FROM pg_proc procedure
       JOIN pg_language language ON language.oid = procedure.prolang
      WHERE procedure.oid = ANY($1::regprocedure[])
      ORDER BY procedure.oid::regprocedure::text`,
    [[...functionIdentities]]
  );
  const searchPath = ["search_path=pg_catalog"];
  const expectedFunctions = [
    {
      identity: functionIdentities[0],
      result: "boolean",
      language: "plpgsql",
      owner: "migration_owner",
      security_definer: false,
      strict: true,
      volatility: "i",
      leakproof: false,
      parallel: "u",
      kind: "f",
      configuration: searchPath
    },
    {
      identity: functionIdentities[1],
      result: "boolean",
      language: "plpgsql",
      owner: "migration_owner",
      security_definer: false,
      strict: true,
      volatility: "i",
      leakproof: false,
      parallel: "u",
      kind: "f",
      configuration: searchPath
    },
    {
      identity: functionIdentities[2],
      result: "boolean",
      language: "plpgsql",
      owner: "migration_owner",
      security_definer: false,
      strict: false,
      volatility: "i",
      leakproof: false,
      parallel: "u",
      kind: "f",
      configuration: searchPath
    },
    {
      identity: functionIdentities[3],
      result: "trigger",
      language: "plpgsql",
      owner: "throughline_b1_0_integrity",
      security_definer: true,
      strict: false,
      volatility: "v",
      leakproof: false,
      parallel: "u",
      kind: "f",
      configuration: searchPath
    }
  ];
  if (JSON.stringify(functions.rows) !== JSON.stringify(expectedFunctions)) {
    throw new Error("B2 Slice 1 command function ownership or execution shape drifted");
  }

  const privileges = await client.query<Record<string, unknown>>(
    `SELECT procedure.oid::regprocedure::text AS identity,
            CASE
              WHEN acl_record.grantee = 0 THEN 'PUBLIC'
              ELSE pg_get_userbyid(acl_record.grantee)
            END AS grantee,
            acl_record.privilege_type AS privilege,
            acl_record.is_grantable AS grantable,
            CASE
              WHEN acl_record.grantor = current_user::regrole THEN 'migration_owner'
              ELSE pg_get_userbyid(acl_record.grantor)
            END AS grantor
       FROM pg_proc procedure
       CROSS JOIN LATERAL aclexplode(COALESCE(
         procedure.proacl, acldefault('f', procedure.proowner)
       )) acl_record
      WHERE procedure.oid = ANY($1::regprocedure[])
        AND acl_record.grantee <> procedure.proowner
      ORDER BY procedure.oid::regprocedure::text, grantee, privilege, grantable, grantor`,
    [[...functionIdentities]]
  );
  const expectedPrivileges = [
    {
      identity: functionIdentities[0],
      grantee: "throughline_app",
      privilege: "EXECUTE",
      grantable: false,
      grantor: "migration_owner"
    },
    {
      identity: functionIdentities[1],
      grantee: "throughline_app",
      privilege: "EXECUTE",
      grantable: false,
      grantor: "migration_owner"
    },
    {
      identity: functionIdentities[1],
      grantee: "throughline_product_relay",
      privilege: "EXECUTE",
      grantable: false,
      grantor: "migration_owner"
    },
    {
      identity: functionIdentities[2],
      grantee: "throughline_app",
      privilege: "EXECUTE",
      grantable: false,
      grantor: "migration_owner"
    }
  ];
  if (JSON.stringify(privileges.rows) !== JSON.stringify(expectedPrivileges)) {
    throw new Error("B2 Slice 1 command function EXECUTE grants drifted");
  }
}

export function assertProductValidatorDelegatesExactB1Kinds(definition: string): void {
  const delegation = definition.match(
    /IF\s+command_kind_value\s+IN\s*\(([\s\S]*?)\)\s*THEN\s+RETURN\s+ops\.b1_command_record_valid\s*\(/
  );
  const delegatedKinds = [...(delegation?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
    (match) => match[1]
  );
  if (JSON.stringify(delegatedKinds) !== JSON.stringify(b1CommandKinds)) {
    throw new Error("Product validator does not delegate the exact sealed B1 command catalog");
  }
}
