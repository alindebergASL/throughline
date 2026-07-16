SET LOCAL search_path TO pg_catalog;

GRANT USAGE ON SCHEMA identity, access, work, content, ops TO throughline_b1_0_integrity;
GRANT SELECT ON
  work.organizations, work.initiatives, work.activities, work.relationships,
  work.activity_sources, content.content_items, content.source_artifacts,
  content.source_chunks, access.spaces, access.access_relationships,
  identity.service_principals, ops.audit_events, ops.product_outbox_events
TO throughline_b1_0_integrity;

CREATE POLICY spaces_b1_integrity_select ON access.spaces
  FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY access_relationships_b1_integrity_select ON access.access_relationships
  FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY service_principals_b1_integrity_select ON identity.service_principals
  FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY audit_events_b1_integrity_select ON ops.audit_events
  FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY product_outbox_events_b1_integrity_select ON ops.product_outbox_events
  FOR SELECT TO throughline_b1_0_integrity USING (true);

DO $integrity_policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organizations', 'initiatives', 'activities', 'relationships', 'activity_sources'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON work.%I FOR SELECT TO throughline_b1_0_integrity USING (true)',
      table_name || '_b1_integrity_select', table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['content_items', 'source_artifacts', 'source_chunks'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON content.%I FOR SELECT TO throughline_b1_0_integrity USING (true)',
      table_name || '_b1_integrity_select', table_name
    );
  END LOOP;
END
$integrity_policies$;

CREATE FUNCTION ops.b1_command_record_valid(
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
DECLARE expected_type text; id_key text; required_keys text[];
BEGIN
  IF command_kind_value NOT IN (
    'organization.create.v1', 'initiative.create.v1', 'activity.create.v1',
    'relationship.create.v1', 'relationship.end.v1', 'content.create.v1',
    'content.revise.v1', 'source.capture.v1', 'source.correct.v1',
    'source.tombstone.v1'
  ) THEN RETURN true; END IF;
  IF command_schema_version_value <> 1 THEN RETURN false; END IF;
  CASE command_kind_value
    WHEN 'organization.create.v1' THEN expected_type := 'organization'; id_key := 'organizationId'; required_keys := ARRAY['organizationId','spaceId','version'];
    WHEN 'initiative.create.v1' THEN expected_type := 'initiative'; id_key := 'initiativeId'; required_keys := ARRAY['initiativeId','spaceId','version'];
    WHEN 'activity.create.v1' THEN expected_type := 'activity'; id_key := 'activityId'; required_keys := ARRAY['activityId','spaceId','version'];
    WHEN 'relationship.create.v1' THEN expected_type := 'relationship'; id_key := 'relationshipId'; required_keys := ARRAY['relationshipId','spaceId','version'];
    WHEN 'relationship.end.v1' THEN expected_type := 'relationship'; id_key := 'relationshipId'; required_keys := ARRAY['relationshipId','version','validTo'];
    WHEN 'content.create.v1' THEN expected_type := 'content_item'; id_key := 'contentItemId'; required_keys := ARRAY['contentItemId','revisionNumber','version'];
    WHEN 'content.revise.v1' THEN expected_type := 'content_item'; id_key := 'contentItemId'; required_keys := ARRAY['contentItemId','revisionNumber','version'];
    WHEN 'source.capture.v1' THEN expected_type := 'source_artifact'; id_key := 'sourceArtifactId'; required_keys := ARRAY['sourceArtifactId','activityId','chunkCount','version'];
    WHEN 'source.correct.v1' THEN expected_type := 'source_artifact'; id_key := 'sourceArtifactId'; required_keys := ARRAY['sourceArtifactId','previousSourceArtifactId','chunkCount','version'];
    WHEN 'source.tombstone.v1' THEN expected_type := 'source_artifact'; id_key := 'sourceArtifactId'; required_keys := ARRAY['sourceArtifactId','version','hashDisposition'];
    ELSE RETURN true;
  END CASE;
  IF command_state = 'reserved' THEN
    RETURN result_type IS NULL AND result_id IS NULL AND response IS NULL;
  END IF;
  IF command_state <> 'completed' OR result_type <> expected_type OR result_id IS NULL
    OR response IS NULL OR jsonb_typeof(response) <> 'object'
    OR NOT response ?& required_keys
    OR (SELECT count(*) FROM jsonb_object_keys(response)) <> cardinality(required_keys)
    OR response ->> id_key <> result_id::text
    OR jsonb_typeof(response -> 'version') <> 'number'
    OR (response ->> 'version')::integer < 1 THEN RETURN false;
  END IF;
  IF command_kind_value IN ('organization.create.v1','initiative.create.v1','activity.create.v1',
      'relationship.create.v1') THEN
    RETURN (response ->> 'spaceId')::uuid IS NOT NULL AND (response ->> 'version')::integer = 1;
  ELSIF command_kind_value IN ('content.create.v1','content.revise.v1') THEN
    RETURN jsonb_typeof(response -> 'revisionNumber') = 'number'
      AND (response ->> 'revisionNumber')::integer > 0;
  ELSIF command_kind_value = 'source.capture.v1' THEN
    RETURN ops.is_uuid_v7((response ->> 'activityId')::uuid)
      AND jsonb_typeof(response -> 'chunkCount') = 'number'
      AND (response ->> 'chunkCount')::integer > 0 AND (response ->> 'version')::integer = 1;
  ELSIF command_kind_value = 'source.correct.v1' THEN
    RETURN ops.is_uuid_v7((response ->> 'previousSourceArtifactId')::uuid)
      AND (response ->> 'previousSourceArtifactId') <> result_id::text
      AND jsonb_typeof(response -> 'chunkCount') = 'number'
      AND (response ->> 'chunkCount')::integer > 0 AND (response ->> 'version')::integer = 1;
  ELSIF command_kind_value = 'source.tombstone.v1' THEN
    RETURN response ->> 'hashDisposition' IN ('retained','erased');
  ELSIF command_kind_value = 'relationship.end.v1' THEN
    RETURN jsonb_typeof(response -> 'validTo') = 'string';
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

ALTER TABLE ops.domain_command_records
  ADD CONSTRAINT domain_command_records_b1_shape_check CHECK (
    ops.b1_command_record_valid(
      command_kind, command_schema_version, state,
      result_resource_type, result_resource_id, safe_response
    )
  );

CREATE FUNCTION ops.require_b1_command_atomicity()
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
  resolved_aggregate_version integer;
  aggregate_revision integer;
  aggregate_valid_to timestamptz;
  aggregate_chunk_count integer;
  audit_count integer;
  outbox_count integer;
  outbox_record record;
  child_kind text;
BEGIN
  IF NEW.state <> 'completed' THEN RETURN NULL; END IF;
  CASE NEW.command_kind
    WHEN 'organization.create.v1' THEN expected_action := 'organization.create'; expected_event := 'organization.created'; expected_aggregate := 'organization';
    WHEN 'initiative.create.v1' THEN expected_action := 'initiative.create'; expected_event := 'initiative.created'; expected_aggregate := 'initiative';
    WHEN 'activity.create.v1' THEN expected_action := 'activity.create'; expected_event := 'activity.created'; expected_aggregate := 'activity';
    WHEN 'relationship.create.v1' THEN expected_action := 'relationship.create'; expected_event := 'relationship.created'; expected_aggregate := 'relationship';
    WHEN 'relationship.end.v1' THEN expected_action := 'relationship.end'; expected_event := 'relationship.ended'; expected_aggregate := 'relationship';
    WHEN 'content.create.v1' THEN expected_action := 'content.create'; expected_event := 'content.created'; expected_aggregate := 'content_item';
    WHEN 'content.revise.v1' THEN expected_action := 'content.revise'; expected_event := 'content.revised'; expected_aggregate := 'content_item';
    WHEN 'source.capture.v1' THEN expected_action := 'source_artifact.capture'; expected_event := 'source_artifact.captured'; expected_aggregate := 'source_artifact';
    WHEN 'source.correct.v1' THEN expected_action := 'source_artifact.correct'; expected_event := 'source_artifact.corrected'; expected_aggregate := 'source_artifact';
    WHEN 'source.tombstone.v1' THEN expected_action := 'source_artifact.tombstone'; expected_event := 'source_artifact.tombstoned'; expected_aggregate := 'source_artifact';
    ELSE RETURN NULL;
  END CASE;

  CASE expected_aggregate
    WHEN 'organization' THEN SELECT space_id, version INTO aggregate_space, resolved_aggregate_version FROM work.organizations
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND id = NEW.result_resource_id;
    WHEN 'initiative' THEN SELECT space_id, version INTO aggregate_space, resolved_aggregate_version FROM work.initiatives
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND id = NEW.result_resource_id;
    WHEN 'activity' THEN SELECT space_id, version INTO aggregate_space, resolved_aggregate_version FROM work.activities
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND id = NEW.result_resource_id;
    WHEN 'relationship' THEN SELECT space_id, version, valid_to INTO aggregate_space, resolved_aggregate_version, aggregate_valid_to FROM work.relationships
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND id = NEW.result_resource_id;
    WHEN 'content_item' THEN SELECT space_id, version, current_revision INTO aggregate_space, resolved_aggregate_version, aggregate_revision FROM content.content_items
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND id = NEW.result_resource_id;
    WHEN 'source_artifact' THEN SELECT space_id, version INTO aggregate_space, resolved_aggregate_version FROM content.source_artifacts
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND id = NEW.result_resource_id;
  END CASE;
  IF NOT FOUND OR resolved_aggregate_version <> (NEW.safe_response ->> 'version')::integer THEN
    RAISE EXCEPTION 'B1 command result does not match the committed aggregate version';
  END IF;
  IF NEW.command_kind IN ('organization.create.v1','initiative.create.v1','activity.create.v1',
      'relationship.create.v1')
    AND (NEW.safe_response ->> 'spaceId')::uuid <> aggregate_space THEN
    RAISE EXCEPTION 'B1 command result Space does not match its aggregate';
  END IF;
  IF NEW.command_kind IN ('content.create.v1','content.revise.v1')
    AND aggregate_revision <> (NEW.safe_response ->> 'revisionNumber')::integer THEN
    RAISE EXCEPTION 'B1 content result does not match its current revision';
  END IF;
  IF NEW.command_kind = 'relationship.end.v1'
    AND aggregate_valid_to IS DISTINCT FROM (NEW.safe_response ->> 'validTo')::timestamptz THEN
    RAISE EXCEPTION 'B1 relationship result does not match its validity end';
  END IF;
  IF NEW.command_kind IN ('source.capture.v1','source.correct.v1') THEN
    SELECT count(*) INTO aggregate_chunk_count FROM content.source_chunks chunk
    WHERE chunk.tenant_id = NEW.tenant_id AND chunk.workspace_id = NEW.workspace_id
      AND chunk.source_artifact_id = NEW.result_resource_id;
    IF aggregate_chunk_count <> (NEW.safe_response ->> 'chunkCount')::integer THEN
      RAISE EXCEPTION 'B1 source result does not match its chunks';
    END IF;
  END IF;

  SELECT count(*) INTO audit_count FROM ops.audit_events audit
  WHERE audit.tenant_id = NEW.tenant_id AND audit.workspace_id = NEW.workspace_id
    AND audit.causation_command_id = NEW.id AND audit.action = expected_action
    AND audit.resource_type = expected_aggregate AND audit.resource_id = NEW.result_resource_id
    AND audit.space_id = aggregate_space;
  SELECT count(*) INTO outbox_count FROM ops.product_outbox_events event
  WHERE event.tenant_id = NEW.tenant_id AND event.workspace_id = NEW.workspace_id
    AND event.causation_command_id = NEW.id AND event.event_type = expected_event
    AND event.aggregate_type = expected_aggregate AND event.aggregate_id = NEW.result_resource_id
    AND event.aggregate_version = resolved_aggregate_version AND event.space_id = aggregate_space;
  IF audit_count <> 1 OR outbox_count <> 1
    OR (SELECT count(*) FROM ops.audit_events WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id AND causation_command_id = NEW.id) <> 1
    OR (SELECT count(*) FROM ops.product_outbox_events WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id AND causation_command_id = NEW.id) <> 1 THEN
    RAISE EXCEPTION 'B1 command requires exactly one matching audit and product notification';
  END IF;

  SELECT relay_service_principal_id, policy_version_id INTO outbox_record
  FROM ops.product_outbox_events
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND causation_command_id = NEW.id;
  IF outbox_record.policy_version_id <> NEW.policy_version_id THEN
    RAISE EXCEPTION 'B1 notification policy does not match command policy';
  END IF;

  IF NEW.command_kind IN ('organization.create.v1','initiative.create.v1') THEN
    child_kind := CASE NEW.command_kind WHEN 'organization.create.v1' THEN 'organization' ELSE 'initiative' END;
    IF NOT ops.is_uuid_v7(aggregate_space) OR NOT EXISTS (
      SELECT 1 FROM access.spaces child
      WHERE child.tenant_id = NEW.tenant_id AND child.workspace_id = NEW.workspace_id
        AND child.id = aggregate_space AND child.parent_space_id = NEW.reservation_space_id
        AND child.kind = child_kind AND child.archived_at IS NULL
    ) OR (SELECT count(*) FROM access.access_relationships grant_record
      JOIN identity.service_principals principal
        ON principal.tenant_id = grant_record.tenant_id
        AND principal.workspace_id = grant_record.workspace_id
        AND principal.id = grant_record.subject_id
      WHERE grant_record.tenant_id = NEW.tenant_id AND grant_record.workspace_id = NEW.workspace_id
        AND grant_record.subject_type = 'service_principal'
        AND grant_record.subject_id = outbox_record.relay_service_principal_id
        AND grant_record.relation = 'manager' AND grant_record.resource_type = 'space'
        AND grant_record.resource_id = aggregate_space AND grant_record.source = 'direct'
        AND principal.purpose = 'product_notification_relay' AND principal.status = 'active') <> 1 THEN
      RAISE EXCEPTION 'B1 child creation lacks its exact relay access binding';
    END IF;
  ELSIF aggregate_space <> NEW.reservation_space_id THEN
    RAISE EXCEPTION 'B1 command reservation Space does not match its aggregate';
  END IF;

  IF NEW.command_kind = 'source.capture.v1' AND NOT EXISTS (
    SELECT 1 FROM work.activity_sources link
    WHERE link.tenant_id = NEW.tenant_id AND link.workspace_id = NEW.workspace_id
      AND link.activity_id = (NEW.safe_response ->> 'activityId')::uuid
      AND link.source_artifact_id = NEW.result_resource_id AND link.space_id = aggregate_space
  ) THEN RAISE EXCEPTION 'captured source is not linked to its Activity'; END IF;
  IF NEW.command_kind = 'source.correct.v1' AND NOT EXISTS (
    SELECT 1 FROM content.source_artifacts successor
    WHERE successor.tenant_id = NEW.tenant_id AND successor.workspace_id = NEW.workspace_id
      AND successor.id = NEW.result_resource_id
      AND successor.supersedes_source_id = (NEW.safe_response ->> 'previousSourceArtifactId')::uuid
  ) THEN RAISE EXCEPTION 'corrected source does not reference its predecessor'; END IF;
  IF NEW.command_kind = 'source.tombstone.v1' AND NOT EXISTS (
    SELECT 1 FROM content.source_artifacts source
    WHERE source.tenant_id = NEW.tenant_id AND source.workspace_id = NEW.workspace_id
      AND source.id = NEW.result_resource_id AND source.deleted_at IS NOT NULL
      AND source.hash_disposition = NEW.safe_response ->> 'hashDisposition'
      AND NOT EXISTS (SELECT 1 FROM content.source_chunks chunk
        WHERE chunk.tenant_id = source.tenant_id AND chunk.workspace_id = source.workspace_id
          AND chunk.source_artifact_id = source.id)
  ) THEN RAISE EXCEPTION 'source tombstone reconciliation is incomplete'; END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER domain_command_records_b1_atomicity_deferred
AFTER INSERT OR UPDATE ON ops.domain_command_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ops.require_b1_command_atomicity();

ALTER FUNCTION ops.require_b1_command_atomicity() OWNER TO throughline_b1_0_integrity;
REVOKE ALL ON FUNCTION ops.require_b1_command_atomicity() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.b1_command_record_valid(text, integer, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.b1_command_record_valid(text, integer, text, text, uuid, jsonb)
  TO throughline_app;

DO $assertions$
BEGIN
  IF to_regclass('ops.domain_events') IS NOT NULL THEN
    RAISE EXCEPTION 'B1 must not create a duplicate domain event ledger';
  END IF;
  IF has_table_privilege('throughline_relay', 'work.organizations', 'SELECT')
    OR has_table_privilege('throughline_worker', 'content.source_artifacts', 'SELECT')
    OR has_table_privilege('throughline_product_relay', 'ops.domain_command_records', 'INSERT') THEN
    RAISE EXCEPTION 'B1 role isolation was weakened';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ops.domain_command_records'::regclass
      AND tgname = 'domain_command_records_b1_atomicity_deferred'
      AND tgconstraint <> 0
  ) THEN RAISE EXCEPTION 'B1 deferred command integrity trigger is missing'; END IF;
END
$assertions$;
