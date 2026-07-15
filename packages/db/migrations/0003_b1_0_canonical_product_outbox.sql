SET LOCAL search_path TO pg_catalog;

DO $role$
DECLARE
  granted_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'throughline_product_relay') THEN
    CREATE ROLE throughline_product_relay
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  FOR granted_role IN
    SELECT granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'throughline_product_relay'
  LOOP
    EXECUTE format('REVOKE %I FROM throughline_product_relay', granted_role);
  END LOOP;

  ALTER ROLE throughline_product_relay
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
END
$role$;

DO $prepare_contract_schema$
BEGIN
  IF to_regnamespace('throughline_b1_0_migration_contract') IS NOT NULL THEN
    RAISE EXCEPTION
      'B1.0 migration contract schema already exists; refusing unsafe adoption';
  END IF;
END
$prepare_contract_schema$;

CREATE SCHEMA throughline_b1_0_migration_contract;
REVOKE ALL PRIVILEGES ON SCHEMA throughline_b1_0_migration_contract FROM PUBLIC;

CREATE TABLE throughline_b1_0_migration_contract.b1_0_expected_service_principal_purpose (
  purpose text
);
ALTER TABLE throughline_b1_0_migration_contract.b1_0_expected_service_principal_purpose
  ADD CONSTRAINT b1_0_expected_service_principal_purpose_foundation
  CHECK (purpose IN ('worker', 'connector', 'system')),
  ADD CONSTRAINT b1_0_expected_service_principal_purpose_product
  CHECK (purpose IN ('worker', 'connector', 'system', 'product_notification_relay'));

DO $adopt_service_principal_purpose$
DECLARE
  actual_definition text;
BEGIN
  SELECT pg_get_constraintdef(constraint_record.oid)
  INTO actual_definition
  FROM pg_constraint AS constraint_record
  WHERE constraint_record.conrelid = 'identity.service_principals'::regclass
    AND constraint_record.conname = 'service_principals_purpose_check'
    AND constraint_record.contype = 'c'
    AND constraint_record.convalidated
    AND NOT constraint_record.condeferrable
    AND NOT constraint_record.condeferred;

  IF actual_definition IS NULL OR actual_definition NOT IN (
    SELECT pg_get_constraintdef(constraint_record.oid)
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.conrelid =
      'throughline_b1_0_migration_contract.b1_0_expected_service_principal_purpose'::regclass
  ) THEN
    RAISE EXCEPTION
      'Existing constraint service_principals_purpose_check does not match an accepted definition';
  END IF;
END
$adopt_service_principal_purpose$;

DO $adopt_functions$
DECLARE
  expected_function record;
  installed_function record;
BEGIN
  FOR expected_function IN
    SELECT *
    FROM (VALUES
      ('is_uuid_v7', 'uuid', 'boolean', 'sql', 'i', true, 'b898da6973f850c9ea0050413fccfbf6'),
      ('product_safe_json', 'jsonb', 'boolean', 'plpgsql', 'i', true, '76c9b68fa18aa9092a631a8bc459b831'),
      ('product_event_payload_valid', 'text, integer, uuid, jsonb', 'boolean', 'plpgsql', 'i', true, '7051124c6fdef53ea1ab1d3e84c133f1'),
      ('enforce_domain_command_transition', '', 'trigger', 'plpgsql', 'v', false, '8559d04ff4138c55d9a36c98a6661e9d'),
      ('reject_committed_reserved_command', '', 'trigger', 'plpgsql', 'v', false, '443e0136eb3745677d174bfaad1be7c1'),
      ('reject_audit_event_mutation', '', 'trigger', 'plpgsql', 'v', false, '4ed19d7809b95466646e5674aef11d5e'),
      ('enforce_product_outbox_transition', '', 'trigger', 'plpgsql', 'v', false, '0f84372b13204352ba3b93e406fd3fa7'),
      ('validate_product_outbox_relay_binding', '', 'trigger', 'plpgsql', 'v', false, 'fa6fc5ad8aee30d6d74165ea0407675f')
    ) AS expected(
      function_name, identity_arguments, result_type, language_name,
      volatility_code, is_strict, source_md5
    )
  LOOP
    SELECT
      oidvectortypes(procedure_record.proargtypes) AS identity_arguments,
      pg_get_function_result(procedure_record.oid) AS result_type,
      language_record.lanname AS language_name,
      procedure_record.provolatile::text AS volatility_code,
      procedure_record.proisstrict AS is_strict,
      procedure_record.prosecdef AS security_definer,
      procedure_record.prokind::text AS function_kind,
      md5(procedure_record.prosrc) AS source_md5
    INTO installed_function
    FROM pg_proc AS procedure_record
    JOIN pg_namespace AS namespace_record
      ON namespace_record.oid = procedure_record.pronamespace
    JOIN pg_language AS language_record
      ON language_record.oid = procedure_record.prolang
    WHERE namespace_record.nspname = 'ops'
      AND procedure_record.proname = expected_function.function_name
      AND oidvectortypes(procedure_record.proargtypes) = expected_function.identity_arguments;

    IF FOUND AND ROW(
      installed_function.identity_arguments,
      installed_function.result_type,
      installed_function.language_name,
      installed_function.volatility_code,
      installed_function.is_strict,
      installed_function.security_definer,
      installed_function.function_kind,
      installed_function.source_md5
    ) IS DISTINCT FROM ROW(
      expected_function.identity_arguments,
      expected_function.result_type,
      expected_function.language_name,
      expected_function.volatility_code,
      expected_function.is_strict,
      false,
      'f',
      expected_function.source_md5
    ) THEN
      RAISE EXCEPTION 'Existing function ops.%(%) does not match the B1.0 definition',
        expected_function.function_name, expected_function.identity_arguments;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure_record
    JOIN pg_namespace AS namespace_record
      ON namespace_record.oid = procedure_record.pronamespace
    WHERE namespace_record.nspname = 'ops'
      AND procedure_record.proname IN (
        'is_uuid_v7', 'product_safe_json', 'product_event_payload_valid',
        'enforce_domain_command_transition', 'reject_committed_reserved_command',
        'reject_audit_event_mutation', 'enforce_product_outbox_transition',
        'validate_product_outbox_relay_binding'
      )
      AND (procedure_record.proname, oidvectortypes(procedure_record.proargtypes)) NOT IN (
        ('is_uuid_v7', 'uuid'),
        ('product_safe_json', 'jsonb'),
        ('product_event_payload_valid', 'text, integer, uuid, jsonb'),
        ('enforce_domain_command_transition', ''),
        ('reject_committed_reserved_command', ''),
        ('reject_audit_event_mutation', ''),
        ('enforce_product_outbox_transition', ''),
        ('validate_product_outbox_relay_binding', '')
      )
  ) THEN
    RAISE EXCEPTION 'Existing ops function overload conflicts with the closed B1.0 contract';
  END IF;
END
$adopt_functions$;

ALTER TABLE identity.service_principals
  DROP CONSTRAINT service_principals_purpose_check;
ALTER TABLE identity.service_principals
  ADD CONSTRAINT service_principals_purpose_check
  CHECK (purpose IN ('worker', 'connector', 'system', 'product_notification_relay'));

DO $adopt_indexes$
DECLARE
  expected_index record;
  installed_index record;
  normalized_predicate text;
BEGIN
  FOR expected_index IN
    SELECT *
    FROM (VALUES
      (
        'identity', 'service_principals_product_notification_relay_unique',
        'service_principals', true, ARRAY['tenant_id', 'workspace_id']::text[],
        'purpose = ''product_notification_relay'''
      ),
      (
        'ops', 'domain_command_records_scope_created_idx', 'domain_command_records', false,
        ARRAY['tenant_id', 'workspace_id', 'reservation_space_id', 'created_at']::text[], ''
      ),
      (
        'ops', 'audit_events_resource_created_idx', 'audit_events', false,
        ARRAY[
          'tenant_id', 'workspace_id', 'space_id', 'resource_type', 'resource_id', 'created_at'
        ]::text[], ''
      ),
      (
        'ops', 'audit_events_command_idx', 'audit_events', false,
        ARRAY['tenant_id', 'workspace_id', 'causation_command_id']::text[], ''
      ),
      (
        'ops', 'product_outbox_events_publishable_idx', 'product_outbox_events', false,
        ARRAY['next_attempt_at', 'created_at', 'id']::text[],
        'publication_state = ANY (ARRAY[''pending''::text, ''retry_wait''::text, ''claimed''::text])'
      ),
      (
        'ops', 'product_outbox_events_scope_created_idx', 'product_outbox_events', false,
        ARRAY['tenant_id', 'workspace_id', 'space_id', 'created_at', 'id']::text[], ''
      )
    ) AS expected(
      schema_name, index_name, table_name, is_unique, key_columns, predicate_expression
    )
  LOOP
    SELECT
      table_namespace.nspname AS table_schema,
      table_relation.relname AS table_name,
      access_method.amname AS access_method,
      index_record.indisunique AS is_unique,
      index_record.indisprimary AS is_primary,
      index_record.indisexclusion AS is_exclusion,
      index_record.indimmediate AS is_immediate,
      index_record.indisvalid AS is_valid,
      index_record.indisready AS is_ready,
      index_record.indislive AS is_live,
      index_record.indnullsnotdistinct AS nulls_not_distinct,
      index_record.indnatts AS attribute_count,
      index_record.indnkeyatts AS key_attribute_count,
      ARRAY(
        SELECT attribute_record.attname::text
        FROM unnest(index_record.indkey::smallint[]) WITH ORDINALITY AS key_record(attnum, ordinal)
        JOIN pg_attribute AS attribute_record
          ON attribute_record.attrelid = index_record.indrelid
         AND attribute_record.attnum = key_record.attnum
        WHERE key_record.ordinal <= index_record.indnkeyatts
        ORDER BY key_record.ordinal
      ) AS key_columns,
      lower(regexp_replace(regexp_replace(
        COALESCE(pg_get_expr(index_record.indpred, index_record.indrelid), ''),
        '::text', '', 'g'
      ), '[()[:space:]]', '', 'g')) AS predicate_expression
    INTO installed_index
    FROM pg_class AS index_relation
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_index AS index_record ON index_record.indexrelid = index_relation.oid
    JOIN pg_class AS table_relation ON table_relation.oid = index_record.indrelid
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE index_namespace.nspname = expected_index.schema_name
      AND index_relation.relname = expected_index.index_name;

    normalized_predicate := lower(regexp_replace(regexp_replace(
      expected_index.predicate_expression, '::text', '', 'g'
    ), '[()[:space:]]', '', 'g'));

    IF FOUND AND ROW(
      installed_index.table_schema,
      installed_index.table_name,
      installed_index.access_method,
      installed_index.is_unique,
      installed_index.is_primary,
      installed_index.is_exclusion,
      installed_index.is_immediate,
      installed_index.is_valid,
      installed_index.is_ready,
      installed_index.is_live,
      installed_index.nulls_not_distinct,
      installed_index.attribute_count,
      installed_index.key_attribute_count,
      installed_index.key_columns,
      installed_index.predicate_expression
    ) IS DISTINCT FROM ROW(
      expected_index.schema_name,
      expected_index.table_name,
      'btree',
      expected_index.is_unique,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      cardinality(expected_index.key_columns),
      cardinality(expected_index.key_columns),
      expected_index.key_columns,
      normalized_predicate
    ) THEN
      RAISE EXCEPTION 'Existing index %.% does not match the B1.0 definition',
        expected_index.schema_name, expected_index.index_name;
    END IF;

    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM pg_class WHERE relname = expected_index.index_name
    ) THEN
      RAISE EXCEPTION 'Existing index % is installed in the wrong schema',
        expected_index.index_name;
    END IF;
  END LOOP;
END
$adopt_indexes$;

CREATE UNIQUE INDEX IF NOT EXISTS service_principals_product_notification_relay_unique
  ON identity.service_principals (tenant_id, workspace_id)
  WHERE purpose = 'product_notification_relay';

CREATE OR REPLACE FUNCTION ops.is_uuid_v7(value uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT substring(value::text FROM 15 FOR 1) = '7'
    AND substring(value::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
$function$;

CREATE OR REPLACE FUNCTION ops.product_safe_json(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  item_key text;
  item_value jsonb;
BEGIN
  IF octet_length(document::text) > 16384 THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(document) = 'object' THEN
    FOR item_key, item_value IN SELECT key, value FROM jsonb_each(document)
    LOOP
      IF lower(item_key) ~ '(raw.?source|source.?text|immutable.?text|normalized.?text|object.?key|credential|secret|password|token|api.?key|primary.?email|external.?refs|policy.?erased.?hash|content.?hash|normalized.?content.?hash)'
        OR NOT ops.product_safe_json(item_value)
      THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR item_value IN SELECT value FROM jsonb_array_elements(document)
    LOOP
      IF NOT ops.product_safe_json(item_value) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'string' THEN
    IF length(document #>> '{}') > 2000 OR (document #>> '{}') ~ '[[:cntrl:]]' THEN
      RETURN false;
    END IF;
  ELSIF jsonb_typeof(document) = 'number' THEN
    IF abs((document #>> '{}')::numeric) > 9007199254740991 THEN
      RETURN false;
    END IF;
  ELSIF jsonb_typeof(document) NOT IN ('boolean', 'null') THEN
    RETURN false;
  END IF;

  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION ops.product_event_payload_valid(
  event_type_value text,
  payload_schema_version_value integer,
  aggregate_id_value uuid,
  payload_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  payload_keys text[];
  aggregate_key text;
BEGIN
  IF payload_schema_version_value <> 1
    OR jsonb_typeof(payload_value) <> 'object'
    OR NOT ops.product_safe_json(payload_value)
  THEN
    RETURN false;
  END IF;

  SELECT array_agg(key ORDER BY key) INTO payload_keys FROM jsonb_object_keys(payload_value) AS key;

  aggregate_key := CASE event_type_value
    WHEN 'organization.created' THEN 'organizationId'
    WHEN 'initiative.created' THEN 'initiativeId'
    WHEN 'activity.created' THEN 'activityId'
    WHEN 'relationship.created' THEN 'relationshipId'
    WHEN 'content.created' THEN 'contentItemId'
    WHEN 'source_artifact.captured' THEN 'sourceArtifactId'
    ELSE NULL
  END;

  IF aggregate_key IS NOT NULL THEN
    RETURN payload_keys = ARRAY[aggregate_key]
      AND payload_value->>aggregate_key = aggregate_id_value::text;
  END IF;

  CASE event_type_value
    WHEN 'activity.capture_added' THEN
      RETURN payload_keys = ARRAY['activityId', 'sourceArtifactId']
        AND payload_value->>'activityId' = aggregate_id_value::text
        AND payload_value->>'sourceArtifactId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
    WHEN 'relationship.ended' THEN
      RETURN payload_keys = ARRAY['relationshipId', 'validTo']
        AND payload_value->>'relationshipId' = aggregate_id_value::text
        AND payload_value->>'validTo' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$';
    WHEN 'content.revised' THEN
      RETURN payload_keys = ARRAY['contentItemId', 'revisionNumber']
        AND payload_value->>'contentItemId' = aggregate_id_value::text
        AND jsonb_typeof(payload_value->'revisionNumber') = 'number'
        AND payload_value->>'revisionNumber' ~ '^[1-9][0-9]*$';
    WHEN 'source_artifact.corrected' THEN
      RETURN payload_keys = ARRAY['previousSourceArtifactId', 'sourceArtifactId']
        AND payload_value->>'sourceArtifactId' = aggregate_id_value::text
        AND payload_value->>'previousSourceArtifactId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND payload_value->>'previousSourceArtifactId' <> aggregate_id_value::text;
    WHEN 'source_artifact.tombstoned' THEN
      RETURN payload_keys = ARRAY['deletionPolicyRef', 'deletionReasonCategory', 'hashDisposition', 'sourceArtifactId']
        AND payload_value->>'sourceArtifactId' = aggregate_id_value::text
        AND payload_value->>'deletionPolicyRef' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
        AND payload_value->>'deletionReasonCategory' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
        AND payload_value->>'hashDisposition' IN ('retained', 'erased');
    ELSE
      RETURN false;
  END CASE;
END
$function$;

DO $adopt_tables$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'domain_command_records', 'audit_events', 'product_outbox_events'
  ] LOOP
    IF to_regclass('ops.' || table_name) IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM pg_class AS relation_record
      JOIN pg_namespace AS namespace_record ON namespace_record.oid = relation_record.relnamespace
      WHERE namespace_record.nspname = 'ops'
        AND relation_record.relname = table_name
        AND relation_record.relkind = 'r'
        AND relation_record.relpersistence = 'p'
        AND relation_record.relrowsecurity
        AND relation_record.relforcerowsecurity
        AND NOT relation_record.relispartition
    ) THEN
      RAISE EXCEPTION 'Existing table ops.% does not have the required table security shape',
        table_name;
    END IF;
  END LOOP;
END
$adopt_tables$;

CREATE TABLE IF NOT EXISTS ops.domain_command_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  reservation_space_id uuid NOT NULL,
  command_kind text NOT NULL,
  command_schema_version integer NOT NULL,
  idempotency_key text NOT NULL,
  canonical_request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  result_resource_type text,
  result_resource_id uuid,
  safe_response jsonb,
  actor_user_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  delegating_user_id uuid,
  delegating_membership_id uuid,
  agent_principal_id uuid,
  policy_version_id text NOT NULL,
  request_id text NOT NULL,
  traceparent text NOT NULL,
  tracestate text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT domain_command_records_scope_id_unique
    UNIQUE (tenant_id, workspace_id, id),
  CONSTRAINT domain_command_records_idempotency_unique
    UNIQUE (tenant_id, workspace_id, reservation_space_id, command_kind, idempotency_key),
  CONSTRAINT domain_command_records_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  CONSTRAINT domain_command_records_space_fk
    FOREIGN KEY (tenant_id, workspace_id, reservation_space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  CONSTRAINT domain_command_records_actor_fk
    FOREIGN KEY (tenant_id, workspace_id, actor_membership_id, actor_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  CONSTRAINT domain_command_records_delegator_fk
    FOREIGN KEY (tenant_id, workspace_id, delegating_membership_id, delegating_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  CONSTRAINT domain_command_records_agent_fk
    FOREIGN KEY (tenant_id, workspace_id, agent_principal_id)
    REFERENCES identity.agent_principals(tenant_id, workspace_id, id),
  CONSTRAINT domain_command_records_policy_fk
    FOREIGN KEY (tenant_id, workspace_id, policy_version_id)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  CONSTRAINT domain_command_records_uuid_v7_check CHECK (ops.is_uuid_v7(id)),
  CONSTRAINT domain_command_records_kind_check CHECK (
    length(command_kind) BETWEEN 3 AND 100
    AND command_kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[1-9][0-9]*$'
  ),
  CONSTRAINT domain_command_records_schema_version_check CHECK (command_schema_version > 0),
  CONSTRAINT domain_command_records_idempotency_key_check CHECK (
    length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT domain_command_records_request_hash_check
    CHECK (canonical_request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT domain_command_records_state_check CHECK (state IN ('reserved', 'completed')),
  CONSTRAINT domain_command_records_result_check CHECK (
    (result_resource_type IS NULL AND result_resource_id IS NULL)
    OR (
      result_resource_type ~ '^[a-z][a-z0-9_]{0,63}$'
      AND result_resource_id IS NOT NULL
      AND ops.is_uuid_v7(result_resource_id)
    )
  ),
  CONSTRAINT domain_command_records_response_check CHECK (
    safe_response IS NULL
    OR (jsonb_typeof(safe_response) = 'object' AND ops.product_safe_json(safe_response))
  ),
  CONSTRAINT domain_command_records_delegation_check CHECK (
    (delegating_user_id IS NULL) = (delegating_membership_id IS NULL)
  ),
  CONSTRAINT domain_command_records_lifecycle_check CHECK (
    (state = 'reserved' AND result_resource_type IS NULL AND result_resource_id IS NULL
      AND safe_response IS NULL AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT domain_command_records_request_check CHECK (
    length(request_id) BETWEEN 1 AND 200 AND request_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT domain_command_records_trace_check CHECK (
    traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
    AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    AND (tracestate IS NULL OR (length(tracestate) BETWEEN 1 AND 512 AND tracestate !~ '[[:cntrl:]]'))
  ),
  CONSTRAINT domain_command_records_time_check CHECK (
    updated_at >= created_at AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE TABLE IF NOT EXISTS ops.audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  causation_command_id uuid NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  delegating_user_id uuid,
  delegating_membership_id uuid,
  agent_principal_id uuid,
  policy_version_id text NOT NULL,
  request_id text NOT NULL,
  traceparent text NOT NULL,
  tracestate text,
  audit_schema_version integer NOT NULL,
  safe_detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_scope_id_unique UNIQUE (tenant_id, workspace_id, space_id, id),
  CONSTRAINT audit_events_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  CONSTRAINT audit_events_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  CONSTRAINT audit_events_command_fk
    FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  CONSTRAINT audit_events_actor_fk
    FOREIGN KEY (tenant_id, workspace_id, actor_membership_id, actor_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  CONSTRAINT audit_events_delegator_fk
    FOREIGN KEY (tenant_id, workspace_id, delegating_membership_id, delegating_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  CONSTRAINT audit_events_agent_fk
    FOREIGN KEY (tenant_id, workspace_id, agent_principal_id)
    REFERENCES identity.agent_principals(tenant_id, workspace_id, id),
  CONSTRAINT audit_events_policy_fk
    FOREIGN KEY (tenant_id, workspace_id, policy_version_id)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  CONSTRAINT audit_events_uuid_v7_check
    CHECK (ops.is_uuid_v7(id) AND ops.is_uuid_v7(resource_id)),
  CONSTRAINT audit_events_action_check CHECK (action IN (
    'organization.create', 'initiative.create', 'activity.create', 'activity.capture_add',
    'relationship.create', 'relationship.end', 'content.create', 'content.revise',
    'source_artifact.capture', 'source_artifact.correct', 'source_artifact.tombstone'
  )),
  CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN (
    'organization', 'initiative', 'activity', 'relationship', 'content_item', 'source_artifact'
  )),
  CONSTRAINT audit_events_action_resource_pair_check CHECK (
    (action = 'organization.create' AND resource_type = 'organization')
    OR (action = 'initiative.create' AND resource_type = 'initiative')
    OR (action IN ('activity.create', 'activity.capture_add') AND resource_type = 'activity')
    OR (action IN ('relationship.create', 'relationship.end') AND resource_type = 'relationship')
    OR (action IN ('content.create', 'content.revise') AND resource_type = 'content_item')
    OR (action IN ('source_artifact.capture', 'source_artifact.correct', 'source_artifact.tombstone')
      AND resource_type = 'source_artifact')
  ),
  CONSTRAINT audit_events_delegation_check CHECK (
    (delegating_user_id IS NULL) = (delegating_membership_id IS NULL)
  ),
  CONSTRAINT audit_events_schema_version_check CHECK (audit_schema_version > 0),
  CONSTRAINT audit_events_detail_check CHECK (
    jsonb_typeof(safe_detail) = 'object' AND ops.product_safe_json(safe_detail)
  ),
  CONSTRAINT audit_events_request_check CHECK (
    length(request_id) BETWEEN 1 AND 200 AND request_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT audit_events_trace_check CHECK (
    traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
    AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    AND (tracestate IS NULL OR (length(tracestate) BETWEEN 1 AND 512 AND tracestate !~ '[[:cntrl:]]'))
  )
);

CREATE TABLE IF NOT EXISTS ops.product_outbox_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  relay_service_principal_id uuid NOT NULL,
  policy_version_id text NOT NULL,
  event_type text NOT NULL,
  event_schema_version integer NOT NULL,
  payload_schema_version integer NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  causation_command_id uuid NOT NULL,
  payload jsonb NOT NULL,
  request_id text NOT NULL,
  traceparent text NOT NULL,
  tracestate text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  publication_state text NOT NULL DEFAULT 'pending',
  publication_attempt integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  claimed_by text,
  claim_token text,
  claim_expires_at timestamptz,
  last_outcome_code text,
  published_at timestamptz,
  published_message_id text,
  terminal_at timestamptz,
  CONSTRAINT product_outbox_events_scope_id_unique
    UNIQUE (tenant_id, workspace_id, space_id, id),
  CONSTRAINT product_outbox_events_semantic_unique
    UNIQUE (
      tenant_id, workspace_id, space_id, causation_command_id, event_type,
      aggregate_type, aggregate_id, aggregate_version
    ),
  CONSTRAINT product_outbox_events_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  CONSTRAINT product_outbox_events_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  CONSTRAINT product_outbox_events_relay_fk
    FOREIGN KEY (tenant_id, workspace_id, relay_service_principal_id)
    REFERENCES identity.service_principals(tenant_id, workspace_id, id),
  CONSTRAINT product_outbox_events_policy_fk
    FOREIGN KEY (tenant_id, workspace_id, policy_version_id)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  CONSTRAINT product_outbox_events_command_fk
    FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  CONSTRAINT product_outbox_events_uuid_v7_check
    CHECK (ops.is_uuid_v7(id) AND ops.is_uuid_v7(aggregate_id)),
  CONSTRAINT product_outbox_events_event_type_check CHECK (event_type IN (
    'organization.created', 'initiative.created', 'activity.created', 'activity.capture_added',
    'relationship.created', 'relationship.ended', 'content.created', 'content.revised',
    'source_artifact.captured', 'source_artifact.corrected', 'source_artifact.tombstoned'
  )),
  CONSTRAINT product_outbox_events_aggregate_type_check CHECK (aggregate_type IN (
    'organization', 'initiative', 'activity', 'relationship', 'content_item', 'source_artifact'
  )),
  CONSTRAINT product_outbox_events_event_aggregate_pair_check CHECK (
    (event_type = 'organization.created' AND aggregate_type = 'organization')
    OR (event_type = 'initiative.created' AND aggregate_type = 'initiative')
    OR (event_type IN ('activity.created', 'activity.capture_added') AND aggregate_type = 'activity')
    OR (event_type IN ('relationship.created', 'relationship.ended') AND aggregate_type = 'relationship')
    OR (event_type IN ('content.created', 'content.revised') AND aggregate_type = 'content_item')
    OR (event_type IN (
      'source_artifact.captured', 'source_artifact.corrected', 'source_artifact.tombstoned'
    ) AND aggregate_type = 'source_artifact')
  ),
  CONSTRAINT product_outbox_events_version_check CHECK (
    event_schema_version = 1 AND payload_schema_version = 1 AND aggregate_version > 0
  ),
  CONSTRAINT product_outbox_events_payload_check CHECK (
    ops.product_event_payload_valid(event_type, payload_schema_version, aggregate_id, payload)
  ),
  CONSTRAINT product_outbox_events_request_check CHECK (
    length(request_id) BETWEEN 1 AND 200 AND request_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT product_outbox_events_trace_check CHECK (
    traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
    AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    AND (tracestate IS NULL OR (length(tracestate) BETWEEN 1 AND 512 AND tracestate !~ '[[:cntrl:]]'))
  ),
  CONSTRAINT product_outbox_events_state_check CHECK (publication_state IN (
    'pending', 'claimed', 'retry_wait', 'published', 'terminal_failed', 'terminal_unconfirmed'
  )),
  CONSTRAINT product_outbox_events_attempt_check CHECK (publication_attempt BETWEEN 0 AND 6),
  CONSTRAINT product_outbox_events_claim_check CHECK (
    (
      publication_state = 'claimed'
      AND publication_attempt BETWEEN 1 AND 6
      AND claimed_at IS NOT NULL
      AND claimed_by IS NOT NULL
      AND length(claimed_by) BETWEEN 1 AND 128
      AND claimed_by !~ '[[:cntrl:]]'
      AND claim_token ~ '^[A-Za-z0-9_-]{43}$'
      AND claim_expires_at > claimed_at
    )
    OR (
      publication_state <> 'claimed'
      AND claimed_at IS NULL AND claimed_by IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL
    )
  ),
  CONSTRAINT product_outbox_events_publication_check CHECK (
    (publication_state = 'published' AND published_at IS NOT NULL
      AND published_message_id IS NOT NULL AND length(published_message_id) BETWEEN 1 AND 200
      AND published_message_id !~ '[[:cntrl:]]')
    OR (publication_state <> 'published' AND published_at IS NULL AND published_message_id IS NULL)
  ),
  CONSTRAINT product_outbox_events_terminal_check CHECK (
    (publication_state IN ('terminal_failed', 'terminal_unconfirmed')
      AND terminal_at IS NOT NULL AND last_outcome_code IS NOT NULL)
    OR (publication_state NOT IN ('terminal_failed', 'terminal_unconfirmed') AND terminal_at IS NULL)
  ),
  CONSTRAINT product_outbox_events_pending_retry_check CHECK (
    (publication_state = 'pending' AND publication_attempt = 0 AND last_outcome_code IS NULL)
    OR (publication_state = 'retry_wait' AND publication_attempt BETWEEN 1 AND 5
      AND last_outcome_code IS NOT NULL)
    OR publication_state IN ('claimed', 'published', 'terminal_failed', 'terminal_unconfirmed')
  ),
  CONSTRAINT product_outbox_events_outcome_code_check CHECK (
    last_outcome_code IS NULL OR last_outcome_code ~ '^[a-z0-9][a-z0-9_]{0,99}$'
  )
);

CREATE TABLE throughline_b1_0_migration_contract.b1_0_expected_domain_command_records
  (LIKE ops.domain_command_records INCLUDING DEFAULTS);
ALTER TABLE throughline_b1_0_migration_contract.b1_0_expected_domain_command_records
  ADD CONSTRAINT domain_command_records_pkey PRIMARY KEY (id),
  ADD CONSTRAINT domain_command_records_scope_id_unique
    UNIQUE (tenant_id, workspace_id, id),
  ADD CONSTRAINT domain_command_records_idempotency_unique
    UNIQUE (tenant_id, workspace_id, reservation_space_id, command_kind, idempotency_key),
  ADD CONSTRAINT domain_command_records_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  ADD CONSTRAINT domain_command_records_space_fk
    FOREIGN KEY (tenant_id, workspace_id, reservation_space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  ADD CONSTRAINT domain_command_records_actor_fk
    FOREIGN KEY (tenant_id, workspace_id, actor_membership_id, actor_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  ADD CONSTRAINT domain_command_records_delegator_fk
    FOREIGN KEY (tenant_id, workspace_id, delegating_membership_id, delegating_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  ADD CONSTRAINT domain_command_records_agent_fk
    FOREIGN KEY (tenant_id, workspace_id, agent_principal_id)
    REFERENCES identity.agent_principals(tenant_id, workspace_id, id),
  ADD CONSTRAINT domain_command_records_policy_fk
    FOREIGN KEY (tenant_id, workspace_id, policy_version_id)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  ADD CONSTRAINT domain_command_records_uuid_v7_check CHECK (ops.is_uuid_v7(id)),
  ADD CONSTRAINT domain_command_records_kind_check CHECK (
    length(command_kind) BETWEEN 3 AND 100
    AND command_kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[1-9][0-9]*$'
  ),
  ADD CONSTRAINT domain_command_records_schema_version_check CHECK (command_schema_version > 0),
  ADD CONSTRAINT domain_command_records_idempotency_key_check CHECK (
    length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT domain_command_records_request_hash_check
    CHECK (canonical_request_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT domain_command_records_state_check CHECK (state IN ('reserved', 'completed')),
  ADD CONSTRAINT domain_command_records_result_check CHECK (
    (result_resource_type IS NULL AND result_resource_id IS NULL)
    OR (
      result_resource_type ~ '^[a-z][a-z0-9_]{0,63}$'
      AND result_resource_id IS NOT NULL
      AND ops.is_uuid_v7(result_resource_id)
    )
  ),
  ADD CONSTRAINT domain_command_records_response_check CHECK (
    safe_response IS NULL
    OR (jsonb_typeof(safe_response) = 'object' AND ops.product_safe_json(safe_response))
  ),
  ADD CONSTRAINT domain_command_records_delegation_check CHECK (
    (delegating_user_id IS NULL) = (delegating_membership_id IS NULL)
  ),
  ADD CONSTRAINT domain_command_records_lifecycle_check CHECK (
    (state = 'reserved' AND result_resource_type IS NULL AND result_resource_id IS NULL
      AND safe_response IS NULL AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT domain_command_records_request_check CHECK (
    length(request_id) BETWEEN 1 AND 200 AND request_id !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT domain_command_records_trace_check CHECK (
    traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
    AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    AND (tracestate IS NULL OR (length(tracestate) BETWEEN 1 AND 512
      AND tracestate !~ '[[:cntrl:]]'))
  ),
  ADD CONSTRAINT domain_command_records_time_check CHECK (
    updated_at >= created_at AND (completed_at IS NULL OR completed_at >= created_at)
  );

CREATE TABLE throughline_b1_0_migration_contract.b1_0_expected_audit_events
  (LIKE ops.audit_events INCLUDING DEFAULTS);
ALTER TABLE throughline_b1_0_migration_contract.b1_0_expected_audit_events
  ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id),
  ADD CONSTRAINT audit_events_scope_id_unique UNIQUE (tenant_id, workspace_id, space_id, id),
  ADD CONSTRAINT audit_events_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  ADD CONSTRAINT audit_events_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  ADD CONSTRAINT audit_events_command_fk
    FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  ADD CONSTRAINT audit_events_actor_fk
    FOREIGN KEY (tenant_id, workspace_id, actor_membership_id, actor_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  ADD CONSTRAINT audit_events_delegator_fk
    FOREIGN KEY (tenant_id, workspace_id, delegating_membership_id, delegating_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  ADD CONSTRAINT audit_events_agent_fk
    FOREIGN KEY (tenant_id, workspace_id, agent_principal_id)
    REFERENCES identity.agent_principals(tenant_id, workspace_id, id),
  ADD CONSTRAINT audit_events_policy_fk
    FOREIGN KEY (tenant_id, workspace_id, policy_version_id)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  ADD CONSTRAINT audit_events_uuid_v7_check
    CHECK (ops.is_uuid_v7(id) AND ops.is_uuid_v7(resource_id)),
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'organization.create', 'initiative.create', 'activity.create', 'activity.capture_add',
    'relationship.create', 'relationship.end', 'content.create', 'content.revise',
    'source_artifact.capture', 'source_artifact.correct', 'source_artifact.tombstone'
  )),
  ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN (
    'organization', 'initiative', 'activity', 'relationship', 'content_item', 'source_artifact'
  )),
  ADD CONSTRAINT audit_events_action_resource_pair_check CHECK (
    (action = 'organization.create' AND resource_type = 'organization')
    OR (action = 'initiative.create' AND resource_type = 'initiative')
    OR (action IN ('activity.create', 'activity.capture_add') AND resource_type = 'activity')
    OR (action IN ('relationship.create', 'relationship.end') AND resource_type = 'relationship')
    OR (action IN ('content.create', 'content.revise') AND resource_type = 'content_item')
    OR (action IN ('source_artifact.capture', 'source_artifact.correct',
      'source_artifact.tombstone') AND resource_type = 'source_artifact')
  ),
  ADD CONSTRAINT audit_events_delegation_check CHECK (
    (delegating_user_id IS NULL) = (delegating_membership_id IS NULL)
  ),
  ADD CONSTRAINT audit_events_schema_version_check CHECK (audit_schema_version > 0),
  ADD CONSTRAINT audit_events_detail_check CHECK (
    jsonb_typeof(safe_detail) = 'object' AND ops.product_safe_json(safe_detail)
  ),
  ADD CONSTRAINT audit_events_request_check CHECK (
    length(request_id) BETWEEN 1 AND 200 AND request_id !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT audit_events_trace_check CHECK (
    traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
    AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    AND (tracestate IS NULL OR (length(tracestate) BETWEEN 1 AND 512
      AND tracestate !~ '[[:cntrl:]]'))
  );

CREATE TABLE throughline_b1_0_migration_contract.b1_0_expected_product_outbox_events
  (LIKE ops.product_outbox_events INCLUDING DEFAULTS);
ALTER TABLE throughline_b1_0_migration_contract.b1_0_expected_product_outbox_events
  ADD CONSTRAINT product_outbox_events_pkey PRIMARY KEY (id),
  ADD CONSTRAINT product_outbox_events_scope_id_unique
    UNIQUE (tenant_id, workspace_id, space_id, id),
  ADD CONSTRAINT product_outbox_events_semantic_unique
    UNIQUE (
      tenant_id, workspace_id, space_id, causation_command_id, event_type,
      aggregate_type, aggregate_id, aggregate_version
    ),
  ADD CONSTRAINT product_outbox_events_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  ADD CONSTRAINT product_outbox_events_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  ADD CONSTRAINT product_outbox_events_relay_fk
    FOREIGN KEY (tenant_id, workspace_id, relay_service_principal_id)
    REFERENCES identity.service_principals(tenant_id, workspace_id, id),
  ADD CONSTRAINT product_outbox_events_policy_fk
    FOREIGN KEY (tenant_id, workspace_id, policy_version_id)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  ADD CONSTRAINT product_outbox_events_command_fk
    FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  ADD CONSTRAINT product_outbox_events_uuid_v7_check
    CHECK (ops.is_uuid_v7(id) AND ops.is_uuid_v7(aggregate_id)),
  ADD CONSTRAINT product_outbox_events_event_type_check CHECK (event_type IN (
    'organization.created', 'initiative.created', 'activity.created', 'activity.capture_added',
    'relationship.created', 'relationship.ended', 'content.created', 'content.revised',
    'source_artifact.captured', 'source_artifact.corrected', 'source_artifact.tombstoned'
  )),
  ADD CONSTRAINT product_outbox_events_aggregate_type_check CHECK (aggregate_type IN (
    'organization', 'initiative', 'activity', 'relationship', 'content_item', 'source_artifact'
  )),
  ADD CONSTRAINT product_outbox_events_event_aggregate_pair_check CHECK (
    (event_type = 'organization.created' AND aggregate_type = 'organization')
    OR (event_type = 'initiative.created' AND aggregate_type = 'initiative')
    OR (event_type IN ('activity.created', 'activity.capture_added')
      AND aggregate_type = 'activity')
    OR (event_type IN ('relationship.created', 'relationship.ended')
      AND aggregate_type = 'relationship')
    OR (event_type IN ('content.created', 'content.revised') AND aggregate_type = 'content_item')
    OR (event_type IN (
      'source_artifact.captured', 'source_artifact.corrected', 'source_artifact.tombstoned'
    ) AND aggregate_type = 'source_artifact')
  ),
  ADD CONSTRAINT product_outbox_events_version_check CHECK (
    event_schema_version = 1 AND payload_schema_version = 1 AND aggregate_version > 0
  ),
  ADD CONSTRAINT product_outbox_events_payload_check CHECK (
    ops.product_event_payload_valid(event_type, payload_schema_version, aggregate_id, payload)
  ),
  ADD CONSTRAINT product_outbox_events_request_check CHECK (
    length(request_id) BETWEEN 1 AND 200 AND request_id !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT product_outbox_events_trace_check CHECK (
    traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
    AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    AND (tracestate IS NULL OR (length(tracestate) BETWEEN 1 AND 512
      AND tracestate !~ '[[:cntrl:]]'))
  ),
  ADD CONSTRAINT product_outbox_events_state_check CHECK (publication_state IN (
    'pending', 'claimed', 'retry_wait', 'published', 'terminal_failed', 'terminal_unconfirmed'
  )),
  ADD CONSTRAINT product_outbox_events_attempt_check CHECK (publication_attempt BETWEEN 0 AND 6),
  ADD CONSTRAINT product_outbox_events_claim_check CHECK (
    (
      publication_state = 'claimed'
      AND publication_attempt BETWEEN 1 AND 6
      AND claimed_at IS NOT NULL
      AND claimed_by IS NOT NULL
      AND length(claimed_by) BETWEEN 1 AND 128
      AND claimed_by !~ '[[:cntrl:]]'
      AND claim_token ~ '^[A-Za-z0-9_-]{43}$'
      AND claim_expires_at > claimed_at
    )
    OR (
      publication_state <> 'claimed'
      AND claimed_at IS NULL AND claimed_by IS NULL AND claim_token IS NULL
      AND claim_expires_at IS NULL
    )
  ),
  ADD CONSTRAINT product_outbox_events_publication_check CHECK (
    (publication_state = 'published' AND published_at IS NOT NULL
      AND published_message_id IS NOT NULL AND length(published_message_id) BETWEEN 1 AND 200
      AND published_message_id !~ '[[:cntrl:]]')
    OR (publication_state <> 'published' AND published_at IS NULL AND published_message_id IS NULL)
  ),
  ADD CONSTRAINT product_outbox_events_terminal_check CHECK (
    (publication_state IN ('terminal_failed', 'terminal_unconfirmed')
      AND terminal_at IS NOT NULL AND last_outcome_code IS NOT NULL)
    OR (publication_state NOT IN ('terminal_failed', 'terminal_unconfirmed')
      AND terminal_at IS NULL)
  ),
  ADD CONSTRAINT product_outbox_events_pending_retry_check CHECK (
    (publication_state = 'pending' AND publication_attempt = 0 AND last_outcome_code IS NULL)
    OR (publication_state = 'retry_wait' AND publication_attempt BETWEEN 1 AND 5
      AND last_outcome_code IS NOT NULL)
    OR publication_state IN ('claimed', 'published', 'terminal_failed', 'terminal_unconfirmed')
  ),
  ADD CONSTRAINT product_outbox_events_outcome_code_check CHECK (
    last_outcome_code IS NULL OR last_outcome_code ~ '^[a-z0-9][a-z0-9_]{0,99}$'
  );

DO $assert_table_adoption$
DECLARE
  expected_table record;
  actual_columns text[];
  actual_constraints text[];
  expected_constraints text[];
  first_missing_constraint text;
  first_unexpected_constraint text;
  first_invalid_constraint_index text;
BEGIN
  FOR expected_table IN
    SELECT *
    FROM (VALUES
      (
        'domain_command_records',
        'throughline_b1_0_migration_contract.b1_0_expected_domain_command_records', ARRAY[
          'id|uuid|t|', 'tenant_id|uuid|t|', 'workspace_id|uuid|t|',
          'reservation_space_id|uuid|t|', 'command_kind|text|t|',
          'command_schema_version|integer|t|', 'idempotency_key|text|t|',
          'canonical_request_hash|text|t|', 'state|text|t|''reserved''::text',
          'result_resource_type|text|f|', 'result_resource_id|uuid|f|',
          'safe_response|jsonb|f|', 'actor_user_id|uuid|t|',
          'actor_membership_id|uuid|t|', 'delegating_user_id|uuid|f|',
          'delegating_membership_id|uuid|f|', 'agent_principal_id|uuid|f|',
          'policy_version_id|text|t|', 'request_id|text|t|', 'traceparent|text|t|',
          'tracestate|text|f|', 'created_at|timestamp with time zone|t|clock_timestamp()',
          'updated_at|timestamp with time zone|t|clock_timestamp()',
          'completed_at|timestamp with time zone|f|'
        ]::text[]
      ),
      (
        'audit_events',
        'throughline_b1_0_migration_contract.b1_0_expected_audit_events', ARRAY[
          'id|uuid|t|', 'tenant_id|uuid|t|', 'workspace_id|uuid|t|', 'space_id|uuid|t|',
          'causation_command_id|uuid|t|', 'action|text|t|', 'resource_type|text|t|',
          'resource_id|uuid|t|', 'actor_user_id|uuid|t|', 'actor_membership_id|uuid|t|',
          'delegating_user_id|uuid|f|', 'delegating_membership_id|uuid|f|',
          'agent_principal_id|uuid|f|', 'policy_version_id|text|t|', 'request_id|text|t|',
          'traceparent|text|t|', 'tracestate|text|f|', 'audit_schema_version|integer|t|',
          'safe_detail|jsonb|t|', 'created_at|timestamp with time zone|t|clock_timestamp()'
        ]::text[]
      ),
      (
        'product_outbox_events',
        'throughline_b1_0_migration_contract.b1_0_expected_product_outbox_events', ARRAY[
          'id|uuid|t|', 'tenant_id|uuid|t|', 'workspace_id|uuid|t|', 'space_id|uuid|t|',
          'relay_service_principal_id|uuid|t|', 'policy_version_id|text|t|',
          'event_type|text|t|', 'event_schema_version|integer|t|',
          'payload_schema_version|integer|t|', 'aggregate_type|text|t|',
          'aggregate_id|uuid|t|', 'aggregate_version|integer|t|',
          'causation_command_id|uuid|t|', 'payload|jsonb|t|', 'request_id|text|t|',
          'traceparent|text|t|', 'tracestate|text|f|',
          'created_at|timestamp with time zone|t|clock_timestamp()',
          'publication_state|text|t|''pending''::text', 'publication_attempt|integer|t|0',
          'next_attempt_at|timestamp with time zone|t|clock_timestamp()',
          'claimed_at|timestamp with time zone|f|', 'claimed_by|text|f|',
          'claim_token|text|f|', 'claim_expires_at|timestamp with time zone|f|',
          'last_outcome_code|text|f|', 'published_at|timestamp with time zone|f|',
          'published_message_id|text|f|', 'terminal_at|timestamp with time zone|f|'
        ]::text[]
      )
    ) AS expected(table_name, expected_table_name, columns)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class AS relation_record
      JOIN pg_namespace AS namespace_record ON namespace_record.oid = relation_record.relnamespace
      WHERE namespace_record.nspname = 'ops'
        AND relation_record.relname = expected_table.table_name
        AND relation_record.relkind = 'r'
        AND relation_record.relpersistence = 'p'
        AND NOT relation_record.relispartition
    ) THEN
      RAISE EXCEPTION 'Existing table ops.% does not have the required table security shape',
        expected_table.table_name;
    END IF;

    SELECT array_agg(
      format(
        '%s|%s|%s|%s', attribute_record.attname,
        format_type(attribute_record.atttypid, attribute_record.atttypmod),
        attribute_record.attnotnull,
        COALESCE(pg_get_expr(default_record.adbin, default_record.adrelid), '')
      ) ORDER BY attribute_record.attnum
    )
    INTO actual_columns
    FROM pg_attribute AS attribute_record
    LEFT JOIN pg_attrdef AS default_record
      ON default_record.adrelid = attribute_record.attrelid
     AND default_record.adnum = attribute_record.attnum
    WHERE attribute_record.attrelid = format('ops.%I', expected_table.table_name)::regclass
      AND attribute_record.attnum > 0
      AND NOT attribute_record.attisdropped;

    IF actual_columns IS DISTINCT FROM expected_table.columns OR EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = format('ops.%I', expected_table.table_name)::regclass
        AND attnum > 0 AND attisdropped
    ) OR EXISTS (
      SELECT 1
      FROM pg_attribute AS attribute_record
      JOIN pg_type AS type_record ON type_record.oid = attribute_record.atttypid
      WHERE attribute_record.attrelid = format('ops.%I', expected_table.table_name)::regclass
        AND attribute_record.attnum > 0 AND NOT attribute_record.attisdropped
        AND attribute_record.attcollation <> type_record.typcollation
    ) THEN
      RAISE EXCEPTION 'Existing table ops.% columns do not match the B1.0 definition',
        expected_table.table_name;
    END IF;

    SELECT array_agg(
      concat_ws('|', constraint_record.conname, constraint_record.contype::text,
        pg_get_constraintdef(constraint_record.oid), constraint_record.convalidated::text,
        constraint_record.condeferrable::text, constraint_record.condeferred::text,
        constraint_record.connoinherit::text)
      ORDER BY constraint_record.conname
    )
    INTO actual_constraints
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = format('ops.%I', expected_table.table_name)::regclass
      AND constraint_record.contype <> 't';

    SELECT array_agg(
      concat_ws('|', constraint_record.conname, constraint_record.contype::text,
        pg_get_constraintdef(constraint_record.oid), constraint_record.convalidated::text,
        constraint_record.condeferrable::text, constraint_record.condeferred::text,
        constraint_record.connoinherit::text)
      ORDER BY constraint_record.conname
    )
    INTO expected_constraints
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = expected_table.expected_table_name::regclass
      AND constraint_record.contype <> 't';

    SELECT candidate.entry
    INTO first_missing_constraint
    FROM unnest(COALESCE(expected_constraints, ARRAY[]::text[])) AS candidate(entry)
    WHERE NOT (candidate.entry = ANY(COALESCE(actual_constraints, ARRAY[]::text[])))
    ORDER BY candidate.entry
    LIMIT 1;

    SELECT candidate.entry
    INTO first_unexpected_constraint
    FROM unnest(COALESCE(actual_constraints, ARRAY[]::text[])) AS candidate(entry)
    WHERE NOT (candidate.entry = ANY(COALESCE(expected_constraints, ARRAY[]::text[])))
    ORDER BY candidate.entry
    LIMIT 1;

    SELECT concat_ws('|', constraint_record.conname, constraint_record.contype::text,
      pg_get_constraintdef(constraint_record.oid), constraint_record.convalidated::text,
      constraint_record.condeferrable::text, constraint_record.condeferred::text,
      constraint_record.connoinherit::text)
    INTO first_invalid_constraint_index
    FROM pg_constraint AS constraint_record
    JOIN pg_index AS index_record ON index_record.indexrelid = constraint_record.conindid
    WHERE constraint_record.conrelid = format('ops.%I', expected_table.table_name)::regclass
      AND constraint_record.conindid <> 0
      AND (NOT index_record.indisvalid OR NOT index_record.indisready OR NOT index_record.indislive)
    ORDER BY constraint_record.conname
    LIMIT 1;

    IF actual_constraints IS DISTINCT FROM expected_constraints
      OR first_invalid_constraint_index IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'Existing table ops.%s constraints do not match the B1.0 definition; actual_md5=%s; expected_md5=%s; first_missing=%s; first_unexpected=%s; first_invalid_index_constraint=%s',
        expected_table.table_name,
        md5(COALESCE(array_to_string(actual_constraints, E'\n'), '<null>')),
        md5(COALESCE(array_to_string(expected_constraints, E'\n'), '<null>')),
        left(COALESCE(first_missing_constraint, '<none>'), 1200),
        left(COALESCE(first_unexpected_constraint, '<none>'), 1200),
        left(COALESCE(first_invalid_constraint_index, '<none>'), 1200)
      );
    END IF;
  END LOOP;
END
$assert_table_adoption$;

DROP SCHEMA throughline_b1_0_migration_contract CASCADE;

DO $assert_contract_cleanup$
BEGIN
  IF to_regnamespace('throughline_b1_0_migration_contract') IS NOT NULL THEN
    RAISE EXCEPTION 'B1.0 migration contract schema cleanup failed';
  END IF;
END
$assert_contract_cleanup$;

CREATE INDEX IF NOT EXISTS domain_command_records_scope_created_idx
  ON ops.domain_command_records (tenant_id, workspace_id, reservation_space_id, created_at);
CREATE INDEX IF NOT EXISTS audit_events_resource_created_idx
  ON ops.audit_events (tenant_id, workspace_id, space_id, resource_type, resource_id, created_at);
CREATE INDEX IF NOT EXISTS audit_events_command_idx
  ON ops.audit_events (tenant_id, workspace_id, causation_command_id);
CREATE INDEX IF NOT EXISTS product_outbox_events_publishable_idx
  ON ops.product_outbox_events (next_attempt_at, created_at, id)
  WHERE publication_state IN ('pending', 'retry_wait', 'claimed');
CREATE INDEX IF NOT EXISTS product_outbox_events_scope_created_idx
  ON ops.product_outbox_events (tenant_id, workspace_id, space_id, created_at, id);

CREATE OR REPLACE FUNCTION ops.enforce_domain_command_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'domain command records cannot be deleted';
  END IF;

  IF OLD.state <> 'reserved' OR NEW.state <> 'completed'
    OR ROW(
      NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.reservation_space_id,
      NEW.command_kind, NEW.command_schema_version, NEW.idempotency_key,
      NEW.canonical_request_hash, NEW.actor_user_id, NEW.actor_membership_id,
      NEW.delegating_user_id, NEW.delegating_membership_id, NEW.agent_principal_id,
      NEW.policy_version_id, NEW.request_id, NEW.traceparent, NEW.tracestate, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.reservation_space_id,
      OLD.command_kind, OLD.command_schema_version, OLD.idempotency_key,
      OLD.canonical_request_hash, OLD.actor_user_id, OLD.actor_membership_id,
      OLD.delegating_user_id, OLD.delegating_membership_id, OLD.agent_principal_id,
      OLD.policy_version_id, OLD.request_id, OLD.traceparent, OLD.tracestate, OLD.created_at
    )
    OR OLD.result_resource_type IS NOT NULL OR OLD.result_resource_id IS NOT NULL
    OR OLD.safe_response IS NOT NULL OR OLD.completed_at IS NOT NULL
    OR NEW.completed_at IS NULL OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'domain command records permit only exact reserved-to-completed transition';
  END IF;

  RETURN NEW;
END
$function$;

DO $adopt_triggers$
DECLARE
  expected_trigger record;
  installed_trigger record;
BEGIN
  FOR expected_trigger IN
    SELECT *
    FROM (VALUES
      (
        'domain_command_records', 'domain_command_records_transition_guard',
        'enforce_domain_command_transition', 27, false, false, false
      ),
      (
        'domain_command_records', 'domain_command_records_no_committed_reserved',
        'reject_committed_reserved_command', 21, true, true, true
      ),
      (
        'audit_events', 'audit_events_append_only_guard',
        'reject_audit_event_mutation', 27, false, false, false
      ),
      (
        'product_outbox_events', 'product_outbox_events_transition_guard',
        'enforce_product_outbox_transition', 27, false, false, false
      ),
      (
        'product_outbox_events', 'product_outbox_events_relay_binding_guard',
        'validate_product_outbox_relay_binding', 7, false, false, false
      )
    ) AS expected(
      table_name, trigger_name, function_name, trigger_type,
      is_constraint, is_deferrable, is_initially_deferred
    )
  LOOP
    SELECT
      procedure_namespace.nspname AS function_schema,
      procedure_record.proname AS function_name,
      trigger_record.tgtype::integer AS trigger_type,
      (trigger_record.tgconstraint <> 0) AS is_constraint,
      trigger_record.tgdeferrable AS is_deferrable,
      trigger_record.tginitdeferred AS is_initially_deferred,
      trigger_record.tgenabled AS enabled,
      trigger_record.tgisinternal AS internal,
      trigger_record.tgparentid AS parent_id,
      trigger_record.tgqual IS NULL AS has_no_when,
      trigger_record.tgoldtable IS NULL AND trigger_record.tgnewtable IS NULL
        AS has_no_transition_tables,
      octet_length(trigger_record.tgargs) AS argument_bytes,
      cardinality(trigger_record.tgattr::smallint[]) AS column_count
    INTO installed_trigger
    FROM pg_trigger AS trigger_record
    JOIN pg_proc AS procedure_record ON procedure_record.oid = trigger_record.tgfoid
    JOIN pg_namespace AS procedure_namespace
      ON procedure_namespace.oid = procedure_record.pronamespace
    WHERE trigger_record.tgrelid = format('ops.%I', expected_trigger.table_name)::regclass
      AND trigger_record.tgname = expected_trigger.trigger_name;

    IF FOUND AND ROW(
      installed_trigger.function_schema,
      installed_trigger.function_name,
      installed_trigger.trigger_type,
      installed_trigger.is_constraint,
      installed_trigger.is_deferrable,
      installed_trigger.is_initially_deferred,
      installed_trigger.enabled,
      installed_trigger.internal,
      installed_trigger.parent_id,
      installed_trigger.has_no_when,
      installed_trigger.has_no_transition_tables,
      installed_trigger.argument_bytes,
      installed_trigger.column_count
    ) IS DISTINCT FROM ROW(
      'ops',
      expected_trigger.function_name,
      expected_trigger.trigger_type,
      expected_trigger.is_constraint,
      expected_trigger.is_deferrable,
      expected_trigger.is_initially_deferred,
      'O'::"char",
      false,
      0::oid,
      true,
      true,
      0,
      0
    ) THEN
      RAISE EXCEPTION 'Existing trigger % on ops.% does not match the B1.0 definition',
        expected_trigger.trigger_name, expected_trigger.table_name;
    END IF;
  END LOOP;
END
$adopt_triggers$;

DROP TRIGGER IF EXISTS domain_command_records_transition_guard ON ops.domain_command_records;
CREATE TRIGGER domain_command_records_transition_guard
BEFORE UPDATE OR DELETE ON ops.domain_command_records
FOR EACH ROW EXECUTE FUNCTION ops.enforce_domain_command_transition();

CREATE OR REPLACE FUNCTION ops.reject_committed_reserved_command()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ops.domain_command_records
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND id = NEW.id AND state = 'reserved'
  ) THEN
    RAISE EXCEPTION 'domain command reservation must complete before commit';
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS domain_command_records_no_committed_reserved ON ops.domain_command_records;
CREATE CONSTRAINT TRIGGER domain_command_records_no_committed_reserved
AFTER INSERT OR UPDATE ON ops.domain_command_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ops.reject_committed_reserved_command();

CREATE OR REPLACE FUNCTION ops.reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END
$function$;

DROP TRIGGER IF EXISTS audit_events_append_only_guard ON ops.audit_events;
CREATE TRIGGER audit_events_append_only_guard
BEFORE UPDATE OR DELETE ON ops.audit_events
FOR EACH ROW EXECUTE FUNCTION ops.reject_audit_event_mutation();

CREATE OR REPLACE FUNCTION ops.enforce_product_outbox_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product outbox events cannot be deleted';
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.space_id,
    NEW.relay_service_principal_id, NEW.policy_version_id, NEW.event_type,
    NEW.event_schema_version, NEW.payload_schema_version, NEW.aggregate_type,
    NEW.aggregate_id, NEW.aggregate_version, NEW.causation_command_id,
    NEW.payload, NEW.request_id, NEW.traceparent, NEW.tracestate, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.space_id,
    OLD.relay_service_principal_id, OLD.policy_version_id, OLD.event_type,
    OLD.event_schema_version, OLD.payload_schema_version, OLD.aggregate_type,
    OLD.aggregate_id, OLD.aggregate_version, OLD.causation_command_id,
    OLD.payload, OLD.request_id, OLD.traceparent, OLD.tracestate, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'product outbox envelope identity is immutable';
  END IF;

  IF NEW.publication_state = 'claimed' THEN
    IF OLD.publication_state NOT IN ('pending', 'retry_wait', 'claimed')
      OR NEW.publication_attempt <> OLD.publication_attempt + 1
      OR (OLD.publication_state = 'claimed' AND OLD.claim_expires_at > clock_timestamp())
      OR NEW.last_outcome_code IS NOT NULL
      OR NEW.published_at IS NOT NULL OR NEW.published_message_id IS NOT NULL
      OR NEW.terminal_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid product outbox claim transition';
    END IF;
  ELSIF NEW.publication_state = 'retry_wait' THEN
    IF OLD.publication_state <> 'claimed'
      OR NEW.publication_attempt <> OLD.publication_attempt
      OR NEW.next_attempt_at <= clock_timestamp()
      OR NEW.last_outcome_code IS NULL
    THEN
      RAISE EXCEPTION 'invalid product outbox retry transition';
    END IF;
  ELSIF NEW.publication_state = 'published' THEN
    IF OLD.publication_state <> 'claimed'
      OR NEW.publication_attempt <> OLD.publication_attempt
      OR OLD.claim_expires_at <= clock_timestamp()
      OR NEW.published_at IS NULL OR NEW.published_message_id IS NULL
      OR NEW.terminal_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid product outbox publication transition';
    END IF;
  ELSIF NEW.publication_state IN ('terminal_failed', 'terminal_unconfirmed') THEN
    IF OLD.publication_state <> 'claimed'
      OR NEW.publication_attempt <> OLD.publication_attempt
      OR NEW.publication_attempt <> 6
      OR NEW.terminal_at IS NULL OR NEW.last_outcome_code IS NULL
      OR NEW.published_at IS NOT NULL OR NEW.published_message_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid product outbox terminal transition';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid product outbox publication transition';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS product_outbox_events_transition_guard ON ops.product_outbox_events;
CREATE TRIGGER product_outbox_events_transition_guard
BEFORE UPDATE OR DELETE ON ops.product_outbox_events
FOR EACH ROW EXECUTE FUNCTION ops.enforce_product_outbox_transition();

CREATE OR REPLACE FUNCTION ops.validate_product_outbox_relay_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM identity.service_principals
    WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id
      AND id = NEW.relay_service_principal_id
      AND purpose = 'product_notification_relay'
  ) THEN
    RAISE EXCEPTION 'product outbox requires the fixed notification-only relay principal';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS product_outbox_events_relay_binding_guard ON ops.product_outbox_events;
CREATE TRIGGER product_outbox_events_relay_binding_guard
BEFORE INSERT ON ops.product_outbox_events
FOR EACH ROW EXECUTE FUNCTION ops.validate_product_outbox_relay_binding();

ALTER TABLE ops.domain_command_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.domain_command_records FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.product_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.product_outbox_events FORCE ROW LEVEL SECURITY;

DO $adopt_policies$
DECLARE
  expected_policy record;
  installed_policy record;
  expected_using text;
  expected_check text;
BEGIN
  FOR expected_policy IN
    SELECT *
    FROM (VALUES
      (
        'ops', 'domain_command_records', 'domain_command_records_app_select',
        'r', true, 'throughline_app',
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND reservation_space_id = ops.current_space_id()$expression$,
        NULL::text
      ),
      (
        'ops', 'domain_command_records', 'domain_command_records_app_insert',
        'a', true, 'throughline_app', NULL::text,
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND reservation_space_id = ops.current_space_id()
          AND actor_user_id = ops.current_user_id()
          AND actor_membership_id = ops.current_membership_id()
          AND policy_version_id = ops.current_policy_version()$expression$
      ),
      (
        'ops', 'domain_command_records', 'domain_command_records_app_complete',
        'w', true, 'throughline_app',
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND reservation_space_id = ops.current_space_id()
          AND actor_user_id = ops.current_user_id()
          AND actor_membership_id = ops.current_membership_id()
          AND policy_version_id = ops.current_policy_version()$expression$,
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND reservation_space_id = ops.current_space_id()
          AND actor_user_id = ops.current_user_id()
          AND actor_membership_id = ops.current_membership_id()
          AND policy_version_id = ops.current_policy_version()$expression$
      ),
      (
        'ops', 'audit_events', 'audit_events_app_select', 'r', true, 'throughline_app',
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()$expression$,
        NULL::text
      ),
      (
        'ops', 'audit_events', 'audit_events_app_insert', 'a', true, 'throughline_app',
        NULL::text,
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()
          AND actor_user_id = ops.current_user_id()
          AND actor_membership_id = ops.current_membership_id()
          AND policy_version_id = ops.current_policy_version()$expression$
      ),
      (
        'ops', 'product_outbox_events', 'product_outbox_events_app_select',
        'r', true, 'throughline_app',
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()$expression$,
        NULL::text
      ),
      (
        'ops', 'product_outbox_events', 'product_outbox_events_app_insert',
        'a', true, 'throughline_app', NULL::text,
        $expression$tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()
          AND policy_version_id = ops.current_policy_version()
          AND EXISTS (
            SELECT 1 FROM identity.service_principals principal
            WHERE principal.tenant_id = product_outbox_events.tenant_id
              AND principal.workspace_id = product_outbox_events.workspace_id
              AND principal.id = product_outbox_events.relay_service_principal_id
              AND principal.purpose = 'product_notification_relay'
              AND principal.status = 'active'
          )$expression$
      ),
      (
        'ops', 'product_outbox_events', 'product_outbox_events_product_relay_select',
        'r', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()
          AND relay_service_principal_id = ops.current_service_principal_id()
          AND policy_version_id = ops.current_policy_version()$expression$,
        NULL::text
      ),
      (
        'ops', 'product_outbox_events', 'product_outbox_events_product_relay_update',
        'w', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()
          AND relay_service_principal_id = ops.current_service_principal_id()
          AND policy_version_id = ops.current_policy_version()$expression$,
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()
          AND relay_service_principal_id = ops.current_service_principal_id()
          AND policy_version_id = ops.current_policy_version()$expression$
      ),
      (
        'identity', 'tenants', 'tenants_product_relay_select',
        'r', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND id = ops.current_tenant_id()$expression$,
        NULL::text
      ),
      (
        'identity', 'tenants', 'tenants_product_relay_lock_only',
        'w', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND id = ops.current_tenant_id() AND status = 'active'$expression$,
        'false'
      ),
      (
        'identity', 'tenants', 'tenants_product_relay_no_write',
        'w', false, 'throughline_product_relay', 'true', 'false'
      ),
      (
        'identity', 'workspaces', 'workspaces_product_relay_select',
        'r', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND id = ops.current_workspace_id()$expression$,
        NULL::text
      ),
      (
        'identity', 'workspaces', 'workspaces_product_relay_lock_only',
        'w', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND id = ops.current_workspace_id() AND status = 'active'$expression$,
        'false'
      ),
      (
        'identity', 'workspaces', 'workspaces_product_relay_no_write',
        'w', false, 'throughline_product_relay', 'true', 'false'
      ),
      (
        'identity', 'policy_versions', 'policy_versions_product_relay_select',
        'r', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND id = ops.current_policy_version()$expression$,
        NULL::text
      ),
      (
        'identity', 'policy_versions', 'policy_versions_product_relay_lock_only',
        'w', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND id = ops.current_policy_version() AND status = 'active'$expression$,
        'false'
      ),
      (
        'identity', 'policy_versions', 'policy_versions_product_relay_no_write',
        'w', false, 'throughline_product_relay', 'true', 'false'
      ),
      (
        'identity', 'service_principals', 'service_principals_product_relay_select',
        'r', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND id = ops.current_service_principal_id()$expression$,
        NULL::text
      ),
      (
        'identity', 'service_principals', 'service_principals_product_relay_lock_only',
        'w', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND id = ops.current_service_principal_id()
          AND purpose = 'product_notification_relay' AND status = 'active'$expression$,
        'false'
      ),
      (
        'identity', 'service_principals', 'service_principals_product_relay_no_write',
        'w', false, 'throughline_product_relay', 'true', 'false'
      ),
      (
        'access', 'spaces', 'spaces_product_relay_select',
        'r', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND id = ops.current_space_id()$expression$,
        NULL::text
      ),
      (
        'access', 'spaces', 'spaces_product_relay_lock_only',
        'w', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND id = ops.current_space_id() AND archived_at IS NULL$expression$,
        'false'
      ),
      (
        'access', 'spaces', 'spaces_product_relay_no_write',
        'w', false, 'throughline_product_relay', 'true', 'false'
      ),
      (
        'access', 'access_relationships', 'access_relationships_product_relay_select',
        'r', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND subject_type = 'service_principal'
          AND subject_id = ops.current_service_principal_id()
          AND relation = 'manager' AND resource_type = 'space'
          AND resource_id = ops.current_space_id() AND source = 'direct'$expression$,
        NULL::text
      ),
      (
        'access', 'access_relationships', 'access_relationships_product_relay_lock_only',
        'w', true, 'throughline_product_relay',
        $expression$current_user = 'throughline_product_relay'
          AND tenant_id = ops.current_tenant_id()
          AND workspace_id = ops.current_workspace_id()
          AND subject_type = 'service_principal'
          AND subject_id = ops.current_service_principal_id()
          AND relation = 'manager' AND resource_type = 'space'
          AND resource_id = ops.current_space_id() AND source = 'direct'$expression$,
        'false'
      ),
      (
        'access', 'access_relationships', 'access_relationships_product_relay_no_write',
        'w', false, 'throughline_product_relay', 'true', 'false'
      )
    ) AS expected(
      schema_name, table_name, policy_name, policy_command, is_permissive,
      role_name, using_expression, check_expression
    )
  LOOP
    SELECT
      policy_record.polcmd::text AS policy_command,
      policy_record.polpermissive AS is_permissive,
      ARRAY(
        SELECT (CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END)::text
        FROM unnest(policy_record.polroles) AS role_oid
        ORDER BY 1
      ) AS role_names,
      lower(regexp_replace(regexp_replace(
        COALESCE(pg_get_expr(policy_record.polqual, policy_record.polrelid), ''),
        '::(text|name)', '', 'g'
      ), '[()[:space:]]', '', 'g')) AS using_expression,
      lower(regexp_replace(regexp_replace(
        COALESCE(pg_get_expr(policy_record.polwithcheck, policy_record.polrelid), ''),
        '::(text|name)', '', 'g'
      ), '[()[:space:]]', '', 'g')) AS check_expression
    INTO installed_policy
    FROM pg_policy AS policy_record
    WHERE policy_record.polrelid =
      format('%I.%I', expected_policy.schema_name, expected_policy.table_name)::regclass
      AND policy_record.polname = expected_policy.policy_name;

    expected_using := lower(regexp_replace(regexp_replace(
      COALESCE(expected_policy.using_expression, ''), '::(text|name)', '', 'g'
    ), '[()[:space:]]', '', 'g'));
    expected_check := lower(regexp_replace(regexp_replace(
      COALESCE(expected_policy.check_expression, ''), '::(text|name)', '', 'g'
    ), '[()[:space:]]', '', 'g'));

    IF FOUND AND ROW(
      installed_policy.policy_command,
      installed_policy.is_permissive,
      installed_policy.role_names,
      installed_policy.using_expression,
      installed_policy.check_expression
    ) IS DISTINCT FROM ROW(
      expected_policy.policy_command,
      expected_policy.is_permissive,
      ARRAY[expected_policy.role_name]::text[],
      expected_using,
      expected_check
    ) THEN
      RAISE EXCEPTION 'Existing policy % on %.% does not match the B1.0 definition',
        expected_policy.policy_name, expected_policy.schema_name, expected_policy.table_name;
    END IF;
  END LOOP;
END
$adopt_policies$;

DROP POLICY IF EXISTS domain_command_records_app_select ON ops.domain_command_records;
CREATE POLICY domain_command_records_app_select ON ops.domain_command_records
  FOR SELECT TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND reservation_space_id = ops.current_space_id()
  );
DROP POLICY IF EXISTS domain_command_records_app_insert ON ops.domain_command_records;
CREATE POLICY domain_command_records_app_insert ON ops.domain_command_records
  FOR INSERT TO throughline_app
  WITH CHECK (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND reservation_space_id = ops.current_space_id()
    AND actor_user_id = ops.current_user_id()
    AND actor_membership_id = ops.current_membership_id()
    AND policy_version_id = ops.current_policy_version()
  );
DROP POLICY IF EXISTS domain_command_records_app_complete ON ops.domain_command_records;
CREATE POLICY domain_command_records_app_complete ON ops.domain_command_records
  FOR UPDATE TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND reservation_space_id = ops.current_space_id()
    AND actor_user_id = ops.current_user_id()
    AND actor_membership_id = ops.current_membership_id()
    AND policy_version_id = ops.current_policy_version()
  )
  WITH CHECK (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND reservation_space_id = ops.current_space_id()
    AND actor_user_id = ops.current_user_id()
    AND actor_membership_id = ops.current_membership_id()
    AND policy_version_id = ops.current_policy_version()
  );

DROP POLICY IF EXISTS audit_events_app_select ON ops.audit_events;
CREATE POLICY audit_events_app_select ON ops.audit_events
  FOR SELECT TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  );
DROP POLICY IF EXISTS audit_events_app_insert ON ops.audit_events;
CREATE POLICY audit_events_app_insert ON ops.audit_events
  FOR INSERT TO throughline_app
  WITH CHECK (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND actor_user_id = ops.current_user_id()
    AND actor_membership_id = ops.current_membership_id()
    AND policy_version_id = ops.current_policy_version()
  );

DROP POLICY IF EXISTS product_outbox_events_app_select ON ops.product_outbox_events;
CREATE POLICY product_outbox_events_app_select ON ops.product_outbox_events
  FOR SELECT TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  );
DROP POLICY IF EXISTS product_outbox_events_app_insert ON ops.product_outbox_events;
CREATE POLICY product_outbox_events_app_insert ON ops.product_outbox_events
  FOR INSERT TO throughline_app
  WITH CHECK (
    tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND policy_version_id = ops.current_policy_version()
    AND EXISTS (
      SELECT 1 FROM identity.service_principals principal
      WHERE principal.tenant_id = product_outbox_events.tenant_id
        AND principal.workspace_id = product_outbox_events.workspace_id
        AND principal.id = product_outbox_events.relay_service_principal_id
        AND principal.purpose = 'product_notification_relay'
        AND principal.status = 'active'
    )
  );

DROP POLICY IF EXISTS product_outbox_events_product_relay_select ON ops.product_outbox_events;
CREATE POLICY product_outbox_events_product_relay_select ON ops.product_outbox_events
  FOR SELECT TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND relay_service_principal_id = ops.current_service_principal_id()
    AND policy_version_id = ops.current_policy_version()
  );
DROP POLICY IF EXISTS product_outbox_events_product_relay_update ON ops.product_outbox_events;
CREATE POLICY product_outbox_events_product_relay_update ON ops.product_outbox_events
  FOR UPDATE TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND relay_service_principal_id = ops.current_service_principal_id()
    AND policy_version_id = ops.current_policy_version()
  )
  WITH CHECK (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND relay_service_principal_id = ops.current_service_principal_id()
    AND policy_version_id = ops.current_policy_version()
  );

DROP POLICY IF EXISTS tenants_product_relay_select ON identity.tenants;
CREATE POLICY tenants_product_relay_select ON identity.tenants
  FOR SELECT TO throughline_product_relay
  USING (current_user = 'throughline_product_relay' AND id = ops.current_tenant_id());
DROP POLICY IF EXISTS tenants_product_relay_lock_only ON identity.tenants;
CREATE POLICY tenants_product_relay_lock_only ON identity.tenants
  AS PERMISSIVE FOR UPDATE TO throughline_product_relay
  USING (current_user = 'throughline_product_relay' AND id = ops.current_tenant_id() AND status = 'active')
  WITH CHECK (false);
DROP POLICY IF EXISTS tenants_product_relay_no_write ON identity.tenants;
CREATE POLICY tenants_product_relay_no_write ON identity.tenants
  AS RESTRICTIVE FOR UPDATE TO throughline_product_relay USING (true) WITH CHECK (false);

DROP POLICY IF EXISTS workspaces_product_relay_select ON identity.workspaces;
CREATE POLICY workspaces_product_relay_select ON identity.workspaces
  FOR SELECT TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id()
  );
DROP POLICY IF EXISTS workspaces_product_relay_lock_only ON identity.workspaces;
CREATE POLICY workspaces_product_relay_lock_only ON identity.workspaces
  AS PERMISSIVE FOR UPDATE TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id() AND status = 'active'
  ) WITH CHECK (false);
DROP POLICY IF EXISTS workspaces_product_relay_no_write ON identity.workspaces;
CREATE POLICY workspaces_product_relay_no_write ON identity.workspaces
  AS RESTRICTIVE FOR UPDATE TO throughline_product_relay USING (true) WITH CHECK (false);

DROP POLICY IF EXISTS policy_versions_product_relay_select ON identity.policy_versions;
CREATE POLICY policy_versions_product_relay_select ON identity.policy_versions
  FOR SELECT TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_policy_version()
  );
DROP POLICY IF EXISTS policy_versions_product_relay_lock_only ON identity.policy_versions;
CREATE POLICY policy_versions_product_relay_lock_only ON identity.policy_versions
  AS PERMISSIVE FOR UPDATE TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_policy_version() AND status = 'active'
  ) WITH CHECK (false);
DROP POLICY IF EXISTS policy_versions_product_relay_no_write ON identity.policy_versions;
CREATE POLICY policy_versions_product_relay_no_write ON identity.policy_versions
  AS RESTRICTIVE FOR UPDATE TO throughline_product_relay USING (true) WITH CHECK (false);

DROP POLICY IF EXISTS service_principals_product_relay_select ON identity.service_principals;
CREATE POLICY service_principals_product_relay_select ON identity.service_principals
  FOR SELECT TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_service_principal_id()
  );
DROP POLICY IF EXISTS service_principals_product_relay_lock_only ON identity.service_principals;
CREATE POLICY service_principals_product_relay_lock_only ON identity.service_principals
  AS PERMISSIVE FOR UPDATE TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_service_principal_id()
    AND purpose = 'product_notification_relay' AND status = 'active'
  ) WITH CHECK (false);
DROP POLICY IF EXISTS service_principals_product_relay_no_write ON identity.service_principals;
CREATE POLICY service_principals_product_relay_no_write ON identity.service_principals
  AS RESTRICTIVE FOR UPDATE TO throughline_product_relay USING (true) WITH CHECK (false);

DROP POLICY IF EXISTS spaces_product_relay_select ON access.spaces;
CREATE POLICY spaces_product_relay_select ON access.spaces
  FOR SELECT TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_space_id()
  );
DROP POLICY IF EXISTS spaces_product_relay_lock_only ON access.spaces;
CREATE POLICY spaces_product_relay_lock_only ON access.spaces
  AS PERMISSIVE FOR UPDATE TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_space_id() AND archived_at IS NULL
  ) WITH CHECK (false);
DROP POLICY IF EXISTS spaces_product_relay_no_write ON access.spaces;
CREATE POLICY spaces_product_relay_no_write ON access.spaces
  AS RESTRICTIVE FOR UPDATE TO throughline_product_relay USING (true) WITH CHECK (false);

DROP POLICY IF EXISTS access_relationships_product_relay_select ON access.access_relationships;
CREATE POLICY access_relationships_product_relay_select ON access.access_relationships
  FOR SELECT TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND subject_type = 'service_principal' AND subject_id = ops.current_service_principal_id()
    AND relation = 'manager' AND resource_type = 'space' AND resource_id = ops.current_space_id()
    AND source = 'direct'
  );
DROP POLICY IF EXISTS access_relationships_product_relay_lock_only ON access.access_relationships;
CREATE POLICY access_relationships_product_relay_lock_only ON access.access_relationships
  AS PERMISSIVE FOR UPDATE TO throughline_product_relay
  USING (
    current_user = 'throughline_product_relay'
    AND tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
    AND subject_type = 'service_principal' AND subject_id = ops.current_service_principal_id()
    AND relation = 'manager' AND resource_type = 'space' AND resource_id = ops.current_space_id()
    AND source = 'direct'
  ) WITH CHECK (false);
DROP POLICY IF EXISTS access_relationships_product_relay_no_write ON access.access_relationships;
CREATE POLICY access_relationships_product_relay_no_write ON access.access_relationships
  AS RESTRICTIVE FOR UPDATE TO throughline_product_relay USING (true) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON SCHEMA identity, access, ops FROM throughline_product_relay;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA identity FROM throughline_product_relay;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA access FROM throughline_product_relay;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ops FROM throughline_product_relay;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ops FROM throughline_product_relay;
REVOKE ALL PRIVILEGES ON ops.domain_command_records FROM throughline_app;
REVOKE ALL PRIVILEGES ON ops.audit_events FROM throughline_app;
REVOKE ALL PRIVILEGES ON ops.product_outbox_events FROM throughline_app;

DO $clear_b1_0_column_grants$
DECLARE
  privilege_record record;
BEGIN
  FOR privilege_record IN
    SELECT grantee, table_schema, table_name, column_name, privilege_type
    FROM information_schema.column_privileges
    WHERE (
      grantee = 'throughline_product_relay'
      AND table_schema IN ('identity', 'access', 'ops')
    ) OR (
      grantee = 'throughline_app'
      AND table_schema = 'ops'
      AND table_name IN ('domain_command_records', 'audit_events', 'product_outbox_events')
    )
  LOOP
    EXECUTE format(
      'REVOKE %s (%I) ON TABLE %I.%I FROM %I',
      privilege_record.privilege_type,
      privilege_record.column_name,
      privilege_record.table_schema,
      privilege_record.table_name,
      privilege_record.grantee
    );
  END LOOP;
END
$clear_b1_0_column_grants$;

REVOKE EXECUTE ON FUNCTION
  ops.is_uuid_v7(uuid), ops.product_safe_json(jsonb),
  ops.product_event_payload_valid(text, integer, uuid, jsonb),
  ops.enforce_domain_command_transition(), ops.reject_committed_reserved_command(),
  ops.reject_audit_event_mutation(), ops.enforce_product_outbox_transition(),
  ops.validate_product_outbox_relay_binding()
FROM PUBLIC;

DO $assertions$
DECLARE
  table_name text;
  constraint_name text;
  index_name text;
  policy_name text;
  trigger_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'throughline_product_relay' AND NOT rolcanlogin AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'throughline_product_relay role attributes are unsafe';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'domain_command_records', 'audit_events', 'product_outbox_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'ops' AND relation.relname = table_name
        AND relation.relrowsecurity AND relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'ops.% is missing forced RLS', table_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid IN (
      'ops.domain_command_records'::regclass,
      'ops.audit_events'::regclass,
      'ops.product_outbox_events'::regclass
    ) AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'B1.0 contains an unvalidated table constraint';
  END IF;

  FOREACH index_name IN ARRAY ARRAY[
    'service_principals_product_notification_relay_unique',
    'domain_command_records_scope_created_idx',
    'audit_events_resource_created_idx', 'audit_events_command_idx',
    'product_outbox_events_publishable_idx', 'product_outbox_events_scope_created_idx'
  ] LOOP
    IF to_regclass(index_name) IS NULL
      AND to_regclass('identity.' || index_name) IS NULL
      AND to_regclass('ops.' || index_name) IS NULL
    THEN
      RAISE EXCEPTION 'required B1.0 index % is missing', index_name;
    END IF;
  END LOOP;

  FOREACH constraint_name IN ARRAY ARRAY[
    'domain_command_records_workspace_fk', 'domain_command_records_space_fk',
    'domain_command_records_actor_fk', 'domain_command_records_policy_fk',
    'audit_events_command_fk', 'audit_events_space_fk', 'audit_events_actor_fk',
    'product_outbox_events_command_fk', 'product_outbox_events_space_fk',
    'product_outbox_events_relay_fk', 'product_outbox_events_policy_fk',
    'product_outbox_events_semantic_unique', 'product_outbox_events_event_aggregate_pair_check'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = constraint_name AND convalidated) THEN
      RAISE EXCEPTION 'required validated constraint % is missing', constraint_name;
    END IF;
  END LOOP;

  FOREACH policy_name IN ARRAY ARRAY[
    'domain_command_records_app_select', 'domain_command_records_app_insert',
    'domain_command_records_app_complete', 'audit_events_app_select', 'audit_events_app_insert',
    'product_outbox_events_app_select', 'product_outbox_events_app_insert',
    'product_outbox_events_product_relay_select', 'product_outbox_events_product_relay_update',
    'tenants_product_relay_select',
    'tenants_product_relay_lock_only', 'tenants_product_relay_no_write',
    'workspaces_product_relay_select',
    'workspaces_product_relay_lock_only', 'workspaces_product_relay_no_write',
    'policy_versions_product_relay_select',
    'policy_versions_product_relay_lock_only', 'policy_versions_product_relay_no_write',
    'service_principals_product_relay_select',
    'service_principals_product_relay_lock_only', 'service_principals_product_relay_no_write',
    'spaces_product_relay_select',
    'spaces_product_relay_lock_only', 'spaces_product_relay_no_write',
    'access_relationships_product_relay_select',
    'access_relationships_product_relay_lock_only', 'access_relationships_product_relay_no_write'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = policy_name) THEN
      RAISE EXCEPTION 'required policy % is missing', policy_name;
    END IF;
  END LOOP;

  FOREACH trigger_name IN ARRAY ARRAY[
    'domain_command_records_transition_guard',
    'domain_command_records_no_committed_reserved',
    'audit_events_append_only_guard',
    'product_outbox_events_transition_guard',
    'product_outbox_events_relay_binding_guard'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = trigger_name AND tgisinternal = false
        AND tgrelid IN (
          'ops.domain_command_records'::regclass,
          'ops.audit_events'::regclass,
          'ops.product_outbox_events'::regclass
        )
    ) THEN
      RAISE EXCEPTION 'required B1.0 integrity trigger % is missing', trigger_name;
    END IF;
  END LOOP;

  IF has_table_privilege('throughline_app', 'ops.domain_command_records', 'INSERT')
    OR has_table_privilege('throughline_product_relay', 'ops.product_outbox_events', 'SELECT')
  THEN
    RAISE EXCEPTION 'B1.0 grants were visible before final security assertions';
  END IF;
END
$assertions$;

GRANT USAGE ON SCHEMA identity, access, ops TO throughline_product_relay;
GRANT EXECUTE ON FUNCTION
  ops.current_tenant_id(), ops.current_workspace_id(), ops.current_space_id(),
  ops.current_service_principal_id(), ops.current_policy_version()
TO throughline_product_relay;
GRANT EXECUTE ON FUNCTION
  ops.is_uuid_v7(uuid), ops.product_safe_json(jsonb),
  ops.product_event_payload_valid(text, integer, uuid, jsonb)
TO throughline_product_relay;
GRANT EXECUTE ON FUNCTION
  ops.is_uuid_v7(uuid), ops.product_safe_json(jsonb),
  ops.product_event_payload_valid(text, integer, uuid, jsonb)
TO throughline_app;

GRANT SELECT (id, status) ON identity.tenants TO throughline_product_relay;
GRANT SELECT (id, tenant_id, status) ON identity.workspaces TO throughline_product_relay;
GRANT SELECT (id, tenant_id, workspace_id, status) ON identity.policy_versions
  TO throughline_product_relay;
GRANT SELECT (id, tenant_id, workspace_id, purpose, status) ON identity.service_principals
  TO throughline_product_relay;
GRANT SELECT (id, tenant_id, workspace_id, archived_at) ON access.spaces
  TO throughline_product_relay;
GRANT SELECT (
  id, tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source
) ON access.access_relationships TO throughline_product_relay;

GRANT UPDATE (id) ON identity.tenants TO throughline_product_relay;
GRANT UPDATE (id) ON identity.workspaces TO throughline_product_relay;
GRANT UPDATE (id) ON identity.policy_versions TO throughline_product_relay;
GRANT UPDATE (id) ON identity.service_principals TO throughline_product_relay;
GRANT UPDATE (id) ON access.spaces TO throughline_product_relay;
GRANT UPDATE (id) ON access.access_relationships TO throughline_product_relay;

GRANT SELECT, INSERT ON ops.domain_command_records TO throughline_app;
GRANT UPDATE (
  state, result_resource_type, result_resource_id, safe_response, completed_at, updated_at
) ON ops.domain_command_records TO throughline_app;
GRANT SELECT, INSERT ON ops.audit_events TO throughline_app;
GRANT SELECT, INSERT ON ops.product_outbox_events TO throughline_app;

GRANT SELECT (
  id, tenant_id, workspace_id, space_id, relay_service_principal_id, policy_version_id,
  event_type, event_schema_version, payload_schema_version, aggregate_type, aggregate_id,
  aggregate_version, causation_command_id, payload, request_id, traceparent, tracestate, created_at,
  publication_state, publication_attempt, next_attempt_at, claimed_at, claimed_by, claim_token,
  claim_expires_at, last_outcome_code, published_at, published_message_id, terminal_at
) ON ops.product_outbox_events TO throughline_product_relay;
GRANT UPDATE (
  publication_state, publication_attempt, next_attempt_at, claimed_at, claimed_by,
  claim_token, claim_expires_at, last_outcome_code, published_at, published_message_id, terminal_at
) ON ops.product_outbox_events TO throughline_product_relay;
