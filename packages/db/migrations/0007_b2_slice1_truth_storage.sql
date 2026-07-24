SET LOCAL search_path TO pg_catalog;

CREATE SCHEMA truth;
REVOKE ALL ON SCHEMA truth FROM PUBLIC;

COMMENT ON SCHEMA truth IS
  'Throughline B2 Slice 1 durable Claim and AcceptedFact write ledger';

CREATE FUNCTION truth.access_class_rank(value text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
  SELECT CASE value
    WHEN 'public' THEN 0
    WHEN 'workspace' THEN 1
    WHEN 'restricted' THEN 2
    WHEN 'confidential' THEN 3
    ELSE NULL
  END
$function$;

-- Database backstop for the centralized human Space-read and data-class policy.
CREATE OR REPLACE FUNCTION access.can_read_space(
  requested_space_id uuid,
  requested_access_class text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  WITH RECURSIVE authority_path AS (
    SELECT space_record.id, space_record.parent_space_id, space_record.kind,
      space_record.access_class, space_record.inheritance_mode, 0 AS depth
    FROM access.spaces space_record
    WHERE space_record.tenant_id = ops.current_tenant_id()
      AND space_record.workspace_id = ops.current_workspace_id()
      AND space_record.id = requested_space_id
      AND space_record.archived_at IS NULL
    UNION ALL
    SELECT parent.id, parent.parent_space_id, parent.kind,
      parent.access_class, parent.inheritance_mode, authority_path.depth + 1
    FROM access.spaces parent
    JOIN authority_path ON authority_path.parent_space_id = parent.id
    WHERE parent.tenant_id = ops.current_tenant_id()
      AND parent.workspace_id = ops.current_workspace_id()
      AND parent.archived_at IS NULL
  ),
  active_actor AS (
    SELECT membership.role
    FROM identity.memberships membership
    JOIN identity.users user_record
      ON user_record.id = membership.user_id
      AND user_record.id = ops.current_user_id()
      AND user_record.status = 'active'
    JOIN identity.policy_versions policy
      ON policy.tenant_id = membership.tenant_id
      AND policy.workspace_id = membership.workspace_id
      AND policy.id = ops.current_policy_version()
      AND policy.status = 'active'
    WHERE membership.tenant_id = ops.current_tenant_id()
      AND membership.workspace_id = ops.current_workspace_id()
      AND membership.id = ops.current_membership_id()
      AND membership.user_id = ops.current_user_id()
      AND membership.status = 'active'
      AND membership.person_id IS NOT NULL
  )
  SELECT EXISTS (
    SELECT 1
    FROM authority_path target
    CROSS JOIN active_actor actor
    WHERE target.depth = 0
      AND CASE NULLIF(current_setting('app.data_class_ceiling', true), '')
        WHEN 'public' THEN 0 WHEN 'workspace' THEN 1
        WHEN 'restricted' THEN 2 WHEN 'confidential' THEN 3 ELSE -1
      END >= truth.access_class_rank(target.access_class)
      AND CASE NULLIF(current_setting('app.data_class_ceiling', true), '')
        WHEN 'public' THEN 0 WHEN 'workspace' THEN 1
        WHEN 'restricted' THEN 2 WHEN 'confidential' THEN 3 ELSE -1
      END >= truth.access_class_rank(COALESCE(requested_access_class, target.access_class))
      AND (
        actor.role IN ('owner', 'admin')
        OR target.kind = 'workspace_root'
        OR EXISTS (
          SELECT 1
          FROM access.access_relationships direct_grant
          WHERE direct_grant.tenant_id = ops.current_tenant_id()
            AND direct_grant.workspace_id = ops.current_workspace_id()
            AND direct_grant.resource_type = 'space'
            AND direct_grant.resource_id = target.id
            AND direct_grant.relation IN ('owner','manager','contributor','viewer')
            AND (
              (direct_grant.subject_type = 'membership'
                AND direct_grant.subject_id = ops.current_membership_id())
              OR (direct_grant.subject_type = 'user'
                AND direct_grant.subject_id = ops.current_user_id())
            )
        )
        OR (
          target.inheritance_mode <> 'restricted'
          AND EXISTS (
            SELECT 1
            FROM authority_path ancestor
            JOIN access.access_relationships inherited_grant
              ON inherited_grant.tenant_id = ops.current_tenant_id()
              AND inherited_grant.workspace_id = ops.current_workspace_id()
              AND inherited_grant.resource_type = 'space'
              AND inherited_grant.resource_id = ancestor.id
              AND inherited_grant.relation IN ('owner','manager','contributor','viewer')
              AND (
                (inherited_grant.subject_type = 'membership'
                  AND inherited_grant.subject_id = ops.current_membership_id())
                OR (inherited_grant.subject_type = 'user'
                  AND inherited_grant.subject_id = ops.current_user_id())
              )
            WHERE ancestor.depth > 0
              AND NOT EXISTS (
                SELECT 1
                FROM authority_path boundary
                WHERE boundary.depth < ancestor.depth
                  AND boundary.inheritance_mode = 'restricted'
              )
          )
        )
      )
  )
$function$;

CREATE TABLE truth.verified_evidence_spans (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_chunk_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  chunk_version integer NOT NULL CHECK (chunk_version = 1),
  normalization_version text NOT NULL CHECK (normalization_version = 'source-normalization.v1'),
  chunking_version text NOT NULL CHECK (chunking_version = 'source-chunking.v1'),
  source_start_offset integer NOT NULL CHECK (source_start_offset >= 0),
  source_end_offset integer NOT NULL CHECK (source_end_offset > source_start_offset),
  source_excerpt text,
  source_content_hash text,
  source_normalized_content_hash text,
  chunk_content_hash text,
  excerpt_hash text,
  access_class text NOT NULL
    CHECK (access_class IN ('public','workspace','restricted','confidential')),
  created_by_user_id uuid NOT NULL REFERENCES identity.users(id),
  created_by_membership_id uuid NOT NULL,
  causation_command_id uuid NOT NULL,
  redacted_at timestamptz,
  redaction_command_id uuid,
  hash_disposition text CHECK (hash_disposition IN ('retained','erased')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1,
  CHECK (
    (
      redacted_at IS NULL AND redaction_command_id IS NULL AND hash_disposition IS NULL
      AND source_excerpt IS NOT NULL AND length(source_excerpt) > 0
      AND source_content_hash ~ '^[a-f0-9]{64}$'
      AND source_normalized_content_hash ~ '^[a-f0-9]{64}$'
      AND chunk_content_hash ~ '^[a-f0-9]{64}$'
      AND excerpt_hash ~ '^[a-f0-9]{64}$'
      AND version = 1
    )
    OR (
      redacted_at IS NOT NULL AND redaction_command_id IS NOT NULL
      AND source_excerpt IS NULL AND version = 2
      AND (
        (
          hash_disposition = 'retained'
          AND source_content_hash ~ '^[a-f0-9]{64}$'
          AND source_normalized_content_hash ~ '^[a-f0-9]{64}$'
          AND chunk_content_hash ~ '^[a-f0-9]{64}$'
          AND excerpt_hash ~ '^[a-f0-9]{64}$'
        )
        OR (
          hash_disposition = 'erased'
          AND source_content_hash IS NULL AND source_normalized_content_hash IS NULL
          AND chunk_content_hash IS NULL AND excerpt_hash IS NULL
        )
      )
    )
  ),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, source_artifact_id)
    REFERENCES content.source_artifacts(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, created_by_membership_id, created_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, redaction_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)
);

CREATE TABLE truth.claims (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('activity','initiative')),
  subject_id uuid NOT NULL,
  predicate_catalog_version text NOT NULL
    CHECK (predicate_catalog_version = 'truth-predicate-catalog.v1'),
  predicate text NOT NULL CHECK (
    (subject_type = 'activity' AND predicate = 'activity.outcome')
    OR (subject_type = 'initiative' AND predicate = 'initiative.primary_objective')
  ),
  value_json jsonb,
  value_hash text,
  normalized_text text,
  verified_evidence_span_id uuid NOT NULL,
  asserted_by_type text NOT NULL CHECK (asserted_by_type = 'person'),
  asserted_by_id uuid NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('confirmed','strong','weak','unknown')),
  valid_from timestamptz,
  valid_to timestamptz,
  observed_at timestamptz,
  status text NOT NULL CHECK (status IN ('proposed','accepted','rejected')),
  access_class text NOT NULL
    CHECK (access_class IN ('public','workspace','restricted','confidential')),
  created_by_user_id uuid NOT NULL REFERENCES identity.users(id),
  created_by_membership_id uuid NOT NULL,
  causation_command_id uuid NOT NULL,
  redacted_at timestamptz,
  redaction_command_id uuid,
  hash_disposition text CHECK (hash_disposition IN ('retained','erased')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1,
  CHECK (
    (
      redacted_at IS NULL AND redaction_command_id IS NULL AND hash_disposition IS NULL
      AND value_json IS NOT NULL AND jsonb_typeof(value_json) = 'string'
      AND value_hash ~ '^[a-f0-9]{64}$'
      AND value_json #>> '{}' = normalized_text
      AND normalized_text = normalize(normalized_text, NFC)
      AND length(btrim(normalized_text)) BETWEEN 1 AND 2000
      AND (
        (status = 'proposed' AND version = 1)
        OR (status = 'accepted' AND version = 2)
      )
    )
    OR (
      redacted_at IS NOT NULL AND redaction_command_id IS NOT NULL
      AND hash_disposition IS NOT NULL
      AND value_json IS NULL AND normalized_text IS NULL
      AND status = 'rejected' AND version IN (2,3)
      AND (
        (hash_disposition = 'retained' AND value_hash ~ '^[a-f0-9]{64}$')
        OR (hash_disposition = 'erased' AND value_hash IS NULL)
      )
    )
  ),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, verified_evidence_span_id)
    REFERENCES truth.verified_evidence_spans(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, asserted_by_id)
    REFERENCES identity.people(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, created_by_membership_id, created_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, redaction_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)
);

CREATE TABLE truth.accepted_facts (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('activity','initiative')),
  subject_id uuid NOT NULL,
  predicate_catalog_version text NOT NULL
    CHECK (predicate_catalog_version = 'truth-predicate-catalog.v1'),
  predicate text NOT NULL CHECK (
    (subject_type = 'activity' AND predicate = 'activity.outcome')
    OR (subject_type = 'initiative' AND predicate = 'initiative.primary_objective')
  ),
  value_json jsonb,
  value_hash text,
  normalized_text text,
  confidence text NOT NULL CHECK (confidence IN ('confirmed','strong','weak','unknown')),
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('current','revoked')),
  access_class text NOT NULL
    CHECK (access_class IN ('public','workspace','restricted','confidential')),
  accepted_by_user_id uuid NOT NULL REFERENCES identity.users(id),
  accepted_by_membership_id uuid NOT NULL,
  acceptance_scope text NOT NULL CHECK (
    (subject_type = 'activity' AND acceptance_scope = 'engagement')
    OR (subject_type = 'initiative' AND acceptance_scope = 'initiative')
  ),
  authority_basis text NOT NULL CHECK (
    (subject_type = 'activity' AND authority_basis = 'activity_owner')
    OR (subject_type = 'initiative' AND authority_basis = 'initiative_owner')
  ),
  acceptance_policy_version text NOT NULL,
  last_causation_command_id uuid NOT NULL,
  redacted_at timestamptz,
  redaction_source_artifact_id uuid,
  hash_disposition text CHECK (hash_disposition IN ('retained','erased')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1,
  CHECK (
    (
      status = 'current' AND version = 1
      AND redacted_at IS NULL AND redaction_source_artifact_id IS NULL
      AND hash_disposition IS NULL
      AND value_json IS NOT NULL AND jsonb_typeof(value_json) = 'string'
      AND value_hash ~ '^[a-f0-9]{64}$'
      AND value_json #>> '{}' = normalized_text
      AND normalized_text = normalize(normalized_text, NFC)
      AND length(btrim(normalized_text)) BETWEEN 1 AND 2000
    )
    OR (
      status = 'revoked' AND version = 2
      AND redacted_at IS NOT NULL AND redaction_source_artifact_id IS NOT NULL
      AND hash_disposition IS NOT NULL
      AND value_json IS NULL AND normalized_text IS NULL
      AND (
        (hash_disposition = 'retained' AND value_hash ~ '^[a-f0-9]{64}$')
        OR (hash_disposition = 'erased' AND value_hash IS NULL)
      )
    )
  ),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, accepted_by_membership_id, accepted_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, acceptance_policy_version)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, last_causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, redaction_source_artifact_id)
    REFERENCES content.source_artifacts(tenant_id, workspace_id, space_id, id)
);

CREATE UNIQUE INDEX accepted_facts_one_current_slot
  ON truth.accepted_facts (
    tenant_id, workspace_id, space_id, subject_type, subject_id, predicate
  ) WHERE status = 'current';

CREATE TABLE truth.fact_claims (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, fact_id, claim_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, fact_id)
    REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, claim_id)
    REFERENCES truth.claims(tenant_id, workspace_id, space_id, id)
);

CREATE TABLE truth.fact_lifecycle_events (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type = 'fact.accepted'),
  to_status text NOT NULL CHECK (to_status = 'current'),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  actor_membership_id uuid NOT NULL,
  authority_basis text NOT NULL CHECK (authority_basis IN ('activity_owner','initiative_owner')),
  policy_version text NOT NULL,
  confidence_rule text NOT NULL CHECK (
    confidence_rule = 'strongest-selected-valid-claim.v1'
  ),
  confidence text NOT NULL CHECK (confidence IN ('confirmed','strong','weak','unknown')),
  strongest_supporting_confidence text NOT NULL
    CHECK (strongest_supporting_confidence IN ('confirmed','strong','weak','unknown')),
  human_lowered boolean NOT NULL,
  confidence_lowering_reason_code text,
  confidence_lowering_rationale text,
  causation_command_id uuid NOT NULL,
  redacted_at timestamptz,
  redaction_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (
      human_lowered
      AND confidence_lowering_reason_code IS NOT NULL
      AND confidence_lowering_reason_code IN (
        'conservative_human_judgment','evidence_quality','residual_uncertainty'
      )
      AND (
        (
          redacted_at IS NULL AND redaction_command_id IS NULL
          AND confidence_lowering_rationale IS NOT NULL
          AND confidence_lowering_rationale = normalize(confidence_lowering_rationale, NFC)
          AND confidence_lowering_rationale = btrim(confidence_lowering_rationale)
          AND length(confidence_lowering_rationale) BETWEEN 1 AND 2000
        )
        OR (
          redacted_at IS NOT NULL AND redaction_command_id IS NOT NULL
          AND confidence_lowering_rationale IS NULL
        )
      )
    )
    OR (
      NOT human_lowered
      AND confidence_lowering_reason_code IS NULL
      AND confidence_lowering_rationale IS NULL
      AND redacted_at IS NULL
      AND redaction_command_id IS NULL
    )
  ),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, fact_id, event_type),
  FOREIGN KEY (tenant_id, workspace_id, space_id, fact_id)
    REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, actor_membership_id, actor_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, policy_version)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, redaction_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)
);

CREATE INDEX evidence_spans_source_idx
  ON truth.verified_evidence_spans (
    tenant_id, workspace_id, source_artifact_id, created_at
  );
CREATE INDEX claims_subject_predicate_idx
  ON truth.claims (
    tenant_id, workspace_id, space_id, subject_type, subject_id, predicate, created_at
  );
CREATE INDEX fact_lifecycle_fact_idx
  ON truth.fact_lifecycle_events (tenant_id, workspace_id, fact_id, created_at);

CREATE FUNCTION truth.require_reserved_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  command_id uuid;
BEGIN
  command_id := CASE TG_TABLE_NAME
    WHEN 'accepted_facts' THEN NEW.last_causation_command_id
    ELSE NEW.causation_command_id
  END;
  IF NOT EXISTS (
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

CREATE FUNCTION truth.verify_evidence_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  source_record record;
  chunk_record record;
  required_access integer;
BEGIN
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
    AND chunk.id = NEW.source_chunk_id
  FOR SHARE;

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
    truth.access_class_rank(source_record.space_access_class),
    truth.access_class_rank(source_record.access_class),
    truth.access_class_rank(chunk_record.access_class)
  );
  IF truth.access_class_rank(NEW.access_class) <> required_access THEN
    RAISE EXCEPTION 'source evidence access class is not propagated exactly';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.validate_claim_insert()
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
    AND space_id = NEW.space_id AND id = NEW.verified_evidence_span_id
  FOR SHARE;

  IF subject_space IS NULL OR subject_space <> NEW.space_id
    OR evidence_record IS NULL
    OR evidence_record.access_class <> NEW.access_class
    OR evidence_record.created_by_user_id <> NEW.created_by_user_id
    OR evidence_record.created_by_membership_id <> NEW.created_by_membership_id
    OR evidence_record.causation_command_id <> NEW.causation_command_id
    OR NEW.value_hash <> encode(public.digest(
      pg_catalog.convert_to(NEW.value_json::text, 'UTF8'), 'sha256'
    ), 'hex')
  THEN
    RAISE EXCEPTION 'claim subject or evidence scope is invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.validate_fact_insert()
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
      pg_catalog.convert_to(NEW.value_json::text, 'UTF8'), 'sha256'
    ), 'hex')
  THEN
    RAISE EXCEPTION 'fact acceptance authority is invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.validate_fact_support()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_fact_id uuid;
  fact_record record;
  support_count integer;
  invalid_count integer;
  strongest_rank integer;
  fact_rank integer;
  required_access integer;
BEGIN
  selected_fact_id := CASE TG_TABLE_NAME
    WHEN 'accepted_facts' THEN NEW.id
    ELSE NEW.fact_id
  END;
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
             OR claim.value_json <> fact_record.value_json
             OR claim.normalized_text <> fact_record.normalized_text
             OR claim.valid_from IS DISTINCT FROM fact_record.valid_from
             OR claim.valid_to IS DISTINCT FROM fact_record.valid_to
         ),
         max(CASE claim.confidence
           WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
           WHEN 'weak' THEN 1 ELSE 0 END),
         max(truth.access_class_rank(claim.access_class))
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
  IF support_count < 1 OR invalid_count <> 0
    OR fact_rank > strongest_rank
    OR truth.access_class_rank(fact_record.access_class) <> required_access
  THEN
    RAISE EXCEPTION 'accepted fact support is invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.enforce_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.redacted_at IS NOT NULL THEN
    IF OLD.redacted_at IS NOT NULL
      OR NEW.redaction_command_id::text
         IS DISTINCT FROM NULLIF(current_setting('throughline.b2_retention_command', true), '')
      OR NEW.status <> 'rejected' OR NEW.version <> OLD.version + 1
      OR NEW.value_json IS NOT NULL OR NEW.normalized_text IS NOT NULL
      OR NEW.updated_at < OLD.updated_at
      OR (
        NEW.hash_disposition = 'retained'
        AND NEW.value_hash IS DISTINCT FROM OLD.value_hash
      )
      OR (
        NEW.hash_disposition = 'erased'
        AND NEW.value_hash IS NOT NULL
      )
      OR NEW.hash_disposition NOT IN ('retained','erased')
      OR (to_jsonb(NEW) - ARRAY[
           'value_json','value_hash','normalized_text','status','redacted_at',
           'redaction_command_id','hash_disposition','updated_at','version'
         ])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY[
           'value_json','value_hash','normalized_text','status','redacted_at',
           'redaction_command_id','hash_disposition','updated_at','version'
         ])
    THEN
      RAISE EXCEPTION 'claim retention redaction is not permitted';
    END IF;
    RETURN NEW;
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

CREATE FUNCTION truth.enforce_evidence_retention_redaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.redacted_at IS NOT NULL
    OR NEW.redacted_at IS NULL
    OR NEW.redaction_command_id::text
       IS DISTINCT FROM NULLIF(current_setting('throughline.b2_retention_command', true), '')
    OR NEW.source_excerpt IS NOT NULL OR NEW.version <> 2
    OR NEW.updated_at < OLD.updated_at
    OR (
      NEW.hash_disposition = 'retained'
      AND ROW(
        NEW.source_content_hash, NEW.source_normalized_content_hash,
        NEW.chunk_content_hash, NEW.excerpt_hash
      ) IS DISTINCT FROM ROW(
        OLD.source_content_hash, OLD.source_normalized_content_hash,
        OLD.chunk_content_hash, OLD.excerpt_hash
      )
    )
    OR (
      NEW.hash_disposition = 'erased'
      AND ROW(
        NEW.source_content_hash, NEW.source_normalized_content_hash,
        NEW.chunk_content_hash, NEW.excerpt_hash
      ) IS DISTINCT FROM ROW(NULL, NULL, NULL, NULL)
    )
    OR NEW.hash_disposition NOT IN ('retained','erased')
    OR (to_jsonb(NEW) - ARRAY[
         'source_excerpt','source_content_hash','source_normalized_content_hash',
         'chunk_content_hash','excerpt_hash','redacted_at','redaction_command_id',
         'hash_disposition','updated_at','version'
       ])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[
         'source_excerpt','source_content_hash','source_normalized_content_hash',
         'chunk_content_hash','excerpt_hash','redacted_at','redaction_command_id',
         'hash_disposition','updated_at','version'
       ])
  THEN
    RAISE EXCEPTION 'evidence retention redaction is not permitted';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.enforce_fact_retention_redaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'current' OR OLD.version <> 1
    OR NEW.status <> 'revoked' OR NEW.version <> 2
    OR NEW.redacted_at IS NULL OR NEW.redaction_source_artifact_id IS NULL
    OR NEW.last_causation_command_id::text
       IS DISTINCT FROM NULLIF(current_setting('throughline.b2_retention_command', true), '')
    OR NEW.value_json IS NOT NULL OR NEW.normalized_text IS NOT NULL
    OR NEW.updated_at < OLD.updated_at
    OR (
      NEW.hash_disposition = 'retained'
      AND NEW.value_hash IS DISTINCT FROM OLD.value_hash
    )
    OR (
      NEW.hash_disposition = 'erased'
      AND NEW.value_hash IS NOT NULL
    )
    OR NEW.hash_disposition NOT IN ('retained','erased')
    OR (to_jsonb(NEW) - ARRAY[
         'value_json','value_hash','normalized_text','status','last_causation_command_id',
         'redacted_at','redaction_source_artifact_id','hash_disposition',
         'updated_at','version'
       ])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[
         'value_json','value_hash','normalized_text','status','last_causation_command_id',
         'redacted_at','redaction_source_artifact_id','hash_disposition',
         'updated_at','version'
       ])
  THEN
    RAISE EXCEPTION 'fact retention redaction is not permitted';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.enforce_lifecycle_retention_redaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR NOT OLD.human_lowered OR OLD.redacted_at IS NOT NULL
    OR NEW.confidence_lowering_rationale IS NOT NULL
    OR NEW.redacted_at IS NULL
    OR NEW.redaction_command_id::text
       IS DISTINCT FROM NULLIF(current_setting('throughline.b2_retention_command', true), '')
    OR (to_jsonb(NEW) - ARRAY[
         'confidence_lowering_rationale','redacted_at','redaction_command_id'
       ])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[
         'confidence_lowering_rationale','redacted_at','redaction_command_id'
       ])
  THEN
    RAISE EXCEPTION 'fact lifecycle retention redaction is not permitted';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.reconcile_source_retention()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  command_ids uuid[];
  command_id uuid;
BEGIN
  IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL
    OR NEW.hash_disposition IS NULL
    OR NEW.hash_disposition NOT IN ('retained','erased')
  THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(command.id ORDER BY command.id)
    INTO command_ids
  FROM ops.domain_command_records command
  WHERE command.tenant_id = NEW.tenant_id
    AND command.workspace_id = NEW.workspace_id
    AND command.command_kind = 'source.tombstone.v1'
    AND command.state = 'reserved'
    AND command.reservation_space_id = NEW.space_id
    AND command.actor_user_id = ops.current_user_id()
    AND command.actor_membership_id = ops.current_membership_id()
    AND command.policy_version_id = ops.current_policy_version();
  IF cardinality(command_ids) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'source retention reconciliation requires one reserved tombstone command';
  END IF;
  command_id := command_ids[1];
  PERFORM set_config('throughline.b2_retention_command', command_id::text, true);

  UPDATE truth.verified_evidence_spans evidence
     SET source_excerpt = NULL,
         source_content_hash = CASE
           WHEN NEW.hash_disposition = 'retained' THEN evidence.source_content_hash
           ELSE NULL
         END,
         source_normalized_content_hash = CASE
           WHEN NEW.hash_disposition = 'retained' THEN evidence.source_normalized_content_hash
           ELSE NULL
         END,
         chunk_content_hash = CASE
           WHEN NEW.hash_disposition = 'retained' THEN evidence.chunk_content_hash
           ELSE NULL
         END,
         excerpt_hash = CASE
           WHEN NEW.hash_disposition = 'retained' THEN evidence.excerpt_hash
           ELSE NULL
         END,
         redacted_at = NEW.deleted_at,
         redaction_command_id = command_id,
         hash_disposition = NEW.hash_disposition,
         updated_at = NEW.updated_at,
         version = 2
   WHERE evidence.tenant_id = NEW.tenant_id
     AND evidence.workspace_id = NEW.workspace_id
     AND evidence.space_id = NEW.space_id
     AND evidence.source_artifact_id = NEW.id
     AND evidence.redacted_at IS NULL;

  UPDATE truth.claims claim
     SET value_json = NULL,
         value_hash = CASE
           WHEN NEW.hash_disposition = 'retained' THEN claim.value_hash
           ELSE NULL
         END,
         normalized_text = NULL,
         status = 'rejected',
         redacted_at = NEW.deleted_at,
         redaction_command_id = command_id,
         hash_disposition = NEW.hash_disposition,
         updated_at = NEW.updated_at,
         version = claim.version + 1
    FROM truth.verified_evidence_spans evidence
   WHERE claim.tenant_id = evidence.tenant_id
     AND claim.workspace_id = evidence.workspace_id
     AND claim.space_id = evidence.space_id
     AND claim.verified_evidence_span_id = evidence.id
     AND evidence.tenant_id = NEW.tenant_id
     AND evidence.workspace_id = NEW.workspace_id
     AND evidence.space_id = NEW.space_id
     AND evidence.source_artifact_id = NEW.id
     AND claim.redacted_at IS NULL;

  UPDATE truth.accepted_facts fact
     SET value_json = NULL,
         value_hash = CASE
           WHEN NEW.hash_disposition = 'retained' THEN fact.value_hash
           ELSE NULL
         END,
         normalized_text = NULL,
         status = 'revoked',
         last_causation_command_id = command_id,
         redacted_at = NEW.deleted_at,
         redaction_source_artifact_id = NEW.id,
         hash_disposition = NEW.hash_disposition,
         updated_at = NEW.updated_at,
         version = 2
   WHERE fact.tenant_id = NEW.tenant_id
     AND fact.workspace_id = NEW.workspace_id
     AND fact.space_id = NEW.space_id
     AND fact.status = 'current'
     AND EXISTS (
       SELECT 1
       FROM truth.fact_claims affected_support
       JOIN truth.claims affected_claim
         ON affected_claim.tenant_id = affected_support.tenant_id
        AND affected_claim.workspace_id = affected_support.workspace_id
        AND affected_claim.id = affected_support.claim_id
       JOIN truth.verified_evidence_spans affected_evidence
         ON affected_evidence.tenant_id = affected_claim.tenant_id
        AND affected_evidence.workspace_id = affected_claim.workspace_id
        AND affected_evidence.id = affected_claim.verified_evidence_span_id
       WHERE affected_support.tenant_id = fact.tenant_id
         AND affected_support.workspace_id = fact.workspace_id
         AND affected_support.fact_id = fact.id
         AND affected_evidence.source_artifact_id = NEW.id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM truth.fact_claims surviving_support
       JOIN truth.claims surviving_claim
         ON surviving_claim.tenant_id = surviving_support.tenant_id
        AND surviving_claim.workspace_id = surviving_support.workspace_id
        AND surviving_claim.id = surviving_support.claim_id
       JOIN truth.verified_evidence_spans surviving_evidence
         ON surviving_evidence.tenant_id = surviving_claim.tenant_id
        AND surviving_evidence.workspace_id = surviving_claim.workspace_id
        AND surviving_evidence.id = surviving_claim.verified_evidence_span_id
       JOIN content.source_artifacts surviving_source
         ON surviving_source.tenant_id = surviving_evidence.tenant_id
        AND surviving_source.workspace_id = surviving_evidence.workspace_id
        AND surviving_source.id = surviving_evidence.source_artifact_id
       WHERE surviving_support.tenant_id = fact.tenant_id
         AND surviving_support.workspace_id = fact.workspace_id
         AND surviving_support.fact_id = fact.id
         AND surviving_claim.status = 'accepted'
         AND surviving_claim.redacted_at IS NULL
         AND surviving_source.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM content.source_artifacts successor
           WHERE successor.tenant_id = surviving_source.tenant_id
             AND successor.workspace_id = surviving_source.workspace_id
             AND successor.supersedes_source_id = surviving_source.id
         )
         AND CASE surviving_claim.confidence
           WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
           WHEN 'weak' THEN 1 ELSE 0
         END >= CASE fact.confidence
           WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
           WHEN 'weak' THEN 1 ELSE 0
         END
     );

  UPDATE truth.fact_lifecycle_events lifecycle
     SET confidence_lowering_rationale = NULL,
         redacted_at = NEW.deleted_at,
         redaction_command_id = command_id
    FROM truth.accepted_facts fact
   WHERE lifecycle.tenant_id = fact.tenant_id
     AND lifecycle.workspace_id = fact.workspace_id
     AND lifecycle.fact_id = fact.id
     AND fact.tenant_id = NEW.tenant_id
     AND fact.workspace_id = NEW.workspace_id
     AND fact.space_id = NEW.space_id
     AND lifecycle.human_lowered
     AND lifecycle.redacted_at IS NULL
     AND EXISTS (
       SELECT 1
       FROM truth.fact_claims affected_support
       JOIN truth.claims affected_claim
         ON affected_claim.tenant_id = affected_support.tenant_id
        AND affected_claim.workspace_id = affected_support.workspace_id
        AND affected_claim.id = affected_support.claim_id
       JOIN truth.verified_evidence_spans affected_evidence
         ON affected_evidence.tenant_id = affected_claim.tenant_id
        AND affected_evidence.workspace_id = affected_claim.workspace_id
        AND affected_evidence.id = affected_claim.verified_evidence_span_id
       WHERE affected_support.tenant_id = fact.tenant_id
         AND affected_support.workspace_id = fact.workspace_id
         AND affected_support.fact_id = fact.id
         AND affected_evidence.source_artifact_id = NEW.id
     );
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.require_fact_accept_reservation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
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

CREATE FUNCTION truth.validate_fact_lifecycle_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  fact_record record;
  strongest_confidence text;
  strongest_rank integer;
  fact_rank integer;
BEGIN
  SELECT fact.accepted_by_user_id, fact.accepted_by_membership_id,
         fact.authority_basis, fact.acceptance_policy_version, fact.confidence
    INTO fact_record
  FROM truth.accepted_facts fact
  WHERE fact.tenant_id = NEW.tenant_id
    AND fact.workspace_id = NEW.workspace_id
    AND fact.space_id = NEW.space_id
    AND fact.id = NEW.fact_id
  FOR SHARE;
  SELECT claim.confidence,
         CASE claim.confidence
           WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
           WHEN 'weak' THEN 1 ELSE 0 END
    INTO strongest_confidence, strongest_rank
  FROM truth.fact_claims support
  JOIN truth.claims claim
    ON claim.tenant_id = support.tenant_id
   AND claim.workspace_id = support.workspace_id
   AND claim.id = support.claim_id
  WHERE support.tenant_id = NEW.tenant_id
    AND support.workspace_id = NEW.workspace_id
    AND support.fact_id = NEW.fact_id
  ORDER BY CASE claim.confidence
    WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
    WHEN 'weak' THEN 1 ELSE 0 END DESC
  LIMIT 1;
  fact_rank := CASE fact_record.confidence
    WHEN 'confirmed' THEN 3 WHEN 'strong' THEN 2
    WHEN 'weak' THEN 1 ELSE 0 END;
  IF fact_record IS NULL OR strongest_confidence IS NULL
    OR NEW.actor_user_id <> fact_record.accepted_by_user_id
    OR NEW.actor_membership_id <> fact_record.accepted_by_membership_id
    OR NEW.authority_basis <> fact_record.authority_basis
    OR NEW.policy_version <> fact_record.acceptance_policy_version
    OR NEW.confidence <> fact_record.confidence
    OR NEW.strongest_supporting_confidence <> strongest_confidence
    OR NEW.human_lowered <> (fact_rank < strongest_rank)
  THEN
    RAISE EXCEPTION 'fact acceptance lifecycle does not match its Fact and support';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'truth lineage is immutable';
END
$function$;

CREATE TRIGGER verified_evidence_command_guard
BEFORE INSERT ON truth.verified_evidence_spans
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('claim.create.v1');
CREATE TRIGGER verified_evidence_snapshot_guard
BEFORE INSERT ON truth.verified_evidence_spans
FOR EACH ROW EXECUTE FUNCTION truth.verify_evidence_snapshot();
CREATE TRIGGER claims_command_guard
BEFORE INSERT ON truth.claims
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('claim.create.v1');
CREATE TRIGGER claims_insert_guard
BEFORE INSERT ON truth.claims
FOR EACH ROW EXECUTE FUNCTION truth.validate_claim_insert();
CREATE TRIGGER accepted_facts_command_guard
BEFORE INSERT ON truth.accepted_facts
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('fact.accept.v1');
CREATE TRIGGER accepted_facts_insert_guard
BEFORE INSERT ON truth.accepted_facts
FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_insert();
CREATE TRIGGER fact_claims_command_guard
BEFORE INSERT ON truth.fact_claims
FOR EACH ROW EXECUTE FUNCTION truth.require_fact_accept_reservation();
CREATE TRIGGER fact_lifecycle_command_guard
BEFORE INSERT ON truth.fact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('fact.accept.v1');
CREATE TRIGGER fact_lifecycle_insert_guard
BEFORE INSERT ON truth.fact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_lifecycle_insert();

CREATE CONSTRAINT TRIGGER accepted_facts_support_deferred
AFTER INSERT ON truth.accepted_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_support();
CREATE CONSTRAINT TRIGGER fact_claims_support_deferred
AFTER INSERT ON truth.fact_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION truth.validate_fact_support();

CREATE TRIGGER verified_evidence_retention_guard
BEFORE UPDATE OR DELETE ON truth.verified_evidence_spans
FOR EACH ROW EXECUTE FUNCTION truth.enforce_evidence_retention_redaction();
CREATE TRIGGER claims_transition_guard
BEFORE UPDATE ON truth.claims
FOR EACH ROW EXECUTE FUNCTION truth.enforce_claim_transition();
CREATE TRIGGER claims_delete_guard
BEFORE DELETE ON truth.claims
FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation();
CREATE TRIGGER accepted_facts_retention_guard
BEFORE UPDATE OR DELETE ON truth.accepted_facts
FOR EACH ROW EXECUTE FUNCTION truth.enforce_fact_retention_redaction();
CREATE TRIGGER fact_claims_immutable
BEFORE UPDATE OR DELETE ON truth.fact_claims
FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation();
CREATE TRIGGER fact_lifecycle_events_immutable
BEFORE UPDATE OR DELETE ON truth.fact_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION truth.enforce_lifecycle_retention_redaction();

CREATE TRIGGER source_artifacts_truth_retention
AFTER UPDATE ON content.source_artifacts
FOR EACH ROW EXECUTE FUNCTION truth.reconcile_source_retention();

ALTER TABLE truth.verified_evidence_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.verified_evidence_spans FORCE ROW LEVEL SECURITY;
ALTER TABLE truth.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.claims FORCE ROW LEVEL SECURITY;
ALTER TABLE truth.accepted_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.accepted_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE truth.fact_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.fact_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE truth.fact_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.fact_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE POLICY verified_evidence_select ON truth.verified_evidence_spans
FOR SELECT TO throughline_app
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND access.can_read_space(space_id, access_class)
);
CREATE POLICY verified_evidence_insert ON truth.verified_evidence_spans
FOR INSERT TO throughline_app
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND access.can_read_space(space_id, access_class)
  AND created_by_user_id = ops.current_user_id()
  AND created_by_membership_id = ops.current_membership_id()
);

CREATE POLICY claims_select ON truth.claims
FOR SELECT TO throughline_app
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND access.can_read_space(space_id, access_class)
);
CREATE POLICY claims_insert ON truth.claims
FOR INSERT TO throughline_app
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND access.can_read_space(space_id, access_class)
  AND created_by_user_id = ops.current_user_id()
  AND created_by_membership_id = ops.current_membership_id()
);
CREATE POLICY claims_update ON truth.claims
FOR UPDATE TO throughline_app
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND access.can_read_space(space_id, access_class)
)
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND access.can_read_space(space_id, access_class)
);

CREATE POLICY accepted_facts_select ON truth.accepted_facts
FOR SELECT TO throughline_app
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND access.can_read_space(space_id, access_class)
);
CREATE POLICY accepted_facts_insert ON truth.accepted_facts
FOR INSERT TO throughline_app
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND access.can_read_space(space_id, access_class)
  AND accepted_by_user_id = ops.current_user_id()
  AND accepted_by_membership_id = ops.current_membership_id()
  AND acceptance_policy_version = ops.current_policy_version()
);

CREATE POLICY fact_claims_select ON truth.fact_claims
FOR SELECT TO throughline_app
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND access.can_read_space(
    space_id,
    (SELECT fact.access_class FROM truth.accepted_facts fact
      WHERE fact.tenant_id = fact_claims.tenant_id
        AND fact.workspace_id = fact_claims.workspace_id
        AND fact.id = fact_claims.fact_id)
  )
);
CREATE POLICY fact_claims_insert ON truth.fact_claims
FOR INSERT TO throughline_app
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND access.can_read_space(
    space_id,
    (SELECT fact.access_class FROM truth.accepted_facts fact
      WHERE fact.tenant_id = fact_claims.tenant_id
        AND fact.workspace_id = fact_claims.workspace_id
        AND fact.id = fact_claims.fact_id)
  )
);

CREATE POLICY fact_lifecycle_select ON truth.fact_lifecycle_events
FOR SELECT TO throughline_app
USING (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND access.can_read_space(
    space_id,
    (SELECT fact.access_class FROM truth.accepted_facts fact
      WHERE fact.tenant_id = fact_lifecycle_events.tenant_id
        AND fact.workspace_id = fact_lifecycle_events.workspace_id
        AND fact.id = fact_lifecycle_events.fact_id)
  )
);
CREATE POLICY fact_lifecycle_insert ON truth.fact_lifecycle_events
FOR INSERT TO throughline_app
WITH CHECK (
  tenant_id = ops.current_tenant_id()
  AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND access.can_read_space(
    space_id,
    (SELECT fact.access_class FROM truth.accepted_facts fact
      WHERE fact.tenant_id = fact_lifecycle_events.tenant_id
        AND fact.workspace_id = fact_lifecycle_events.workspace_id
        AND fact.id = fact_lifecycle_events.fact_id)
  )
  AND actor_user_id = ops.current_user_id()
  AND actor_membership_id = ops.current_membership_id()
  AND policy_version = ops.current_policy_version()
);

CREATE POLICY verified_evidence_retention_update ON truth.verified_evidence_spans
FOR UPDATE TO throughline_b1_0_integrity
USING (true)
WITH CHECK (true);
CREATE POLICY claims_retention_update ON truth.claims
FOR UPDATE TO throughline_b1_0_integrity
USING (true)
WITH CHECK (true);
CREATE POLICY accepted_facts_retention_update ON truth.accepted_facts
FOR UPDATE TO throughline_b1_0_integrity
USING (true)
WITH CHECK (true);
CREATE POLICY fact_lifecycle_retention_update ON truth.fact_lifecycle_events
FOR UPDATE TO throughline_b1_0_integrity
USING (true)
WITH CHECK (true);
CREATE POLICY verified_evidence_integrity_select ON truth.verified_evidence_spans
FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY claims_integrity_select ON truth.claims
FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY accepted_facts_integrity_select ON truth.accepted_facts
FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY fact_claims_integrity_select ON truth.fact_claims
FOR SELECT TO throughline_b1_0_integrity USING (true);
CREATE POLICY fact_lifecycle_integrity_select ON truth.fact_lifecycle_events
FOR SELECT TO throughline_b1_0_integrity USING (true);

GRANT USAGE ON SCHEMA truth TO throughline_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA truth TO throughline_app;
GRANT UPDATE (status, updated_at, version) ON truth.claims TO throughline_app;

GRANT USAGE ON SCHEMA truth TO throughline_b1_0_integrity;
GRANT SELECT (
  reservation_space_id, command_kind, actor_user_id,
  actor_membership_id, policy_version_id
) ON ops.domain_command_records TO throughline_b1_0_integrity;
GRANT SELECT ON
  truth.verified_evidence_spans, truth.claims, truth.accepted_facts,
  truth.fact_claims, truth.fact_lifecycle_events
TO throughline_b1_0_integrity;
GRANT UPDATE (
  source_excerpt, source_content_hash, source_normalized_content_hash,
  chunk_content_hash, excerpt_hash, redacted_at, redaction_command_id,
  hash_disposition, updated_at, version
) ON truth.verified_evidence_spans TO throughline_b1_0_integrity;
GRANT UPDATE (
  value_json, value_hash, normalized_text, status, redacted_at,
  redaction_command_id, hash_disposition, updated_at, version
) ON truth.claims TO throughline_b1_0_integrity;
GRANT UPDATE (
  value_json, value_hash, normalized_text, status, last_causation_command_id,
  redacted_at, redaction_source_artifact_id, hash_disposition, updated_at, version
) ON truth.accepted_facts TO throughline_b1_0_integrity;
GRANT UPDATE (
  confidence_lowering_rationale, redacted_at, redaction_command_id
) ON truth.fact_lifecycle_events TO throughline_b1_0_integrity;
ALTER FUNCTION truth.reconcile_source_retention()
  OWNER TO throughline_b1_0_integrity;

REVOKE ALL ON ALL TABLES IN SCHEMA truth FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA truth FROM PUBLIC;
REVOKE ALL ON FUNCTION access.can_read_space(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access.can_read_space(uuid, text) TO throughline_app;
