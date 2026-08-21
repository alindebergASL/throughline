import type { PgPoolClient } from "./client.js";
import {
  exactTruthCatalogForPhase,
  type ExactTruthCatalog,
  type ExactTruthPolicy,
  type ExactTruthRelation
} from "./b2-exact-catalog.js";

export const B2_MIGRATION_IDS = [
  "0007_b2_slice1_truth_storage.sql",
  "0008_b2_slice1_command_integrity.sql",
  "0009_b2_source_truth_lifecycle_interlock.sql",
  "0010_b2_trusted_objective_initiative_lock.sql",
  "0011_b2_primary_objective_proposal_recovery.sql",
  "0012_b2_fact_lifecycle.sql"
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
    "canonical_value_text",
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
    "canonical_value_text",
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
  fact_lifecycle_events: [
    "id",
    "tenant_id",
    "workspace_id",
    "space_id",
    "predecessor_fact_id",
    "successor_fact_id",
    "transition_kind",
    "from_status",
    "to_status",
    "reason_code",
    "reason_rationale",
    "authority_basis",
    "policy_version",
    "acted_by_user_id",
    "acted_by_membership_id",
    "causation_command_id",
    "recorded_at",
    "version"
  ],
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

const initiativeLockMigrationSource =
  "-- Established row-lock capability for durable Initiative truth mutations.\n" +
  "CREATE POLICY initiatives_app_truth_lock ON work.initiatives\n" +
  "AS PERMISSIVE FOR UPDATE TO throughline_app\n" +
  "USING (\n" +
  "  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()\n" +
  "  AND space_id = ops.current_space_id()\n" +
  "  AND EXISTS (\n" +
  "    SELECT 1 FROM access.spaces governing_space\n" +
  "    WHERE governing_space.tenant_id = work.initiatives.tenant_id\n" +
  "      AND governing_space.workspace_id = work.initiatives.workspace_id\n" +
  "      AND governing_space.id = work.initiatives.space_id\n" +
  "      AND governing_space.archived_at IS NULL\n" +
  "  )\n" +
  ")\n" +
  "WITH CHECK (false);\n\n" +
  "CREATE POLICY initiatives_app_permanent_no_write ON work.initiatives\n" +
  "AS RESTRICTIVE FOR UPDATE TO throughline_app\n" +
  "USING (true)\n" +
  "WITH CHECK (false);\n\n" +
  "GRANT UPDATE (id) ON work.initiatives TO throughline_app;\n";

export async function assertB2MigrationStateAbsent(
  client: PgPoolClient,
  migrationId: B2MigrationId
): Promise<void> {
  const installed =
    migrationId === "0007_b2_slice1_truth_storage.sql"
      ? await client.query("SELECT to_regnamespace('truth')::text AS installed")
      : migrationId === "0008_b2_slice1_command_integrity.sql"
        ? await client.query(
            "SELECT to_regprocedure('ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)')::text AS installed"
          )
        : migrationId === "0009_b2_source_truth_lifecycle_interlock.sql"
          ? await client.query(
              "SELECT to_regprocedure('ops.enforce_b2_source_truth_lifecycle_interlock()')::text AS installed"
            )
          : migrationId === "0010_b2_trusted_objective_initiative_lock.sql"
            ? await client.query(
                `SELECT
                 has_column_privilege(
                   'throughline_app','work.initiatives','id','UPDATE'
                 ) OR EXISTS (
                   SELECT 1 FROM pg_policy policy
                    WHERE policy.polrelid = to_regclass('work.initiatives')
                      AND policy.polname = ANY($1::text[])
                 ) AS installed`,
                [["initiatives_app_truth_lock", "initiatives_app_permanent_no_write"]]
              )
            : migrationId === "0011_b2_primary_objective_proposal_recovery.sql"
              ? await client.query(
                  "SELECT to_regclass('truth.initiative_objective_support_attestations')::text AS installed"
                )
              : await client.query(
                  "SELECT to_regclass('truth.fact_lifecycle_events')::text AS installed"
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
  const exactTruthCatalog = exactTruthCatalogForPhase(phase);
  if (phase >= 5) {
    await validateObjectiveRecoveryCatalog(
      client,
      migrationSources.get(B2_MIGRATION_IDS[4])!,
      phase
    );
  }
  const factLifecycleSource = migrationSources.get(B2_MIGRATION_IDS[5]);
  if (phase >= 6 && !factLifecycleSource) {
    throw new Error("Missing ordinary Fact lifecycle migration source");
  }
  await validateTruthTables(client, exactTruthCatalog.relations);
  await validateTruthColumnsAndConstraints(client, phase, exactTruthCatalog);
  await validateTruthPolicies(client, exactTruthCatalog.policies);
  await validateTruthSecurity(client, phase, exactTruthCatalog.relations);
  await validateTruthFunctions(
    client,
    migrationSources.get(B2_MIGRATION_IDS[0])!,
    migrationSources.get(B2_MIGRATION_IDS[2]),
    migrationSources.get(B2_MIGRATION_IDS[4]),
    factLifecycleSource,
    phase
  );
  await validateTruthConstraintsAndTriggers(client, phase);
  await validateCommandBoundary(
    client,
    migrationSources.get("0008_b2_slice1_command_integrity.sql")!,
    migrationSources.get("0009_b2_source_truth_lifecycle_interlock.sql"),
    migrationSources.get("0011_b2_primary_objective_proposal_recovery.sql"),
    factLifecycleSource,
    phase
  );
  if (phase >= 3) {
    await validateSourceTruthLifecycleInterlock(
      client,
      migrationSources.get("0009_b2_source_truth_lifecycle_interlock.sql")!
    );
  }
}

export function assertB2InitiativeLockMigrationSource(source: string): void {
  if (source !== initiativeLockMigrationSource) {
    throw new Error("B2 Initiative lock migration source drifted");
  }
}

function assertNarrowMigrationSources(
  migrationSources: ReadonlyMap<string, string>,
  phase: number
): void {
  const schema = migrationSources.get("0007_b2_slice1_truth_storage.sql");
  const integrity = migrationSources.get("0008_b2_slice1_command_integrity.sql");
  const lifecycle = migrationSources.get("0009_b2_source_truth_lifecycle_interlock.sql");
  const initiativeLock = migrationSources.get("0010_b2_trusted_objective_initiative_lock.sql");
  if (!schema || !integrity) throw new Error("Missing fixed B2 migration source");
  if (phase >= 3 && !lifecycle) {
    throw new Error("Missing fixed B2 lifecycle migration source");
  }
  if (phase >= 4) {
    if (!initiativeLock) throw new Error("Missing fixed B2 Initiative lock migration source");
    assertB2InitiativeLockMigrationSource(initiativeLock);
  }
  if (phase >= 5) {
    const recovery = migrationSources.get("0011_b2_primary_objective_proposal_recovery.sql");
    if (!recovery) throw new Error("Missing objective proposal recovery migration source");
    for (const required of [
      "initiative_objective_support_attestations",
      "initiative_objective_proposal_recoveries",
      "initiative.primary_objective.withdraw.v1",
      "initiative.primary_objective.rework.v1",
      "claims_one_active_primary_objective_proposal",
      "objective acceptance requires human support confirmation"
    ]) {
      if (!recovery.includes(required)) {
        throw new Error(`Objective proposal recovery migration omits ${required}`);
      }
    }
    for (const forbidden of [
      "fact.supersede.v1",
      "fact.revoke.v1",
      "fact.contest.v1",
      "derived_view.regenerate.v1",
      "CREATE TABLE truth.conflict",
      "CREATE TABLE truth.fact_lifecycle"
    ]) {
      if (recovery.includes(forbidden)) {
        throw new Error(`Objective proposal recovery migration broadens into ${forbidden}`);
      }
    }
  }
  if (phase >= 6) {
    const factLifecycle = migrationSources.get("0012_b2_fact_lifecycle.sql");
    if (!factLifecycle) throw new Error("Missing ordinary Fact lifecycle migration source");
    for (const required of [
      "fact_lifecycle_events",
      "newer_evidence",
      "accepted_value_changed",
      "corrected_source_revalidated",
      "no_longer_true",
      "support_invalidated",
      "entered_in_error",
      "fact.supersede.v1",
      "fact.revoke.v1",
      "fact.superseded",
      "fact.revoked"
    ]) {
      if (!factLifecycle.includes(required)) {
        throw new Error(`Ordinary Fact lifecycle migration omits ${required}`);
      }
    }
  }
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
  if (phase >= 2) {
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
  if (
    phase >= 3 &&
    (!lifecycle!.includes("SECURITY DEFINER") ||
      !lifecycle!.includes("SET search_path = pg_catalog") ||
      !lifecycle!.includes("FROM truth.verified_evidence_spans") ||
      !lifecycle!.includes("ERRCODE = 'TLB21'") ||
      !lifecycle!.includes("MESSAGE = 'Source lifecycle transition is unavailable'"))
  ) {
    throw new Error("B2 lifecycle migration omits its fixed fail-closed boundary");
  }
}

function objectiveRecoveryForbiddenRelations(phase: number): readonly string[] {
  switch (phase) {
    case 5:
      return [
        "conflict_groups",
        "fact_lifecycle_events",
        "fact_supersessions",
        "derived_view_snapshots"
      ];
    case 6:
      return ["conflict_groups", "fact_supersessions", "derived_view_snapshots"];
    default:
      throw new Error("Objective recovery catalog received unsupported B2 phase");
  }
}

async function validateObjectiveRecoveryCatalog(
  client: PgPoolClient,
  recoverySource: string,
  phase: number
): Promise<void> {
  const columns = await client.query<{ table_name: string; columns: string[] }>(
    `SELECT relation.relname AS table_name,
            array_agg(attribute.attname::text ORDER BY attribute.attnum) AS columns
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'truth'
        AND relation.relname IN (
          'initiative_objective_support_attestations',
          'initiative_objective_proposal_recoveries'
        ) AND attribute.attnum > 0 AND NOT attribute.attisdropped
      GROUP BY relation.relname ORDER BY relation.relname`
  );
  const expectedColumns = [
    {
      table_name: "initiative_objective_proposal_recoveries",
      columns: [
        "id",
        "tenant_id",
        "workspace_id",
        "space_id",
        "initiative_id",
        "predecessor_claim_id",
        "successor_claim_id",
        "disposition",
        "reason_code",
        "acted_by_user_id",
        "acted_by_membership_id",
        "causation_command_id",
        "created_at",
        "version"
      ]
    },
    {
      table_name: "initiative_objective_support_attestations",
      columns: [
        "id",
        "tenant_id",
        "workspace_id",
        "space_id",
        "initiative_id",
        "claim_id",
        "verified_evidence_span_id",
        "objective_value_hash",
        "excerpt_hash",
        "confirmed_by_user_id",
        "confirmed_by_membership_id",
        "causation_command_id",
        "confirmed_at",
        "version"
      ]
    }
  ];
  if (JSON.stringify(columns.rows) !== JSON.stringify(expectedColumns)) {
    throw new Error("Objective recovery column inventory drifted");
  }

  const constraints = await client.query<{
    relation: string;
    type: string;
    definition: string;
  }>(
    `SELECT relation.relname AS relation, constraint_record.contype::text AS type,
            regexp_replace(
              pg_get_constraintdef(constraint_record.oid, false), E'\\\\s+', ' ', 'g'
            ) AS definition
       FROM pg_constraint constraint_record
       JOIN pg_class relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE (namespace.nspname = 'truth' AND (
        relation.relname IN (
          'initiative_objective_support_attestations',
          'initiative_objective_proposal_recoveries'
        ) OR (
          relation.relname = 'claims' AND constraint_record.conname IN (
            'claims_status_check','claims_canonical_value_text_valid'
          )
        )
      )) OR ($1::boolean AND namespace.nspname = 'ops' AND constraint_record.conname IN (
        'domain_command_records_b2_safe_request_check',
        'audit_events_action_check','audit_events_action_resource_pair_check',
        'product_outbox_events_event_type_check',
        'product_outbox_events_event_aggregate_pair_check'
      )) ORDER BY relation.relname, constraint_record.contype, definition`,
    [phase < 6]
  );
  const constraintStatement = recoverySource.match(
    /ALTER TABLE ops\.domain_command_records\s+ADD CONSTRAINT domain_command_records_b2_safe_request_check[\s\S]*?\n\s*\);/
  )?.[0];
  if (!constraintStatement) {
    throw new Error("Fixed objective recovery safe-request constraint parser failed");
  }
  await client.query(`CREATE TEMP TABLE b2_expected_safe_request_constraint (
    command_kind text, safe_request jsonb, safe_request_adopted boolean
  ) ON COMMIT DROP`);
  await client.query(
    constraintStatement.replace(
      "ops.domain_command_records",
      "pg_temp.b2_expected_safe_request_constraint"
    )
  );
  const canonicalConstraint = await client.query<{ definition: string }>(
    `SELECT regexp_replace(
       pg_get_constraintdef(constraint_record.oid, false), E'\\\\s+', ' ', 'g'
     ) AS definition
       FROM pg_constraint constraint_record
      WHERE constraint_record.conrelid =
        to_regclass('pg_temp.b2_expected_safe_request_constraint')
        AND constraint_record.conname = 'domain_command_records_b2_safe_request_check'`
  );
  await client.query("DROP TABLE pg_temp.b2_expected_safe_request_constraint");
  const expectedConstraints = exactObjectiveRecoveryConstraints(
    canonicalConstraint.rows[0]?.definition ?? ""
  ).filter(
    ({ relation }) =>
      phase < 6 ||
      !["domain_command_records", "audit_events", "product_outbox_events"].includes(relation)
  );
  if (
    JSON.stringify(sortExactCatalogRows(constraints.rows)) !==
    JSON.stringify(sortExactCatalogRows(expectedConstraints))
  ) {
    throw new Error("Objective recovery exact constraint inventory drifted");
  }

  const indexes = await client.query<{
    relation: string;
    name: string;
    definition: string;
    is_unique: boolean;
    is_primary: boolean;
    is_valid: boolean;
    is_ready: boolean;
    is_live: boolean;
  }>(
    `SELECT relation.relname AS relation, index_relation.relname AS name,
            regexp_replace(regexp_replace(
              pg_get_indexdef(index_record.indexrelid, 0, false),
              '^CREATE UNIQUE INDEX [^ ]+ ON ', 'CREATE UNIQUE INDEX ON '
            ), E'\\\\s+', ' ', 'g') AS definition,
            index_record.indisunique AS is_unique,
            index_record.indisprimary AS is_primary,
            index_record.indisvalid AS is_valid,
            index_record.indisready AS is_ready,
            index_record.indislive AS is_live
       FROM pg_index index_record
       JOIN pg_class relation ON relation.oid = index_record.indrelid
       JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth' AND (
        relation.relname IN (
          'initiative_objective_support_attestations',
          'initiative_objective_proposal_recoveries'
        ) OR index_record.indexrelid =
          to_regclass('truth.claims_one_active_primary_objective_proposal')
      ) ORDER BY relation.relname, index_relation.relname`
  );
  const expectedIndexes = exactObjectiveRecoveryIndexes();
  if (JSON.stringify(indexes.rows) !== JSON.stringify(expectedIndexes)) {
    throw new Error("Objective recovery exact index inventory drifted");
  }

  const catalog = await client.query<{
    atomicity_function: string | null;
    support_function: string | null;
    recovery_function: string | null;
    terminal_recovery_function: string | null;
  }>(
    `SELECT
       to_regprocedure('ops.require_b2_slice1_command_atomicity()')::text AS atomicity_function,
       to_regprocedure('truth.require_objective_support_attestation()')::text AS support_function,
       to_regprocedure('truth.validate_objective_recovery()')::text AS recovery_function,
       to_regprocedure('truth.require_objective_recovery_for_terminal_claim()')::text
         AS terminal_recovery_function`
  );
  const row = catalog.rows[0];
  if (
    !row ||
    !row.atomicity_function ||
    !row.support_function ||
    !row.recovery_function ||
    !row.terminal_recovery_function
  ) {
    throw new Error("Objective recovery constraints or functions are incomplete");
  }

  const commandBoundary = await client.query<{
    validator: string;
    atomicity: string;
    trigger_kinds: string[];
    safe_request_column: boolean;
    safe_request_adopted_column: boolean;
    safe_request_adopted_not_null: boolean;
    safe_request_adopted_default: string | null;
    command_relation_owned_by_migrator: boolean;
    app_can_insert_safe_request_adopted: boolean;
    app_can_update_safe_request_adopted: boolean;
    safe_request_constraint: string | null;
    safe_request_owner: string;
    safe_request_config: string[] | null;
    app_can_execute_safe_request: boolean;
    public_can_execute_safe_request: boolean;
  }>(
    `SELECT
       pg_get_functiondef(
         'ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)'::regprocedure
       ) AS validator,
       pg_get_functiondef('ops.require_b2_slice1_command_atomicity()'::regprocedure) AS atomicity,
       regexp_split_to_array(pg_get_triggerdef(trigger_record.oid, false), E'\\n') AS trigger_kinds,
       EXISTS (SELECT 1 FROM pg_attribute attribute
         WHERE attribute.attrelid = to_regclass('ops.domain_command_records')
           AND attribute.attname = 'safe_request' AND NOT attribute.attisdropped)
         AS safe_request_column,
       EXISTS (SELECT 1 FROM pg_attribute attribute
         WHERE attribute.attrelid = to_regclass('ops.domain_command_records')
           AND attribute.attname = 'safe_request_adopted' AND NOT attribute.attisdropped)
         AS safe_request_adopted_column,
       (SELECT attribute.attnotnull FROM pg_attribute attribute
         WHERE attribute.attrelid = to_regclass('ops.domain_command_records')
           AND attribute.attname = 'safe_request_adopted' AND NOT attribute.attisdropped)
         AS safe_request_adopted_not_null,
       (SELECT pg_get_expr(default_record.adbin, default_record.adrelid, false)
          FROM pg_attribute attribute
          JOIN pg_attrdef default_record ON default_record.adrelid = attribute.attrelid
            AND default_record.adnum = attribute.attnum
         WHERE attribute.attrelid = to_regclass('ops.domain_command_records')
           AND attribute.attname = 'safe_request_adopted' AND NOT attribute.attisdropped)
         AS safe_request_adopted_default,
       pg_get_userbyid(command_relation.relowner) = current_user
         AS command_relation_owned_by_migrator,
       has_column_privilege('throughline_app', command_relation.oid,
         'safe_request_adopted', 'INSERT') AS app_can_insert_safe_request_adopted,
       has_column_privilege('throughline_app', command_relation.oid,
         'safe_request_adopted', 'UPDATE') AS app_can_update_safe_request_adopted,
       (SELECT pg_get_constraintdef(constraint_record.oid, false)
          FROM pg_constraint constraint_record
         WHERE constraint_record.conrelid = to_regclass('ops.domain_command_records')
           AND constraint_record.conname = 'domain_command_records_b2_safe_request_check')
         AS safe_request_constraint,
       pg_get_userbyid(safe_request_function.proowner) AS safe_request_owner,
       safe_request_function.proconfig AS safe_request_config,
       has_function_privilege('throughline_app', safe_request_function.oid, 'EXECUTE')
         AS app_can_execute_safe_request,
       EXISTS (SELECT 1 FROM aclexplode(COALESCE(safe_request_function.proacl,
         acldefault('f', safe_request_function.proowner))) acl
         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')
         AS public_can_execute_safe_request
      FROM pg_trigger trigger_record
      CROSS JOIN pg_proc safe_request_function
      CROSS JOIN pg_class command_relation
      WHERE trigger_record.tgrelid = to_regclass('ops.domain_command_records')
        AND trigger_record.tgname = 'domain_command_records_b2_slice1_atomicity_deferred'
        AND NOT trigger_record.tgisinternal
        AND safe_request_function.oid =
          'ops.b2_slice1_safe_request_valid(text,jsonb)'::regprocedure
        AND command_relation.oid = to_regclass('ops.domain_command_records')`
  );
  const boundary = commandBoundary.rows[0];
  if (
    !boundary?.safe_request_column ||
    !boundary.safe_request_adopted_column ||
    !boundary.safe_request_adopted_not_null ||
    boundary.safe_request_adopted_default !== "false" ||
    !boundary.command_relation_owned_by_migrator ||
    boundary.app_can_insert_safe_request_adopted ||
    boundary.app_can_update_safe_request_adopted ||
    !boundary.safe_request_constraint?.includes("b2_slice1_safe_request_valid") ||
    boundary.safe_request_owner !== "throughline_b1_0_integrity" ||
    JSON.stringify(boundary.safe_request_config) !== JSON.stringify(["search_path=pg_catalog"]) ||
    !boundary.app_can_execute_safe_request ||
    boundary.public_can_execute_safe_request ||
    !boundary.atomicity.includes("caused_recovery_count") ||
    !boundary.atomicity.includes("caused_attestation_count")
  ) {
    throw new Error("Objective recovery exact command request/effect boundary drifted");
  }
  for (const kind of [
    "claim.create.v1",
    "initiative.primary_objective.withdraw.v1",
    "initiative.primary_objective.rework.v1",
    "fact.accept.v1"
  ]) {
    if (
      !boundary?.validator.includes(kind) ||
      !boundary.atomicity.includes(kind) ||
      !boundary.trigger_kinds.join("\n").includes(kind)
    ) {
      throw new Error(`Objective recovery command boundary omits ${kind}`);
    }
  }

  const policyCount = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_policy policy
      WHERE policy.polrelid IN (
        to_regclass('truth.initiative_objective_support_attestations'),
        to_regclass('truth.initiative_objective_proposal_recoveries')
      )`
  );
  if (policyCount.rows[0]?.count !== "6") {
    throw new Error("Objective recovery RLS policy inventory drifted");
  }
  const policies = await client.query<{
    relation: string;
    name: string;
    command: string;
    permissive: boolean;
    roles: string[];
    using_expression: string | null;
    check_expression: string | null;
  }>(
    `SELECT relation.relname AS relation, policy.polname AS name,
            policy.polcmd::text AS command, policy.polpermissive AS permissive,
            ARRAY(SELECT role::regrole::text FROM unnest(policy.polroles) role ORDER BY 1) AS roles,
            regexp_replace(
              pg_get_expr(policy.polqual, policy.polrelid, false), E'\\\\s+', ' ', 'g'
            ) AS using_expression,
            regexp_replace(
              pg_get_expr(policy.polwithcheck, policy.polrelid, false), E'\\\\s+', ' ', 'g'
            ) AS check_expression
       FROM pg_policy policy
       JOIN pg_class relation ON relation.oid = policy.polrelid
      WHERE policy.polrelid IN (
        to_regclass('truth.initiative_objective_support_attestations'),
        to_regclass('truth.initiative_objective_proposal_recoveries')
      ) ORDER BY relation.relname, policy.polname`
  );
  if (JSON.stringify(policies.rows) !== JSON.stringify(exactObjectiveRecoveryPolicies())) {
    throw new Error("Objective recovery exact RLS policy definitions drifted");
  }

  const triggers = await client.query<{ name: string }>(
    `SELECT trigger_record.tgname AS name FROM pg_trigger trigger_record
      WHERE trigger_record.tgname = ANY($1::text[]) AND NOT trigger_record.tgisinternal
      ORDER BY trigger_record.tgname`,
    [
      [
        "attestations_objective_support_deferred",
        "claims_objective_recovery_deferred",
        "claims_objective_support_deferred",
        "objective_recovery_command_guard",
        "objective_recovery_immutable",
        "objective_recovery_valid_deferred",
        "objective_support_command_guard",
        "objective_support_immutable",
        "objective_support_insert_guard"
      ]
    ]
  );
  if (triggers.rows.length !== 9) {
    throw new Error("Objective recovery trigger inventory drifted");
  }

  const privilegeShape = await client.query<{
    app_support_select: boolean;
    app_support_insert: boolean;
    app_support_update: boolean;
    app_recovery_select: boolean;
    app_recovery_insert: boolean;
    app_recovery_delete: boolean;
    worker_support_select: boolean;
    relay_recovery_select: boolean;
  }>(`SELECT
    has_table_privilege('throughline_app',
      'truth.initiative_objective_support_attestations','SELECT') AS app_support_select,
    has_table_privilege('throughline_app',
      'truth.initiative_objective_support_attestations','INSERT') AS app_support_insert,
    has_table_privilege('throughline_app',
      'truth.initiative_objective_support_attestations','UPDATE') AS app_support_update,
    has_table_privilege('throughline_app',
      'truth.initiative_objective_proposal_recoveries','SELECT') AS app_recovery_select,
    has_table_privilege('throughline_app',
      'truth.initiative_objective_proposal_recoveries','INSERT') AS app_recovery_insert,
    has_table_privilege('throughline_app',
      'truth.initiative_objective_proposal_recoveries','DELETE') AS app_recovery_delete,
    has_table_privilege('throughline_worker',
      'truth.initiative_objective_support_attestations','SELECT') AS worker_support_select,
    has_table_privilege('throughline_relay',
      'truth.initiative_objective_proposal_recoveries','SELECT') AS relay_recovery_select`);
  if (
    JSON.stringify(privilegeShape.rows[0]) !==
    JSON.stringify({
      app_support_select: true,
      app_support_insert: true,
      app_support_update: false,
      app_recovery_select: true,
      app_recovery_insert: true,
      app_recovery_delete: false,
      worker_support_select: false,
      relay_recovery_select: false
    })
  ) {
    throw new Error("Objective recovery least-privilege grants drifted");
  }

  const forbiddenRelations = objectiveRecoveryForbiddenRelations(phase);
  const forbidden = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'truth'
         AND relation.relname = ANY($1::text[])
     ) AS present`,
    [forbiddenRelations]
  );
  if (forbidden.rows[0]?.present) {
    throw new Error("Objective recovery catalog contains generalized lifecycle storage");
  }
}

function exactObjectiveRecoveryPolicies(): Array<{
  relation: string;
  name: string;
  command: string;
  permissive: boolean;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
}> {
  return [
    {
      relation: "initiative_objective_proposal_recoveries",
      name: "objective_recovery_insert",
      command: "a",
      permissive: true,
      roles: ["throughline_app"],
      using_expression: null,
      check_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (acted_by_user_id = ops.current_user_id()) AND (acted_by_membership_id = ops.current_membership_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class FROM truth.claims claim WHERE ((claim.tenant_id = initiative_objective_proposal_recoveries.tenant_id) AND (claim.workspace_id = initiative_objective_proposal_recoveries.workspace_id) AND (claim.id = initiative_objective_proposal_recoveries.predecessor_claim_id)))))"
    },
    {
      relation: "initiative_objective_proposal_recoveries",
      name: "objective_recovery_integrity_select",
      command: "r",
      permissive: true,
      roles: ["throughline_b1_0_integrity"],
      using_expression: "true",
      check_expression: null
    },
    {
      relation: "initiative_objective_proposal_recoveries",
      name: "objective_recovery_select",
      command: "r",
      permissive: true,
      roles: ["throughline_app"],
      using_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class FROM truth.claims claim WHERE ((claim.tenant_id = initiative_objective_proposal_recoveries.tenant_id) AND (claim.workspace_id = initiative_objective_proposal_recoveries.workspace_id) AND (claim.id = initiative_objective_proposal_recoveries.predecessor_claim_id)))))",
      check_expression: null
    },
    {
      relation: "initiative_objective_support_attestations",
      name: "objective_support_insert",
      command: "a",
      permissive: true,
      roles: ["throughline_app"],
      using_expression: null,
      check_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (confirmed_by_user_id = ops.current_user_id()) AND (confirmed_by_membership_id = ops.current_membership_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class FROM truth.claims claim WHERE ((claim.tenant_id = initiative_objective_support_attestations.tenant_id) AND (claim.workspace_id = initiative_objective_support_attestations.workspace_id) AND (claim.id = initiative_objective_support_attestations.claim_id)))))"
    },
    {
      relation: "initiative_objective_support_attestations",
      name: "objective_support_integrity_select",
      command: "r",
      permissive: true,
      roles: ["throughline_b1_0_integrity"],
      using_expression: "true",
      check_expression: null
    },
    {
      relation: "initiative_objective_support_attestations",
      name: "objective_support_select",
      command: "r",
      permissive: true,
      roles: ["throughline_app"],
      using_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class FROM truth.claims claim WHERE ((claim.tenant_id = initiative_objective_support_attestations.tenant_id) AND (claim.workspace_id = initiative_objective_support_attestations.workspace_id) AND (claim.id = initiative_objective_support_attestations.claim_id)))))",
      check_expression: null
    }
  ];
}

function exactObjectiveRecoveryConstraints(safeRequestConstraint: string): Array<{
  relation: string;
  type: string;
  definition: string;
}> {
  const claims = "claims";
  const recovery = "initiative_objective_proposal_recoveries";
  const support = "initiative_objective_support_attestations";
  return [
    {
      relation: "audit_events",
      type: "c",
      definition:
        "CHECK ((((action = 'organization.create'::text) AND (resource_type = 'organization'::text)) OR ((action = 'initiative.create'::text) AND (resource_type = 'initiative'::text)) OR ((action = ANY (ARRAY['activity.create'::text, 'activity.capture_add'::text])) AND (resource_type = 'activity'::text)) OR ((action = ANY (ARRAY['relationship.create'::text, 'relationship.end'::text])) AND (resource_type = 'relationship'::text)) OR ((action = ANY (ARRAY['content.create'::text, 'content.revise'::text])) AND (resource_type = 'content_item'::text)) OR ((action = ANY (ARRAY['source_artifact.capture'::text, 'source_artifact.correct'::text, 'source_artifact.tombstone'::text])) AND (resource_type = 'source_artifact'::text)) OR ((action = ANY (ARRAY['claim.create'::text, 'initiative.primary_objective.withdraw'::text, 'initiative.primary_objective.reject'::text, 'initiative.primary_objective.rework'::text])) AND (resource_type = 'claim'::text)) OR ((action = 'fact.accept'::text) AND (resource_type = 'accepted_fact'::text))))"
    },
    {
      relation: "audit_events",
      type: "c",
      definition:
        "CHECK ((action = ANY (ARRAY['organization.create'::text, 'initiative.create'::text, 'activity.create'::text, 'activity.capture_add'::text, 'relationship.create'::text, 'relationship.end'::text, 'content.create'::text, 'content.revise'::text, 'source_artifact.capture'::text, 'source_artifact.correct'::text, 'source_artifact.tombstone'::text, 'claim.create'::text, 'initiative.primary_objective.withdraw'::text, 'initiative.primary_objective.reject'::text, 'initiative.primary_objective.rework'::text, 'fact.accept'::text])))"
    },
    {
      relation: claims,
      type: "c",
      definition:
        "CHECK (((canonical_value_text = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000)) AND (((status = 'proposed'::text) AND (version = 1)) OR ((status = ANY (ARRAY['accepted'::text, 'rejected'::text, 'superseded'::text])) AND (version = 2)))))"
    },
    {
      relation: claims,
      type: "c",
      definition:
        "CHECK ((status = ANY (ARRAY['proposed'::text, 'accepted'::text, 'rejected'::text, 'superseded'::text])))"
    },
    {
      relation: "domain_command_records",
      type: "c",
      definition: safeRequestConstraint
    },
    {
      relation: recovery,
      type: "c",
      definition:
        "CHECK ((((disposition = 'reworked'::text) AND (reason_code = 'reworked'::text) AND (successor_claim_id IS NOT NULL)) OR ((disposition = ANY (ARRAY['withdrawn'::text, 'rejected'::text])) AND (reason_code <> 'reworked'::text) AND (successor_claim_id IS NULL))))"
    },
    {
      relation: recovery,
      type: "c",
      definition:
        "CHECK ((disposition = ANY (ARRAY['withdrawn'::text, 'rejected'::text, 'reworked'::text])))"
    },
    {
      relation: recovery,
      type: "c",
      definition:
        "CHECK ((reason_code = ANY (ARRAY['needs_rework'::text, 'unsupported'::text, 'incorrect'::text, 'duplicate'::text, 'not_useful'::text, 'sensitive'::text, 'other'::text, 'reworked'::text])))"
    },
    { relation: recovery, type: "c", definition: "CHECK ((version = 1))" },
    { relation: recovery, type: "c", definition: "CHECK (ops.is_uuid_v7(id))" },
    {
      relation: recovery,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, acted_by_membership_id, acted_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)"
    },
    {
      relation: recovery,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)"
    },
    {
      relation: recovery,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id) REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id)"
    },
    {
      relation: recovery,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_claim_id) REFERENCES truth.claims(tenant_id, workspace_id, space_id, id)"
    },
    {
      relation: recovery,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, successor_claim_id) REFERENCES truth.claims(tenant_id, workspace_id, space_id, id) DEFERRABLE INITIALLY DEFERRED"
    },
    { relation: recovery, type: "p", definition: "PRIMARY KEY (id)" },
    {
      relation: recovery,
      type: "t",
      definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED"
    },
    {
      relation: recovery,
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, causation_command_id)"
    },
    {
      relation: recovery,
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, id)"
    },
    {
      relation: recovery,
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, predecessor_claim_id)"
    },
    {
      relation: recovery,
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, space_id, id)"
    },
    {
      relation: support,
      type: "c",
      definition: "CHECK ((excerpt_hash ~ '^[a-f0-9]{64}$'::text))"
    },
    {
      relation: support,
      type: "c",
      definition: "CHECK ((objective_value_hash ~ '^[a-f0-9]{64}$'::text))"
    },
    { relation: support, type: "c", definition: "CHECK ((version = 1))" },
    { relation: support, type: "c", definition: "CHECK (ops.is_uuid_v7(id))" },
    {
      relation: support,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)"
    },
    {
      relation: support,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, confirmed_by_membership_id, confirmed_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)"
    },
    {
      relation: support,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, claim_id) REFERENCES truth.claims(tenant_id, workspace_id, space_id, id)"
    },
    {
      relation: support,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id) REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id)"
    },
    {
      relation: support,
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, verified_evidence_span_id) REFERENCES truth.verified_evidence_spans(tenant_id, workspace_id, space_id, id)"
    },
    { relation: support, type: "p", definition: "PRIMARY KEY (id)" },
    {
      relation: support,
      type: "t",
      definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED"
    },
    {
      relation: support,
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, claim_id)"
    },
    {
      relation: support,
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, id)"
    },
    {
      relation: support,
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, space_id, id)"
    },
    {
      relation: "product_outbox_events",
      type: "c",
      definition:
        "CHECK ((((event_type = 'organization.created'::text) AND (aggregate_type = 'organization'::text)) OR ((event_type = 'initiative.created'::text) AND (aggregate_type = 'initiative'::text)) OR ((event_type = ANY (ARRAY['activity.created'::text, 'activity.capture_added'::text])) AND (aggregate_type = 'activity'::text)) OR ((event_type = ANY (ARRAY['relationship.created'::text, 'relationship.ended'::text])) AND (aggregate_type = 'relationship'::text)) OR ((event_type = ANY (ARRAY['content.created'::text, 'content.revised'::text])) AND (aggregate_type = 'content_item'::text)) OR ((event_type = ANY (ARRAY['source_artifact.captured'::text, 'source_artifact.corrected'::text, 'source_artifact.tombstoned'::text])) AND (aggregate_type = 'source_artifact'::text)) OR ((event_type = ANY (ARRAY['claim.proposed'::text, 'initiative.primary_objective.proposal_withdrawn'::text, 'initiative.primary_objective.proposal_rejected'::text, 'initiative.primary_objective.proposal_reworked'::text])) AND (aggregate_type = 'claim'::text)) OR ((event_type = 'fact.accepted'::text) AND (aggregate_type = 'accepted_fact'::text))))"
    },
    {
      relation: "product_outbox_events",
      type: "c",
      definition:
        "CHECK ((event_type = ANY (ARRAY['organization.created'::text, 'initiative.created'::text, 'activity.created'::text, 'activity.capture_added'::text, 'relationship.created'::text, 'relationship.ended'::text, 'content.created'::text, 'content.revised'::text, 'source_artifact.captured'::text, 'source_artifact.corrected'::text, 'source_artifact.tombstoned'::text, 'claim.proposed'::text, 'initiative.primary_objective.proposal_withdrawn'::text, 'initiative.primary_objective.proposal_rejected'::text, 'initiative.primary_objective.proposal_reworked'::text, 'fact.accepted'::text])))"
    }
  ];
}

function sortExactCatalogRows<T extends { relation: string; definition: string; type?: string }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((left, right) => {
    const leftKey = `${left.relation}\u0000${left.type ?? ""}\u0000${left.definition}`;
    const rightKey = `${right.relation}\u0000${right.type ?? ""}\u0000${right.definition}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function exactObjectiveRecoveryIndexes(): Array<{
  relation: string;
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
  is_valid: boolean;
  is_ready: boolean;
  is_live: boolean;
}> {
  const recovery = "initiative_objective_proposal_recoveries";
  const support = "initiative_objective_support_attestations";
  const index = (relation: string, name: string, keys: string, primary = false) => ({
    relation,
    name,
    definition: `CREATE UNIQUE INDEX ON truth.${relation} USING btree (${keys})`,
    is_unique: true,
    is_primary: primary,
    is_valid: true,
    is_ready: true,
    is_live: true
  });
  return [
    {
      relation: "claims",
      name: "claims_one_active_primary_objective_proposal",
      definition:
        "CREATE UNIQUE INDEX ON truth.claims USING btree (tenant_id, workspace_id, space_id, subject_type, subject_id, predicate) WHERE ((subject_type = 'initiative'::text) AND (predicate = 'initiative.primary_objective'::text) AND (status = 'proposed'::text))",
      is_unique: true,
      is_primary: false,
      is_valid: true,
      is_ready: true,
      is_live: true
    },
    index(
      recovery,
      "initiative_objective_proposal_rec_tenant_id_workspace_id_id_key",
      "tenant_id, workspace_id, id"
    ),
    index(recovery, "initiative_objective_proposal_recoveries_pkey", "id", true),
    index(
      recovery,
      "initiative_objective_proposal_tenant_id_workspace_id_causat_key",
      "tenant_id, workspace_id, causation_command_id"
    ),
    index(
      recovery,
      "initiative_objective_proposal_tenant_id_workspace_id_predec_key",
      "tenant_id, workspace_id, predecessor_claim_id"
    ),
    index(
      recovery,
      "initiative_objective_proposal_tenant_id_workspace_id_space__key",
      "tenant_id, workspace_id, space_id, id"
    ),
    index(
      support,
      "initiative_objective_support__tenant_id_workspace_id_claim__key",
      "tenant_id, workspace_id, claim_id"
    ),
    index(
      support,
      "initiative_objective_support__tenant_id_workspace_id_space__key",
      "tenant_id, workspace_id, space_id, id"
    ),
    index(
      support,
      "initiative_objective_support_atte_tenant_id_workspace_id_id_key",
      "tenant_id, workspace_id, id"
    ),
    index(support, "initiative_objective_support_attestations_pkey", "id", true)
  ];
}

async function validateTruthTables(
  client: PgPoolClient,
  expectedRelations: ExactTruthRelation[]
): Promise<void> {
  const result = await client.query<{
    name: string;
    kind: string;
    rls: boolean;
    forced_rls: boolean;
    persistence: string;
    owner: string;
  }>(
    `SELECT relation.relname AS name, relation.relkind::text AS kind,
            relation.relpersistence::text AS persistence,
            relation.relrowsecurity AS rls,
            relation.relforcerowsecurity AS forced_rls,
            CASE WHEN relation.relowner = current_user::regrole THEN 'migration_owner'
                 ELSE pg_get_userbyid(relation.relowner) END AS owner
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth'
        AND relation.relkind NOT IN ('i','I')
      ORDER BY relation.relname`
  );
  if (JSON.stringify(result.rows) !== JSON.stringify(expectedRelations)) {
    throw new Error("B2 Slice 1 truth table inventory or forced RLS drifted");
  }
}

async function validateTruthColumnsAndConstraints(
  client: PgPoolClient,
  phase: number,
  expectedCatalog: ExactTruthCatalog
): Promise<void> {
  const phaseTruthTables: Array<keyof typeof truthColumns> =
    phase >= 6 ? [...truthTables, "fact_lifecycle_events"] : [...truthTables];
  phaseTruthTables.sort();
  const columns = await client.query<{ table_name: string; columns: string[] }>(
    `SELECT relation.relname AS table_name,
            array_agg(attribute.attname::text ORDER BY attribute.attnum) AS columns
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'truth'
        AND relation.relkind = 'r'
        AND relation.relname = ANY($1::text[])
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      GROUP BY relation.relname
      ORDER BY relation.relname`,
    [[...phaseTruthTables]]
  );
  const expectedColumns = phaseTruthTables.map((table_name) => ({
    table_name,
    columns: truthColumns[table_name].map((column) =>
      phase >= 3 || column !== "canonical_value_text" ? column : "value_json"
    )
  }));
  if (JSON.stringify(columns.rows) !== JSON.stringify(expectedColumns)) {
    throw new Error("B2 Slice 1 truth column inventory drifted");
  }
  const canonicalValues = await client.query<{
    table_name: string;
    data_type: string;
  }>(
    `SELECT relation.relname AS table_name, format_type(attribute.atttypid, NULL) AS data_type
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth'
        AND relation.relname IN ('claims','accepted_facts')
        AND attribute.attname = $1
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY relation.relname`,
    [phase >= 3 ? "canonical_value_text" : "value_json"]
  );
  if (
    JSON.stringify(canonicalValues.rows) !==
    JSON.stringify([
      { table_name: "accepted_facts", data_type: phase >= 3 ? "text" : "jsonb" },
      { table_name: "claims", data_type: phase >= 3 ? "text" : "jsonb" }
    ])
  ) {
    throw new Error(
      phase >= 3
        ? "B2 canonical truth values are not stored as text"
        : "B2 v1 truth values are not stored as JSON strings"
    );
  }

  const constraints = await client.query<{
    table_name: string;
    name: string;
    type: string;
    definition: string;
    deferrable: boolean;
    initially_deferred: boolean;
    validated: boolean;
  }>(
    `SELECT relation.relname AS table_name, constraint_record.conname AS name,
            constraint_record.contype::text AS type,
            pg_get_constraintdef(constraint_record.oid, false) AS definition,
            constraint_record.condeferrable AS deferrable,
            constraint_record.condeferred AS initially_deferred,
            constraint_record.convalidated AS validated
       FROM pg_constraint constraint_record
       JOIN pg_class relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth'
      ORDER BY relation.relname, constraint_record.conname`
  );
  if (JSON.stringify(constraints.rows) !== JSON.stringify(expectedCatalog.constraints)) {
    throw new Error("B2 Slice 1 exact truth constraint inventory drifted");
  }
  const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
  for (const forbidden of [
    ...(phase >= 5 ? [] : ["rejected"]),
    ...(phase >= 6 ? [] : ["revoked"]),
    "redacted",
    "hash_disposition"
  ]) {
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

  const indexes = await client.query<{
    table_name: string;
    index_name: string;
    unique: boolean;
    primary: boolean;
    valid: boolean;
    ready: boolean;
    live: boolean;
    definition: string;
  }>(
    `SELECT relation.relname AS table_name, index_relation.relname AS index_name,
            index_record.indisunique AS unique, index_record.indisprimary AS primary,
            index_record.indisvalid AS valid, index_record.indisready AS ready,
            index_record.indislive AS live,
            pg_get_indexdef(index_record.indexrelid, 0, false) AS definition
       FROM pg_index index_record
       JOIN pg_class relation ON relation.oid = index_record.indrelid
       JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'truth'
      ORDER BY relation.relname, index_relation.relname`
  );
  if (JSON.stringify(indexes.rows) !== JSON.stringify(expectedCatalog.indexes)) {
    throw new Error("B2 Slice 1 exact truth index inventory drifted");
  }
}

async function validateTruthPolicies(
  client: PgPoolClient,
  expectedPolicies: ExactTruthPolicy[]
): Promise<void> {
  const result = await client.query<{
    policy_name: string;
    table_name: string;
    operation: string;
    permissive: boolean;
    roles: string[];
    using_expression: string | null;
    check_expression: string | null;
  }>(
    `SELECT relation.relname AS table_name, policy.polname AS policy_name,
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
  if (JSON.stringify(result.rows) !== JSON.stringify(expectedPolicies)) {
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

async function validateTruthSecurity(
  client: PgPoolClient,
  phase: number,
  expectedRelations: ExactTruthRelation[]
): Promise<void> {
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
    ...(phase >= 2
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
        AND relation.relkind NOT IN ('i','I')
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
        AND relation.relkind NOT IN ('i','I')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl.grantee <> relation.relowner
      ORDER BY table_name, scope, column_name NULLS FIRST, grantee, privilege, grantable`
  );
  const expectedTablePrivileges: Array<Record<string, unknown>> = [];
  for (const { name: table_name } of expectedRelations) {
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
    if (phase >= 2) {
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
  if (phase >= 6) {
    for (const column_name of ["last_causation_command_id", "status", "updated_at", "version"]) {
      expectedTablePrivileges.push({
        table_name: "accepted_facts",
        scope: "column",
        column_name,
        grantee: "throughline_app",
        privilege: "UPDATE",
        grantable: false
      });
    }
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

async function validateTruthFunctions(
  client: PgPoolClient,
  schemaSource: string,
  lifecycleSource: string | undefined,
  recoverySource: string | undefined,
  factLifecycleSource: string | undefined,
  phase: number
): Promise<void> {
  const objectiveRecoveryFunctionIdentities = [
    "truth.require_objective_recovery_command()",
    "truth.require_objective_recovery_for_terminal_claim()",
    "truth.require_objective_support_attestation()",
    "truth.validate_objective_recovery()",
    "truth.validate_objective_support_attestation()"
  ] as const;
  const factLifecycleFunctionIdentities = [
    "truth.enforce_fact_lifecycle_transition()",
    "truth.require_fact_lifecycle_command()",
    "truth.require_fact_lifecycle_event()",
    "truth.reject_statement_mutation()",
    "truth.validate_fact_lifecycle_event()"
  ] as const;
  const expectedTruthFunctionIdentities = [
    ...truthFunctionIdentities,
    ...(phase >= 5 ? objectiveRecoveryFunctionIdentities : []),
    ...(phase >= 6 ? factLifecycleFunctionIdentities : [])
  ].sort();
  const inventory = await client.query<{ identity: string }>(
    `SELECT procedure.oid::regprocedure::text AS identity
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'truth'
      ORDER BY procedure.oid::regprocedure::text`
  );
  if (
    JSON.stringify(inventory.rows.map(({ identity }) => identity)) !==
    JSON.stringify(expectedTruthFunctionIdentities)
  ) {
    throw new Error("B2 Slice 1 truth function inventory drifted");
  }

  const inspectedIdentities = [
    ...expectedTruthFunctionIdentities,
    "access.can_read_space(uuid,text)"
  ];
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
      const objectiveRecoveryFunction = objectiveRecoveryFunctionIdentities.includes(
        identity as (typeof objectiveRecoveryFunctionIdentities)[number]
      );
      const recoveryBackedFunction =
        objectiveRecoveryFunction ||
        identity === "truth.enforce_claim_transition()" ||
        identity === "truth.require_reserved_command()";
      const factLifecycleFunction = factLifecycleFunctionIdentities.includes(
        identity as (typeof factLifecycleFunctionIdentities)[number]
      );
      const phase6BackedFunction =
        factLifecycleFunction ||
        identity === "truth.enforce_claim_transition()" ||
        identity === "truth.require_reserved_command()" ||
        identity === "truth.require_fact_accept_reservation()" ||
        identity === "truth.validate_fact_insert()" ||
        identity === "truth.validate_fact_support()";
      return {
        identity,
        result: accessFunction ? "boolean" : "trigger",
        language: accessFunction ? "sql" : "plpgsql",
        owner: objectiveRecoveryFunction ? "throughline_b1_0_integrity" : "migration_owner",
        security_definer: false,
        strict: false,
        volatility: accessFunction ? "s" : "v",
        leakproof: false,
        parallel: "u",
        kind: "f",
        configuration: ["search_path=pg_catalog"],
        source:
          phase >= 6 && phase6BackedFunction
            ? migrationFunctionSource(factLifecycleSource!, identity.slice(0, -2))
            : migrationFunctionSource(
                phase >= 5 && recoveryBackedFunction
                  ? recoverySource!
                  : phase >= 3 && !accessFunction
                    ? lifecycleSource!
                    : schemaSource,
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

async function validateTruthConstraintsAndTriggers(
  client: PgPoolClient,
  phase: number
): Promise<void> {
  type TruthTriggerContract = {
    name: string;
    table_name: string;
    function_identity: string;
    timing_and_events: string;
    deferred?: boolean;
    arguments?: string[];
    statement?: boolean;
  };
  const triggerContracts: TruthTriggerContract[] = [
    phase >= 6
      ? {
          name: "accepted_facts_command_guard",
          table_name: "accepted_facts",
          function_identity: "truth.require_reserved_command()",
          timing_and_events: "BEFORE INSERT",
          arguments: ["fact.accept-or-supersede.v1"]
        }
      : {
          name: "accepted_facts_command_guard",
          table_name: "accepted_facts",
          function_identity: "truth.require_reserved_command()",
          timing_and_events: "BEFORE INSERT",
          arguments: ["fact.accept.v1"]
        },
    {
      name: phase >= 6 ? "accepted_facts_delete_guard" : "accepted_facts_immutable",
      table_name: "accepted_facts",
      function_identity: "truth.reject_mutation()",
      timing_and_events: phase >= 6 ? "BEFORE DELETE" : "BEFORE DELETE OR UPDATE"
    },
    {
      name: "accepted_facts_insert_guard",
      table_name: "accepted_facts",
      function_identity: "truth.validate_fact_insert()",
      timing_and_events: "BEFORE INSERT"
    },
    {
      name: "accepted_facts_support_deferred",
      table_name: "accepted_facts",
      function_identity: "truth.validate_fact_support()",
      timing_and_events: "AFTER INSERT",
      deferred: true
    },
    {
      name: "claims_command_guard",
      table_name: "claims",
      function_identity: "truth.require_reserved_command()",
      timing_and_events: "BEFORE INSERT",
      arguments: [phase >= 5 ? "claim.create-or-rework.v1" : "claim.create.v1"]
    },
    {
      name: "claims_delete_guard",
      table_name: "claims",
      function_identity: "truth.reject_mutation()",
      timing_and_events: "BEFORE DELETE"
    },
    {
      name: "claims_insert_guard",
      table_name: "claims",
      function_identity: "truth.validate_claim_insert()",
      timing_and_events: "BEFORE INSERT"
    },
    {
      name: "claims_transition_guard",
      table_name: "claims",
      function_identity: "truth.enforce_claim_transition()",
      timing_and_events: "BEFORE UPDATE"
    },
    {
      name: "fact_claims_command_guard",
      table_name: "fact_claims",
      function_identity: "truth.require_fact_accept_reservation()",
      timing_and_events: "BEFORE INSERT"
    },
    {
      name: "fact_claims_immutable",
      table_name: "fact_claims",
      function_identity: "truth.reject_mutation()",
      timing_and_events: "BEFORE DELETE OR UPDATE"
    },
    {
      name: "fact_claims_support_deferred",
      table_name: "fact_claims",
      function_identity: "truth.validate_fact_support()",
      timing_and_events: "AFTER INSERT",
      deferred: true
    },
    {
      name: "verified_evidence_command_guard",
      table_name: "verified_evidence_spans",
      function_identity: "truth.require_reserved_command()",
      timing_and_events: "BEFORE INSERT",
      arguments: [phase >= 5 ? "claim.create-or-rework.v1" : "claim.create.v1"]
    },
    {
      name: "verified_evidence_immutable",
      table_name: "verified_evidence_spans",
      function_identity: "truth.reject_mutation()",
      timing_and_events: "BEFORE DELETE OR UPDATE"
    },
    {
      name: "verified_evidence_snapshot_guard",
      table_name: "verified_evidence_spans",
      function_identity: "truth.verify_evidence_snapshot()",
      timing_and_events: "BEFORE INSERT"
    },
    ...(phase >= 5
      ? [
          {
            name: "attestations_objective_support_deferred",
            table_name: "initiative_objective_support_attestations",
            function_identity: "truth.require_objective_support_attestation()",
            timing_and_events: "AFTER INSERT",
            deferred: true
          },
          {
            name: "claims_objective_recovery_deferred",
            table_name: "claims",
            function_identity: "truth.require_objective_recovery_for_terminal_claim()",
            timing_and_events: "AFTER UPDATE",
            deferred: true
          },
          {
            name: "claims_objective_support_deferred",
            table_name: "claims",
            function_identity: "truth.require_objective_support_attestation()",
            timing_and_events: "AFTER INSERT OR UPDATE",
            deferred: true
          },
          {
            name: "objective_recovery_command_guard",
            table_name: "initiative_objective_proposal_recoveries",
            function_identity: "truth.require_objective_recovery_command()",
            timing_and_events: "BEFORE INSERT"
          },
          {
            name: "objective_recovery_immutable",
            table_name: "initiative_objective_proposal_recoveries",
            function_identity: "truth.reject_mutation()",
            timing_and_events: "BEFORE DELETE OR UPDATE"
          },
          {
            name: "objective_recovery_valid_deferred",
            table_name: "initiative_objective_proposal_recoveries",
            function_identity: "truth.validate_objective_recovery()",
            timing_and_events: "AFTER INSERT",
            deferred: true
          },
          {
            name: "objective_support_command_guard",
            table_name: "initiative_objective_support_attestations",
            function_identity: "truth.require_reserved_command()",
            timing_and_events: "BEFORE INSERT",
            arguments: ["claim.create-or-rework.v1"]
          },
          {
            name: "objective_support_immutable",
            table_name: "initiative_objective_support_attestations",
            function_identity: "truth.reject_mutation()",
            timing_and_events: "BEFORE DELETE OR UPDATE"
          },
          {
            name: "objective_support_insert_guard",
            table_name: "initiative_objective_support_attestations",
            function_identity: "truth.validate_objective_support_attestation()",
            timing_and_events: "BEFORE INSERT"
          }
        ]
      : []),
    ...(phase >= 6
      ? [
          {
            name: "accepted_facts_lifecycle_deferred",
            table_name: "accepted_facts",
            function_identity: "truth.require_fact_lifecycle_event()",
            timing_and_events: "AFTER UPDATE",
            deferred: true
          },
          {
            name: "accepted_facts_lifecycle_guard",
            table_name: "accepted_facts",
            function_identity: "truth.enforce_fact_lifecycle_transition()",
            timing_and_events: "BEFORE UPDATE"
          },
          {
            name: "fact_lifecycle_command_guard",
            table_name: "fact_lifecycle_events",
            function_identity: "truth.require_fact_lifecycle_command()",
            timing_and_events: "BEFORE INSERT",
            arguments: ["fact.supersede-or-revoke.v1"]
          },
          {
            name: "fact_lifecycle_immutable",
            table_name: "fact_lifecycle_events",
            function_identity: "truth.reject_mutation()",
            timing_and_events: "BEFORE DELETE OR UPDATE"
          },
          {
            name: "fact_lifecycle_insert_guard",
            table_name: "fact_lifecycle_events",
            function_identity: "truth.validate_fact_lifecycle_event()",
            timing_and_events: "BEFORE INSERT"
          },
          {
            name: "fact_lifecycle_truncate_guard",
            table_name: "fact_lifecycle_events",
            function_identity: "truth.reject_statement_mutation()",
            timing_and_events: "BEFORE TRUNCATE",
            statement: true
          },
          {
            name: "fact_lifecycle_valid_deferred",
            table_name: "fact_lifecycle_events",
            function_identity: "truth.validate_fact_lifecycle_event()",
            timing_and_events: "AFTER INSERT",
            deferred: true
          }
        ]
      : [])
  ];
  const expectedTriggers = triggerContracts
    .map((contract) => {
      const rowInvocation = "FOR EACH ROW EXECUTE FUNCTION";
      const invocation = contract.statement ? "FOR EACH STATEMENT EXECUTE FUNCTION" : rowInvocation;
      return {
        name: contract.name,
        table_name: contract.table_name,
        function_identity: contract.function_identity,
        enabled: true,
        deferrable: contract.deferred ?? false,
        initially_deferred: contract.deferred ?? false,
        definition: `CREATE ${contract.deferred ? "CONSTRAINT " : ""}TRIGGER ${contract.name} ${contract.timing_and_events} ON truth.${contract.table_name}${contract.deferred ? " DEFERRABLE INITIALLY DEFERRED" : ""} ${invocation} ${contract.function_identity.slice(0, -2)}(${(contract.arguments ?? []).map((argument) => `'${argument}'`).join(", ")})`
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const triggers = await client.query<Record<string, unknown>>(
    `SELECT trigger_record.tgname AS name, relation.relname AS table_name,
            procedure.oid::regprocedure::text AS function_identity,
            trigger_record.tgenabled = 'O' AS enabled,
            trigger_record.tgdeferrable AS deferrable,
            trigger_record.tginitdeferred AS initially_deferred,
            pg_get_triggerdef(trigger_record.oid, true) AS definition
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

  const currentSlotIndexes = await client.query<{
    index_schema: string;
    index_name: string;
    table_schema: string;
    table_name: string;
    access_method: string;
    unique: boolean;
    ready: boolean;
    valid: boolean;
    immediate: boolean;
    primary: boolean;
    exclusion: boolean;
    nulls_not_distinct: boolean;
    key_attribute_count: number;
    attribute_count: number;
    key_columns: string[];
    predicate: string | null;
  }>(
    `SELECT index_namespace.nspname AS index_schema,
            index_relation.relname AS index_name,
            table_namespace.nspname AS table_schema,
            table_relation.relname AS table_name,
            access_method.amname AS access_method,
            index_state.indisunique AS unique,
            index_state.indisready AS ready,
            index_state.indisvalid AS valid,
            index_state.indimmediate AS immediate,
            index_state.indisprimary AS primary,
            index_state.indisexclusion AS exclusion,
            index_state.indnullsnotdistinct AS nulls_not_distinct,
            index_state.indnkeyatts AS key_attribute_count,
            index_state.indnatts AS attribute_count,
            ARRAY(
              SELECT attribute.attname::text
                FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
                  AS key_column(attribute_number, position)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = index_state.indrelid
                 AND attribute.attnum = key_column.attribute_number
               WHERE key_column.position <= index_state.indnkeyatts
               ORDER BY key_column.position
            ) AS key_columns,
            pg_get_expr(index_state.indpred, index_state.indrelid, false) AS predicate
       FROM pg_index index_state
       JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
       JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
       JOIN pg_class table_relation ON table_relation.oid = index_state.indrelid
       JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
       JOIN pg_am access_method ON access_method.oid = index_relation.relam
      WHERE index_namespace.nspname = 'truth'
        AND index_relation.relname = 'accepted_facts_one_current_slot'`
  );
  const currentSlotIndex = currentSlotIndexes.rows[0];
  if (
    currentSlotIndexes.rows.length !== 1 ||
    !currentSlotIndex ||
    JSON.stringify(currentSlotIndex) !==
      JSON.stringify({
        index_schema: "truth",
        index_name: "accepted_facts_one_current_slot",
        table_schema: "truth",
        table_name: "accepted_facts",
        access_method: "btree",
        unique: true,
        ready: true,
        valid: true,
        immediate: true,
        primary: false,
        exclusion: false,
        nulls_not_distinct: false,
        key_attribute_count: 6,
        attribute_count: 6,
        key_columns: [
          "tenant_id",
          "workspace_id",
          "space_id",
          "subject_type",
          "subject_id",
          "predicate"
        ],
        predicate: "(status = 'current'::text)"
      })
  ) {
    throw new Error("B2 Slice 1 current-Fact unique-slot index definition drifted");
  }

  const constraints = await client.query<{
    fact_support_deferred: boolean;
    claim_support_deferred: boolean;
    source_truth_triggers: string;
    reconciliation_function: string | null;
  }>(
    `SELECT
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
    !constraints.rows[0]?.fact_support_deferred ||
    !constraints.rows[0].claim_support_deferred ||
    constraints.rows[0].source_truth_triggers !== "0" ||
    constraints.rows[0].reconciliation_function !== null
  ) {
    throw new Error("B2 Slice 1 current-slot, support, or no-reconciliation boundary drifted");
  }
}

async function validateCommandBoundary(
  client: PgPoolClient,
  integritySource: string,
  lifecycleSource: string | undefined,
  recoverySource: string | undefined,
  factLifecycleSource: string | undefined,
  phase: number
): Promise<void> {
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
  await validateCommandFunctionSecurity(
    client,
    integritySource,
    lifecycleSource,
    recoverySource,
    factLifecycleSource,
    phase
  );
  const validClaimResponse =
    phase >= 5
      ? {
          claimId: "0190a000-0000-7000-8000-000000000302",
          evidenceSpanId: "0190a000-0000-7000-8000-000000000304",
          status: "proposed",
          version: 1
        }
      : {
          claimId: "0190a000-0000-7000-8000-000000000302",
          status: "proposed",
          version: 1
        };
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
         $1::jsonb
       ) AS claim_valid,
       ops.product_command_record_valid(
         'fact.accept.v1', 1, 'completed', 'accepted_fact',
         '0190a000-0000-7000-8000-000000000303'::uuid,
         '{"acceptedClaimIds":["0190a000-0000-7000-8000-000000000302"],
           "factId":"0190a000-0000-7000-8000-000000000303",
           "status":"current","version":1}'::jsonb
       ) AS fact_valid,
       ${phase >= 6 ? "" : "NOT "}ops.product_command_record_valid(
         'fact.revoke.v1', 1, 'reserved', NULL, NULL, NULL
       ) AS future_invalid,
       NOT ops.product_command_record_valid(
         'claim.create.v1', 1, 'completed', 'claim',
         '0190a000-0000-7000-8000-000000000302'::uuid,
         '{"claimId":"0190a000-0000-7000-8000-000000000302",
           "status":"proposed","version":1,"extra":true}'::jsonb
       ) AS malformed_invalid`,
    [JSON.stringify(validClaimResponse)]
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

async function validateCommandFunctionSecurity(
  client: PgPoolClient,
  integritySource: string,
  lifecycleSource: string | undefined,
  recoverySource: string | undefined,
  factLifecycleSource: string | undefined,
  phase: number
): Promise<void> {
  const safeRequestIdentity = "ops.b2_slice1_safe_request_valid(text,jsonb)" as const;
  // prettier-ignore
  const predecessorSafeRequestSource = migrationFunctionSource(recoverySource!, "ops.b2_slice1_safe_request_valid");
  const predecessorAtomicitySource = phase >= 3 ? lifecycleSource! : integritySource;
  const functionIdentities = [
    "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)",
    "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)",
    ...(phase >= 5 ? [safeRequestIdentity] : []),
    "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)",
    "ops.require_b2_slice1_command_atomicity()"
  ];
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
            COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration,
            procedure.prosrc AS source
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
      configuration: searchPath,
      source: migrationFunctionSource(
        phase >= 6 ? factLifecycleSource! : phase >= 5 ? recoverySource! : integritySource,
        "ops.b2_slice1_audit_detail_valid"
      )
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
      configuration: searchPath,
      source: migrationFunctionSource(
        phase >= 6 ? factLifecycleSource! : phase >= 5 ? recoverySource! : integritySource,
        "ops.b2_slice1_event_payload_valid"
      )
    },
    ...(phase >= 5
      ? [
          {
            identity: safeRequestIdentity,
            result: "boolean",
            language: "plpgsql",
            owner: "throughline_b1_0_integrity",
            security_definer: false,
            strict: true,
            volatility: "i",
            leakproof: false,
            parallel: "u",
            kind: "f",
            configuration: searchPath,
            source:
              phase >= 6
                ? migrationFunctionSource(factLifecycleSource!, "ops.b2_slice1_safe_request_valid")
                : predecessorSafeRequestSource
          }
        ]
      : []),
    {
      identity: "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)",
      result: "boolean",
      language: "plpgsql",
      owner: "migration_owner",
      security_definer: false,
      strict: false,
      volatility: "i",
      leakproof: false,
      parallel: "u",
      kind: "f",
      configuration: searchPath,
      source: migrationFunctionSource(
        phase >= 6 ? factLifecycleSource! : phase >= 5 ? recoverySource! : integritySource,
        "ops.product_command_record_valid"
      )
    },
    {
      identity: "ops.require_b2_slice1_command_atomicity()",
      result: "trigger",
      language: "plpgsql",
      owner: "throughline_b1_0_integrity",
      security_definer: true,
      strict: false,
      volatility: "v",
      leakproof: false,
      parallel: "u",
      kind: "f",
      configuration: searchPath,
      source: migrationFunctionSource(
        phase >= 6
          ? factLifecycleSource!
          : phase >= 5
            ? recoverySource!
            : predecessorAtomicitySource,
        "ops.require_b2_slice1_command_atomicity"
      )
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
    ...(phase >= 5
      ? [
          {
            identity: safeRequestIdentity,
            grantee: "throughline_app",
            privilege: "EXECUTE",
            grantable: false,
            grantor: "throughline_b1_0_integrity"
          }
        ]
      : []),
    {
      identity: "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)",
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

async function validateSourceTruthLifecycleInterlock(
  client: PgPoolClient,
  migrationSource: string
): Promise<void> {
  const identity = "ops.enforce_b2_source_truth_lifecycle_interlock()" as const;
  const functionShape = await client.query<Record<string, unknown>>(
    `SELECT procedure.oid::regprocedure::text AS identity,
            pg_get_function_result(procedure.oid) AS result,
            language.lanname AS language,
            pg_get_userbyid(procedure.proowner) AS owner,
            procedure.prosecdef AS security_definer,
            procedure.provolatile::text AS volatility,
            COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration,
            procedure.prosrc AS source
       FROM pg_proc procedure
       JOIN pg_language language ON language.oid = procedure.prolang
      WHERE procedure.oid = $1::regprocedure`,
    [identity]
  );
  if (
    JSON.stringify(functionShape.rows) !==
    JSON.stringify([
      {
        identity,
        result: "trigger",
        language: "plpgsql",
        owner: "throughline_b1_0_integrity",
        security_definer: true,
        volatility: "v",
        configuration: ["search_path=pg_catalog"],
        source: migrationFunctionSource(
          migrationSource,
          "ops.enforce_b2_source_truth_lifecycle_interlock"
        )
      }
    ])
  ) {
    throw new Error("B2 source/truth lifecycle interlock function drifted");
  }

  const privileges = await client.query<Record<string, unknown>>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                 ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            acl.privilege_type AS privilege,
            acl.is_grantable AS grantable
       FROM pg_proc procedure
       CROSS JOIN LATERAL aclexplode(COALESCE(
         procedure.proacl, acldefault('f', procedure.proowner)
       )) acl
      WHERE procedure.oid = $1::regprocedure
        AND acl.grantee <> procedure.proowner
      ORDER BY grantee, privilege, grantable`,
    [identity]
  );
  if (privileges.rows.length !== 0) {
    throw new Error("B2 source/truth lifecycle interlock is directly callable");
  }

  const triggers = await client.query<Record<string, unknown>>(
    `SELECT trigger_record.tgname AS name,
            trigger_record.tgrelid::regclass::text AS relation,
            procedure.oid::regprocedure::text AS function_identity,
            pg_get_triggerdef(trigger_record.oid, false) AS definition
       FROM pg_trigger trigger_record
       JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
      WHERE procedure.oid = $1::regprocedure
        AND NOT trigger_record.tgisinternal
      ORDER BY trigger_record.tgname`,
    [identity]
  );
  const expected = [
    {
      name: "source_artifacts_z_b2_correction_interlock",
      relation: "content.source_artifacts",
      event: "BEFORE INSERT",
      conditions: ["new.supersedes_source_id is not null"]
    },
    {
      name: "source_artifacts_z_b2_tombstone_interlock",
      relation: "content.source_artifacts",
      event: "BEFORE UPDATE",
      conditions: ["old.deleted_at is null", "new.deleted_at is not null"]
    },
    {
      name: "source_chunks_z_b2_delete_interlock",
      relation: "content.source_chunks",
      event: "BEFORE DELETE",
      conditions: []
    }
  ];
  if (
    triggers.rows.length !== expected.length ||
    triggers.rows.some((row, index) => {
      const wanted = expected[index]!;
      const definition = String(row.definition).toLowerCase().replaceAll(/[()"]/g, "");
      return (
        row.name !== wanted.name ||
        row.relation !== wanted.relation ||
        row.function_identity !== identity ||
        !definition.includes(wanted.event.toLowerCase()) ||
        wanted.conditions.some((condition) => !definition.includes(condition))
      );
    })
  ) {
    throw new Error("B2 source/truth lifecycle interlock trigger inventory drifted");
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
