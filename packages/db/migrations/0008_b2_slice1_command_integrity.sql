SET LOCAL search_path TO pg_catalog;

GRANT USAGE ON SCHEMA truth TO throughline_b1_0_integrity;
GRANT SELECT ON
  truth.verified_evidence_spans, truth.claims, truth.accepted_facts,
  truth.fact_claims, truth.fact_lifecycle_events
TO throughline_b1_0_integrity;

CREATE FUNCTION ops.b2_slice1_event_payload_valid(
  event_type_value text,
  payload_schema_version_value integer,
  aggregate_id_value uuid,
  payload_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
DECLARE
  payload_keys text[];
BEGIN
  IF event_type_value NOT IN ('claim.proposed','fact.accepted') THEN
    RETURN false;
  END IF;
  IF payload_schema_version_value <> 1
    OR jsonb_typeof(payload_value) <> 'object'
    OR NOT ops.product_safe_json(payload_value)
  THEN
    RETURN false;
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
    INTO payload_keys
  FROM jsonb_object_keys(payload_value) key;
  CASE event_type_value
    WHEN 'claim.proposed' THEN
      RETURN payload_keys = ARRAY['claimId','evidenceSpanId']
        AND (payload_value ->> 'claimId')::uuid = aggregate_id_value
        AND ops.is_uuid_v7((payload_value ->> 'evidenceSpanId')::uuid);
    WHEN 'fact.accepted' THEN
      RETURN payload_keys = ARRAY['factId']
        AND (payload_value ->> 'factId')::uuid = aggregate_id_value;
    ELSE
      RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

CREATE FUNCTION ops.b2_slice1_audit_detail_valid(
  action_value text,
  resource_type_value text,
  audit_schema_version_value integer,
  resource_id_value uuid,
  safe_detail_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
DECLARE
  detail_keys text[];
BEGIN
  IF audit_schema_version_value <> 1
    OR jsonb_typeof(safe_detail_value) <> 'object'
    OR NOT ops.product_safe_json(safe_detail_value)
  THEN
    RETURN false;
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
    INTO detail_keys
  FROM jsonb_object_keys(safe_detail_value) key;
  IF action_value = 'claim.create' AND resource_type_value = 'claim' THEN
    RETURN detail_keys = ARRAY['claimId','evidenceSpanId']
      AND (safe_detail_value ->> 'claimId')::uuid = resource_id_value
      AND ops.is_uuid_v7((safe_detail_value ->> 'evidenceSpanId')::uuid);
  END IF;
  IF action_value = 'fact.accept' AND resource_type_value = 'accepted_fact' THEN
    RETURN detail_keys = ARRAY['factId']
      AND (safe_detail_value ->> 'factId')::uuid = resource_id_value;
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

ALTER TABLE ops.audit_events
  DROP CONSTRAINT audit_events_action_check,
  DROP CONSTRAINT audit_events_resource_type_check,
  DROP CONSTRAINT audit_events_action_resource_pair_check,
  DROP CONSTRAINT audit_events_detail_check,
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'organization.create', 'initiative.create', 'activity.create', 'activity.capture_add',
    'relationship.create', 'relationship.end', 'content.create', 'content.revise',
    'source_artifact.capture', 'source_artifact.correct', 'source_artifact.tombstone',
    'claim.create', 'fact.accept'
  )),
  ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN (
    'organization', 'initiative', 'activity', 'relationship', 'content_item',
    'source_artifact', 'claim', 'accepted_fact'
  )),
  ADD CONSTRAINT audit_events_action_resource_pair_check CHECK (
    (action = 'organization.create' AND resource_type = 'organization')
    OR (action = 'initiative.create' AND resource_type = 'initiative')
    OR (action IN ('activity.create', 'activity.capture_add') AND resource_type = 'activity')
    OR (action IN ('relationship.create', 'relationship.end') AND resource_type = 'relationship')
    OR (action IN ('content.create', 'content.revise') AND resource_type = 'content_item')
    OR (action IN (
      'source_artifact.capture', 'source_artifact.correct', 'source_artifact.tombstone'
    ) AND resource_type = 'source_artifact')
    OR (action = 'claim.create' AND resource_type = 'claim')
    OR (action = 'fact.accept' AND resource_type = 'accepted_fact')
  ),
  ADD CONSTRAINT audit_events_detail_check CHECK (
    ops.product_audit_detail_valid(
      action, resource_type, audit_schema_version, resource_id, safe_detail
    )
    OR ops.b2_slice1_audit_detail_valid(
      action, resource_type, audit_schema_version, resource_id, safe_detail
    )
  );

ALTER TABLE ops.product_outbox_events
  DROP CONSTRAINT product_outbox_events_event_type_check,
  DROP CONSTRAINT product_outbox_events_aggregate_type_check,
  DROP CONSTRAINT product_outbox_events_event_aggregate_pair_check,
  DROP CONSTRAINT product_outbox_events_payload_check,
  ADD CONSTRAINT product_outbox_events_event_type_check CHECK (event_type IN (
    'organization.created', 'initiative.created', 'activity.created', 'activity.capture_added',
    'relationship.created', 'relationship.ended', 'content.created', 'content.revised',
    'source_artifact.captured', 'source_artifact.corrected', 'source_artifact.tombstoned',
    'claim.proposed', 'fact.accepted'
  )),
  ADD CONSTRAINT product_outbox_events_aggregate_type_check CHECK (aggregate_type IN (
    'organization', 'initiative', 'activity', 'relationship', 'content_item',
    'source_artifact', 'claim', 'accepted_fact'
  )),
  ADD CONSTRAINT product_outbox_events_event_aggregate_pair_check CHECK (
    (event_type = 'organization.created' AND aggregate_type = 'organization')
    OR (event_type = 'initiative.created' AND aggregate_type = 'initiative')
    OR (event_type IN ('activity.created', 'activity.capture_added')
      AND aggregate_type = 'activity')
    OR (event_type IN ('relationship.created', 'relationship.ended')
      AND aggregate_type = 'relationship')
    OR (event_type IN ('content.created', 'content.revised')
      AND aggregate_type = 'content_item')
    OR (event_type IN (
      'source_artifact.captured', 'source_artifact.corrected', 'source_artifact.tombstoned'
    ) AND aggregate_type = 'source_artifact')
    OR (event_type = 'claim.proposed' AND aggregate_type = 'claim')
    OR (event_type = 'fact.accepted' AND aggregate_type = 'accepted_fact')
  ),
  ADD CONSTRAINT product_outbox_events_payload_check CHECK (
    ops.product_event_payload_valid(
      event_type, payload_schema_version, aggregate_id, payload
    )
    OR ops.b2_slice1_event_payload_valid(
      event_type, payload_schema_version, aggregate_id, payload
    )
  );

CREATE FUNCTION ops.product_command_record_valid(
  command_kind_value text,
  command_schema_version_value integer,
  command_state text,
  result_type text,
  result_id uuid,
  response jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  response_keys text[];
  claim_id_value text;
BEGIN
  IF command_kind_value IN (
    'organization.create.v1', 'initiative.create.v1', 'activity.create.v1',
    'relationship.create.v1', 'relationship.end.v1', 'content.create.v1',
    'content.revise.v1', 'source.capture.v1', 'source.correct.v1',
    'source.tombstone.v1'
  ) THEN
    RETURN ops.b1_command_record_valid(
      command_kind_value, command_schema_version_value, command_state,
      result_type, result_id, response
    );
  END IF;
  IF command_schema_version_value <> 1
    OR command_kind_value NOT IN ('claim.create.v1','fact.accept.v1')
  THEN
    RETURN false;
  END IF;
  IF command_state = 'reserved' THEN
    RETURN result_type IS NULL AND result_id IS NULL AND response IS NULL;
  END IF;
  IF command_state <> 'completed'
    OR result_id IS NULL
    OR response IS NULL
    OR jsonb_typeof(response) <> 'object'
    OR NOT ops.product_safe_json(response)
  THEN
    RETURN false;
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
    INTO response_keys
  FROM jsonb_object_keys(response) key;

  IF command_kind_value = 'claim.create.v1' THEN
    RETURN result_type = 'claim'
      AND response_keys = ARRAY['claimId','status','version']
      AND (response ->> 'claimId')::uuid = result_id
      AND response ->> 'status' = 'proposed'
      AND jsonb_typeof(response -> 'version') = 'number'
      AND (response ->> 'version')::numeric = 1;
  END IF;

  IF result_type <> 'accepted_fact'
    OR response_keys <> ARRAY['acceptedClaimIds','factId','status','version']
    OR (response ->> 'factId')::uuid <> result_id
    OR response ->> 'status' <> 'current'
    OR jsonb_typeof(response -> 'version') <> 'number'
    OR (response ->> 'version')::numeric <> 1
    OR jsonb_typeof(response -> 'acceptedClaimIds') <> 'array'
    OR jsonb_array_length(response -> 'acceptedClaimIds') < 1
  THEN
    RETURN false;
  END IF;
  FOR claim_id_value IN SELECT jsonb_array_elements_text(response -> 'acceptedClaimIds')
  LOOP
    IF NOT ops.is_uuid_v7(claim_id_value::uuid) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN (
    SELECT count(*) = count(DISTINCT value)
      AND array_agg(value ORDER BY value) = array_agg(value ORDER BY ordinal)
    FROM jsonb_array_elements_text(response -> 'acceptedClaimIds')
      WITH ORDINALITY AS claim(value, ordinal)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

ALTER TABLE ops.domain_command_records
  DROP CONSTRAINT domain_command_records_b1_shape_check,
  ADD CONSTRAINT domain_command_records_product_shape_check CHECK (
    ops.product_command_record_valid(
      command_kind, command_schema_version, state,
      result_resource_type, result_resource_id, safe_response
    )
  );

DROP TRIGGER domain_command_records_b1_atomicity_deferred
  ON ops.domain_command_records;
CREATE CONSTRAINT TRIGGER domain_command_records_b1_atomicity_deferred
AFTER INSERT OR UPDATE ON ops.domain_command_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.command_kind IN (
  'organization.create.v1', 'initiative.create.v1', 'activity.create.v1',
  'relationship.create.v1', 'relationship.end.v1', 'content.create.v1',
  'content.revise.v1', 'source.capture.v1', 'source.correct.v1',
  'source.tombstone.v1'
))
EXECUTE FUNCTION ops.require_b1_command_atomicity();

CREATE FUNCTION ops.require_b2_slice1_command_atomicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_action text;
  expected_event text;
  expected_aggregate text;
  aggregate_space uuid;
  aggregate_version integer;
  aggregate_command_id uuid;
  evidence_span_id uuid;
  audit_count integer;
  outbox_count integer;
  accepted_claim_ids jsonb;
  expected_audit_detail jsonb;
  expected_event_payload jsonb;
BEGIN
  IF NEW.state <> 'completed' THEN
    RETURN NULL;
  END IF;
  CASE NEW.command_kind
    WHEN 'claim.create.v1' THEN
      expected_action := 'claim.create';
      expected_event := 'claim.proposed';
      expected_aggregate := 'claim';
      SELECT claim.space_id, claim.version, claim.causation_command_id,
             claim.verified_evidence_span_id
        INTO aggregate_space, aggregate_version, aggregate_command_id,
             evidence_span_id
      FROM truth.claims claim
      WHERE claim.tenant_id = NEW.tenant_id
        AND claim.workspace_id = NEW.workspace_id
        AND claim.id = NEW.result_resource_id
        AND claim.status = 'proposed';
      IF aggregate_space IS NULL
        OR aggregate_command_id <> NEW.id
        OR aggregate_version <> 1
        OR (NEW.safe_response ->> 'claimId')::uuid <> NEW.result_resource_id
        OR (SELECT count(*)
          FROM truth.claims claim
          JOIN truth.verified_evidence_spans evidence
            ON evidence.tenant_id = claim.tenant_id
           AND evidence.workspace_id = claim.workspace_id
           AND evidence.space_id = claim.space_id
           AND evidence.id = claim.verified_evidence_span_id
          WHERE claim.tenant_id = NEW.tenant_id
            AND claim.workspace_id = NEW.workspace_id
            AND claim.id = NEW.result_resource_id
            AND evidence.causation_command_id = NEW.id) <> 1
      THEN
        RAISE EXCEPTION 'claim.create result does not match its durable Claim and evidence';
      END IF;
      expected_audit_detail := jsonb_build_object(
        'claimId', NEW.result_resource_id,
        'evidenceSpanId', evidence_span_id
      );
      expected_event_payload := expected_audit_detail;
    WHEN 'fact.accept.v1' THEN
      expected_action := 'fact.accept';
      expected_event := 'fact.accepted';
      expected_aggregate := 'accepted_fact';
      SELECT fact.space_id, fact.version, fact.last_causation_command_id
        INTO aggregate_space, aggregate_version, aggregate_command_id
      FROM truth.accepted_facts fact
      WHERE fact.tenant_id = NEW.tenant_id
        AND fact.workspace_id = NEW.workspace_id
        AND fact.id = NEW.result_resource_id
        AND fact.status = 'current';
      SELECT jsonb_agg(support.claim_id::text ORDER BY support.claim_id)
        INTO accepted_claim_ids
      FROM truth.fact_claims support
      WHERE support.tenant_id = NEW.tenant_id
        AND support.workspace_id = NEW.workspace_id
        AND support.fact_id = NEW.result_resource_id;
      IF aggregate_space IS NULL
        OR aggregate_command_id <> NEW.id
        OR aggregate_version <> 1
        OR accepted_claim_ids IS DISTINCT FROM NEW.safe_response -> 'acceptedClaimIds'
        OR (SELECT count(*)
          FROM truth.fact_lifecycle_events lifecycle
          WHERE lifecycle.tenant_id = NEW.tenant_id
            AND lifecycle.workspace_id = NEW.workspace_id
            AND lifecycle.fact_id = NEW.result_resource_id
            AND lifecycle.event_type = 'fact.accepted'
            AND lifecycle.causation_command_id = NEW.id) <> 1
        OR EXISTS (
          SELECT 1
          FROM truth.fact_claims support
          JOIN truth.claims claim
            ON claim.tenant_id = support.tenant_id
           AND claim.workspace_id = support.workspace_id
           AND claim.id = support.claim_id
          WHERE support.tenant_id = NEW.tenant_id
            AND support.workspace_id = NEW.workspace_id
            AND support.fact_id = NEW.result_resource_id
            AND (claim.status <> 'accepted' OR claim.version <> 2)
        )
      THEN
        RAISE EXCEPTION 'fact.accept result does not match its durable Fact support and lifecycle';
      END IF;
      expected_audit_detail := jsonb_build_object('factId', NEW.result_resource_id);
      expected_event_payload := expected_audit_detail;
    ELSE
      RAISE EXCEPTION 'unknown command kind cannot bypass B2 Slice 1 atomicity';
  END CASE;

  IF aggregate_space <> NEW.reservation_space_id THEN
    RAISE EXCEPTION 'truth command reservation Space does not match its aggregate';
  END IF;
  SELECT count(*) INTO audit_count
  FROM ops.audit_events audit
  WHERE audit.tenant_id = NEW.tenant_id
    AND audit.workspace_id = NEW.workspace_id
    AND audit.space_id = aggregate_space
    AND audit.causation_command_id = NEW.id
    AND audit.action = expected_action
    AND audit.resource_type = expected_aggregate
    AND audit.resource_id = NEW.result_resource_id
    AND audit.actor_user_id = NEW.actor_user_id
    AND audit.actor_membership_id = NEW.actor_membership_id
    AND audit.policy_version_id = NEW.policy_version_id
    AND audit.safe_detail = expected_audit_detail;
  SELECT count(*) INTO outbox_count
  FROM ops.product_outbox_events event
  WHERE event.tenant_id = NEW.tenant_id
    AND event.workspace_id = NEW.workspace_id
    AND event.space_id = aggregate_space
    AND event.causation_command_id = NEW.id
    AND event.event_type = expected_event
    AND event.aggregate_type = expected_aggregate
    AND event.aggregate_id = NEW.result_resource_id
    AND event.aggregate_version = aggregate_version
    AND event.policy_version_id = NEW.policy_version_id
    AND event.payload = expected_event_payload;
  IF audit_count <> 1 OR outbox_count <> 1
    OR (SELECT count(*) FROM ops.audit_events audit
      WHERE audit.tenant_id = NEW.tenant_id
        AND audit.workspace_id = NEW.workspace_id
        AND audit.causation_command_id = NEW.id) <> 1
    OR (SELECT count(*) FROM ops.product_outbox_events event
      WHERE event.tenant_id = NEW.tenant_id
        AND event.workspace_id = NEW.workspace_id
        AND event.causation_command_id = NEW.id) <> 1
  THEN
    RAISE EXCEPTION 'truth command requires exact audit and product outbox rows';
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
AFTER INSERT OR UPDATE ON ops.domain_command_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.command_kind IN ('claim.create.v1','fact.accept.v1'))
EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity();

ALTER FUNCTION ops.require_b2_slice1_command_atomicity()
  OWNER TO throughline_b1_0_integrity;

REVOKE ALL ON FUNCTION ops.require_b2_slice1_command_atomicity() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  ops.product_command_record_valid(text, integer, text, text, uuid, jsonb)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  ops.b2_slice1_event_payload_valid(text, integer, uuid, jsonb)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  ops.b2_slice1_audit_detail_valid(text, text, integer, uuid, jsonb)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  ops.product_command_record_valid(text, integer, text, text, uuid, jsonb)
TO throughline_app;
GRANT EXECUTE ON FUNCTION
  ops.b2_slice1_event_payload_valid(text, integer, uuid, jsonb),
  ops.b2_slice1_audit_detail_valid(text, text, integer, uuid, jsonb)
TO throughline_app;
GRANT EXECUTE ON FUNCTION
  ops.b2_slice1_event_payload_valid(text, integer, uuid, jsonb)
TO throughline_product_relay;
