ALTER TABLE truth.accepted_facts
  DROP CONSTRAINT accepted_facts_status_check,
  DROP CONSTRAINT accepted_facts_version_check,
  ADD CONSTRAINT accepted_facts_status_check
    CHECK (status IN ('current','superseded','revoked')),
  ADD CONSTRAINT accepted_facts_version_check CHECK (
    (status = 'current' AND version = 1)
    OR (status IN ('superseded','revoked') AND version = 2)
  );

CREATE TABLE truth.fact_lifecycle_events (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  predecessor_fact_id uuid NOT NULL,
  successor_fact_id uuid,
  transition_kind text NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason_code text NOT NULL,
  reason_rationale text NOT NULL,
  authority_basis text NOT NULL CONSTRAINT fact_lifecycle_events_authority_check
    CHECK (authority_basis IN ('activity_owner','initiative_owner')),
  policy_version text NOT NULL,
  acted_by_user_id uuid NOT NULL,
  acted_by_membership_id uuid NOT NULL,
  causation_command_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    CONSTRAINT fact_lifecycle_events_timestamp_check
    CHECK (recorded_at = transaction_timestamp()),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  CONSTRAINT fact_lifecycle_events_transition_shape_check CHECK (
    (transition_kind = 'supersede' AND from_status = 'current' AND to_status = 'superseded'
      AND successor_fact_id IS NOT NULL AND successor_fact_id <> predecessor_fact_id)
    OR (transition_kind = 'revoke' AND from_status = 'current' AND to_status = 'revoked'
      AND successor_fact_id IS NULL)
  ),
  CONSTRAINT fact_lifecycle_events_reason_check CHECK (
    (transition_kind = 'supersede' AND reason_code IN
      ('newer_evidence','accepted_value_changed','corrected_source_revalidated'))
    OR (transition_kind = 'revoke' AND reason_code IN
      ('no_longer_true','support_invalidated','entered_in_error'))
  ),
  CONSTRAINT fact_lifecycle_events_rationale_check CHECK (
    reason_rationale = normalize(reason_rationale, NFC)
    AND reason_rationale = btrim(reason_rationale)
    AND length(reason_rationale) BETWEEN 1 AND 2000
  ),
  CONSTRAINT fact_lifecycle_events_tenant_workspace_id_key
    UNIQUE (tenant_id, workspace_id, id),
  CONSTRAINT fact_lifecycle_events_tenant_workspace_space_id_key
    UNIQUE (tenant_id, workspace_id, space_id, id),
  CONSTRAINT fact_lifecycle_events_predecessor_key
    UNIQUE (tenant_id, workspace_id, predecessor_fact_id),
  CONSTRAINT fact_lifecycle_events_successor_key
    UNIQUE (tenant_id, workspace_id, successor_fact_id),
  CONSTRAINT fact_lifecycle_events_command_key
    UNIQUE (tenant_id, workspace_id, causation_command_id),
  CONSTRAINT fact_lifecycle_events_predecessor_fkey
    FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_fact_id)
    REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id)
    MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fact_lifecycle_events_successor_fkey
    FOREIGN KEY (tenant_id, workspace_id, space_id, successor_fact_id)
    REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fact_lifecycle_events_actor_user_fkey
    FOREIGN KEY (acted_by_user_id) REFERENCES identity.users(id)
    MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fact_lifecycle_events_actor_membership_fkey
    FOREIGN KEY (tenant_id, workspace_id, acted_by_membership_id, acted_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)
    MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fact_lifecycle_events_policy_fkey
    FOREIGN KEY (tenant_id, workspace_id, policy_version)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id)
    MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fact_lifecycle_events_command_fkey
    FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)
    MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION truth.enforce_fact_lifecycle_transition()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
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
$function$;

CREATE FUNCTION truth.require_fact_lifecycle_command()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
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
$function$;

CREATE FUNCTION truth.require_fact_lifecycle_event()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
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
$function$;

CREATE FUNCTION truth.reject_statement_mutation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'truth statement mutation is not permitted';
END
$function$;

CREATE FUNCTION truth.validate_fact_lifecycle_event()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
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
$function$;

DROP TRIGGER accepted_facts_command_guard ON truth.accepted_facts;
DROP TRIGGER accepted_facts_immutable ON truth.accepted_facts;
CREATE TRIGGER accepted_facts_command_guard BEFORE INSERT ON truth.accepted_facts
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('fact.accept-or-supersede.v1');
CREATE TRIGGER accepted_facts_delete_guard BEFORE DELETE ON truth.accepted_facts
FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation();
CREATE TRIGGER accepted_facts_lifecycle_guard BEFORE UPDATE ON truth.accepted_facts
FOR EACH ROW EXECUTE FUNCTION truth.enforce_fact_lifecycle_transition();
CREATE CONSTRAINT TRIGGER accepted_facts_lifecycle_deferred AFTER UPDATE ON truth.accepted_facts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION truth.require_fact_lifecycle_event();
CREATE TRIGGER fact_lifecycle_command_guard BEFORE INSERT ON truth.fact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION truth.require_fact_lifecycle_command('fact.supersede-or-revoke.v1');
CREATE TRIGGER fact_lifecycle_immutable BEFORE DELETE OR UPDATE ON truth.fact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation();
CREATE TRIGGER fact_lifecycle_insert_guard BEFORE INSERT ON truth.fact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_lifecycle_event();
CREATE TRIGGER fact_lifecycle_truncate_guard BEFORE TRUNCATE ON truth.fact_lifecycle_events
FOR EACH STATEMENT EXECUTE FUNCTION truth.reject_statement_mutation();
CREATE CONSTRAINT TRIGGER fact_lifecycle_valid_deferred AFTER INSERT ON truth.fact_lifecycle_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_lifecycle_event();

ALTER TABLE truth.fact_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.fact_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY accepted_facts_lifecycle_update ON truth.accepted_facts
FOR UPDATE TO throughline_app
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id() AND access.can_read_space(space_id, access_class))
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id() AND access.can_read_space(space_id, access_class));
CREATE POLICY fact_lifecycle_select ON truth.fact_lifecycle_events
FOR SELECT TO throughline_app USING (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND EXISTS (
    SELECT 1 FROM truth.accepted_facts predecessor
    WHERE predecessor.tenant_id = fact_lifecycle_events.tenant_id
      AND predecessor.workspace_id = fact_lifecycle_events.workspace_id
      AND predecessor.space_id = fact_lifecycle_events.space_id
      AND predecessor.id = fact_lifecycle_events.predecessor_fact_id
      AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)
  )
  AND (successor_fact_id IS NULL OR EXISTS (
    SELECT 1 FROM truth.accepted_facts successor
    WHERE successor.tenant_id = fact_lifecycle_events.tenant_id
      AND successor.workspace_id = fact_lifecycle_events.workspace_id
      AND successor.space_id = fact_lifecycle_events.space_id
      AND successor.id = fact_lifecycle_events.successor_fact_id
      AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class)
  ))
);
CREATE POLICY fact_lifecycle_insert ON truth.fact_lifecycle_events
FOR INSERT TO throughline_app WITH CHECK (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND acted_by_user_id = ops.current_user_id()
  AND acted_by_membership_id = ops.current_membership_id()
  AND policy_version = ops.current_policy_version()
  AND EXISTS (
    SELECT 1 FROM truth.accepted_facts predecessor
    WHERE predecessor.tenant_id = fact_lifecycle_events.tenant_id
      AND predecessor.workspace_id = fact_lifecycle_events.workspace_id
      AND predecessor.space_id = fact_lifecycle_events.space_id
      AND predecessor.id = fact_lifecycle_events.predecessor_fact_id
      AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)
  )
  AND (successor_fact_id IS NULL OR EXISTS (
    SELECT 1 FROM truth.accepted_facts successor
    WHERE successor.tenant_id = fact_lifecycle_events.tenant_id
      AND successor.workspace_id = fact_lifecycle_events.workspace_id
      AND successor.space_id = fact_lifecycle_events.space_id
      AND successor.id = fact_lifecycle_events.successor_fact_id
      AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class)
  ))
);
CREATE POLICY fact_lifecycle_integrity_select ON truth.fact_lifecycle_events
FOR SELECT TO throughline_b1_0_integrity USING (true);

REVOKE ALL ON truth.fact_lifecycle_events FROM PUBLIC;
GRANT SELECT, INSERT ON truth.fact_lifecycle_events TO throughline_app;
GRANT SELECT ON truth.fact_lifecycle_events TO throughline_b1_0_integrity;
GRANT UPDATE (status, last_causation_command_id, updated_at, version)
  ON truth.accepted_facts TO throughline_app;

REVOKE ALL ON FUNCTION truth.enforce_fact_lifecycle_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION truth.require_fact_lifecycle_command() FROM PUBLIC;
REVOKE ALL ON FUNCTION truth.require_fact_lifecycle_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION truth.reject_statement_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION truth.validate_fact_lifecycle_event() FROM PUBLIC;

CREATE OR REPLACE FUNCTION truth.require_reserved_command()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  command_id uuid;
  actual_kind text;
  command_request jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  BEGIN
    command_id := CASE TG_TABLE_NAME
      WHEN 'accepted_facts' THEN (row_data ->> 'last_causation_command_id')::uuid
      ELSE (row_data ->> 'causation_command_id')::uuid END;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  END;
  SELECT command.command_kind, command.safe_request INTO actual_kind, command_request
    FROM ops.domain_command_records command
   WHERE command.tenant_id = NEW.tenant_id AND command.workspace_id = NEW.workspace_id
     AND command.id = command_id AND command.state = 'reserved'
     AND command.reservation_space_id = NEW.space_id
     AND command.actor_user_id = ops.current_user_id()
     AND command.actor_membership_id = ops.current_membership_id()
     AND command.policy_version_id = ops.current_policy_version();
  IF actual_kind IS NULL OR (
    TG_ARGV[0] = 'claim.create-or-rework.v1'
      AND actual_kind NOT IN ('claim.create.v1','initiative.primary_objective.rework.v1')
  ) OR (
    TG_ARGV[0] = 'fact.accept-or-supersede.v1'
      AND actual_kind NOT IN ('fact.accept.v1','fact.supersede.v1')
  ) OR (TG_ARGV[0] NOT IN ('claim.create-or-rework.v1','fact.accept-or-supersede.v1')
    AND actual_kind <> TG_ARGV[0])
  THEN RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  END IF;
  IF TG_TABLE_NAME = 'verified_evidence_spans' AND (
      command_request ->> 'sourceArtifactId' <> row_data ->> 'source_artifact_id'
      OR command_request ->> 'sourceChunkId' <> row_data ->> 'source_chunk_id'
      OR (command_request ->> 'expectedSourceVersion')::integer <>
        (row_data ->> 'source_version')::integer
      OR (command_request ->> 'expectedChunkVersion')::integer <>
        (row_data ->> 'chunk_version')::integer
      OR command_request ->> 'normalizationVersion' <> row_data ->> 'normalization_version'
      OR command_request ->> 'chunkingVersion' <> row_data ->> 'chunking_version'
      OR (command_request ->> 'startOffset')::integer <>
        (row_data ->> 'source_start_offset')::integer
      OR (command_request ->> 'endOffset')::integer <>
        (row_data ->> 'source_end_offset')::integer
      OR command_request ->> 'sourceContentHash' <> row_data ->> 'source_content_hash'
      OR command_request ->> 'sourceNormalizedContentHash' <>
        row_data ->> 'source_normalized_content_hash'
      OR command_request ->> 'chunkContentHash' <> row_data ->> 'chunk_content_hash'
      OR command_request ->> 'excerptHash' <> row_data ->> 'excerpt_hash'
    ) THEN RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  ELSIF TG_TABLE_NAME = 'claims' AND (
      command_request ->> 'subjectType' <> row_data ->> 'subject_type'
      OR command_request ->> 'subjectId' <> row_data ->> 'subject_id'
      OR command_request ->> 'predicate' <> row_data ->> 'predicate'
      OR command_request ->> 'valueHash' <> row_data ->> 'value_hash'
      OR row_data ->> 'status' <> 'proposed'
      OR (row_data ->> 'version')::integer <> 1
    ) THEN RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  ELSIF TG_TABLE_NAME = 'initiative_objective_support_attestations' AND (
      command_request ->> 'subjectId' <> row_data ->> 'initiative_id'
      OR command_request ->> 'valueHash' <> row_data ->> 'objective_value_hash'
      OR command_request ->> 'excerptHash' <> row_data ->> 'excerpt_hash'
      OR command_request ->> 'supportConfirmed' <> 'true'
    ) THEN RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  ELSIF TG_TABLE_NAME = 'accepted_facts' AND actual_kind = 'fact.supersede.v1' AND (
      command_request #>> '{subject,type}' <> row_data ->> 'subject_type'
      OR command_request #>> '{subject,id}' <> row_data ->> 'subject_id'
      OR row_data ->> 'status' <> 'current'
      OR (row_data ->> 'version')::integer <> 1
      OR NOT EXISTS (
        SELECT 1 FROM truth.accepted_facts predecessor
         WHERE predecessor.tenant_id = NEW.tenant_id
           AND predecessor.workspace_id = NEW.workspace_id
           AND predecessor.space_id = NEW.space_id
           AND predecessor.id::text = command_request ->> 'factId'
           AND predecessor.subject_type = NEW.subject_type
           AND predecessor.subject_id = NEW.subject_id
           AND predecessor.predicate = NEW.predicate
           AND predecessor.status = 'superseded'
           AND predecessor.version = 2
           AND predecessor.last_causation_command_id = NEW.last_causation_command_id
      )
      OR (
        command_request ? 'confidenceLowering'
        AND (
          command_request #>> '{confidenceLowering,confidence}' IS DISTINCT FROM
            row_data ->> 'confidence'
          OR (row_data ->> 'human_lowered')::boolean IS DISTINCT FROM true
          OR command_request #>> '{confidenceLowering,reason,code}' IS DISTINCT FROM
            row_data ->> 'confidence_lowering_reason_code'
          OR command_request #>> '{confidenceLowering,reason,rationale}' IS DISTINCT FROM
            row_data ->> 'confidence_lowering_rationale'
        )
      )
      OR (
        NOT (command_request ? 'confidenceLowering')
        AND (
          row_data ->> 'confidence' IS DISTINCT FROM
            row_data ->> 'strongest_supporting_confidence'
          OR (row_data ->> 'human_lowered')::boolean IS DISTINCT FROM false
          OR row_data ->> 'confidence_lowering_reason_code' IS NOT NULL
          OR row_data ->> 'confidence_lowering_rationale' IS NOT NULL
        )
      )
    ) THEN RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.enforce_claim_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  command_kind_value text;
  command_request jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  IF OLD.status <> 'proposed' OR OLD.version <> 1 OR NEW.version <> 2
    OR NEW.status NOT IN ('accepted','rejected','superseded')
    OR (NEW.status IN ('rejected','superseded') AND (
      NEW.subject_type <> 'initiative' OR NEW.predicate <> 'initiative.primary_objective'
    ))
    OR NEW.updated_at < OLD.updated_at
    OR (to_jsonb(NEW) - ARRAY['status','version','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','version','updated_at'])
  THEN RAISE EXCEPTION 'claim transition is not permitted'; END IF;
  IF NEW.status = 'accepted' THEN
    SELECT command.command_kind, command.safe_request
      INTO command_kind_value, command_request
      FROM truth.fact_claims support
      JOIN truth.accepted_facts fact
        ON fact.tenant_id = support.tenant_id
       AND fact.workspace_id = support.workspace_id
       AND fact.space_id = support.space_id
       AND fact.id = support.fact_id
      JOIN ops.domain_command_records command
        ON command.tenant_id = fact.tenant_id
       AND command.workspace_id = fact.workspace_id
       AND command.id = fact.last_causation_command_id
     WHERE support.tenant_id = NEW.tenant_id
       AND support.workspace_id = NEW.workspace_id
       AND support.space_id = NEW.space_id
       AND support.claim_id = NEW.id
       AND command.command_kind IN ('fact.accept.v1','fact.supersede.v1')
       AND command.state = 'reserved'
       AND command.reservation_space_id = NEW.space_id
       AND command.actor_user_id = ops.current_user_id()
       AND command.actor_membership_id = ops.current_membership_id()
       AND command.policy_version_id = ops.current_policy_version()
       AND (command.command_kind = 'fact.accept.v1' OR (
         command.safe_request #>> '{subject,type}' = OLD.subject_type
         AND command.safe_request #>> '{subject,id}' = OLD.subject_id::text
       ))
     ORDER BY command.command_kind DESC
     LIMIT 1;
  ELSE
    SELECT command.command_kind, command.safe_request
      INTO command_kind_value, command_request
      FROM ops.domain_command_records command
     WHERE command.tenant_id = NEW.tenant_id
       AND command.workspace_id = NEW.workspace_id
       AND command.state = 'reserved'
       AND command.reservation_space_id = NEW.space_id
       AND command.actor_user_id = ops.current_user_id()
       AND command.actor_membership_id = ops.current_membership_id()
       AND command.policy_version_id = ops.current_policy_version()
       AND command.command_kind = CASE NEW.status
         WHEN 'rejected' THEN 'initiative.primary_objective.withdraw.v1'
         ELSE 'initiative.primary_objective.rework.v1' END
       AND command.safe_request ->> 'subjectId' = NEW.subject_id::text
       AND command.safe_request ->> 'predecessorClaimId' = NEW.id::text
       AND (command.safe_request ->> 'expectedPredecessorVersion')::integer = OLD.version
     LIMIT 1;
  END IF;
  IF command_kind_value IS NULL THEN
    RAISE EXCEPTION 'claim transition requires its reserved command';
  END IF;
  IF command_kind_value = 'fact.supersede.v1' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(command_request -> 'replacementClaims') claim_ref
       WHERE claim_ref ->> 'claimId' = OLD.id::text
    ) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'fact supersede support set does not match replacementClaims';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(command_request -> 'replacementClaims') claim_ref
       WHERE claim_ref ->> 'claimId' = OLD.id::text
         AND (claim_ref ->> 'expectedVersion')::integer = OLD.version
    ) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'fact supersede replacement Claim version is stale';
    END IF;
    IF NEW.updated_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'claim transition is not permitted';
    END IF;
  END IF;
  IF NEW.status = 'accepted' AND NEW.subject_type = 'initiative'
    AND NEW.predicate = 'initiative.primary_objective' AND NOT EXISTS (
      SELECT 1 FROM truth.initiative_objective_support_attestations attestation
       WHERE attestation.tenant_id = NEW.tenant_id
         AND attestation.workspace_id = NEW.workspace_id
         AND attestation.claim_id = NEW.id
         AND attestation.verified_evidence_span_id = NEW.verified_evidence_span_id
         AND attestation.objective_value_hash = NEW.value_hash
  ) THEN RAISE EXCEPTION 'objective acceptance requires human support confirmation'; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.require_fact_accept_reservation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  command_kind_value text;
  command_request jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  SELECT command.command_kind, command.safe_request
    INTO command_kind_value, command_request
    FROM truth.accepted_facts fact
    JOIN ops.domain_command_records command
      ON command.tenant_id = fact.tenant_id
     AND command.workspace_id = fact.workspace_id
     AND command.id = fact.last_causation_command_id
   WHERE fact.tenant_id = NEW.tenant_id
     AND fact.workspace_id = NEW.workspace_id
     AND fact.space_id = NEW.space_id
     AND fact.id = NEW.fact_id
     AND fact.status = 'current'
     AND fact.version = 1
     AND command.command_kind IN ('fact.accept.v1','fact.supersede.v1')
     AND command.state = 'reserved'
     AND command.reservation_space_id = NEW.space_id
     AND command.actor_user_id = ops.current_user_id()
     AND command.actor_membership_id = ops.current_membership_id()
     AND command.policy_version_id = ops.current_policy_version();
  IF command_kind_value IS NULL THEN
    RAISE EXCEPTION 'fact support requires its exact reserved command';
  END IF;
  IF command_kind_value = 'fact.supersede.v1' AND NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(command_request -> 'replacementClaims') claim_ref
     WHERE claim_ref ->> 'claimId' = NEW.claim_id::text
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'fact supersede support set does not match replacementClaims';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.validate_fact_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  subject_owner uuid;
  subject_space uuid;
  command_kind_value text;
  command_request jsonb;
BEGIN
  IF NEW.subject_type = 'activity' THEN
    SELECT owner_person_id, space_id INTO subject_owner, subject_space
      FROM work.activities WHERE tenant_id = NEW.tenant_id
       AND workspace_id = NEW.workspace_id AND id = NEW.subject_id FOR SHARE;
  ELSE
    SELECT owner_person_id, space_id INTO subject_owner, subject_space
      FROM work.initiatives WHERE tenant_id = NEW.tenant_id
       AND workspace_id = NEW.workspace_id AND id = NEW.subject_id FOR SHARE;
  END IF;
  SELECT command.command_kind, command.safe_request INTO command_kind_value, command_request
    FROM ops.domain_command_records command
   WHERE command.tenant_id = NEW.tenant_id AND command.workspace_id = NEW.workspace_id
     AND command.id = NEW.last_causation_command_id AND command.state = 'reserved';
  IF subject_space IS NULL OR subject_space <> NEW.space_id
    OR command_kind_value IS NULL
    OR command_kind_value NOT IN ('fact.accept.v1','fact.supersede.v1')
    OR (command_kind_value = 'fact.accept.v1' AND EXISTS (
      SELECT 1 FROM truth.accepted_facts current_fact
       WHERE current_fact.tenant_id = NEW.tenant_id
         AND current_fact.workspace_id = NEW.workspace_id
         AND current_fact.space_id = NEW.space_id
         AND current_fact.subject_type = NEW.subject_type
         AND current_fact.subject_id = NEW.subject_id
         AND current_fact.predicate = NEW.predicate
         AND current_fact.status = 'current'
    ))
    OR (command_kind_value = 'fact.supersede.v1' AND NOT EXISTS (
      SELECT 1 FROM truth.accepted_facts predecessor
       WHERE predecessor.tenant_id = NEW.tenant_id
         AND predecessor.workspace_id = NEW.workspace_id
         AND predecessor.space_id = NEW.space_id
         AND predecessor.id::text = command_request ->> 'factId'
         AND predecessor.subject_type = NEW.subject_type
         AND predecessor.subject_id = NEW.subject_id
         AND predecessor.predicate = NEW.predicate
         AND predecessor.status = 'superseded'
         AND predecessor.version = 2
         AND predecessor.last_causation_command_id = NEW.last_causation_command_id
    ))
    OR NOT EXISTS (
      SELECT 1 FROM identity.memberships membership
       WHERE membership.tenant_id = NEW.tenant_id
         AND membership.workspace_id = NEW.workspace_id
         AND membership.id = NEW.accepted_by_membership_id
         AND membership.user_id = NEW.accepted_by_user_id
         AND membership.person_id = subject_owner AND membership.status = 'active'
    )
    OR NEW.value_hash <> encode(public.digest(
      pg_catalog.convert_to(NEW.canonical_value_text, 'UTF8'), 'sha256'
    ), 'hex')
  THEN RAISE EXCEPTION 'fact acceptance authority is invalid'; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION ops.b2_slice1_safe_request_valid(
  command_kind_value text, request_value jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
DECLARE request_keys text[];
BEGIN
  IF jsonb_typeof(request_value) <> 'object'
    OR octet_length(request_value::text) > 8192
    THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO request_keys
    FROM jsonb_object_keys(request_value) key;
  IF command_kind_value IN ('fact.supersede.v1','fact.revoke.v1') THEN
    IF command_kind_value = 'fact.revoke.v1' THEN
      RETURN COALESCE((request_keys = ARRAY['expectedFactVersion','factId','reason']
        AND jsonb_typeof(request_value -> 'factId') = 'string'
        AND jsonb_typeof(request_value -> 'expectedFactVersion') = 'number'
        AND ops.is_uuid_v7((request_value ->> 'factId')::uuid)
        AND (request_value ->> 'expectedFactVersion')::integer = 1
        AND jsonb_typeof(request_value -> 'reason') = 'object'
        AND ARRAY(SELECT key FROM jsonb_object_keys(request_value -> 'reason') key ORDER BY key)
          = ARRAY['code','rationale']
        AND jsonb_typeof(request_value #> '{reason,code}') = 'string'
        AND jsonb_typeof(request_value #> '{reason,rationale}') = 'string'
        AND request_value #>> '{reason,code}' IN
          ('no_longer_true','support_invalidated','entered_in_error')
        AND request_value #>> '{reason,rationale}' =
          normalize(request_value #>> '{reason,rationale}', NFC)
        AND request_value #>> '{reason,rationale}' =
          btrim(request_value #>> '{reason,rationale}')
        AND length(request_value #>> '{reason,rationale}') BETWEEN 1 AND 2000), false);
    END IF;
    RETURN COALESCE(((
      request_keys = ARRAY['expectedFactVersion','factId','reason','replacementClaims','subject']
      OR request_keys = ARRAY[
        'confidenceLowering','expectedFactVersion','factId','reason','replacementClaims','subject'
      ]
    )
      AND jsonb_typeof(request_value -> 'factId') = 'string'
      AND jsonb_typeof(request_value -> 'expectedFactVersion') = 'number'
      AND ops.is_uuid_v7((request_value ->> 'factId')::uuid)
      AND (request_value ->> 'expectedFactVersion')::integer = 1
      AND jsonb_typeof(request_value -> 'subject') = 'object'
      AND ARRAY(SELECT key FROM jsonb_object_keys(request_value -> 'subject') key ORDER BY key)
        = ARRAY['expectedVersion','id','type']
      AND jsonb_typeof(request_value #> '{subject,type}') = 'string'
      AND jsonb_typeof(request_value #> '{subject,id}') = 'string'
      AND jsonb_typeof(request_value #> '{subject,expectedVersion}') = 'number'
      AND request_value #>> '{subject,type}' IN ('activity','initiative')
      AND ops.is_uuid_v7((request_value #>> '{subject,id}')::uuid)
      AND (request_value #>> '{subject,expectedVersion}')::integer > 0
      AND jsonb_typeof(request_value -> 'replacementClaims') = 'array'
      AND jsonb_array_length(request_value -> 'replacementClaims') BETWEEN 1 AND 100
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(request_value -> 'replacementClaims') claim_ref
         WHERE jsonb_typeof(claim_ref) <> 'object'
            OR ARRAY(SELECT key FROM jsonb_object_keys(claim_ref) key ORDER BY key)
               <> ARRAY['claimId','expectedVersion']
            OR jsonb_typeof(claim_ref -> 'claimId') <> 'string'
            OR claim_ref ->> 'claimId' !~
               '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            OR NOT ops.is_uuid_v7((claim_ref ->> 'claimId')::uuid)
            OR jsonb_typeof(claim_ref -> 'expectedVersion') <> 'number'
            OR (claim_ref ->> 'expectedVersion')::integer < 1
      )
      AND (SELECT count(*) = count(DISTINCT claim_ref ->> 'claimId')
               AND array_agg(claim_ref ->> 'claimId' ORDER BY ordinal) =
                 array_agg(claim_ref ->> 'claimId' ORDER BY claim_ref ->> 'claimId')
             FROM jsonb_array_elements(request_value -> 'replacementClaims')
               WITH ORDINALITY AS replacement(claim_ref, ordinal))
      AND jsonb_typeof(request_value -> 'reason') = 'object'
      AND ARRAY(SELECT key FROM jsonb_object_keys(request_value -> 'reason') key ORDER BY key)
        = ARRAY['code','rationale']
      AND jsonb_typeof(request_value #> '{reason,code}') = 'string'
      AND jsonb_typeof(request_value #> '{reason,rationale}') = 'string'
      AND request_value #>> '{reason,code}' IN
        ('newer_evidence','accepted_value_changed','corrected_source_revalidated')
      AND request_value #>> '{reason,rationale}' =
        normalize(request_value #>> '{reason,rationale}', NFC)
      AND request_value #>> '{reason,rationale}' =
        btrim(request_value #>> '{reason,rationale}')
      AND length(request_value #>> '{reason,rationale}') BETWEEN 1 AND 2000
      AND (NOT (request_value ? 'confidenceLowering') OR (
        jsonb_typeof(request_value -> 'confidenceLowering') = 'object'
        AND ARRAY(SELECT key
                    FROM jsonb_object_keys(request_value -> 'confidenceLowering') key
                   ORDER BY key) = ARRAY['confidence','reason']
        AND jsonb_typeof(request_value #> '{confidenceLowering,confidence}') = 'string'
        AND request_value #>> '{confidenceLowering,confidence}' IN
          ('confirmed','strong','weak','unknown')
        AND jsonb_typeof(request_value #> '{confidenceLowering,reason}') = 'object'
        AND ARRAY(SELECT key
                    FROM jsonb_object_keys(request_value #> '{confidenceLowering,reason}') key
                   ORDER BY key) = ARRAY['code','rationale']
        AND jsonb_typeof(request_value #> '{confidenceLowering,reason,code}') = 'string'
        AND request_value #>> '{confidenceLowering,reason,code}' IN (
          'conservative_human_judgment','evidence_quality','residual_uncertainty'
        )
        AND jsonb_typeof(request_value #> '{confidenceLowering,reason,rationale}') = 'string'
        AND request_value #>> '{confidenceLowering,reason,rationale}' =
          normalize(request_value #>> '{confidenceLowering,reason,rationale}', NFC)
        AND request_value #>> '{confidenceLowering,reason,rationale}' =
          btrim(request_value #>> '{confidenceLowering,reason,rationale}')
        AND length(request_value #>> '{confidenceLowering,reason,rationale}')
          BETWEEN 1 AND 2000
      ))), false);
  END IF;
  IF command_kind_value = 'initiative.primary_objective.withdraw.v1' THEN
    RETURN COALESCE((request_keys = ARRAY[
      'disposition','expectedPredecessorVersion','expectedSubjectVersion','predecessorClaimId',
      'reasonCode','subjectId','subjectType'
    ]
      AND request_value ->> 'subjectType' = 'initiative'
      AND ops.is_uuid_v7((request_value ->> 'subjectId')::uuid)
      AND ops.is_uuid_v7((request_value ->> 'predecessorClaimId')::uuid)
      AND (request_value ->> 'expectedSubjectVersion')::integer > 0
      AND (request_value ->> 'expectedPredecessorVersion')::integer = 1
      AND request_value ->> 'disposition' IN ('withdrawn','rejected')
      AND request_value ->> 'reasonCode' IN (
        'needs_rework','unsupported','incorrect','duplicate','not_useful','sensitive','other'
      )), false);
  END IF;
  IF command_kind_value NOT IN ('claim.create.v1','initiative.primary_objective.rework.v1')
    THEN RETURN false; END IF;
  IF command_kind_value = 'claim.create.v1' THEN
    IF request_value ->> 'predicate' = 'initiative.primary_objective' THEN
      IF request_keys <> ARRAY[
        'chunkContentHash','chunkingVersion','endOffset','excerptHash','expectedChunkVersion',
        'expectedLatestClaimId','expectedLatestClaimStatus','expectedLatestClaimVersion',
        'expectedSourceVersion','expectedSubjectVersion','normalizationVersion','predicate',
        'sourceArtifactId','sourceChunkId','sourceContentHash','sourceNormalizedContentHash',
        'startOffset','subjectId','subjectType','supportConfirmed','valueHash'
      ] OR NOT COALESCE((
        (jsonb_typeof(request_value -> 'expectedLatestClaimId') = 'null'
          AND jsonb_typeof(request_value -> 'expectedLatestClaimStatus') = 'null'
          AND jsonb_typeof(request_value -> 'expectedLatestClaimVersion') = 'null')
        OR (ops.is_uuid_v7((request_value ->> 'expectedLatestClaimId')::uuid)
          AND (request_value ->> 'expectedLatestClaimVersion')::integer > 0
          AND request_value ->> 'expectedLatestClaimStatus' IN (
            'proposed','accepted','rejected','superseded'
          ))
      ), false) THEN RETURN false; END IF;
    ELSIF request_keys <> ARRAY[
      'chunkContentHash','chunkingVersion','endOffset','excerptHash','expectedChunkVersion',
      'expectedSourceVersion','expectedSubjectVersion','normalizationVersion','predicate',
      'sourceArtifactId','sourceChunkId','sourceContentHash','sourceNormalizedContentHash',
      'startOffset','subjectId','subjectType','supportConfirmed','valueHash'
    ] THEN RETURN false; END IF;
  ELSE
    IF NOT COALESCE((request_keys = ARRAY[
      'chunkContentHash','chunkingVersion','endOffset','excerptHash','expectedChunkVersion',
      'expectedPredecessorVersion','expectedSourceVersion','expectedSubjectVersion',
      'normalizationVersion','predecessorClaimId','predicate','sourceArtifactId','sourceChunkId',
      'sourceContentHash','sourceNormalizedContentHash','startOffset','subjectId','subjectType',
      'supportConfirmed','valueHash'
    ] AND request_value ->> 'subjectType' = 'initiative'
      AND request_value ->> 'predicate' = 'initiative.primary_objective'
      AND ops.is_uuid_v7((request_value ->> 'predecessorClaimId')::uuid)
      AND (request_value ->> 'expectedPredecessorVersion')::integer = 1
    ), false) THEN RETURN false; END IF;
  END IF;
  RETURN COALESCE((request_value ->> 'subjectType' IN ('activity','initiative')
    AND ops.is_uuid_v7((request_value ->> 'subjectId')::uuid)
    AND (request_value ->> 'expectedSubjectVersion')::integer > 0
    AND request_value ->> 'predicate' = CASE request_value ->> 'subjectType'
      WHEN 'activity' THEN 'activity.outcome' ELSE 'initiative.primary_objective' END
    AND request_value ->> 'valueHash' ~ '^[a-f0-9]{64}$'
    AND ops.is_uuid_v7((request_value ->> 'sourceArtifactId')::uuid)
    AND ops.is_uuid_v7((request_value ->> 'sourceChunkId')::uuid)
    AND (request_value ->> 'expectedSourceVersion')::integer > 0
    AND (request_value ->> 'expectedChunkVersion')::integer = 1
    AND request_value ->> 'normalizationVersion' = 'source-normalization.v1'
    AND request_value ->> 'chunkingVersion' = 'source-chunking.v1'
    AND (request_value ->> 'startOffset')::integer >= 0
    AND (request_value ->> 'endOffset')::integer > (request_value ->> 'startOffset')::integer
    AND request_value ->> 'sourceContentHash' ~ '^[a-f0-9]{64}$'
    AND request_value ->> 'sourceNormalizedContentHash' ~ '^[a-f0-9]{64}$'
    AND request_value ->> 'chunkContentHash' ~ '^[a-f0-9]{64}$'
    AND request_value ->> 'excerptHash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(request_value -> 'supportConfirmed') = 'boolean'
    AND (request_value ->> 'supportConfirmed')::boolean =
      (request_value ->> 'predicate' = 'initiative.primary_objective')), false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION ops.b2_slice1_event_payload_valid(
  event_type_value text, payload_schema_version_value integer,
  aggregate_id_value uuid, payload_value jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
DECLARE payload_keys text[];
BEGIN
  IF payload_schema_version_value <> 1 OR jsonb_typeof(payload_value) <> 'object'
    OR NOT ops.product_safe_json(payload_value) THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO payload_keys
    FROM jsonb_object_keys(payload_value) key;
  CASE event_type_value
    WHEN 'claim.proposed' THEN
      RETURN payload_keys IN (
        ARRAY['claimId','evidenceSpanId'],
        ARRAY['claimId','evidenceSpanId','supportAttestationId']
      ) AND (payload_value ->> 'claimId')::uuid = aggregate_id_value
        AND ops.is_uuid_v7((payload_value ->> 'evidenceSpanId')::uuid)
        AND (NOT (payload_value ? 'supportAttestationId')
          OR ops.is_uuid_v7((payload_value ->> 'supportAttestationId')::uuid));
    WHEN 'initiative.primary_objective.proposal_withdrawn' THEN
      RETURN payload_keys = ARRAY['claimId','claimVersion','disposition','reasonCode','recoveryId']
        AND (payload_value ->> 'claimId')::uuid = aggregate_id_value
        AND (payload_value ->> 'claimVersion')::integer = 2
        AND payload_value ->> 'disposition' = 'withdrawn'
        AND payload_value ->> 'reasonCode' IN (
          'needs_rework','unsupported','incorrect','duplicate','not_useful','sensitive','other'
        )
        AND ops.is_uuid_v7((payload_value ->> 'recoveryId')::uuid);
    WHEN 'initiative.primary_objective.proposal_rejected' THEN
      RETURN payload_keys = ARRAY['claimId','claimVersion','disposition','reasonCode','recoveryId']
        AND (payload_value ->> 'claimId')::uuid = aggregate_id_value
        AND (payload_value ->> 'claimVersion')::integer = 2
        AND payload_value ->> 'disposition' = 'rejected'
        AND payload_value ->> 'reasonCode' IN (
          'needs_rework','unsupported','incorrect','duplicate','not_useful','sensitive','other'
        )
        AND ops.is_uuid_v7((payload_value ->> 'recoveryId')::uuid);
    WHEN 'initiative.primary_objective.proposal_reworked' THEN
      RETURN payload_keys = ARRAY[
        'disposition','evidenceSpanId','predecessorClaimId','predecessorVersion','reasonCode',
        'recoveryId','successorClaimId','successorVersion','supportAttestationId'
      ] AND (payload_value ->> 'successorClaimId')::uuid = aggregate_id_value
        AND payload_value ->> 'disposition' = 'reworked'
        AND payload_value ->> 'reasonCode' = 'reworked'
        AND (payload_value ->> 'predecessorVersion')::integer = 2
        AND (payload_value ->> 'successorVersion')::integer = 1
        AND ops.is_uuid_v7((payload_value ->> 'predecessorClaimId')::uuid)
        AND ops.is_uuid_v7((payload_value ->> 'successorClaimId')::uuid)
        AND ops.is_uuid_v7((payload_value ->> 'evidenceSpanId')::uuid)
        AND ops.is_uuid_v7((payload_value ->> 'supportAttestationId')::uuid)
        AND ops.is_uuid_v7((payload_value ->> 'recoveryId')::uuid);
    WHEN 'fact.superseded' THEN
      RETURN payload_keys = ARRAY['factId','factVersion','reasonCode','replacementFactId',
        'replacementFactVersion','status']
        AND jsonb_typeof(payload_value -> 'factId') = 'string'
        AND jsonb_typeof(payload_value -> 'factVersion') = 'number'
        AND jsonb_typeof(payload_value -> 'reasonCode') = 'string'
        AND jsonb_typeof(payload_value -> 'replacementFactId') = 'string'
        AND jsonb_typeof(payload_value -> 'replacementFactVersion') = 'number'
        AND jsonb_typeof(payload_value -> 'status') = 'string'
        AND (payload_value ->> 'factId')::uuid = aggregate_id_value
        AND (payload_value ->> 'factVersion')::integer = 2
        AND payload_value ->> 'status' = 'superseded'
        AND payload_value ->> 'reasonCode' IN
          ('newer_evidence','accepted_value_changed','corrected_source_revalidated')
        AND ops.is_uuid_v7((payload_value ->> 'replacementFactId')::uuid)
        AND (payload_value ->> 'replacementFactVersion')::integer = 1;
    WHEN 'fact.revoked' THEN
      RETURN payload_keys = ARRAY['factId','factVersion','reasonCode','status']
        AND jsonb_typeof(payload_value -> 'factId') = 'string'
        AND jsonb_typeof(payload_value -> 'factVersion') = 'number'
        AND jsonb_typeof(payload_value -> 'reasonCode') = 'string'
        AND jsonb_typeof(payload_value -> 'status') = 'string'
        AND (payload_value ->> 'factId')::uuid = aggregate_id_value
        AND (payload_value ->> 'factVersion')::integer = 2
        AND payload_value ->> 'status' = 'revoked'
        AND payload_value ->> 'reasonCode' IN
          ('no_longer_true','support_invalidated','entered_in_error');
    WHEN 'fact.accepted' THEN
      RETURN payload_keys = ARRAY['factId']
        AND (payload_value ->> 'factId')::uuid = aggregate_id_value;
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION ops.b2_slice1_audit_detail_valid(
  action_value text, resource_type_value text, audit_schema_version_value integer,
  resource_id_value uuid, safe_detail_value jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
BEGIN
  IF audit_schema_version_value <> 1 OR resource_type_value NOT IN ('claim','accepted_fact')
    THEN RETURN false; END IF;
  RETURN ops.b2_slice1_event_payload_valid(
    CASE action_value
      WHEN 'claim.create' THEN 'claim.proposed'
      WHEN 'initiative.primary_objective.withdraw'
        THEN 'initiative.primary_objective.proposal_withdrawn'
      WHEN 'initiative.primary_objective.reject'
        THEN 'initiative.primary_objective.proposal_rejected'
      WHEN 'initiative.primary_objective.rework'
        THEN 'initiative.primary_objective.proposal_reworked'
      WHEN 'fact.accept' THEN 'fact.accepted'
      WHEN 'fact.supersede' THEN 'fact.superseded'
      WHEN 'fact.revoke' THEN 'fact.revoked'
      ELSE '' END,
    audit_schema_version_value, resource_id_value, safe_detail_value
  );
END
$function$;

ALTER TABLE ops.audit_events
  DROP CONSTRAINT audit_events_action_check,
  DROP CONSTRAINT audit_events_action_resource_pair_check,
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'organization.create','initiative.create','activity.create','activity.capture_add',
    'relationship.create','relationship.end','content.create','content.revise',
    'source_artifact.capture','source_artifact.correct','source_artifact.tombstone',
    'claim.create','initiative.primary_objective.withdraw','initiative.primary_objective.reject',
    'initiative.primary_objective.rework','fact.accept'
  )),
  ADD CONSTRAINT audit_events_action_resource_pair_check CHECK (
    (action = 'organization.create' AND resource_type = 'organization')
    OR (action = 'initiative.create' AND resource_type = 'initiative')
    OR (action IN ('activity.create','activity.capture_add') AND resource_type = 'activity')
    OR (action IN ('relationship.create','relationship.end') AND resource_type = 'relationship')
    OR (action IN ('content.create','content.revise') AND resource_type = 'content_item')
    OR (action IN ('source_artifact.capture','source_artifact.correct','source_artifact.tombstone')
      AND resource_type = 'source_artifact')
    OR (action IN ('claim.create','initiative.primary_objective.withdraw',
      'initiative.primary_objective.reject',
      'initiative.primary_objective.rework') AND resource_type = 'claim')
    OR (action = 'fact.accept' AND resource_type = 'accepted_fact')
  );

ALTER TABLE ops.product_outbox_events
  DROP CONSTRAINT product_outbox_events_event_type_check,
  DROP CONSTRAINT product_outbox_events_event_aggregate_pair_check,
  ADD CONSTRAINT product_outbox_events_event_type_check CHECK (event_type IN (
    'organization.created','initiative.created','activity.created','activity.capture_added',
    'relationship.created','relationship.ended','content.created','content.revised',
    'source_artifact.captured','source_artifact.corrected','source_artifact.tombstoned',
    'claim.proposed','initiative.primary_objective.proposal_withdrawn',
    'initiative.primary_objective.proposal_rejected',
    'initiative.primary_objective.proposal_reworked','fact.accepted'
  )),
  ADD CONSTRAINT product_outbox_events_event_aggregate_pair_check CHECK (
    (event_type = 'organization.created' AND aggregate_type = 'organization')
    OR (event_type = 'initiative.created' AND aggregate_type = 'initiative')
    OR (event_type IN ('activity.created','activity.capture_added') AND aggregate_type = 'activity')
    OR (event_type IN ('relationship.created','relationship.ended') AND aggregate_type = 'relationship')
    OR (event_type IN ('content.created','content.revised') AND aggregate_type = 'content_item')
    OR (event_type IN ('source_artifact.captured','source_artifact.corrected',
      'source_artifact.tombstoned') AND aggregate_type = 'source_artifact')
    OR (event_type IN ('claim.proposed','initiative.primary_objective.proposal_withdrawn',
      'initiative.primary_objective.proposal_rejected',
      'initiative.primary_objective.proposal_reworked') AND aggregate_type = 'claim')
    OR (event_type = 'fact.accepted' AND aggregate_type = 'accepted_fact')
  );

CREATE OR REPLACE FUNCTION ops.product_command_record_valid(
  command_kind_value text, command_schema_version_value integer, command_state text,
  result_type text, result_id uuid, response jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $function$
DECLARE response_keys text[]; claim_id_value text;
BEGIN
  IF command_kind_value IN (
    'organization.create.v1','initiative.create.v1','activity.create.v1',
    'relationship.create.v1','relationship.end.v1','content.create.v1',
    'content.revise.v1','source.capture.v1','source.correct.v1','source.tombstone.v1'
  ) THEN RETURN ops.b1_command_record_valid(command_kind_value, command_schema_version_value,
    command_state, result_type, result_id, response); END IF;
  IF command_schema_version_value <> 1 OR command_kind_value NOT IN (
    'claim.create.v1','initiative.primary_objective.withdraw.v1',
    'initiative.primary_objective.rework.v1','fact.accept.v1',
    'fact.supersede.v1','fact.revoke.v1'
  ) THEN RETURN false; END IF;
  IF command_state = 'reserved' THEN
    RETURN result_type IS NULL AND result_id IS NULL AND response IS NULL; END IF;
  IF command_state <> 'completed' OR response IS NULL OR jsonb_typeof(response) <> 'object'
    OR result_id IS NULL OR NOT ops.product_safe_json(response) THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO response_keys
    FROM jsonb_object_keys(response) key;
  IF command_kind_value = 'fact.revoke.v1' THEN
    RETURN result_type = 'accepted_fact'
      AND jsonb_typeof(response -> 'factId') = 'string'
      AND jsonb_typeof(response -> 'status') = 'string'
      AND jsonb_typeof(response -> 'version') = 'number'
      AND (response ->> 'factId')::uuid = result_id
      AND response ->> 'status' = 'revoked' AND (response ->> 'version')::integer = 2
      AND response_keys = ARRAY['factId','status','version'];
  ELSIF command_kind_value = 'fact.supersede.v1' THEN
    RETURN result_type = 'accepted_fact'
      AND jsonb_typeof(response -> 'factId') = 'string'
      AND jsonb_typeof(response -> 'status') = 'string'
      AND jsonb_typeof(response -> 'version') = 'number'
      AND jsonb_typeof(response -> 'replacementFactId') = 'string'
      AND jsonb_typeof(response -> 'replacementFactVersion') = 'number'
      AND jsonb_typeof(response -> 'replacementFactStatus') = 'string'
      AND (response ->> 'factId')::uuid = result_id
      AND response ->> 'status' = 'superseded' AND (response ->> 'version')::integer = 2
      AND ops.is_uuid_v7((response ->> 'replacementFactId')::uuid)
      AND (response ->> 'replacementFactVersion')::integer = 1
      AND response ->> 'replacementFactStatus' = 'current'
      AND response_keys = ARRAY['factId','replacementFactId','replacementFactStatus',
        'replacementFactVersion','status','version'];
  ELSIF command_kind_value = 'claim.create.v1' THEN
    RETURN result_type = 'claim' AND (response ->> 'claimId')::uuid = result_id
      AND response ->> 'status' = 'proposed' AND (response ->> 'version')::integer = 1
      AND ops.is_uuid_v7((response ->> 'claimId')::uuid)
      AND ops.is_uuid_v7((response ->> 'evidenceSpanId')::uuid)
      AND response_keys IN (
        ARRAY['claimId','evidenceSpanId','status','version'],
        ARRAY['claimId','evidenceSpanId','status','supportAttestationId','version']
      ) AND (NOT (response ? 'supportAttestationId')
        OR ops.is_uuid_v7((response ->> 'supportAttestationId')::uuid));
  ELSIF command_kind_value = 'initiative.primary_objective.withdraw.v1' THEN
    RETURN result_type = 'claim' AND (response ->> 'claimId')::uuid = result_id
      AND response ->> 'status' = 'rejected' AND (response ->> 'version')::integer = 2
      AND ops.is_uuid_v7((response ->> 'claimId')::uuid)
      AND ops.is_uuid_v7((response ->> 'recoveryId')::uuid)
      AND response ->> 'disposition' IN ('withdrawn','rejected')
      AND response ->> 'reasonCode' IN (
        'needs_rework','unsupported','incorrect','duplicate','not_useful','sensitive','other'
      )
      AND response_keys = ARRAY['claimId','disposition','reasonCode','recoveryId','status','version'];
  ELSIF command_kind_value = 'initiative.primary_objective.rework.v1' THEN
    RETURN result_type = 'claim' AND (response ->> 'successorClaimId')::uuid = result_id
      AND response ->> 'successorStatus' = 'proposed'
      AND response ->> 'predecessorStatus' = 'superseded'
      AND (response ->> 'predecessorVersion')::integer = 2
      AND (response ->> 'successorVersion')::integer = 1
      AND ops.is_uuid_v7((response ->> 'predecessorClaimId')::uuid)
      AND ops.is_uuid_v7((response ->> 'successorClaimId')::uuid)
      AND ops.is_uuid_v7((response ->> 'evidenceSpanId')::uuid)
      AND ops.is_uuid_v7((response ->> 'supportAttestationId')::uuid)
      AND ops.is_uuid_v7((response ->> 'recoveryId')::uuid)
      AND response ->> 'disposition' = 'reworked'
      AND response ->> 'reasonCode' = 'reworked'
      AND response_keys = ARRAY['disposition','evidenceSpanId','predecessorClaimId',
        'predecessorStatus','predecessorVersion','reasonCode','recoveryId','successorClaimId',
        'successorStatus','successorVersion','supportAttestationId'];
  END IF;
  IF result_type <> 'accepted_fact' OR response_keys <>
    ARRAY['acceptedClaimIds','factId','status','version']
    OR (response ->> 'factId')::uuid <> result_id OR response ->> 'status' <> 'current'
    OR (response ->> 'version')::integer <> 1
    OR jsonb_typeof(response -> 'acceptedClaimIds') <> 'array'
    OR jsonb_array_length(response -> 'acceptedClaimIds') < 1 THEN RETURN false; END IF;
  FOR claim_id_value IN SELECT jsonb_array_elements_text(response -> 'acceptedClaimIds') LOOP
    IF NOT ops.is_uuid_v7(claim_id_value::uuid) THEN RETURN false; END IF;
  END LOOP;
  RETURN (
    SELECT count(*) = count(DISTINCT value)
      AND array_agg(value ORDER BY value) = array_agg(value ORDER BY ordinal)
    FROM jsonb_array_elements_text(response -> 'acceptedClaimIds')
      WITH ORDINALITY AS claim(value, ordinal)
  );
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$function$;

ALTER TABLE ops.domain_command_records
  DROP CONSTRAINT domain_command_records_b2_safe_request_check,
  ADD CONSTRAINT domain_command_records_b2_safe_request_check CHECK (
    (command_kind IN ('claim.create.v1','initiative.primary_objective.withdraw.v1',
      'initiative.primary_objective.rework.v1','fact.supersede.v1','fact.revoke.v1')
      AND NOT safe_request_adopted AND safe_request IS NOT NULL
      AND ops.b2_slice1_safe_request_valid(command_kind, safe_request) IS TRUE)
    OR (command_kind = 'claim.create.v1' AND safe_request_adopted AND safe_request IS NOT NULL
      AND ((ops.b2_slice1_safe_request_valid(command_kind, safe_request) IS TRUE OR (
        safe_request ->> 'predicate' = 'initiative.primary_objective'
        AND jsonb_typeof(safe_request -> 'supportConfirmed') = 'boolean'
        AND NOT (safe_request ->> 'supportConfirmed')::boolean
        AND ops.b2_slice1_safe_request_valid(command_kind,
          jsonb_set(safe_request, '{supportConfirmed}', 'true'::jsonb, false)) IS TRUE
      )) IS TRUE))
    OR (command_kind NOT IN ('claim.create.v1','initiative.primary_objective.withdraw.v1',
      'initiative.primary_objective.rework.v1','fact.supersede.v1','fact.revoke.v1')
      AND NOT safe_request_adopted AND safe_request IS NULL)
  );

ALTER TABLE ops.audit_events
  DROP CONSTRAINT audit_events_action_check,
  DROP CONSTRAINT audit_events_action_resource_pair_check,
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'organization.create','initiative.create','activity.create','activity.capture_add',
    'relationship.create','relationship.end','content.create','content.revise',
    'source_artifact.capture','source_artifact.correct','source_artifact.tombstone',
    'claim.create','initiative.primary_objective.withdraw','initiative.primary_objective.reject',
    'initiative.primary_objective.rework','fact.accept','fact.supersede','fact.revoke'
  )),
  ADD CONSTRAINT audit_events_action_resource_pair_check CHECK (
    (action = 'organization.create' AND resource_type = 'organization')
    OR (action = 'initiative.create' AND resource_type = 'initiative')
    OR (action IN ('activity.create','activity.capture_add') AND resource_type = 'activity')
    OR (action IN ('relationship.create','relationship.end') AND resource_type = 'relationship')
    OR (action IN ('content.create','content.revise') AND resource_type = 'content_item')
    OR (action IN ('source_artifact.capture','source_artifact.correct','source_artifact.tombstone')
      AND resource_type = 'source_artifact')
    OR (action IN ('claim.create','initiative.primary_objective.withdraw',
      'initiative.primary_objective.reject','initiative.primary_objective.rework')
      AND resource_type = 'claim')
    OR (action IN ('fact.accept','fact.supersede','fact.revoke')
      AND resource_type = 'accepted_fact')
  );

ALTER TABLE ops.product_outbox_events
  DROP CONSTRAINT product_outbox_events_event_type_check,
  DROP CONSTRAINT product_outbox_events_event_aggregate_pair_check,
  ADD CONSTRAINT product_outbox_events_event_type_check CHECK (event_type IN (
    'organization.created','initiative.created','activity.created','activity.capture_added',
    'relationship.created','relationship.ended','content.created','content.revised',
    'source_artifact.captured','source_artifact.corrected','source_artifact.tombstoned',
    'claim.proposed','initiative.primary_objective.proposal_withdrawn',
    'initiative.primary_objective.proposal_rejected',
    'initiative.primary_objective.proposal_reworked','fact.accepted',
    'fact.superseded','fact.revoked'
  )),
  ADD CONSTRAINT product_outbox_events_event_aggregate_pair_check CHECK (
    (event_type = 'organization.created' AND aggregate_type = 'organization')
    OR (event_type = 'initiative.created' AND aggregate_type = 'initiative')
    OR (event_type IN ('activity.created','activity.capture_added') AND aggregate_type = 'activity')
    OR (event_type IN ('relationship.created','relationship.ended')
      AND aggregate_type = 'relationship')
    OR (event_type IN ('content.created','content.revised') AND aggregate_type = 'content_item')
    OR (event_type IN ('source_artifact.captured','source_artifact.corrected',
      'source_artifact.tombstoned') AND aggregate_type = 'source_artifact')
    OR (event_type IN ('claim.proposed','initiative.primary_objective.proposal_withdrawn',
      'initiative.primary_objective.proposal_rejected',
      'initiative.primary_objective.proposal_reworked') AND aggregate_type = 'claim')
    OR (event_type IN ('fact.accepted','fact.superseded','fact.revoked')
      AND aggregate_type = 'accepted_fact')
  );

CREATE OR REPLACE FUNCTION ops.require_b2_slice1_command_atomicity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  expected_action text;
  expected_event text;
  expected_aggregate text;
  aggregate_space uuid;
  expected_aggregate_version integer;
  aggregate_command_id uuid;
  evidence_span_id uuid;
  support_attestation_id uuid;
  recovery_id uuid;
  predecessor_claim_id uuid;
  predecessor_version integer;
  disposition_value text;
  reason_code_value text;
  latest_predecessor_claim_id uuid;
  latest_predecessor_claim_version integer;
  latest_predecessor_claim_status text;
  audit_count integer;
  outbox_count integer;
  caused_claim_count integer;
  caused_evidence_count integer;
  caused_attestation_count integer;
  caused_recovery_count integer;
  caused_lifecycle_count integer;
  predecessor_fact_count integer;
  successor_fact_count integer;
  successor_fact_id_value uuid;
  successor_confidence text;
  successor_strongest_confidence text;
  successor_human_lowered boolean;
  successor_lowering_reason_code text;
  successor_lowering_rationale text;
  canonical_replacement_claims jsonb;
  accepted_claim_ids jsonb;
  expected_audit_detail jsonb;
  expected_event_payload jsonb;
BEGIN
  IF NEW.state <> 'completed' THEN RETURN NULL; END IF;
  SELECT count(*) INTO caused_claim_count FROM truth.claims claim
   WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
     AND claim.causation_command_id = NEW.id;
  SELECT count(*) INTO caused_evidence_count FROM truth.verified_evidence_spans evidence
   WHERE evidence.tenant_id = NEW.tenant_id AND evidence.workspace_id = NEW.workspace_id
     AND evidence.causation_command_id = NEW.id;
  SELECT count(*) INTO caused_attestation_count
    FROM truth.initiative_objective_support_attestations attestation
   WHERE attestation.tenant_id = NEW.tenant_id AND attestation.workspace_id = NEW.workspace_id
     AND attestation.causation_command_id = NEW.id;
  SELECT count(*) INTO caused_recovery_count
    FROM truth.initiative_objective_proposal_recoveries recovery
   WHERE recovery.tenant_id = NEW.tenant_id AND recovery.workspace_id = NEW.workspace_id
     AND recovery.causation_command_id = NEW.id;
  SELECT count(*) INTO caused_lifecycle_count FROM truth.fact_lifecycle_events lifecycle
   WHERE lifecycle.tenant_id = NEW.tenant_id AND lifecycle.workspace_id = NEW.workspace_id
     AND lifecycle.causation_command_id = NEW.id;
  CASE NEW.command_kind
    WHEN 'claim.create.v1' THEN
      expected_action := 'claim.create';
      expected_event := 'claim.proposed';
      expected_aggregate := 'claim';
      SELECT claim.space_id, claim.version, claim.causation_command_id,
             claim.verified_evidence_span_id, attestation.id
        INTO aggregate_space, expected_aggregate_version, aggregate_command_id,
             evidence_span_id, support_attestation_id
        FROM truth.claims claim
        LEFT JOIN truth.initiative_objective_support_attestations attestation
          ON attestation.tenant_id = claim.tenant_id
         AND attestation.workspace_id = claim.workspace_id
         AND attestation.claim_id = claim.id
       WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
         AND claim.id = NEW.result_resource_id AND claim.status = 'proposed';
      IF aggregate_space IS NULL OR aggregate_command_id <> NEW.id
        OR expected_aggregate_version <> 1
        OR (NEW.safe_response ->> 'claimId')::uuid <> NEW.result_resource_id
        OR (NEW.safe_response ->> 'evidenceSpanId')::uuid <> evidence_span_id
        OR NEW.safe_response ->> 'status' <> 'proposed'
        OR (NEW.safe_response ->> 'version')::integer <> 1
        OR caused_claim_count <> 1 OR caused_evidence_count <> 1
        OR caused_recovery_count <> 0
        OR caused_attestation_count <> (CASE
          WHEN NEW.safe_request ->> 'predicate' = 'initiative.primary_objective' THEN 1 ELSE 0 END)
        OR (NEW.safe_request ->> 'subjectId')::uuid IS DISTINCT FROM (
          SELECT claim.subject_id FROM truth.claims claim
           WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
             AND claim.id = NEW.result_resource_id)
        OR NEW.safe_request ->> 'valueHash' IS DISTINCT FROM (
          SELECT claim.value_hash FROM truth.claims claim
           WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
             AND claim.id = NEW.result_resource_id)
        OR (support_attestation_id IS NULL) IS DISTINCT FROM
          (NEW.safe_request ->> 'predicate' <> 'initiative.primary_objective')
        OR (support_attestation_id IS NOT NULL AND
          (NEW.safe_response ->> 'supportAttestationId')::uuid IS DISTINCT FROM support_attestation_id)
        OR NOT EXISTS (
          SELECT 1 FROM truth.verified_evidence_spans evidence
           WHERE evidence.tenant_id = NEW.tenant_id
             AND evidence.workspace_id = NEW.workspace_id
             AND evidence.id = evidence_span_id AND evidence.causation_command_id = NEW.id
             AND evidence.source_artifact_id::text = NEW.safe_request ->> 'sourceArtifactId'
             AND evidence.source_chunk_id::text = NEW.safe_request ->> 'sourceChunkId'
             AND evidence.source_version = (NEW.safe_request ->> 'expectedSourceVersion')::integer
             AND evidence.chunk_version = (NEW.safe_request ->> 'expectedChunkVersion')::integer
             AND evidence.source_start_offset = (NEW.safe_request ->> 'startOffset')::integer
             AND evidence.source_end_offset = (NEW.safe_request ->> 'endOffset')::integer
             AND evidence.excerpt_hash = NEW.safe_request ->> 'excerptHash'
        )
        OR (support_attestation_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM truth.initiative_objective_support_attestations attestation
           WHERE attestation.tenant_id = NEW.tenant_id
             AND attestation.workspace_id = NEW.workspace_id
             AND attestation.id = support_attestation_id
             AND attestation.claim_id = NEW.result_resource_id
             AND attestation.verified_evidence_span_id = evidence_span_id
             AND attestation.objective_value_hash = NEW.safe_request ->> 'valueHash'
             AND attestation.excerpt_hash = NEW.safe_request ->> 'excerptHash'
             AND attestation.causation_command_id = NEW.id
        ))
        OR (SELECT count(*) FROM truth.claims claim
          JOIN truth.verified_evidence_spans evidence
            ON evidence.tenant_id = claim.tenant_id
           AND evidence.workspace_id = claim.workspace_id
           AND evidence.space_id = claim.space_id
           AND evidence.id = claim.verified_evidence_span_id
          WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
            AND claim.id = NEW.result_resource_id
            AND evidence.causation_command_id = NEW.id) <> 1
      THEN RAISE EXCEPTION 'claim.create result does not match its durable Claim and evidence';
      END IF;
      IF NEW.safe_request ->> 'predicate' = 'initiative.primary_objective' THEN
        SELECT claim.id, claim.version, claim.status
          INTO latest_predecessor_claim_id, latest_predecessor_claim_version,
               latest_predecessor_claim_status
          FROM truth.claims claim
         WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
           AND claim.space_id = aggregate_space
           AND claim.subject_type = 'initiative'
           AND claim.subject_id = (NEW.safe_request ->> 'subjectId')::uuid
           AND claim.predicate = 'initiative.primary_objective'
           AND claim.id <> NEW.result_resource_id
         ORDER BY claim.created_at DESC, claim.id DESC LIMIT 1;
        IF (NEW.safe_request -> 'expectedLatestClaimId') = 'null'::jsonb THEN
          IF latest_predecessor_claim_id IS NOT NULL THEN
            RAISE EXCEPTION 'claim.create objective generation is stale';
          END IF;
        ELSIF latest_predecessor_claim_id IS DISTINCT FROM
            (NEW.safe_request ->> 'expectedLatestClaimId')::uuid
          OR latest_predecessor_claim_version IS DISTINCT FROM
            (NEW.safe_request ->> 'expectedLatestClaimVersion')::integer
          OR latest_predecessor_claim_status IS DISTINCT FROM
            NEW.safe_request ->> 'expectedLatestClaimStatus'
        THEN RAISE EXCEPTION 'claim.create objective generation is stale';
        END IF;
      END IF;
      expected_audit_detail := jsonb_build_object(
        'claimId', NEW.result_resource_id, 'evidenceSpanId', evidence_span_id
      );
      IF support_attestation_id IS NOT NULL THEN
        expected_audit_detail := expected_audit_detail || jsonb_build_object(
          'supportAttestationId', support_attestation_id
        );
      END IF;
      expected_event_payload := expected_audit_detail;
    WHEN 'initiative.primary_objective.withdraw.v1' THEN
      expected_action := CASE NEW.safe_request ->> 'disposition'
        WHEN 'rejected' THEN 'initiative.primary_objective.reject'
        ELSE 'initiative.primary_objective.withdraw' END;
      expected_event := CASE NEW.safe_request ->> 'disposition'
        WHEN 'rejected' THEN 'initiative.primary_objective.proposal_rejected'
        ELSE 'initiative.primary_objective.proposal_withdrawn' END;
      expected_aggregate := 'claim';
      SELECT claim.space_id, claim.version, recovery.causation_command_id,
             recovery.id, recovery.disposition, recovery.reason_code
        INTO aggregate_space, expected_aggregate_version, aggregate_command_id,
             recovery_id, disposition_value, reason_code_value
        FROM truth.initiative_objective_proposal_recoveries recovery
        JOIN truth.claims claim ON claim.tenant_id = recovery.tenant_id
         AND claim.workspace_id = recovery.workspace_id
         AND claim.id = recovery.predecessor_claim_id
       WHERE recovery.tenant_id = NEW.tenant_id AND recovery.workspace_id = NEW.workspace_id
         AND recovery.causation_command_id = NEW.id AND claim.id = NEW.result_resource_id
         AND claim.status = 'rejected' AND claim.version = 2
         AND recovery.disposition IN ('withdrawn','rejected');
      IF aggregate_space IS NULL OR aggregate_command_id <> NEW.id
        OR (NEW.safe_response ->> 'claimId')::uuid <> NEW.result_resource_id
        OR (NEW.safe_response ->> 'recoveryId')::uuid <> recovery_id
        OR NEW.safe_response ->> 'status' <> 'rejected'
        OR (NEW.safe_response ->> 'version')::integer <> 2
        OR NEW.safe_response ->> 'disposition' <> disposition_value
        OR NEW.safe_response ->> 'reasonCode' <> reason_code_value
        OR NEW.safe_request ->> 'predecessorClaimId' <> NEW.result_resource_id::text
        OR NEW.safe_request ->> 'disposition' <> disposition_value
        OR NEW.safe_request ->> 'reasonCode' <> reason_code_value
        OR caused_claim_count <> 0 OR caused_evidence_count <> 0
        OR caused_attestation_count <> 0 OR caused_recovery_count <> 1
      THEN RAISE EXCEPTION 'objective withdrawal result is incomplete'; END IF;
      expected_audit_detail := jsonb_build_object(
        'claimId', NEW.result_resource_id, 'claimVersion', 2,
        'recoveryId', recovery_id, 'disposition', disposition_value,
        'reasonCode', reason_code_value
      );
      expected_event_payload := expected_audit_detail;
    WHEN 'initiative.primary_objective.rework.v1' THEN
      expected_action := 'initiative.primary_objective.rework';
      expected_event := 'initiative.primary_objective.proposal_reworked';
      expected_aggregate := 'claim';
      SELECT successor.space_id, successor.version, recovery.causation_command_id,
             recovery.id, predecessor.id, predecessor.version,
             successor.verified_evidence_span_id, attestation.id
        INTO aggregate_space, expected_aggregate_version, aggregate_command_id,
             recovery_id, predecessor_claim_id, predecessor_version,
             evidence_span_id, support_attestation_id
        FROM truth.initiative_objective_proposal_recoveries recovery
        JOIN truth.claims predecessor ON predecessor.tenant_id = recovery.tenant_id
         AND predecessor.workspace_id = recovery.workspace_id
         AND predecessor.id = recovery.predecessor_claim_id
        JOIN truth.claims successor ON successor.tenant_id = recovery.tenant_id
         AND successor.workspace_id = recovery.workspace_id
         AND successor.id = recovery.successor_claim_id
        JOIN truth.initiative_objective_support_attestations attestation
          ON attestation.tenant_id = successor.tenant_id
         AND attestation.workspace_id = successor.workspace_id
         AND attestation.claim_id = successor.id
       WHERE recovery.tenant_id = NEW.tenant_id AND recovery.workspace_id = NEW.workspace_id
         AND recovery.causation_command_id = NEW.id AND successor.id = NEW.result_resource_id
         AND recovery.disposition = 'reworked' AND predecessor.status = 'superseded'
         AND predecessor.version = 2 AND successor.status = 'proposed'
         AND successor.version = 1 AND successor.causation_command_id = NEW.id
         AND attestation.causation_command_id = NEW.id;
      IF aggregate_space IS NULL OR aggregate_command_id <> NEW.id
        OR (NEW.safe_response ->> 'successorClaimId')::uuid <> NEW.result_resource_id
        OR (NEW.safe_response ->> 'predecessorClaimId')::uuid <> predecessor_claim_id
        OR (NEW.safe_response ->> 'recoveryId')::uuid <> recovery_id
        OR (NEW.safe_response ->> 'evidenceSpanId')::uuid <> evidence_span_id
        OR (NEW.safe_response ->> 'supportAttestationId')::uuid <> support_attestation_id
        OR NEW.safe_response ->> 'predecessorStatus' <> 'superseded'
        OR (NEW.safe_response ->> 'predecessorVersion')::integer <> predecessor_version
        OR NEW.safe_response ->> 'successorStatus' <> 'proposed'
        OR (NEW.safe_response ->> 'successorVersion')::integer <> expected_aggregate_version
        OR NEW.safe_response ->> 'disposition' <> 'reworked'
        OR NEW.safe_response ->> 'reasonCode' <> 'reworked'
        OR NEW.safe_request ->> 'predecessorClaimId' <> predecessor_claim_id::text
        OR NEW.safe_request ->> 'subjectId' IS DISTINCT FROM (
          SELECT successor.subject_id::text FROM truth.claims successor
           WHERE successor.tenant_id = NEW.tenant_id
             AND successor.workspace_id = NEW.workspace_id
             AND successor.id = NEW.result_resource_id)
        OR NEW.safe_request ->> 'valueHash' IS DISTINCT FROM (
          SELECT successor.value_hash FROM truth.claims successor
           WHERE successor.tenant_id = NEW.tenant_id
             AND successor.workspace_id = NEW.workspace_id
             AND successor.id = NEW.result_resource_id)
        OR caused_claim_count <> 1 OR caused_evidence_count <> 1
        OR caused_attestation_count <> 1 OR caused_recovery_count <> 1
        OR NOT EXISTS (
          SELECT 1 FROM truth.verified_evidence_spans evidence
           WHERE evidence.tenant_id = NEW.tenant_id
             AND evidence.workspace_id = NEW.workspace_id
             AND evidence.id = evidence_span_id AND evidence.causation_command_id = NEW.id
             AND evidence.source_artifact_id::text = NEW.safe_request ->> 'sourceArtifactId'
             AND evidence.source_chunk_id::text = NEW.safe_request ->> 'sourceChunkId'
             AND evidence.source_version = (NEW.safe_request ->> 'expectedSourceVersion')::integer
             AND evidence.chunk_version = (NEW.safe_request ->> 'expectedChunkVersion')::integer
             AND evidence.source_start_offset = (NEW.safe_request ->> 'startOffset')::integer
             AND evidence.source_end_offset = (NEW.safe_request ->> 'endOffset')::integer
             AND evidence.excerpt_hash = NEW.safe_request ->> 'excerptHash'
        )
        OR NOT EXISTS (
          SELECT 1 FROM truth.initiative_objective_support_attestations attestation
           WHERE attestation.tenant_id = NEW.tenant_id
             AND attestation.workspace_id = NEW.workspace_id
             AND attestation.id = support_attestation_id
             AND attestation.claim_id = NEW.result_resource_id
             AND attestation.verified_evidence_span_id = evidence_span_id
             AND attestation.objective_value_hash = NEW.safe_request ->> 'valueHash'
             AND attestation.excerpt_hash = NEW.safe_request ->> 'excerptHash'
             AND attestation.causation_command_id = NEW.id
        )
      THEN RAISE EXCEPTION 'objective rework result is incomplete'; END IF;
      expected_audit_detail := jsonb_build_object(
        'predecessorClaimId', predecessor_claim_id,
        'predecessorVersion', predecessor_version,
        'successorClaimId', NEW.result_resource_id,
        'successorVersion', expected_aggregate_version,
        'evidenceSpanId', evidence_span_id,
        'supportAttestationId', support_attestation_id,
        'recoveryId', recovery_id, 'disposition', 'reworked', 'reasonCode', 'reworked'
      );
      expected_event_payload := expected_audit_detail;
    WHEN 'fact.supersede.v1' THEN
      expected_action := 'fact.supersede';
      expected_event := 'fact.superseded';
      expected_aggregate := 'accepted_fact';
      SELECT count(*) INTO predecessor_fact_count
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.id = NEW.result_resource_id AND fact.status = 'superseded'
         AND fact.version = 2 AND fact.last_causation_command_id = NEW.id;
      SELECT fact.space_id, fact.version INTO aggregate_space, expected_aggregate_version
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.id = NEW.result_resource_id AND fact.status = 'superseded'
         AND fact.version = 2 AND fact.last_causation_command_id = NEW.id;
      SELECT count(*) INTO successor_fact_count
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.status = 'current' AND fact.version = 1
         AND fact.last_causation_command_id = NEW.id;
      SELECT fact.id, fact.confidence, fact.strongest_supporting_confidence,
             fact.human_lowered, fact.confidence_lowering_reason_code,
             fact.confidence_lowering_rationale
        INTO successor_fact_id_value, successor_confidence, successor_strongest_confidence,
             successor_human_lowered, successor_lowering_reason_code,
             successor_lowering_rationale
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.status = 'current' AND fact.version = 1
         AND fact.last_causation_command_id = NEW.id
       ORDER BY fact.id LIMIT 1;
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'claimId', support.claim_id,
               'expectedVersion', claim.version - 1
             ) ORDER BY support.claim_id), '[]'::jsonb)
        INTO canonical_replacement_claims
        FROM truth.fact_claims support
        JOIN truth.claims claim
          ON claim.tenant_id = support.tenant_id
         AND claim.workspace_id = support.workspace_id
         AND claim.space_id = support.space_id
         AND claim.id = support.claim_id
       WHERE support.tenant_id = NEW.tenant_id
         AND support.workspace_id = NEW.workspace_id
         AND support.fact_id = successor_fact_id_value;
      IF predecessor_fact_count <> 1 OR successor_fact_count <> 1
        OR caused_lifecycle_count <> 1
        OR NOT EXISTS (
          SELECT 1 FROM truth.fact_lifecycle_events lifecycle
           WHERE lifecycle.tenant_id = NEW.tenant_id
             AND lifecycle.workspace_id = NEW.workspace_id
             AND lifecycle.space_id = aggregate_space
             AND lifecycle.predecessor_fact_id = NEW.result_resource_id
             AND lifecycle.successor_fact_id = successor_fact_id_value
             AND lifecycle.transition_kind = 'supersede'
             AND lifecycle.from_status = 'current' AND lifecycle.to_status = 'superseded'
             AND lifecycle.reason_code = NEW.safe_request #>> '{reason,code}'
             AND lifecycle.reason_rationale = NEW.safe_request #>> '{reason,rationale}'
             AND lifecycle.causation_command_id = NEW.id
      )
      THEN RAISE EXCEPTION 'fact supersede result is incomplete'; END IF;
      IF (NEW.safe_response ->> 'replacementFactId')::uuid IS DISTINCT FROM
          successor_fact_id_value
      THEN
        RAISE EXCEPTION USING
          MESSAGE = 'fact supersede response does not match successor';
      END IF;
      IF canonical_replacement_claims IS DISTINCT FROM
          NEW.safe_request -> 'replacementClaims'
        OR EXISTS (
          SELECT 1
            FROM truth.fact_claims support
            JOIN truth.claims claim
              ON claim.tenant_id = support.tenant_id
             AND claim.workspace_id = support.workspace_id
             AND claim.space_id = support.space_id
             AND claim.id = support.claim_id
           WHERE support.tenant_id = NEW.tenant_id
             AND support.workspace_id = NEW.workspace_id
             AND support.fact_id = successor_fact_id_value
             AND (claim.status <> 'accepted' OR claim.version <> 2
               OR claim.updated_at IS DISTINCT FROM transaction_timestamp())
        )
      THEN
        RAISE EXCEPTION USING
          MESSAGE = 'fact supersede support set does not match replacementClaims';
      END IF;
      IF NEW.safe_request ? 'confidenceLowering' THEN
        IF successor_confidence IS DISTINCT FROM
            NEW.safe_request #>> '{confidenceLowering,confidence}'
          OR successor_human_lowered IS DISTINCT FROM true
          OR successor_lowering_reason_code IS DISTINCT FROM
            NEW.safe_request #>> '{confidenceLowering,reason,code}'
          OR successor_lowering_rationale IS DISTINCT FROM
            NEW.safe_request #>> '{confidenceLowering,reason,rationale}'
        THEN
          RAISE EXCEPTION USING
            MESSAGE = 'fact supersede successor confidence does not match confidenceLowering';
        END IF;
      ELSIF successor_confidence IS DISTINCT FROM successor_strongest_confidence
        OR successor_human_lowered IS DISTINCT FROM false
        OR successor_lowering_reason_code IS NOT NULL
        OR successor_lowering_rationale IS NOT NULL
      THEN
        RAISE EXCEPTION USING
          MESSAGE = 'fact supersede successor confidence requires confidenceLowering';
      END IF;
      expected_audit_detail := jsonb_build_object(
        'factId', NEW.result_resource_id, 'factVersion', 2,
        'reasonCode', NEW.safe_request #>> '{reason,code}',
        'replacementFactId', successor_fact_id_value, 'replacementFactVersion', 1,
        'status', 'superseded'
      );
      expected_event_payload := expected_audit_detail;
    WHEN 'fact.revoke.v1' THEN
      expected_action := 'fact.revoke';
      expected_event := 'fact.revoked';
      expected_aggregate := 'accepted_fact';
      SELECT count(*) INTO predecessor_fact_count
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.id = NEW.result_resource_id AND fact.status = 'revoked'
         AND fact.version = 2 AND fact.last_causation_command_id = NEW.id;
      SELECT fact.space_id, fact.version INTO aggregate_space, expected_aggregate_version
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.id = NEW.result_resource_id AND fact.status = 'revoked'
         AND fact.version = 2 AND fact.last_causation_command_id = NEW.id;
      SELECT count(*) INTO successor_fact_count FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.id <> NEW.result_resource_id AND fact.status = 'current'
         AND fact.last_causation_command_id = NEW.id;
      IF predecessor_fact_count <> 1 OR successor_fact_count <> 0
        OR caused_lifecycle_count <> 1
        OR NOT EXISTS (
          SELECT 1 FROM truth.fact_lifecycle_events lifecycle
           WHERE lifecycle.tenant_id = NEW.tenant_id
             AND lifecycle.workspace_id = NEW.workspace_id
             AND lifecycle.space_id = aggregate_space
             AND lifecycle.predecessor_fact_id = NEW.result_resource_id
             AND lifecycle.successor_fact_id IS NULL
             AND lifecycle.transition_kind = 'revoke'
             AND lifecycle.from_status = 'current' AND lifecycle.to_status = 'revoked'
             AND lifecycle.reason_code = NEW.safe_request #>> '{reason,code}'
             AND lifecycle.reason_rationale = NEW.safe_request #>> '{reason,rationale}'
             AND lifecycle.causation_command_id = NEW.id
        )
      THEN RAISE EXCEPTION 'fact revoke result is incomplete'; END IF;
      expected_audit_detail := jsonb_build_object(
        'factId', NEW.result_resource_id, 'factVersion', 2,
        'reasonCode', NEW.safe_request #>> '{reason,code}', 'status', 'revoked'
      );
      expected_event_payload := expected_audit_detail;
    WHEN 'fact.accept.v1' THEN
      expected_action := 'fact.accept';
      expected_event := 'fact.accepted';
      expected_aggregate := 'accepted_fact';
      SELECT fact.space_id, fact.version, fact.last_causation_command_id
        INTO aggregate_space, expected_aggregate_version, aggregate_command_id
        FROM truth.accepted_facts fact
       WHERE fact.tenant_id = NEW.tenant_id AND fact.workspace_id = NEW.workspace_id
         AND fact.id = NEW.result_resource_id AND fact.status = 'current';
      SELECT jsonb_agg(support.claim_id::text ORDER BY support.claim_id)
        INTO accepted_claim_ids FROM truth.fact_claims support
       WHERE support.tenant_id = NEW.tenant_id AND support.workspace_id = NEW.workspace_id
         AND support.fact_id = NEW.result_resource_id;
      IF aggregate_space IS NULL OR aggregate_command_id <> NEW.id
        OR expected_aggregate_version <> 1
        OR accepted_claim_ids IS DISTINCT FROM NEW.safe_response -> 'acceptedClaimIds'
        OR EXISTS (SELECT 1 FROM truth.fact_claims support
          JOIN truth.claims claim ON claim.tenant_id = support.tenant_id
           AND claim.workspace_id = support.workspace_id AND claim.id = support.claim_id
          WHERE support.tenant_id = NEW.tenant_id AND support.workspace_id = NEW.workspace_id
            AND support.fact_id = NEW.result_resource_id
            AND (claim.status <> 'accepted' OR claim.version <> 2))
      THEN RAISE EXCEPTION 'fact.accept result does not match its durable Fact and support'; END IF;
      expected_audit_detail := jsonb_build_object('factId', NEW.result_resource_id);
      expected_event_payload := expected_audit_detail;
    ELSE RAISE EXCEPTION 'unknown command kind cannot bypass B2 atomicity';
  END CASE;

  IF aggregate_space <> NEW.reservation_space_id THEN
    RAISE EXCEPTION 'truth command reservation Space does not match its aggregate';
  END IF;
  SELECT count(*) INTO audit_count FROM ops.audit_events audit
   WHERE audit.tenant_id = NEW.tenant_id AND audit.workspace_id = NEW.workspace_id
     AND audit.space_id = aggregate_space AND audit.causation_command_id = NEW.id
     AND audit.action = expected_action AND audit.resource_type = expected_aggregate
     AND audit.resource_id = NEW.result_resource_id
     AND audit.actor_user_id = NEW.actor_user_id
     AND audit.actor_membership_id = NEW.actor_membership_id
     AND audit.policy_version_id = NEW.policy_version_id
     AND audit.safe_detail = expected_audit_detail;
  SELECT count(*) INTO outbox_count FROM ops.product_outbox_events event
   WHERE event.tenant_id = NEW.tenant_id AND event.workspace_id = NEW.workspace_id
     AND event.space_id = aggregate_space AND event.causation_command_id = NEW.id
     AND event.event_type = expected_event AND event.aggregate_type = expected_aggregate
     AND event.aggregate_id = NEW.result_resource_id
     AND event.aggregate_version = expected_aggregate_version
     AND event.policy_version_id = NEW.policy_version_id
     AND event.payload = expected_event_payload;
  IF audit_count <> 1 OR outbox_count <> 1
    OR (SELECT count(*) FROM ops.audit_events audit
      WHERE audit.tenant_id = NEW.tenant_id AND audit.workspace_id = NEW.workspace_id
        AND audit.causation_command_id = NEW.id) <> 1
    OR (SELECT count(*) FROM ops.product_outbox_events event
      WHERE event.tenant_id = NEW.tenant_id AND event.workspace_id = NEW.workspace_id
        AND event.causation_command_id = NEW.id) <> 1
  THEN RAISE EXCEPTION 'truth command requires exact audit and product outbox rows'; END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
  ON ops.domain_command_records;
CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
AFTER INSERT OR UPDATE ON ops.domain_command_records
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.command_kind IN (
  'claim.create.v1','initiative.primary_objective.withdraw.v1',
  'initiative.primary_objective.rework.v1','fact.accept.v1',
  'fact.supersede.v1','fact.revoke.v1'
)) EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity();
