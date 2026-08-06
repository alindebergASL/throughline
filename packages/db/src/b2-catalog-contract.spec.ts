import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { PgPoolClient } from "./client.js";
import {
  B2_MIGRATION_IDS,
  assertB2InitiativeLockMigrationSource,
  assertB2MigrationStateAbsent,
  assertProductValidatorDelegatesExactB1Kinds,
  validateB2CatalogContract
} from "./b2-catalog-contract.js";
import { exactTruthCatalogForPhase } from "./b2-exact-catalog.js";

const fixedPredecessors = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql",
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql"
] as const;

const factLifecycleUrl = new URL("../migrations/0012_b2_fact_lifecycle.sql", import.meta.url);
const normalizeSql = (source: string) => source.trim().replace(/\s+/g, " ");
const migrationFunctionSource = (migrationSource: string, identity: string) => {
  const qualifiedName = identity.slice(0, -2);
  const escapedName = qualifiedName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = migrationSource.match(
    new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION ${escapedName}\\(\\)[\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
    )
  )?.[1];
  if (source === undefined) {
    throw new Error(`Exact Slice 4A function source parser failed for ${identity}`);
  }
  return normalizeSql(source);
};
const exactPhase6LifecycleFunctionSources = {
  "truth.enforce_fact_lifecycle_transition()": normalizeSql(`
    DECLARE
      required_kind text;
      subject_version integer;
    BEGIN
      IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = 'TLB22',
          MESSAGE = 'Truth mutation transaction is unavailable';
      END IF;
      required_kind := CASE NEW.status
        WHEN 'superseded' THEN 'fact.supersede.v1'
        WHEN 'revoked' THEN 'fact.revoke.v1'
        ELSE NULL
      END;
      IF OLD.status <> 'current' OR OLD.version <> 1 OR required_kind IS NULL
        OR NEW.version <> 2
        OR NEW.last_causation_command_id IS NOT DISTINCT FROM OLD.last_causation_command_id
        OR NEW.updated_at IS DISTINCT FROM pg_catalog.transaction_timestamp()
        OR (pg_catalog.to_jsonb(NEW) - ARRAY[
          'status','last_causation_command_id','updated_at','version'
        ]) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
          'status','last_causation_command_id','updated_at','version'
        ])
      THEN
        RAISE EXCEPTION 'accepted Fact lifecycle transition is not permitted';
      END IF;
      IF OLD.subject_type = 'activity' THEN
        SELECT subject.version INTO subject_version
          FROM work.activities subject
         WHERE subject.tenant_id = OLD.tenant_id
           AND subject.workspace_id = OLD.workspace_id
           AND subject.space_id = OLD.space_id
           AND subject.id = OLD.subject_id
         FOR SHARE;
      ELSE
        SELECT subject.version INTO subject_version
          FROM work.initiatives subject
         WHERE subject.tenant_id = OLD.tenant_id
           AND subject.workspace_id = OLD.workspace_id
           AND subject.space_id = OLD.space_id
           AND subject.id = OLD.subject_id
         FOR SHARE;
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM ops.domain_command_records command
         WHERE command.tenant_id = NEW.tenant_id
           AND command.workspace_id = NEW.workspace_id
           AND command.reservation_space_id = NEW.space_id
           AND command.id = NEW.last_causation_command_id
           AND command.state = 'reserved'
           AND command.command_kind = required_kind
           AND command.command_schema_version = 1
           AND command.actor_user_id = ops.current_user_id()
           AND command.actor_membership_id = ops.current_membership_id()
           AND command.policy_version_id = ops.current_policy_version()
           AND command.safe_request ->> 'factId' = OLD.id::text
           AND (command.safe_request ->> 'expectedFactVersion')::integer = OLD.version
           AND (required_kind = 'fact.revoke.v1' OR (
             command.safe_request #>> '{subject,type}' = OLD.subject_type
             AND command.safe_request #>> '{subject,id}' = OLD.subject_id::text
           ))
      ) THEN
        RAISE EXCEPTION 'accepted Fact lifecycle transition requires its exact reserved command';
      END IF;
      IF required_kind = 'fact.supersede.v1' AND (
        subject_version IS NULL OR NOT EXISTS (
          SELECT 1
            FROM ops.domain_command_records command
           WHERE command.tenant_id = NEW.tenant_id
             AND command.workspace_id = NEW.workspace_id
             AND command.id = NEW.last_causation_command_id
             AND (command.safe_request #>> '{subject,expectedVersion}')::integer = subject_version
        )
      ) THEN
        RAISE EXCEPTION USING
          MESSAGE = 'fact supersede subject version is stale';
      END IF;
      RETURN NEW;
    END
  `),
  "truth.require_fact_lifecycle_command()": normalizeSql(`
    BEGIN
      IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = 'TLB22',
          MESSAGE = 'Truth mutation transaction is unavailable';
      END IF;
      IF NEW.recorded_at IS DISTINCT FROM pg_catalog.transaction_timestamp()
        OR NEW.acted_by_user_id IS DISTINCT FROM ops.current_user_id()
        OR NEW.acted_by_membership_id IS DISTINCT FROM ops.current_membership_id()
        OR NEW.policy_version IS DISTINCT FROM ops.current_policy_version()
        OR NOT EXISTS (
          SELECT 1
            FROM truth.accepted_facts predecessor
            JOIN ops.domain_command_records command
              ON command.tenant_id = predecessor.tenant_id
             AND command.workspace_id = predecessor.workspace_id
             AND command.reservation_space_id = predecessor.space_id
             AND command.id = NEW.causation_command_id
           WHERE predecessor.tenant_id = NEW.tenant_id
             AND predecessor.workspace_id = NEW.workspace_id
             AND predecessor.space_id = NEW.space_id
             AND predecessor.id = NEW.predecessor_fact_id
             AND predecessor.status = NEW.to_status
             AND predecessor.version = 2
             AND predecessor.last_causation_command_id = NEW.causation_command_id
             AND predecessor.authority_basis = NEW.authority_basis
             AND command.state = 'reserved'
             AND command.command_schema_version = 1
             AND command.command_kind = CASE NEW.transition_kind
               WHEN 'supersede' THEN 'fact.supersede.v1'
               WHEN 'revoke' THEN 'fact.revoke.v1'
             END
             AND command.actor_user_id = NEW.acted_by_user_id
             AND command.actor_membership_id = NEW.acted_by_membership_id
             AND command.policy_version_id = NEW.policy_version
             AND command.safe_request ->> 'factId' = predecessor.id::text
             AND (command.safe_request ->> 'expectedFactVersion')::integer = 1
             AND command.safe_request #>> '{reason,code}' = NEW.reason_code
             AND command.safe_request #>> '{reason,rationale}' = NEW.reason_rationale
             AND (NEW.transition_kind = 'revoke' OR (
               command.safe_request #>> '{subject,type}' = predecessor.subject_type
               AND command.safe_request #>> '{subject,id}' = predecessor.subject_id::text
             ))
        )
      THEN
        RAISE EXCEPTION 'Fact lifecycle event requires its exact reserved command';
      END IF;
      RETURN NEW;
    END
  `),
  "truth.require_fact_lifecycle_event()": normalizeSql(`
    BEGIN
      IF OLD.status = 'current' AND NEW.status IN ('superseded','revoked')
        AND NOT EXISTS (
          SELECT 1
            FROM truth.fact_lifecycle_events lifecycle
           WHERE lifecycle.tenant_id = NEW.tenant_id
             AND lifecycle.workspace_id = NEW.workspace_id
             AND lifecycle.space_id = NEW.space_id
             AND lifecycle.predecessor_fact_id = NEW.id
             AND lifecycle.causation_command_id = NEW.last_causation_command_id
             AND lifecycle.from_status = OLD.status
             AND lifecycle.to_status = NEW.status
             AND lifecycle.transition_kind = CASE NEW.status
               WHEN 'superseded' THEN 'supersede'
               WHEN 'revoked' THEN 'revoke'
             END
        )
      THEN
        RAISE EXCEPTION 'accepted Fact lifecycle transition requires exactly one lineage event';
      END IF;
      RETURN NEW;
    END
  `),
  "truth.reject_statement_mutation()": normalizeSql(`
    BEGIN
      RAISE EXCEPTION 'truth statement mutation is not permitted';
    END
  `),
  "truth.validate_fact_lifecycle_event()": normalizeSql(`
    DECLARE
      predecessor truth.accepted_facts%ROWTYPE;
      successor truth.accepted_facts%ROWTYPE;
      command_record ops.domain_command_records%ROWTYPE;
    BEGIN
      SELECT * INTO predecessor
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id
         AND fact.workspace_id = NEW.workspace_id
         AND fact.space_id = NEW.space_id
         AND fact.id = NEW.predecessor_fact_id;
      IF NOT FOUND OR predecessor.status <> NEW.to_status
        OR predecessor.version <> 2
        OR predecessor.last_causation_command_id <> NEW.causation_command_id
      THEN
        RAISE EXCEPTION 'Fact lifecycle predecessor is inconsistent';
      END IF;
      IF NEW.transition_kind = 'supersede' THEN
        SELECT * INTO successor
          FROM truth.accepted_facts fact
         WHERE fact.tenant_id = NEW.tenant_id
           AND fact.workspace_id = NEW.workspace_id
           AND fact.space_id = NEW.space_id
           AND fact.id = NEW.successor_fact_id;
        IF NOT FOUND OR successor.status <> 'current' OR successor.version <> 1
          OR successor.last_causation_command_id <> NEW.causation_command_id
          OR successor.subject_type <> predecessor.subject_type
          OR successor.subject_id <> predecessor.subject_id
          OR successor.predicate <> predecessor.predicate
        THEN
          RAISE EXCEPTION 'Fact supersession lineage is inconsistent';
        END IF;
      ELSIF NEW.successor_fact_id IS NOT NULL THEN
        RAISE EXCEPTION 'Fact revocation cannot identify a successor';
      END IF;
      IF TG_WHEN = 'AFTER' THEN
        SELECT * INTO command_record
          FROM ops.domain_command_records command
         WHERE command.tenant_id = NEW.tenant_id
           AND command.workspace_id = NEW.workspace_id
           AND command.id = NEW.causation_command_id;
        IF NOT FOUND OR command_record.state <> 'completed'
          OR command_record.result_resource_type <> 'accepted_fact'
          OR command_record.result_resource_id <> NEW.predecessor_fact_id
          OR NOT ops.product_command_record_valid(
            command_record.command_kind, command_record.command_schema_version,
            command_record.state, command_record.result_resource_type,
            command_record.result_resource_id, command_record.safe_response
          )
        THEN
          RAISE EXCEPTION 'Fact lifecycle command completion is inconsistent';
        END IF;
      END IF;
      RETURN NEW;
    END
  `)
} as const;

const exactFactScope =
  "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class))";
const exactLifecycleScope =
  "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (EXISTS ( SELECT 1\n   FROM truth.accepted_facts predecessor\n  WHERE ((predecessor.tenant_id = fact_lifecycle_events.tenant_id) AND (predecessor.workspace_id = fact_lifecycle_events.workspace_id) AND (predecessor.space_id = fact_lifecycle_events.space_id) AND (predecessor.id = fact_lifecycle_events.predecessor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)))) AND ((successor_fact_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM truth.accepted_facts successor\n  WHERE ((successor.tenant_id = fact_lifecycle_events.tenant_id) AND (successor.workspace_id = fact_lifecycle_events.workspace_id) AND (successor.space_id = fact_lifecycle_events.space_id) AND (successor.id = fact_lifecycle_events.successor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class))))))";
const exactLifecycleInsertScope =
  "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (acted_by_user_id = ops.current_user_id()) AND (acted_by_membership_id = ops.current_membership_id()) AND (policy_version = ops.current_policy_version()) AND (EXISTS ( SELECT 1\n   FROM truth.accepted_facts predecessor\n  WHERE ((predecessor.tenant_id = fact_lifecycle_events.tenant_id) AND (predecessor.workspace_id = fact_lifecycle_events.workspace_id) AND (predecessor.space_id = fact_lifecycle_events.space_id) AND (predecessor.id = fact_lifecycle_events.predecessor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)))) AND ((successor_fact_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM truth.accepted_facts successor\n  WHERE ((successor.tenant_id = fact_lifecycle_events.tenant_id) AND (successor.workspace_id = fact_lifecycle_events.workspace_id) AND (successor.space_id = fact_lifecycle_events.space_id) AND (successor.id = fact_lifecycle_events.successor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class))))))";

const exactPhase6PolicyAdditions = [
  {
    table_name: "accepted_facts",
    policy_name: "accepted_facts_lifecycle_update",
    operation: "w",
    permissive: true,
    roles: ["throughline_app"],
    using_expression: exactFactScope,
    check_expression: exactFactScope
  },
  {
    table_name: "fact_lifecycle_events",
    policy_name: "fact_lifecycle_insert",
    operation: "a",
    permissive: true,
    roles: ["throughline_app"],
    using_expression: null,
    check_expression: exactLifecycleInsertScope
  },
  {
    table_name: "fact_lifecycle_events",
    policy_name: "fact_lifecycle_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  },
  {
    table_name: "fact_lifecycle_events",
    policy_name: "fact_lifecycle_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_app"],
    using_expression: exactLifecycleScope,
    check_expression: null
  }
] as const;

const exactPhase6ConstraintAdditions = [
  {
    table_name: "accepted_facts",
    name: "accepted_facts_lifecycle_deferred",
    type: "t",
    definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "accepted_facts",
    name: "accepted_facts_status_check",
    type: "c",
    definition:
      "CHECK ((status = ANY (ARRAY['current'::text, 'superseded'::text, 'revoked'::text])))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "accepted_facts",
    name: "accepted_facts_version_check",
    type: "c",
    definition:
      "CHECK ((((status = 'current'::text) AND (version = 1)) OR ((status = ANY (ARRAY['superseded'::text, 'revoked'::text])) AND (version = 2))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_actor_membership_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, acted_by_membership_id, acted_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_actor_user_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (acted_by_user_id) REFERENCES identity.users(id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_authority_check",
    type: "c",
    definition:
      "CHECK ((authority_basis = ANY (ARRAY['activity_owner'::text, 'initiative_owner'::text])))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_command_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_command_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, causation_command_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_id_check",
    type: "c",
    definition: "CHECK (ops.is_uuid_v7(id))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_pkey",
    type: "p",
    definition: "PRIMARY KEY (id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_policy_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, policy_version) REFERENCES identity.policy_versions(tenant_id, workspace_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_predecessor_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_fact_id) REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_predecessor_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, predecessor_fact_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_rationale_check",
    type: "c",
    definition:
      "CHECK (((reason_rationale = NORMALIZE(reason_rationale, NFC)) AND (reason_rationale = btrim(reason_rationale)) AND ((length(reason_rationale) >= 1) AND (length(reason_rationale) <= 2000))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_reason_check",
    type: "c",
    definition:
      "CHECK ((((transition_kind = 'supersede'::text) AND (reason_code = ANY (ARRAY['newer_evidence'::text, 'accepted_value_changed'::text, 'corrected_source_revalidated'::text]))) OR ((transition_kind = 'revoke'::text) AND (reason_code = ANY (ARRAY['no_longer_true'::text, 'support_invalidated'::text, 'entered_in_error'::text])))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_successor_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, successor_fact_id) REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_successor_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, successor_fact_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_tenant_workspace_id_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_tenant_workspace_space_id_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_timestamp_check",
    type: "c",
    definition: "CHECK ((recorded_at = transaction_timestamp()))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_transition_shape_check",
    type: "c",
    definition:
      "CHECK ((((transition_kind = 'supersede'::text) AND (from_status = 'current'::text) AND (to_status = 'superseded'::text) AND (successor_fact_id IS NOT NULL) AND (successor_fact_id <> predecessor_fact_id)) OR ((transition_kind = 'revoke'::text) AND (from_status = 'current'::text) AND (to_status = 'revoked'::text) AND (successor_fact_id IS NULL))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_version_check",
    type: "c",
    definition: "CHECK ((version = 1))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_valid_deferred",
    type: "t",
    definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  }
] as const;

const exactPhase6IndexAdditions = [
  ["fact_lifecycle_events_command_key", "tenant_id, workspace_id, causation_command_id"],
  ["fact_lifecycle_events_pkey", "id"],
  ["fact_lifecycle_events_predecessor_key", "tenant_id, workspace_id, predecessor_fact_id"],
  ["fact_lifecycle_events_successor_key", "tenant_id, workspace_id, successor_fact_id"],
  ["fact_lifecycle_events_tenant_workspace_id_key", "tenant_id, workspace_id, id"],
  ["fact_lifecycle_events_tenant_workspace_space_id_key", "tenant_id, workspace_id, space_id, id"]
].map(([index_name, columns]) => ({
  table_name: "fact_lifecycle_events",
  index_name,
  unique: true,
  primary: index_name === "fact_lifecycle_events_pkey",
  valid: true,
  ready: true,
  live: true,
  definition: `CREATE UNIQUE INDEX ${index_name} ON truth.fact_lifecycle_events USING btree (${columns})`
}));

describe("B2 Slice 1 catalog contract unit boundary", () => {
  it("extends the exact contiguous journal with only the Slice 4A lifecycle migration", () => {
    expect(B2_MIGRATION_IDS).toEqual([
      "0007_b2_slice1_truth_storage.sql",
      "0008_b2_slice1_command_integrity.sql",
      "0009_b2_source_truth_lifecycle_interlock.sql",
      "0010_b2_trusted_objective_initiative_lock.sql",
      "0011_b2_primary_objective_proposal_recovery.sql",
      "0012_b2_fact_lifecycle.sql"
    ]);
  });

  it("treats an exact B1 journal as pre-B2 without querying a future catalog", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PgPoolClient;
    const journal = new Map(fixedPredecessors.map((id) => [id, "checksum"]));

    await expect(validateB2CatalogContract(client, journal, new Map())).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on a missing predecessor before querying the installed catalog", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PgPoolClient;
    const journal = new Map(fixedPredecessors.slice(1).map((id) => [id, "checksum"]));

    await expect(validateB2CatalogContract(client, journal, new Map())).rejects.toThrow(
      "B2 migration journal is missing a fixed predecessor"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on a gapped B2 journal before querying the installed catalog", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PgPoolClient;
    const journal = new Map([
      ...fixedPredecessors.map((id) => [id, "checksum"] as const),
      ["0008_b2_slice1_command_integrity.sql", "checksum"] as const
    ]);

    await expect(validateB2CatalogContract(client, journal, new Map())).rejects.toThrow(
      "B2 migration journal is not an exact contiguous prefix"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("uses non-throwing probes for unjournaled B2 state", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ installed: null }], rowCount: 1 });
    const client = { query } as unknown as PgPoolClient;

    await assertB2MigrationStateAbsent(client, "0007_b2_slice1_truth_storage.sql");
    await assertB2MigrationStateAbsent(client, "0008_b2_slice1_command_integrity.sql");
    await assertB2MigrationStateAbsent(client, "0009_b2_source_truth_lifecycle_interlock.sql");
    await assertB2MigrationStateAbsent(client, "0010_b2_trusted_objective_initiative_lock.sql");
    await assertB2MigrationStateAbsent(client, "0011_b2_primary_objective_proposal_recovery.sql");
    await assertB2MigrationStateAbsent(
      client,
      "0012_b2_fact_lifecycle.sql" as Parameters<typeof assertB2MigrationStateAbsent>[1]
    );

    expect(query.mock.calls[0]?.[0]).toContain("to_regnamespace('truth')");
    expect(query.mock.calls[1]?.[0]).toContain("ops.product_command_record_valid");
    expect(query.mock.calls[2]?.[0]).toContain("ops.enforce_b2_source_truth_lifecycle_interlock");
    expect(query.mock.calls[3]?.[0]).toContain("has_column_privilege");
    expect(query.mock.calls[3]?.[0]).toContain("work.initiatives");
    expect(query.mock.calls[3]?.[0]).toContain("'id','UPDATE'");
    expect(query.mock.calls[3]?.[0]).toContain("FROM pg_policy");
    expect(query.mock.calls[3]?.[0]).toContain("to_regclass('work.initiatives')");
    expect(query.mock.calls[3]?.[1]).toEqual([
      ["initiatives_app_truth_lock", "initiatives_app_permanent_no_write"]
    ]);
    expect(query.mock.calls[4]?.[0]).toContain("truth.initiative_objective_support_attestations");
    expect(query.mock.calls[5]?.[0]).toContain("truth.fact_lifecycle_events");
  });

  it("rejects an unjournaled Initiative lock capability", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ installed: true }], rowCount: 1 });
    const client = { query } as unknown as PgPoolClient;

    await expect(
      assertB2MigrationStateAbsent(client, "0010_b2_trusted_objective_initiative_lock.sql")
    ).rejects.toThrow(
      "B2 migration state already exists without journal row for 0010_b2_trusted_objective_initiative_lock.sql"
    );
  });

  it("accepts only the exact phase-4 Initiative lock migration source", async () => {
    const source = await readFile(
      new URL("../migrations/0010_b2_trusted_objective_initiative_lock.sql", import.meta.url),
      "utf8"
    );

    expect(() => assertB2InitiativeLockMigrationSource(source)).not.toThrow();
    for (const mutation of [
      `${source}GRANT SELECT ON work.initiatives TO throughline_worker;\n`,
      source.replace("UPDATE (id)", "UPDATE (id, title)"),
      source.replace("UPDATE (id)", "UPDATE"),
      source.replaceAll("throughline_app", "PUBLIC"),
      source.replace(
        "GRANT UPDATE (id) ON work.initiatives TO throughline_app;",
        "GRANT UPDATE (id) ON work.initiatives TO throughline_app WITH GRANT OPTION;"
      ),
      source.replace("tenant_id = ops.current_tenant_id() AND ", ""),
      source.replace("workspace_id = ops.current_workspace_id()\n", "true\n"),
      source.replace("AND space_id = ops.current_space_id()\n", ""),
      source.replace("AND governing_space.archived_at IS NULL\n", ""),
      source.replace("WITH CHECK (false);", "WITH CHECK (true);"),
      source.replace(
        /CREATE POLICY initiatives_app_permanent_no_write[\s\S]*?WITH CHECK \(false\);\n\n/,
        ""
      ),
      source.replace("AS RESTRICTIVE FOR UPDATE", "AS PERMISSIVE FOR UPDATE"),
      source.replace("FOR UPDATE TO throughline_app", "FOR ALL TO throughline_app"),
      `${source}CREATE TABLE truth.future_store (id uuid);\n`,
      `${source}-- fact_lifecycle future work\n`
    ]) {
      expect(() => assertB2InitiativeLockMigrationSource(mutation)).toThrow(
        "B2 Initiative lock migration source drifted"
      );
    }
  });

  it("pins only the four Slice 1 tables and two executable commands", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    for (const table of ["accepted_facts", "claims", "fact_claims", "verified_evidence_spans"]) {
      expect(contract).toContain(`"${table}"`);
    }
    expect(contract).toContain('"claim.create.v1", "fact.accept.v1"');
    expect(contract).toContain("domain_command_records_b2_slice1_atomicity_deferred");
    expect(contract).not.toContain("command_effects_immutable");
    expect(contract).not.toContain("require_product_command_atomicity");
  });

  it("adds only the objective recovery catalog without generalized Claim or Fact lifecycle", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const migration = await readFile(
      new URL("../migrations/0011_b2_primary_objective_proposal_recovery.sql", import.meta.url),
      "utf8"
    );

    for (const bounded of [
      "initiative_objective_support_attestations",
      "initiative_objective_proposal_recoveries",
      "initiative.primary_objective.withdraw.v1",
      "initiative.primary_objective.rework.v1",
      "claims_one_active_primary_objective_proposal"
    ]) {
      expect(contract).toContain(bounded);
      expect(migration).toContain(bounded);
    }
    expect(migration).not.toMatch(
      /fact\.(?:contest|uphold|supersede|revoke)|derived_view\.regenerate|CREATE TABLE truth\.(?:conflict|fact_lifecycle|claim_lifecycle)/
    );
  });

  it("compares every phase-5 constraint and index by exact normalized catalog definition", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const objectiveCatalog = contract.slice(
      contract.indexOf("async function validateObjectiveRecoveryCatalog"),
      contract.indexOf("async function validateTruthTables")
    );
    expect(objectiveCatalog).toContain("pg_get_constraintdef(constraint_record.oid, false)");
    expect(objectiveCatalog).toContain("pg_get_indexdef(index_record.indexrelid, 0, false)");
    expect(objectiveCatalog).toContain("exactObjectiveRecoveryConstraints(");
    expect(objectiveCatalog).toContain("exactObjectiveRecoveryIndexes()");
    expect(objectiveCatalog).toContain("FOREIGN KEY (tenant_id, workspace_id, space_id");
    expect(objectiveCatalog).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(objectiveCatalog).toContain("PRIMARY KEY (id)");
    expect(objectiveCatalog).toContain("UNIQUE (tenant_id, workspace_id, causation_command_id)");
    expect(objectiveCatalog).toContain("CHECK ((version = 1))");
    expect(objectiveCatalog).not.toMatch(/active_index_(?:definition|predicate).*\.includes/);
  });

  it("keeps generalized objective-recovery storage exclusions exact across phases 5 and 6", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const phaseForbiddenContract =
      contract.match(
        /function objectiveRecoveryForbiddenRelations[\s\S]*?\n}\n\nasync function validateObjectiveRecoveryCatalog/
      )?.[0] ?? "";
    const objectiveCatalog = contract.slice(
      contract.indexOf("async function validateObjectiveRecoveryCatalog"),
      contract.indexOf("function exactObjectiveRecoveryPolicies")
    );

    expect
      .soft(phaseForbiddenContract)
      .toMatch(
        /case 5:\s+return \[\s*"conflict_groups",\s*"fact_lifecycle_events",\s*"fact_supersessions",\s*"derived_view_snapshots"\s*\];/
      );
    expect
      .soft(phaseForbiddenContract)
      .toMatch(
        /case 6:\s+return \[\s*"conflict_groups",\s*"fact_supersessions",\s*"derived_view_snapshots"\s*\];/
      );
    expect
      .soft(phaseForbiddenContract)
      .toMatch(
        /default:\s+throw new Error\("Objective recovery catalog received unsupported B2 phase"\);/
      );
    expect
      .soft(objectiveCatalog)
      .toContain("const forbiddenRelations = objectiveRecoveryForbiddenRelations(phase);");
    expect.soft(objectiveCatalog).toContain("relation.relname = ANY($1::text[])");
    expect.soft(objectiveCatalog).toMatch(/AS present`,\s*\[forbiddenRelations\]\s*\);/);
    expect
      .soft(objectiveCatalog)
      .not.toMatch(/relation\.relname IN \(\s*'conflict_groups','fact_lifecycle_events'/);
  });

  it("closes every non-index truth relation and ACL without expected-name filtering", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const relationInventory = contract.slice(
      contract.indexOf("async function validateTruthTables"),
      contract.indexOf("async function validateTruthColumnsAndConstraints")
    );
    const aclInventory = contract.slice(
      contract.indexOf("async function validateTruthSecurity"),
      contract.indexOf("async function validateTruthFunctions")
    );

    for (const inventory of [relationInventory, aclInventory]) {
      expect(inventory).toContain("relation.relkind NOT IN ('i','I')");
      expect(inventory).not.toContain("relation.relname = ANY");
    }
    expect(relationInventory).toContain(
      "CASE WHEN relation.relowner = current_user::regrole THEN 'migration_owner'"
    );
    expect(relationInventory).toContain("ELSE pg_get_userbyid(relation.relowner) END AS owner");
  });

  it("encodes the canonical phase catalog as compact exact deltas", () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((phase) => {
        const catalog = exactTruthCatalogForPhase(phase);
        return [
          catalog.relations.length,
          catalog.policies.length,
          catalog.constraints.length,
          catalog.indexes.length
        ];
      })
    ).toEqual([
      [4, 9, 70, 13],
      [4, 13, 70, 13],
      [4, 13, 68, 13],
      [4, 13, 68, 13],
      [6, 19, 100, 23],
      [7, 23, 121, 29]
    ]);
    expect(exactTruthCatalogForPhase(6).relations.map(({ owner }) => owner)).toEqual(
      Array(7).fill("migration_owner")
    );
  });

  it("encodes the smallest exact ordinary Fact lifecycle catalog delta", async () => {
    const phase5 = exactTruthCatalogForPhase(5);
    const phase6 = exactTruthCatalogForPhase(6);
    const addedRows = <T>(current: T[], predecessor: T[]) => {
      const predecessorRows = new Set(predecessor.map((row) => JSON.stringify(row)));
      return current.filter((row) => !predecessorRows.has(JSON.stringify(row)));
    };

    expect(addedRows(phase6.relations, phase5.relations)).toEqual([
      {
        name: "fact_lifecycle_events",
        kind: "r",
        persistence: "p",
        rls: true,
        forced_rls: true,
        owner: "migration_owner"
      }
    ]);
    expect(addedRows(phase6.policies, phase5.policies)).toEqual(exactPhase6PolicyAdditions);
    for (const policyName of ["fact_lifecycle_insert", "fact_lifecycle_select"]) {
      const policy = phase6.policies.find(({ policy_name }) => policy_name === policyName);
      const expression = policy?.check_expression ?? policy?.using_expression;
      expect(expression).toContain("predecessor.id = fact_lifecycle_events.predecessor_fact_id");
      expect(expression).toContain("access.can_read_space(");
      expect(expression).toContain("((successor_fact_id IS NULL) OR (EXISTS ( SELECT 1");
      expect(expression).toContain("successor.id = fact_lifecycle_events.successor_fact_id");
      expect(expression).toContain(
        "access.can_read_space(fact_lifecycle_events.space_id, successor.access_class)"
      );
    }
    expect(addedRows(phase6.constraints, phase5.constraints)).toEqual(
      exactPhase6ConstraintAdditions
    );
    expect(addedRows(phase6.indexes, phase5.indexes)).toEqual(exactPhase6IndexAdditions);
    expect(addedRows(phase5.constraints, phase6.constraints)).toEqual([
      {
        table_name: "accepted_facts",
        name: "accepted_facts_status_check",
        type: "c",
        definition: "CHECK ((status = 'current'::text))",
        deferrable: false,
        initially_deferred: false,
        validated: true
      },
      {
        table_name: "accepted_facts",
        name: "accepted_facts_version_check",
        type: "c",
        definition: "CHECK ((version = 1))",
        deferrable: false,
        initially_deferred: false,
        validated: true
      }
    ]);
    expect(phase6.indexes).toContainEqual(
      phase5.indexes.find(({ index_name }) => index_name === "accepted_facts_one_current_slot")
    );

    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    expect(contract).toMatch(
      /fact_lifecycle_events:\s*\[\s*"id",\s*"tenant_id",\s*"workspace_id",\s*"space_id",\s*"predecessor_fact_id",\s*"successor_fact_id",\s*"transition_kind",\s*"from_status",\s*"to_status",\s*"reason_code",\s*"reason_rationale",\s*"authority_basis",\s*"policy_version",\s*"acted_by_user_id",\s*"acted_by_membership_id",\s*"causation_command_id",\s*"recorded_at",\s*"version"\s*\]/
    );
    for (const required of [
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
      expect(contract).toContain(required);
    }
    const triggerContract = contract.slice(
      contract.indexOf("async function validateTruthConstraintsAndTriggers"),
      contract.indexOf("const currentSlotIndexes")
    );
    for (const trigger of [
      "accepted_facts_lifecycle_deferred",
      "accepted_facts_lifecycle_guard",
      "fact_lifecycle_command_guard",
      "fact_lifecycle_immutable",
      "fact_lifecycle_insert_guard",
      "fact_lifecycle_truncate_guard",
      "fact_lifecycle_valid_deferred"
    ]) {
      expect(triggerContract).toContain(trigger);
    }
    expect(triggerContract).toContain("fact.accept-or-supersede.v1");
    expect(triggerContract).toContain("fact.supersede-or-revoke.v1");
  });

  it("pins canonical lifecycle UNIQUE names and deferred trigger constraints", async () => {
    const migration = await readFile(factLifecycleUrl, "utf8");
    const phase6 = exactTruthCatalogForPhase(6);
    const namedUniqueConstraints = [
      ...migration.matchAll(/CONSTRAINT (fact_lifecycle_events_[a-z_]+)\s+UNIQUE \(([^)]+)\)/g)
    ].map((match) => [match[1], match[2]]);

    expect(namedUniqueConstraints).toEqual([
      ["fact_lifecycle_events_tenant_workspace_id_key", "tenant_id, workspace_id, id"],
      [
        "fact_lifecycle_events_tenant_workspace_space_id_key",
        "tenant_id, workspace_id, space_id, id"
      ],
      ["fact_lifecycle_events_predecessor_key", "tenant_id, workspace_id, predecessor_fact_id"],
      ["fact_lifecycle_events_successor_key", "tenant_id, workspace_id, successor_fact_id"],
      ["fact_lifecycle_events_command_key", "tenant_id, workspace_id, causation_command_id"]
    ]);
    expect([...migration.matchAll(/\bUNIQUE \(/g)]).toHaveLength(5);

    expect(
      phase6.constraints.filter(({ name }) =>
        ["accepted_facts_lifecycle_deferred", "fact_lifecycle_valid_deferred"].includes(name)
      )
    ).toEqual([
      {
        table_name: "accepted_facts",
        name: "accepted_facts_lifecycle_deferred",
        type: "t",
        definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
        deferrable: true,
        initially_deferred: true,
        validated: true
      },
      {
        table_name: "fact_lifecycle_events",
        name: "fact_lifecycle_valid_deferred",
        type: "t",
        definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
        deferrable: true,
        initially_deferred: true,
        validated: true
      }
    ]);

    for (const autoGeneratedName of [
      "fact_lifecycle_events_tenant_id_workspace_id_causation_comm_key",
      "fact_lifecycle_events_tenant_id_workspace_id_id_key",
      "fact_lifecycle_events_tenant_id_workspace_id_predecessor_fa_key",
      "fact_lifecycle_events_tenant_id_workspace_id_space_id_id_key",
      "fact_lifecycle_events_tenant_id_workspace_id_successor_fact_key"
    ]) {
      expect(phase6.constraints.map(({ name }) => name)).not.toContain(autoGeneratedName);
    }
  });

  it("pins every Slice 4A lifecycle function row and body independently", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const functionContract = contract.slice(
      contract.indexOf("async function validateTruthFunctions"),
      contract.indexOf("async function validateTruthConstraintsAndTriggers")
    );
    expect(functionContract).toMatch(
      /const factLifecycleFunctionIdentities = \[\s*"truth\.enforce_fact_lifecycle_transition\(\)",\s*"truth\.require_fact_lifecycle_command\(\)",\s*"truth\.require_fact_lifecycle_event\(\)",\s*"truth\.reject_statement_mutation\(\)",\s*"truth\.validate_fact_lifecycle_event\(\)"\s*\] as const;/
    );
    expect(functionContract).toContain("...(phase >= 6 ? factLifecycleFunctionIdentities : [])");
    expect(functionContract).toContain(
      "migrationFunctionSource(factLifecycleSource!, identity.slice(0, -2))"
    );
    for (const field of [
      "pg_get_function_result(procedure.oid) AS result",
      "language.lanname AS language",
      "procedure.proowner",
      "procedure.prosecdef AS security_definer",
      "procedure.proisstrict AS strict",
      "procedure.provolatile::text AS volatility",
      "procedure.proleakproof AS leakproof",
      "procedure.proparallel::text AS parallel",
      "procedure.prokind::text AS kind",
      "COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration",
      "procedure.prosrc AS source",
      "acl.privilege_type AS privilege",
      "acl.is_grantable AS grantable"
    ]) {
      expect(functionContract).toContain(field);
    }
    const migration = await readFile(factLifecycleUrl, "utf8");
    expect(
      Object.fromEntries(
        Object.keys(exactPhase6LifecycleFunctionSources).map((identity) => [
          identity,
          migrationFunctionSource(migration, identity)
        ])
      )
    ).toEqual(exactPhase6LifecycleFunctionSources);
  });

  it("trims the connected phase-6 lifecycle prosrc after collapsing whitespace", async () => {
    const connectedContract = await readFile(
      new URL("./b2-catalog-contract.postgres.spec.ts", import.meta.url),
      "utf8"
    );
    const lifecycleQuery = connectedContract.slice(
      connectedContract.indexOf("const lifecycleFunctions = await ownerPool.query"),
      connectedContract.indexOf(
        "expect(lifecycleFunctions.rows).toEqual(exactPhase6LifecycleFunctionCatalog)"
      )
    );

    expect(lifecycleQuery).toContain(
      "btrim(regexp_replace(procedure.prosrc, '[[:space:]]+', ' ', 'g')) AS source"
    );
    expect(lifecycleQuery).not.toContain(
      "regexp_replace(btrim(procedure.prosrc), '[[:space:]]+', ' ', 'g') AS source"
    );
    expect(lifecycleQuery).not.toMatch(
      /(?<!btrim\()regexp_replace\(procedure\.prosrc, '\[\[:space:\]\]\+', ' ', 'g'\) AS source/
    );
  });

  it("builds the connected closed vocabulary with the exact PostgreSQL CHECK shape", async () => {
    const connectedContract = await readFile(
      new URL("./b2-catalog-contract.postgres.spec.ts", import.meta.url),
      "utf8"
    );
    const closedVocabularyContract = connectedContract.slice(
      connectedContract.indexOf("const closedVocabulary = await ownerPool.query"),
      connectedContract.indexOf("const policies = await ownerPool.query", 1100)
    );

    expect(closedVocabularyContract).toMatch(/\.join\(", "\)\}\]\)\)\)`;/);
    expect(closedVocabularyContract).not.toMatch(/\.join\(", "\)\}\]\)\)\)\)`;/);
    expect(closedVocabularyContract).toContain(
      'definition: exactAnyCheck("action", exactPhase6AuditActions)'
    );
    expect(closedVocabularyContract).toContain(
      'definition: exactAnyCheck("event_type", exactPhase6OutboxEvents)'
    );
  });

  it("uses exact policy, constraint, index, and safe-request function rows", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    expect(contract).toContain("pg_get_expr(policy.polqual, policy.polrelid) AS using_expression");
    expect(contract).toContain("JSON.stringify(result.rows) !== JSON.stringify(expectedPolicies)");
    for (const field of [
      "constraint_record.conname AS name",
      "constraint_record.contype::text AS type",
      "constraint_record.condeferrable AS deferrable",
      "constraint_record.condeferred AS initially_deferred",
      "constraint_record.convalidated AS validated",
      "index_record.indisunique AS unique",
      "index_record.indisprimary AS primary",
      "index_record.indisvalid AS valid",
      "index_record.indisready AS ready",
      "index_record.indislive AS live",
      "pg_get_indexdef(index_record.indexrelid, 0, false) AS definition"
    ]) {
      expect(contract).toContain(field);
    }
    expect(contract).toContain("safeRequestIdentity");
    expect(contract).toContain(
      'migrationFunctionSource(recoverySource!, "ops.b2_slice1_safe_request_valid")'
    );
  });

  it("pins complete canonical truth trigger definitions including timing, events, and arguments", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const triggerContract = contract.slice(
      contract.indexOf("async function validateTruthConstraintsAndTriggers"),
      contract.indexOf("const currentSlotIndexes")
    );

    expect(triggerContract).toContain("pg_get_triggerdef(trigger_record.oid, true) AS definition");
    expect(triggerContract).toContain('timing_and_events: "AFTER INSERT OR UPDATE"');
    expect(triggerContract).toContain('timing_and_events: "BEFORE DELETE OR UPDATE"');
    expect(triggerContract).toContain('arguments: ["fact.accept.v1"]');
    expect(triggerContract).toContain('arguments: ["claim.create-or-rework.v1"]');
    expect(triggerContract).toContain('CREATE ${contract.deferred ? "CONSTRAINT " : ""}TRIGGER');
    expect(triggerContract).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(triggerContract).toContain("FOR EACH ROW EXECUTE FUNCTION");
  });

  it("keeps migration-adopted request provenance distinct from native confirmation", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const migration = await readFile(
      new URL("../migrations/0011_b2_primary_objective_proposal_recovery.sql", import.meta.url),
      "utf8"
    );

    expect(migration).toContain("safe_request_adopted boolean NOT NULL DEFAULT false");
    expect(migration).toContain("'supportConfirmed', false");
    expect(migration).toContain("jsonb_set(safe_request, '{supportConfirmed}', 'true'::jsonb");
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE) \(safe_request_adopted\)/);
    expect(contract).toContain("app_can_insert_safe_request_adopted");
    expect(contract).toContain("app_can_update_safe_request_adopted");
    expect(contract).toContain('safe_request_adopted_default !== "false"');
  });

  it("pins the staged B2 capability boundary and rejects full lifecycle objects", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    expect(contract).toContain("phase >= 2");
    expect(contract).toContain("throughline_b1_0_integrity");
    expect(contract).toContain("B2 Slice 1 truth column inventory drifted");
    expect(contract).toContain("B2 Slice 1 truth function inventory drifted");
    expect(contract).toContain("source_truth_triggers");
    expect(contract).toContain("truth.reconcile_source_retention()");
    expect(contract).toContain("reconciliation_function !== null");
    expect(contract).toContain("B2 Slice 1 truth table authority drifted");
    expect(contract).toContain("ops.enforce_b2_source_truth_lifecycle_interlock()");
    expect(contract).toContain("ERRCODE = 'TLB21'");
    expect(contract).toContain("B2 source/truth lifecycle interlock trigger inventory drifted");
  });

  it("inspects the exact installed current-Fact unique-slot index instead of its name alone", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    for (const catalogField of [
      "index_state.indisunique",
      "index_state.indisready",
      "index_state.indisvalid",
      "index_state.indnkeyatts",
      "index_state.indnatts",
      "index_state.indpred",
      "index_relation.relam"
    ]) {
      expect(contract).toContain(catalogField);
    }
    expect(contract).toContain('access_method: "btree"');
    expect(contract).toContain("predicate: \"(status = 'current'::text)\"");
    expect(contract).toContain("JSON.stringify(currentSlotIndex)");
    expect(contract).not.toContain("normalizePartialIndexPredicate");
    expect(contract).toContain(
      'throw new Error("B2 Slice 1 current-Fact unique-slot index definition drifted")'
    );
    expect(contract).not.toContain(
      "to_regclass('truth.accepted_facts_one_current_slot')::text AS current_slot"
    );
  });

  it("casts PostgreSQL name columns to text before aggregating exact inventories", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const connectedContract = await readFile(
      new URL("./b2-catalog-contract.postgres.spec.ts", import.meta.url),
      "utf8"
    );

    expect(contract).toContain(
      "array_agg(attribute.attname::text ORDER BY attribute.attnum) AS columns"
    );
    expect(contract).not.toMatch(
      /array_agg\(attribute\.attname ORDER BY attribute\.attnum\) AS columns/
    );
    expect(connectedContract).toContain("array_agg(trigger.tgname::text ORDER BY trigger.tgname)");
    expect(connectedContract).not.toMatch(/array_agg\(trigger\.tgname ORDER BY trigger\.tgname\)/);
  });

  it("inspects PUBLIC through expanded PostgreSQL ACLs instead of role-name helpers", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    expect(contract).not.toContain("information_schema.role_table_grants");
    expect(contract).not.toContain("information_schema.usage_privileges");
    expect(contract).not.toMatch(/has_function_privilege\(\s*'PUBLIC'/);
    expect(contract).toContain("relation.relacl, acldefault('r', relation.relowner)");
    expect(contract).toContain("attribute.attacl, acldefault('c', relation.relowner)");
    expect(contract).toContain("namespace.nspacl, acldefault('n', namespace.nspowner)");
    expect(contract).toContain("procedure.proacl, acldefault('f', procedure.proowner)");
    expect(contract).toContain("acl_record.grantee = 0");
  });

  it("adds exactly the four phase-6 accepted Fact lifecycle UPDATE columns", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");
    const truthSecurityContract = contract.slice(
      contract.indexOf("async function validateTruthSecurity"),
      contract.indexOf("async function validateTruthFunctions")
    );
    const phase6AclContract =
      truthSecurityContract.match(
        /if \(phase >= 6\) \{[\s\S]*?table_name: "accepted_facts"[\s\S]*?\n[ ]{2}}/
      )?.[0] ?? "";

    expect
      .soft(phase6AclContract)
      .toMatch(
        /for \(const column_name of \[\s*"last_causation_command_id",\s*"status",\s*"updated_at",\s*"version"\s*\]\)/
      );
    expect.soft(phase6AclContract).toContain('table_name: "accepted_facts"');
    expect.soft(phase6AclContract).toContain('scope: "column"');
    expect.soft(phase6AclContract).toContain('grantee: "throughline_app"');
    expect.soft(phase6AclContract).toContain('privilege: "UPDATE"');
    expect.soft(phase6AclContract).toContain("grantable: false");
    expect(truthSecurityContract).toMatch(
      /for \(const column_name of \["status", "updated_at", "version"\]\) \{\s*expectedTablePrivileges\.push\(\{\s*table_name: "claims"/
    );
    expect(truthSecurityContract.match(/table_name: "accepted_facts"/g)).toHaveLength(1);
  });

  it("closes the B2 command function catalog and direct EXECUTE ACLs exactly", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    for (const identity of [
      "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)",
      "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)",
      "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)",
      "ops.require_b2_slice1_command_atomicity()"
    ]) {
      expect(contract).toContain(identity);
    }
    expect(contract).toContain("procedure.proowner = current_user::regrole");
    expect(contract).toContain("procedure.prosrc AS source");
    expect(contract).toContain("phase >= 3 ? lifecycleSource! : integritySource");
    expect(contract).toContain('"ops.require_b2_slice1_command_atomicity"');
    expect(contract).toContain("procedure.proacl, acldefault('f', procedure.proowner)");
    expect(contract).toContain("acl_record.grantee <> procedure.proowner");
    expect(contract).toContain('grantee: "throughline_product_relay"');
    expect(contract).toContain("B2 Slice 1 command function EXECUTE grants drifted");
  });

  it("closes the truth function inventory, source, security mode, search path, and ACLs", async () => {
    const contract = await readFile(new URL("./b2-catalog-contract.ts", import.meta.url), "utf8");

    for (const identity of [
      "truth.enforce_claim_transition()",
      "truth.reject_mutation()",
      "truth.require_fact_accept_reservation()",
      "truth.require_reserved_command()",
      "truth.validate_claim_insert()",
      "truth.validate_fact_insert()",
      "truth.validate_fact_support()",
      "truth.verify_evidence_snapshot()",
      "access.can_read_space(uuid,text)"
    ]) {
      expect(contract).toContain(identity);
    }
    expect(contract).toContain("procedure.prosrc AS source");
    expect(contract).toContain("security_definer: false");
    expect(contract).toContain('configuration: ["search_path=pg_catalog"]');
    expect(contract).toContain("B2 Slice 1 truth function EXECUTE grants drifted");
    expect(contract).toContain("content.access_class_rank");
  });

  it("requires exact delegation to the immutable B1 catalog", async () => {
    const sql = await readFile(
      new URL("../migrations/0008_b2_slice1_command_integrity.sql", import.meta.url),
      "utf8"
    );
    expect(() => assertProductValidatorDelegatesExactB1Kinds(sql)).not.toThrow();
    expect(() =>
      assertProductValidatorDelegatesExactB1Kinds(
        sql.replace("'source.tombstone.v1'", "'future.command.v1'")
      )
    ).toThrow("exact sealed B1 command catalog");
  });
});
