SET LOCAL search_path TO pg_catalog;

LOCK TABLE truth.claims, truth.accepted_facts, truth.fact_claims,
  truth.verified_evidence_spans IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE ops.domain_command_records
  ADD COLUMN safe_request jsonb,
  ADD COLUMN safe_request_adopted boolean NOT NULL DEFAULT false;

ALTER TABLE truth.claims
  DROP CONSTRAINT claims_status_check,
  DROP CONSTRAINT claims_canonical_value_text_valid,
  ADD CONSTRAINT claims_status_check CHECK (
    status IN ('proposed','accepted','rejected','superseded')
  ),
  ADD CONSTRAINT claims_canonical_value_text_valid CHECK (
    canonical_value_text = normalized_text
    AND normalized_text = normalize(normalized_text, NFC)
    AND length(btrim(normalized_text)) BETWEEN 1 AND 2000
    AND (
      (status = 'proposed' AND version = 1)
      OR (status IN ('accepted','rejected','superseded') AND version = 2)
    )
  );

CREATE UNIQUE INDEX claims_one_active_primary_objective_proposal
  ON truth.claims (
    tenant_id, workspace_id, space_id, subject_type, subject_id, predicate
  ) WHERE subject_type = 'initiative'
    AND predicate = 'initiative.primary_objective' AND status = 'proposed';

CREATE TABLE truth.initiative_objective_support_attestations (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  initiative_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  verified_evidence_span_id uuid NOT NULL,
  objective_value_hash text NOT NULL CHECK (objective_value_hash ~ '^[a-f0-9]{64}$'),
  excerpt_hash text NOT NULL CHECK (excerpt_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by_user_id uuid NOT NULL,
  confirmed_by_membership_id uuid NOT NULL,
  causation_command_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  UNIQUE (tenant_id, workspace_id, claim_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id)
    REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, claim_id)
    REFERENCES truth.claims(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, verified_evidence_span_id)
    REFERENCES truth.verified_evidence_spans(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, confirmed_by_membership_id, confirmed_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)
);

CREATE TABLE truth.initiative_objective_proposal_recoveries (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  initiative_id uuid NOT NULL,
  predecessor_claim_id uuid NOT NULL,
  successor_claim_id uuid,
  disposition text NOT NULL CHECK (disposition IN ('withdrawn','rejected','reworked')),
  reason_code text NOT NULL CHECK (reason_code IN (
    'needs_rework','unsupported','incorrect','duplicate','not_useful','sensitive','other','reworked'
  )),
  acted_by_user_id uuid NOT NULL,
  acted_by_membership_id uuid NOT NULL,
  causation_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  CHECK (
    (disposition = 'reworked' AND reason_code = 'reworked' AND successor_claim_id IS NOT NULL)
    OR (disposition IN ('withdrawn','rejected') AND reason_code <> 'reworked'
      AND successor_claim_id IS NULL)
  ),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  UNIQUE (tenant_id, workspace_id, predecessor_claim_id),
  UNIQUE (tenant_id, workspace_id, causation_command_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id)
    REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_claim_id)
    REFERENCES truth.claims(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, successor_claim_id)
    REFERENCES truth.claims(tenant_id, workspace_id, space_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, workspace_id, acted_by_membership_id, acted_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, causation_command_id)
    REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)
);

CREATE FUNCTION truth.require_objective_support_attestation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  selected_claim_id uuid := (CASE TG_TABLE_NAME
    WHEN 'claims' THEN row_data ->> 'id' ELSE row_data ->> 'claim_id' END)::uuid;
  claim_record record;
  attestation_count integer;
BEGIN
  SELECT * INTO claim_record FROM truth.claims claim
   WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
     AND claim.id = selected_claim_id;
  IF claim_record IS NULL THEN
    RAISE EXCEPTION 'objective support confirmation is invalid';
  END IF;
  SELECT count(*) INTO attestation_count
    FROM truth.initiative_objective_support_attestations attestation
    JOIN truth.verified_evidence_spans span
      ON span.tenant_id = attestation.tenant_id
     AND span.workspace_id = attestation.workspace_id
     AND span.space_id = attestation.space_id
     AND span.id = attestation.verified_evidence_span_id
   WHERE attestation.tenant_id = claim_record.tenant_id
     AND attestation.workspace_id = claim_record.workspace_id
     AND attestation.space_id = claim_record.space_id
     AND attestation.claim_id = claim_record.id
     AND attestation.initiative_id = claim_record.subject_id
     AND attestation.verified_evidence_span_id = claim_record.verified_evidence_span_id
     AND attestation.objective_value_hash = claim_record.value_hash
     AND attestation.excerpt_hash = span.excerpt_hash
     AND attestation.confirmed_by_user_id = claim_record.created_by_user_id
     AND attestation.confirmed_by_membership_id = claim_record.created_by_membership_id
     AND attestation.causation_command_id = claim_record.causation_command_id;
  IF claim_record.subject_type = 'initiative'
     AND claim_record.predicate = 'initiative.primary_objective'
     AND claim_record.status IN ('proposed','accepted') THEN
    IF attestation_count <> 1 THEN
      RAISE EXCEPTION 'objective support confirmation is invalid';
    END IF;
  ELSIF NOT (
    claim_record.subject_type = 'initiative'
    AND claim_record.predicate = 'initiative.primary_objective'
    AND claim_record.status IN ('rejected','superseded')
    AND attestation_count IN (0, 1)
  ) AND attestation_count <> 0 THEN
    RAISE EXCEPTION 'objective support confirmation is invalid';
  END IF;
  RETURN NULL;
END
$function$;

CREATE FUNCTION truth.validate_objective_support_attestation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  claim_record record;
BEGIN
  SELECT * INTO claim_record FROM truth.claims claim
   WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
     AND claim.space_id = NEW.space_id AND claim.id = NEW.claim_id;
  IF claim_record IS NULL OR claim_record.subject_type <> 'initiative'
    OR claim_record.predicate <> 'initiative.primary_objective'
    OR claim_record.subject_id <> NEW.initiative_id
    OR claim_record.verified_evidence_span_id <> NEW.verified_evidence_span_id
    OR claim_record.value_hash <> NEW.objective_value_hash
    OR claim_record.created_by_user_id <> NEW.confirmed_by_user_id
    OR claim_record.created_by_membership_id <> NEW.confirmed_by_membership_id
    OR claim_record.causation_command_id <> NEW.causation_command_id
    OR NOT EXISTS (
      SELECT 1 FROM truth.verified_evidence_spans span
       WHERE span.tenant_id = NEW.tenant_id AND span.workspace_id = NEW.workspace_id
         AND span.space_id = NEW.space_id AND span.id = NEW.verified_evidence_span_id
         AND span.excerpt_hash = NEW.excerpt_hash
    )
  THEN RAISE EXCEPTION 'objective support confirmation is invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION truth.validate_objective_recovery()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  predecessor record;
  successor record;
  expected_kind text;
BEGIN
  SELECT * INTO predecessor FROM truth.claims claim
   WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
     AND claim.space_id = NEW.space_id AND claim.id = NEW.predecessor_claim_id;
  IF NEW.disposition = 'reworked' THEN
    SELECT * INTO successor FROM truth.claims claim
     WHERE claim.tenant_id = NEW.tenant_id AND claim.workspace_id = NEW.workspace_id
       AND claim.space_id = NEW.space_id AND claim.id = NEW.successor_claim_id;
  END IF;
  expected_kind := CASE NEW.disposition WHEN 'reworked'
    THEN 'initiative.primary_objective.rework.v1'
    ELSE 'initiative.primary_objective.withdraw.v1' END;
  IF predecessor IS NULL OR predecessor.subject_type <> 'initiative'
    OR predecessor.predicate <> 'initiative.primary_objective'
    OR predecessor.subject_id <> NEW.initiative_id
    OR predecessor.version <> 2
  THEN RAISE EXCEPTION 'objective proposal recovery is invalid';
  END IF;
  IF NEW.disposition = 'reworked' THEN
    IF predecessor.status <> 'superseded'
      OR successor IS NULL OR successor.subject_id <> NEW.initiative_id
      OR successor.predicate <> 'initiative.primary_objective'
      OR successor.status <> 'proposed' OR successor.version <> 1
      OR successor.causation_command_id <> NEW.causation_command_id
    THEN RAISE EXCEPTION 'objective proposal recovery is invalid';
    END IF;
  ELSIF NEW.disposition IN ('withdrawn','rejected') THEN
    IF predecessor.status <> 'rejected' OR NEW.successor_claim_id IS NOT NULL
    THEN RAISE EXCEPTION 'objective proposal recovery is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'objective proposal recovery is invalid';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM ops.domain_command_records command
       WHERE command.tenant_id = NEW.tenant_id AND command.workspace_id = NEW.workspace_id
         AND command.id = NEW.causation_command_id AND command.command_kind = expected_kind
         AND command.state = 'completed' AND command.reservation_space_id = NEW.space_id
         AND command.actor_user_id = NEW.acted_by_user_id
         AND command.actor_membership_id = NEW.acted_by_membership_id
         AND command.safe_request ->> 'subjectId' = NEW.initiative_id::text
         AND command.safe_request ->> 'predecessorClaimId' = NEW.predecessor_claim_id::text
         AND (command.safe_request ->> 'expectedPredecessorVersion')::integer = 1
         AND (
           (NEW.disposition = 'reworked')
           OR (
             command.safe_request ->> 'disposition' = NEW.disposition
             AND command.safe_request ->> 'reasonCode' = NEW.reason_code
           )
         )
    )
  THEN RAISE EXCEPTION 'objective proposal recovery is invalid';
  END IF;
  RETURN NULL;
END
$function$;

CREATE FUNCTION ops.b2_slice1_safe_request_valid(
  command_kind_value text, request_value jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
DECLARE request_keys text[];
BEGIN
  IF jsonb_typeof(request_value) <> 'object'
    OR octet_length(request_value::text) > 8192
    THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO request_keys
    FROM jsonb_object_keys(request_value) key;
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

ALTER TABLE ops.domain_command_records
  DISABLE TRIGGER domain_command_records_transition_guard;
ALTER TABLE ops.domain_command_records
  DISABLE TRIGGER domain_command_records_no_committed_reserved;
ALTER TABLE ops.domain_command_records
  DISABLE TRIGGER domain_command_records_b2_slice1_atomicity_deferred;

WITH reconstructable AS (
  SELECT command.tenant_id, command.workspace_id, command.id,
         jsonb_build_object(
           'subjectType', claim.subject_type,
           'subjectId', claim.subject_id,
           'expectedSubjectVersion', CASE claim.subject_type
             WHEN 'activity' THEN activity.version
             WHEN 'initiative' THEN initiative.version
           END,
           'predicate', claim.predicate,
           'valueHash', claim.value_hash,
           'sourceArtifactId', evidence.source_artifact_id,
           'sourceChunkId', evidence.source_chunk_id,
           'expectedSourceVersion', evidence.source_version,
           'expectedChunkVersion', evidence.chunk_version,
           'normalizationVersion', evidence.normalization_version,
           'chunkingVersion', evidence.chunking_version,
           'startOffset', evidence.source_start_offset,
           'endOffset', evidence.source_end_offset,
           'sourceContentHash', evidence.source_content_hash,
           'sourceNormalizedContentHash', evidence.source_normalized_content_hash,
           'chunkContentHash', evidence.chunk_content_hash,
           'excerptHash', evidence.excerpt_hash,
           'supportConfirmed', false
         ) || CASE WHEN claim.subject_type = 'initiative'
                      AND claim.predicate = 'initiative.primary_objective'
           THEN jsonb_build_object(
             'expectedLatestClaimId', NULL::uuid,
             'expectedLatestClaimVersion', NULL::integer,
             'expectedLatestClaimStatus', NULL::text
           )
           ELSE '{}'::jsonb
         END AS safe_request
    FROM ops.domain_command_records command
    JOIN truth.claims claim
      ON claim.tenant_id = command.tenant_id
     AND claim.workspace_id = command.workspace_id
     AND claim.space_id = command.reservation_space_id
     AND claim.causation_command_id = command.id
    JOIN truth.verified_evidence_spans evidence
      ON evidence.tenant_id = claim.tenant_id
     AND evidence.workspace_id = claim.workspace_id
     AND evidence.space_id = claim.space_id
     AND evidence.id = claim.verified_evidence_span_id
     AND evidence.causation_command_id = command.id
    LEFT JOIN work.activities activity
      ON activity.tenant_id = claim.tenant_id
     AND activity.workspace_id = claim.workspace_id
     AND activity.space_id = claim.space_id
     AND activity.id = claim.subject_id
     AND claim.subject_type = 'activity'
    LEFT JOIN work.initiatives initiative
      ON initiative.tenant_id = claim.tenant_id
     AND initiative.workspace_id = claim.workspace_id
     AND initiative.space_id = claim.space_id
     AND initiative.id = claim.subject_id
     AND claim.subject_type = 'initiative'
   WHERE command.command_kind = 'claim.create.v1'
     AND command.safe_request IS NULL
     AND (SELECT count(*) FROM truth.claims caused_claim
           WHERE caused_claim.tenant_id = command.tenant_id
             AND caused_claim.workspace_id = command.workspace_id
             AND caused_claim.causation_command_id = command.id) = 1
)
UPDATE ops.domain_command_records command
   SET safe_request = reconstructable.safe_request,
       safe_request_adopted = true
  FROM reconstructable
 WHERE command.tenant_id = reconstructable.tenant_id
   AND command.workspace_id = reconstructable.workspace_id
   AND command.id = reconstructable.id;

DO $reconstruct_claim_create_safe_requests$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ops.domain_command_records command
     WHERE command.command_kind = 'claim.create.v1'
       AND (command.safe_request IS NULL
         OR NOT command.safe_request_adopted
         OR NOT ((
           ops.b2_slice1_safe_request_valid(
             command.command_kind, command.safe_request
           ) IS TRUE
           OR (
             command.safe_request ->> 'predicate' = 'initiative.primary_objective'
             AND jsonb_typeof(command.safe_request -> 'supportConfirmed') = 'boolean'
             AND NOT (command.safe_request ->> 'supportConfirmed')::boolean
             AND ops.b2_slice1_safe_request_valid(
               command.command_kind,
               jsonb_set(command.safe_request, '{supportConfirmed}', 'true'::jsonb, false)
             ) IS TRUE
           )
         ) IS TRUE))
  ) THEN
    RAISE EXCEPTION 'existing claim.create request cannot be reconstructed';
  END IF;
END
$reconstruct_claim_create_safe_requests$;

ALTER TABLE ops.domain_command_records
  ENABLE TRIGGER domain_command_records_transition_guard;
ALTER TABLE ops.domain_command_records
  ENABLE TRIGGER domain_command_records_no_committed_reserved;
ALTER TABLE ops.domain_command_records
  ENABLE TRIGGER domain_command_records_b2_slice1_atomicity_deferred;

ALTER TABLE ops.domain_command_records
  ADD CONSTRAINT domain_command_records_b2_safe_request_check CHECK (
    (command_kind IN ('claim.create.v1','initiative.primary_objective.withdraw.v1',
      'initiative.primary_objective.rework.v1')
      AND NOT safe_request_adopted
      AND safe_request IS NOT NULL
      AND ops.b2_slice1_safe_request_valid(command_kind, safe_request) IS TRUE)
    OR (command_kind = 'claim.create.v1'
      AND safe_request_adopted
      AND safe_request IS NOT NULL
      AND ((
        ops.b2_slice1_safe_request_valid(command_kind, safe_request) IS TRUE
        OR (
          safe_request ->> 'predicate' = 'initiative.primary_objective'
          AND jsonb_typeof(safe_request -> 'supportConfirmed') = 'boolean'
          AND NOT (safe_request ->> 'supportConfirmed')::boolean
          AND ops.b2_slice1_safe_request_valid(
            command_kind,
            jsonb_set(safe_request, '{supportConfirmed}', 'true'::jsonb, false)
          ) IS TRUE
        )
      ) IS TRUE))
    OR (command_kind NOT IN ('claim.create.v1','initiative.primary_objective.withdraw.v1',
      'initiative.primary_objective.rework.v1')
      AND NOT safe_request_adopted AND safe_request IS NULL)
  );
GRANT INSERT (safe_request) ON ops.domain_command_records TO throughline_app;

CREATE FUNCTION truth.require_objective_recovery_for_terminal_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.status IN ('rejected','superseded') AND (
    NEW.subject_type <> 'initiative' OR NEW.predicate <> 'initiative.primary_objective'
    OR NOT EXISTS (
      SELECT 1 FROM truth.initiative_objective_proposal_recoveries recovery
       WHERE recovery.tenant_id = NEW.tenant_id
         AND recovery.workspace_id = NEW.workspace_id
         AND recovery.space_id = NEW.space_id
         AND recovery.initiative_id = NEW.subject_id
         AND recovery.predecessor_claim_id = NEW.id
         AND recovery.causation_command_id IN (
           SELECT command.id FROM ops.domain_command_records command
            WHERE command.tenant_id = NEW.tenant_id
              AND command.workspace_id = NEW.workspace_id
              AND command.state = 'completed'
              AND command.reservation_space_id = NEW.space_id
         )
         AND (
           (NEW.status = 'rejected' AND recovery.disposition IN ('withdrawn','rejected'))
           OR (NEW.status = 'superseded' AND recovery.disposition = 'reworked')
         )
    )
  ) THEN RAISE EXCEPTION 'objective proposal terminal transition is incomplete'; END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION truth.require_reserved_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  command_id uuid;
  actual_kind text;
  command_request jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TLB22',
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
  ) OR (TG_ARGV[0] <> 'claim.create-or-rework.v1' AND actual_kind <> TG_ARGV[0])
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
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER verified_evidence_command_guard ON truth.verified_evidence_spans;
CREATE TRIGGER verified_evidence_command_guard BEFORE INSERT ON truth.verified_evidence_spans
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('claim.create-or-rework.v1');
DROP TRIGGER claims_command_guard ON truth.claims;
CREATE TRIGGER claims_command_guard BEFORE INSERT ON truth.claims
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('claim.create-or-rework.v1');

CREATE TRIGGER objective_support_command_guard
BEFORE INSERT ON truth.initiative_objective_support_attestations
FOR EACH ROW EXECUTE FUNCTION truth.require_reserved_command('claim.create-or-rework.v1');
CREATE TRIGGER objective_support_insert_guard
BEFORE INSERT ON truth.initiative_objective_support_attestations
FOR EACH ROW EXECUTE FUNCTION truth.validate_objective_support_attestation();
CREATE TRIGGER objective_support_immutable
BEFORE UPDATE OR DELETE ON truth.initiative_objective_support_attestations
FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation();
CREATE CONSTRAINT TRIGGER claims_objective_support_deferred
AFTER INSERT OR UPDATE ON truth.claims DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION truth.require_objective_support_attestation();
CREATE CONSTRAINT TRIGGER attestations_objective_support_deferred
AFTER INSERT ON truth.initiative_objective_support_attestations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION truth.require_objective_support_attestation();

CREATE TRIGGER objective_recovery_immutable
BEFORE UPDATE OR DELETE ON truth.initiative_objective_proposal_recoveries
FOR EACH ROW EXECUTE FUNCTION truth.reject_mutation();
CREATE CONSTRAINT TRIGGER objective_recovery_valid_deferred
AFTER INSERT ON truth.initiative_objective_proposal_recoveries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION truth.validate_objective_recovery();
CREATE CONSTRAINT TRIGGER claims_objective_recovery_deferred
AFTER UPDATE ON truth.claims DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION truth.require_objective_recovery_for_terminal_claim();

-- The recovery guard accepts either objective command, while the deferred validator
-- proves the exact command kind for the persisted disposition.
CREATE OR REPLACE FUNCTION truth.require_objective_recovery_command()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ops.domain_command_records command
     WHERE command.tenant_id = NEW.tenant_id AND command.workspace_id = NEW.workspace_id
       AND command.id = NEW.causation_command_id
       AND command.command_kind IN (
         'initiative.primary_objective.withdraw.v1',
         'initiative.primary_objective.rework.v1'
       )
       AND command.state = 'reserved' AND command.reservation_space_id = NEW.space_id
       AND command.actor_user_id = ops.current_user_id()
       AND command.actor_membership_id = ops.current_membership_id()
       AND command.policy_version_id = ops.current_policy_version()
       AND command.safe_request ->> 'subjectId' = NEW.initiative_id::text
       AND command.safe_request ->> 'predecessorClaimId' = NEW.predecessor_claim_id::text
       AND (command.safe_request ->> 'expectedPredecessorVersion')::integer = 1
       AND (
         (command.command_kind = 'initiative.primary_objective.rework.v1'
           AND NEW.disposition = 'reworked' AND NEW.reason_code = 'reworked')
         OR (command.command_kind = 'initiative.primary_objective.withdraw.v1'
           AND command.safe_request ->> 'disposition' = NEW.disposition
           AND command.safe_request ->> 'reasonCode' = NEW.reason_code)
       )
  ) THEN RAISE EXCEPTION 'truth mutation requires its exact reserved command'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER objective_recovery_command_guard
BEFORE INSERT ON truth.initiative_objective_proposal_recoveries
FOR EACH ROW EXECUTE FUNCTION truth.require_objective_recovery_command();

CREATE OR REPLACE FUNCTION truth.enforce_claim_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE command_kind_value text;
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
  SELECT command.command_kind INTO command_kind_value
    FROM ops.domain_command_records command
   WHERE command.tenant_id = NEW.tenant_id AND command.workspace_id = NEW.workspace_id
     AND command.state = 'reserved' AND command.reservation_space_id = NEW.space_id
     AND command.actor_user_id = ops.current_user_id()
     AND command.actor_membership_id = ops.current_membership_id()
     AND command.policy_version_id = ops.current_policy_version()
     AND command.command_kind = CASE NEW.status
       WHEN 'accepted' THEN 'fact.accept.v1'
       WHEN 'rejected' THEN 'initiative.primary_objective.withdraw.v1'
       ELSE 'initiative.primary_objective.rework.v1' END
     AND (
       NEW.status = 'accepted'
       OR (
         command.safe_request ->> 'subjectId' = NEW.subject_id::text
         AND command.safe_request ->> 'predecessorClaimId' = NEW.id::text
         AND (command.safe_request ->> 'expectedPredecessorVersion')::integer = OLD.version
       )
     )
   LIMIT 1;
  IF command_kind_value IS NULL THEN
    RAISE EXCEPTION 'claim transition requires its reserved command';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM truth.fact_claims support
    JOIN truth.accepted_facts fact ON fact.tenant_id = support.tenant_id
      AND fact.workspace_id = support.workspace_id AND fact.id = support.fact_id
    JOIN ops.domain_command_records command ON command.tenant_id = fact.tenant_id
      AND command.workspace_id = fact.workspace_id
      AND command.id = fact.last_causation_command_id
    WHERE support.tenant_id = NEW.tenant_id AND support.workspace_id = NEW.workspace_id
      AND support.claim_id = NEW.id AND command.command_kind = 'fact.accept.v1'
      AND command.state = 'reserved'
  ) THEN RAISE EXCEPTION 'claim acceptance requires its reserved fact.accept command'; END IF;
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

ALTER TABLE truth.initiative_objective_support_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.initiative_objective_support_attestations FORCE ROW LEVEL SECURITY;
ALTER TABLE truth.initiative_objective_proposal_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE truth.initiative_objective_proposal_recoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_support_select ON truth.initiative_objective_support_attestations
FOR SELECT TO throughline_app USING (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND access.can_read_space(space_id, (SELECT claim.access_class FROM truth.claims claim
    WHERE claim.tenant_id = initiative_objective_support_attestations.tenant_id
      AND claim.workspace_id = initiative_objective_support_attestations.workspace_id
      AND claim.id = initiative_objective_support_attestations.claim_id))
);
CREATE POLICY objective_support_insert ON truth.initiative_objective_support_attestations
FOR INSERT TO throughline_app WITH CHECK (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND confirmed_by_user_id = ops.current_user_id()
  AND confirmed_by_membership_id = ops.current_membership_id()
  AND access.can_read_space(space_id, (SELECT claim.access_class FROM truth.claims claim
    WHERE claim.tenant_id = initiative_objective_support_attestations.tenant_id
      AND claim.workspace_id = initiative_objective_support_attestations.workspace_id
      AND claim.id = initiative_objective_support_attestations.claim_id))
);
CREATE POLICY objective_recovery_select ON truth.initiative_objective_proposal_recoveries
FOR SELECT TO throughline_app USING (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND access.can_read_space(space_id, (SELECT claim.access_class FROM truth.claims claim
    WHERE claim.tenant_id = initiative_objective_proposal_recoveries.tenant_id
      AND claim.workspace_id = initiative_objective_proposal_recoveries.workspace_id
      AND claim.id = initiative_objective_proposal_recoveries.predecessor_claim_id))
);
CREATE POLICY objective_recovery_insert ON truth.initiative_objective_proposal_recoveries
FOR INSERT TO throughline_app WITH CHECK (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND acted_by_user_id = ops.current_user_id()
  AND acted_by_membership_id = ops.current_membership_id()
  AND access.can_read_space(space_id, (SELECT claim.access_class FROM truth.claims claim
    WHERE claim.tenant_id = initiative_objective_proposal_recoveries.tenant_id
      AND claim.workspace_id = initiative_objective_proposal_recoveries.workspace_id
      AND claim.id = initiative_objective_proposal_recoveries.predecessor_claim_id))
);
GRANT SELECT, INSERT ON truth.initiative_objective_support_attestations,
  truth.initiative_objective_proposal_recoveries TO throughline_app;
GRANT SELECT ON truth.initiative_objective_support_attestations,
  truth.initiative_objective_proposal_recoveries TO throughline_b1_0_integrity;
CREATE POLICY objective_support_integrity_select
ON truth.initiative_objective_support_attestations FOR SELECT
TO throughline_b1_0_integrity USING (true);
CREATE POLICY objective_recovery_integrity_select
ON truth.initiative_objective_proposal_recoveries FOR SELECT
TO throughline_b1_0_integrity USING (true);
REVOKE ALL ON truth.initiative_objective_support_attestations,
  truth.initiative_objective_proposal_recoveries FROM PUBLIC;

ALTER FUNCTION truth.require_objective_support_attestation()
  OWNER TO throughline_b1_0_integrity;
ALTER FUNCTION truth.validate_objective_support_attestation()
  OWNER TO throughline_b1_0_integrity;
ALTER FUNCTION truth.validate_objective_recovery()
  OWNER TO throughline_b1_0_integrity;
ALTER FUNCTION truth.require_objective_recovery_for_terminal_claim()
  OWNER TO throughline_b1_0_integrity;
ALTER FUNCTION truth.require_objective_recovery_command()
  OWNER TO throughline_b1_0_integrity;
ALTER FUNCTION ops.b2_slice1_safe_request_valid(text,jsonb)
  OWNER TO throughline_b1_0_integrity;
REVOKE ALL ON FUNCTION truth.require_objective_support_attestation(),
  truth.validate_objective_support_attestation(),
  truth.validate_objective_recovery(),
  truth.require_objective_recovery_for_terminal_claim(),
  truth.require_objective_recovery_command()
FROM PUBLIC, throughline_app, throughline_relay, throughline_worker,
  throughline_product_relay;
REVOKE ALL ON FUNCTION ops.b2_slice1_safe_request_valid(text,jsonb)
FROM PUBLIC, throughline_relay, throughline_worker, throughline_product_relay;
GRANT EXECUTE ON FUNCTION ops.b2_slice1_safe_request_valid(text,jsonb) TO throughline_app;

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
      WHEN 'fact.accept' THEN 'fact.accepted' ELSE '' END,
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
    'initiative.primary_objective.rework.v1','fact.accept.v1'
  ) THEN RETURN false; END IF;
  IF command_state = 'reserved' THEN
    RETURN result_type IS NULL AND result_id IS NULL AND response IS NULL; END IF;
  IF command_state <> 'completed' OR response IS NULL OR jsonb_typeof(response) <> 'object'
    OR result_id IS NULL OR NOT ops.product_safe_json(response) THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO response_keys
    FROM jsonb_object_keys(response) key;
  IF command_kind_value = 'claim.create.v1' THEN
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

DROP TRIGGER domain_command_records_b2_slice1_atomicity_deferred
  ON ops.domain_command_records;
CREATE CONSTRAINT TRIGGER domain_command_records_b2_slice1_atomicity_deferred
AFTER INSERT OR UPDATE ON ops.domain_command_records
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.command_kind IN (
  'claim.create.v1','initiative.primary_objective.withdraw.v1',
  'initiative.primary_objective.rework.v1','fact.accept.v1'
)) EXECUTE FUNCTION ops.require_b2_slice1_command_atomicity();

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
ALTER FUNCTION ops.require_b2_slice1_command_atomicity() OWNER TO throughline_b1_0_integrity;
REVOKE ALL ON FUNCTION ops.require_b2_slice1_command_atomicity() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.require_b2_slice1_command_atomicity()
  FROM throughline_app, throughline_relay, throughline_worker, throughline_product_relay;
