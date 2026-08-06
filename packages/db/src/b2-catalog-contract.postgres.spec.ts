import pg from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { devFixtures } from "@throughline/tenancy";
import { applyMigrations } from "./migrations.js";
import { provisionProductRelayDirectManagerAccess } from "./product-relay-provisioning.js";
import { seedWaveA2DeterministicData } from "./seed.js";
import { provisionTestAppRole } from "./test-database.js";
import type { TenantDbTransaction } from "./transaction.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const authoritative = process.env.B2_AUTHORITATIVE_GATE === "1";
const maybeDescribe =
  ownerUrl && appUrl ? describe.sequential : authoritative ? describe : describe.skip;
const allMigrationIds = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql",
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql",
  "0007_b2_slice1_truth_storage.sql",
  "0008_b2_slice1_command_integrity.sql",
  "0009_b2_source_truth_lifecycle_interlock.sql",
  "0010_b2_trusted_objective_initiative_lock.sql"
] as const;
const postSlice3MigrationIds = [
  ...allMigrationIds,
  "0011_b2_primary_objective_proposal_recovery.sql"
] as const;
const postSlice4AMigrationIds = [...postSlice3MigrationIds, "0012_b2_fact_lifecycle.sql"] as const;
const truthTables = ["accepted_facts", "claims", "fact_claims", "verified_evidence_spans"] as const;
const PHASE5_TEST_TIMEOUT = 180_000;
const PHASE6_SUPERSEDE_ROLLBACK_TEST_TIMEOUT = 300_000;
const normalizeSql = (source: string) => source.trim().replace(/\s+/g, " ");
const exact0012FunctionBodyDigests = {
  "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)":
    "144d82c83595006551ae90b66cb279e0605054470a3b82f89d7d13e53f12475a",
  "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)":
    "6d0c4b56de9120cb11375c7cceb92a7871adf2c3cd122e3eaa3c964dd1ea81f0",
  "ops.b2_slice1_safe_request_valid(text,jsonb)":
    "411d840a4103fad18a06842df04cf9edca89aeeba166b6b5726fbd183d586eef",
  "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)":
    "e5c46c5b0d47712951dce2d60e55f28bca1e7cca795658c196836b7e8fe7affa",
  "ops.require_b2_slice1_command_atomicity()":
    "2ed3c76136938f08846defd78c14ed84d5c50ac915a9fb946b25fbed17819f48",
  "truth.enforce_claim_transition()":
    "0bef1037a525126dad73b202c4dd59cd8be26fed48d6fb36657afd59b140bf48",
  "truth.enforce_fact_lifecycle_transition()":
    "967ec9269eb34f79e35ba6113f22ec29ba1c5d74819546b4716d982b59336a10",
  "truth.reject_statement_mutation()":
    "e8a66bfefb5d061c9981613e9e581872595c6f3fff384c20cd5513d7503902ae",
  "truth.require_fact_accept_reservation()":
    "6e3a8170aeb14d4cf474c3ed0acf9b122efa7d732e1530bad205a8c4d17190bb",
  "truth.require_fact_lifecycle_command()":
    "9ab571a5144343140ed4511d70c9e2127ec3b68b9c97fdd249c4cfe04e5b0e07",
  "truth.require_fact_lifecycle_event()":
    "16e0ece019be747f0ac189bdb092b622ae37d6183990dd2b54e9d02a126135c9",
  "truth.require_reserved_command()":
    "91b97c7b7e5efef91129f48ab842e3d5047d1e72f4e353d5514829d90c9f00b7",
  "truth.validate_fact_insert()":
    "c27176c6b7a8050c1d98f9c38333864614ee0f85c3dd0ded411a522745c81756",
  "truth.validate_fact_lifecycle_event()":
    "40a11b34d6a9cdb43a496523b81c3bade3b340600a6b21b4e97453e1dc55b550"
} as const;
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
const exactPhase6LifecycleFunctionCatalog = Object.entries(exactPhase6LifecycleFunctionSources)
  .map(([identity, source]) => ({
    identity,
    result: "trigger",
    language: "plpgsql",
    owner: "migration_owner",
    security_definer: false,
    strict: false,
    volatility: "v",
    leakproof: false,
    parallel: "u",
    kind: "f",
    configuration: ["search_path=pg_catalog"],
    source,
    acl: []
  }))
  .sort((left, right) => left.identity.localeCompare(right.identity));
const exactPhase6TruthFunctionIdentities = [
  "truth.enforce_claim_transition()",
  "truth.enforce_fact_lifecycle_transition()",
  "truth.reject_mutation()",
  "truth.reject_statement_mutation()",
  "truth.require_fact_accept_reservation()",
  "truth.require_fact_lifecycle_command()",
  "truth.require_fact_lifecycle_event()",
  "truth.require_objective_recovery_command()",
  "truth.require_objective_recovery_for_terminal_claim()",
  "truth.require_objective_support_attestation()",
  "truth.require_reserved_command()",
  "truth.validate_claim_insert()",
  "truth.validate_fact_insert()",
  "truth.validate_fact_lifecycle_event()",
  "truth.validate_fact_support()",
  "truth.validate_objective_recovery()",
  "truth.validate_objective_support_attestation()",
  "truth.verify_evidence_snapshot()"
] as const;
const exactFactLifecycleColumns = [
  ["id", "uuid", true, null],
  ["tenant_id", "uuid", true, null],
  ["workspace_id", "uuid", true, null],
  ["space_id", "uuid", true, null],
  ["predecessor_fact_id", "uuid", true, null],
  ["successor_fact_id", "uuid", false, null],
  ["transition_kind", "text", true, null],
  ["from_status", "text", true, null],
  ["to_status", "text", true, null],
  ["reason_code", "text", true, null],
  ["reason_rationale", "text", true, null],
  ["authority_basis", "text", true, null],
  ["policy_version", "text", true, null],
  ["acted_by_user_id", "uuid", true, null],
  ["acted_by_membership_id", "uuid", true, null],
  ["causation_command_id", "uuid", true, null],
  ["recorded_at", "timestamp with time zone", true, "transaction_timestamp()"],
  ["version", "integer", true, "1"]
].map(([column_name, data_type, not_null, default_expression]) => ({
  column_name,
  data_type,
  not_null,
  default_expression
}));
const exactFactScope =
  "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class))";
const exactLifecycleScope =
  "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (EXISTS ( SELECT 1\n   FROM truth.accepted_facts predecessor\n  WHERE ((predecessor.tenant_id = fact_lifecycle_events.tenant_id) AND (predecessor.workspace_id = fact_lifecycle_events.workspace_id) AND (predecessor.space_id = fact_lifecycle_events.space_id) AND (predecessor.id = fact_lifecycle_events.predecessor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)))) AND ((successor_fact_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM truth.accepted_facts successor\n  WHERE ((successor.tenant_id = fact_lifecycle_events.tenant_id) AND (successor.workspace_id = fact_lifecycle_events.workspace_id) AND (successor.space_id = fact_lifecycle_events.space_id) AND (successor.id = fact_lifecycle_events.successor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class))))))";
const exactLifecycleInsertScope =
  "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (acted_by_user_id = ops.current_user_id()) AND (acted_by_membership_id = ops.current_membership_id()) AND (policy_version = ops.current_policy_version()) AND (EXISTS ( SELECT 1\n   FROM truth.accepted_facts predecessor\n  WHERE ((predecessor.tenant_id = fact_lifecycle_events.tenant_id) AND (predecessor.workspace_id = fact_lifecycle_events.workspace_id) AND (predecessor.space_id = fact_lifecycle_events.space_id) AND (predecessor.id = fact_lifecycle_events.predecessor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)))) AND ((successor_fact_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM truth.accepted_facts successor\n  WHERE ((successor.tenant_id = fact_lifecycle_events.tenant_id) AND (successor.workspace_id = fact_lifecycle_events.workspace_id) AND (successor.space_id = fact_lifecycle_events.space_id) AND (successor.id = fact_lifecycle_events.successor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class))))))";
const exactPhase6Policies = [
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
const exactPhase6TriggerRows = [
  {
    name: "accepted_facts_command_guard",
    table_name: "accepted_facts",
    function_identity: "truth.require_reserved_command()",
    enabled: true,
    deferrable: false,
    initially_deferred: false,
    definition:
      "CREATE TRIGGER accepted_facts_command_guard BEFORE INSERT ON truth.accepted_facts FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('fact.accept-or-supersede.v1')"
  },
  {
    name: "accepted_facts_delete_guard",
    table_name: "accepted_facts",
    function_identity: "truth.reject_mutation()",
    enabled: true,
    deferrable: false,
    initially_deferred: false,
    definition:
      "CREATE TRIGGER accepted_facts_delete_guard BEFORE DELETE ON truth.accepted_facts FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation()"
  },
  {
    name: "accepted_facts_lifecycle_deferred",
    table_name: "accepted_facts",
    function_identity: "truth.require_fact_lifecycle_event()",
    enabled: true,
    deferrable: true,
    initially_deferred: true,
    definition:
      "CREATE CONSTRAINT TRIGGER accepted_facts_lifecycle_deferred AFTER UPDATE ON truth.accepted_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION truth.require_fact_lifecycle_event()"
  },
  {
    name: "accepted_facts_lifecycle_guard",
    table_name: "accepted_facts",
    function_identity: "truth.enforce_fact_lifecycle_transition()",
    enabled: true,
    deferrable: false,
    initially_deferred: false,
    definition:
      "CREATE TRIGGER accepted_facts_lifecycle_guard BEFORE UPDATE ON truth.accepted_facts FOR EACH ROW EXECUTE FUNCTION truth.enforce_fact_lifecycle_transition()"
  },
  {
    name: "fact_lifecycle_command_guard",
    table_name: "fact_lifecycle_events",
    function_identity: "truth.require_fact_lifecycle_command()",
    enabled: true,
    deferrable: false,
    initially_deferred: false,
    definition:
      "CREATE TRIGGER fact_lifecycle_command_guard BEFORE INSERT ON truth.fact_lifecycle_events FOR EACH ROW EXECUTE FUNCTION truth.require_fact_lifecycle_command('fact.supersede-or-revoke.v1')"
  },
  {
    name: "fact_lifecycle_immutable",
    table_name: "fact_lifecycle_events",
    function_identity: "truth.reject_mutation()",
    enabled: true,
    deferrable: false,
    initially_deferred: false,
    definition:
      "CREATE TRIGGER fact_lifecycle_immutable BEFORE DELETE OR UPDATE ON truth.fact_lifecycle_events FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation()"
  },
  {
    name: "fact_lifecycle_insert_guard",
    table_name: "fact_lifecycle_events",
    function_identity: "truth.validate_fact_lifecycle_event()",
    enabled: true,
    deferrable: false,
    initially_deferred: false,
    definition:
      "CREATE TRIGGER fact_lifecycle_insert_guard BEFORE INSERT ON truth.fact_lifecycle_events FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_lifecycle_event()"
  },
  {
    name: "fact_lifecycle_truncate_guard",
    table_name: "fact_lifecycle_events",
    function_identity: "truth.reject_statement_mutation()",
    enabled: true,
    deferrable: false,
    initially_deferred: false,
    definition:
      "CREATE TRIGGER fact_lifecycle_truncate_guard BEFORE TRUNCATE ON truth.fact_lifecycle_events FOR EACH STATEMENT EXECUTE FUNCTION truth.reject_statement_mutation()"
  },
  {
    name: "fact_lifecycle_valid_deferred",
    table_name: "fact_lifecycle_events",
    function_identity: "truth.validate_fact_lifecycle_event()",
    enabled: true,
    deferrable: true,
    initially_deferred: true,
    definition:
      "CREATE CONSTRAINT TRIGGER fact_lifecycle_valid_deferred AFTER INSERT ON truth.fact_lifecycle_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_lifecycle_event()"
  }
] as const;
const exactPhase6ForeignKeys = [
  {
    name: "fact_lifecycle_events_actor_membership_fkey",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, acted_by_membership_id, acted_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    match_type: "f",
    update_action: "r",
    delete_action: "r"
  },
  {
    name: "fact_lifecycle_events_actor_user_fkey",
    definition:
      "FOREIGN KEY (acted_by_user_id) REFERENCES identity.users(id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    match_type: "f",
    update_action: "r",
    delete_action: "r"
  },
  {
    name: "fact_lifecycle_events_command_fkey",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    match_type: "f",
    update_action: "r",
    delete_action: "r"
  },
  {
    name: "fact_lifecycle_events_policy_fkey",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, policy_version) REFERENCES identity.policy_versions(tenant_id, workspace_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    match_type: "f",
    update_action: "r",
    delete_action: "r"
  },
  {
    name: "fact_lifecycle_events_predecessor_fkey",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_fact_id) REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    match_type: "f",
    update_action: "r",
    delete_action: "r"
  },
  {
    name: "fact_lifecycle_events_successor_fkey",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, successor_fact_id) REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    match_type: "s",
    update_action: "r",
    delete_action: "r"
  }
].map((row) => ({
  ...row,
  deferrable: true,
  initially_deferred: true,
  validated: true
}));
const exactPhase6Checks = [
  {
    table_name: "accepted_facts",
    name: "accepted_facts_status_check",
    definition:
      "CHECK ((status = ANY (ARRAY['current'::text, 'superseded'::text, 'revoked'::text])))"
  },
  {
    table_name: "accepted_facts",
    name: "accepted_facts_version_check",
    definition:
      "CHECK ((((status = 'current'::text) AND (version = 1)) OR ((status = ANY (ARRAY['superseded'::text, 'revoked'::text])) AND (version = 2))))"
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_authority_check",
    definition:
      "CHECK ((authority_basis = ANY (ARRAY['activity_owner'::text, 'initiative_owner'::text])))"
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_id_check",
    definition: "CHECK (ops.is_uuid_v7(id))"
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_rationale_check",
    definition:
      "CHECK (((reason_rationale = NORMALIZE(reason_rationale, NFC)) AND (reason_rationale = btrim(reason_rationale)) AND ((length(reason_rationale) >= 1) AND (length(reason_rationale) <= 2000))))"
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_reason_check",
    definition:
      "CHECK ((((transition_kind = 'supersede'::text) AND (reason_code = ANY (ARRAY['newer_evidence'::text, 'accepted_value_changed'::text, 'corrected_source_revalidated'::text]))) OR ((transition_kind = 'revoke'::text) AND (reason_code = ANY (ARRAY['no_longer_true'::text, 'support_invalidated'::text, 'entered_in_error'::text])))))"
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_timestamp_check",
    definition: "CHECK ((recorded_at = transaction_timestamp()))"
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_transition_shape_check",
    definition:
      "CHECK ((((transition_kind = 'supersede'::text) AND (from_status = 'current'::text) AND (to_status = 'superseded'::text) AND (successor_fact_id IS NOT NULL) AND (successor_fact_id <> predecessor_fact_id)) OR ((transition_kind = 'revoke'::text) AND (from_status = 'current'::text) AND (to_status = 'revoked'::text) AND (successor_fact_id IS NULL))))"
  },
  {
    table_name: "fact_lifecycle_events",
    name: "fact_lifecycle_events_version_check",
    definition: "CHECK ((version = 1))"
  }
].map((row) => ({
  ...row,
  deferrable: false,
  initially_deferred: false,
  validated: true
}));
const exactPhase6Privileges = [
  ...["INSERT", "SELECT"].map((privilege) => ({
    table_name: "accepted_facts",
    scope: "table",
    column_name: null,
    grantee: "throughline_app",
    privilege,
    grantable: false
  })),
  {
    table_name: "accepted_facts",
    scope: "table",
    column_name: null,
    grantee: "throughline_b1_0_integrity",
    privilege: "SELECT",
    grantable: false
  },
  ...["last_causation_command_id", "status", "updated_at", "version"].map((column_name) => ({
    table_name: "accepted_facts",
    scope: "column",
    column_name,
    grantee: "throughline_app",
    privilege: "UPDATE",
    grantable: false
  })),
  ...["INSERT", "SELECT"].map((privilege) => ({
    table_name: "fact_lifecycle_events",
    scope: "table",
    column_name: null,
    grantee: "throughline_app",
    privilege,
    grantable: false
  })),
  {
    table_name: "fact_lifecycle_events",
    scope: "table",
    column_name: null,
    grantee: "throughline_b1_0_integrity",
    privilege: "SELECT",
    grantable: false
  }
].sort((left, right) =>
  `${left.table_name}|${left.scope}|${left.column_name ?? ""}|${left.grantee}|${left.privilege}`.localeCompare(
    `${right.table_name}|${right.scope}|${right.column_name ?? ""}|${right.grantee}|${right.privilege}`
  )
);
const exactPhase6AuditActions = [
  "organization.create",
  "initiative.create",
  "activity.create",
  "activity.capture_add",
  "relationship.create",
  "relationship.end",
  "content.create",
  "content.revise",
  "source_artifact.capture",
  "source_artifact.correct",
  "source_artifact.tombstone",
  "claim.create",
  "initiative.primary_objective.withdraw",
  "initiative.primary_objective.reject",
  "initiative.primary_objective.rework",
  "fact.accept",
  "fact.supersede",
  "fact.revoke"
] as const;
const exactPhase6OutboxEvents = [
  "organization.created",
  "initiative.created",
  "activity.created",
  "activity.capture_added",
  "relationship.created",
  "relationship.ended",
  "content.created",
  "content.revised",
  "source_artifact.captured",
  "source_artifact.corrected",
  "source_artifact.tombstoned",
  "claim.proposed",
  "initiative.primary_objective.proposal_withdrawn",
  "initiative.primary_objective.proposal_rejected",
  "initiative.primary_objective.proposal_reworked",
  "fact.accepted",
  "fact.superseded",
  "fact.revoked"
] as const;
const exactPhase6CommandTrigger = {
  name: "domain_command_records_b2_slice1_atomicity_deferred",
  function_identity: "ops.require_b2_slice1_command_atomicity()",
  deferrable: true,
  initially_deferred: true,
  definition:
    "CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred AFTER INSERT OR UPDATE ON ops.domain_command_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_kind = ANY (ARRAY['claim.create.v1'::text, 'initiative.primary_objective.withdraw.v1'::text, 'initiative.primary_objective.rework.v1'::text, 'fact.accept.v1'::text, 'fact.supersede.v1'::text, 'fact.revoke.v1'::text]))) EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity()"
} as const;

const readThisSpec = () =>
  readFile(new URL("./b2-catalog-contract.postgres.spec.ts", import.meta.url), "utf8");

describe("phase-6 connected fixture source contract", () => {
  it("uses the canonical command state default in both app lifecycle helpers", async () => {
    const source = await readThisSpec();
    const revoke = source.slice(
      source.lastIndexOf("async function executeExactRevokeTransaction"),
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );
    const supersede = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );
    const commandInsert = (helper: string) => {
      const match = helper.match(
        /INSERT INTO ops\.domain_command_records \(\s*([\s\S]*?)\s*\) VALUES \(\s*([\s\S]*?)\s*\)`/
      );

      expect(match).not.toBeNull();
      return {
        columns: match![1]!.split(",").map((column) => column.trim()),
        values: normalizeSql(match![2]!)
      };
    };

    for (const insert of [commandInsert(revoke), commandInsert(supersede)]) {
      expect(insert.columns).toEqual([
        "id",
        "tenant_id",
        "workspace_id",
        "reservation_space_id",
        "command_kind",
        "command_schema_version",
        "idempotency_key",
        "canonical_request_hash",
        "safe_request",
        "actor_user_id",
        "actor_membership_id",
        "policy_version_id",
        "request_id",
        "traceparent"
      ]);
      expect(insert.columns).not.toContain("state");
      expect(insert.values).not.toContain("'reserved'");
      expect(insert.values).toMatch(/\$5::jsonb, \$6,\$7,'default-v1'/);
    }
  });

  it("keeps the supersession request on the predecessor while only the mismatched successor diverges", async () => {
    const source = await readThisSpec();
    const supersede = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );
    const commandInsert = supersede.slice(
      supersede.indexOf("INSERT INTO ops.domain_command_records"),
      supersede.indexOf("UPDATE truth.accepted_facts")
    );
    const successorInsert = supersede.slice(
      supersede.indexOf("INSERT INTO truth.accepted_facts"),
      supersede.indexOf("INSERT INTO truth.fact_claims")
    );
    const successorSubjectSelector =
      'fault === "mismatched_lineage" ? phase6Ids.otherSubject : adoptionIds.subject';

    expect(commandInsert).toMatch(
      /id:\s*adoptionIds\.subject,\s*expectedVersion:\s*fault === "stale_subject_version"/
    );
    expect(commandInsert).toContain('expectedVersion: fault === "stale_subject_version" ? 2 : 1');
    expect(commandInsert).not.toContain(successorSubjectSelector);
    expect(successorInsert).toContain(successorSubjectSelector);
    expect(supersede.split(successorSubjectSelector)).toHaveLength(2);
  });

  it("pins terminal-predecessor support and mismatched-response successor rollback faults", async () => {
    const source = await readThisSpec();
    const helper = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction"),
      source.lastIndexOf("async function insertExact0008TruthFixture")
    );
    const suite = source.slice(
      source.lastIndexOf('maybeDescribe("Wave B2 PostgreSQL catalog contract"'),
      source.lastIndexOf("const adoptionIds")
    );
    const diagnosticTitle =
      "asserts exact supersede stale/support/row-guard diagnostics and full rollback: %s";
    const diagnosticTitleIndex = suite.indexOf(`"${diagnosticTitle}"`);
    const matrixStart = suite.lastIndexOf("it.each([", diagnosticTitleIndex);
    const matrixEnd = suite.indexOf(
      '"classifies supersede storage uniqueness failure exactly: %s"',
      diagnosticTitleIndex
    );
    const matrix = suite.slice(matrixStart, matrixEnd);
    const supportTarget =
      'fault === "predecessor_support_appended" ? adoptionIds.fact : adoptionIds.successor';
    const responseSelector =
      'fault === "mismatched_response_successor"\n              ? phase6Ids.mismatchedResponseSuccessor\n              : adoptionIds.successor';

    expect(helper).toContain(supportTarget);
    expect(helper.indexOf(supportTarget)).toBeLessThan(helper.indexOf("UPDATE truth.claims"));
    expect(helper).toContain(responseSelector);
    expect(helper.split("phase6Ids.mismatchedResponseSuccessor")).toHaveLength(2);
    expect(helper).toContain("replacementFactId: adoptionIds.successor");
    expect(matrix).toMatch(
      /"predecessor_support_appended",\s*"fact support requires its exact reserved command"/
    );
    expect(matrix).toMatch(
      /"mismatched_response_successor",\s*"fact supersede response does not match successor"/
    );
    expect(matrix).toContain("expectExactDatabaseFailure(");
    expect(matrix).toContain("exactPhase6RollbackDigest");
    expect(matrix).toContain("expectNoPhase6CommandResidue");
  });

  it("pins executable confidence-lowering fixtures and exact rollback diagnostics", async () => {
    const source = await readThisSpec();
    const helper = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction"),
      source.lastIndexOf("async function insertExact0008TruthFixture")
    );
    const suite = source.slice(
      source.lastIndexOf('maybeDescribe("Wave B2 PostgreSQL catalog contract"'),
      source.lastIndexOf("const adoptionIds")
    );
    const positiveTitle =
      "commits restricted-app supersession with exact requested confidence lowering provenance";
    const positiveStart = suite.indexOf(`"${positiveTitle}"`);
    const positiveEnd = suite.indexOf("\n  it(", positiveStart + positiveTitle.length);
    const positive = suite.slice(positiveStart, positiveEnd);
    const negativeTitle =
      "asserts exact supersede stale/support/row-guard diagnostics and full rollback: %s";
    const negativeTitleIndex = suite.indexOf(`"${negativeTitle}"`);
    const negativeStart = suite.lastIndexOf("it.each([", negativeTitleIndex);
    const negativeEnd = suite.indexOf(
      '"classifies supersede storage uniqueness failure exactly: %s"',
      negativeTitleIndex
    );
    const negative = suite.slice(negativeStart, negativeEnd);
    const successorInsert = helper.slice(
      helper.indexOf("INSERT INTO truth.accepted_facts"),
      helper.indexOf("INSERT INTO truth.fact_claims")
    );

    expect(helper).toContain("...(loweringRequested ? { confidenceLowering } : {})");
    expect(successorInsert).toContain("replacement.normalized_text, $6,");
    expect(successorInsert).toContain("predecessor.confidence_rule, $10,");
    expect(successorInsert).toContain("$7, $8, $9, replacement.valid_from");
    expect(positiveStart).toBeGreaterThan(-1);
    expect(positive).toContain('"valid_confidence_lowering"');
    expect(positive).toContain("successor.confidence_lowering_reason_code");
    expect(positive).toContain('confidence_lowering_reason_code: "residual_uncertainty"');
    expect(positive).toContain("safe_request: {");
    expect(negativeTitleIndex).toBeGreaterThan(-1);
    expect(negativeStart).toBeGreaterThan(-1);
    expect(negative).toMatch(
      /"lowering_requested_successor_omitted",\s*"truth mutation requires its exact reserved command"/
    );
    expect(negative).toMatch(
      /"lowering_omitted_successor_lowered",\s*"truth mutation requires its exact reserved command"/
    );
    expect(negative).toMatch(
      /"lowering_confidence_mismatched",\s*"truth mutation requires its exact reserved command"/
    );
    expect(negative).toMatch(
      /"lowering_reason_code_mismatched",\s*"truth mutation requires its exact reserved command"/
    );
    expect(negative).toMatch(
      /"lowering_rationale_mismatched",\s*"truth mutation requires its exact reserved command"/
    );
    expect(negative).toMatch(
      /"requested_confidence_not_lower",\s*"accepted fact support is invalid"/
    );
    expect(negative).toMatch(/"stored_strongest_mismatched",\s*"accepted fact support is invalid"/);
    expect(negative).toContain("expectExactDatabaseFailure(");
    expect(negative).toContain('{ code: "P0001", message, constraint: null }');
    expect(negative).toContain("exactPhase6RollbackDigest");
    expect(negative).toContain("expectNoPhase6CommandResidue");
  });

  it("classifies unexpected successor as an exact revoke row-guard failure", async () => {
    const source = await readThisSpec();
    const suite = source.slice(
      source.lastIndexOf('maybeDescribe("Wave B2 PostgreSQL catalog contract"'),
      source.lastIndexOf("const adoptionIds")
    );
    const matrixFor = (title: string) => {
      const titleIndex = suite.indexOf(`"${title}"`);
      const start = suite.lastIndexOf("it.each([", titleIndex);
      const end = suite.indexOf("PHASE5_TEST_TIMEOUT", titleIndex);

      expect(titleIndex).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(titleIndex);
      return suite.slice(start, end);
    };
    const rowGuard = matrixFor("asserts the exact revoke row-guard layer and full rollback: %s");
    const storage = matrixFor("classifies revoke storage uniqueness failure exactly: %s");
    const failureMatrices = suite.slice(
      suite.indexOf('"forces exact deferred revoke completeness and full rollback: %s"'),
      suite.indexOf('"rejects a missing phase-5 objective recovery integrity policy"')
    );
    const matrixUntil = (title: string, nextTitle: string) => {
      const titleIndex = suite.indexOf(`"${title}"`);
      const nextTitleIndex = suite.indexOf(`"${nextTitle}"`, titleIndex + title.length);

      expect(titleIndex).toBeGreaterThan(-1);
      expect(nextTitleIndex).toBeGreaterThan(titleIndex);
      return suite.slice(titleIndex, nextTitleIndex);
    };
    const supersedeCompleteness = matrixUntil(
      "forces exact deferred supersede completeness and full rollback: %s",
      "asserts exact supersede stale/support/row-guard diagnostics and full rollback: %s"
    );
    const supersedeRollback = matrixUntil(
      "asserts exact supersede stale/support/row-guard diagnostics and full rollback: %s",
      "classifies supersede storage uniqueness failure exactly: %s"
    );
    const supersedeStorage = matrixUntil(
      "classifies supersede storage uniqueness failure exactly: %s",
      "rejects a missing phase-5 objective recovery integrity policy"
    );

    expect(rowGuard).toMatch(
      /"unexpected_successor",\s*"Fact revocation cannot identify a successor"/
    );
    expect(rowGuard).toContain('{ code: "P0001", message, constraint: null }');
    expect(storage).not.toContain('"unexpected_successor"');
    expect(failureMatrices).not.toContain(".rejects");
    expect(failureMatrices).not.toContain("toThrow");
    expect(source).toContain("const PHASE6_SUPERSEDE_ROLLBACK_TEST_TIMEOUT = 300_000;");
    expect(supersedeCompleteness).toMatch(/},\s*PHASE5_TEST_TIMEOUT\s*\);/);
    expect(supersedeCompleteness).not.toContain("PHASE6_SUPERSEDE_ROLLBACK_TEST_TIMEOUT");
    expect(supersedeRollback).toMatch(/},\s*PHASE6_SUPERSEDE_ROLLBACK_TEST_TIMEOUT\s*\);/);
    expect(supersedeRollback).not.toContain("PHASE5_TEST_TIMEOUT");
    expect(supersedeStorage).toMatch(/},\s*PHASE5_TEST_TIMEOUT\s*\);/);
    expect(supersedeStorage).not.toContain("PHASE6_SUPERSEDE_ROLLBACK_TEST_TIMEOUT");
  });

  it("limits both duplicate-outbox probes to canonical app-writable columns", async () => {
    const source = await readThisSpec();
    const revoke = source.slice(
      source.lastIndexOf("async function executeExactRevokeTransaction"),
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );
    const supersede = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction"),
      source.lastIndexOf("async function insertExact0008TruthFixture")
    );
    const appWritableColumns = [
      "id",
      "tenant_id",
      "workspace_id",
      "space_id",
      "relay_service_principal_id",
      "policy_version_id",
      "event_type",
      "event_schema_version",
      "payload_schema_version",
      "aggregate_type",
      "aggregate_id",
      "aggregate_version",
      "causation_command_id",
      "payload",
      "request_id",
      "traceparent",
      "tracestate"
    ];
    const relayOwnedColumns = [
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
    ];
    const duplicateOutboxProbe = (helper: string) => {
      const probe = helper.match(
        /if \(fault === "duplicate_outbox"\) \{\s*await client\.query\(\s*`([\s\S]*?)`\s*,/
      )?.[1];

      expect(probe).toBeDefined();
      const insert = probe!.match(
        /INSERT INTO ops\.product_outbox_events \(\s*([\s\S]*?)\s*\)\s*SELECT\s+([\s\S]*?)\s+FROM ops\.product_outbox_events/
      );
      expect(insert).not.toBeNull();
      return {
        probe: probe!,
        columns: insert![1]!.split(",").map((column) => column.trim()),
        selection: insert![2]!.split(",").map((column) => column.trim())
      };
    };

    for (const { probe, columns, selection } of [
      duplicateOutboxProbe(revoke),
      duplicateOutboxProbe(supersede)
    ]) {
      expect(columns).toEqual(appWritableColumns);
      expect(selection).toEqual(["$1", ...appWritableColumns.slice(1)]);
      for (const relayOwnedColumn of relayOwnedColumns) {
        expect(probe).not.toMatch(new RegExp(`\\b${relayOwnedColumn}\\b`));
      }
    }
  });

  it("keeps phase-6 replacement Claims out of exact-0008/0011 history", async () => {
    const source = await readThisSpec();
    const exact0008Fixture = source.slice(
      source.lastIndexOf("async function insertExact0008TruthFixture"),
      source.lastIndexOf("function sqlLiteral")
    );
    const exact0011Reset = source.slice(
      source.lastIndexOf("async function resetPopulatedExact0011"),
      source.lastIndexOf("async function withOwnerTransaction")
    );

    expect(exact0008Fixture).not.toContain("phase6Ids.replacementClaim");
    expect(exact0008Fixture).not.toContain("phase6Ids.secondReplacementClaim");
    expect(exact0008Fixture).not.toContain("phase6Ids.orphanReplacementClaim");
    expect(exact0008Fixture).not.toContain("phase6Ids.confidentialReplacementClaim");
    expect(exact0008Fixture).not.toContain("Replacement canonical value");
    expect(exact0011Reset).toContain('through: "0008_b2_slice1_command_integrity.sql"');
    expect(exact0011Reset).toContain("await insertExact0008TruthFixture(pool)");
    expect(exact0011Reset).toContain('through: "0011_b2_primary_objective_proposal_recovery.sql"');
    expect(exact0011Reset).not.toContain("0012_b2_fact_lifecycle.sql");
    expect(exact0011Reset).not.toContain("insertOwnerPhase6ReplacementClaims");

    const ownerFixture = source.slice(
      source.lastIndexOf("async function insertOwnerPhase6ReplacementClaims"),
      source.lastIndexOf("async function resetPopulatedPhase6")
    );
    const phase6Reset = source.slice(
      source.lastIndexOf("async function resetPopulatedPhase6"),
      source.lastIndexOf("async function exactLifecycleProtectedDigest")
    );
    const migration = phase6Reset.indexOf("await applyMigrations(pool)");
    const replacementClaims = phase6Reset.indexOf("await insertOwnerPhase6ReplacementClaims(pool)");
    const provisioning = phase6Reset.indexOf("provisionProductRelayDirectManagerAccess");

    expect(ownerFixture).toContain("phase6Ids.replacementClaim");
    expect(ownerFixture).toContain("phase6Ids.secondReplacementClaim");
    expect(ownerFixture).toContain("phase6Ids.orphanReplacementClaim");
    expect(ownerFixture).toContain("phase6Ids.confidentialReplacementClaim");
    expect(ownerFixture).toContain("ALTER TABLE truth.claims DISABLE TRIGGER USER");
    expect(ownerFixture).toContain("ALTER TABLE truth.claims ENABLE TRIGGER USER");
    expect(ownerFixture.match(/ALTER TABLE/g)).toHaveLength(2);
    expect(ownerFixture).not.toContain("INSERT INTO ops.domain_command_records");
    expect(migration).toBeGreaterThan(-1);
    expect(replacementClaims).toBeGreaterThan(migration);
    expect(provisioning).toBeGreaterThan(replacementClaims);
  });

  it("provisions and threads the canonical product relay through lifecycle transactions", async () => {
    const source = await readThisSpec();
    const imports = source.slice(0, source.indexOf("const ownerUrl"));
    const suite = source.slice(
      source.lastIndexOf('maybeDescribe("Wave B2 PostgreSQL catalog contract"'),
      source.lastIndexOf("const adoptionIds")
    );
    const reset = source.slice(
      source.lastIndexOf("async function resetPopulatedPhase6"),
      source.lastIndexOf("async function exactLifecycleProtectedDigest")
    );
    const revoke = source.slice(
      source.lastIndexOf("async function executeExactRevokeTransaction"),
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );
    const supersede = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );

    expect(imports).toContain(
      'import { provisionProductRelayDirectManagerAccess } from "./product-relay-provisioning.js";'
    );
    expect(reset).toContain("async function resetPopulatedPhase6(pool: pg.Pool): Promise<string>");
    expect(reset).toContain("provisionProductRelayDirectManagerAccess(tx, {");
    expect(reset).toContain("tenantId: adoptionIds.tenant");
    expect(reset).toContain("workspaceId: adoptionIds.workspace");
    expect(reset).toContain("spaceId: adoptionIds.space");
    expect(reset).toContain("return provisioned.principalId");
    expect(revoke).toContain("relayServicePrincipalId: string");
    expect(revoke).not.toContain("devFixtures.relayServicePrincipalA");
    expect(supersede).toContain("relayServicePrincipalId: string");
    expect(supersede).not.toContain("devFixtures.relayServicePrincipalA");
    expect(suite).not.toMatch(
      /executeExact(?:Revoke|Supersede)Transaction\(\s*ownerPool,\s*"valid"/
    );
    expect(suite).toMatch(
      /withTestAppPool\(\(appPool\) =>\s*executeExactRevokeTransaction\(\s*appPool,\s*"valid",\s*relayServicePrincipalId\s*\)\s*\)/
    );
    expect(suite).toMatch(
      /withTestAppPool\(\(appPool\) =>\s*executeExactSupersedeTransaction\(\s*appPool,\s*"valid",\s*relayServicePrincipalId\s*\)\s*\)/
    );
    expect(revoke).toContain("appPool: pg.Pool");
    expect(supersede).toContain("appPool: pg.Pool");
    expect(revoke).toContain("current_user = 'throughline_app'");
    expect(supersede).toContain("current_user = 'throughline_app'");
    expect(revoke).toContain("NOT rolbypassrls");
    expect(supersede).toContain("NOT rolbypassrls");
    expect(
      suite.match(/'relayServicePrincipalId', event\.relay_service_principal_id/g)
    ).toHaveLength(3);
  });

  it("flushes supersede support validation before schema-qualified command atomicity", async () => {
    const source = await readThisSpec();
    const revoke = source.slice(
      source.lastIndexOf("async function executeExactRevokeTransaction"),
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );
    const supersede = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction"),
      source.lastIndexOf("async function executeExactSecondSupersedeTransaction")
    );
    const atomicityFlush =
      "SET CONSTRAINTS ops.domain_command_records_b2_slice1_atomicity_deferred IMMEDIATE";
    const supportFlush = "SET CONSTRAINTS truth.accepted_facts_support_deferred IMMEDIATE";
    const unqualifiedAtomicityFlush =
      "SET CONSTRAINTS domain_command_records_b2_slice1_atomicity_deferred IMMEDIATE";

    expect(revoke.match(/SET CONSTRAINTS [^"]+ IMMEDIATE/g)).toEqual([atomicityFlush]);
    expect(supersede.match(/SET CONSTRAINTS [^"]+ IMMEDIATE/g)).toEqual([
      supportFlush,
      atomicityFlush
    ]);
    expect(supersede.indexOf(supportFlush)).toBeLessThan(supersede.indexOf(atomicityFlush));
    expect(revoke).not.toContain(unqualifiedAtomicityFlush);
    expect(supersede).not.toContain(unqualifiedAtomicityFlush);
  });

  it("forces deferred visibility-fixture constraints before restoring user triggers", async () => {
    const source = await readThisSpec();
    const fixture = source.slice(
      source.lastIndexOf("async function insertLifecycleVisibilityFixture"),
      source.lastIndexOf("type Phase6AtomicFault")
    );
    const insert = fixture.indexOf("INSERT INTO truth.fact_lifecycle_events");
    const immediate = fixture.indexOf('client.query("SET CONSTRAINTS ALL IMMEDIATE")');
    const enable = fixture.indexOf(
      'client.query("ALTER TABLE truth.fact_lifecycle_events ENABLE TRIGGER USER")'
    );

    expect(insert).toBeGreaterThan(-1);
    expect(immediate).toBeGreaterThan(insert);
    expect(enable).toBeGreaterThan(immediate);
  });

  it("pins validator-owned lifecycle drift and unjournaled-state diagnostics", async () => {
    const source = await readThisSpec();
    const suite = source.slice(
      source.lastIndexOf('maybeDescribe("Wave B2 PostgreSQL catalog contract"'),
      source.lastIndexOf("const adoptionIds")
    );
    const occurrences = (value: string) => suite.split(value).length - 1;

    expect(occurrences("/B2 Slice 1 exact truth constraint inventory drifted/")).toBe(3);
    expect(occurrences("/B2 Slice 1 truth trigger inventory drifted/")).toBe(3);
    expect(occurrences("/B2 Slice 1 truth policy inventory drifted/")).toBe(1);
    expect(
      occurrences(
        "/B2 migration state already exists without journal row for 0012_b2_fact_lifecycle\\.sql/"
      )
    ).toBe(2);
    expect(occurrences("/Fact lifecycle foreign key catalog drifted/")).toBe(0);
    expect(occurrences("/Fact lifecycle trigger catalog drifted/")).toBe(0);
    expect(occurrences("/Fact lifecycle policy catalog drifted/")).toBe(0);
    expect(
      occurrences("/B2 migration state already exists before 0012_b2_fact_lifecycle\\.sql/")
    ).toBe(0);
  });

  it("uses canonical completion clocks in all lifecycle transaction helpers", async () => {
    const source = await readThisSpec();
    const revoke = source.slice(
      source.lastIndexOf("async function executeExactRevokeTransaction"),
      source.lastIndexOf("async function executeExactSupersedeTransaction")
    );
    const supersede = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction"),
      source.lastIndexOf("async function executeExactSecondSupersedeTransaction")
    );
    const chainedSupersede = source.slice(
      source.lastIndexOf("async function executeExactSecondSupersedeTransaction"),
      source.lastIndexOf("async function executeOrphanSuccessorInsert")
    );
    const completionUpdate = (helper: string) =>
      helper.slice(
        helper.lastIndexOf("UPDATE ops.domain_command_records"),
        helper.lastIndexOf('await client.query("COMMIT")')
      );
    const completions = [
      completionUpdate(revoke),
      completionUpdate(supersede),
      completionUpdate(chainedSupersede)
    ];

    expect(completions).toHaveLength(3);
    for (const completion of completions) {
      expect(completion).toMatch(
        /completed_at = clock_timestamp\(\),\s+updated_at = clock_timestamp\(\)/
      );
      expect(completion).not.toContain("transaction_timestamp()");
    }
  });

  it("sets the confidential data-class ceiling before the lifecycle visibility query", async () => {
    const source = await readThisSpec();
    const rlsTest = source.slice(
      source.lastIndexOf(
        '"enforces exact transaction-local Space RLS for lifecycle rows through the restricted app role"'
      ),
      source.lastIndexOf('"blocks lifecycle event mutation at the table surface: %s"')
    );
    const setLocalScope = rlsTest.slice(
      rlsTest.indexOf("const setLocalScope"),
      rlsTest.indexOf("const visible")
    );

    expect(setLocalScope).toMatch(
      /client\.query\(\s*"SELECT set_config\('app\.data_class_ceiling', 'confidential', true\)"\s*\)/
    );
  });

  it("pins the no-reset A-to-B-to-C history regression and both exact transitions", async () => {
    const source = await readThisSpec();
    const test = source.slice(
      source.lastIndexOf(
        '"commits connected supersession history A to B to C without resetting the coordinate"'
      ),
      source.lastIndexOf(
        '"rejects an orphan successor INSERT immediately with no residue: %s predecessor"'
      )
    );
    const firstTransition = test.indexOf("executeExactSupersedeTransaction");
    const secondTransition = test.indexOf("executeExactSecondSupersedeTransaction");
    const secondHelper = source.slice(
      source.lastIndexOf("async function executeExactSecondSupersedeTransaction"),
      source.lastIndexOf("async function executeOrphanSuccessorInsert")
    );

    expect(firstTransition).toBeGreaterThan(-1);
    expect(secondTransition).toBeGreaterThan(firstTransition);
    expect(test.slice(firstTransition, secondTransition)).not.toMatch(/reset/i);
    expect(test).toContain("phase6Ids.chainSuccessor");
    expect(test).toContain("phase6Ids.chainLifecycle");
    expect(test).toContain("current_slots: 1");
    expect(test).toContain(
      'immutable_triggers: ["fact_lifecycle_immutable", "fact_lifecycle_truncate_guard"]'
    );
    expect(secondHelper).toContain("UPDATE truth.accepted_facts");
    expect(secondHelper).toContain("INSERT INTO truth.accepted_facts");
    expect(secondHelper).toContain("INSERT INTO truth.fact_lifecycle_events");
    expect(secondHelper).toContain(
      "SET CONSTRAINTS truth.accepted_facts_support_deferred IMMEDIATE"
    );
    expect(secondHelper).toContain(
      "SET CONSTRAINTS ops.domain_command_records_b2_slice1_atomicity_deferred IMMEDIATE"
    );
    expect(secondHelper).not.toMatch(/DISABLE TRIGGER|ENABLE TRIGGER/);
  });

  it("pins orphan INSERT rollback to a same-subject proposed Claim with no decoy failure", async () => {
    const source = await readThisSpec();
    const titleIndex = source.lastIndexOf(
      '"rejects an orphan successor INSERT immediately with no residue: %s predecessor"'
    );
    const test = source.slice(
      source.lastIndexOf("it.each([", titleIndex),
      source.lastIndexOf(
        '"commits restricted-app supersession with exact requested confidence lowering provenance"'
      )
    );
    const helper = source.slice(
      source.lastIndexOf("async function executeOrphanSuccessorInsert"),
      source.lastIndexOf("async function insertExact0008TruthFixture")
    );
    const fixture = source.slice(
      source.lastIndexOf("async function insertOwnerPhase6ReplacementClaims"),
      source.lastIndexOf("async function resetPopulatedPhase6")
    );

    expect(test).toContain('["nonexistent", "unrelated"] as const');
    expect(test).toContain('message: "truth mutation requires its exact reserved command"');
    expect(test).toContain("exactPhase6RollbackDigest");
    expect(test).toContain("expectNoPhase6CommandResidue");
    expect(helper).toContain("phase6Ids.nonexistentPredecessor");
    expect(helper).toContain(": adoptionIds.fact");
    expect(helper).toContain("phase6Ids.orphanReplacementClaim");
    expect(helper).toContain("claim.subject_id = $9");
    expect(helper).toContain("phase6Ids.otherSubject");
    expect(helper).toContain("claim.status = 'proposed'");
    expect(helper).toContain('throw new Error("orphan successor INSERT unexpectedly succeeded")');
    expect(helper).not.toMatch(/DISABLE TRIGGER|ENABLE TRIGGER/);
    expect(fixture).toContain("phase6Ids.orphanReplacementClaim");
    expect(fixture).toContain("phase6Ids.otherSubject");
    expect(fixture).toContain('access_class: "workspace"');
  });

  it("pins mixed-class non-leakage through a NOBYPASSRLS app transaction", async () => {
    const source = await readThisSpec();
    const test = source.slice(
      source.lastIndexOf(
        '"classifies mixed-access supersession by both predecessor and successor monotonically"'
      ),
      source.lastIndexOf('"blocks lifecycle event mutation at the table surface: %s"')
    );
    const helper = source.slice(
      source.lastIndexOf("async function executeExactSupersedeTransaction"),
      source.lastIndexOf("async function executeExactSecondSupersedeTransaction")
    );

    expect(test).toContain('"valid_confidential_successor"');
    expect(test).toContain('readAtCeiling("workspace", adoptionIds.space)');
    expect(test).toContain('readAtCeiling("confidential", adoptionIds.space)');
    expect(test).toContain("devFixtures.restrictedSpaceA");
    expect(test).toContain("NOT rolbypassrls");
    for (const protectedField of [
      "replacementFactId",
      "reasonCode",
      "reasonRationale",
      "actorUserId",
      "actorMembershipId"
    ]) {
      expect(test).toContain(protectedField);
    }
    expect(helper).toContain("phase6Ids.confidentialReplacementClaim");
    expect(helper).not.toMatch(/DISABLE TRIGGER|ENABLE TRIGGER/);
  });
});

maybeDescribe("Wave B2 PostgreSQL catalog contract", () => {
  if (!ownerUrl || !appUrl) {
    it("requires local PostgreSQL DSNs in the authoritative gate", () => {
      throw new Error("TEST_DATABASE_URL and TEST_APP_DATABASE_URL are required by the B2 gate");
    });
    return;
  }
  const ownerPool = new pg.Pool({ connectionString: ownerUrl });
  const eventValidator = "ops.b2_slice1_event_payload_valid(text,integer,uuid,jsonb)" as const;
  const auditValidator = "ops.b2_slice1_audit_detail_valid(text,text,integer,uuid,jsonb)" as const;
  const commandValidator =
    "ops.product_command_record_valid(text,integer,text,text,uuid,jsonb)" as const;
  const atomicityFunction = "ops.require_b2_slice1_command_atomicity()" as const;

  const expectExactCommandFunctionPrivileges = async () => {
    const privileges = await ownerPool.query<{
      identity: string;
      grantee: string;
      privilege: string;
      grantable: boolean;
    }>(
      `SELECT procedure.oid::regprocedure::text AS identity,
              CASE
                WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl_record.grantee)
              END AS grantee,
              acl_record.privilege_type AS privilege,
              acl_record.is_grantable AS grantable
         FROM pg_proc procedure
         CROSS JOIN LATERAL aclexplode(COALESCE(
           procedure.proacl, acldefault('f', procedure.proowner)
         )) acl_record
        WHERE procedure.oid = ANY($1::regprocedure[])
          AND acl_record.grantee <> procedure.proowner
        ORDER BY procedure.oid::regprocedure::text, grantee, privilege, grantable`,
      [[auditValidator, eventValidator, commandValidator, atomicityFunction]]
    );
    expect(privileges.rows).toEqual([
      {
        identity: auditValidator,
        grantee: "throughline_app",
        privilege: "EXECUTE",
        grantable: false
      },
      {
        identity: eventValidator,
        grantee: "throughline_app",
        privilege: "EXECUTE",
        grantable: false
      },
      {
        identity: eventValidator,
        grantee: "throughline_product_relay",
        privilege: "EXECUTE",
        grantable: false
      },
      {
        identity: commandValidator,
        grantee: "throughline_app",
        privilege: "EXECUTE",
        grantable: false
      }
    ]);
  };

  const checkpoint = "0010_b2_trusted_objective_initiative_lock.sql";
  const applyCheckpoint = (options: { reset?: boolean } = {}) =>
    applyMigrations(ownerPool, { ...options, through: checkpoint });
  const resetToLatest = () => applyCheckpoint({ reset: true });

  const expectCatalogContractRejected = async (mutation: string, expectedDiagnostic: string) => {
    try {
      await ownerPool.query(mutation);
      await expect(applyCheckpoint()).rejects.toThrow(expectedDiagnostic);
    } finally {
      await resetToLatest();
    }
  };

  const expectPhase5CatalogContractRejected = async (
    mutation: string,
    expectedDiagnostic: string
  ) => {
    try {
      await resetToLatest();
      await applyMigrations(ownerPool);
      await ownerPool.query(mutation);
      await expect(applyMigrations(ownerPool)).rejects.toThrow(expectedDiagnostic);
    } finally {
      await resetToLatest();
    }
  };

  const expectPhase6CatalogContractRejected = async (
    mutation: string,
    expectedDiagnostic: RegExp
  ) => {
    try {
      await resetToLatest();
      await applyMigrations(ownerPool);
      await ownerPool.query(mutation);
      const before = await exactPhase6FailureSnapshot(ownerPool);
      await expect(applyMigrations(ownerPool)).rejects.toThrow(expectedDiagnostic);
      expect(await exactPhase6FailureSnapshot(ownerPool)).toBe(before);
    } finally {
      await resetToLatest();
    }
  };

  const restoreProductionAppRole = () =>
    ownerPool.query(`
      DO $restore$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'throughline_app') THEN
          ALTER ROLE throughline_app
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOBYPASSRLS PASSWORD NULL;
        END IF;
      END
      $restore$
    `);

  const withTestAppPool = async <T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> => {
    await provisionTestAppRole(ownerPool, appUrl);
    const appPool = new pg.Pool({ connectionString: appUrl });
    try {
      return await run(appPool);
    } finally {
      try {
        await appPool.end();
      } finally {
        await restoreProductionAppRole();
      }
    }
  };

  const executeAsRole = async (role: string, statement: string, values: unknown[] = []) => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      return await client.query(statement, values);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  afterAll(async () => {
    try {
      await restoreProductionAppRole();
    } finally {
      await ownerPool.end();
    }
  });

  it("accepts and reapplies the exact post-0007 staged B2 checkpoint", async () => {
    try {
      const initial = await applyMigrations(ownerPool, {
        reset: true,
        through: "0007_b2_slice1_truth_storage.sql"
      });
      expect(initial.applied).toEqual(allMigrationIds.slice(0, 7));
      const phaseOneCapability = await ownerPool.query<{
        schema_usage: boolean;
        table_select: boolean;
      }>(
        `SELECT
           has_schema_privilege(
             'throughline_b1_0_integrity','truth','USAGE'
           ) AS schema_usage,
           has_table_privilege(
             'throughline_b1_0_integrity','truth.accepted_facts','SELECT'
           ) AS table_select`
      );
      expect(phaseOneCapability.rows[0]).toEqual({
        schema_usage: false,
        table_select: false
      });
      await expect(
        applyMigrations(ownerPool, { through: "0007_b2_slice1_truth_storage.sql" })
      ).resolves.toEqual({
        applied: [],
        skipped: [...allMigrationIds.slice(0, 7)]
      });
    } finally {
      await resetToLatest();
    }
  }, 60_000);

  it("boots fresh and reapplies the exact post-0010 ten-migration checkpoint", async () => {
    await resetToLatest();
    await expect(applyCheckpoint()).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });
    const journal = await ownerPool.query<{ id: string }>(
      "SELECT id FROM throughline_migrations.journal ORDER BY id"
    );
    expect(journal.rows.map(({ id }) => id)).toEqual(allMigrationIds);
    const currentSlotIndex = await ownerPool.query<{
      definition: string;
      predicate: string;
    }>(
      `SELECT pg_get_indexdef(index_state.indexrelid, 0, false) AS definition,
              pg_get_expr(index_state.indpred, index_state.indrelid, false) AS predicate
         FROM pg_index index_state
        WHERE index_state.indexrelid =
              'truth.accepted_facts_one_current_slot'::regclass`
    );
    expect(currentSlotIndex.rows).toEqual([
      {
        definition:
          "CREATE UNIQUE INDEX accepted_facts_one_current_slot ON truth.accepted_facts USING btree (tenant_id, workspace_id, space_id, subject_type, subject_id, predicate) WHERE (status = 'current'::text)",
        predicate: "(status = 'current'::text)"
      }
    ]);
    await expectExactCommandFunctionPrivileges();
  }, 60_000);

  it(
    "adds and reapplies the bounded post-0011 objective recovery catalog",
    async () => {
      try {
        await resetToLatest();
        await expect(
          applyMigrations(ownerPool, {
            through: "0011_b2_primary_objective_proposal_recovery.sql"
          })
        ).resolves.toEqual({
          applied: ["0011_b2_primary_objective_proposal_recovery.sql"],
          skipped: [...allMigrationIds]
        });
        await expect(
          applyMigrations(ownerPool, {
            through: "0011_b2_primary_objective_proposal_recovery.sql"
          })
        ).resolves.toEqual({
          applied: [],
          skipped: [...allMigrationIds, "0011_b2_primary_objective_proposal_recovery.sql"]
        });
        const catalog = await ownerPool.query<{
          name: string;
          rls: boolean;
          forced: boolean;
        }>(
          `SELECT relation.relname AS name, relation.relrowsecurity AS rls,
                relation.relforcerowsecurity AS forced
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'truth' AND relation.relname = ANY($1::text[])
          ORDER BY relation.relname`,
          [
            [
              "initiative_objective_proposal_recoveries",
              "initiative_objective_support_attestations"
            ]
          ]
        );
        expect(catalog.rows).toEqual([
          { name: "initiative_objective_proposal_recoveries", rls: true, forced: true },
          { name: "initiative_objective_support_attestations", rls: true, forced: true }
        ]);
        const adoptedMarker = await ownerPool.query<{
          not_null: boolean;
          default_expression: string;
          owned_by_migrator: boolean;
          app_insert: boolean;
          app_update: boolean;
        }>(
          `SELECT attribute.attnotnull AS not_null,
                  pg_get_expr(default_record.adbin, default_record.adrelid, false)
                    AS default_expression,
                  pg_get_userbyid(relation.relowner) = current_user AS owned_by_migrator,
                  has_column_privilege('throughline_app', relation.oid,
                    'safe_request_adopted', 'INSERT') AS app_insert,
                  has_column_privilege('throughline_app', relation.oid,
                    'safe_request_adopted', 'UPDATE') AS app_update
             FROM pg_class relation
             JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
             JOIN pg_attrdef default_record ON default_record.adrelid = attribute.attrelid
               AND default_record.adnum = attribute.attnum
            WHERE relation.oid = 'ops.domain_command_records'::regclass
              AND attribute.attname = 'safe_request_adopted'`
        );
        expect(adoptedMarker.rows).toEqual([
          {
            not_null: true,
            default_expression: "false",
            owned_by_migrator: true,
            app_insert: false,
            app_update: false
          }
        ]);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "adds and reapplies only the bounded post-0012 ordinary Fact lifecycle catalog",
    async () => {
      try {
        await resetToLatest();
        await expect(applyMigrations(ownerPool)).resolves.toEqual({
          applied: [
            "0011_b2_primary_objective_proposal_recovery.sql",
            "0012_b2_fact_lifecycle.sql"
          ],
          skipped: [...allMigrationIds]
        });
        await expect(applyMigrations(ownerPool)).resolves.toEqual({
          applied: [],
          skipped: [...postSlice4AMigrationIds]
        });
        const journal = await ownerPool.query<{ id: string }>(
          "SELECT id FROM throughline_migrations.journal ORDER BY id"
        );
        expect(journal.rows.map(({ id }) => id)).toEqual(postSlice4AMigrationIds);

        const truthFunctionInventory = await ownerPool.query<{ identity: string }>(
          `SELECT procedure.oid::regprocedure::text AS identity
             FROM pg_proc procedure
             JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'truth'
            ORDER BY procedure.oid::regprocedure::text`
        );
        expect(truthFunctionInventory.rows.map(({ identity }) => identity)).toEqual(
          exactPhase6TruthFunctionIdentities
        );

        const lifecycleFunctions = await ownerPool.query<{
          identity: string;
          result: string;
          language: string;
          owner: string;
          security_definer: boolean;
          strict: boolean;
          volatility: string;
          leakproof: boolean;
          parallel: string;
          kind: string;
          configuration: string[];
          source: string;
          acl: unknown[];
        }>(
          `SELECT procedure.oid::regprocedure::text AS identity,
                  pg_get_function_result(procedure.oid) AS result,
                  language.lanname AS language,
                  CASE WHEN procedure.proowner = current_user::regrole
                       THEN 'migration_owner'
                       ELSE pg_get_userbyid(procedure.proowner) END AS owner,
                  procedure.prosecdef AS security_definer,
                  procedure.proisstrict AS strict,
                  procedure.provolatile::text AS volatility,
                  procedure.proleakproof AS leakproof,
                  procedure.proparallel::text AS parallel,
                  procedure.prokind::text AS kind,
                  COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration,
                  btrim(regexp_replace(procedure.prosrc, '[[:space:]]+', ' ', 'g')) AS source,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                             'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                             ELSE pg_get_userbyid(acl.grantee) END,
                             'privilege', acl.privilege_type,
                             'grantable', acl.is_grantable,
                             'grantor', CASE WHEN acl.grantor = current_user::regrole
                                            THEN 'migration_owner'
                                            ELSE pg_get_userbyid(acl.grantor) END
                           ) ORDER BY acl.grantee, acl.privilege_type,
                                      acl.is_grantable, acl.grantor)
                      FROM aclexplode(COALESCE(
                        procedure.proacl, acldefault('f', procedure.proowner)
                      )) acl
                     WHERE acl.grantee <> procedure.proowner
                  ), '[]'::jsonb) AS acl
             FROM pg_proc procedure
             JOIN pg_language language ON language.oid = procedure.prolang
            WHERE procedure.oid = ANY($1::regprocedure[])
            ORDER BY procedure.oid::regprocedure::text`,
          [Object.keys(exactPhase6LifecycleFunctionSources)]
        );
        expect(lifecycleFunctions.rows).toEqual(exactPhase6LifecycleFunctionCatalog);

        const installed0012FunctionBodies = await ownerPool.query<{
          identity: string;
          source: string;
        }>(
          `SELECT procedure.oid::regprocedure::text AS identity,
                  procedure.prosrc AS source
             FROM pg_proc procedure
            WHERE procedure.oid = ANY($1::regprocedure[])
            ORDER BY procedure.oid::regprocedure::text`,
          [Object.keys(exact0012FunctionBodyDigests)]
        );
        expect(
          Object.fromEntries(
            installed0012FunctionBodies.rows.map(({ identity, source }) => [
              identity,
              createHash("sha256").update(normalizeSql(source)).digest("hex")
            ])
          )
        ).toEqual(exact0012FunctionBodyDigests);

        const columns = await ownerPool.query<{
          column_name: string;
          data_type: string;
          not_null: boolean;
          default_expression: string | null;
        }>(
          `SELECT attribute.attname::text AS column_name,
                  format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
                  attribute.attnotnull AS not_null,
                  pg_get_expr(default_record.adbin, default_record.adrelid, false)
                    AS default_expression
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
             LEFT JOIN pg_attrdef default_record
               ON default_record.adrelid = attribute.attrelid
              AND default_record.adnum = attribute.attnum
            WHERE namespace.nspname = 'truth'
              AND relation.relname = 'fact_lifecycle_events'
              AND attribute.attnum > 0 AND NOT attribute.attisdropped
            ORDER BY attribute.attnum`
        );
        expect(columns.rows).toEqual(exactFactLifecycleColumns);

        const lifecycleBoundary = await ownerPool.query<{
          rls: boolean;
          forced: boolean;
          status_constraint: string;
          version_constraint: string;
          current_slot: string;
        }>(
          `SELECT lifecycle.relrowsecurity AS rls,
                  lifecycle.relforcerowsecurity AS forced,
                  (SELECT pg_get_constraintdef(constraint_record.oid, false)
                     FROM pg_constraint constraint_record
                    WHERE constraint_record.conrelid = 'truth.accepted_facts'::regclass
                      AND constraint_record.conname = 'accepted_facts_status_check')
                    AS status_constraint,
                  (SELECT pg_get_constraintdef(constraint_record.oid, false)
                     FROM pg_constraint constraint_record
                    WHERE constraint_record.conrelid = 'truth.accepted_facts'::regclass
                      AND constraint_record.conname = 'accepted_facts_version_check')
                    AS version_constraint,
                  pg_get_indexdef('truth.accepted_facts_one_current_slot'::regclass, 0, false)
                    AS current_slot
             FROM pg_class lifecycle
            WHERE lifecycle.oid = 'truth.fact_lifecycle_events'::regclass`
        );
        expect(lifecycleBoundary.rows).toEqual([
          {
            rls: true,
            forced: true,
            status_constraint:
              "CHECK ((status = ANY (ARRAY['current'::text, 'superseded'::text, 'revoked'::text])))",
            version_constraint:
              "CHECK ((((status = 'current'::text) AND (version = 1)) OR ((status = ANY (ARRAY['superseded'::text, 'revoked'::text])) AND (version = 2))))",
            current_slot:
              "CREATE UNIQUE INDEX accepted_facts_one_current_slot ON truth.accepted_facts USING btree (tenant_id, workspace_id, space_id, subject_type, subject_id, predicate) WHERE (status = 'current'::text)"
          }
        ]);

        const checks = await ownerPool.query<{
          table_name: string;
          name: string;
          definition: string;
          deferrable: boolean;
          initially_deferred: boolean;
          validated: boolean;
        }>(
          `SELECT relation.relname AS table_name,
                  constraint_record.conname AS name,
                  pg_get_constraintdef(constraint_record.oid, false) AS definition,
                  constraint_record.condeferrable AS deferrable,
                  constraint_record.condeferred AS initially_deferred,
                  constraint_record.convalidated AS validated
             FROM pg_constraint constraint_record
             JOIN pg_class relation ON relation.oid = constraint_record.conrelid
            WHERE constraint_record.contype = 'c'
              AND (
                constraint_record.conrelid = 'truth.fact_lifecycle_events'::regclass OR
                (constraint_record.conrelid = 'truth.accepted_facts'::regclass AND
                 constraint_record.conname IN (
                   'accepted_facts_status_check', 'accepted_facts_version_check'
                 ))
              )
            ORDER BY relation.relname, constraint_record.conname`
        );
        expect(checks.rows).toEqual(exactPhase6Checks);

        const closedVocabulary = await ownerPool.query<{
          name: string;
          definition: string;
        }>(
          `SELECT constraint_record.conname AS name,
                  pg_get_constraintdef(constraint_record.oid, false) AS definition
             FROM pg_constraint constraint_record
            WHERE constraint_record.conname = ANY($1::text[])
            ORDER BY constraint_record.conname`,
          [["audit_events_action_check", "product_outbox_events_event_type_check"]]
        );
        const exactAnyCheck = (column: string, values: readonly string[]) =>
          `CHECK ((${column} = ANY (ARRAY[${values
            .map((value) => `'${value}'::text`)
            .join(", ")}])))`;
        expect(closedVocabulary.rows).toEqual([
          {
            name: "audit_events_action_check",
            definition: exactAnyCheck("action", exactPhase6AuditActions)
          },
          {
            name: "product_outbox_events_event_type_check",
            definition: exactAnyCheck("event_type", exactPhase6OutboxEvents)
          }
        ]);

        const policies = await ownerPool.query<{
          table_name: string;
          policy_name: string;
          operation: string;
          permissive: boolean;
          roles: string[];
          using_expression: string | null;
          check_expression: string | null;
        }>(
          `SELECT relation.relname AS table_name, policy.polname AS policy_name,
                  policy.polcmd::text AS operation,
                  policy.polpermissive AS permissive,
                  ARRAY(SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC'
                                    ELSE role_oid::regrole::text END
                          FROM unnest(policy.polroles) role_oid ORDER BY 1) AS roles,
                  pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
                  pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
             FROM pg_policy policy
             JOIN pg_class relation ON relation.oid = policy.polrelid
            WHERE policy.polname = ANY($1::text[])
            ORDER BY relation.relname, policy.polname`,
          [
            [
              "accepted_facts_lifecycle_update",
              "fact_lifecycle_insert",
              "fact_lifecycle_integrity_select",
              "fact_lifecycle_select"
            ]
          ]
        );
        expect(policies.rows).toEqual(exactPhase6Policies);

        const foreignKeys = await ownerPool.query<{
          name: string;
          definition: string;
          deferrable: boolean;
          initially_deferred: boolean;
          validated: boolean;
          match_type: string;
          update_action: string;
          delete_action: string;
        }>(
          `SELECT constraint_record.conname AS name,
                  pg_get_constraintdef(constraint_record.oid, false) AS definition,
                  constraint_record.condeferrable AS deferrable,
                  constraint_record.condeferred AS initially_deferred,
                  constraint_record.convalidated AS validated,
                  constraint_record.confmatchtype::text AS match_type,
                  constraint_record.confupdtype::text AS update_action,
                  constraint_record.confdeltype::text AS delete_action
             FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid = 'truth.fact_lifecycle_events'::regclass
              AND constraint_record.contype = 'f'
            ORDER BY constraint_record.conname`
        );
        expect(foreignKeys.rows).toEqual(exactPhase6ForeignKeys);

        const triggers = await ownerPool.query<{
          name: string;
          table_name: string;
          function_identity: string;
          enabled: boolean;
          deferrable: boolean;
          initially_deferred: boolean;
          definition: string;
        }>(
          `SELECT trigger_record.tgname AS name,
                  relation.relname AS table_name,
                  procedure.oid::regprocedure::text AS function_identity,
                  trigger_record.tgenabled <> 'D' AS enabled,
                  trigger_record.tgdeferrable AS deferrable,
                  trigger_record.tginitdeferred AS initially_deferred,
                  pg_get_triggerdef(trigger_record.oid, false) AS definition
             FROM pg_trigger trigger_record
             JOIN pg_class relation ON relation.oid = trigger_record.tgrelid
             JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
            WHERE NOT trigger_record.tgisinternal
              AND trigger_record.tgname = ANY($1::text[])
            ORDER BY trigger_record.tgname`,
          [exactPhase6TriggerRows.map(({ name }) => name)]
        );
        expect(triggers.rows).toEqual(exactPhase6TriggerRows);

        const commandTrigger = await ownerPool.query<{
          name: string;
          function_identity: string;
          deferrable: boolean;
          initially_deferred: boolean;
          definition: string;
        }>(
          `SELECT trigger_record.tgname AS name,
                  procedure.oid::regprocedure::text AS function_identity,
                  trigger_record.tgdeferrable AS deferrable,
                  trigger_record.tginitdeferred AS initially_deferred,
                  pg_get_triggerdef(trigger_record.oid, false) AS definition
             FROM pg_trigger trigger_record
             JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
            WHERE trigger_record.tgrelid = 'ops.domain_command_records'::regclass
              AND trigger_record.tgname = $1`,
          [exactPhase6CommandTrigger.name]
        );
        expect(commandTrigger.rows).toEqual([exactPhase6CommandTrigger]);

        const preservedImmutability = await ownerPool.query<{
          name: string;
          table_name: string;
          function_identity: string;
          definition: string;
        }>(
          `SELECT trigger_record.tgname AS name,
                  relation.relname AS table_name,
                  procedure.oid::regprocedure::text AS function_identity,
                  pg_get_triggerdef(trigger_record.oid, false) AS definition
             FROM pg_trigger trigger_record
             JOIN pg_class relation ON relation.oid = trigger_record.tgrelid
             JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
            WHERE NOT trigger_record.tgisinternal
              AND trigger_record.tgname = ANY($1::text[])
            ORDER BY trigger_record.tgname`,
          [
            [
              "accepted_facts_insert_guard",
              "accepted_facts_support_deferred",
              "claims_command_guard",
              "claims_delete_guard",
              "claims_insert_guard",
              "claims_transition_guard",
              "fact_claims_command_guard",
              "fact_claims_immutable",
              "fact_claims_support_deferred",
              "verified_evidence_command_guard",
              "verified_evidence_immutable",
              "verified_evidence_snapshot_guard"
            ]
          ]
        );
        expect(preservedImmutability.rows).toEqual([
          {
            name: "accepted_facts_insert_guard",
            table_name: "accepted_facts",
            function_identity: "truth.validate_fact_insert()",
            definition:
              "CREATE TRIGGER accepted_facts_insert_guard BEFORE INSERT ON truth.accepted_facts FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_insert()"
          },
          {
            name: "accepted_facts_support_deferred",
            table_name: "accepted_facts",
            function_identity: "truth.validate_fact_support()",
            definition:
              "CREATE CONSTRAINT TRIGGER accepted_facts_support_deferred AFTER INSERT ON truth.accepted_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_support()"
          },
          {
            name: "claims_command_guard",
            table_name: "claims",
            function_identity: "truth.require_reserved_command()",
            definition:
              "CREATE TRIGGER claims_command_guard BEFORE INSERT ON truth.claims FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('claim.create-or-rework.v1')"
          },
          {
            name: "claims_delete_guard",
            table_name: "claims",
            function_identity: "truth.reject_mutation()",
            definition:
              "CREATE TRIGGER claims_delete_guard BEFORE DELETE ON truth.claims FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation()"
          },
          {
            name: "claims_insert_guard",
            table_name: "claims",
            function_identity: "truth.validate_claim_insert()",
            definition:
              "CREATE TRIGGER claims_insert_guard BEFORE INSERT ON truth.claims FOR EACH ROW EXECUTE FUNCTION truth.validate_claim_insert()"
          },
          {
            name: "claims_transition_guard",
            table_name: "claims",
            function_identity: "truth.enforce_claim_transition()",
            definition:
              "CREATE TRIGGER claims_transition_guard BEFORE UPDATE ON truth.claims FOR EACH ROW EXECUTE FUNCTION truth.enforce_claim_transition()"
          },
          {
            name: "fact_claims_command_guard",
            table_name: "fact_claims",
            function_identity: "truth.require_fact_accept_reservation()",
            definition:
              "CREATE TRIGGER fact_claims_command_guard BEFORE INSERT ON truth.fact_claims FOR EACH ROW EXECUTE FUNCTION truth.require_fact_accept_reservation()"
          },
          {
            name: "fact_claims_immutable",
            table_name: "fact_claims",
            function_identity: "truth.reject_mutation()",
            definition:
              "CREATE TRIGGER fact_claims_immutable BEFORE DELETE OR UPDATE ON truth.fact_claims FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation()"
          },
          {
            name: "fact_claims_support_deferred",
            table_name: "fact_claims",
            function_identity: "truth.validate_fact_support()",
            definition:
              "CREATE CONSTRAINT TRIGGER fact_claims_support_deferred AFTER INSERT ON truth.fact_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_support()"
          },
          {
            name: "verified_evidence_command_guard",
            table_name: "verified_evidence_spans",
            function_identity: "truth.require_reserved_command()",
            definition:
              "CREATE TRIGGER verified_evidence_command_guard BEFORE INSERT ON truth.verified_evidence_spans FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('claim.create-or-rework.v1')"
          },
          {
            name: "verified_evidence_immutable",
            table_name: "verified_evidence_spans",
            function_identity: "truth.reject_mutation()",
            definition:
              "CREATE TRIGGER verified_evidence_immutable BEFORE DELETE OR UPDATE ON truth.verified_evidence_spans FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation()"
          },
          {
            name: "verified_evidence_snapshot_guard",
            table_name: "verified_evidence_spans",
            function_identity: "truth.verify_evidence_snapshot()",
            definition:
              "CREATE TRIGGER verified_evidence_snapshot_guard BEFORE INSERT ON truth.verified_evidence_spans FOR EACH ROW EXECUTE FUNCTION truth.verify_evidence_snapshot()"
          }
        ]);

        const privileges = await ownerPool.query<{
          table_name: string;
          scope: string;
          column_name: string | null;
          grantee: string;
          privilege: string;
          grantable: boolean;
        }>(
          `SELECT relation.relname AS table_name, 'table'::text AS scope,
                  NULL::text AS column_name,
                  CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_get_userbyid(acl.grantee) END AS grantee,
                  acl.privilege_type AS privilege, acl.is_grantable AS grantable
             FROM pg_class relation
             CROSS JOIN LATERAL aclexplode(COALESCE(
               relation.relacl, acldefault('r', relation.relowner)
             )) acl
            WHERE relation.oid = ANY($1::regclass[])
              AND acl.grantee <> relation.relowner
            UNION ALL
           SELECT relation.relname, 'column', attribute.attname::text,
                  CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_get_userbyid(acl.grantee) END,
                  acl.privilege_type, acl.is_grantable
             FROM pg_class relation
             JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
             CROSS JOIN LATERAL aclexplode(COALESCE(
               attribute.attacl, acldefault('c', relation.relowner)
             )) acl
            WHERE relation.oid = ANY($1::regclass[])
              AND attribute.attnum > 0 AND NOT attribute.attisdropped
              AND acl.grantee <> relation.relowner
            ORDER BY table_name, scope, column_name NULLS FIRST, grantee, privilege, grantable`,
          [["truth.accepted_facts", "truth.fact_lifecycle_events"]]
        );
        expect(privileges.rows).toEqual(exactPhase6Privileges);

        const appRoleBoundary = await ownerPool.query<{
          bypass_rls: boolean;
          privilege_memberships: string[];
        }>(
          `SELECT app.rolbypassrls AS bypass_rls,
                  ARRAY(
                    SELECT inherited.rolname::text
                      FROM pg_roles inherited
                     WHERE inherited.oid <> app.oid
                       AND pg_has_role(app.oid, inherited.oid, 'MEMBER')
                       AND (
                         inherited.rolsuper OR inherited.rolbypassrls OR
                         has_table_privilege(
                           inherited.oid,
                           'truth.accepted_facts',
                           'UPDATE, DELETE, TRUNCATE'
                         ) OR has_table_privilege(
                           inherited.oid,
                           'truth.fact_lifecycle_events',
                           'UPDATE, DELETE, TRUNCATE'
                         )
                       )
                     ORDER BY inherited.rolname
                  ) AS privilege_memberships
             FROM pg_roles app
            WHERE app.rolname = 'throughline_app'`
        );
        expect(appRoleBoundary.rows).toEqual([{ bypass_rls: false, privilege_memberships: [] }]);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "commits one exact revoke with no successor and exact command, audit, and outbox evidence",
    async () => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        await withTestAppPool((appPool) =>
          executeExactRevokeTransaction(appPool, "valid", relayServicePrincipalId)
        );
        const committed = await ownerPool.query<{
          fact: unknown;
          lifecycle: unknown;
          command_record: unknown;
          audit: unknown;
          outbox: unknown;
        }>(
          `SELECT
             (SELECT jsonb_build_object(
                'id', fact.id, 'status', fact.status, 'version', fact.version,
                'lastCausationCommandId', fact.last_causation_command_id
              ) FROM truth.accepted_facts fact WHERE fact.id = $1) AS fact,
             (SELECT jsonb_build_object(
                'predecessorFactId', lifecycle.predecessor_fact_id,
                'successorFactId', lifecycle.successor_fact_id,
                'transitionKind', lifecycle.transition_kind,
                'fromStatus', lifecycle.from_status, 'toStatus', lifecycle.to_status,
                'reasonCode', lifecycle.reason_code,
                'reasonRationale', lifecycle.reason_rationale,
                'authorityBasis', lifecycle.authority_basis,
                'actorUserId', lifecycle.acted_by_user_id,
                'actorMembershipId', lifecycle.acted_by_membership_id,
                'commandId', lifecycle.causation_command_id,
                'version', lifecycle.version
              ) FROM truth.fact_lifecycle_events lifecycle
                WHERE lifecycle.causation_command_id = $2) AS lifecycle,
             (SELECT jsonb_build_object(
                'kind', command_record.command_kind,
                'schemaVersion', command_record.command_schema_version,
                'state', command_record.state,
                'safeRequest', command_record.safe_request,
                'resourceType', command_record.result_resource_type,
                'resourceId', command_record.result_resource_id,
                'safeResponse', command_record.safe_response
              ) FROM ops.domain_command_records command_record
                WHERE command_record.id = $2) AS command_record,
             (SELECT jsonb_build_object(
                'action', audit.action, 'resourceType', audit.resource_type,
                'resourceId', audit.resource_id, 'schemaVersion', audit.audit_schema_version,
                'safeDetail', audit.safe_detail
              ) FROM ops.audit_events audit WHERE audit.causation_command_id = $2) AS audit,
             (SELECT jsonb_build_object(
                'eventType', event.event_type,
                'eventSchemaVersion', event.event_schema_version,
                'payloadSchemaVersion', event.payload_schema_version,
                'aggregateType', event.aggregate_type,
                'aggregateId', event.aggregate_id,
                'aggregateVersion', event.aggregate_version,
                'relayServicePrincipalId', event.relay_service_principal_id,
                'payload', event.payload
              ) FROM ops.product_outbox_events event
                WHERE event.causation_command_id = $2) AS outbox`,
          [adoptionIds.fact, phase6Ids.revokeCommand]
        );
        expect(committed.rows).toEqual([
          {
            fact: {
              id: adoptionIds.fact,
              status: "revoked",
              version: 2,
              lastCausationCommandId: phase6Ids.revokeCommand
            },
            lifecycle: {
              predecessorFactId: adoptionIds.fact,
              successorFactId: null,
              transitionKind: "revoke",
              fromStatus: "current",
              toStatus: "revoked",
              reasonCode: "no_longer_true",
              reasonRationale: "The accepted outcome no longer reflects current reality.",
              authorityBasis: "activity_owner",
              actorUserId: adoptionIds.user,
              actorMembershipId: adoptionIds.membership,
              commandId: phase6Ids.revokeCommand,
              version: 1
            },
            command_record: {
              kind: "fact.revoke.v1",
              schemaVersion: 1,
              state: "completed",
              safeRequest: {
                factId: adoptionIds.fact,
                expectedFactVersion: 1,
                reason: {
                  code: "no_longer_true",
                  rationale: "The accepted outcome no longer reflects current reality."
                }
              },
              resourceType: "accepted_fact",
              resourceId: adoptionIds.fact,
              safeResponse: { factId: adoptionIds.fact, status: "revoked", version: 2 }
            },
            audit: {
              action: "fact.revoke",
              resourceType: "accepted_fact",
              resourceId: adoptionIds.fact,
              schemaVersion: 1,
              safeDetail: {
                factId: adoptionIds.fact,
                factVersion: 2,
                reasonCode: "no_longer_true",
                status: "revoked"
              }
            },
            outbox: {
              eventType: "fact.revoked",
              eventSchemaVersion: 1,
              payloadSchemaVersion: 1,
              aggregateType: "accepted_fact",
              aggregateId: adoptionIds.fact,
              aggregateVersion: 2,
              relayServicePrincipalId,
              payload: {
                factId: adoptionIds.fact,
                factVersion: 2,
                reasonCode: "no_longer_true",
                status: "revoked"
              }
            }
          }
        ]);
        expect(
          JSON.stringify({ audit: committed.rows[0]?.audit, outbox: committed.rows[0]?.outbox })
        ).not.toMatch(/reasonRationale|objectiveText|sourceText|sourceExcerpt|arbitraryText/);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "commits exact supersession lineage A to B with one replacement current slot",
    async () => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const immutableBefore = await exactPredecessorImmutableDigest(ownerPool);
        await withTestAppPool((appPool) =>
          executeExactSupersedeTransaction(appPool, "valid", relayServicePrincipalId)
        );
        const lineage = await ownerPool.query<{
          predecessor_id: string;
          predecessor_status: string;
          predecessor_version: number;
          successor_id: string;
          successor_status: string;
          successor_version: number;
          lifecycle_predecessor: string;
          lifecycle_successor: string;
          transition: string;
          current_slots: number;
          replacement_support: unknown;
          outbox: unknown;
        }>(
          `SELECT predecessor.id AS predecessor_id,
                  predecessor.status AS predecessor_status,
                  predecessor.version AS predecessor_version,
                  successor.id AS successor_id,
                  successor.status AS successor_status,
                  successor.version AS successor_version,
                  lifecycle.predecessor_fact_id AS lifecycle_predecessor,
                  lifecycle.successor_fact_id AS lifecycle_successor,
                  lifecycle.transition_kind AS transition,
                  (SELECT count(*)::integer FROM truth.accepted_facts current_fact
                    WHERE current_fact.tenant_id = predecessor.tenant_id
                      AND current_fact.workspace_id = predecessor.workspace_id
                      AND current_fact.space_id = predecessor.space_id
                      AND current_fact.subject_type = predecessor.subject_type
                      AND current_fact.subject_id = predecessor.subject_id
                      AND current_fact.predicate = predecessor.predicate
                      AND current_fact.status = 'current') AS current_slots,
                  (SELECT jsonb_agg(jsonb_build_object(
                     'claimId', support.claim_id,
                     'expectedVersion', claim.version - 1,
                     'status', claim.status,
                     'version', claim.version
                   ) ORDER BY support.claim_id)
                     FROM truth.fact_claims support
                     JOIN truth.claims claim
                       ON claim.tenant_id = support.tenant_id
                      AND claim.workspace_id = support.workspace_id
                      AND claim.id = support.claim_id
                    WHERE support.fact_id = successor.id) AS replacement_support,
                  (SELECT jsonb_build_object(
                     'relayServicePrincipalId', event.relay_service_principal_id
                   ) FROM ops.product_outbox_events event
                    WHERE event.causation_command_id = $2) AS outbox
             FROM truth.accepted_facts predecessor
             JOIN truth.fact_lifecycle_events lifecycle
               ON lifecycle.predecessor_fact_id = predecessor.id
             JOIN truth.accepted_facts successor
               ON successor.id = lifecycle.successor_fact_id
            WHERE predecessor.id = $1`,
          [adoptionIds.fact, phase6Ids.supersedeCommand]
        );
        expect(lineage.rows).toEqual([
          {
            predecessor_id: adoptionIds.fact,
            predecessor_status: "superseded",
            predecessor_version: 2,
            successor_id: adoptionIds.successor,
            successor_status: "current",
            successor_version: 1,
            lifecycle_predecessor: adoptionIds.fact,
            lifecycle_successor: adoptionIds.successor,
            transition: "supersede",
            current_slots: 1,
            replacement_support: [
              {
                claimId: phase6Ids.replacementClaim,
                expectedVersion: 1,
                status: "accepted",
                version: 2
              }
            ],
            outbox: { relayServicePrincipalId }
          }
        ]);
        expect(await exactPredecessorImmutableDigest(ownerPool)).toBe(immutableBefore);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "commits connected supersession history A to B to C without resetting the coordinate",
    async () => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        await withTestAppPool((appPool) =>
          executeExactSupersedeTransaction(appPool, "valid", relayServicePrincipalId)
        );
        await withTestAppPool((appPool) =>
          executeExactSecondSupersedeTransaction(appPool, relayServicePrincipalId)
        );

        const history = await ownerPool.query<{
          facts: unknown;
          lifecycle: unknown;
          commands: unknown;
          audits: unknown;
          outbox: unknown;
          support: unknown;
          current_slots: number;
          immutable_triggers: string[];
        }>(
          `SELECT
             (SELECT jsonb_agg(jsonb_build_object(
                'id', fact.id, 'status', fact.status, 'version', fact.version,
                'commandId', fact.last_causation_command_id
              ) ORDER BY fact.id)
                FROM truth.accepted_facts fact
               WHERE fact.id = ANY($1::uuid[])) AS facts,
             (SELECT jsonb_agg(jsonb_build_object(
                'id', lifecycle.id,
                'predecessorFactId', lifecycle.predecessor_fact_id,
                'successorFactId', lifecycle.successor_fact_id,
                'transitionKind', lifecycle.transition_kind,
                'fromStatus', lifecycle.from_status,
                'toStatus', lifecycle.to_status,
                'reasonCode', lifecycle.reason_code,
                'reasonRationale', lifecycle.reason_rationale,
                'actorUserId', lifecycle.acted_by_user_id,
                'actorMembershipId', lifecycle.acted_by_membership_id,
                'commandId', lifecycle.causation_command_id,
                'version', lifecycle.version
              ) ORDER BY lifecycle.id)
                FROM truth.fact_lifecycle_events lifecycle
               WHERE lifecycle.predecessor_fact_id = ANY($1::uuid[])) AS lifecycle,
             (SELECT jsonb_agg(jsonb_build_object(
                'id', command.id, 'state', command.state,
                'resourceId', command.result_resource_id,
                'response', command.safe_response
              ) ORDER BY command.id)
                FROM ops.domain_command_records command
               WHERE command.id = ANY($2::uuid[])) AS commands,
             (SELECT jsonb_agg(jsonb_build_object(
                'commandId', audit.causation_command_id,
                'action', audit.action,
                'resourceId', audit.resource_id,
                'safeDetail', audit.safe_detail
              ) ORDER BY audit.causation_command_id)
                FROM ops.audit_events audit
               WHERE audit.causation_command_id = ANY($2::uuid[])) AS audits,
             (SELECT jsonb_agg(jsonb_build_object(
                'commandId', event.causation_command_id,
                'eventType', event.event_type,
                'aggregateId', event.aggregate_id,
                'payload', event.payload,
                'relayServicePrincipalId', event.relay_service_principal_id
              ) ORDER BY event.causation_command_id)
                FROM ops.product_outbox_events event
               WHERE event.causation_command_id = ANY($2::uuid[])) AS outbox,
             (SELECT jsonb_agg(jsonb_build_object(
                'factId', support.fact_id,
                'claimId', support.claim_id,
                'claimStatus', claim.status,
                'claimVersion', claim.version
              ) ORDER BY support.fact_id, support.claim_id)
                FROM truth.fact_claims support
                JOIN truth.claims claim
                  ON claim.tenant_id = support.tenant_id
                 AND claim.workspace_id = support.workspace_id
                 AND claim.id = support.claim_id
               WHERE support.fact_id = ANY($1::uuid[])) AS support,
             (SELECT count(*)::integer
                FROM truth.accepted_facts fact
               WHERE fact.tenant_id = $3
                 AND fact.workspace_id = $4
                 AND fact.space_id = $5
                 AND fact.subject_type = 'activity'
                 AND fact.subject_id = $6
                 AND fact.predicate = 'activity.outcome'
                 AND fact.status = 'current') AS current_slots,
             (SELECT array_agg(trigger.tgname::text ORDER BY trigger.tgname)
                FROM pg_trigger trigger
               WHERE trigger.tgrelid = 'truth.fact_lifecycle_events'::regclass
                 AND NOT trigger.tgisinternal
                 AND trigger.tgenabled = 'O'
                 AND trigger.tgname IN (
                   'fact_lifecycle_immutable','fact_lifecycle_truncate_guard'
                 )) AS immutable_triggers`,
          [
            [adoptionIds.fact, adoptionIds.successor, phase6Ids.chainSuccessor],
            [phase6Ids.supersedeCommand, phase6Ids.chainCommand],
            adoptionIds.tenant,
            adoptionIds.workspace,
            adoptionIds.space,
            adoptionIds.subject
          ]
        );
        expect(history.rows).toEqual([
          {
            facts: [
              {
                id: adoptionIds.fact,
                status: "superseded",
                version: 2,
                commandId: phase6Ids.supersedeCommand
              },
              {
                id: adoptionIds.successor,
                status: "superseded",
                version: 2,
                commandId: phase6Ids.chainCommand
              },
              {
                id: phase6Ids.chainSuccessor,
                status: "current",
                version: 1,
                commandId: phase6Ids.chainCommand
              }
            ],
            lifecycle: [
              {
                id: phase6Ids.supersedeLifecycle,
                predecessorFactId: adoptionIds.fact,
                successorFactId: adoptionIds.successor,
                transitionKind: "supersede",
                fromStatus: "current",
                toStatus: "superseded",
                reasonCode: "newer_evidence",
                reasonRationale: "The later ratified outcome replaces the predecessor.",
                actorUserId: adoptionIds.user,
                actorMembershipId: adoptionIds.membership,
                commandId: phase6Ids.supersedeCommand,
                version: 1
              },
              {
                id: phase6Ids.chainLifecycle,
                predecessorFactId: adoptionIds.successor,
                successorFactId: phase6Ids.chainSuccessor,
                transitionKind: "supersede",
                fromStatus: "current",
                toStatus: "superseded",
                reasonCode: "newer_evidence",
                reasonRationale: "A later ratified outcome replaces the first successor.",
                actorUserId: adoptionIds.user,
                actorMembershipId: adoptionIds.membership,
                commandId: phase6Ids.chainCommand,
                version: 1
              }
            ],
            commands: [
              {
                id: phase6Ids.supersedeCommand,
                state: "completed",
                resourceId: adoptionIds.fact,
                response: {
                  factId: adoptionIds.fact,
                  version: 2,
                  status: "superseded",
                  replacementFactId: adoptionIds.successor,
                  replacementFactVersion: 1,
                  replacementFactStatus: "current"
                }
              },
              {
                id: phase6Ids.chainCommand,
                state: "completed",
                resourceId: adoptionIds.successor,
                response: {
                  factId: adoptionIds.successor,
                  version: 2,
                  status: "superseded",
                  replacementFactId: phase6Ids.chainSuccessor,
                  replacementFactVersion: 1,
                  replacementFactStatus: "current"
                }
              }
            ],
            audits: [
              {
                commandId: phase6Ids.supersedeCommand,
                action: "fact.supersede",
                resourceId: adoptionIds.fact,
                safeDetail: {
                  factId: adoptionIds.fact,
                  factVersion: 2,
                  reasonCode: "newer_evidence",
                  replacementFactId: adoptionIds.successor,
                  replacementFactVersion: 1,
                  status: "superseded"
                }
              },
              {
                commandId: phase6Ids.chainCommand,
                action: "fact.supersede",
                resourceId: adoptionIds.successor,
                safeDetail: {
                  factId: adoptionIds.successor,
                  factVersion: 2,
                  reasonCode: "newer_evidence",
                  replacementFactId: phase6Ids.chainSuccessor,
                  replacementFactVersion: 1,
                  status: "superseded"
                }
              }
            ],
            outbox: [
              {
                commandId: phase6Ids.supersedeCommand,
                eventType: "fact.superseded",
                aggregateId: adoptionIds.fact,
                payload: {
                  factId: adoptionIds.fact,
                  factVersion: 2,
                  reasonCode: "newer_evidence",
                  replacementFactId: adoptionIds.successor,
                  replacementFactVersion: 1,
                  status: "superseded"
                },
                relayServicePrincipalId
              },
              {
                commandId: phase6Ids.chainCommand,
                eventType: "fact.superseded",
                aggregateId: adoptionIds.successor,
                payload: {
                  factId: adoptionIds.successor,
                  factVersion: 2,
                  reasonCode: "newer_evidence",
                  replacementFactId: phase6Ids.chainSuccessor,
                  replacementFactVersion: 1,
                  status: "superseded"
                },
                relayServicePrincipalId
              }
            ],
            support: [
              {
                factId: adoptionIds.fact,
                claimId: adoptionIds.claim,
                claimStatus: "accepted",
                claimVersion: 2
              },
              {
                factId: adoptionIds.successor,
                claimId: phase6Ids.replacementClaim,
                claimStatus: "accepted",
                claimVersion: 2
              },
              {
                factId: phase6Ids.chainSuccessor,
                claimId: phase6Ids.secondReplacementClaim,
                claimStatus: "accepted",
                claimVersion: 2
              }
            ],
            current_slots: 1,
            immutable_triggers: ["fact_lifecycle_immutable", "fact_lifecycle_truncate_guard"]
          }
        ]);
      } finally {
        await resetToLatest();
      }
    },
    PHASE6_SUPERSEDE_ROLLBACK_TEST_TIMEOUT
  );

  it.each(["nonexistent", "unrelated"] as const)(
    "rejects an orphan successor INSERT immediately with no residue: %s predecessor",
    async (predecessorFault) => {
      try {
        await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool, phase6Ids.orphanCommand);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(executeOrphanSuccessorInsert(appPool, predecessorFault), {
            code: "P0001",
            message: "truth mutation requires its exact reserved command",
            constraint: null
          })
        );
        expect(await exactPhase6RollbackDigest(ownerPool, phase6Ids.orphanCommand)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.orphanCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "commits restricted-app supersession with exact requested confidence lowering provenance",
    async () => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        await withTestAppPool((appPool) =>
          executeExactSupersedeTransaction(
            appPool,
            "valid_confidence_lowering",
            relayServicePrincipalId
          )
        );
        const stored = await ownerPool.query<{
          confidence: string;
          strongest_supporting_confidence: string;
          human_lowered: boolean;
          confidence_lowering_reason_code: string;
          confidence_lowering_rationale: string;
          safe_request: unknown;
        }>(
          `SELECT successor.confidence, successor.strongest_supporting_confidence,
                  successor.human_lowered, successor.confidence_lowering_reason_code,
                  successor.confidence_lowering_rationale, command.safe_request
             FROM truth.accepted_facts successor
             JOIN ops.domain_command_records command
               ON command.tenant_id = successor.tenant_id
              AND command.workspace_id = successor.workspace_id
              AND command.id = successor.last_causation_command_id
            WHERE successor.id = $1`,
          [adoptionIds.successor]
        );
        expect(stored.rows).toEqual([
          {
            confidence: "weak",
            strongest_supporting_confidence: "strong",
            human_lowered: true,
            confidence_lowering_reason_code: "residual_uncertainty",
            confidence_lowering_rationale:
              "Residual timing uncertainty warrants a conservative confidence.",
            safe_request: {
              factId: adoptionIds.fact,
              expectedFactVersion: 1,
              subject: { type: "activity", id: adoptionIds.subject, expectedVersion: 1 },
              replacementClaims: [{ claimId: phase6Ids.replacementClaim, expectedVersion: 1 }],
              reason: {
                code: "newer_evidence",
                rationale: "The later ratified outcome replaces the predecessor."
              },
              confidenceLowering: {
                confidence: "weak",
                reason: {
                  code: "residual_uncertainty",
                  rationale: "Residual timing uncertainty warrants a conservative confidence."
                }
              }
            }
          }
        ]);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects mismatched predecessor/successor subjects at the exact-command guard and rolls back every write",
    async () => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(
            executeExactSupersedeTransaction(
              appPool,
              "mismatched_lineage",
              relayServicePrincipalId
            ),
            {
              code: "P0001",
              message: "truth mutation requires its exact reserved command",
              constraint: null
            }
          )
        );
        expect(await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.supersedeCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    ["accepted value", "normalized_text = normalized_text || ' drift'"],
    ["accepted confidence", "confidence = 'confirmed'"],
    ["support-derived confidence", "strongest_supporting_confidence = 'confirmed'"],
    ["Fact coordinate", `subject_id = '${phase6Ids.otherSubject}'::uuid`],
    ["accepting actor", `accepted_by_user_id = '${devFixtures.userB}'::uuid`],
    ["acceptance time", "recorded_at = recorded_at + interval '1 second'"],
    ["access classification", "access_class = 'restricted'"]
  ])(
    "rejects a lifecycle-shaped update that also mutates the predecessor %s",
    async (_field, mutation) => {
      try {
        await resetPopulatedPhase6(ownerPool);
        const before = await exactLifecycleProtectedDigest(ownerPool);
        await expect(executeForbiddenAcceptedFactMutation(ownerPool, mutation)).rejects.toThrow(
          "accepted Fact lifecycle transition is not permitted"
        );
        expect(await exactLifecycleProtectedDigest(ownerPool)).toBe(before);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    [
      "Fact support association",
      `UPDATE truth.fact_claims
          SET created_at = created_at + interval '1 second'
        WHERE fact_id = '${adoptionIds.fact}'::uuid`,
      "truth lineage is immutable"
    ],
    [
      "verified evidence",
      `UPDATE truth.verified_evidence_spans
          SET source_excerpt = source_excerpt || ' drift'
        WHERE id = '${adoptionIds.evidence}'::uuid`,
      "truth lineage is immutable"
    ],
    [
      "accepted Claim value",
      `UPDATE truth.claims
          SET normalized_text = normalized_text || ' drift'
        WHERE id = '${adoptionIds.claim}'::uuid`,
      "claim transition is not permitted"
    ]
  ])(
    "preserves the predecessor %s immutability guard during Slice 4A",
    async (_surface, statement, diagnostic) => {
      try {
        await resetPopulatedPhase6(ownerPool);
        const before = await exactLifecycleProtectedDigest(ownerPool);
        await expect(executeRolledBackStatement(ownerPool, statement)).rejects.toThrow(diagnostic);
        expect(await exactLifecycleProtectedDigest(ownerPool)).toBe(before);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    [
      "reduced-cardinality predecessor FK",
      `ALTER TABLE truth.fact_lifecycle_events
         DROP CONSTRAINT fact_lifecycle_events_predecessor_fkey;
       ALTER TABLE truth.fact_lifecycle_events
         ADD CONSTRAINT fact_lifecycle_events_predecessor_fkey
         FOREIGN KEY (predecessor_fact_id)
         REFERENCES truth.accepted_facts(id)
         ON UPDATE RESTRICT ON DELETE RESTRICT
         DEFERRABLE INITIALLY DEFERRED`,
      /B2 Slice 1 exact truth constraint inventory drifted/
    ],
    [
      "wrong predecessor FK action",
      `ALTER TABLE truth.fact_lifecycle_events
         DROP CONSTRAINT fact_lifecycle_events_predecessor_fkey;
       ALTER TABLE truth.fact_lifecycle_events
         ADD CONSTRAINT fact_lifecycle_events_predecessor_fkey
         FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_fact_id)
         REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id)
         MATCH FULL ON UPDATE RESTRICT ON DELETE CASCADE
         DEFERRABLE INITIALLY DEFERRED`,
      /B2 Slice 1 exact truth constraint inventory drifted/
    ],
    [
      "wrong predecessor FK deferrability",
      `ALTER TABLE truth.fact_lifecycle_events
         DROP CONSTRAINT fact_lifecycle_events_predecessor_fkey;
       ALTER TABLE truth.fact_lifecycle_events
         ADD CONSTRAINT fact_lifecycle_events_predecessor_fkey
         FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_fact_id)
         REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id)
         MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT NOT DEFERRABLE`,
      /B2 Slice 1 exact truth constraint inventory drifted/
    ],
    [
      "wrong lifecycle transition trigger timing",
      `DROP TRIGGER accepted_facts_lifecycle_guard ON truth.accepted_facts;
       CREATE TRIGGER accepted_facts_lifecycle_guard
         AFTER UPDATE ON truth.accepted_facts
         FOR EACH ROW EXECUTE FUNCTION truth.enforce_fact_lifecycle_transition()`,
      /B2 Slice 1 truth trigger inventory drifted/
    ],
    [
      "wrong lifecycle transition trigger event",
      `DROP TRIGGER accepted_facts_lifecycle_guard ON truth.accepted_facts;
       CREATE TRIGGER accepted_facts_lifecycle_guard
         BEFORE INSERT ON truth.accepted_facts
         FOR EACH ROW EXECUTE FUNCTION truth.enforce_fact_lifecycle_transition()`,
      /B2 Slice 1 truth trigger inventory drifted/
    ],
    [
      "UPDATE-only lifecycle event immutability",
      `DROP TRIGGER fact_lifecycle_immutable ON truth.fact_lifecycle_events;
       CREATE TRIGGER fact_lifecycle_immutable
         BEFORE UPDATE ON truth.fact_lifecycle_events
         FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation()`,
      /B2 Slice 1 truth trigger inventory drifted/
    ],
    [
      "OR-true lifecycle SELECT escape",
      `DROP POLICY fact_lifecycle_select ON truth.fact_lifecycle_events;
       CREATE POLICY fact_lifecycle_select ON truth.fact_lifecycle_events
         FOR SELECT TO throughline_app
         USING (${exactLifecycleScope} OR true)`,
      /B2 Slice 1 truth policy inventory drifted/
    ],
    [
      "broad accepted Fact table mutation privileges",
      `GRANT UPDATE, DELETE, TRUNCATE ON truth.accepted_facts TO throughline_app`,
      /truth table authority drifted/
    ],
    [
      "missing lifecycle function",
      `DROP FUNCTION truth.reject_statement_mutation() CASCADE`,
      /truth function inventory drifted/
    ],
    [
      "extra lifecycle function",
      `CREATE FUNCTION truth.unexpected_fact_lifecycle_escape()
         RETURNS trigger LANGUAGE plpgsql
         SET search_path = pg_catalog
         AS $function$ BEGIN RETURN NEW; END $function$`,
      /truth function inventory drifted/
    ],
    [
      "semantically weakened lifecycle function body",
      `CREATE OR REPLACE FUNCTION truth.enforce_fact_lifecycle_transition()
         RETURNS trigger LANGUAGE plpgsql
         SET search_path = pg_catalog
         AS $function$ BEGIN RETURN NEW; END $function$`,
      /truth function execution shape or source drifted/
    ],
    [
      "SECURITY DEFINER lifecycle function",
      `ALTER FUNCTION truth.require_fact_lifecycle_command() SECURITY DEFINER`,
      /truth function execution shape or source drifted/
    ],
    [
      "wrong lifecycle function owner",
      `ALTER FUNCTION truth.require_fact_lifecycle_event()
         OWNER TO throughline_b1_0_integrity`,
      /truth function execution shape or source drifted/
    ],
    [
      "wrong lifecycle function search_path",
      `ALTER FUNCTION truth.validate_fact_lifecycle_event()
         SET search_path = truth, pg_catalog`,
      /truth function execution shape or source drifted/
    ],
    [
      "lifecycle function app EXECUTE grant",
      `GRANT EXECUTE ON FUNCTION truth.reject_statement_mutation() TO throughline_app`,
      /truth function EXECUTE grants drifted/
    ],
    [
      "phase-6 safe-request constraint drift",
      `ALTER TABLE ops.domain_command_records
         DROP CONSTRAINT domain_command_records_b2_safe_request_check;
       ALTER TABLE ops.domain_command_records
         ADD CONSTRAINT domain_command_records_b2_safe_request_check
         CHECK (safe_request IS NULL OR safe_request IS NOT NULL)`,
      /Installed B1 catalog does not match exact domain command constraint inventory/
    ],
    [
      "phase-6 deferred command-trigger drift",
      `DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
         ON ops.domain_command_records;
       CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
         AFTER INSERT OR UPDATE ON ops.domain_command_records
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW
         WHEN (NEW.command_kind IN (
           'claim.create.v1','initiative.primary_objective.withdraw.v1',
           'initiative.primary_objective.rework.v1','fact.accept.v1',
           'fact.supersede.v1'
         ))
         EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity()`,
      /Installed B1 catalog does not match exact domain command user-trigger inventory/
    ],
    [
      "missing lifecycle integrity SELECT policy",
      `DROP POLICY fact_lifecycle_integrity_select
         ON truth.fact_lifecycle_events`,
      /Installed B1 catalog does not match B1 integrity policy capability boundary/
    ],
    [
      "missing lifecycle integrity SELECT ACL",
      `REVOKE SELECT ON truth.fact_lifecycle_events
         FROM throughline_b1_0_integrity`,
      /Installed predecessor ACL authority does not match the exact normalized contract/
    ]
  ])(
    "rejects phase-6 catalog drift: %s",
    async (_label, mutation, diagnostic) => {
      await expectPhase6CatalogContractRejected(mutation, diagnostic);
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects a throughline_app privilege-bearing role membership escape",
    async () => {
      try {
        await resetToLatest();
        await applyMigrations(ownerPool);
        await ownerPool.query("GRANT throughline_b1_0_integrity TO throughline_app");
        await expect(applyMigrations(ownerPool)).rejects.toThrow(
          "Protected B1 roles have an inherited capability path"
        );
      } finally {
        await ownerPool.query("REVOKE throughline_b1_0_integrity FROM throughline_app");
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects a throughline_app BYPASSRLS escape",
    async () => {
      try {
        await resetToLatest();
        await applyMigrations(ownerPool);
        await ownerPool.query("ALTER ROLE throughline_app BYPASSRLS");
        await expect(applyMigrations(ownerPool)).rejects.toThrow(
          "Installed B1 catalog does not match protected B1 role attributes"
        );
      } finally {
        await restoreProductionAppRole();
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "upgrades an exactly journaled populated 0011 database without rewriting Fact evidence or support",
    async () => {
      try {
        await resetPopulatedExact0011(ownerPool);
        const before = await exactLifecycleProtectedDigest(ownerPool);
        const predecessorJournal = await ownerPool.query<{ id: string; checksum: string }>(
          "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
        );
        expect(predecessorJournal.rows.map(({ id }) => id)).toEqual(postSlice3MigrationIds);

        await expect(applyMigrations(ownerPool)).resolves.toEqual({
          applied: ["0012_b2_fact_lifecycle.sql"],
          skipped: [...postSlice3MigrationIds]
        });
        expect(await exactLifecycleProtectedDigest(ownerPool)).toBe(before);
        const preservedJournal = await ownerPool.query<{ id: string; checksum: string }>(
          "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id LIMIT 11"
        );
        expect(preservedJournal.rows).toEqual(predecessorJournal.rows);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "fails before SQL for installed-but-unjournaled 0012 state and preserves catalog and data",
    async () => {
      try {
        await resetPopulatedExact0011(ownerPool);
        await ownerPool.query("CREATE TABLE truth.fact_lifecycle_events (id uuid PRIMARY KEY)");
        const before = await exactPhase6FailureSnapshot(ownerPool);
        await expect(applyMigrations(ownerPool)).rejects.toThrow(
          /B2 migration state already exists without journal row for 0012_b2_fact_lifecycle\.sql/
        );
        expect(await exactPhase6FailureSnapshot(ownerPool)).toBe(before);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "fails closed when an installed 0012 catalog loses its final journal row",
    async () => {
      try {
        await resetPopulatedExact0011(ownerPool);
        await applyMigrations(ownerPool);
        await ownerPool.query(
          "DELETE FROM throughline_migrations.journal WHERE id = '0012_b2_fact_lifecycle.sql'"
        );
        const before = await exactPhase6FailureSnapshot(ownerPool);
        await expect(applyMigrations(ownerPool)).rejects.toThrow(
          /B2 migration state already exists without journal row for 0012_b2_fact_lifecycle\.sql/
        );
        expect(await exactPhase6FailureSnapshot(ownerPool)).toBe(before);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "enforces exact transaction-local Space RLS for lifecycle rows through the restricted app role",
    async () => {
      try {
        await resetPopulatedPhase6(ownerPool);
        await insertLifecycleVisibilityFixture(ownerPool);
        await ownerPool.query("ALTER TABLE truth.fact_lifecycle_events DISABLE TRIGGER USER");
        await withTestAppPool(async (pool) => {
          const client = await pool.connect();
          const setLocalScope = async (workspaceId: string, spaceId: string) => {
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [
              adoptionIds.tenant
            ]);
            await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
            await client.query("SELECT set_config('app.space_id', $1, true)", [spaceId]);
            await client.query("SELECT set_config('app.user_id', $1, true)", [adoptionIds.user]);
            await client.query("SELECT set_config('app.membership_id', $1, true)", [
              adoptionIds.membership
            ]);
            await client.query("SELECT set_config('app.policy_version', $1, true)", ["default-v1"]);
            await client.query("SELECT set_config('app.data_class_ceiling', 'confidential', true)");
          };
          const visible = () =>
            client.query<{ id: string }>(
              "SELECT id FROM truth.fact_lifecycle_events WHERE id = $1",
              [phase6Ids.lifecycle]
            );
          try {
            await client.query("BEGIN");
            await setLocalScope(adoptionIds.workspace, adoptionIds.space);
            expect((await visible()).rows).toEqual([{ id: phase6Ids.lifecycle }]);
            await client.query("COMMIT");

            expect((await visible()).rows).toEqual([]);

            await client.query("BEGIN");
            await setLocalScope(adoptionIds.workspace, devFixtures.restrictedSpaceA);
            expect((await visible()).rows).toEqual([]);
            await expect(
              client.query(
                `INSERT INTO truth.fact_lifecycle_events (
                   id, tenant_id, workspace_id, space_id, predecessor_fact_id,
                   successor_fact_id, transition_kind, from_status, to_status,
                   reason_code, reason_rationale, authority_basis, policy_version,
                   acted_by_user_id, acted_by_membership_id, causation_command_id,
                   recorded_at, version
                 ) VALUES (
                   $1,$2,$3,$4,$5,NULL,'revoke','current','revoked',
                   'no_longer_true','Cross-Space attempt','activity_owner','default-v1',
                   $6,$7,$8,transaction_timestamp(),1
                 )`,
                [
                  phase6Ids.crossSpaceLifecycle,
                  adoptionIds.tenant,
                  adoptionIds.workspace,
                  adoptionIds.space,
                  adoptionIds.fact,
                  adoptionIds.user,
                  adoptionIds.membership,
                  adoptionIds.factCommand
                ]
              )
            ).rejects.toThrow(/row-level security policy/);
            await client.query("ROLLBACK");

            await client.query("BEGIN");
            await setLocalScope(devFixtures.workspaceB, adoptionIds.space);
            expect((await visible()).rows).toEqual([]);
            await client.query("ROLLBACK");

            await client.query("BEGIN");
            expect((await visible()).rows).toEqual([]);
            await client.query("ROLLBACK");
          } finally {
            client.release();
          }
        });
        await ownerPool.query("ALTER TABLE truth.fact_lifecycle_events ENABLE TRIGGER USER");
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "classifies mixed-access supersession by both predecessor and successor monotonically",
    async () => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        await withTestAppPool((appPool) =>
          executeExactSupersedeTransaction(
            appPool,
            "valid_confidential_successor",
            relayServicePrincipalId
          )
        );
        await withTestAppPool(async (pool) => {
          const client = await pool.connect();
          const readAtCeiling = async (ceiling: "workspace" | "confidential", spaceId: string) => {
            await client.query("BEGIN");
            try {
              for (const [setting, value] of [
                ["app.tenant_id", adoptionIds.tenant],
                ["app.workspace_id", adoptionIds.workspace],
                ["app.space_id", spaceId],
                ["app.user_id", adoptionIds.user],
                ["app.membership_id", adoptionIds.membership],
                ["app.policy_version", "default-v1"],
                ["app.data_class_ceiling", ceiling]
              ] as const) {
                await client.query("SELECT set_config($1, $2, true)", [setting, value]);
              }
              const identity = await client.query<{
                current_user: string;
                rolbypassrls: boolean;
              }>(
                `SELECT current_user, rolbypassrls
                   FROM pg_roles
                  WHERE rolname = current_user
                    AND current_user = 'throughline_app'
                    AND NOT rolbypassrls`
              );
              expect(identity.rows).toEqual([
                { current_user: "throughline_app", rolbypassrls: false }
              ]);
              const visible = await client.query<{
                predecessor: unknown;
                successor: unknown;
                lifecycle: unknown;
              }>(
                `SELECT
                   (SELECT jsonb_build_object('id', fact.id, 'accessClass', fact.access_class)
                      FROM truth.accepted_facts fact WHERE fact.id = $1) AS predecessor,
                   (SELECT jsonb_build_object('id', fact.id, 'accessClass', fact.access_class)
                      FROM truth.accepted_facts fact WHERE fact.id = $2) AS successor,
                   (SELECT jsonb_build_object(
                      'id', lifecycle.id,
                      'replacementFactId', lifecycle.successor_fact_id,
                      'reasonCode', lifecycle.reason_code,
                      'reasonRationale', lifecycle.reason_rationale,
                      'actorUserId', lifecycle.acted_by_user_id,
                      'actorMembershipId', lifecycle.acted_by_membership_id
                    ) FROM truth.fact_lifecycle_events lifecycle
                     WHERE lifecycle.id = $3) AS lifecycle`,
                [adoptionIds.fact, adoptionIds.successor, phase6Ids.supersedeLifecycle]
              );
              return visible.rows;
            } finally {
              await client.query("ROLLBACK");
            }
          };

          try {
            expect(await readAtCeiling("workspace", adoptionIds.space)).toEqual([
              {
                predecessor: { id: adoptionIds.fact, accessClass: "workspace" },
                successor: null,
                lifecycle: null
              }
            ]);
            expect(await readAtCeiling("confidential", adoptionIds.space)).toEqual([
              {
                predecessor: { id: adoptionIds.fact, accessClass: "workspace" },
                successor: { id: adoptionIds.successor, accessClass: "confidential" },
                lifecycle: {
                  id: phase6Ids.supersedeLifecycle,
                  replacementFactId: adoptionIds.successor,
                  reasonCode: "newer_evidence",
                  reasonRationale: "The later ratified outcome replaces the predecessor.",
                  actorUserId: adoptionIds.user,
                  actorMembershipId: adoptionIds.membership
                }
              }
            ]);
            expect(await readAtCeiling("confidential", devFixtures.restrictedSpaceA)).toEqual([
              {
                predecessor: { id: adoptionIds.fact, accessClass: "workspace" },
                successor: { id: adoptionIds.successor, accessClass: "confidential" },
                lifecycle: null
              }
            ]);
          } finally {
            client.release();
          }
        });
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    [
      "UPDATE truth.fact_lifecycle_events SET reason_rationale = reason_rationale WHERE id = $1",
      "truth lineage is immutable"
    ],
    ["DELETE FROM truth.fact_lifecycle_events WHERE id = $1", "truth lineage is immutable"],
    ["TRUNCATE truth.fact_lifecycle_events", "truth statement mutation is not permitted"]
  ])(
    "blocks lifecycle event mutation at the table surface: %s",
    async (statement, diagnostic) => {
      try {
        await resetPopulatedPhase6(ownerPool);
        await insertLifecycleVisibilityFixture(ownerPool);
        const before = await exactPhase6AtomicDigest(ownerPool);
        const client = await ownerPool.connect();
        try {
          await client.query("BEGIN");
          await expect(
            client.query(statement, statement.startsWith("TRUNCATE") ? [] : [phase6Ids.lifecycle])
          ).rejects.toThrow(diagnostic);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        expect(await exactPhase6AtomicDigest(ownerPool)).toBe(before);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "accepts only exact ordinary lifecycle request, response, audit, and outbox shapes",
    async () => {
      try {
        await resetPopulatedPhase6(ownerPool);
        const revokeRequest = {
          factId: adoptionIds.fact,
          expectedFactVersion: 1,
          reason: {
            code: "no_longer_true",
            rationale: "The accepted outcome no longer reflects current reality."
          }
        };
        const revokeResponse = { factId: adoptionIds.fact, status: "revoked", version: 2 };
        const revokeDetail = {
          factId: adoptionIds.fact,
          factVersion: 2,
          reasonCode: "no_longer_true",
          status: "revoked"
        };
        const supersedeRequest = {
          factId: adoptionIds.fact,
          expectedFactVersion: 1,
          subject: { type: "activity", id: adoptionIds.subject, expectedVersion: 1 },
          replacementClaims: [{ claimId: adoptionIds.claim, expectedVersion: 1 }],
          reason: {
            code: "newer_evidence",
            rationale: "The later ratified outcome replaces the predecessor."
          }
        };
        const supersedeResponse = {
          factId: adoptionIds.fact,
          version: 2,
          status: "superseded",
          replacementFactId: adoptionIds.successor,
          replacementFactVersion: 1,
          replacementFactStatus: "current"
        };
        const supersedeDetail = {
          factId: adoptionIds.fact,
          factVersion: 2,
          reasonCode: "newer_evidence",
          replacementFactId: adoptionIds.successor,
          replacementFactVersion: 1,
          status: "superseded"
        };
        const shape = await ownerPool.query<{
          revoke_request: boolean;
          revoke_request_extra: boolean;
          revoke_request_string_version: boolean;
          revoke_request_numeric_rationale: boolean;
          revoke_request_null_fact_id: boolean;
          supersede_request: boolean;
          supersede_request_extra: boolean;
          supersede_request_string_fact_version: boolean;
          supersede_request_string_subject_version: boolean;
          supersede_request_numeric_rationale: boolean;
          supersede_request_null_subject_id: boolean;
          revoke_reserved: boolean;
          supersede_reserved: boolean;
          revoke_completed: boolean;
          revoke_response_extra: boolean;
          revoke_response_string_version: boolean;
          revoke_response_null_status: boolean;
          supersede_completed: boolean;
          supersede_response_extra: boolean;
          supersede_response_string_version: boolean;
          supersede_response_string_replacement_version: boolean;
          supersede_response_null_replacement_id: boolean;
          supersede_response_other_valid_successor: boolean;
          revoke_audit: boolean;
          revoke_audit_raw: boolean;
          revoke_audit_string_version: boolean;
          supersede_audit: boolean;
          supersede_audit_raw: boolean;
          supersede_audit_string_version: boolean;
          revoke_outbox: boolean;
          revoke_outbox_raw: boolean;
          revoke_outbox_string_version: boolean;
          supersede_outbox: boolean;
          supersede_outbox_raw: boolean;
          supersede_outbox_string_version: boolean;
        }>(
          `SELECT
             ops.b2_slice1_safe_request_valid('fact.revoke.v1', $1::jsonb)
               AS revoke_request,
             ops.b2_slice1_safe_request_valid(
               'fact.revoke.v1', $1::jsonb || '{"arbitraryText":"escape"}'::jsonb
             ) AS revoke_request_extra,
             ops.b2_slice1_safe_request_valid(
               'fact.revoke.v1', jsonb_set($1::jsonb,'{expectedFactVersion}',to_jsonb('1'::text))
             ) AS revoke_request_string_version,
             ops.b2_slice1_safe_request_valid(
               'fact.revoke.v1', jsonb_set($1::jsonb,'{reason,rationale}',to_jsonb(7))
             ) AS revoke_request_numeric_rationale,
             ops.b2_slice1_safe_request_valid(
               'fact.revoke.v1', jsonb_set($1::jsonb,'{factId}','null'::jsonb)
             ) AS revoke_request_null_fact_id,
             ops.b2_slice1_safe_request_valid('fact.supersede.v1', $2::jsonb)
               AS supersede_request,
             ops.b2_slice1_safe_request_valid(
               'fact.supersede.v1', $2::jsonb || '{"emergency":true}'::jsonb
             ) AS supersede_request_extra,
             ops.b2_slice1_safe_request_valid(
               'fact.supersede.v1',
               jsonb_set($2::jsonb,'{expectedFactVersion}',to_jsonb('1'::text))
             ) AS supersede_request_string_fact_version,
             ops.b2_slice1_safe_request_valid(
               'fact.supersede.v1',
               jsonb_set($2::jsonb,'{subject,expectedVersion}',to_jsonb('1'::text))
             ) AS supersede_request_string_subject_version,
             ops.b2_slice1_safe_request_valid(
               'fact.supersede.v1', jsonb_set($2::jsonb,'{reason,rationale}',to_jsonb(7))
             ) AS supersede_request_numeric_rationale,
             ops.b2_slice1_safe_request_valid(
               'fact.supersede.v1', jsonb_set($2::jsonb,'{subject,id}','null'::jsonb)
             ) AS supersede_request_null_subject_id,
             ops.product_command_record_valid(
               'fact.revoke.v1',1,'reserved',NULL,NULL,NULL
             ) AS revoke_reserved,
             ops.product_command_record_valid(
               'fact.supersede.v1',1,'reserved',NULL,NULL,NULL
             ) AS supersede_reserved,
             ops.product_command_record_valid(
               'fact.revoke.v1',1,'completed','accepted_fact',$3,$4::jsonb
             ) AS revoke_completed,
             ops.product_command_record_valid(
               'fact.revoke.v1',1,'completed','accepted_fact',$3,
               $4::jsonb || '{"reasonRationale":"raw"}'::jsonb
             ) AS revoke_response_extra,
             ops.product_command_record_valid(
               'fact.revoke.v1',1,'completed','accepted_fact',$3,
               jsonb_set($4::jsonb,'{version}',to_jsonb('2'::text))
             ) AS revoke_response_string_version,
             ops.product_command_record_valid(
               'fact.revoke.v1',1,'completed','accepted_fact',$3,
               jsonb_set($4::jsonb,'{status}','null'::jsonb)
             ) AS revoke_response_null_status,
             ops.product_command_record_valid(
               'fact.supersede.v1',1,'completed','accepted_fact',$3,$5::jsonb
             ) AS supersede_completed,
             ops.product_command_record_valid(
               'fact.supersede.v1',1,'completed','accepted_fact',$3,
               $5::jsonb || '{"reasonRationale":"raw user rationale"}'::jsonb
             ) AS supersede_response_extra,
             ops.product_command_record_valid(
               'fact.supersede.v1',1,'completed','accepted_fact',$3,
               jsonb_set($5::jsonb,'{version}',to_jsonb('2'::text))
             ) AS supersede_response_string_version,
             ops.product_command_record_valid(
               'fact.supersede.v1',1,'completed','accepted_fact',$3,
               jsonb_set($5::jsonb,'{replacementFactVersion}',to_jsonb('1'::text))
             ) AS supersede_response_string_replacement_version,
             ops.product_command_record_valid(
               'fact.supersede.v1',1,'completed','accepted_fact',$3,
               jsonb_set($5::jsonb,'{replacementFactId}','null'::jsonb)
             ) AS supersede_response_null_replacement_id,
             ops.product_command_record_valid(
               'fact.supersede.v1',1,'completed','accepted_fact',$3,
               jsonb_set($5::jsonb,'{replacementFactId}',to_jsonb($8::text))
             ) AS supersede_response_other_valid_successor,
             ops.b2_slice1_audit_detail_valid(
               'fact.revoke','accepted_fact',1,$3,$6::jsonb
             ) AS revoke_audit,
             ops.b2_slice1_audit_detail_valid(
               'fact.revoke','accepted_fact',1,$3,
               $6::jsonb || '{"reasonRationale":"raw objective/source excerpt"}'::jsonb
             ) AS revoke_audit_raw,
             ops.b2_slice1_audit_detail_valid(
               'fact.revoke','accepted_fact',1,$3,
               jsonb_set($6::jsonb,'{factVersion}',to_jsonb('2'::text))
             ) AS revoke_audit_string_version,
             ops.b2_slice1_audit_detail_valid(
               'fact.supersede','accepted_fact',1,$3,$7::jsonb
             ) AS supersede_audit,
             ops.b2_slice1_audit_detail_valid(
               'fact.supersede','accepted_fact',1,$3,
               $7::jsonb || '{"sourceExcerpt":"raw objective/source rationale"}'::jsonb
             ) AS supersede_audit_raw,
             ops.b2_slice1_audit_detail_valid(
               'fact.supersede','accepted_fact',1,$3,
               jsonb_set($7::jsonb,'{replacementFactVersion}',to_jsonb('1'::text))
             ) AS supersede_audit_string_version,
             ops.b2_slice1_event_payload_valid(
               'fact.revoked',1,$3,$6::jsonb
             ) AS revoke_outbox,
             ops.b2_slice1_event_payload_valid(
               'fact.revoked',1,$3,
               $6::jsonb || '{"sourceText":"raw"}'::jsonb
             ) AS revoke_outbox_raw,
             ops.b2_slice1_event_payload_valid(
               'fact.revoked',1,$3,
               jsonb_set($6::jsonb,'{factVersion}',to_jsonb('2'::text))
             ) AS revoke_outbox_string_version,
             ops.b2_slice1_event_payload_valid(
               'fact.superseded',1,$3,$7::jsonb
             ) AS supersede_outbox,
             ops.b2_slice1_event_payload_valid(
               'fact.superseded',1,$3,
               $7::jsonb || '{"sourceText":"raw objective/source rationale"}'::jsonb
             ) AS supersede_outbox_raw,
             ops.b2_slice1_event_payload_valid(
               'fact.superseded',1,$3,
               jsonb_set($7::jsonb,'{factVersion}',to_jsonb('2'::text))
             ) AS supersede_outbox_string_version`,
          [
            JSON.stringify(revokeRequest),
            JSON.stringify(supersedeRequest),
            adoptionIds.fact,
            JSON.stringify(revokeResponse),
            JSON.stringify(supersedeResponse),
            JSON.stringify(revokeDetail),
            JSON.stringify(supersedeDetail),
            phase6Ids.mismatchedResponseSuccessor
          ]
        );
        expect(shape.rows).toEqual([
          {
            revoke_request: true,
            revoke_request_extra: false,
            revoke_request_string_version: false,
            revoke_request_numeric_rationale: false,
            revoke_request_null_fact_id: false,
            supersede_request: true,
            supersede_request_extra: false,
            supersede_request_string_fact_version: false,
            supersede_request_string_subject_version: false,
            supersede_request_numeric_rationale: false,
            supersede_request_null_subject_id: false,
            revoke_reserved: true,
            supersede_reserved: true,
            revoke_completed: true,
            revoke_response_extra: false,
            revoke_response_string_version: false,
            revoke_response_null_status: false,
            supersede_completed: true,
            supersede_response_extra: false,
            supersede_response_string_version: false,
            supersede_response_string_replacement_version: false,
            supersede_response_null_replacement_id: false,
            supersede_response_other_valid_successor: true,
            revoke_audit: true,
            revoke_audit_raw: false,
            revoke_audit_string_version: false,
            supersede_audit: true,
            supersede_audit_raw: false,
            supersede_audit_string_version: false,
            revoke_outbox: true,
            revoke_outbox_raw: false,
            revoke_outbox_string_version: false,
            supersede_outbox: true,
            supersede_outbox_raw: false,
            supersede_outbox_string_version: false
          }
        ]);

        const excluded = await ownerPool.query<{
          vocabulary: string;
          value: string;
          accepted: boolean;
        }>(
          `SELECT 'command'::text AS vocabulary, value,
                  ops.b2_slice1_safe_request_valid(value, $1::jsonb) OR
                  ops.product_command_record_valid(value,1,'reserved',NULL,NULL,NULL)
                    AS accepted
             FROM unnest($2::text[]) value
            UNION ALL
           SELECT 'audit', value,
                  ops.b2_slice1_audit_detail_valid(
                    value,'accepted_fact',1,$3,$4::jsonb
                  )
             FROM unnest($5::text[]) value
            UNION ALL
           SELECT 'outbox', value,
                  ops.b2_slice1_event_payload_valid(value,1,$3,$4::jsonb)
             FROM unnest($6::text[]) value
            ORDER BY vocabulary, value`,
          [
            JSON.stringify(revokeRequest),
            [
              "fact.contest.v1",
              "fact.contest.v2",
              "fact.uphold.v1",
              "fact.emergency_contest.v1",
              "fact.emergency_revoke.v1",
              "fact.reconcile_source.v1",
              "fact.source_reconcile.v1",
              "derived_view.regenerate.v1",
              "derived_views.regenerate.v2",
              "fact.revoke.v2",
              "fact.supersede.v2"
            ],
            adoptionIds.fact,
            JSON.stringify(revokeDetail),
            [
              "fact.contest",
              "fact.uphold",
              "fact.emergency_revoke",
              "fact.source_reconcile",
              "derived_view.regenerate"
            ],
            [
              "fact.contested",
              "fact.upheld",
              "fact.emergency_revoked",
              "fact.source_reconciled",
              "derived_view.regenerated"
            ]
          ]
        );
        expect(excluded.rows.length).toBe(21);
        expect(excluded.rows.every(({ accepted }) => !accepted)).toBe(true);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "matches parseSortedClaimRefs cardinality, key, uniqueness, sort, and version semantics",
    async () => {
      try {
        await resetPopulatedPhase6(ownerPool);
        const requestWith = (replacementClaims: Array<Record<string, unknown>>) => ({
          factId: adoptionIds.fact,
          expectedFactVersion: 1,
          subject: { type: "activity", id: adoptionIds.subject, expectedVersion: 1 },
          replacementClaims,
          reason: {
            code: "newer_evidence",
            rationale: "The later ratified outcome replaces the predecessor."
          }
        });
        const first = { claimId: phase6Ids.replacementClaim, expectedVersion: 1 };
        const second = { claimId: phase6Ids.secondReplacementClaim, expectedVersion: 2 };
        const parserCases = {
          duplicate_ids: requestWith([first, first]),
          empty: requestWith([]),
          extra_claim_key: requestWith([{ ...first, arbitraryText: "escape" }]),
          over_100: requestWith(
            Array.from({ length: 101 }, (_, index) => ({
              claimId: `0190a000-0000-7000-8000-${(1000 + index).toString(16).padStart(12, "0")}`,
              expectedVersion: 1
            }))
          ),
          string_version: requestWith([{ ...first, expectedVersion: "1" }]),
          unsorted: requestWith([second, first]),
          uppercase_id: requestWith([{ ...first, claimId: first.claimId.toUpperCase() }]),
          valid: requestWith([first, second]),
          zero_version: requestWith([{ ...first, expectedVersion: 0 }])
        };

        const rows = await withTestAppPool((appPool) =>
          appPool.query<{ label: string; valid: boolean }>(
            `SELECT request.label,
                    ops.b2_slice1_safe_request_valid(
                      'fact.supersede.v1', request.request_value
                    ) AS valid
               FROM jsonb_each($1::jsonb) request(label, request_value)
              ORDER BY request.label`,
            [JSON.stringify(parserCases)]
          )
        );
        expect(rows.rows).toEqual([
          { label: "duplicate_ids", valid: false },
          { label: "empty", valid: false },
          { label: "extra_claim_key", valid: false },
          { label: "over_100", valid: false },
          { label: "string_version", valid: false },
          { label: "unsorted", valid: false },
          { label: "uppercase_id", valid: false },
          { label: "valid", valid: true },
          { label: "zero_version", valid: false }
        ]);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "matches the canonical confidenceLowering parser shape and fails malformed requests closed",
    async () => {
      try {
        await resetPopulatedPhase6(ownerPool);
        const baseRequest = {
          factId: adoptionIds.fact,
          expectedFactVersion: 1,
          subject: { type: "activity", id: adoptionIds.subject, expectedVersion: 1 },
          replacementClaims: [{ claimId: phase6Ids.replacementClaim, expectedVersion: 1 }],
          reason: {
            code: "newer_evidence",
            rationale: "The later ratified outcome replaces the predecessor."
          }
        };
        const validLowering = {
          confidence: "weak",
          reason: {
            code: "residual_uncertainty",
            rationale: "Residual timing uncertainty warrants a conservative confidence."
          }
        };
        const parserCases = {
          blank_rationale: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { ...validLowering.reason, rationale: "" }
            }
          },
          conflict_out_of_scope: {
            ...baseRequest,
            conflict: { conflictId: phase6Ids.lifecycle, expectedVersion: 1 }
          },
          explicit_null: { ...baseRequest, confidenceLowering: null },
          extra_lowering_key: {
            ...baseRequest,
            confidenceLowering: { ...validLowering, arbitraryText: "escape" }
          },
          extra_reason_key: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { ...validLowering.reason, arbitraryText: "escape" }
            }
          },
          extra_top_level: { ...baseRequest, confidenceLowering: validLowering, emergency: true },
          malformed: { ...baseRequest, confidenceLowering: [validLowering] },
          missing_confidence: {
            ...baseRequest,
            confidenceLowering: { reason: validLowering.reason }
          },
          missing_rationale: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { code: validLowering.reason.code }
            }
          },
          missing_reason: {
            ...baseRequest,
            confidenceLowering: { confidence: validLowering.confidence }
          },
          missing_reason_code: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { rationale: validLowering.reason.rationale }
            }
          },
          non_nfc_rationale: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { ...validLowering.reason, rationale: "Cafe\u0301 uncertainty" }
            }
          },
          numeric_rationale: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { ...validLowering.reason, rationale: 17 }
            }
          },
          overlong_rationale: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { ...validLowering.reason, rationale: "x".repeat(2001) }
            }
          },
          unknown_confidence: {
            ...baseRequest,
            confidenceLowering: { ...validLowering, confidence: "certain" }
          },
          unknown_reason: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { ...validLowering.reason, code: "manager_preference" }
            }
          },
          untrimmed_rationale: {
            ...baseRequest,
            confidenceLowering: {
              ...validLowering,
              reason: { ...validLowering.reason, rationale: " leading whitespace" }
            }
          },
          valid: { ...baseRequest, confidenceLowering: validLowering }
        };
        const rows = await withTestAppPool((appPool) =>
          appPool.query<{ label: string; valid: boolean }>(
            `SELECT request.label,
                    ops.b2_slice1_safe_request_valid(
                      'fact.supersede.v1', request.request_value
                    ) AS valid
               FROM jsonb_each($1::jsonb) request(label, request_value)
              ORDER BY request.label`,
            [JSON.stringify(parserCases)]
          )
        );
        expect(rows.rows).toEqual([
          { label: "blank_rationale", valid: false },
          { label: "conflict_out_of_scope", valid: false },
          { label: "explicit_null", valid: false },
          { label: "extra_lowering_key", valid: false },
          { label: "extra_reason_key", valid: false },
          { label: "extra_top_level", valid: false },
          { label: "malformed", valid: false },
          { label: "missing_confidence", valid: false },
          { label: "missing_rationale", valid: false },
          { label: "missing_reason", valid: false },
          { label: "missing_reason_code", valid: false },
          { label: "non_nfc_rationale", valid: false },
          { label: "numeric_rationale", valid: false },
          { label: "overlong_rationale", valid: false },
          { label: "unknown_confidence", valid: false },
          { label: "unknown_reason", valid: false },
          { label: "untrimmed_rationale", valid: false },
          { label: "valid", valid: true }
        ]);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    ["missing_lifecycle", "fact revoke result is incomplete"],
    ["missing_audit", "truth command requires exact audit and product outbox rows"],
    ["duplicate_audit", "truth command requires exact audit and product outbox rows"],
    ["missing_outbox", "truth command requires exact audit and product outbox rows"]
  ] as const)(
    "forces exact deferred revoke completeness and full rollback: %s",
    async (fault, message) => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(
            executeExactRevokeTransaction(appPool, fault, relayServicePrincipalId),
            { code: "P0001", message, constraint: null }
          )
        );
        expect(await exactPhase6RollbackDigest(ownerPool)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.revokeCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    ["mismatched_lifecycle", "Fact lifecycle event requires its exact reserved command"],
    ["missing_predecessor", "Fact lifecycle event requires its exact reserved command"],
    ["unexpected_successor", "Fact revocation cannot identify a successor"],
    ["mismatched_audit", "truth command requires exact audit and product outbox rows"],
    ["mismatched_outbox", "truth command requires exact audit and product outbox rows"]
  ] as const)(
    "asserts the exact revoke row-guard layer and full rollback: %s",
    async (fault, message) => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(
            executeExactRevokeTransaction(appPool, fault, relayServicePrincipalId),
            { code: "P0001", message, constraint: null }
          )
        );
        expect(await exactPhase6RollbackDigest(ownerPool)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.revokeCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    [
      "duplicate_lifecycle",
      "23505",
      'duplicate key value violates unique constraint "fact_lifecycle_events_predecessor_key"',
      "fact_lifecycle_events_predecessor_key"
    ],
    [
      "duplicate_outbox",
      "23505",
      'duplicate key value violates unique constraint "product_outbox_events_semantic_unique"',
      "product_outbox_events_semantic_unique"
    ]
  ] as const)(
    "classifies revoke storage uniqueness failure exactly: %s",
    async (fault, code, message, constraint) => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(
            executeExactRevokeTransaction(appPool, fault, relayServicePrincipalId),
            { code, message, constraint }
          )
        );
        expect(await exactPhase6RollbackDigest(ownerPool)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.revokeCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    ["missing_lifecycle", "fact supersede result is incomplete"],
    ["missing_audit", "truth command requires exact audit and product outbox rows"],
    ["duplicate_audit", "truth command requires exact audit and product outbox rows"],
    ["missing_outbox", "truth command requires exact audit and product outbox rows"],
    ["requested_support_omitted", "fact supersede support set does not match replacementClaims"]
  ] as const)(
    "forces exact deferred supersede completeness and full rollback: %s",
    async (fault, message) => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(
            executeExactSupersedeTransaction(appPool, fault, relayServicePrincipalId),
            { code: "P0001", message, constraint: null }
          )
        );
        expect(await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.supersedeCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    ["mismatched_lifecycle", "Fact lifecycle event requires its exact reserved command"],
    ["mismatched_audit", "truth command requires exact audit and product outbox rows"],
    ["mismatched_outbox", "truth command requires exact audit and product outbox rows"],
    ["stale_subject_version", "fact supersede subject version is stale"],
    ["stale_replacement_claim_version", "fact supersede replacement Claim version is stale"],
    [
      "unrequested_support_persisted",
      "fact supersede support set does not match replacementClaims"
    ],
    ["predecessor_support_appended", "fact support requires its exact reserved command"],
    ["mismatched_response_successor", "fact supersede response does not match successor"],
    ["lowering_requested_successor_omitted", "truth mutation requires its exact reserved command"],
    ["lowering_omitted_successor_lowered", "truth mutation requires its exact reserved command"],
    ["lowering_confidence_mismatched", "truth mutation requires its exact reserved command"],
    ["lowering_reason_code_mismatched", "truth mutation requires its exact reserved command"],
    ["lowering_rationale_mismatched", "truth mutation requires its exact reserved command"],
    ["requested_confidence_not_lower", "accepted fact support is invalid"],
    ["stored_strongest_mismatched", "accepted fact support is invalid"]
  ] as const)(
    "asserts exact supersede stale/support/row-guard diagnostics and full rollback: %s",
    async (fault, message) => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(
            executeExactSupersedeTransaction(appPool, fault, relayServicePrincipalId),
            { code: "P0001", message, constraint: null }
          )
        );
        expect(await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.supersedeCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE6_SUPERSEDE_ROLLBACK_TEST_TIMEOUT
  );

  it.each([
    [
      "duplicate_lifecycle",
      'duplicate key value violates unique constraint "fact_lifecycle_events_predecessor_key"',
      "fact_lifecycle_events_predecessor_key"
    ],
    [
      "duplicate_outbox",
      'duplicate key value violates unique constraint "product_outbox_events_semantic_unique"',
      "product_outbox_events_semantic_unique"
    ]
  ] as const)(
    "classifies supersede storage uniqueness failure exactly: %s",
    async (fault, message, constraint) => {
      try {
        const relayServicePrincipalId = await resetPopulatedPhase6(ownerPool);
        const before = await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand);
        await withTestAppPool((appPool) =>
          expectExactDatabaseFailure(
            executeExactSupersedeTransaction(appPool, fault, relayServicePrincipalId),
            { code: "23505", message, constraint }
          )
        );
        expect(await exactPhase6RollbackDigest(ownerPool, phase6Ids.supersedeCommand)).toBe(before);
        await expectNoPhase6CommandResidue(ownerPool, phase6Ids.supersedeCommand);
      } finally {
        await resetToLatest();
      }
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects a missing phase-5 objective recovery integrity policy",
    async () => {
      await expectPhase5CatalogContractRejected(
        `
        DROP POLICY objective_support_integrity_select
          ON truth.initiative_objective_support_attestations
      `,
        "Installed B1 catalog does not match B1 integrity policy capability boundary"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects an undeclared persistent truth table",
    async () => {
      await expectPhase5CatalogContractRejected(
        `CREATE TABLE truth.rogue_store (id bigint PRIMARY KEY);
         ALTER TABLE truth.rogue_store ENABLE ROW LEVEL SECURITY;
         ALTER TABLE truth.rogue_store FORCE ROW LEVEL SECURITY`,
        "B2 Slice 1 truth table inventory or forced RLS drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    [
      "wrong timing",
      `DROP TRIGGER objective_support_command_guard
         ON truth.initiative_objective_support_attestations;
       CREATE TRIGGER objective_support_command_guard
         AFTER INSERT ON truth.initiative_objective_support_attestations
         FOR EACH ROW EXECUTE FUNCTION
           truth.require_reserved_command('claim.create-or-rework.v1')`
    ],
    [
      "wrong command argument",
      `DROP TRIGGER verified_evidence_command_guard ON truth.verified_evidence_spans;
       CREATE TRIGGER verified_evidence_command_guard
         BEFORE INSERT ON truth.verified_evidence_spans
         FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('fact.accept.v1')`
    ]
  ])(
    "rejects a truth trigger with %s but unchanged identity fields",
    async (_label, mutation) => {
      await expectPhase5CatalogContractRejected(
        mutation,
        "B2 Slice 1 truth trigger inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects a permissive same-shape safe-request validator body",
    async () => {
      await expectPhase5CatalogContractRejected(
        `CREATE OR REPLACE FUNCTION ops.b2_slice1_safe_request_valid(
           command_kind_value text, request_value jsonb
         ) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT
         SET search_path = pg_catalog AS $permissive$
         BEGIN
           RETURN request_value::text LIKE '%predecessorClaimId%'
             OR request_value::text LIKE '%expectedPredecessorVersion%';
         END
         $permissive$;
         ALTER FUNCTION ops.b2_slice1_safe_request_valid(text,jsonb)
           OWNER TO throughline_b1_0_integrity;
         REVOKE ALL ON FUNCTION ops.b2_slice1_safe_request_valid(text,jsonb) FROM PUBLIC;
         GRANT EXECUTE ON FUNCTION ops.b2_slice1_safe_request_valid(text,jsonb)
           TO throughline_app`,
        "B2 Slice 1 command function ownership or execution shape drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects a legacy truth policy widened while retaining its scope expression",
    async () => {
      await expectPhase5CatalogContractRejected(
        `DROP POLICY claims_select ON truth.claims;
         CREATE POLICY claims_select ON truth.claims FOR SELECT TO throughline_app
         USING (((tenant_id = ops.current_tenant_id())
           AND (workspace_id = ops.current_workspace_id())
           AND access.can_read_space(space_id, access_class)) OR true)`,
        "B2 Slice 1 truth policy inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects an owner-rights rogue truth view and its app grant",
    async () => {
      await expectPhase5CatalogContractRejected(
        `CREATE VIEW truth.rogue_view AS SELECT id FROM truth.claims;
         GRANT SELECT ON truth.rogue_view TO throughline_app`,
        "B2 Slice 1 truth table inventory or forced RLS drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    [
      "weakened legacy CHECK",
      `ALTER TABLE truth.claims DROP CONSTRAINT claims_access_class_check;
       ALTER TABLE truth.claims ADD CONSTRAINT claims_access_class_check
         CHECK (access_class IS NOT NULL)`,
      "B2 Slice 1 exact truth constraint inventory drifted"
    ],
    [
      "unexpected legacy index",
      `CREATE INDEX claims_review_rogue_idx ON truth.claims (created_at)`,
      "B2 Slice 1 exact truth index inventory drifted"
    ]
  ])(
    "rejects %s",
    async (_label, mutation, diagnostic) => {
      await expectPhase5CatalogContractRejected(mutation, diagnostic);
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects a missing phase-5 objective recovery integrity ACL",
    async () => {
      await expectPhase5CatalogContractRejected(
        `
        REVOKE SELECT ON truth.initiative_objective_proposal_recoveries
          FROM throughline_b1_0_integrity
      `,
        "Installed predecessor ACL authority does not match the exact normalized contract"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects an extra permissive phase-5 truth policy",
    async () => {
      await expectPhase5CatalogContractRejected(
        `CREATE POLICY objective_recovery_extra ON truth.initiative_objective_proposal_recoveries
       FOR SELECT TO throughline_app USING (true)`,
        "Objective recovery RLS policy inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects an altered phase-5 app policy expression",
    async () => {
      await expectPhase5CatalogContractRejected(
        `DROP POLICY objective_recovery_select ON truth.initiative_objective_proposal_recoveries;
       CREATE POLICY objective_recovery_select ON truth.initiative_objective_proposal_recoveries
       FOR SELECT TO throughline_app USING (true)`,
        "Objective recovery exact RLS policy definitions drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects an app policy widened with an always-true disjunct",
    async () => {
      await expectPhase5CatalogContractRejected(
        `DROP POLICY objective_recovery_select ON truth.initiative_objective_proposal_recoveries;
       CREATE POLICY objective_recovery_select ON truth.initiative_objective_proposal_recoveries
       FOR SELECT TO throughline_app USING ((
         tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
         AND access.can_read_space(space_id, (SELECT claim.access_class FROM truth.claims claim
           WHERE claim.tenant_id = initiative_objective_proposal_recoveries.tenant_id
             AND claim.workspace_id = initiative_objective_proposal_recoveries.workspace_id
             AND claim.id = initiative_objective_proposal_recoveries.predecessor_claim_id))
       ) OR true)`,
        "Objective recovery exact RLS policy definitions drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects representative predecessor phase-4 drift while phase 5 is installed",
    async () => {
      await expectPhase5CatalogContractRejected(
        `DROP INDEX truth.accepted_facts_one_current_slot;
       CREATE UNIQUE INDEX accepted_facts_one_current_slot
         ON truth.accepted_facts (tenant_id, workspace_id, space_id, subject_type, subject_id)
         WHERE status = 'current'`,
        "B2 Slice 1 exact truth index inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects a narrowed phase-5 active-proposal index predicate",
    async () => {
      await expectPhase5CatalogContractRejected(
        `DROP INDEX truth.claims_one_active_primary_objective_proposal;
       CREATE UNIQUE INDEX claims_one_active_primary_objective_proposal
         ON truth.claims (
           tenant_id, workspace_id, space_id, subject_type, subject_id, predicate
         ) WHERE subject_type = 'initiative'
           AND predicate = 'initiative.primary_objective' AND status = 'proposed'
           AND access_class = 'public'`,
        "Objective recovery exact index inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects an unexpected non-unique phase-5 index",
    async () => {
      await expectPhase5CatalogContractRejected(
        `CREATE INDEX objective_support_unexpected_nonunique
           ON truth.initiative_objective_support_attestations (claim_id)`,
        "Objective recovery exact index inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it(
    "rejects an expected phase-5 index with invalid catalog state",
    async () => {
      await expectPhase5CatalogContractRejected(
        `DO $drift$
         BEGIN
           UPDATE pg_index SET indisvalid = false
             WHERE indexrelid =
               'truth.initiative_objective_support_attestations_pkey'::regclass;
         END
         $drift$`,
        "Objective recovery exact index inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it.each([
    [
      "primary key",
      "initiative_objective_proposal_recoveries",
      "p",
      "ALTER TABLE truth.initiative_objective_proposal_recoveries ADD CONSTRAINT objective_recovery_test_drift PRIMARY KEY (id, tenant_id)",
      undefined
    ],
    [
      "unique key",
      "initiative_objective_proposal_recoveries",
      "u",
      "ALTER TABLE truth.initiative_objective_proposal_recoveries ADD CONSTRAINT objective_recovery_test_drift UNIQUE (tenant_id, workspace_id, causation_command_id, id)",
      undefined
    ],
    [
      "check",
      "initiative_objective_support_attestations",
      "c",
      "ALTER TABLE truth.initiative_objective_support_attestations ADD CONSTRAINT objective_recovery_test_drift CHECK (version >= 1)",
      "CHECK ((version = 1))"
    ],
    [
      "foreign key",
      "initiative_objective_support_attestations",
      "f",
      "ALTER TABLE truth.initiative_objective_support_attestations ADD CONSTRAINT objective_recovery_test_drift FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id) ON DELETE CASCADE",
      "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)"
    ]
  ])(
    "rejects altered phase-5 %s inventory",
    async (_label, relation, type, replacement, exactDefinition) => {
      await expectPhase5CatalogContractRejected(
        `DO $drift$
         DECLARE target_name name;
         BEGIN
           SELECT constraint_record.conname INTO target_name
             FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid = ('truth.' || ${sqlLiteral(relation)})::regclass
              AND constraint_record.contype = ${sqlLiteral(type)}
              ${exactDefinition ? `AND pg_get_constraintdef(constraint_record.oid, false) = ${sqlLiteral(exactDefinition)}` : ""}
            ORDER BY constraint_record.oid LIMIT 1;
           EXECUTE format('ALTER TABLE truth.%I DROP CONSTRAINT %I', ${sqlLiteral(relation)}, target_name);
           EXECUTE ${sqlLiteral(replacement)};
         END
         $drift$`,
        "Objective recovery exact constraint inventory drifted"
      );
    },
    PHASE5_TEST_TIMEOUT
  );

  it("rejects an installed 0010 state whose final journal row was deleted without changing the database", async () => {
    await resetToLatest();
    await ownerPool.query(
      "DELETE FROM throughline_migrations.journal WHERE id = '0010_b2_trusted_objective_initiative_lock.sql'"
    );
    const before = await exact0010CatalogSnapshot(ownerPool);

    await expect(applyCheckpoint()).rejects.toThrow(
      "B2 migration state already exists without journal row for 0010_b2_trusted_objective_initiative_lock.sql"
    );

    expect(await exact0010CatalogSnapshot(ownerPool)).toBe(before);
  }, 60_000);

  it("adds the exact Initiative lock policies and id privilege only at 0010", async () => {
    await applyMigrations(ownerPool, {
      reset: true,
      through: "0009_b2_source_truth_lifecycle_interlock.sql"
    });
    const policiesBefore = await ownerPool.query(
      `SELECT policy_record.polname
         FROM pg_policy policy_record
        WHERE policy_record.polrelid = 'work.initiatives'::regclass
          AND policy_record.polname = ANY($1::text[])
        ORDER BY policy_record.polname`,
      [["initiatives_app_permanent_no_write", "initiatives_app_truth_lock"]]
    );
    expect(policiesBefore.rows).toEqual([]);
    const privilegeBefore = await ownerPool.query(
      `SELECT has_column_privilege(
         'throughline_app','work.initiatives','id','UPDATE'
       ) AS installed`
    );
    expect(privilegeBefore.rows).toEqual([{ installed: false }]);

    await expect(applyCheckpoint()).resolves.toMatchObject({
      applied: ["0010_b2_trusted_objective_initiative_lock.sql"]
    });
    const policies = await ownerPool.query<{
      name: string;
      command: string;
      permissive: boolean;
      roles: string[];
      using_expression: string;
      check_expression: string;
    }>(
      `SELECT policy_record.polname AS name,
              policy_record.polcmd::text AS command,
              policy_record.polpermissive AS permissive,
              ARRAY(
                SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END
                  FROM unnest(policy_record.polroles) role_oid
                 ORDER BY 1
              ) AS roles,
              pg_get_expr(policy_record.polqual, policy_record.polrelid) AS using_expression,
              pg_get_expr(policy_record.polwithcheck, policy_record.polrelid) AS check_expression
         FROM pg_policy policy_record
        WHERE policy_record.polrelid = 'work.initiatives'::regclass
          AND policy_record.polname = ANY($1::text[])
        ORDER BY policy_record.polname`,
      [["initiatives_app_permanent_no_write", "initiatives_app_truth_lock"]]
    );
    expect(policies.rows).toEqual([
      {
        name: "initiatives_app_permanent_no_write",
        command: "w",
        permissive: false,
        roles: ["throughline_app"],
        using_expression: "true",
        check_expression: "false"
      },
      {
        name: "initiatives_app_truth_lock",
        command: "w",
        permissive: true,
        roles: ["throughline_app"],
        using_expression: expect.stringMatching(
          /tenant_id = ops\.current_tenant_id\(\)[\s\S]*workspace_id = ops\.current_workspace_id\(\)[\s\S]*space_id = ops\.current_space_id\(\)[\s\S]*governing_space\.tenant_id = initiatives\.tenant_id[\s\S]*governing_space\.workspace_id = initiatives\.workspace_id[\s\S]*governing_space\.id = initiatives\.space_id[\s\S]*governing_space\.archived_at IS NULL/
        ),
        check_expression: "false"
      }
    ]);

    const privileges = await ownerPool.query<{
      scope: string;
      column_name: string | null;
      grantee: string;
      privilege: string;
      grantable: boolean;
    }>(
      `WITH relation AS (
         SELECT relation_record.oid, relation_record.relowner, relation_record.relacl
           FROM pg_class relation_record
          WHERE relation_record.oid = 'work.initiatives'::regclass
       )
       SELECT 'table'::text AS scope, NULL::text AS column_name,
              CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantee) END AS grantee,
              acl_record.privilege_type AS privilege,
              acl_record.is_grantable AS grantable
         FROM relation
         CROSS JOIN LATERAL aclexplode(relation.relacl) acl_record
        WHERE acl_record.grantee <> relation.relowner
          AND acl_record.privilege_type = 'UPDATE'
       UNION ALL
       SELECT 'column', attribute_record.attname::text,
              CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantee) END,
              acl_record.privilege_type,
              acl_record.is_grantable
         FROM relation
         JOIN pg_attribute attribute_record ON attribute_record.attrelid = relation.oid
         CROSS JOIN LATERAL aclexplode(attribute_record.attacl) acl_record
        WHERE attribute_record.attnum > 0 AND NOT attribute_record.attisdropped
          AND acl_record.grantee <> relation.relowner
          AND acl_record.privilege_type = 'UPDATE'
        ORDER BY scope, column_name NULLS FIRST, grantee`
    );

    expect(privileges.rows).toEqual([
      {
        scope: "column",
        column_name: "id",
        grantee: "throughline_app",
        privilege: "UPDATE",
        grantable: false
      }
    ]);
  }, 60_000);

  it("rejects missing or widened Initiative lock privileges", async () => {
    for (const mutation of [
      "REVOKE UPDATE (id) ON work.initiatives FROM throughline_app",
      "GRANT UPDATE ON work.initiatives TO throughline_app",
      "GRANT UPDATE (title) ON work.initiatives TO throughline_app",
      "GRANT UPDATE (id) ON work.initiatives TO PUBLIC",
      "GRANT UPDATE (id) ON work.initiatives TO throughline_worker",
      "GRANT UPDATE (id) ON work.initiatives TO throughline_app WITH GRANT OPTION"
    ]) {
      await expectCatalogContractRejected(
        mutation,
        "Installed B1 catalog does not match work.initiatives direct, PUBLIC, column, and grant-option privileges"
      );
    }
  }, 240_000);

  it("rejects missing, widened, wrong-role, or rogue Initiative lock policies", async () => {
    for (const mutation of [
      "DROP POLICY initiatives_app_truth_lock ON work.initiatives",
      "DROP POLICY initiatives_app_permanent_no_write ON work.initiatives",
      `DROP POLICY initiatives_app_truth_lock ON work.initiatives;
       CREATE POLICY initiatives_app_truth_lock ON work.initiatives
       AS PERMISSIVE FOR UPDATE TO throughline_app
       USING (true) WITH CHECK (false)`,
      "ALTER POLICY initiatives_app_truth_lock ON work.initiatives TO throughline_worker",
      `CREATE POLICY initiatives_app_rogue_update ON work.initiatives
       AS PERMISSIVE FOR UPDATE TO throughline_app
       USING (true) WITH CHECK (true)`
    ]) {
      await expectCatalogContractRejected(
        mutation,
        "Installed B1 catalog does not match work.initiatives policies"
      );
    }
  }, 240_000);

  it("allows FOR SHARE visibility but no Initiative data mutation", async () => {
    await resetToLatest();
    await seedWaveA2DeterministicData(ownerPool);
    const organizationId = "70000000-0000-7000-8000-000000000101";
    const initiativeId = "70000000-0000-7000-8000-000000000102";
    const fixtureClient = await ownerPool.connect();
    try {
      await fixtureClient.query("BEGIN");
      await fixtureClient.query(
        `INSERT INTO work.organizations (
           id, tenant_id, workspace_id, space_id, name, normalized_name
         ) VALUES ($1, $2, $3, $4, 'Lock Test Organization', 'lock test organization')`,
        [organizationId, devFixtures.tenantA, devFixtures.workspaceA, devFixtures.rootSpaceA]
      );
      await fixtureClient.query(
        `INSERT INTO work.initiatives (
           id, tenant_id, workspace_id, space_id, title, type_key, stage_key, health,
           owner_person_id, profile_id, profile_version
         ) VALUES ($1, $2, $3, $4, 'Immutable lock test', 'application', 'workshop',
                   'active', $5, 'ai-solutions', '1.0.0')`,
        [
          initiativeId,
          devFixtures.tenantA,
          devFixtures.workspaceA,
          devFixtures.rootSpaceA,
          devFixtures.personA
        ]
      );
      await fixtureClient.query(
        `INSERT INTO work.initiative_organizations (
           tenant_id, workspace_id, space_id, initiative_id, organization_id, association_role
         ) VALUES ($1, $2, $3, $4, $5, 'primary')`,
        [
          devFixtures.tenantA,
          devFixtures.workspaceA,
          devFixtures.rootSpaceA,
          initiativeId,
          organizationId
        ]
      );
      await fixtureClient.query("COMMIT");
    } catch (error) {
      await fixtureClient.query("ROLLBACK");
      throw error;
    } finally {
      fixtureClient.release();
    }

    await withTestAppPool(async (pool) => {
      const client = await pool.connect();
      const setScope = async () => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [devFixtures.tenantA]);
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [
          devFixtures.workspaceA
        ]);
        await client.query("SELECT set_config('app.space_id', $1, true)", [devFixtures.rootSpaceA]);
      };
      try {
        await client.query("BEGIN");
        await setScope();
        const locked = await client.query(
          "SELECT id FROM work.initiatives WHERE id = $1 FOR SHARE",
          [initiativeId]
        );
        expect(locked.rows).toEqual([{ id: initiativeId }]);
        await expect(
          client.query("UPDATE work.initiatives SET id = id WHERE id = $1", [initiativeId])
        ).rejects.toThrow(/row-level security policy/);
        await client.query("ROLLBACK");

        await client.query("BEGIN");
        await setScope();
        await expect(
          client.query("UPDATE work.initiatives SET title = 'Mutated' WHERE id = $1", [
            initiativeId
          ])
        ).rejects.toThrow(/permission denied/);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    const unchanged = await ownerPool.query(
      "SELECT title, version FROM work.initiatives WHERE id = $1",
      [initiativeId]
    );
    expect(unchanged.rows).toEqual([{ title: "Immutable lock test", version: 1 }]);
  }, 60_000);

  it("rejects post-0009 trigger, function-source, and deferrability drift", async () => {
    await resetToLatest();

    const qualifiedTriggers = await ownerPool.query<{ name: string; definition: string }>(
      `SELECT trigger_record.tgname AS name,
              pg_get_triggerdef(trigger_record.oid, false) AS definition
       FROM pg_trigger trigger_record
       WHERE trigger_record.tgrelid = 'ops.domain_command_records'::regclass
         AND trigger_record.tgname = ANY($1::text[])
       ORDER BY trigger_record.tgname`,
      [
        [
          "domain_command_records_b1_atomicity_deferred",
          "domain_command_records_b2_slice1_atomicity_deferred"
        ]
      ]
    );
    expect(qualifiedTriggers.rows.map(({ name }) => name)).toEqual([
      "domain_command_records_b1_atomicity_deferred",
      "domain_command_records_b2_slice1_atomicity_deferred"
    ]);
    expect(qualifiedTriggers.rows.every(({ definition }) => definition.includes(" WHEN "))).toBe(
      true
    );

    await expectCatalogContractRejected(
      `
        DROP INDEX truth.accepted_facts_one_current_slot;
        CREATE UNIQUE INDEX accepted_facts_one_current_slot
          ON truth.accepted_facts (
            tenant_id, workspace_id, space_id, subject_type, subject_id
          ) WHERE status = 'current'
      `,
      "B2 Slice 1 exact truth index inventory drifted"
    );

    await expectCatalogContractRejected(
      `
        DROP INDEX truth.accepted_facts_one_current_slot;
        CREATE UNIQUE INDEX accepted_facts_one_current_slot
          ON truth.accepted_facts (
            tenant_id, workspace_id, space_id, subject_type, subject_id, predicate
          ) WHERE status = 'cur(rent)'
      `,
      "B2 Slice 1 exact truth index inventory drifted"
    );

    await expectCatalogContractRejected(
      `
        DROP TRIGGER domain_command_records_b1_atomicity_deferred
          ON ops.domain_command_records;
        CREATE CONSTRAINT TRIGGER domain_command_records_b1_atomicity_deferred
          AFTER INSERT OR UPDATE ON ops.domain_command_records
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          WHEN (NEW.command_kind IN ('organization.create.v1'))
          EXECUTE FUNCTION ops.require_b1_command_atomicity()
      `,
      "Installed B1 catalog does not match exact domain command user-trigger inventory"
    );
    await expectCatalogContractRejected(
      `
        DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          ON ops.domain_command_records;
        CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          AFTER INSERT OR UPDATE ON ops.domain_command_records
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          WHEN (NEW.command_kind IN ('claim.create.v1','fact.accept.v1'))
          EXECUTE FUNCTION ops.require_b1_command_atomicity()
      `,
      "Installed B1 catalog does not match exact domain command user-trigger inventory"
    );
    await expectCatalogContractRejected(
      `
        DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          ON ops.domain_command_records;
        CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
          AFTER INSERT OR UPDATE ON ops.domain_command_records
          NOT DEFERRABLE INITIALLY IMMEDIATE
          FOR EACH ROW
          WHEN (NEW.command_kind IN ('claim.create.v1','fact.accept.v1'))
          EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity()
      `,
      "Installed B1 catalog does not match exact domain command constraint inventory"
    );
    await expectCatalogContractRejected(
      `
        CREATE OR REPLACE FUNCTION ops.require_b2_slice1_command_atomicity()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $function$
        BEGIN
          RETURN NULL;
        END
        $function$
      `,
      "B2 Slice 1 command function ownership or execution shape drifted"
    );
    await expectCatalogContractRejected(
      `
        CREATE OR REPLACE FUNCTION truth.validate_fact_support()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $function$
        DECLARE
          selected_fact_id uuid;
        BEGIN
          selected_fact_id := CASE TG_TABLE_NAME
            WHEN 'accepted_facts' THEN NEW.id
            ELSE NEW.fact_id
          END;
          RETURN NEW;
        END
        $function$
      `,
      "B2 Slice 1 truth function execution shape or source drifted"
    );
  }, 300_000);

  it("upgrades an exact B1 database through B2 without rewriting its journal", async () => {
    await applyMigrations(ownerPool, { reset: true, through: "0006_b1_command_integrity.sql" });
    const before = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
    );
    const upgraded = await applyCheckpoint();
    expect(upgraded.applied).toEqual([
      "0007_b2_slice1_truth_storage.sql",
      "0008_b2_slice1_command_integrity.sql",
      "0009_b2_source_truth_lifecycle_interlock.sql",
      "0010_b2_trusted_objective_initiative_lock.sql"
    ]);
    const after = await ownerPool.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id LIMIT 6"
    );
    expect(after.rows).toEqual(before.rows);
    await expectExactCommandFunctionPrivileges();
  }, 120_000);

  it(
    "upgrades valid populated exact-0008 truth into canonical text without changing history",
    async () => {
      await applyMigrations(ownerPool, {
        reset: true,
        through: "0008_b2_slice1_command_integrity.sql"
      });
      await insertExact0008TruthFixture(ownerPool);
      await expectExact0008ReferencesValid(ownerPool);
      const beforeCounts = await exact0008RowCounts(ownerPool);
      const beforeHistory = await exact0008StableHistory(ownerPool);
      expect(beforeCounts).toEqual({
        evidence: "2",
        claims: "2",
        facts: "1",
        support: "1"
      });
      const legacyValues = await ownerPool.query<{
        relation: string;
        semantic_value: string;
        json_type: string;
        hash_matches_v1_json: boolean;
      }>(
        `SELECT 'claim_' || subject_type AS relation, value_json #>> '{}' AS semantic_value,
              jsonb_typeof(value_json) AS json_type,
              value_hash = encode(
                public.digest(convert_to(value_json::text, 'UTF8'), 'sha256'
              ), 'hex') AS hash_matches_v1_json
         FROM truth.claims
       UNION ALL
       SELECT 'fact', value_json #>> '{}', jsonb_typeof(value_json),
              value_hash = encode(
                public.digest(convert_to(value_json::text, 'UTF8'), 'sha256'
              ), 'hex')
         FROM truth.accepted_facts
       ORDER BY relation`
      );
      expect(legacyValues.rows).toEqual([
        {
          relation: "claim_activity",
          semantic_value: "Adopted canonical value",
          json_type: "string",
          hash_matches_v1_json: true
        },
        {
          relation: "claim_initiative",
          semantic_value: "Adopted primary objective",
          json_type: "string",
          hash_matches_v1_json: true
        },
        {
          relation: "fact",
          semantic_value: "Adopted canonical value",
          json_type: "string",
          hash_matches_v1_json: true
        }
      ]);
      const beforeJournal = await ownerPool.query<{ id: string; checksum: string }>(
        "SELECT id, checksum FROM throughline_migrations.journal ORDER BY id"
      );

      await expect(
        applyMigrations(ownerPool, {
          through: "0011_b2_primary_objective_proposal_recovery.sql"
        })
      ).resolves.toMatchObject({
        applied: [
          "0009_b2_source_truth_lifecycle_interlock.sql",
          "0010_b2_trusted_objective_initiative_lock.sql",
          "0011_b2_primary_objective_proposal_recovery.sql"
        ]
      });

      const values = await ownerPool.query<{
        relation: string;
        canonical_value_text: string;
        hash_matches: boolean;
      }>(
        `SELECT 'claim_' || subject_type AS relation, canonical_value_text,
              value_hash = encode(
                public.digest(convert_to(canonical_value_text, 'UTF8'), 'sha256'
              ), 'hex') AS hash_matches
         FROM truth.claims
       UNION ALL
       SELECT 'fact', canonical_value_text,
              value_hash = encode(
                public.digest(convert_to(canonical_value_text, 'UTF8'), 'sha256'
              ), 'hex')
         FROM truth.accepted_facts
       ORDER BY relation`
      );
      expect(values.rows).toEqual([
        {
          relation: "claim_activity",
          canonical_value_text: "Adopted canonical value",
          hash_matches: true
        },
        {
          relation: "claim_initiative",
          canonical_value_text: "Adopted primary objective",
          hash_matches: true
        },
        { relation: "fact", canonical_value_text: "Adopted canonical value", hash_matches: true }
      ]);
      expect(await exact0008RowCounts(ownerPool)).toEqual(beforeCounts);
      expect(await exact0008StableHistory(ownerPool)).toBe(beforeHistory);
      const reconstructed = await ownerPool.query<{
        id: string;
        safe_request: Record<string, unknown>;
        native_valid: boolean;
        adopted_valid: boolean;
        safe_request_adopted: boolean;
        bound_to_durable: boolean;
      }>(
        `SELECT command.id, command.safe_request, command.safe_request_adopted,
              ops.b2_slice1_safe_request_valid(
                command.command_kind, command.safe_request
              ) AS native_valid,
              (ops.b2_slice1_safe_request_valid(command.command_kind, command.safe_request)
                OR (command.safe_request ->> 'predicate' = 'initiative.primary_objective'
                  AND jsonb_typeof(command.safe_request -> 'supportConfirmed') = 'boolean'
                  AND NOT (command.safe_request ->> 'supportConfirmed')::boolean
                  AND ops.b2_slice1_safe_request_valid(command.command_kind,
                    jsonb_set(command.safe_request, '{supportConfirmed}', 'true'::jsonb, false))))
                AS adopted_valid,
              command.safe_request ->> 'subjectType' = claim.subject_type
                AND command.safe_request ->> 'subjectId' = claim.subject_id::text
                AND (command.safe_request ->> 'expectedSubjectVersion')::integer =
                  CASE claim.subject_type WHEN 'activity' THEN activity.version
                    ELSE initiative.version END
                AND command.safe_request ->> 'predicate' = claim.predicate
                AND command.safe_request ->> 'valueHash' = claim.value_hash
                AND command.safe_request ->> 'sourceArtifactId' =
                  evidence.source_artifact_id::text
                AND command.safe_request ->> 'sourceChunkId' = evidence.source_chunk_id::text
                AND (command.safe_request ->> 'expectedSourceVersion')::integer =
                  evidence.source_version
                AND (command.safe_request ->> 'expectedChunkVersion')::integer =
                  evidence.chunk_version
                AND command.safe_request ->> 'normalizationVersion' =
                  evidence.normalization_version
                AND command.safe_request ->> 'chunkingVersion' = evidence.chunking_version
                AND (command.safe_request ->> 'startOffset')::integer =
                  evidence.source_start_offset
                AND (command.safe_request ->> 'endOffset')::integer =
                  evidence.source_end_offset
                AND command.safe_request ->> 'sourceContentHash' = evidence.source_content_hash
                AND command.safe_request ->> 'sourceNormalizedContentHash' =
                  evidence.source_normalized_content_hash
                AND command.safe_request ->> 'chunkContentHash' = evidence.chunk_content_hash
                AND command.safe_request ->> 'excerptHash' = evidence.excerpt_hash
                AND NOT (command.safe_request ->> 'supportConfirmed')::boolean
                  AS bound_to_durable
         FROM ops.domain_command_records command
         JOIN truth.claims claim ON claim.causation_command_id = command.id
         JOIN truth.verified_evidence_spans evidence
           ON evidence.id = claim.verified_evidence_span_id
         LEFT JOIN work.activities activity
           ON claim.subject_type = 'activity' AND activity.id = claim.subject_id
         LEFT JOIN work.initiatives initiative
           ON claim.subject_type = 'initiative' AND initiative.id = claim.subject_id
        WHERE command.command_kind = 'claim.create.v1'
        ORDER BY command.id`
      );
      expect(reconstructed.rows).toHaveLength(2);
      expect(
        reconstructed.rows.map(
          ({ native_valid, adopted_valid, safe_request_adopted, bound_to_durable }) => ({
            native_valid,
            adopted_valid,
            safe_request_adopted,
            bound_to_durable
          })
        )
      ).toEqual([
        {
          native_valid: true,
          adopted_valid: true,
          safe_request_adopted: true,
          bound_to_durable: true
        },
        {
          native_valid: false,
          adopted_valid: true,
          safe_request_adopted: true,
          bound_to_durable: true
        }
      ]);
      const genericRequest = reconstructed.rows.find(
        ({ id }) => id === adoptionIds.command
      )!.safe_request;
      expect(Object.keys(genericRequest).sort()).toEqual([
        "chunkContentHash",
        "chunkingVersion",
        "endOffset",
        "excerptHash",
        "expectedChunkVersion",
        "expectedSourceVersion",
        "expectedSubjectVersion",
        "normalizationVersion",
        "predicate",
        "sourceArtifactId",
        "sourceChunkId",
        "sourceContentHash",
        "sourceNormalizedContentHash",
        "startOffset",
        "subjectId",
        "subjectType",
        "supportConfirmed",
        "valueHash"
      ]);
      expect(genericRequest).toMatchObject({
        subjectType: "activity",
        predicate: "activity.outcome",
        supportConfirmed: false
      });
      const objectiveRequest = reconstructed.rows.find(
        ({ id }) => id === adoptionIds.objectiveCommand
      )!.safe_request;
      expect(objectiveRequest).toMatchObject({
        subjectType: "initiative",
        predicate: "initiative.primary_objective",
        supportConfirmed: false,
        expectedLatestClaimId: null,
        expectedLatestClaimVersion: null,
        expectedLatestClaimStatus: null
      });
      expect(
        (
          await ownerPool.query(
            "SELECT 1 FROM truth.initiative_objective_support_attestations LIMIT 1"
          )
        ).rows
      ).toHaveLength(0);
      await expect(
        ownerPool.query(
          `INSERT INTO ops.domain_command_records (
             id, tenant_id, workspace_id, reservation_space_id, command_kind,
             command_schema_version, idempotency_key, canonical_request_hash, state,
             safe_request, safe_request_adopted, actor_user_id, actor_membership_id,
             policy_version_id, request_id, traceparent
           ) SELECT
             '0190a000-0000-7000-8000-0000000000fe', tenant_id, workspace_id,
             reservation_space_id, command_kind, command_schema_version,
             'native-unconfirmed-objective', canonical_request_hash, 'reserved', safe_request,
             false, actor_user_id, actor_membership_id, policy_version_id,
             'native-unconfirmed-objective',
             '00-00000000000000000000000000000004-0000000000000004-01'
           FROM ops.domain_command_records WHERE id = $1`,
          [adoptionIds.objectiveCommand]
        )
      ).rejects.toMatchObject({ code: "23514" });
      const nullHashRequest = {
        ...objectiveRequest,
        supportConfirmed: true,
        sourceContentHash: null
      };
      const nullIntegerRequest = {
        ...objectiveRequest,
        expectedSubjectVersion: null
      };
      expect(
        (
          await ownerPool.query<{ valid: boolean }>(
            `SELECT ops.b2_slice1_safe_request_valid(
               'claim.create.v1', request.request_value
             ) AS valid
               FROM (VALUES ($1::jsonb), ($2::jsonb)) request(request_value)`,
            [nullHashRequest, nullIntegerRequest]
          )
        ).rows
      ).toEqual([{ valid: false }, { valid: false }]);
      const expectNullRequestRejected = async (
        commandId: string,
        idempotencyKey: string,
        request: Record<string, unknown>,
        adopted: boolean
      ) =>
        expect(
          ownerPool.query(
            `INSERT INTO ops.domain_command_records (
               id, tenant_id, workspace_id, reservation_space_id, command_kind,
               command_schema_version, idempotency_key, canonical_request_hash, state,
               safe_request, safe_request_adopted, actor_user_id, actor_membership_id,
               policy_version_id, request_id, traceparent
             ) SELECT
               $2, tenant_id, workspace_id, reservation_space_id, command_kind,
               command_schema_version, $3, canonical_request_hash, 'reserved', $4::jsonb,
               $5, actor_user_id, actor_membership_id, policy_version_id, $3,
               '00-00000000000000000000000000000005-0000000000000005-01'
             FROM ops.domain_command_records WHERE id = $1`,
            [adoptionIds.objectiveCommand, commandId, idempotencyKey, request, adopted]
          )
        ).rejects.toMatchObject({ code: "23514" });
      await expectNullRequestRejected(
        "0190a000-0000-7000-8000-0000000000fd",
        "native-null-source-hash",
        nullHashRequest,
        false
      );
      await expectNullRequestRejected(
        "0190a000-0000-7000-8000-0000000000fc",
        "adopted-null-subject-version",
        nullIntegerRequest,
        true
      );
      await expect(
        executeAsRole(
          "throughline_app",
          "INSERT INTO ops.domain_command_records (safe_request_adopted) VALUES (true)"
        )
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        executeAsRole(
          "throughline_app",
          "UPDATE ops.domain_command_records SET safe_request_adopted = true WHERE id = $1",
          [adoptionIds.objectiveCommand]
        )
      ).rejects.toMatchObject({ code: "42501" });
      const afterJournal = await ownerPool.query<{ id: string; checksum: string }>(
        "SELECT id, checksum FROM throughline_migrations.journal WHERE id <> ALL($1::text[]) ORDER BY id",
        [
          [
            "0009_b2_source_truth_lifecycle_interlock.sql",
            "0010_b2_trusted_objective_initiative_lock.sql",
            "0011_b2_primary_objective_proposal_recovery.sql"
          ]
        ]
      );
      expect(afterJournal.rows).toEqual(beforeJournal.rows);
    },
    PHASE5_TEST_TIMEOUT
  );

  it("executes the additive Fact-support validator from both shared trigger relations", async () => {
    try {
      await applyMigrations(ownerPool, {
        reset: true,
        through: "0008_b2_slice1_command_integrity.sql"
      });
      await insertExact0008TruthFixture(ownerPool);
      await applyCheckpoint();

      const factClient = await ownerPool.connect();
      try {
        await factClient.query("BEGIN");
        await factClient.query(
          "ALTER TABLE truth.accepted_facts DISABLE TRIGGER accepted_facts_command_guard"
        );
        await factClient.query(
          "ALTER TABLE truth.accepted_facts DISABLE TRIGGER accepted_facts_insert_guard"
        );
        await factClient.query(
          `INSERT INTO truth.accepted_facts (
             id, tenant_id, workspace_id, space_id, subject_type, subject_id,
             predicate_catalog_version, predicate, canonical_value_text, value_hash,
             normalized_text, confidence, confidence_rule, strongest_supporting_confidence,
             human_lowered, confidence_lowering_reason_code, confidence_lowering_rationale,
             valid_from, valid_to, recorded_at, status, access_class,
             accepted_by_user_id, accepted_by_membership_id, acceptance_scope,
             authority_basis, acceptance_policy_version, last_causation_command_id,
             created_at, updated_at, version
           )
           SELECT $1, tenant_id, workspace_id, space_id, subject_type, $2,
                  predicate_catalog_version, predicate, canonical_value_text, value_hash,
                  normalized_text, confidence, confidence_rule, strongest_supporting_confidence,
                  human_lowered, confidence_lowering_reason_code, confidence_lowering_rationale,
                  valid_from, valid_to, recorded_at, status, access_class,
                  accepted_by_user_id, accepted_by_membership_id, acceptance_scope,
                  authority_basis, acceptance_policy_version, last_causation_command_id,
                  created_at, updated_at, version
             FROM truth.accepted_facts
            WHERE id = $3`,
          [
            "0190a000-0000-7000-8000-000000000411",
            "0190a000-0000-7000-8000-000000000412",
            adoptionIds.fact
          ]
        );
        const unsupportedFactError = await factClient
          .query("SET CONSTRAINTS truth.accepted_facts_support_deferred IMMEDIATE")
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(unsupportedFactError).toMatchObject({
          code: "P0001",
          message: "accepted fact support is invalid"
        });
      } finally {
        await factClient.query("ROLLBACK");
        factClient.release();
      }

      const supportClient = await ownerPool.connect();
      try {
        await supportClient.query("BEGIN");
        await supportClient.query("ALTER TABLE truth.claims DISABLE TRIGGER claims_command_guard");
        await supportClient.query("ALTER TABLE truth.claims DISABLE TRIGGER claims_insert_guard");
        await supportClient.query(
          "ALTER TABLE truth.fact_claims DISABLE TRIGGER fact_claims_command_guard"
        );
        await supportClient.query(
          `INSERT INTO truth.claims (
             id, tenant_id, workspace_id, space_id, subject_type, subject_id,
             predicate_catalog_version, predicate, canonical_value_text, value_hash,
             normalized_text, verified_evidence_span_id, asserted_by_type, asserted_by_id,
             confidence, valid_from, valid_to, observed_at, status, access_class,
             created_by_user_id, created_by_membership_id, causation_command_id,
             created_at, updated_at, version
           )
           SELECT $1, tenant_id, workspace_id, space_id, subject_type, subject_id,
                  predicate_catalog_version, predicate, canonical_value_text, value_hash,
                  normalized_text, verified_evidence_span_id, asserted_by_type, asserted_by_id,
                  confidence, valid_from, valid_to, observed_at, status, access_class,
                  created_by_user_id, created_by_membership_id, causation_command_id,
                  created_at, updated_at, version
             FROM truth.claims
            WHERE id = $2`,
          ["0190a000-0000-7000-8000-000000000413", adoptionIds.claim]
        );
        await supportClient.query(
          `INSERT INTO truth.fact_claims (
             tenant_id, workspace_id, space_id, fact_id, claim_id
           ) VALUES ($1,$2,$3,$4,$5)`,
          [
            adoptionIds.tenant,
            adoptionIds.workspace,
            adoptionIds.space,
            adoptionIds.fact,
            "0190a000-0000-7000-8000-000000000413"
          ]
        );
        await expect(
          supportClient.query("SET CONSTRAINTS truth.fact_claims_support_deferred IMMEDIATE")
        ).resolves.toBeDefined();
      } finally {
        await supportClient.query("ROLLBACK");
        supportClient.release();
      }
    } finally {
      await resetToLatest();
    }
  }, 120_000);

  it.each([
    ["corrected source", "correction"],
    ["retained-hash tombstone", "retained"],
    ["erased-hash tombstone", "erased"],
    ["missing referenced chunk", "missing_chunk"]
  ] as const)(
    "atomically rejects exact-0008 adoption with a %s",
    async (_label, mutation) => {
      await applyMigrations(ownerPool, {
        reset: true,
        through: "0008_b2_slice1_command_integrity.sql"
      });
      await insertExact0008TruthFixture(ownerPool);
      await mutateExact0008Evidence(ownerPool, mutation);
      await expectExact0008ReferencesValid(ownerPool);
      const before = await exact0008Digest(ownerPool);

      const adoptionError = await applyCheckpoint().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(adoptionError).toMatchObject({
        code: "P0001",
        message: "Existing truth evidence cannot adopt the B2 lifecycle interlock"
      });

      expect(await exact0008Digest(ownerPool)).toBe(before);
      const state = await ownerPool.query<{
        journal: string | null;
        canonical_column: string | null;
        lifecycle_function: string | null;
        lifecycle_triggers: string;
      }>(
        `SELECT
         (SELECT id FROM throughline_migrations.journal
           WHERE id = '0009_b2_source_truth_lifecycle_interlock.sql') AS journal,
         (SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'truth' AND table_name = 'claims'
             AND column_name = 'canonical_value_text') AS canonical_column,
         to_regprocedure('ops.enforce_b2_source_truth_lifecycle_interlock()')::text
           AS lifecycle_function,
         (SELECT count(*)::text FROM pg_trigger
           WHERE tgname LIKE '%_z_b2_%_interlock') AS lifecycle_triggers`
      );
      expect(state.rows[0]).toEqual({
        journal: null,
        canonical_column: null,
        lifecycle_function: null,
        lifecycle_triggers: "0"
      });
    },
    120_000
  );

  it("allows only app writes and product-relay outbox checks to execute B2 validators", async () => {
    await resetToLatest();
    const claimId = "0190a000-0000-7000-8000-000000000321";
    const evidenceSpanId = "0190a000-0000-7000-8000-000000000322";
    const payload = JSON.stringify({ claimId, evidenceSpanId });
    const appExecution = await withTestAppPool((appPool) =>
      appPool.query<{
        event_valid: boolean;
        audit_valid: boolean;
        command_valid: boolean;
      }>(
        `SELECT
           ops.b2_slice1_event_payload_valid(
             'claim.proposed', 1, $1::uuid, $2::jsonb
           ) AS event_valid,
           ops.b2_slice1_audit_detail_valid(
             'claim.create', 'claim', 1, $1::uuid, $2::jsonb
           ) AS audit_valid,
           ops.product_command_record_valid(
             'claim.create.v1', 1, 'reserved', NULL, NULL, NULL
           ) AS command_valid`,
        [claimId, payload]
      )
    );
    expect(appExecution.rows[0]).toEqual({
      event_valid: true,
      audit_valid: true,
      command_valid: true
    });
    const restoredAppRole = await ownerPool.query<{ login: boolean }>(
      "SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = 'throughline_app'"
    );
    expect(restoredAppRole.rows).toEqual([{ login: false }]);
    await expect(applyCheckpoint()).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });

    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.b2_slice1_event_payload_valid(
           'claim.proposed', 1, $1::uuid, $2::jsonb
         ) AS valid`,
        [claimId, payload]
      )
    ).resolves.toMatchObject({ rows: [{ valid: true }] });
    for (const role of ["throughline_relay", "throughline_worker"]) {
      await expect(
        executeAsRole(
          role,
          `SELECT ops.b2_slice1_event_payload_valid(
             'claim.proposed', 1, $1::uuid, $2::jsonb
           )`,
          [claimId, payload]
        )
      ).rejects.toThrow(/permission denied for function b2_slice1_event_payload_valid/);
    }
    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.b2_slice1_audit_detail_valid(
           'claim.create', 'claim', 1, $1::uuid, $2::jsonb
         )`,
        [claimId, payload]
      )
    ).rejects.toThrow(/permission denied for function b2_slice1_audit_detail_valid/);
    await expect(
      executeAsRole(
        "throughline_product_relay",
        `SELECT ops.product_command_record_valid(
           'claim.create.v1', 1, 'reserved', NULL, NULL, NULL
         )`
      )
    ).rejects.toThrow(/permission denied for function product_command_record_valid/);

    await expectExactCommandFunctionPrivileges();
  }, 60_000);

  it("forces RLS for every truth table and gives no raw truth access to worker/relay", async () => {
    await resetToLatest();
    const rls = await ownerPool.query<{
      name: string;
      enabled: boolean;
      forced: boolean;
    }>(
      `SELECT relation.relname AS name, relation.relrowsecurity AS enabled,
              relation.relforcerowsecurity AS forced
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'truth' AND relation.relkind = 'r'
       ORDER BY relation.relname`
    );
    expect(rls.rows.map(({ name }) => name)).toEqual(truthTables);
    expect(rls.rows.every(({ enabled, forced }) => enabled && forced)).toBe(true);

    const policies = await ownerPool.query<{
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
      const select = policies.rows.find(
        (policy) => policy.table_name === table && policy.operation === "SELECT"
      );
      const insert = policies.rows.find(
        (policy) => policy.table_name === table && policy.operation === "INSERT"
      );
      expect(select?.using_expression, `${table} SELECT ceiling`).toContain(
        "access.can_read_space"
      );
      expect(insert?.check_expression, `${table} INSERT ceiling`).toContain(
        "access.can_read_space"
      );
      expect(insert?.check_expression, `${table} INSERT current Space`).toContain(
        "space_id = ops.current_space_id()"
      );
    }

    const raw = await ownerPool.query<{
      relay: boolean;
      worker: boolean;
      product_relay: boolean;
    }>(
      `SELECT has_table_privilege(
                'throughline_relay','truth.accepted_facts','SELECT'
              ) AS relay,
              has_table_privilege(
                'throughline_worker','truth.accepted_facts','SELECT'
              ) AS worker,
              has_table_privilege(
                'throughline_product_relay','truth.claims','SELECT'
              ) AS product_relay`
    );
    expect(raw.rows[0]).toEqual({ relay: false, worker: false, product_relay: false });

    const integrity = await ownerPool.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT table_name,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'SELECT'
              ) AS can_select,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'INSERT'
              ) AS can_insert,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'UPDATE'
              ) AS can_update,
              has_table_privilege(
                'throughline_b1_0_integrity', 'truth.' || table_name, 'DELETE'
              ) AS can_delete
         FROM unnest($1::text[]) table_name
        ORDER BY table_name`,
      [[...truthTables]]
    );
    expect(integrity.rows).toEqual(
      [...truthTables].sort().map((table_name) => ({
        table_name,
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false
      }))
    );

    const excluded = await ownerPool.query<{
      lifecycle_table: string | null;
      reconciliation_function: string | null;
      source_truth_triggers: string;
    }>(
      `SELECT
         to_regclass('truth.fact_lifecycle_events')::text AS lifecycle_table,
         to_regprocedure('truth.reconcile_source_retention()')::text
           AS reconciliation_function,
         (SELECT count(*)::text
            FROM pg_trigger trigger_record
            JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
            JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
           WHERE trigger_record.tgrelid = 'content.source_artifacts'::regclass
             AND NOT trigger_record.tgisinternal
             AND namespace.nspname = 'truth') AS source_truth_triggers`
    );
    expect(excluded.rows[0]).toEqual({
      lifecycle_table: null,
      reconciliation_function: null,
      source_truth_triggers: "0"
    });
  }, 60_000);

  it("pins the lifecycle interlock owner, safe search path, direct ACLs, and exact triggers", async () => {
    await resetToLatest();
    const identity = "ops.enforce_b2_source_truth_lifecycle_interlock()";
    const shape = await ownerPool.query<{
      owner: string;
      security_definer: boolean;
      configuration: string[];
      public_execute: boolean;
      app_execute: boolean;
    }>(
      `SELECT pg_get_userbyid(procedure.proowner) AS owner,
              procedure.prosecdef AS security_definer,
              COALESCE(procedure.proconfig, ARRAY[]::text[]) AS configuration,
              EXISTS (
                SELECT 1
                  FROM aclexplode(COALESCE(
                    procedure.proacl, acldefault('f', procedure.proowner)
                  )) acl
                 WHERE acl.grantee = 0
                   AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_function_privilege('throughline_app', procedure.oid, 'EXECUTE') AS app_execute
         FROM pg_proc procedure
        WHERE procedure.oid = $1::regprocedure`,
      [identity]
    );
    expect(shape.rows).toEqual([
      {
        owner: "throughline_b1_0_integrity",
        security_definer: true,
        configuration: ["search_path=pg_catalog"],
        public_execute: false,
        app_execute: false
      }
    ]);

    const serializationSources = await ownerPool.query<{ identity: string; source: string }>(
      `SELECT procedure.oid::regprocedure::text AS identity,
              procedure.prosrc AS source
         FROM pg_proc procedure
        WHERE procedure.oid = ANY($1::regprocedure[])
        ORDER BY procedure.oid::regprocedure::text`,
      [[identity, "truth.verify_evidence_snapshot()"]]
    );
    expect(
      serializationSources.rows.map(({ identity: functionIdentity }) => functionIdentity)
    ).toEqual([identity, "truth.verify_evidence_snapshot()"]);
    const installedLocks = serializationSources.rows.map(
      ({ source }) =>
        source.match(/PERFORM pg_catalog\.pg_advisory_xact_lock\([\s\S]*?\n {2}\);/)?.[0]
    );
    expect(installedLocks[0]).toContain("'throughline:b2:source-truth:'");
    expect(installedLocks[1]).toBe(installedLocks[0]);
    expect(serializationSources.rows[0]!.source.indexOf(installedLocks[0]!)).toBeLessThan(
      serializationSources.rows[0]!.source.indexOf("EXISTS (")
    );
    expect(serializationSources.rows[1]!.source.indexOf(installedLocks[1]!)).toBeLessThan(
      serializationSources.rows[1]!.source.indexOf("SELECT source.version")
    );

    const triggers = await ownerPool.query<{ name: string; relation: string }>(
      `SELECT trigger_record.tgname AS name,
              trigger_record.tgrelid::regclass::text AS relation
         FROM pg_trigger trigger_record
        WHERE trigger_record.tgfoid = $1::regprocedure
          AND NOT trigger_record.tgisinternal
        ORDER BY trigger_record.tgname`,
      [identity]
    );
    expect(triggers.rows).toEqual([
      {
        name: "source_artifacts_z_b2_correction_interlock",
        relation: "content.source_artifacts"
      },
      {
        name: "source_artifacts_z_b2_tombstone_interlock",
        relation: "content.source_artifacts"
      },
      {
        name: "source_chunks_z_b2_delete_interlock",
        relation: "content.source_chunks"
      }
    ]);
  }, 60_000);

  it("accepts the clean PUBLIC ACLs and rejects a deliberate PUBLIC truth-table grant", async () => {
    await resetToLatest();
    await expect(applyCheckpoint()).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });

    await ownerPool.query("GRANT SELECT ON truth.claims TO PUBLIC");
    try {
      await expect(applyCheckpoint()).rejects.toThrow("B2 Slice 1 truth table authority drifted");
    } finally {
      await ownerPool.query("REVOKE SELECT ON truth.claims FROM PUBLIC");
    }

    await expect(applyCheckpoint()).resolves.toEqual({
      applied: [],
      skipped: [...allMigrationIds]
    });
  }, 60_000);

  it("denies an app-role raw mutation without a transaction-scoped tenant and Space", async () => {
    await resetToLatest();
    await expect(
      executeAsRole(
        "throughline_app",
        `INSERT INTO truth.accepted_facts (
        id, tenant_id, workspace_id, space_id, subject_type, subject_id,
        predicate_catalog_version, predicate,
        canonical_value_text, value_hash, normalized_text, confidence,
        confidence_rule, strongest_supporting_confidence, human_lowered,
        recorded_at, status, access_class,
        accepted_by_user_id, accepted_by_membership_id, acceptance_scope, authority_basis,
        acceptance_policy_version, last_causation_command_id
      ) VALUES (
        '0190a000-0000-7000-8000-000000000091','0190a000-0000-7000-8000-000000000092',
        '0190a000-0000-7000-8000-000000000093','0190a000-0000-7000-8000-000000000094',
        'activity','0190a000-0000-7000-8000-000000000095',
        'truth-predicate-catalog.v1','activity.outcome',
        'forged',repeat('a',64),'forged','confirmed',
        'strongest-selected-valid-claim.v1','confirmed',false,
        clock_timestamp(),'current','workspace',
        '0190a000-0000-7000-8000-000000000096','0190a000-0000-7000-8000-000000000097',
        'engagement','activity_owner','default-v1',
        '0190a000-0000-7000-8000-000000000098'
      )`
      )
    ).rejects.toThrow();
  }, 60_000);
});

async function exact0010CatalogSnapshot(pool: pg.Pool): Promise<string> {
  const snapshot = await pool.query<{
    journal: unknown;
    policies: unknown;
    relation_oid: string;
    privileges: unknown;
    catalog: unknown;
  }>(
    `SELECT
       (SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.id)
          FROM throughline_migrations.journal entry) AS journal,
       (SELECT jsonb_agg(jsonb_build_object(
          'name', policy.polname,
          'definition', pg_get_expr(policy.polqual, policy.polrelid),
          'check', pg_get_expr(policy.polwithcheck, policy.polrelid),
          'roles', policy.polroles,
          'command', policy.polcmd,
          'permissive', policy.polpermissive
        ) ORDER BY policy.polname)
          FROM pg_policy policy
         WHERE policy.polrelid = 'work.initiatives'::regclass) AS policies,
       'work.initiatives'::regclass::oid::text AS relation_oid,
       (SELECT jsonb_agg(jsonb_build_object(
          'column', attribute.attname,
          'acl', attribute.attacl
        ) ORDER BY attribute.attnum)
          FROM pg_attribute attribute
         WHERE attribute.attrelid = 'work.initiatives'::regclass
           AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS privileges,
       (SELECT to_jsonb(relation)
          FROM pg_class relation
         WHERE relation.oid = 'work.initiatives'::regclass) AS catalog`
  );
  return JSON.stringify(snapshot.rows[0]);
}

const adoptionIds = {
  source: "0190a000-0000-7000-8000-000000000401",
  chunk: "0190a000-0000-7000-8000-000000000402",
  command: "0190a000-0000-7000-8000-000000000403",
  factCommand: "0190a000-0000-7000-8000-000000000409",
  evidence: "0190a000-0000-7000-8000-000000000404",
  claim: "0190a000-0000-7000-8000-000000000405",
  fact: "0190a000-0000-7000-8000-000000000406",
  successor: "0190a000-0000-7000-8000-000000000407",
  tenant: "11111111-1111-4111-8111-111111111111",
  workspace: "11111111-1111-4111-8111-111111111112",
  space: "11111111-1111-4111-8111-111111111113",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  membership: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
  person: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  subject: "0190a000-0000-7000-8000-000000000408",
  organization: "0190a000-0000-7000-8000-000000000410",
  objectiveCommand: "0190a000-0000-7000-8000-000000000421",
  objectiveEvidence: "0190a000-0000-7000-8000-000000000422",
  objectiveClaim: "0190a000-0000-7000-8000-000000000423",
  initiative: "0190a000-0000-7000-8000-000000000424"
} as const;

const phase6Ids = {
  lifecycle: "0190a000-0000-7000-8000-000000000431",
  crossSpaceLifecycle: "0190a000-0000-7000-8000-000000000432",
  revokeCommand: "0190a000-0000-7000-8000-000000000433",
  revokeAudit: "0190a000-0000-7000-8000-000000000434",
  revokeOutbox: "0190a000-0000-7000-8000-000000000435",
  duplicateLifecycle: "0190a000-0000-7000-8000-000000000436",
  duplicateAudit: "0190a000-0000-7000-8000-000000000437",
  duplicateOutbox: "0190a000-0000-7000-8000-000000000438",
  supersedeCommand: "0190a000-0000-7000-8000-000000000439",
  supersedeLifecycle: "0190a000-0000-7000-8000-000000000440",
  supersedeAudit: "0190a000-0000-7000-8000-000000000441",
  supersedeOutbox: "0190a000-0000-7000-8000-000000000442",
  otherSubject: "0190a000-0000-7000-8000-000000000443",
  mutationCommand: "0190a000-0000-7000-8000-000000000444",
  replacementClaim: "0190a000-0000-7000-8000-000000000445",
  secondReplacementClaim: "0190a000-0000-7000-8000-000000000446",
  mismatchedResponseSuccessor: "0190a000-0000-7000-8000-000000000447",
  chainSuccessor: "0190a000-0000-7000-8000-000000000448",
  chainCommand: "0190a000-0000-7000-8000-000000000449",
  chainLifecycle: "0190a000-0000-7000-8000-000000000450",
  chainAudit: "0190a000-0000-7000-8000-000000000451",
  chainOutbox: "0190a000-0000-7000-8000-000000000452",
  orphanReplacementClaim: "0190a000-0000-7000-8000-000000000453",
  orphanSuccessor: "0190a000-0000-7000-8000-000000000454",
  orphanCommand: "0190a000-0000-7000-8000-000000000455",
  nonexistentPredecessor: "0190a000-0000-7000-8000-000000000456",
  confidentialReplacementClaim: "0190a000-0000-7000-8000-000000000457"
} as const;

async function resetPopulatedExact0011(pool: pg.Pool): Promise<void> {
  await applyMigrations(pool, {
    reset: true,
    through: "0008_b2_slice1_command_integrity.sql"
  });
  await insertExact0008TruthFixture(pool);
  await applyMigrations(pool, { through: "0011_b2_primary_objective_proposal_recovery.sql" });
  const causedClaims = await pool.query<{ command_id: string; caused_claim_count: number }>(
    `SELECT command.id AS command_id, count(claim.id)::integer AS caused_claim_count
       FROM ops.domain_command_records command
       LEFT JOIN truth.claims claim
         ON claim.tenant_id = command.tenant_id
        AND claim.workspace_id = command.workspace_id
        AND claim.causation_command_id = command.id
      WHERE command.command_kind = 'claim.create.v1'
      GROUP BY command.id
      ORDER BY command.id`
  );
  expect(causedClaims.rows).toEqual([
    { command_id: adoptionIds.command, caused_claim_count: 1 },
    { command_id: adoptionIds.objectiveCommand, caused_claim_count: 1 }
  ]);
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

async function insertOwnerPhase6ReplacementClaims(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE truth.claims DISABLE TRIGGER USER");
    await client.query(
      `INSERT INTO truth.claims (
         id,tenant_id,workspace_id,space_id,subject_type,subject_id,
         predicate_catalog_version,predicate,canonical_value_text,value_hash,normalized_text,
         verified_evidence_span_id,asserted_by_type,asserted_by_id,confidence,status,
         access_class,created_by_user_id,created_by_membership_id,causation_command_id,version
       ) VALUES (
         $1,$3,$4,$5,'activity',$6,'truth-predicate-catalog.v1','activity.outcome',
         $7,encode(public.digest(convert_to($7,'UTF8'),'sha256'),'hex'),
         $7,$8,'person',$9,'strong','proposed','workspace',$10,$11,$12,1
       ), (
         $2,$3,$4,$5,'activity',$6,'truth-predicate-catalog.v1','activity.outcome',
         $7,encode(public.digest(convert_to($7,'UTF8'),'sha256'),'hex'),
         $7,$8,'person',$9,'strong','proposed','workspace',$10,$11,$12,1
       ), (
         $13,$3,$4,$5,'activity',$14,'truth-predicate-catalog.v1','activity.outcome',
         $15,encode(public.digest(convert_to($15,'UTF8'),'sha256'),'hex'),
         $15,$8,'person',$9,'strong','proposed','workspace',$10,$11,$12,1
       ), (
         $16,$3,$4,$5,'activity',$6,'truth-predicate-catalog.v1','activity.outcome',
         $17,encode(public.digest(convert_to($17,'UTF8'),'sha256'),'hex'),
         $17,$8,'person',$9,'strong','proposed','confidential',$10,$11,$12,1
       )`,
      [
        phase6Ids.replacementClaim,
        phase6Ids.secondReplacementClaim,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        "Replacement canonical value",
        adoptionIds.evidence,
        adoptionIds.person,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.command,
        phase6Ids.orphanReplacementClaim,
        phase6Ids.otherSubject,
        "Orphan replacement canonical value",
        phase6Ids.confidentialReplacementClaim,
        "Confidential replacement canonical value"
      ]
    );
    await client.query("ALTER TABLE truth.claims ENABLE TRIGGER USER");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const replacementClaims = await client.query<{
      claim_id: string;
      tenant_id: string;
      workspace_id: string;
      space_id: string;
      subject_type: string;
      subject_id: string;
      predicate: string;
      canonical_value_text: string;
      verified_evidence_span_id: string;
      asserted_by_type: string;
      asserted_by_id: string;
      confidence: string;
      status: string;
      access_class: string;
      created_by_user_id: string;
      created_by_membership_id: string;
      causation_command_id: string;
      version: number;
    }>(
      `SELECT id AS claim_id, tenant_id, workspace_id, space_id, subject_type, subject_id,
              predicate, canonical_value_text, verified_evidence_span_id, asserted_by_type,
              asserted_by_id, confidence, status, access_class, created_by_user_id,
              created_by_membership_id, causation_command_id, version
         FROM truth.claims
        WHERE tenant_id = $1
          AND workspace_id = $2
          AND space_id = $3
          AND subject_type = 'activity'
          AND subject_id = $4
          AND predicate = 'activity.outcome'
          AND canonical_value_text = $5
        ORDER BY id`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        "Replacement canonical value"
      ]
    );
    expect(replacementClaims.rows).toEqual(
      [phase6Ids.replacementClaim, phase6Ids.secondReplacementClaim].map((claimId) => ({
        claim_id: claimId,
        tenant_id: adoptionIds.tenant,
        workspace_id: adoptionIds.workspace,
        space_id: adoptionIds.space,
        subject_type: "activity",
        subject_id: adoptionIds.subject,
        predicate: "activity.outcome",
        canonical_value_text: "Replacement canonical value",
        verified_evidence_span_id: adoptionIds.evidence,
        asserted_by_type: "person",
        asserted_by_id: adoptionIds.person,
        confidence: "strong",
        status: "proposed",
        access_class: "workspace",
        created_by_user_id: adoptionIds.user,
        created_by_membership_id: adoptionIds.membership,
        causation_command_id: adoptionIds.command,
        version: 1
      }))
    );
    const specializedClaims = await client.query<{
      claim_id: string;
      subject_id: string;
      predicate: string;
      canonical_value_text: string;
      status: string;
      access_class: string;
      version: number;
    }>(
      `SELECT id AS claim_id, subject_id, predicate, canonical_value_text,
              status, access_class, version
         FROM truth.claims
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[phase6Ids.orphanReplacementClaim, phase6Ids.confidentialReplacementClaim]]
    );
    expect(specializedClaims.rows).toEqual([
      {
        claim_id: phase6Ids.orphanReplacementClaim,
        subject_id: phase6Ids.otherSubject,
        predicate: "activity.outcome",
        canonical_value_text: "Orphan replacement canonical value",
        status: "proposed",
        access_class: "workspace",
        version: 1
      },
      {
        claim_id: phase6Ids.confidentialReplacementClaim,
        subject_id: adoptionIds.subject,
        predicate: "activity.outcome",
        canonical_value_text: "Confidential replacement canonical value",
        status: "proposed",
        access_class: "confidential",
        version: 1
      }
    ]);
    const disabledUserTriggers = await client.query<{ name: string }>(
      `SELECT trigger.tgname AS name
         FROM pg_trigger trigger
        WHERE trigger.tgrelid = 'truth.claims'::regclass
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled <> 'O'
        ORDER BY trigger.tgname`
    );
    expect(disabledUserTriggers.rows).toEqual([]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resetPopulatedPhase6(pool: pg.Pool): Promise<string> {
  await resetPopulatedExact0011(pool);
  await applyMigrations(pool);
  await insertOwnerPhase6ReplacementClaims(pool);
  const provisioned = await withOwnerTransaction(pool, (tx) =>
    provisionProductRelayDirectManagerAccess(tx, {
      tenantId: adoptionIds.tenant,
      workspaceId: adoptionIds.workspace,
      spaceId: adoptionIds.space
    })
  );
  return provisioned.principalId;
}

async function exactLifecycleProtectedDigest(pool: pg.Pool): Promise<string> {
  const snapshot = await pool.query(
    `SELECT
       (SELECT jsonb_agg(to_jsonb(tenant) ORDER BY tenant.id)
          FROM identity.tenants tenant) AS tenants,
       (SELECT jsonb_agg(to_jsonb(workspace) ORDER BY workspace.tenant_id, workspace.id)
          FROM identity.workspaces workspace) AS workspaces,
       (SELECT jsonb_agg(to_jsonb(user_record) ORDER BY user_record.id)
          FROM identity.users user_record) AS users,
       (SELECT jsonb_agg(to_jsonb(person) ORDER BY person.tenant_id, person.workspace_id, person.id)
          FROM identity.people person) AS people,
       (SELECT jsonb_agg(to_jsonb(membership)
          ORDER BY membership.tenant_id, membership.workspace_id, membership.id)
          FROM identity.memberships membership) AS memberships,
       (SELECT jsonb_agg(to_jsonb(policy)
          ORDER BY policy.tenant_id, policy.workspace_id, policy.id)
          FROM identity.policy_versions policy) AS policy_versions,
       (SELECT jsonb_agg(to_jsonb(principal)
          ORDER BY principal.tenant_id, principal.workspace_id, principal.id)
          FROM identity.service_principals principal) AS service_principals,
       (SELECT jsonb_agg(to_jsonb(agent)
          ORDER BY agent.tenant_id, agent.workspace_id, agent.id)
          FROM identity.agent_principals agent) AS agent_principals,
       (SELECT jsonb_agg(to_jsonb(space)
          ORDER BY space.tenant_id, space.workspace_id, space.id)
          FROM access.spaces space) AS spaces,
       (SELECT jsonb_agg(to_jsonb(access_relationship)
          ORDER BY access_relationship.tenant_id, access_relationship.workspace_id,
                   access_relationship.resource_type, access_relationship.resource_id,
                   access_relationship.subject_type, access_relationship.subject_id,
                   access_relationship.relation, access_relationship.id)
          FROM access.access_relationships access_relationship) AS access_relationships,
       (SELECT jsonb_agg(to_jsonb(organization)
          ORDER BY organization.tenant_id, organization.workspace_id, organization.id)
          FROM work.organizations organization) AS organizations,
       (SELECT jsonb_agg(to_jsonb(activity)
          ORDER BY activity.tenant_id, activity.workspace_id, activity.id)
          FROM work.activities activity) AS activities,
       (SELECT jsonb_agg(to_jsonb(initiative)
          ORDER BY initiative.tenant_id, initiative.workspace_id, initiative.id)
          FROM work.initiatives initiative) AS initiatives,
       (SELECT jsonb_agg(to_jsonb(activity_source)
          ORDER BY activity_source.tenant_id, activity_source.workspace_id,
                   activity_source.activity_id, activity_source.source_artifact_id)
          FROM work.activity_sources activity_source) AS activity_sources,
       (SELECT jsonb_agg(to_jsonb(source)
          ORDER BY source.tenant_id, source.workspace_id, source.id)
          FROM content.source_artifacts source) AS source_artifacts,
       (SELECT jsonb_agg(to_jsonb(chunk)
          ORDER BY chunk.tenant_id, chunk.workspace_id, chunk.source_artifact_id,
                   chunk.chunk_index, chunk.id)
          FROM content.source_chunks chunk) AS source_chunks,
       (SELECT jsonb_agg(to_jsonb(command_record)
          ORDER BY command_record.tenant_id, command_record.workspace_id, command_record.id)
          FROM ops.domain_command_records command_record) AS commands,
       (SELECT jsonb_agg(to_jsonb(audit)
          ORDER BY audit.tenant_id, audit.workspace_id, audit.id)
          FROM ops.audit_events audit) AS audits,
       (SELECT jsonb_agg(to_jsonb(outbox)
          ORDER BY outbox.tenant_id, outbox.workspace_id, outbox.id)
          FROM ops.product_outbox_events outbox) AS outbox,
       (SELECT jsonb_agg(to_jsonb(fact) ORDER BY fact.id)
          FROM truth.accepted_facts fact) AS facts,
       (SELECT jsonb_agg(to_jsonb(claim) ORDER BY claim.id)
          FROM truth.claims claim) AS claims,
       (SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence.id)
          FROM truth.verified_evidence_spans evidence) AS evidence,
       (SELECT jsonb_agg(to_jsonb(support) ORDER BY support.fact_id, support.claim_id)
          FROM truth.fact_claims support) AS support,
       (SELECT jsonb_agg(to_jsonb(attestation)
          ORDER BY attestation.tenant_id, attestation.workspace_id, attestation.id)
          FROM truth.initiative_objective_support_attestations attestation)
          AS objective_support_attestations,
       (SELECT jsonb_agg(to_jsonb(recovery)
          ORDER BY recovery.tenant_id, recovery.workspace_id, recovery.id)
          FROM truth.initiative_objective_proposal_recoveries recovery)
          AS objective_proposal_recoveries`
  );
  return JSON.stringify(snapshot.rows[0]);
}

async function exactPhase6FailureSnapshot(pool: pg.Pool): Promise<string> {
  const [snapshot, durable] = await Promise.all([
    pool.query(
      `SELECT
       (SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.id)
          FROM throughline_migrations.journal entry) AS journal,
       to_regclass('truth.fact_lifecycle_events')::text AS lifecycle_relation,
       (SELECT CASE WHEN to_regclass('truth.fact_lifecycle_events') IS NULL THEN NULL
                    ELSE (SELECT count(*)::text FROM truth.fact_lifecycle_events) END)
          AS lifecycle_rows,
       (SELECT jsonb_agg(jsonb_build_object(
          'name', constraint_record.conname,
          'definition', pg_get_constraintdef(constraint_record.oid, false)
        ) ORDER BY constraint_record.conname)
          FROM pg_constraint constraint_record
         WHERE constraint_record.conrelid =
               to_regclass('truth.fact_lifecycle_events')) AS lifecycle_constraints,
       (SELECT jsonb_agg(to_jsonb(relation) ORDER BY namespace.nspname, relation.relname)
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY[
           'identity','access','work','content','ops','truth'
         ])) AS protected_relations,
       (SELECT jsonb_agg(to_jsonb(attribute)
          ORDER BY namespace.nspname, relation.relname, attribute.attnum)
          FROM pg_attribute attribute
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY[
           'identity','access','work','content','ops','truth'
         ])) AS protected_attributes,
       (SELECT jsonb_agg(to_jsonb(constraint_record)
          ORDER BY namespace.nspname, relation.relname, constraint_record.conname)
          FROM pg_constraint constraint_record
          JOIN pg_class relation ON relation.oid = constraint_record.conrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY[
           'identity','access','work','content','ops','truth'
         ])) AS protected_constraints,
       (SELECT jsonb_agg(to_jsonb(index_record)
          ORDER BY namespace.nspname, relation.relname, index_record.indexrelid)
          FROM pg_index index_record
          JOIN pg_class relation ON relation.oid = index_record.indrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY[
           'identity','access','work','content','ops','truth'
         ])) AS protected_indexes,
       (SELECT jsonb_agg(to_jsonb(policy)
          ORDER BY namespace.nspname, relation.relname, policy.polname)
          FROM pg_policy policy
          JOIN pg_class relation ON relation.oid = policy.polrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY[
           'identity','access','work','content','ops','truth'
         ])) AS protected_policies,
       (SELECT jsonb_agg(to_jsonb(trigger_record)
          ORDER BY namespace.nspname, relation.relname, trigger_record.tgname)
          FROM pg_trigger trigger_record
          JOIN pg_class relation ON relation.oid = trigger_record.tgrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY[
           'identity','access','work','content','ops','truth'
         ])) AS protected_triggers,
       (SELECT jsonb_agg(to_jsonb(procedure)
          ORDER BY namespace.nspname, procedure.oid::regprocedure::text)
          FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = ANY(ARRAY[
           'identity','access','work','content','ops','truth'
         ])) AS protected_functions`
    ),
    exactLifecycleProtectedDigest(pool)
  ]);
  return JSON.stringify({ catalog: snapshot.rows[0], durable: JSON.parse(durable) });
}

async function insertLifecycleVisibilityFixture(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE truth.fact_lifecycle_events DISABLE TRIGGER USER");
    await client.query(
      `INSERT INTO truth.fact_lifecycle_events (
         id, tenant_id, workspace_id, space_id, predecessor_fact_id,
         successor_fact_id, transition_kind, from_status, to_status,
         reason_code, reason_rationale, authority_basis, policy_version,
         acted_by_user_id, acted_by_membership_id, causation_command_id,
         recorded_at, version
       ) VALUES (
         $1,$2,$3,$4,$5,NULL,'revoke','current','revoked',
         'no_longer_true','Visibility fixture','activity_owner','default-v1',
         $6,$7,$8,transaction_timestamp(),1
       )`,
      [
        phase6Ids.lifecycle,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.fact,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.factCommand
      ]
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("ALTER TABLE truth.fact_lifecycle_events ENABLE TRIGGER USER");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Phase6AtomicFault =
  | "valid"
  | "missing_lifecycle"
  | "duplicate_lifecycle"
  | "mismatched_lifecycle"
  | "missing_predecessor"
  | "unexpected_successor"
  | "missing_audit"
  | "duplicate_audit"
  | "mismatched_audit"
  | "missing_outbox"
  | "duplicate_outbox"
  | "mismatched_outbox";

type Phase6SupersedeFault =
  | "valid"
  | "valid_confidential_successor"
  | "valid_confidence_lowering"
  | "lowering_requested_successor_omitted"
  | "lowering_omitted_successor_lowered"
  | "lowering_confidence_mismatched"
  | "lowering_reason_code_mismatched"
  | "lowering_rationale_mismatched"
  | "requested_confidence_not_lower"
  | "stored_strongest_mismatched"
  | "stale_subject_version"
  | "stale_replacement_claim_version"
  | "requested_support_omitted"
  | "unrequested_support_persisted"
  | "predecessor_support_appended"
  | "mismatched_response_successor"
  | "missing_lifecycle"
  | "duplicate_lifecycle"
  | "mismatched_lifecycle"
  | "mismatched_lineage"
  | "missing_audit"
  | "duplicate_audit"
  | "mismatched_audit"
  | "missing_outbox"
  | "duplicate_outbox"
  | "mismatched_outbox";

type ExactDatabaseFailure = {
  code: string;
  message: string;
  constraint: string | null;
};

async function expectExactDatabaseFailure(
  operation: Promise<unknown>,
  expected: ExactDatabaseFailure
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const databaseError = caught as Error & { code?: string; constraint?: string };
  expect({
    code: databaseError.code,
    message: databaseError.message,
    constraint: databaseError.constraint ?? null
  }).toEqual(expected);
}

async function exactPhase6AtomicDigest(
  pool: pg.Pool,
  commandId: string = phase6Ids.revokeCommand
): Promise<string> {
  const snapshot = await pool.query(
    `SELECT
       (SELECT jsonb_agg(to_jsonb(fact) ORDER BY fact.id)
          FROM truth.accepted_facts fact) AS facts,
       (SELECT jsonb_agg(to_jsonb(claim) ORDER BY claim.id)
          FROM truth.claims claim) AS claims,
       (SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence.id)
          FROM truth.verified_evidence_spans evidence) AS evidence,
       (SELECT jsonb_agg(to_jsonb(support) ORDER BY support.fact_id, support.claim_id)
          FROM truth.fact_claims support) AS support,
       (SELECT jsonb_agg(to_jsonb(lifecycle) ORDER BY lifecycle.id)
          FROM truth.fact_lifecycle_events lifecycle) AS lifecycle,
       (SELECT jsonb_agg(to_jsonb(command_record) ORDER BY command_record.id)
          FROM ops.domain_command_records command_record
         WHERE command_record.id = $1) AS commands,
       (SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)
          FROM ops.audit_events audit WHERE audit.causation_command_id = $1) AS audit,
       (SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
          FROM ops.product_outbox_events event WHERE event.causation_command_id = $1) AS outbox`,
    [commandId]
  );
  return JSON.stringify(snapshot.rows[0]);
}

async function exactPhase6RollbackDigest(
  pool: pg.Pool,
  commandId: string = phase6Ids.revokeCommand
): Promise<string> {
  return JSON.stringify({
    fullState: JSON.parse(await exactLifecycleProtectedDigest(pool)),
    commandState: JSON.parse(await exactPhase6AtomicDigest(pool, commandId)),
    predecessor: JSON.parse(await exactPredecessorImmutableDigest(pool))
  });
}

async function expectNoPhase6CommandResidue(pool: pg.Pool, commandId: string): Promise<void> {
  const residue = await pool.query<{
    command_count: number;
    lifecycle_count: number;
    audit_count: number;
    outbox_count: number;
    successor_count: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM ops.domain_command_records WHERE id = $1)
         AS command_count,
       (SELECT count(*)::integer FROM truth.fact_lifecycle_events
         WHERE causation_command_id = $1) AS lifecycle_count,
       (SELECT count(*)::integer FROM ops.audit_events
         WHERE causation_command_id = $1) AS audit_count,
       (SELECT count(*)::integer FROM ops.product_outbox_events
         WHERE causation_command_id = $1) AS outbox_count,
       (SELECT count(*)::integer FROM truth.accepted_facts
         WHERE last_causation_command_id = $1) AS successor_count`,
    [commandId]
  );
  expect(residue.rows).toEqual([
    {
      command_count: 0,
      lifecycle_count: 0,
      audit_count: 0,
      outbox_count: 0,
      successor_count: 0
    }
  ]);
}

async function exactPredecessorImmutableDigest(pool: pg.Pool): Promise<string> {
  const snapshot = await pool.query(
    `SELECT
       (SELECT to_jsonb(fact) - ARRAY[
          'status','last_causation_command_id','updated_at','version'
        ] FROM truth.accepted_facts fact WHERE fact.id = $1) AS fact_value,
       (SELECT jsonb_agg(to_jsonb(support) ORDER BY support.claim_id)
          FROM truth.fact_claims support WHERE support.fact_id = $1) AS support,
       (SELECT jsonb_agg(to_jsonb(claim) ORDER BY claim.id)
          FROM truth.claims claim
          JOIN truth.fact_claims support ON support.tenant_id = claim.tenant_id
            AND support.workspace_id = claim.workspace_id
            AND support.claim_id = claim.id
         WHERE support.fact_id = $1) AS claims,
       (SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence.id)
          FROM truth.verified_evidence_spans evidence
          JOIN truth.claims claim ON claim.tenant_id = evidence.tenant_id
            AND claim.workspace_id = evidence.workspace_id
            AND claim.verified_evidence_span_id = evidence.id
          JOIN truth.fact_claims support ON support.tenant_id = claim.tenant_id
            AND support.workspace_id = claim.workspace_id
            AND support.claim_id = claim.id
         WHERE support.fact_id = $1) AS evidence`,
    [adoptionIds.fact]
  );
  return JSON.stringify(snapshot.rows[0]);
}

async function executeForbiddenAcceptedFactMutation(
  pool: pg.Pool,
  mutation: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [adoptionIds.tenant]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [adoptionIds.workspace]);
    await client.query("SELECT set_config('app.space_id', $1, true)", [adoptionIds.space]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [adoptionIds.user]);
    await client.query("SELECT set_config('app.membership_id', $1, true)", [
      adoptionIds.membership
    ]);
    await client.query("SELECT set_config('app.policy_version', 'default-v1', true)");
    await client.query(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash, safe_request,
         state, actor_user_id, actor_membership_id, policy_version_id, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,'fact.revoke.v1',1,'phase6-immutable-probe',repeat('b',64),$5::jsonb,
         'reserved',$6,$7,'default-v1','phase6-immutable-probe',
         '00-00000000000000000000000000000005-0000000000000005-01'
       )`,
      [
        phase6Ids.mutationCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        JSON.stringify({
          factId: adoptionIds.fact,
          expectedFactVersion: 1,
          reason: {
            code: "no_longer_true",
            rationale: "Immutability probe"
          }
        }),
        adoptionIds.user,
        adoptionIds.membership
      ]
    );
    await client.query(
      `UPDATE truth.accepted_facts
          SET status = 'revoked', version = 2,
              last_causation_command_id = $1,
              updated_at = transaction_timestamp(),
              ${mutation}
        WHERE tenant_id = $2 AND workspace_id = $3 AND space_id = $4 AND id = $5`,
      [
        phase6Ids.mutationCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.fact
      ]
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function executeRolledBackStatement(pool: pg.Pool, statement: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(statement);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function executeExactRevokeTransaction(
  appPool: pg.Pool,
  fault: Phase6AtomicFault,
  relayServicePrincipalId: string
): Promise<void> {
  const client = await appPool.connect();
  const request = {
    factId: adoptionIds.fact,
    expectedFactVersion: 1,
    reason: {
      code: "no_longer_true",
      rationale: "The accepted outcome no longer reflects current reality."
    }
  };
  const safeDetail = {
    factId: adoptionIds.fact,
    factVersion: 2,
    reasonCode: "no_longer_true",
    status: "revoked"
  };
  try {
    await client.query("BEGIN");
    const appIdentity = await client.query<{ current_user: string; rolbypassrls: boolean }>(
      `SELECT current_user, rolbypassrls
         FROM pg_roles
        WHERE rolname = current_user
          AND current_user = 'throughline_app'
          AND NOT rolbypassrls`
    );
    expect(appIdentity.rows).toEqual([{ current_user: "throughline_app", rolbypassrls: false }]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [adoptionIds.tenant]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [adoptionIds.workspace]);
    await client.query("SELECT set_config('app.space_id', $1, true)", [adoptionIds.space]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [adoptionIds.user]);
    await client.query("SELECT set_config('app.membership_id', $1, true)", [
      adoptionIds.membership
    ]);
    await client.query("SELECT set_config('app.policy_version', 'default-v1', true)");
    await client.query("SELECT set_config('app.data_class_ceiling', 'confidential', true)");
    await client.query(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash, safe_request,
         actor_user_id, actor_membership_id, policy_version_id, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,'fact.revoke.v1',1,'phase6-revoke',repeat('d',64),$5::jsonb,
         $6,$7,'default-v1','phase6-revoke',
         '00-00000000000000000000000000000004-0000000000000004-01'
       )`,
      [
        phase6Ids.revokeCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        JSON.stringify(request),
        adoptionIds.user,
        adoptionIds.membership
      ]
    );

    if (fault !== "missing_predecessor") {
      await client.query(
        `UPDATE truth.accepted_facts
            SET status = 'revoked', version = 2,
                last_causation_command_id = $1, updated_at = transaction_timestamp()
          WHERE tenant_id = $2 AND workspace_id = $3 AND id = $4`,
        [phase6Ids.revokeCommand, adoptionIds.tenant, adoptionIds.workspace, adoptionIds.fact]
      );
    }

    if (fault !== "missing_lifecycle") {
      await client.query(
        `INSERT INTO truth.fact_lifecycle_events (
           id, tenant_id, workspace_id, space_id, predecessor_fact_id,
           successor_fact_id, transition_kind, from_status, to_status,
           reason_code, reason_rationale, authority_basis, policy_version,
           acted_by_user_id, acted_by_membership_id, causation_command_id,
           recorded_at, version
         ) VALUES (
           $1,$2,$3,$4,$5,$6,'revoke','current','revoked',$7,
           $8,'activity_owner','default-v1',$9,$10,$11,transaction_timestamp(),1
         )`,
        [
          phase6Ids.lifecycle,
          adoptionIds.tenant,
          adoptionIds.workspace,
          adoptionIds.space,
          adoptionIds.fact,
          fault === "unexpected_successor" ? adoptionIds.successor : null,
          fault === "mismatched_lifecycle" ? "support_invalidated" : "no_longer_true",
          request.reason.rationale,
          adoptionIds.user,
          adoptionIds.membership,
          phase6Ids.revokeCommand
        ]
      );
      if (fault === "duplicate_lifecycle") {
        await client.query(
          `INSERT INTO truth.fact_lifecycle_events
             SELECT $1, tenant_id, workspace_id, space_id, predecessor_fact_id,
                    successor_fact_id, transition_kind, from_status, to_status,
                    reason_code, reason_rationale, authority_basis, policy_version,
                    acted_by_user_id, acted_by_membership_id, causation_command_id,
                    recorded_at, version
               FROM truth.fact_lifecycle_events WHERE id = $2`,
          [phase6Ids.duplicateLifecycle, phase6Ids.lifecycle]
        );
      }
    }

    if (fault !== "missing_audit") {
      await client.query(
        `INSERT INTO ops.audit_events (
           id, tenant_id, workspace_id, space_id, causation_command_id,
           action, resource_type, resource_id, actor_user_id, actor_membership_id,
           policy_version_id, request_id, traceparent, audit_schema_version, safe_detail
         ) VALUES (
           $1,$2,$3,$4,$5,'fact.revoke','accepted_fact',$6,$7,$8,'default-v1',
           'phase6-revoke','00-00000000000000000000000000000004-0000000000000004-01',
           1,$9::jsonb
         )`,
        [
          phase6Ids.revokeAudit,
          adoptionIds.tenant,
          adoptionIds.workspace,
          adoptionIds.space,
          phase6Ids.revokeCommand,
          adoptionIds.fact,
          adoptionIds.user,
          adoptionIds.membership,
          JSON.stringify(
            fault === "mismatched_audit"
              ? { ...safeDetail, reasonCode: "entered_in_error" }
              : safeDetail
          )
        ]
      );
      if (fault === "duplicate_audit") {
        await client.query(
          `INSERT INTO ops.audit_events
             SELECT $1, tenant_id, workspace_id, space_id, causation_command_id,
                    action, resource_type, resource_id, actor_user_id, actor_membership_id,
                    delegating_user_id, delegating_membership_id, agent_principal_id,
                    policy_version_id, request_id, traceparent, tracestate,
                    audit_schema_version, safe_detail, created_at
               FROM ops.audit_events WHERE id = $2`,
          [phase6Ids.duplicateAudit, phase6Ids.revokeAudit]
        );
      }
    }

    if (fault !== "missing_outbox") {
      await client.query(
        `INSERT INTO ops.product_outbox_events (
           id, tenant_id, workspace_id, space_id, relay_service_principal_id,
           policy_version_id, event_type, event_schema_version, payload_schema_version,
           aggregate_type, aggregate_id, aggregate_version, causation_command_id,
           payload, request_id, traceparent
         ) VALUES (
           $1,$2,$3,$4,$5,'default-v1','fact.revoked',1,1,
           'accepted_fact',$6,2,$7,$8::jsonb,'phase6-revoke',
           '00-00000000000000000000000000000004-0000000000000004-01'
         )`,
        [
          phase6Ids.revokeOutbox,
          adoptionIds.tenant,
          adoptionIds.workspace,
          adoptionIds.space,
          relayServicePrincipalId,
          adoptionIds.fact,
          phase6Ids.revokeCommand,
          JSON.stringify(
            fault === "mismatched_outbox"
              ? { ...safeDetail, reasonCode: "entered_in_error" }
              : safeDetail
          )
        ]
      );
      if (fault === "duplicate_outbox") {
        await client.query(
          `INSERT INTO ops.product_outbox_events (
             id, tenant_id, workspace_id, space_id, relay_service_principal_id,
             policy_version_id, event_type, event_schema_version, payload_schema_version,
             aggregate_type, aggregate_id, aggregate_version, causation_command_id,
             payload, request_id, traceparent, tracestate
           )
             SELECT $1, tenant_id, workspace_id, space_id, relay_service_principal_id,
                    policy_version_id, event_type, event_schema_version,
                    payload_schema_version, aggregate_type, aggregate_id,
                    aggregate_version, causation_command_id, payload, request_id,
                    traceparent, tracestate
               FROM ops.product_outbox_events WHERE id = $2`,
          [phase6Ids.duplicateOutbox, phase6Ids.revokeOutbox]
        );
      }
    }

    await client.query(
      `UPDATE ops.domain_command_records
          SET state = 'completed', result_resource_type = 'accepted_fact',
              result_resource_id = $1,
              safe_response = $2::jsonb,
              completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $3`,
      [
        adoptionIds.fact,
        JSON.stringify({ factId: adoptionIds.fact, status: "revoked", version: 2 }),
        phase6Ids.revokeCommand
      ]
    );
    await client.query(
      "SET CONSTRAINTS ops.domain_command_records_b2_slice1_atomicity_deferred IMMEDIATE"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function executeExactSupersedeTransaction(
  appPool: pg.Pool,
  fault: Phase6SupersedeFault,
  relayServicePrincipalId: string
): Promise<void> {
  const client = await appPool.connect();
  const rationale = "The later ratified outcome replaces the predecessor.";
  const confidenceLowering = {
    confidence: fault === "requested_confidence_not_lower" ? "strong" : "weak",
    reason: {
      code: "residual_uncertainty",
      rationale: "Residual timing uncertainty warrants a conservative confidence."
    }
  };
  const loweringRequested =
    fault === "valid_confidence_lowering" ||
    fault === "lowering_requested_successor_omitted" ||
    fault === "lowering_confidence_mismatched" ||
    fault === "lowering_reason_code_mismatched" ||
    fault === "lowering_rationale_mismatched" ||
    fault === "requested_confidence_not_lower" ||
    fault === "stored_strongest_mismatched";
  const successorLowered =
    fault === "valid_confidence_lowering" ||
    fault === "lowering_omitted_successor_lowered" ||
    fault === "lowering_confidence_mismatched" ||
    fault === "lowering_reason_code_mismatched" ||
    fault === "lowering_rationale_mismatched" ||
    fault === "requested_confidence_not_lower" ||
    fault === "stored_strongest_mismatched";
  const successorConfidence =
    fault === "lowering_confidence_mismatched"
      ? "unknown"
      : successorLowered
        ? confidenceLowering.confidence
        : "strong";
  const successorLoweringReason =
    fault === "lowering_reason_code_mismatched"
      ? {
          code: "evidence_quality",
          rationale: confidenceLowering.reason.rationale
        }
      : fault === "lowering_rationale_mismatched"
        ? {
            code: confidenceLowering.reason.code,
            rationale: "A different valid rationale must not be accepted."
          }
        : confidenceLowering.reason;
  const successorStrongestConfidence =
    fault === "stored_strongest_mismatched" ? "confirmed" : "strong";
  const replacementClaimId =
    fault === "valid_confidential_successor"
      ? phase6Ids.confidentialReplacementClaim
      : phase6Ids.replacementClaim;
  const safeDetail = {
    factId: adoptionIds.fact,
    factVersion: 2,
    reasonCode: "newer_evidence",
    replacementFactId: adoptionIds.successor,
    replacementFactVersion: 1,
    status: "superseded"
  };
  try {
    await client.query("BEGIN");
    const appIdentity = await client.query<{ current_user: string; rolbypassrls: boolean }>(
      `SELECT current_user, rolbypassrls
         FROM pg_roles
        WHERE rolname = current_user
          AND current_user = 'throughline_app'
          AND NOT rolbypassrls`
    );
    expect(appIdentity.rows).toEqual([{ current_user: "throughline_app", rolbypassrls: false }]);
    for (const [setting, value] of [
      ["app.tenant_id", adoptionIds.tenant],
      ["app.workspace_id", adoptionIds.workspace],
      ["app.space_id", adoptionIds.space],
      ["app.user_id", adoptionIds.user],
      ["app.membership_id", adoptionIds.membership],
      ["app.policy_version", "default-v1"],
      ["app.data_class_ceiling", "confidential"]
    ] as const) {
      await client.query("SELECT set_config($1, $2, true)", [setting, value]);
    }
    const replacementClaims = [
      {
        claimId: replacementClaimId,
        expectedVersion: fault === "stale_replacement_claim_version" ? 2 : 1
      },
      ...(fault === "requested_support_omitted"
        ? [{ claimId: phase6Ids.secondReplacementClaim, expectedVersion: 1 }]
        : [])
    ];
    await client.query(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash, safe_request,
         actor_user_id, actor_membership_id, policy_version_id, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,'fact.supersede.v1',1,'phase6-supersede',repeat('e',64),$5::jsonb,
         $6,$7,'default-v1','phase6-supersede',
         '00-00000000000000000000000000000005-0000000000000005-01'
       )`,
      [
        phase6Ids.supersedeCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        JSON.stringify({
          factId: adoptionIds.fact,
          expectedFactVersion: 1,
          subject: {
            type: "activity",
            id: adoptionIds.subject,
            expectedVersion: fault === "stale_subject_version" ? 2 : 1
          },
          replacementClaims,
          reason: { code: "newer_evidence", rationale },
          ...(loweringRequested ? { confidenceLowering } : {})
        }),
        adoptionIds.user,
        adoptionIds.membership
      ]
    );
    await client.query(
      `UPDATE truth.accepted_facts
          SET status = 'superseded', version = 2,
              last_causation_command_id = $1, updated_at = transaction_timestamp()
        WHERE id = $2`,
      [phase6Ids.supersedeCommand, adoptionIds.fact]
    );
    await client.query(
      `INSERT INTO truth.accepted_facts (
         id, tenant_id, workspace_id, space_id, subject_type, subject_id,
         predicate_catalog_version, predicate, canonical_value_text, value_hash,
         normalized_text, confidence, confidence_rule, strongest_supporting_confidence,
         human_lowered, confidence_lowering_reason_code, confidence_lowering_rationale,
         valid_from, valid_to, recorded_at, status, access_class,
         accepted_by_user_id, accepted_by_membership_id, acceptance_scope,
         authority_basis, acceptance_policy_version, last_causation_command_id,
         created_at, updated_at, version
       ) SELECT
         $1, predecessor.tenant_id, predecessor.workspace_id, predecessor.space_id,
         predecessor.subject_type, $4, predecessor.predicate_catalog_version,
         predecessor.predicate, replacement.canonical_value_text, replacement.value_hash,
         replacement.normalized_text, $6,
         predecessor.confidence_rule, $10,
         $7, $8, $9, replacement.valid_from, replacement.valid_to,
         transaction_timestamp(), 'current', replacement.access_class,
         predecessor.accepted_by_user_id, predecessor.accepted_by_membership_id,
         predecessor.acceptance_scope, predecessor.authority_basis,
         predecessor.acceptance_policy_version, $2,
         transaction_timestamp(), transaction_timestamp(), 1
           FROM truth.accepted_facts predecessor
           JOIN truth.claims replacement
             ON replacement.tenant_id = predecessor.tenant_id
            AND replacement.workspace_id = predecessor.workspace_id
            AND replacement.id = $5
          WHERE predecessor.id = $3`,
      [
        adoptionIds.successor,
        phase6Ids.supersedeCommand,
        adoptionIds.fact,
        fault === "mismatched_lineage" ? phase6Ids.otherSubject : adoptionIds.subject,
        replacementClaimId,
        successorConfidence,
        successorLowered,
        successorLowered ? successorLoweringReason.code : null,
        successorLowered ? successorLoweringReason.rationale : null,
        successorStrongestConfidence
      ]
    );
    await client.query(
      `INSERT INTO truth.fact_claims (
         tenant_id, workspace_id, space_id, fact_id, claim_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        fault === "predecessor_support_appended" ? adoptionIds.fact : adoptionIds.successor,
        replacementClaimId
      ]
    );
    if (fault === "unrequested_support_persisted") {
      await client.query(
        `INSERT INTO truth.fact_claims (
           tenant_id, workspace_id, space_id, fact_id, claim_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          adoptionIds.tenant,
          adoptionIds.workspace,
          adoptionIds.space,
          adoptionIds.successor,
          phase6Ids.secondReplacementClaim
        ]
      );
    }
    await client.query(
      `UPDATE truth.claims
          SET status = 'accepted', version = 2,
              updated_at = transaction_timestamp()
        WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3 AND id = $4`,
      [adoptionIds.tenant, adoptionIds.workspace, adoptionIds.space, replacementClaimId]
    );
    if (fault !== "missing_lifecycle") {
      await client.query(
        `INSERT INTO truth.fact_lifecycle_events (
           id, tenant_id, workspace_id, space_id, predecessor_fact_id,
           successor_fact_id, transition_kind, from_status, to_status,
           reason_code, reason_rationale, authority_basis, policy_version,
           acted_by_user_id, acted_by_membership_id, causation_command_id,
           recorded_at, version
         ) VALUES (
           $1,$2,$3,$4,$5,$6,'supersede','current','superseded',$7,$8,
           'activity_owner','default-v1',$9,$10,$11,transaction_timestamp(),1
         )`,
        [
          phase6Ids.supersedeLifecycle,
          adoptionIds.tenant,
          adoptionIds.workspace,
          adoptionIds.space,
          adoptionIds.fact,
          adoptionIds.successor,
          fault === "mismatched_lifecycle" ? "accepted_value_changed" : "newer_evidence",
          rationale,
          adoptionIds.user,
          adoptionIds.membership,
          phase6Ids.supersedeCommand
        ]
      );
      if (fault === "duplicate_lifecycle") {
        await client.query(
          `INSERT INTO truth.fact_lifecycle_events
             SELECT $1, tenant_id, workspace_id, space_id, predecessor_fact_id,
                    successor_fact_id, transition_kind, from_status, to_status,
                    reason_code, reason_rationale, authority_basis, policy_version,
                    acted_by_user_id, acted_by_membership_id, causation_command_id,
                    recorded_at, version
               FROM truth.fact_lifecycle_events WHERE id = $2`,
          [phase6Ids.duplicateLifecycle, phase6Ids.supersedeLifecycle]
        );
      }
    }
    if (fault !== "missing_audit") {
      await client.query(
        `INSERT INTO ops.audit_events (
           id, tenant_id, workspace_id, space_id, causation_command_id,
           action, resource_type, resource_id, actor_user_id, actor_membership_id,
           policy_version_id, request_id, traceparent, audit_schema_version, safe_detail
         ) VALUES (
           $1,$2,$3,$4,$5,'fact.supersede','accepted_fact',$6,$7,$8,'default-v1',
           'phase6-supersede','00-00000000000000000000000000000005-0000000000000005-01',
           1,$9::jsonb
         )`,
        [
          phase6Ids.supersedeAudit,
          adoptionIds.tenant,
          adoptionIds.workspace,
          adoptionIds.space,
          phase6Ids.supersedeCommand,
          adoptionIds.fact,
          adoptionIds.user,
          adoptionIds.membership,
          JSON.stringify(
            fault === "mismatched_audit"
              ? { ...safeDetail, reasonCode: "accepted_value_changed" }
              : safeDetail
          )
        ]
      );
      if (fault === "duplicate_audit") {
        await client.query(
          `INSERT INTO ops.audit_events
             SELECT $1, tenant_id, workspace_id, space_id, causation_command_id,
                    action, resource_type, resource_id, actor_user_id, actor_membership_id,
                    delegating_user_id, delegating_membership_id, agent_principal_id,
                    policy_version_id, request_id, traceparent, tracestate,
                    audit_schema_version, safe_detail, created_at
               FROM ops.audit_events WHERE id = $2`,
          [phase6Ids.duplicateAudit, phase6Ids.supersedeAudit]
        );
      }
    }
    if (fault !== "missing_outbox") {
      await client.query(
        `INSERT INTO ops.product_outbox_events (
           id, tenant_id, workspace_id, space_id, relay_service_principal_id,
           policy_version_id, event_type, event_schema_version, payload_schema_version,
           aggregate_type, aggregate_id, aggregate_version, causation_command_id,
           payload, request_id, traceparent
         ) VALUES (
           $1,$2,$3,$4,$5,'default-v1','fact.superseded',1,1,
           'accepted_fact',$6,2,$7,$8::jsonb,'phase6-supersede',
           '00-00000000000000000000000000000005-0000000000000005-01'
         )`,
        [
          phase6Ids.supersedeOutbox,
          adoptionIds.tenant,
          adoptionIds.workspace,
          adoptionIds.space,
          relayServicePrincipalId,
          adoptionIds.fact,
          phase6Ids.supersedeCommand,
          JSON.stringify(
            fault === "mismatched_outbox"
              ? { ...safeDetail, reasonCode: "accepted_value_changed" }
              : safeDetail
          )
        ]
      );
      if (fault === "duplicate_outbox") {
        await client.query(
          `INSERT INTO ops.product_outbox_events (
             id, tenant_id, workspace_id, space_id, relay_service_principal_id,
             policy_version_id, event_type, event_schema_version, payload_schema_version,
             aggregate_type, aggregate_id, aggregate_version, causation_command_id,
             payload, request_id, traceparent, tracestate
           )
             SELECT $1, tenant_id, workspace_id, space_id, relay_service_principal_id,
                    policy_version_id, event_type, event_schema_version,
                    payload_schema_version, aggregate_type, aggregate_id,
                    aggregate_version, causation_command_id, payload, request_id,
                    traceparent, tracestate
               FROM ops.product_outbox_events WHERE id = $2`,
          [phase6Ids.duplicateOutbox, phase6Ids.supersedeOutbox]
        );
      }
    }
    await client.query(
      `UPDATE ops.domain_command_records
          SET state = 'completed', result_resource_type = 'accepted_fact',
              result_resource_id = $1, safe_response = $2::jsonb,
              completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $3`,
      [
        adoptionIds.fact,
        JSON.stringify({
          factId: adoptionIds.fact,
          version: 2,
          status: "superseded",
          replacementFactId:
            fault === "mismatched_response_successor"
              ? phase6Ids.mismatchedResponseSuccessor
              : adoptionIds.successor,
          replacementFactVersion: 1,
          replacementFactStatus: "current"
        }),
        phase6Ids.supersedeCommand
      ]
    );
    await client.query("SET CONSTRAINTS truth.accepted_facts_support_deferred IMMEDIATE");
    await client.query(
      "SET CONSTRAINTS ops.domain_command_records_b2_slice1_atomicity_deferred IMMEDIATE"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function executeExactSecondSupersedeTransaction(
  appPool: pg.Pool,
  relayServicePrincipalId: string
): Promise<void> {
  const client = await appPool.connect();
  const rationale = "A later ratified outcome replaces the first successor.";
  const safeDetail = {
    factId: adoptionIds.successor,
    factVersion: 2,
    reasonCode: "newer_evidence",
    replacementFactId: phase6Ids.chainSuccessor,
    replacementFactVersion: 1,
    status: "superseded"
  };
  try {
    await client.query("BEGIN");
    for (const [setting, value] of [
      ["app.tenant_id", adoptionIds.tenant],
      ["app.workspace_id", adoptionIds.workspace],
      ["app.space_id", adoptionIds.space],
      ["app.user_id", adoptionIds.user],
      ["app.membership_id", adoptionIds.membership],
      ["app.policy_version", "default-v1"],
      ["app.data_class_ceiling", "confidential"]
    ] as const) {
      await client.query("SELECT set_config($1, $2, true)", [setting, value]);
    }
    await client.query(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash, safe_request,
         actor_user_id, actor_membership_id, policy_version_id, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,'fact.supersede.v1',1,'phase6-chain-supersede',repeat('f',64),$5::jsonb,
         $6,$7,'default-v1','phase6-chain-supersede',
         '00-00000000000000000000000000000006-0000000000000006-01'
       )`,
      [
        phase6Ids.chainCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        JSON.stringify({
          factId: adoptionIds.successor,
          expectedFactVersion: 1,
          subject: { type: "activity", id: adoptionIds.subject, expectedVersion: 1 },
          replacementClaims: [{ claimId: phase6Ids.secondReplacementClaim, expectedVersion: 1 }],
          reason: { code: "newer_evidence", rationale }
        }),
        adoptionIds.user,
        adoptionIds.membership
      ]
    );
    await client.query(
      `UPDATE truth.accepted_facts
          SET status = 'superseded', version = 2,
              last_causation_command_id = $1, updated_at = transaction_timestamp()
        WHERE tenant_id = $2 AND workspace_id = $3 AND space_id = $4 AND id = $5`,
      [
        phase6Ids.chainCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.successor
      ]
    );
    await client.query(
      `INSERT INTO truth.accepted_facts (
         id, tenant_id, workspace_id, space_id, subject_type, subject_id,
         predicate_catalog_version, predicate, canonical_value_text, value_hash,
         normalized_text, confidence, confidence_rule, strongest_supporting_confidence,
         human_lowered, confidence_lowering_reason_code, confidence_lowering_rationale,
         valid_from, valid_to, recorded_at, status, access_class,
         accepted_by_user_id, accepted_by_membership_id, acceptance_scope,
         authority_basis, acceptance_policy_version, last_causation_command_id,
         created_at, updated_at, version
       ) SELECT
         $1, predecessor.tenant_id, predecessor.workspace_id, predecessor.space_id,
         predecessor.subject_type, predecessor.subject_id, predecessor.predicate_catalog_version,
         predecessor.predicate, replacement.canonical_value_text, replacement.value_hash,
         replacement.normalized_text, replacement.confidence,
         predecessor.confidence_rule, replacement.confidence,
         false, NULL, NULL, replacement.valid_from, replacement.valid_to,
         transaction_timestamp(), 'current', replacement.access_class,
         predecessor.accepted_by_user_id, predecessor.accepted_by_membership_id,
         predecessor.acceptance_scope, predecessor.authority_basis,
         predecessor.acceptance_policy_version, $2,
         transaction_timestamp(), transaction_timestamp(), 1
           FROM truth.accepted_facts predecessor
           JOIN truth.claims replacement
             ON replacement.tenant_id = predecessor.tenant_id
            AND replacement.workspace_id = predecessor.workspace_id
            AND replacement.id = $4
          WHERE predecessor.tenant_id = $5
            AND predecessor.workspace_id = $6
            AND predecessor.space_id = $7
            AND predecessor.id = $3`,
      [
        phase6Ids.chainSuccessor,
        phase6Ids.chainCommand,
        adoptionIds.successor,
        phase6Ids.secondReplacementClaim,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space
      ]
    );
    await client.query(
      `INSERT INTO truth.fact_claims (
         tenant_id, workspace_id, space_id, fact_id, claim_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        phase6Ids.chainSuccessor,
        phase6Ids.secondReplacementClaim
      ]
    );
    await client.query(
      `UPDATE truth.claims
          SET status = 'accepted', version = 2,
              updated_at = transaction_timestamp()
        WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3 AND id = $4`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        phase6Ids.secondReplacementClaim
      ]
    );
    await client.query(
      `INSERT INTO truth.fact_lifecycle_events (
         id, tenant_id, workspace_id, space_id, predecessor_fact_id,
         successor_fact_id, transition_kind, from_status, to_status,
         reason_code, reason_rationale, authority_basis, policy_version,
         acted_by_user_id, acted_by_membership_id, causation_command_id,
         recorded_at, version
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'supersede','current','superseded',
         'newer_evidence',$7,'activity_owner','default-v1',
         $8,$9,$10,transaction_timestamp(),1
       )`,
      [
        phase6Ids.chainLifecycle,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.successor,
        phase6Ids.chainSuccessor,
        rationale,
        adoptionIds.user,
        adoptionIds.membership,
        phase6Ids.chainCommand
      ]
    );
    await client.query(
      `INSERT INTO ops.audit_events (
         id, tenant_id, workspace_id, space_id, causation_command_id,
         action, resource_type, resource_id, actor_user_id, actor_membership_id,
         policy_version_id, request_id, traceparent, audit_schema_version, safe_detail
       ) VALUES (
         $1,$2,$3,$4,$5,'fact.supersede','accepted_fact',$6,$7,$8,'default-v1',
         'phase6-chain-supersede',
         '00-00000000000000000000000000000006-0000000000000006-01',1,$9::jsonb
       )`,
      [
        phase6Ids.chainAudit,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        phase6Ids.chainCommand,
        adoptionIds.successor,
        adoptionIds.user,
        adoptionIds.membership,
        JSON.stringify(safeDetail)
      ]
    );
    await client.query(
      `INSERT INTO ops.product_outbox_events (
         id, tenant_id, workspace_id, space_id, relay_service_principal_id,
         policy_version_id, event_type, event_schema_version, payload_schema_version,
         aggregate_type, aggregate_id, aggregate_version, causation_command_id,
         payload, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,$5,'default-v1','fact.superseded',1,1,
         'accepted_fact',$6,2,$7,$8::jsonb,'phase6-chain-supersede',
         '00-00000000000000000000000000000006-0000000000000006-01'
       )`,
      [
        phase6Ids.chainOutbox,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        relayServicePrincipalId,
        adoptionIds.successor,
        phase6Ids.chainCommand,
        JSON.stringify(safeDetail)
      ]
    );
    await client.query(
      `UPDATE ops.domain_command_records
          SET state = 'completed', result_resource_type = 'accepted_fact',
              result_resource_id = $1, safe_response = $2::jsonb,
              completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $3`,
      [
        adoptionIds.successor,
        JSON.stringify({
          factId: adoptionIds.successor,
          version: 2,
          status: "superseded",
          replacementFactId: phase6Ids.chainSuccessor,
          replacementFactVersion: 1,
          replacementFactStatus: "current"
        }),
        phase6Ids.chainCommand
      ]
    );
    await client.query("SET CONSTRAINTS truth.accepted_facts_support_deferred IMMEDIATE");
    await client.query(
      "SET CONSTRAINTS ops.domain_command_records_b2_slice1_atomicity_deferred IMMEDIATE"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function executeOrphanSuccessorInsert(
  appPool: pg.Pool,
  predecessorFault: "nonexistent" | "unrelated"
): Promise<void> {
  const client = await appPool.connect();
  const factId =
    predecessorFault === "nonexistent" ? phase6Ids.nonexistentPredecessor : adoptionIds.fact;
  try {
    await client.query("BEGIN");
    for (const [setting, value] of [
      ["app.tenant_id", adoptionIds.tenant],
      ["app.workspace_id", adoptionIds.workspace],
      ["app.space_id", adoptionIds.space],
      ["app.user_id", adoptionIds.user],
      ["app.membership_id", adoptionIds.membership],
      ["app.policy_version", "default-v1"],
      ["app.data_class_ceiling", "confidential"]
    ] as const) {
      await client.query("SELECT set_config($1, $2, true)", [setting, value]);
    }
    await client.query(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash, safe_request,
         actor_user_id, actor_membership_id, policy_version_id, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,'fact.supersede.v1',1,'phase6-orphan-supersede',repeat('9',64),$5::jsonb,
         $6,$7,'default-v1','phase6-orphan-supersede',
         '00-00000000000000000000000000000007-0000000000000007-01'
       )`,
      [
        phase6Ids.orphanCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        JSON.stringify({
          factId,
          expectedFactVersion: 1,
          subject: { type: "activity", id: phase6Ids.otherSubject, expectedVersion: 1 },
          replacementClaims: [{ claimId: phase6Ids.orphanReplacementClaim, expectedVersion: 1 }],
          reason: {
            code: "newer_evidence",
            rationale: "An orphan successor must never establish a current coordinate."
          }
        }),
        adoptionIds.user,
        adoptionIds.membership
      ]
    );
    await client.query(
      `INSERT INTO truth.accepted_facts (
         id, tenant_id, workspace_id, space_id, subject_type, subject_id,
         predicate_catalog_version, predicate, canonical_value_text, value_hash,
         normalized_text, confidence, confidence_rule, strongest_supporting_confidence,
         human_lowered, recorded_at, status, access_class,
         accepted_by_user_id, accepted_by_membership_id, acceptance_scope,
         authority_basis, acceptance_policy_version, last_causation_command_id, version
       ) SELECT
         $1, claim.tenant_id, claim.workspace_id, claim.space_id,
         claim.subject_type, claim.subject_id, claim.predicate_catalog_version,
         claim.predicate, claim.canonical_value_text, claim.value_hash,
         claim.normalized_text, claim.confidence, 'strongest-selected-valid-claim.v1',
         claim.confidence, false, transaction_timestamp(), 'current', claim.access_class,
         $2,$3,'engagement','activity_owner','default-v1',$4,1
           FROM truth.claims claim
          WHERE claim.tenant_id = $5
            AND claim.workspace_id = $6
            AND claim.space_id = $7
            AND claim.id = $8
            AND claim.subject_type = 'activity'
            AND claim.subject_id = $9
            AND claim.predicate = 'activity.outcome'
            AND claim.status = 'proposed'
            AND claim.version = 1`,
      [
        phase6Ids.orphanSuccessor,
        adoptionIds.user,
        adoptionIds.membership,
        phase6Ids.orphanCommand,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        phase6Ids.orphanReplacementClaim,
        phase6Ids.otherSubject
      ]
    );
    throw new Error("orphan successor INSERT unexpectedly succeeded");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertExact0008TruthFixture(pool: pg.Pool): Promise<void> {
  await seedWaveA2DeterministicData(pool);
  const client = await pool.connect();
  const text = "Adopted canonical value";
  const sourceText = "Adopted evidence";
  try {
    await client.query("BEGIN");
    for (const relation of [
      "work.organizations",
      "work.initiatives",
      "work.activities",
      "work.activity_sources",
      "content.source_artifacts",
      "content.source_chunks",
      "ops.domain_command_records",
      "truth.verified_evidence_spans",
      "truth.claims",
      "truth.accepted_facts",
      "truth.fact_claims"
    ]) {
      await client.query(`ALTER TABLE ${relation} DISABLE TRIGGER USER`);
    }
    await client.query(
      `INSERT INTO work.organizations (
         id, tenant_id, workspace_id, space_id, name, normalized_name, status
       ) VALUES ($1,$2,$3,$4,'Adoption Organization','adoption organization','active')`,
      [adoptionIds.organization, adoptionIds.tenant, adoptionIds.workspace, adoptionIds.space]
    );
    await client.query(
      `INSERT INTO work.activities (
         id, tenant_id, workspace_id, space_id, subtype, profile_template_key,
         title, status, owner_person_id, governing_organization_id
       ) VALUES (
         $1,$2,$3,$4,'meeting','meeting','Adoption Activity','captured',$5,$6
       )`,
      [
        adoptionIds.subject,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.person,
        adoptionIds.organization
      ]
    );
    await client.query(
      `INSERT INTO work.activities (
         id, tenant_id, workspace_id, space_id, subtype, profile_template_key,
         title, status, owner_person_id, governing_organization_id
       ) VALUES (
         $1,$2,$3,$4,'meeting','meeting','Mismatched lineage subject','captured',$5,$6
       )`,
      [
        phase6Ids.otherSubject,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.person,
        adoptionIds.organization
      ]
    );
    await client.query(
      `INSERT INTO work.initiatives (
         id, tenant_id, workspace_id, space_id, title, type_key, stage_key, health,
         owner_person_id, profile_id, profile_version, version
       ) VALUES (
         $1,$2,$3,$4,'Adoption Initiative','delivery','active','active',$5,
         'ai-solutions','v1',1
       )`,
      [
        adoptionIds.initiative,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.person
      ]
    );
    await client.query(
      `INSERT INTO content.source_artifacts (
         id, tenant_id, workspace_id, space_id, source_type, trust_class,
         immutable_text, content_hash, normalization_version, chunking_version,
         normalized_content_hash, hash_retention_policy, captured_by_user_id,
         captured_by_membership_id, access_class, source_snapshot_policy, version
       ) VALUES (
         $1,$2,$3,$4,'note','untrusted_user_content',$5,
         encode(public.digest(convert_to($5, 'UTF8'), 'sha256'), 'hex'),
         'source-normalization.v1','source-chunking.v1',
         encode(public.digest(convert_to($5, 'UTF8'), 'sha256'), 'hex'),
         'retain',$6,$7,'workspace','full_snapshot',1
       )`,
      [
        adoptionIds.source,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        sourceText,
        adoptionIds.user,
        adoptionIds.membership
      ]
    );
    await client.query(
      `INSERT INTO content.source_chunks (
         id, tenant_id, workspace_id, space_id, source_artifact_id,
         normalization_version, chunking_version, chunk_index,
         start_offset, end_offset, normalized_text, content_hash, access_class
       ) VALUES (
         $1,$2,$3,$4,$6,'source-normalization.v1','source-chunking.v1',
         0,0,char_length($5),$5,
         encode(public.digest(convert_to($5, 'UTF8'), 'sha256'), 'hex'),'workspace'
       )`,
      [
        adoptionIds.chunk,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        sourceText,
        adoptionIds.source
      ]
    );
    await client.query(
      `INSERT INTO work.activity_sources (
         tenant_id, workspace_id, space_id, activity_id, source_artifact_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        adoptionIds.source
      ]
    );
    await client.query(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash, state,
         actor_user_id, actor_membership_id, policy_version_id, request_id, traceparent
       ) VALUES (
         $1,$2,$3,$4,'claim.create.v1',1,'exact-0008-adoption',repeat('a',64),'reserved',
         $5,$6,'default-v1','exact-0008-adoption',
         '00-00000000000000000000000000000001-0000000000000001-01'
       ), (
         $7,$2,$3,$4,'fact.accept.v1',1,'exact-0008-fact',repeat('b',64),'reserved',
         $5,$6,'default-v1','exact-0008-fact',
         '00-00000000000000000000000000000002-0000000000000002-01'
       ), (
         $8,$2,$3,$4,'claim.create.v1',1,'exact-0008-objective',repeat('c',64),'reserved',
         $5,$6,'default-v1','exact-0008-objective',
         '00-00000000000000000000000000000003-0000000000000003-01'
       )`,
      [
        adoptionIds.command,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.factCommand,
        adoptionIds.objectiveCommand
      ]
    );
    await client.query(
      `INSERT INTO truth.verified_evidence_spans (
         id, tenant_id, workspace_id, space_id, source_artifact_id, source_chunk_id,
         source_version, chunk_version, normalization_version, chunking_version,
         source_start_offset, source_end_offset, source_excerpt,
         source_content_hash, source_normalized_content_hash, chunk_content_hash,
         excerpt_hash, access_class, created_by_user_id, created_by_membership_id,
         causation_command_id
       ) SELECT
         $1,$2,$3,$4,$5,$6,1,1,'source-normalization.v1','source-chunking.v1',
         0,char_length(source.immutable_text),source.immutable_text,
         source.content_hash,source.normalized_content_hash,chunk.content_hash,
         encode(public.digest(convert_to(source.immutable_text, 'UTF8'), 'sha256'), 'hex'),
         'workspace',$7,$8,$9
       FROM content.source_artifacts source
       JOIN content.source_chunks chunk ON chunk.source_artifact_id = source.id
       WHERE source.id = $5 AND chunk.id = $6`,
      [
        adoptionIds.evidence,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.source,
        adoptionIds.chunk,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.command
      ]
    );
    await client.query(
      `INSERT INTO truth.verified_evidence_spans (
         id, tenant_id, workspace_id, space_id, source_artifact_id, source_chunk_id,
         source_version, chunk_version, normalization_version, chunking_version,
         source_start_offset, source_end_offset, source_excerpt,
         source_content_hash, source_normalized_content_hash, chunk_content_hash,
         excerpt_hash, access_class, created_by_user_id, created_by_membership_id,
         causation_command_id
       ) SELECT
         $1,tenant_id,workspace_id,space_id,source_artifact_id,source_chunk_id,
         source_version,chunk_version,normalization_version,chunking_version,
         source_start_offset,source_end_offset,source_excerpt,
         source_content_hash,source_normalized_content_hash,chunk_content_hash,
         excerpt_hash,access_class,created_by_user_id,created_by_membership_id,$2
       FROM truth.verified_evidence_spans WHERE id = $3`,
      [adoptionIds.objectiveEvidence, adoptionIds.objectiveCommand, adoptionIds.evidence]
    );
    await client.query(
      `INSERT INTO truth.claims (
         id,tenant_id,workspace_id,space_id,subject_type,subject_id,
         predicate_catalog_version,predicate,value_json,value_hash,normalized_text,
         verified_evidence_span_id,asserted_by_type,asserted_by_id,confidence,status,
         access_class,created_by_user_id,created_by_membership_id,causation_command_id,version
       ) VALUES (
         $1,$2,$3,$4,'activity',$5,'truth-predicate-catalog.v1','activity.outcome',
         to_jsonb($6::text),encode(public.digest(convert_to(to_jsonb($6::text)::text,'UTF8'),'sha256'),'hex'),
         $6,$7,'person',$8,'strong','accepted','workspace',$9,$10,$11,2
       )`,
      [
        adoptionIds.claim,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        text,
        adoptionIds.evidence,
        adoptionIds.person,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.command
      ]
    );
    await client.query(
      `INSERT INTO truth.claims (
         id,tenant_id,workspace_id,space_id,subject_type,subject_id,
         predicate_catalog_version,predicate,value_json,value_hash,normalized_text,
         verified_evidence_span_id,asserted_by_type,asserted_by_id,confidence,status,
         access_class,created_by_user_id,created_by_membership_id,causation_command_id,version
       ) VALUES (
         $1,$2,$3,$4,'initiative',$5,'truth-predicate-catalog.v1',
         'initiative.primary_objective',to_jsonb($6::text),
         encode(public.digest(convert_to(to_jsonb($6::text)::text,'UTF8'),'sha256'),'hex'),
         $6,$7,'person',$8,'strong','proposed','workspace',$9,$10,$11,1
       )`,
      [
        adoptionIds.objectiveClaim,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.initiative,
        "Adopted primary objective",
        adoptionIds.objectiveEvidence,
        adoptionIds.person,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.objectiveCommand
      ]
    );
    await client.query(
      `INSERT INTO truth.accepted_facts (
         id,tenant_id,workspace_id,space_id,subject_type,subject_id,
         predicate_catalog_version,predicate,value_json,value_hash,normalized_text,
         confidence,confidence_rule,strongest_supporting_confidence,human_lowered,
         recorded_at,status,access_class,accepted_by_user_id,accepted_by_membership_id,
         acceptance_scope,authority_basis,acceptance_policy_version,last_causation_command_id
       ) VALUES (
         $1,$2,$3,$4,'activity',$5,'truth-predicate-catalog.v1','activity.outcome',
         to_jsonb($6::text),encode(public.digest(convert_to(to_jsonb($6::text)::text,'UTF8'),'sha256'),'hex'),
         $6,'strong','strongest-selected-valid-claim.v1','strong',false,clock_timestamp(),
         'current','workspace',$7,$8,'engagement','activity_owner','default-v1',$9
       )`,
      [
        adoptionIds.fact,
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.subject,
        text,
        adoptionIds.user,
        adoptionIds.membership,
        adoptionIds.factCommand
      ]
    );
    await client.query(
      `INSERT INTO truth.fact_claims (
         tenant_id,workspace_id,space_id,fact_id,claim_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        adoptionIds.tenant,
        adoptionIds.workspace,
        adoptionIds.space,
        adoptionIds.fact,
        adoptionIds.claim
      ]
    );
    for (const relation of [
      "truth.fact_claims",
      "truth.accepted_facts",
      "truth.claims",
      "truth.verified_evidence_spans",
      "ops.domain_command_records",
      "content.source_chunks",
      "content.source_artifacts",
      "work.activity_sources",
      "work.activities",
      "work.initiatives",
      "work.organizations"
    ]) {
      await client.query(`ALTER TABLE ${relation} ENABLE TRIGGER USER`);
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sqlLiteral(value: unknown): string {
  if (typeof value !== "string") throw new Error("SQL test fixture must be a string");
  return `'${value.replaceAll("'", "''")}'`;
}

async function mutateExact0008Evidence(
  pool: pg.Pool,
  mutation: "correction" | "retained" | "erased" | "missing_chunk"
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    if (mutation === "missing_chunk") {
      await client.query("DELETE FROM content.source_chunks WHERE id = $1", [adoptionIds.chunk]);
    } else if (mutation === "correction") {
      await client.query(
        `INSERT INTO content.source_artifacts (
           id,tenant_id,workspace_id,space_id,source_type,trust_class,immutable_text,
           content_hash,normalization_version,chunking_version,normalized_content_hash,
           hash_retention_policy,supersedes_source_id,captured_by_user_id,
           captured_by_membership_id,access_class,source_snapshot_policy,version
         ) SELECT
           $1,tenant_id,workspace_id,space_id,source_type,trust_class,'Corrected evidence',
           encode(public.digest(convert_to('Corrected evidence','UTF8'),'sha256'),'hex'),
           normalization_version,chunking_version,
           encode(public.digest(convert_to('Corrected evidence','UTF8'),'sha256'),'hex'),
           hash_retention_policy,id,captured_by_user_id,captured_by_membership_id,
           access_class,source_snapshot_policy,1
         FROM content.source_artifacts WHERE id = $2`,
        [adoptionIds.successor, adoptionIds.source]
      );
    } else {
      const erased = mutation === "erased";
      await client.query(
        `UPDATE content.source_artifacts
            SET immutable_text = NULL,
                content_hash = CASE WHEN $2 THEN NULL ELSE content_hash END,
                normalized_content_hash = CASE WHEN $2 THEN NULL ELSE normalized_content_hash END,
                hash_retention_policy = CASE WHEN $2 THEN 'erase_on_tombstone' ELSE 'retain' END,
                deleted_at = clock_timestamp(), deletion_reason = 'retention',
                deletion_policy_ref = 'policy:adoption',
                hash_disposition = CASE WHEN $2 THEN 'erased' ELSE 'retained' END,
                version = 2, updated_at = clock_timestamp()
          WHERE id = $1`,
        [adoptionIds.source, erased]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function exact0008Digest(pool: pg.Pool): Promise<string> {
  const relations = [
    "content.source_artifacts",
    "content.source_chunks",
    "truth.verified_evidence_spans",
    "truth.claims",
    "truth.accepted_facts",
    "truth.fact_claims"
  ];
  const rows = [];
  for (const relation of relations) {
    const result = await pool.query(
      `SELECT to_jsonb(row_data) AS row FROM ${relation} row_data ORDER BY to_jsonb(row_data)::text`
    );
    rows.push([relation, result.rows]);
  }
  return JSON.stringify(rows);
}

async function exact0008RowCounts(pool: pg.Pool): Promise<{
  evidence: string;
  claims: string;
  facts: string;
  support: string;
}> {
  const result = await pool.query<{
    evidence: string;
    claims: string;
    facts: string;
    support: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM truth.verified_evidence_spans) AS evidence,
       (SELECT count(*)::text FROM truth.claims) AS claims,
       (SELECT count(*)::text FROM truth.accepted_facts) AS facts,
       (SELECT count(*)::text FROM truth.fact_claims) AS support`
  );
  return result.rows[0]!;
}

async function exact0008StableHistory(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ history: unknown }>(
    `SELECT jsonb_build_object(
       'commands', (SELECT jsonb_agg(
         to_jsonb(command) - ARRAY['safe_request','safe_request_adopted']::text[]
         ORDER BY command.id)
         FROM ops.domain_command_records command),
       'evidence', (SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence.id)
         FROM truth.verified_evidence_spans evidence),
       'claims', (SELECT jsonb_agg(
         to_jsonb(claim) - ARRAY['value_json','canonical_value_text','value_hash']::text[]
         ORDER BY claim.id) FROM truth.claims claim),
       'facts', (SELECT jsonb_agg(
         to_jsonb(fact) - ARRAY['value_json','canonical_value_text','value_hash']::text[]
         ORDER BY fact.id) FROM truth.accepted_facts fact),
       'support', (SELECT jsonb_agg(to_jsonb(support) ORDER BY support.fact_id, support.claim_id)
         FROM truth.fact_claims support),
       'sources', (SELECT jsonb_agg(to_jsonb(source) ORDER BY source.id)
         FROM content.source_artifacts source),
       'chunks', (SELECT jsonb_agg(to_jsonb(chunk) ORDER BY chunk.id)
         FROM content.source_chunks chunk),
       'activities', (SELECT jsonb_agg(to_jsonb(activity) ORDER BY activity.id)
         FROM work.activities activity),
       'initiatives', (SELECT jsonb_agg(to_jsonb(initiative) ORDER BY initiative.id)
         FROM work.initiatives initiative),
       'organizations', (SELECT jsonb_agg(to_jsonb(organization) ORDER BY organization.id)
         FROM work.organizations organization)
     ) AS history`
  );
  return JSON.stringify(result.rows[0]!.history);
}

async function expectExact0008ReferencesValid(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const result = await client.query<{ invalid_references: string }>(
      `SELECT (
         (SELECT count(*) FROM content.source_artifacts source
           LEFT JOIN identity.workspaces workspace
             ON (workspace.tenant_id, workspace.id) =
                (source.tenant_id, source.workspace_id)
           LEFT JOIN access.spaces space
             ON (space.tenant_id, space.workspace_id, space.id) =
                (source.tenant_id, source.workspace_id, source.space_id)
           LEFT JOIN identity.users actor ON actor.id = source.captured_by_user_id
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (source.tenant_id, source.workspace_id,
                 source.captured_by_membership_id, source.captured_by_user_id)
           LEFT JOIN content.source_artifacts predecessor
             ON (predecessor.tenant_id, predecessor.workspace_id, predecessor.space_id,
                 predecessor.id) =
                (source.tenant_id, source.workspace_id, source.space_id,
                 source.supersedes_source_id)
          WHERE workspace.id IS NULL OR space.id IS NULL OR actor.id IS NULL
             OR membership.id IS NULL
             OR (source.supersedes_source_id IS NOT NULL AND predecessor.id IS NULL))
         +
         (SELECT count(*) FROM content.source_chunks chunk
           LEFT JOIN content.source_artifacts source
             ON (source.tenant_id, source.workspace_id, source.space_id, source.id) =
                (chunk.tenant_id, chunk.workspace_id, chunk.space_id,
                 chunk.source_artifact_id)
          WHERE source.id IS NULL)
         +
         (SELECT count(*) FROM truth.verified_evidence_spans evidence
           LEFT JOIN content.source_artifacts source
             ON (source.tenant_id, source.workspace_id, source.space_id, source.id) =
                (evidence.tenant_id, evidence.workspace_id, evidence.space_id,
                 evidence.source_artifact_id)
           LEFT JOIN identity.users actor ON actor.id = evidence.created_by_user_id
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (evidence.tenant_id, evidence.workspace_id,
                 evidence.created_by_membership_id, evidence.created_by_user_id)
           LEFT JOIN ops.domain_command_records command
             ON (command.tenant_id, command.workspace_id, command.id) =
                (evidence.tenant_id, evidence.workspace_id, evidence.causation_command_id)
          WHERE source.id IS NULL OR actor.id IS NULL OR membership.id IS NULL
             OR command.id IS NULL)
         +
         (SELECT count(*) FROM truth.claims claim
           LEFT JOIN truth.verified_evidence_spans evidence
             ON (evidence.tenant_id, evidence.workspace_id, evidence.space_id, evidence.id) =
                (claim.tenant_id, claim.workspace_id, claim.space_id,
                 claim.verified_evidence_span_id)
           LEFT JOIN identity.people person
             ON (person.tenant_id, person.workspace_id, person.id) =
                (claim.tenant_id, claim.workspace_id, claim.asserted_by_id)
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (claim.tenant_id, claim.workspace_id, claim.created_by_membership_id,
                 claim.created_by_user_id)
           LEFT JOIN ops.domain_command_records command
             ON (command.tenant_id, command.workspace_id, command.id) =
                (claim.tenant_id, claim.workspace_id, claim.causation_command_id)
          WHERE evidence.id IS NULL OR person.id IS NULL OR membership.id IS NULL
             OR command.id IS NULL)
         +
         (SELECT count(*) FROM truth.accepted_facts fact
           LEFT JOIN identity.memberships membership
             ON (membership.tenant_id, membership.workspace_id, membership.id,
                 membership.user_id) =
                (fact.tenant_id, fact.workspace_id, fact.accepted_by_membership_id,
                 fact.accepted_by_user_id)
           LEFT JOIN identity.policy_versions policy
             ON (policy.tenant_id, policy.workspace_id, policy.id) =
                (fact.tenant_id, fact.workspace_id, fact.acceptance_policy_version)
           LEFT JOIN ops.domain_command_records command
             ON (command.tenant_id, command.workspace_id, command.id) =
                (fact.tenant_id, fact.workspace_id, fact.last_causation_command_id)
          WHERE membership.id IS NULL OR policy.id IS NULL OR command.id IS NULL)
         +
         (SELECT count(*) FROM truth.fact_claims support
           LEFT JOIN truth.accepted_facts fact
             ON (fact.tenant_id, fact.workspace_id, fact.space_id, fact.id) =
                (support.tenant_id, support.workspace_id, support.space_id, support.fact_id)
           LEFT JOIN truth.claims claim
             ON (claim.tenant_id, claim.workspace_id, claim.space_id, claim.id) =
                (support.tenant_id, support.workspace_id, support.space_id, support.claim_id)
          WHERE fact.id IS NULL OR claim.id IS NULL)
         +
         (SELECT count(*) FROM work.activity_sources link
           LEFT JOIN work.activities activity
             ON (activity.tenant_id, activity.workspace_id, activity.space_id, activity.id) =
                (link.tenant_id, link.workspace_id, link.space_id, link.activity_id)
           LEFT JOIN content.source_artifacts source
             ON (source.tenant_id, source.workspace_id, source.space_id, source.id) =
                (link.tenant_id, link.workspace_id, link.space_id, link.source_artifact_id)
          WHERE activity.id IS NULL OR source.id IS NULL)
       )::text AS invalid_references`
    );
    expect(result.rows).toEqual([{ invalid_references: "0" }]);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
