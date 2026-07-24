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

const truthTables = ["accepted_facts", "claims", "fact_claims", "verified_evidence_spans"] as const;

const truthColumns = {
  accepted_facts: [
    "id",
    "tenant_id",
    "workspace_id",
    "space_id",
    "subject_type",
    "subject_id",
    "predicate_catalog_version",
    "predicate",
    "value_json",
    "value_hash",
    "normalized_text",
    "confidence",
    "confidence_rule",
    "strongest_supporting_confidence",
    "human_lowered",
    "confidence_lowering_reason_code",
    "confidence_lowering_rationale",
    "valid_from",
    "valid_to",
    "recorded_at",
    "status",
    "access_class",
    "accepted_by_user_id",
    "accepted_by_membership_id",
    "acceptance_scope",
    "authority_basis",
    "acceptance_policy_version",
    "last_causation_command_id",
    "created_at",
    "updated_at",
    "version"
  ],
  claims: [
    "id",
    "tenant_id",
    "workspace_id",
    "space_id",
    "subject_type",
    "subject_id",
    "predicate_catalog_version",
    "predicate",
    "value_json",
    "value_hash",
    "normalized_text",
    "verified_evidence_span_id",
    "asserted_by_type",
    "asserted_by_id",
    "confidence",
    "valid_from",
    "valid_to",
    "observed_at",
    "status",
    "access_class",
    "created_by_user_id",
    "created_by_membership_id",
    "causation_command_id",
    "created_at",
    "updated_at",
    "version"
  ],
  fact_claims: ["tenant_id", "workspace_id", "space_id", "fact_id", "claim_id", "created_at"],
  verified_evidence_spans: [
    "id",
    "tenant_id",
    "workspace_id",
    "space_id",
    "source_artifact_id",
    "source_chunk_id",
    "source_version",
    "chunk_version",
    "normalization_version",
    "chunking_version",
    "source_start_offset",
    "source_end_offset",
    "source_excerpt",
    "source_content_hash",
    "source_normalized_content_hash",
    "chunk_content_hash",
    "excerpt_hash",
    "access_class",
    "created_by_user_id",
    "created_by_membership_id",
    "causation_command_id",
    "created_at",
    "updated_at",
    "version"
  ]
} as const;

const truthFunctionIdentities = [
  "truth.enforce_claim_transition()",
  "truth.reject_mutation()",
  "truth.require_fact_accept_reservation()",
  "truth.require_reserved_command()",
  "truth.validate_claim_insert()",
  "truth.validate_fact_insert()",
  "truth.validate_fact_support()",
  "truth.verify_evidence_snapshot()"
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
  await validateTruthColumnsAndConstraints(client);
  await validateTruthPolicies(client, phase);
  await validateTruthSecurity(client, phase);
  await validateTruthFunctions(client, migrationSources.get(B2_MIGRATION_IDS[0])!);
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
    "command_effects",
    "fact_lifecycle_events",
    "reconcile_source_retention",
    "source_artifacts_truth_retention",
    "b2_retention_command",
    "retention_update",
    "redacted_at",
    "redaction_command_id",
    "redaction_source_artifact_id",
    "hash_disposition",
    "status IN ('proposed','accepted','rejected')",
    "status IN ('current','revoked')"
  ]) {
    if (schema.includes(forbidden) || integrity.includes(forbidden)) {
      throw new Error(`B2 Slice 1 migration contains future persistence: ${forbidden}`);
    }
  }
  if (schema.includes("truth.access_class_rank") || !schema.includes("content.access_class_rank")) {
    throw new Error("B2 Slice 1 must reuse the sealed canonical access-class lattice");
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

async function validateTruthColumnsAndConstraints(client: PgPoolClient): Promise<void> {
  const columns = await client.query<{ table_name: string; columns: string[] }>(
    `SELECT relation.relname AS table_name,
            array_agg(attribute.attname::text ORDER BY attribute.attnum) AS columns
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'truth'
        AND relation.relkind = 'r'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      GROUP BY relation.relname
      ORDER BY relation.relname`
  );
  const expectedColumns = truthTables.map((table_name) => ({
    table_name,
    columns: [...truthColumns[table_name]]
  }));
  if (JSON.stringify(columns.rows) !== JSON.stringify(expectedColumns)) {
    throw new Error("B2 Slice 1 truth column inventory drifted");
  }

  const constraints = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(constraint_record.oid, false) AS definition
       FROM pg_constraint constraint_record
       JOIN pg_class relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth'
      ORDER BY relation.relname, constraint_record.conname`
  );
  const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
  for (const forbidden of ["rejected", "revoked", "redacted", "hash_disposition"]) {
    if (definitions.includes(forbidden)) {
      throw new Error(`B2 Slice 1 truth constraint contains future state ${forbidden}`);
    }
  }
  for (const required of [
    "strongest-selected-valid-claim.v1",
    "conservative_human_judgment",
    "evidence_quality",
    "residual_uncertainty",
    "'proposed'::text",
    "'accepted'::text",
    "status = 'current'::text"
  ]) {
    if (!definitions.includes(required)) {
      throw new Error(`B2 Slice 1 truth constraint omits ${required}`);
    }
  }
}

async function validateTruthPolicies(client: PgPoolClient, phase: number): Promise<void> {
  const result = await client.query<{
    policy_name: string;
    table_name: string;
    operation: string;
    permissive: boolean;
    roles: string[];
    using_expression: string | null;
    check_expression: string | null;
  }>(
    `SELECT policy.polname AS policy_name, relation.relname AS table_name,
            policy.polcmd::text AS operation, policy.polpermissive AS permissive,
            ARRAY(
              SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END
                FROM unnest(policy.polroles) role_oid
               ORDER BY 1
            ) AS roles,
            pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
            pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
       FROM pg_policy policy
       JOIN pg_class relation ON relation.oid = policy.polrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth'
      ORDER BY relation.relname, policy.polname`
  );
  const expectedPolicies = [
    ["accepted_facts_insert", "accepted_facts", "a", "throughline_app"],
    ["accepted_facts_select", "accepted_facts", "r", "throughline_app"],
    ...(phase === 2
      ? [["accepted_facts_integrity_select", "accepted_facts", "r", "throughline_b1_0_integrity"]]
      : []),
    ["claims_insert", "claims", "a", "throughline_app"],
    ["claims_select", "claims", "r", "throughline_app"],
    ["claims_update", "claims", "w", "throughline_app"],
    ...(phase === 2
      ? [["claims_integrity_select", "claims", "r", "throughline_b1_0_integrity"]]
      : []),
    ["fact_claims_insert", "fact_claims", "a", "throughline_app"],
    ["fact_claims_select", "fact_claims", "r", "throughline_app"],
    ...(phase === 2
      ? [["fact_claims_integrity_select", "fact_claims", "r", "throughline_b1_0_integrity"]]
      : []),
    ["verified_evidence_insert", "verified_evidence_spans", "a", "throughline_app"],
    ["verified_evidence_select", "verified_evidence_spans", "r", "throughline_app"],
    ...(phase === 2
      ? [
          [
            "verified_evidence_integrity_select",
            "verified_evidence_spans",
            "r",
            "throughline_b1_0_integrity"
          ]
        ]
      : [])
  ]
    .map(([policy_name, table_name, operation, role]) => ({
      policy_name,
      table_name,
      operation,
      permissive: true,
      roles: [role]
    }))
    .sort((left, right) =>
      `${left.table_name}|${left.policy_name}`.localeCompare(
        `${right.table_name}|${right.policy_name}`
      )
    );
  const actualPolicies = result.rows.map((policy) => ({
    policy_name: policy.policy_name,
    table_name: policy.table_name,
    operation: policy.operation,
    permissive: policy.permissive,
    roles: policy.roles
  }));
  if (JSON.stringify(actualPolicies) !== JSON.stringify(expectedPolicies)) {
    throw new Error("B2 Slice 1 truth policy inventory drifted");
  }
  for (const policy of result.rows) {
    if (policy.roles[0] === "throughline_b1_0_integrity") {
      if (policy.using_expression !== "true" || policy.check_expression !== null) {
        throw new Error("B2 Slice 1 integrity truth policy is not read-only");
      }
      continue;
    }
    const expression = policy.operation === "r" ? policy.using_expression : policy.check_expression;
    if (
      !expression?.includes("tenant_id = ops.current_tenant_id()") ||
      !expression.includes("workspace_id = ops.current_workspace_id()") ||
      !expression.includes("access.can_read_space")
    ) {
      throw new Error(`B2 Slice 1 truth policy is incomplete for ${policy.policy_name}`);
    }
    if (policy.operation !== "r" && !expression.includes("space_id = ops.current_space_id()")) {
      throw new Error(`B2 Slice 1 truth write policy lost its current Space binding`);
    }
  }
}

async function validateTruthSecurity(client: PgPoolClient, phase: number): Promise<void> {
  const schemaPrivileges = await client.query<Record<string, unknown>>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                 ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            acl.privilege_type AS privilege,
            acl.is_grantable AS grantable
       FROM pg_namespace namespace
       CROSS JOIN LATERAL aclexplode(COALESCE(
         namespace.nspacl, acldefault('n', namespace.nspowner)
       )) acl
      WHERE namespace.nspname = 'truth'
        AND acl.grantee <> namespace.nspowner
      ORDER BY grantee, privilege, grantable`
  );
  const expectedSchemaPrivileges = [
    { grantee: "throughline_app", privilege: "USAGE", grantable: false },
    ...(phase === 2
      ? [{ grantee: "throughline_b1_0_integrity", privilege: "USAGE", grantable: false }]
      : [])
  ].sort((left, right) => left.grantee.localeCompare(right.grantee));
  if (JSON.stringify(schemaPrivileges.rows) !== JSON.stringify(expectedSchemaPrivileges)) {
    throw new Error("B2 Slice 1 truth schema authority drifted");
  }

  const tablePrivileges = await client.query<Record<string, unknown>>(
    `SELECT relation.relname AS table_name, 'table'::text AS scope,
            NULL::text AS column_name,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                 ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            acl.privilege_type AS privilege,
            acl.is_grantable AS grantable
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(
         relation.relacl, acldefault('r', relation.relowner)
       )) acl
      WHERE namespace.nspname = 'truth'
        AND relation.relkind = 'r'
        AND acl.grantee <> relation.relowner
      UNION ALL
     SELECT relation.relname AS table_name, 'column'::text AS scope,
            attribute.attname AS column_name,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                 ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            acl.privilege_type AS privilege,
            acl.is_grantable AS grantable
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(
         attribute.attacl, acldefault('c', relation.relowner)
       )) acl
      WHERE namespace.nspname = 'truth'
        AND relation.relkind = 'r'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl.grantee <> relation.relowner
      ORDER BY table_name, scope, column_name NULLS FIRST, grantee, privilege, grantable`
  );
  const expectedTablePrivileges: Array<Record<string, unknown>> = [];
  for (const table_name of truthTables) {
    for (const privilege of ["INSERT", "SELECT"]) {
      expectedTablePrivileges.push({
        table_name,
        scope: "table",
        column_name: null,
        grantee: "throughline_app",
        privilege,
        grantable: false
      });
    }
    if (phase === 2) {
      expectedTablePrivileges.push({
        table_name,
        scope: "table",
        column_name: null,
        grantee: "throughline_b1_0_integrity",
        privilege: "SELECT",
        grantable: false
      });
    }
  }
  for (const column_name of ["status", "updated_at", "version"]) {
    expectedTablePrivileges.push({
      table_name: "claims",
      scope: "column",
      column_name,
      grantee: "throughline_app",
      privilege: "UPDATE",
      grantable: false
    });
  }
  expectedTablePrivileges.sort((left, right) =>
    `${left.table_name}|${left.scope}|${left.column_name ?? ""}|${left.grantee}|${left.privilege}`.localeCompare(
      `${right.table_name}|${right.scope}|${right.column_name ?? ""}|${right.grantee}|${right.privilege}`
    )
  );
  if (JSON.stringify(tablePrivileges.rows) !== JSON.stringify(expectedTablePrivileges)) {
    throw new Error("B2 Slice 1 truth table authority drifted");
  }
}

async function validateTruthFunctions(client: PgPoolClient, schemaSource: string): Promise<void> {
  const inventory = await client.query<{ identity: string }>(
    `SELECT procedure.oid::regprocedure::text AS identity
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'truth'
      ORDER BY procedure.oid::regprocedure::text`
  );
  if (
    JSON.stringify(inventory.rows.map(({ identity }) => identity)) !==
    JSON.stringify(truthFunctionIdentities)
  ) {
    throw new Error("B2 Slice 1 truth function inventory drifted");
  }

  const inspectedIdentities = [...truthFunctionIdentities, "access.can_read_space(uuid,text)"];
  const functions = await client.query<Record<string, unknown>>(
    `SELECT procedure.oid::regprocedure::text AS identity,
            pg_get_function_result(procedure.oid) AS result,
            language.lanname AS language,
            CASE WHEN procedure.proowner = current_user::regrole THEN 'migration_owner'
                 ELSE pg_get_userbyid(procedure.proowner) END AS owner,
            procedure.prosecdef AS security_definer,
            procedure.proisstrict AS strict,
            procedure.provolatile::text AS volatility,
            procedure.proleakproof AS leakproof,
            procedure.proparallel::text AS parallel,
            procedure.prokind::text AS kind,
            COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration,
            procedure.prosrc AS source
       FROM pg_proc procedure
       JOIN pg_language language ON language.oid = procedure.prolang
      WHERE procedure.oid = ANY($1::regprocedure[])
      ORDER BY procedure.oid::regprocedure::text`,
    [inspectedIdentities]
  );
  const expectedFunctions = inspectedIdentities
    .map((identity) => {
      const accessFunction = identity === "access.can_read_space(uuid,text)";
      return {
        identity,
        result: accessFunction ? "boolean" : "trigger",
        language: accessFunction ? "sql" : "plpgsql",
        owner: "migration_owner",
        security_definer: false,
        strict: false,
        volatility: accessFunction ? "s" : "v",
        leakproof: false,
        parallel: "u",
        kind: "f",
        configuration: ["search_path=pg_catalog"],
        source: migrationFunctionSource(
          schemaSource,
          accessFunction ? "access.can_read_space" : identity.slice(0, -2)
        )
      };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity));
  if (JSON.stringify(functions.rows) !== JSON.stringify(expectedFunctions)) {
    throw new Error("B2 Slice 1 truth function execution shape or source drifted");
  }

  const privileges = await client.query<Record<string, unknown>>(
    `SELECT procedure.oid::regprocedure::text AS identity,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                 ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            acl.privilege_type AS privilege,
            acl.is_grantable AS grantable,
            CASE WHEN acl.grantor = current_user::regrole THEN 'migration_owner'
                 ELSE pg_get_userbyid(acl.grantor) END AS grantor
       FROM pg_proc procedure
       CROSS JOIN LATERAL aclexplode(COALESCE(
         procedure.proacl, acldefault('f', procedure.proowner)
       )) acl
      WHERE procedure.oid = ANY($1::regprocedure[])
        AND acl.grantee <> procedure.proowner
      ORDER BY procedure.oid::regprocedure::text, grantee, privilege, grantable, grantor`,
    [inspectedIdentities]
  );
  if (
    JSON.stringify(privileges.rows) !==
    JSON.stringify([
      {
        identity: "access.can_read_space(uuid,text)",
        grantee: "throughline_app",
        privilege: "EXECUTE",
        grantable: false,
        grantor: "migration_owner"
      }
    ])
  ) {
    throw new Error("B2 Slice 1 truth function EXECUTE grants drifted");
  }

  const accessSource = functions.rows.find(
    (row) => row.identity === "access.can_read_space(uuid,text)"
  )?.source;
  if (
    typeof accessSource !== "string" ||
    !accessSource.includes("content.access_class_rank") ||
    accessSource.includes("truth.access_class_rank")
  ) {
    throw new Error("B2 Slice 1 access policy does not use the sealed canonical lattice");
  }
}

async function validateTruthConstraintsAndTriggers(client: PgPoolClient): Promise<void> {
  const expectedTriggers = [
    ["accepted_facts_command_guard", "accepted_facts", "truth.require_reserved_command()", false],
    ["accepted_facts_immutable", "accepted_facts", "truth.reject_mutation()", false],
    ["accepted_facts_insert_guard", "accepted_facts", "truth.validate_fact_insert()", false],
    ["accepted_facts_support_deferred", "accepted_facts", "truth.validate_fact_support()", true],
    ["claims_command_guard", "claims", "truth.require_reserved_command()", false],
    ["claims_delete_guard", "claims", "truth.reject_mutation()", false],
    ["claims_insert_guard", "claims", "truth.validate_claim_insert()", false],
    ["claims_transition_guard", "claims", "truth.enforce_claim_transition()", false],
    ["fact_claims_command_guard", "fact_claims", "truth.require_fact_accept_reservation()", false],
    ["fact_claims_immutable", "fact_claims", "truth.reject_mutation()", false],
    ["fact_claims_support_deferred", "fact_claims", "truth.validate_fact_support()", true],
    [
      "verified_evidence_command_guard",
      "verified_evidence_spans",
      "truth.require_reserved_command()",
      false
    ],
    ["verified_evidence_immutable", "verified_evidence_spans", "truth.reject_mutation()", false],
    [
      "verified_evidence_snapshot_guard",
      "verified_evidence_spans",
      "truth.verify_evidence_snapshot()",
      false
    ]
  ].map(([name, table_name, function_identity, deferred]) => ({
    name,
    table_name,
    function_identity,
    deferrable: deferred,
    initially_deferred: deferred
  }));
  const triggers = await client.query<Record<string, unknown>>(
    `SELECT trigger_record.tgname AS name, relation.relname AS table_name,
            procedure.oid::regprocedure::text AS function_identity,
            trigger_record.tgdeferrable AS deferrable,
            trigger_record.tginitdeferred AS initially_deferred
       FROM pg_trigger trigger_record
       JOIN pg_class relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
      WHERE namespace.nspname = 'truth' AND NOT trigger_record.tgisinternal
      ORDER BY trigger_record.tgname`
  );
  if (JSON.stringify(triggers.rows) !== JSON.stringify(expectedTriggers)) {
    throw new Error("B2 Slice 1 truth trigger inventory drifted");
  }
  const constraints = await client.query<{
    current_slot: string | null;
    fact_support_deferred: boolean;
    claim_support_deferred: boolean;
    source_truth_triggers: string;
    reconciliation_function: string | null;
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
       ) AS claim_support_deferred,
       (SELECT count(*)::text
          FROM pg_trigger trigger_record
          JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
         WHERE trigger_record.tgrelid = to_regclass('content.source_artifacts')
           AND NOT trigger_record.tgisinternal
           AND namespace.nspname = 'truth') AS source_truth_triggers,
       to_regprocedure('truth.reconcile_source_retention()')::text
         AS reconciliation_function`
  );
  if (
    !constraints.rows[0]?.current_slot ||
    !constraints.rows[0].fact_support_deferred ||
    !constraints.rows[0].claim_support_deferred ||
    constraints.rows[0].source_truth_triggers !== "0" ||
    constraints.rows[0].reconciliation_function !== null
  ) {
    throw new Error("B2 Slice 1 current-slot, support, or no-reconciliation boundary drifted");
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

function migrationFunctionSource(migrationSource: string, qualifiedName: string): string {
  const escapedName = qualifiedName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = migrationSource.match(
    new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION ${escapedName}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
    )
  )?.[1];
  if (source === undefined) {
    throw new Error(`Fixed B2 truth function source parser failed for ${qualifiedName}`);
  }
  return source;
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
