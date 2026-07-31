SET LOCAL search_path TO pg_catalog;

-- Freeze every relation that can change an admitted evidence snapshot before
-- inspecting exact-0008 data or changing its storage/catalog representation.
LOCK TABLE content.source_artifacts, content.source_chunks IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE truth.verified_evidence_spans, truth.claims,
  truth.accepted_facts, truth.fact_claims IN ACCESS EXCLUSIVE MODE;

DO $adoption$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM truth.verified_evidence_spans evidence
    LEFT JOIN content.source_artifacts source
      ON source.tenant_id = evidence.tenant_id
     AND source.workspace_id = evidence.workspace_id
     AND source.space_id = evidence.space_id
     AND source.id = evidence.source_artifact_id
    LEFT JOIN content.source_chunks chunk
      ON chunk.tenant_id = evidence.tenant_id
     AND chunk.workspace_id = evidence.workspace_id
     AND chunk.space_id = evidence.space_id
     AND chunk.id = evidence.source_chunk_id
    WHERE source.id IS NULL
       OR source.deleted_at IS NOT NULL
       OR EXISTS (
         SELECT 1
         FROM content.source_artifacts successor
         WHERE successor.tenant_id = evidence.tenant_id
           AND successor.workspace_id = evidence.workspace_id
           AND successor.supersedes_source_id = evidence.source_artifact_id
       )
       OR chunk.id IS NULL
       OR chunk.source_artifact_id IS DISTINCT FROM evidence.source_artifact_id
       OR source.version IS DISTINCT FROM evidence.source_version
       OR source.normalization_version IS DISTINCT FROM evidence.normalization_version
       OR source.chunking_version IS DISTINCT FROM evidence.chunking_version
       OR chunk.normalization_version IS DISTINCT FROM evidence.normalization_version
       OR chunk.chunking_version IS DISTINCT FROM evidence.chunking_version
       OR source.content_hash IS DISTINCT FROM evidence.source_content_hash
       OR source.normalized_content_hash IS DISTINCT FROM evidence.source_normalized_content_hash
       OR chunk.content_hash IS DISTINCT FROM evidence.chunk_content_hash
       OR source.content_hash IS DISTINCT FROM encode(
         public.digest(pg_catalog.convert_to(source.immutable_text, 'UTF8'), 'sha256'), 'hex'
       )
       OR chunk.content_hash IS DISTINCT FROM encode(
         public.digest(pg_catalog.convert_to(chunk.normalized_text, 'UTF8'), 'sha256'), 'hex'
       )
       OR evidence.source_end_offset > char_length(chunk.normalized_text)
       OR substring(
         chunk.normalized_text
         FROM evidence.source_start_offset + 1
         FOR evidence.source_end_offset - evidence.source_start_offset
       ) IS DISTINCT FROM evidence.source_excerpt
       OR evidence.excerpt_hash IS DISTINCT FROM encode(
         public.digest(pg_catalog.convert_to(evidence.source_excerpt, 'UTF8'), 'sha256'), 'hex'
       )
  ) THEN
    RAISE EXCEPTION 'Existing truth evidence cannot adopt the B2 lifecycle interlock';
  END IF;
END
$adoption$;

-- v1 stored a JSON string and hashed its JSON serialization. The additive bridge
-- preserves the represented string, then adopts the canonical raw UTF-8 text hash.
DO $constraints$
DECLARE
  constraint_record record;
BEGIN
  FOR constraint_record IN
    SELECT relation.relname AS table_name, constraint_row.conname
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'truth'
      AND relation.relname IN ('claims', 'accepted_facts')
      AND pg_get_constraintdef(constraint_row.oid, false) LIKE '%value_json%'
  LOOP
    EXECUTE format(
      'ALTER TABLE truth.%I DROP CONSTRAINT %I',
      constraint_record.table_name,
      constraint_record.conname
    );
  END LOOP;
END
$constraints$;

ALTER TABLE truth.claims DISABLE TRIGGER USER;
ALTER TABLE truth.accepted_facts DISABLE TRIGGER USER;

ALTER TABLE truth.claims RENAME COLUMN value_json TO canonical_value_text;
ALTER TABLE truth.claims
  ALTER COLUMN canonical_value_text TYPE text USING canonical_value_text #>> '{}';
UPDATE truth.claims
SET value_hash = encode(
  public.digest(pg_catalog.convert_to(canonical_value_text, 'UTF8'), 'sha256'), 'hex'
);
ALTER TABLE truth.claims ADD CONSTRAINT claims_canonical_value_text_valid CHECK (
  canonical_value_text = normalized_text
  AND normalized_text = normalize(normalized_text, NFC)
  AND length(btrim(normalized_text)) BETWEEN 1 AND 2000
  AND (
    (status = 'proposed' AND version = 1)
    OR (status = 'accepted' AND version = 2)
  )
);

ALTER TABLE truth.accepted_facts RENAME COLUMN value_json TO canonical_value_text;
ALTER TABLE truth.accepted_facts
  ALTER COLUMN canonical_value_text TYPE text USING canonical_value_text #>> '{}';
UPDATE truth.accepted_facts
SET value_hash = encode(
  public.digest(pg_catalog.convert_to(canonical_value_text, 'UTF8'), 'sha256'), 'hex'
);
ALTER TABLE truth.accepted_facts ADD CONSTRAINT accepted_facts_canonical_value_text_valid CHECK (
  canonical_value_text = normalized_text
  AND normalized_text = normalize(normalized_text, NFC)
  AND length(btrim(normalized_text)) BETWEEN 1 AND 2000
);

ALTER TABLE truth.claims ENABLE TRIGGER USER;
ALTER TABLE truth.accepted_facts ENABLE TRIGGER USER;

CREATE OR REPLACE FUNCTION truth.require_reserved_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  command_id uuid;
  command_id_text text;
  row_data jsonb := to_jsonb(NEW);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  command_id_text := CASE TG_TABLE_NAME
    WHEN 'accepted_facts' THEN row_data ->> 'last_causation_command_id'
    WHEN 'claims' THEN row_data ->> 'causation_command_id'
    WHEN 'verified_evidence_spans' THEN row_data ->> 'causation_command_id'
    ELSE NULL
  END;
  BEGIN
    command_id := command_id_text::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  END;
  IF command_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM ops.domain_command_records command
    WHERE command.tenant_id = NEW.tenant_id
      AND command.workspace_id = NEW.workspace_id
      AND command.id = command_id
      AND command.command_kind = TG_ARGV[0]
      AND command.state = 'reserved'
      AND command.reservation_space_id = NEW.space_id
      AND command.actor_user_id = ops.current_user_id()
      AND command.actor_membership_id = ops.current_membership_id()
      AND command.policy_version_id = ops.current_policy_version()
  ) THEN
    RAISE EXCEPTION 'truth mutation requires its exact reserved command';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.verify_evidence_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  target_tenant_id uuid;
  target_workspace_id uuid;
  target_source_artifact_id uuid;
  source_record record;
  chunk_record record;
  required_access integer;
BEGIN
  target_tenant_id := NEW.tenant_id;
  target_workspace_id := NEW.workspace_id;
  target_source_artifact_id := NEW.source_artifact_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'throughline:b2:source-truth:' ||
      target_tenant_id::text || '/' ||
      target_workspace_id::text || '/' ||
      target_source_artifact_id::text,
      0
    )
  );

  SELECT source.version, source.normalization_version, source.chunking_version,
         source.content_hash, source.normalized_content_hash, source.access_class,
         source.deleted_at, space.access_class AS space_access_class
    INTO source_record
  FROM content.source_artifacts source
  JOIN access.spaces space
    ON space.tenant_id = source.tenant_id
   AND space.workspace_id = source.workspace_id
   AND space.id = source.space_id
  WHERE source.tenant_id = NEW.tenant_id
    AND source.workspace_id = NEW.workspace_id
    AND source.space_id = NEW.space_id
    AND source.id = NEW.source_artifact_id
    AND space.archived_at IS NULL
  FOR SHARE OF source, space;

  SELECT chunk.source_artifact_id, chunk.normalization_version, chunk.chunking_version,
         chunk.normalized_text, chunk.content_hash, chunk.access_class
    INTO chunk_record
  FROM content.source_chunks chunk
  WHERE chunk.tenant_id = NEW.tenant_id
    AND chunk.workspace_id = NEW.workspace_id
    AND chunk.space_id = NEW.space_id
    AND chunk.id = NEW.source_chunk_id;

  IF source_record IS NULL OR chunk_record IS NULL
    OR source_record.deleted_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM content.source_artifacts successor
      WHERE successor.tenant_id = NEW.tenant_id
        AND successor.workspace_id = NEW.workspace_id
        AND successor.supersedes_source_id = NEW.source_artifact_id
    )
    OR chunk_record.source_artifact_id <> NEW.source_artifact_id
    OR source_record.version <> NEW.source_version
    OR source_record.normalization_version <> NEW.normalization_version
    OR source_record.chunking_version <> NEW.chunking_version
    OR chunk_record.normalization_version <> NEW.normalization_version
    OR chunk_record.chunking_version <> NEW.chunking_version
    OR source_record.content_hash <> NEW.source_content_hash
    OR source_record.normalized_content_hash <> NEW.source_normalized_content_hash
    OR chunk_record.content_hash <> NEW.chunk_content_hash
    OR NEW.source_end_offset > char_length(chunk_record.normalized_text)
    OR substring(
      chunk_record.normalized_text
      FROM NEW.source_start_offset + 1
      FOR NEW.source_end_offset - NEW.source_start_offset
    ) <> NEW.source_excerpt
    OR NEW.excerpt_hash <> encode(public.digest(
      pg_catalog.convert_to(NEW.source_excerpt, 'UTF8'), 'sha256'
    ), 'hex')
  THEN
    RAISE EXCEPTION 'source evidence snapshot is unavailable or invalid';
  END IF;

  required_access := GREATEST(
    content.access_class_rank(source_record.space_access_class),
    content.access_class_rank(source_record.access_class),
    content.access_class_rank(chunk_record.access_class)
  );
  IF content.access_class_rank(NEW.access_class) <> required_access THEN
    RAISE EXCEPTION 'source evidence access class is not propagated exactly';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.validate_claim_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  subject_space uuid;
  evidence_record record;
BEGIN
  IF NEW.subject_type = 'activity' THEN
    SELECT space_id INTO subject_space
    FROM work.activities
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND id = NEW.subject_id
    FOR SHARE;
  ELSE
    SELECT space_id INTO subject_space
    FROM work.initiatives
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND id = NEW.subject_id
    FOR SHARE;
  END IF;

  SELECT access_class, created_by_user_id, created_by_membership_id,
         causation_command_id
    INTO evidence_record
  FROM truth.verified_evidence_spans
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND space_id = NEW.space_id AND id = NEW.verified_evidence_span_id;

  IF subject_space IS NULL OR subject_space <> NEW.space_id
    OR evidence_record IS NULL
    OR evidence_record.access_class <> NEW.access_class
    OR evidence_record.created_by_user_id <> NEW.created_by_user_id
    OR evidence_record.created_by_membership_id <> NEW.created_by_membership_id
    OR evidence_record.causation_command_id <> NEW.causation_command_id
    OR NEW.value_hash <> encode(public.digest(
      pg_catalog.convert_to(NEW.canonical_value_text, 'UTF8'), 'sha256'
    ), 'hex')
  THEN
    RAISE EXCEPTION 'claim subject or evidence scope is invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.validate_fact_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  subject_owner uuid;
  subject_space uuid;
BEGIN
  IF NEW.subject_type = 'activity' THEN
    SELECT owner_person_id, space_id INTO subject_owner, subject_space
    FROM work.activities
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND id = NEW.subject_id
    FOR SHARE;
  ELSE
    SELECT owner_person_id, space_id INTO subject_owner, subject_space
    FROM work.initiatives
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND id = NEW.subject_id
    FOR SHARE;
  END IF;
  IF subject_space IS NULL OR subject_space <> NEW.space_id
    OR EXISTS (
      SELECT 1
      FROM truth.accepted_facts prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.workspace_id = NEW.workspace_id
        AND prior.space_id = NEW.space_id
        AND prior.subject_type = NEW.subject_type
        AND prior.subject_id = NEW.subject_id
        AND prior.predicate = NEW.predicate
    )
    OR NOT EXISTS (
      SELECT 1
      FROM identity.memberships membership
      WHERE membership.tenant_id = NEW.tenant_id
        AND membership.workspace_id = NEW.workspace_id
        AND membership.id = NEW.accepted_by_membership_id
        AND membership.user_id = NEW.accepted_by_user_id
        AND membership.person_id = subject_owner
        AND membership.status = 'active'
    )
    OR NEW.value_hash <> encode(public.digest(
      pg_catalog.convert_to(NEW.canonical_value_text, 'UTF8'), 'sha256'
    ), 'hex')
  THEN
    RAISE EXCEPTION 'fact acceptance authority is invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.validate_fact_support()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  selected_fact_id uuid;
  fact_record record;
  support_count integer;
  invalid_count integer;
  strongest_rank integer;
  stored_strongest_rank integer;
  fact_rank integer;
  required_access integer;
BEGIN
  selected_fact_id := (
    CASE TG_TABLE_NAME
      WHEN 'accepted_facts' THEN row_data ->> 'id'
      WHEN 'fact_claims' THEN row_data ->> 'fact_id'
      ELSE NULL
    END
  )::uuid;
  SELECT * INTO fact_record
  FROM truth.accepted_facts
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = selected_fact_id;
  IF fact_record IS NULL THEN
    RAISE EXCEPTION 'accepted fact support is missing';
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE claim.status <> 'accepted'
             OR claim.space_id <> fact_record.space_id
             OR claim.subject_type <> fact_record.subject_type
             OR claim.subject_id <> fact_record.subject_id
             OR claim.predicate <> fact_record.predicate
             OR claim.canonical_value_text <> fact_record.canonical_value_text
             OR claim.normalized_text <> fact_record.normalized_text
             OR claim.valid_from IS DISTINCT FROM fact_record.valid_from
             OR claim.valid_to IS DISTINCT FROM fact_record.valid_to
         ),
         max(CASE claim.confidence
           WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
           WHEN 'weak' THEN 1 ELSE 0 END),
         max(content.access_class_rank(claim.access_class))
    INTO support_count, invalid_count, strongest_rank, required_access
  FROM truth.fact_claims support
  JOIN truth.claims claim
    ON claim.tenant_id = support.tenant_id
   AND claim.workspace_id = support.workspace_id
   AND claim.id = support.claim_id
  WHERE support.tenant_id = NEW.tenant_id
    AND support.workspace_id = NEW.workspace_id
    AND support.fact_id = selected_fact_id;

  fact_rank := CASE fact_record.confidence
    WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
    WHEN 'weak' THEN 1 ELSE 0 END;
  stored_strongest_rank := CASE fact_record.strongest_supporting_confidence
    WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
    WHEN 'weak' THEN 1 ELSE 0 END;
  IF support_count < 1 OR invalid_count <> 0
    OR fact_rank > strongest_rank
    OR fact_record.confidence_rule <> 'strongest-selected-valid-claim.v1'
    OR stored_strongest_rank <> strongest_rank
    OR fact_record.human_lowered <> (fact_rank < strongest_rank)
    OR content.access_class_rank(fact_record.access_class) <> required_access
  THEN
    RAISE EXCEPTION 'accepted fact support is invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.enforce_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  IF OLD.status <> 'proposed' OR OLD.version <> 1
    OR NEW.status <> 'accepted' OR NEW.version <> 2
    OR NEW.updated_at < OLD.updated_at
    OR (to_jsonb(NEW) - ARRAY['status','version','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','version','updated_at'])
  THEN
    RAISE EXCEPTION 'claim transition is not permitted';
  END IF;
  IF NOT EXISTS (
    SELECT 1
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
      AND command.command_kind = 'fact.accept.v1'
      AND command.state = 'reserved'
      AND command.reservation_space_id = NEW.space_id
      AND command.actor_user_id = ops.current_user_id()
      AND command.actor_membership_id = ops.current_membership_id()
      AND command.policy_version_id = ops.current_policy_version()
  ) THEN
    RAISE EXCEPTION 'claim acceptance requires its reserved fact.accept command';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.require_fact_accept_reservation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM truth.accepted_facts fact
    JOIN ops.domain_command_records command
      ON command.tenant_id = fact.tenant_id
     AND command.workspace_id = fact.workspace_id
     AND command.id = fact.last_causation_command_id
    WHERE fact.tenant_id = NEW.tenant_id
      AND fact.workspace_id = NEW.workspace_id
      AND fact.space_id = NEW.space_id
      AND fact.id = NEW.fact_id
      AND command.command_kind = 'fact.accept.v1'
      AND command.state = 'reserved'
      AND command.reservation_space_id = NEW.space_id
      AND command.actor_user_id = ops.current_user_id()
      AND command.actor_membership_id = ops.current_membership_id()
      AND command.policy_version_id = ops.current_policy_version()
  ) THEN
    RAISE EXCEPTION 'fact support requires its exact reserved fact.accept command';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION truth.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  RAISE EXCEPTION 'truth lineage is immutable';
END
$function$;

-- 0008 is immutable. Replace its command atomicity body additively so the
-- expected aggregate version cannot collide with the outbox column name.
CREATE OR REPLACE FUNCTION ops.require_b2_slice1_command_atomicity()
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
  expected_aggregate_version integer;
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
        INTO aggregate_space, expected_aggregate_version, aggregate_command_id,
             evidence_span_id
      FROM truth.claims claim
      WHERE claim.tenant_id = NEW.tenant_id
        AND claim.workspace_id = NEW.workspace_id
        AND claim.id = NEW.result_resource_id
        AND claim.status = 'proposed';
      IF aggregate_space IS NULL
        OR aggregate_command_id <> NEW.id
        OR expected_aggregate_version <> 1
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
        INTO aggregate_space, expected_aggregate_version, aggregate_command_id
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
        OR expected_aggregate_version <> 1
        OR accepted_claim_ids IS DISTINCT FROM NEW.safe_response -> 'acceptedClaimIds'
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
        RAISE EXCEPTION 'fact.accept result does not match its durable Fact and support';
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
    AND event.aggregate_version = expected_aggregate_version
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

ALTER FUNCTION ops.require_b2_slice1_command_atomicity()
  OWNER TO throughline_b1_0_integrity;

REVOKE ALL ON FUNCTION ops.require_b2_slice1_command_atomicity() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.require_b2_slice1_command_atomicity()
  FROM throughline_app, throughline_relay, throughline_worker, throughline_product_relay;

-- Stage 1 cannot reconcile accepted truth after source correction or erasure.
CREATE OR REPLACE FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_tenant_id uuid;
  target_workspace_id uuid;
  target_source_artifact_id uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB22',
      MESSAGE = 'Truth mutation transaction is unavailable';
  END IF;
  IF TG_TABLE_NAME = 'source_artifacts' AND TG_OP = 'INSERT' THEN
    target_tenant_id := NEW.tenant_id;
    target_workspace_id := NEW.workspace_id;
    target_source_artifact_id := NEW.supersedes_source_id;
  ELSIF TG_TABLE_NAME = 'source_artifacts' AND TG_OP = 'UPDATE' THEN
    target_tenant_id := OLD.tenant_id;
    target_workspace_id := OLD.workspace_id;
    target_source_artifact_id := OLD.id;
  ELSIF TG_TABLE_NAME = 'source_chunks' AND TG_OP = 'DELETE' THEN
    target_tenant_id := OLD.tenant_id;
    target_workspace_id := OLD.workspace_id;
    target_source_artifact_id := OLD.source_artifact_id;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'TLB21',
      MESSAGE = 'Source lifecycle transition is unavailable';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'throughline:b2:source-truth:' ||
      target_tenant_id::text || '/' ||
      target_workspace_id::text || '/' ||
      target_source_artifact_id::text,
      0
    )
  );

  IF target_source_artifact_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM truth.verified_evidence_spans evidence
    WHERE evidence.tenant_id = target_tenant_id
      AND evidence.workspace_id = target_workspace_id
      AND evidence.source_artifact_id = target_source_artifact_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB21',
      MESSAGE = 'Source lifecycle transition is unavailable';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER source_artifacts_z_b2_correction_interlock
BEFORE INSERT ON content.source_artifacts
FOR EACH ROW
WHEN (NEW.supersedes_source_id IS NOT NULL)
EXECUTE FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock();

CREATE TRIGGER source_artifacts_z_b2_tombstone_interlock
BEFORE UPDATE ON content.source_artifacts
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock();

CREATE TRIGGER source_chunks_z_b2_delete_interlock
BEFORE DELETE ON content.source_chunks
FOR EACH ROW
EXECUTE FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock();

ALTER FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock()
  OWNER TO throughline_b1_0_integrity;

REVOKE ALL ON FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock()
  FROM throughline_app, throughline_relay, throughline_worker, throughline_product_relay;
