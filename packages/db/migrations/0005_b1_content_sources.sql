SET LOCAL search_path TO pg_catalog;

CREATE SCHEMA content;
REVOKE ALL ON SCHEMA content FROM PUBLIC;

CREATE TABLE content.content_items (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('page', 'note')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  owner_person_id uuid NOT NULL,
  access_class text NOT NULL CHECK (access_class IN ('public', 'workspace', 'restricted', 'confidential')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id) REFERENCES access.spaces(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, owner_person_id)
    REFERENCES identity.people(tenant_id, workspace_id, id)
);

CREATE TABLE content.content_revisions (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  content_item_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  access_class text NOT NULL CHECK (access_class IN ('public', 'workspace', 'restricted', 'confidential')),
  created_by_user_id uuid NOT NULL REFERENCES identity.users(id),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  UNIQUE (tenant_id, workspace_id, content_item_id, revision_number),
  UNIQUE (tenant_id, workspace_id, space_id, content_item_id, revision_number),
  FOREIGN KEY (tenant_id, workspace_id, space_id, content_item_id)
    REFERENCES content.content_items(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, created_by_membership_id, created_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)
);

CREATE TABLE content.source_artifacts (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('note', 'transcript', 'human')),
  trust_class text NOT NULL CHECK (trust_class = 'untrusted_user_content'),
  title text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 500),
  immutable_text text,
  object_key text,
  content_hash text,
  source_uri text,
  external_ref jsonb,
  provider_id text,
  provider_version text,
  adapter_version text,
  normalization_version text NOT NULL CHECK (normalization_version = 'source-normalization.v1'),
  chunking_version text NOT NULL CHECK (chunking_version = 'source-chunking.v1'),
  normalized_content_hash text,
  hash_retention_policy text NOT NULL CHECK (hash_retention_policy IN ('retain', 'erase_on_tombstone')),
  origin_content_item_id uuid,
  origin_content_revision integer,
  supersedes_source_id uuid,
  captured_by_user_id uuid NOT NULL REFERENCES identity.users(id),
  captured_by_membership_id uuid NOT NULL,
  retrieved_at timestamptz,
  occurred_at timestamptz,
  access_class text NOT NULL CHECK (access_class IN ('public', 'workspace', 'restricted', 'confidential')),
  source_snapshot_policy text NOT NULL CHECK (source_snapshot_policy = 'full_snapshot'),
  retention_policy_id text,
  deleted_at timestamptz,
  deletion_reason text,
  deletion_policy_ref text,
  hash_disposition text CHECK (hash_disposition IS NULL OR hash_disposition IN ('retained', 'erased')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((origin_content_item_id IS NULL) = (origin_content_revision IS NULL)),
  CHECK (deletion_reason IS NULL OR deletion_reason ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  CHECK (deletion_policy_ref IS NULL OR deletion_policy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  CHECK (source_uri IS NULL AND external_ref IS NULL AND provider_id IS NULL
    AND provider_version IS NULL AND adapter_version IS NULL AND retrieved_at IS NULL),
  CHECK (supersedes_source_id IS NULL OR supersedes_source_id <> id),
  CHECK (
    (deleted_at IS NULL AND deletion_reason IS NULL AND deletion_policy_ref IS NULL
      AND hash_disposition IS NULL AND immutable_text IS NOT NULL AND object_key IS NULL
      AND content_hash ~ '^[a-f0-9]{64}$' AND normalized_content_hash ~ '^[a-f0-9]{64}$'
      AND version = 1)
    OR
    (deleted_at IS NOT NULL AND deletion_reason IS NOT NULL AND deletion_policy_ref IS NOT NULL
      AND immutable_text IS NULL AND object_key IS NULL AND version = 2
      AND (
        (hash_retention_policy = 'retain' AND hash_disposition = 'retained'
          AND content_hash ~ '^[a-f0-9]{64}$' AND normalized_content_hash ~ '^[a-f0-9]{64}$')
        OR
        (hash_retention_policy = 'erase_on_tombstone' AND hash_disposition = 'erased'
          AND content_hash IS NULL AND normalized_content_hash IS NULL)
      ))
  ),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  UNIQUE (tenant_id, workspace_id, supersedes_source_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id) REFERENCES access.spaces(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, captured_by_membership_id, captured_by_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, origin_content_item_id, origin_content_revision)
    REFERENCES content.content_revisions(tenant_id, workspace_id, space_id, content_item_id, revision_number),
  FOREIGN KEY (tenant_id, workspace_id, space_id, supersedes_source_id)
    REFERENCES content.source_artifacts(tenant_id, workspace_id, space_id, id)
);

CREATE TABLE content.source_chunks (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  normalization_version text NOT NULL CHECK (normalization_version = 'source-normalization.v1'),
  chunking_version text NOT NULL CHECK (chunking_version = 'source-chunking.v1'),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  normalized_text text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  access_class text NOT NULL CHECK (access_class IN ('public', 'workspace', 'restricted', 'confidential')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (end_offset - start_offset = char_length(normalized_text)),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  UNIQUE (
    tenant_id, workspace_id, source_artifact_id,
    normalization_version, chunking_version, chunk_index
  ),
  FOREIGN KEY (tenant_id, workspace_id, space_id, source_artifact_id)
    REFERENCES content.source_artifacts(tenant_id, workspace_id, space_id, id)
);

CREATE TABLE work.activity_sources (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, activity_id, source_artifact_id),
  UNIQUE (tenant_id, workspace_id, source_artifact_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, activity_id)
    REFERENCES work.activities(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, source_artifact_id)
    REFERENCES content.source_artifacts(tenant_id, workspace_id, space_id, id)
);

CREATE INDEX content_items_space_idx
  ON content.content_items (tenant_id, workspace_id, space_id, updated_at DESC);
CREATE INDEX source_artifacts_space_idx
  ON content.source_artifacts (tenant_id, workspace_id, space_id, created_at DESC);
CREATE INDEX source_artifacts_predecessor_idx
  ON content.source_artifacts (tenant_id, workspace_id, supersedes_source_id);
CREATE INDEX source_chunks_source_idx
  ON content.source_chunks (tenant_id, workspace_id, source_artifact_id, chunk_index);
CREATE INDEX activity_sources_activity_idx
  ON work.activity_sources (tenant_id, workspace_id, activity_id, created_at DESC);

CREATE FUNCTION content.reject_immutable_row_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'content evidence row is immutable';
END
$function$;

CREATE TRIGGER content_revisions_immutable
BEFORE UPDATE OR DELETE ON content.content_revisions
FOR EACH ROW EXECUTE FUNCTION content.reject_immutable_row_mutation();

CREATE FUNCTION content.validate_content_revision_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE item_record record;
BEGIN
  SELECT space_id, title, metadata, access_class, current_revision INTO item_record
  FROM content.content_items
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.content_item_id;
  IF NOT FOUND OR NEW.space_id <> item_record.space_id
    OR NEW.title <> item_record.title OR NEW.metadata <> item_record.metadata
    OR NEW.access_class <> item_record.access_class
    OR NEW.revision_number <> item_record.current_revision THEN
    RAISE EXCEPTION 'content revision does not match its current item state';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER content_revisions_insert_integrity
BEFORE INSERT ON content.content_revisions
FOR EACH ROW EXECUTE FUNCTION content.validate_content_revision_insert();
CREATE TRIGGER activity_sources_immutable
BEFORE UPDATE OR DELETE ON work.activity_sources
FOR EACH ROW EXECUTE FUNCTION content.reject_immutable_row_mutation();

CREATE FUNCTION content.access_class_rank(value text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
  SELECT CASE value WHEN 'public' THEN 0 WHEN 'workspace' THEN 1
    WHEN 'restricted' THEN 2 WHEN 'confidential' THEN 3 ELSE NULL END
$function$;

CREATE FUNCTION content.validate_content_item_access_class()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE governing_class text;
BEGIN
  SELECT access_class INTO governing_class FROM access.spaces
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.space_id AND archived_at IS NULL;
  IF NOT FOUND OR content.access_class_rank(NEW.access_class) < content.access_class_rank(governing_class) THEN
    RAISE EXCEPTION 'content access class cannot be broader than its Space';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER content_items_access_class
BEFORE INSERT ON content.content_items
FOR EACH ROW EXECUTE FUNCTION content.validate_content_item_access_class();

CREATE FUNCTION content.validate_content_item_revision_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.space_id, NEW.type,
    NEW.owner_person_id, NEW.access_class, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.space_id, OLD.type,
    OLD.owner_person_id, OLD.access_class, OLD.created_at
  ) OR NEW.current_revision <> OLD.current_revision + 1 OR NEW.version <> OLD.version + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'content item revision transition is invalid';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER content_items_revision_update
BEFORE UPDATE ON content.content_items
FOR EACH ROW EXECUTE FUNCTION content.validate_content_item_revision_update();

CREATE FUNCTION content.require_current_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE target_tenant uuid; target_workspace uuid; target_item uuid; current_revision integer;
BEGIN
  target_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  target_workspace := COALESCE(NEW.workspace_id, OLD.workspace_id);
  IF TG_TABLE_NAME = 'content_items' THEN target_item := COALESCE(NEW.id, OLD.id);
  ELSE target_item := COALESCE(NEW.content_item_id, OLD.content_item_id); END IF;
  SELECT item.current_revision INTO current_revision FROM content.content_items item
  WHERE item.tenant_id = target_tenant AND item.workspace_id = target_workspace AND item.id = target_item;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM content.content_revisions revision
    WHERE revision.tenant_id = target_tenant AND revision.workspace_id = target_workspace
      AND revision.content_item_id = target_item AND revision.revision_number = current_revision
  ) OR EXISTS (
    SELECT 1 FROM content.content_revisions revision
    WHERE revision.tenant_id = target_tenant AND revision.workspace_id = target_workspace
      AND revision.content_item_id = target_item AND revision.revision_number > current_revision
  ) THEN RAISE EXCEPTION 'content item current revision is not complete'; END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER content_items_current_revision_deferred
AFTER INSERT OR UPDATE OR DELETE ON content.content_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content.require_current_revision();
CREATE CONSTRAINT TRIGGER content_revisions_current_revision_deferred
AFTER INSERT ON content.content_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content.require_current_revision();

CREATE FUNCTION content.validate_source_insert_or_correction()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE predecessor content.source_artifacts%ROWTYPE; workspace_retention text; governing_class text;
BEGIN
  SELECT workspace.retention_policy_id, space.access_class
  INTO workspace_retention, governing_class
  FROM identity.workspaces workspace
  JOIN access.spaces space
    ON space.tenant_id = workspace.tenant_id AND space.workspace_id = workspace.id
    AND space.id = NEW.space_id AND space.archived_at IS NULL
  WHERE workspace.tenant_id = NEW.tenant_id AND workspace.id = NEW.workspace_id
    AND workspace.status = 'active';
  IF NOT FOUND OR NEW.retention_policy_id IS DISTINCT FROM workspace_retention
    OR NEW.hash_retention_policy <> (CASE
      WHEN workspace_retention = 'erase_on_tombstone'
        OR workspace_retention LIKE 'erase_on_tombstone:%' THEN 'erase_on_tombstone'
      ELSE 'retain' END)
    OR content.access_class_rank(NEW.access_class) < content.access_class_rank(governing_class) THEN
    RAISE EXCEPTION 'source retention or access policy was not derived from its Workspace and Space';
  END IF;
  IF NEW.content_hash <> encode(public.digest(pg_catalog.convert_to(NEW.immutable_text, 'UTF8'), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'source content hash mismatch';
  END IF;
  IF NEW.supersedes_source_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM content.source_artifacts
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND space_id = NEW.space_id AND id = NEW.supersedes_source_id
    FOR UPDATE;
    IF NOT FOUND OR predecessor.deleted_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM content.source_artifacts successor
      WHERE successor.tenant_id = NEW.tenant_id AND successor.workspace_id = NEW.workspace_id
        AND successor.supersedes_source_id = NEW.supersedes_source_id
    ) THEN RAISE EXCEPTION 'source correction predecessor is not a live terminal leaf'; END IF;
    IF (CASE predecessor.access_class
      WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END)
      > (CASE NEW.access_class
      WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END) THEN
      RAISE EXCEPTION 'source correction cannot downgrade access class';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER source_artifacts_insert_integrity
BEFORE INSERT ON content.source_artifacts
FOR EACH ROW EXECUTE FUNCTION content.validate_source_insert_or_correction();

CREATE FUNCTION content.enforce_source_tombstone_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF OLD.deleted_at IS NOT NULL
    OR ROW(
      NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.space_id, NEW.source_type, NEW.trust_class,
      NEW.title, NEW.normalization_version, NEW.chunking_version, NEW.hash_retention_policy,
      NEW.source_uri, NEW.external_ref, NEW.provider_id, NEW.provider_version, NEW.adapter_version,
      NEW.origin_content_item_id, NEW.origin_content_revision, NEW.supersedes_source_id,
      NEW.captured_by_user_id, NEW.captured_by_membership_id, NEW.retrieved_at, NEW.occurred_at,
      NEW.access_class, NEW.source_snapshot_policy, NEW.retention_policy_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.space_id, OLD.source_type, OLD.trust_class,
      OLD.title, OLD.normalization_version, OLD.chunking_version, OLD.hash_retention_policy,
      OLD.source_uri, OLD.external_ref, OLD.provider_id, OLD.provider_version, OLD.adapter_version,
      OLD.origin_content_item_id, OLD.origin_content_revision, OLD.supersedes_source_id,
      OLD.captured_by_user_id, OLD.captured_by_membership_id, OLD.retrieved_at, OLD.occurred_at,
      OLD.access_class, OLD.source_snapshot_policy, OLD.retention_policy_id, OLD.created_at
    ) OR NEW.deleted_at IS NULL OR NEW.deletion_reason IS NULL OR NEW.deletion_policy_ref IS NULL
    OR NEW.immutable_text IS NOT NULL OR NEW.object_key IS NOT NULL
    OR NEW.version <> OLD.version + 1 OR NEW.version <> 2 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'source artifact mutation is not the governed tombstone transition';
  END IF;
  IF OLD.hash_retention_policy = 'retain' THEN
    IF NEW.hash_disposition <> 'retained' OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
      OR NEW.normalized_content_hash IS DISTINCT FROM OLD.normalized_content_hash THEN
      RAISE EXCEPTION 'retained-hash tombstone transition mismatch';
    END IF;
  ELSE
    IF NEW.hash_disposition <> 'erased' OR NEW.content_hash IS NOT NULL
      OR NEW.normalized_content_hash IS NOT NULL THEN
      RAISE EXCEPTION 'erased-hash tombstone transition mismatch';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER source_artifacts_tombstone_only
BEFORE UPDATE ON content.source_artifacts
FOR EACH ROW EXECUTE FUNCTION content.enforce_source_tombstone_transition();
CREATE TRIGGER source_artifacts_no_delete
BEFORE DELETE ON content.source_artifacts
FOR EACH ROW EXECUTE FUNCTION content.reject_immutable_row_mutation();

CREATE FUNCTION content.validate_source_chunk()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE source_record record;
BEGIN
  SELECT normalization_version, chunking_version, access_class, deleted_at INTO source_record
  FROM content.source_artifacts
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND space_id = NEW.space_id AND id = NEW.source_artifact_id;
  IF NOT FOUND OR source_record.deleted_at IS NOT NULL
    OR source_record.normalization_version <> NEW.normalization_version
    OR source_record.chunking_version <> NEW.chunking_version
    OR source_record.access_class <> NEW.access_class
    OR NEW.content_hash <> encode(public.digest(pg_catalog.convert_to(NEW.normalized_text, 'UTF8'), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'source chunk payload does not match its source';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER source_chunks_insert_integrity
BEFORE INSERT ON content.source_chunks
FOR EACH ROW EXECUTE FUNCTION content.validate_source_chunk();
CREATE TRIGGER source_chunks_no_update
BEFORE UPDATE ON content.source_chunks
FOR EACH ROW EXECUTE FUNCTION content.reject_immutable_row_mutation();

CREATE FUNCTION content.allow_chunk_delete_after_tombstone()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM content.source_artifacts source
    WHERE source.tenant_id = OLD.tenant_id AND source.workspace_id = OLD.workspace_id
      AND source.space_id = OLD.space_id AND source.id = OLD.source_artifact_id
      AND source.deleted_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'live source chunks are immutable'; END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER source_chunks_governed_delete
BEFORE DELETE ON content.source_chunks
FOR EACH ROW EXECUTE FUNCTION content.allow_chunk_delete_after_tombstone();

CREATE FUNCTION content.require_source_chunk_reconstruction()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE target_tenant uuid; target_workspace uuid; target_source uuid; source_record record; reconstruction record;
BEGIN
  target_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  target_workspace := COALESCE(NEW.workspace_id, OLD.workspace_id);
  IF TG_TABLE_NAME = 'source_artifacts' THEN target_source := COALESCE(NEW.id, OLD.id);
  ELSE target_source := COALESCE(NEW.source_artifact_id, OLD.source_artifact_id); END IF;
  SELECT deleted_at, normalized_content_hash INTO source_record
  FROM content.source_artifacts
  WHERE tenant_id = target_tenant AND workspace_id = target_workspace AND id = target_source;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF source_record.deleted_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM content.source_chunks WHERE tenant_id = target_tenant
      AND workspace_id = target_workspace AND source_artifact_id = target_source) THEN
      RAISE EXCEPTION 'tombstoned source retains chunks';
    END IF;
    RETURN NULL;
  END IF;
  SELECT count(*) AS chunk_count, min(chunk_index) AS first_index, max(chunk_index) AS last_index,
    min(start_offset) AS first_offset, max(end_offset) AS final_offset,
    string_agg(normalized_text, '' ORDER BY chunk_index) AS normalized_text,
    bool_and(start_offset = COALESCE(previous_end, 0)) AS contiguous
  INTO reconstruction
  FROM (
    SELECT chunk.*, lag(end_offset) OVER (ORDER BY chunk_index) AS previous_end
    FROM content.source_chunks chunk
    WHERE tenant_id = target_tenant AND workspace_id = target_workspace
      AND source_artifact_id = target_source
  ) ordered_chunks;
  IF reconstruction.chunk_count < 1 OR reconstruction.first_index <> 0
    OR reconstruction.last_index <> reconstruction.chunk_count - 1 OR reconstruction.first_offset <> 0
    OR NOT reconstruction.contiguous
    OR reconstruction.final_offset <> char_length(reconstruction.normalized_text)
    OR encode(public.digest(pg_catalog.convert_to(reconstruction.normalized_text, 'UTF8'), 'sha256'), 'hex')
      <> source_record.normalized_content_hash THEN
    RAISE EXCEPTION 'source chunks do not reconstruct the normalized artifact';
  END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER source_artifacts_chunks_deferred
AFTER INSERT OR UPDATE ON content.source_artifacts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content.require_source_chunk_reconstruction();
CREATE CONSTRAINT TRIGGER source_chunks_reconstruction_deferred
AFTER INSERT OR DELETE ON content.source_chunks
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content.require_source_chunk_reconstruction();

DO $security$
DECLARE schema_name text; table_name text;
BEGIN
  FOR schema_name, table_name IN VALUES
    ('content', 'content_items'), ('content', 'content_revisions'),
    ('content', 'source_artifacts'), ('content', 'source_chunks'), ('work', 'activity_sources')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR SELECT TO throughline_app USING (
        tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
      )', table_name || '_app_select', schema_name, table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR INSERT TO throughline_app WITH CHECK (
        tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
        AND space_id = ops.current_space_id()
      )', table_name || '_app_insert', schema_name, table_name
    );
  END LOOP;
END
$security$;

CREATE POLICY content_items_app_update ON content.content_items
FOR UPDATE TO throughline_app
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id());
CREATE POLICY source_artifacts_app_tombstone ON content.source_artifacts
FOR UPDATE TO throughline_app
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id());
CREATE POLICY source_chunks_app_tombstone_delete ON content.source_chunks
FOR DELETE TO throughline_app
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id());

GRANT USAGE ON SCHEMA content TO throughline_app;
GRANT SELECT, INSERT ON content.content_items, content.content_revisions,
  content.source_artifacts, content.source_chunks, work.activity_sources TO throughline_app;
GRANT UPDATE (title, metadata, current_revision, updated_at, version)
  ON content.content_items TO throughline_app;
GRANT UPDATE (
  immutable_text, object_key, content_hash, normalized_content_hash, deleted_at,
  deletion_reason, deletion_policy_ref, hash_disposition, updated_at, version
) ON content.source_artifacts TO throughline_app;
GRANT DELETE ON content.source_chunks TO throughline_app;

REVOKE ALL ON ALL TABLES IN SCHEMA content FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA content FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.access_class_rank(text) TO throughline_app;

DO $assertions$
DECLARE unsecured_count integer;
BEGIN
  SELECT count(*) INTO unsecured_count
  FROM pg_class relation_record
  JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
  WHERE namespace_record.nspname IN ('content', 'work')
    AND relation_record.relname IN (
      'content_items', 'content_revisions', 'source_artifacts', 'source_chunks', 'activity_sources'
    ) AND (NOT relation_record.relrowsecurity OR NOT relation_record.relforcerowsecurity);
  IF unsecured_count <> 0 THEN RAISE EXCEPTION 'every B1 content table must have forced RLS'; END IF;
  IF has_table_privilege('throughline_relay', 'content.source_artifacts', 'SELECT')
    OR has_table_privilege('throughline_worker', 'content.source_artifacts', 'SELECT')
    OR has_table_privilege('throughline_product_relay', 'content.source_artifacts', 'SELECT') THEN
    RAISE EXCEPTION 'non-application roles must not receive B1 source access';
  END IF;
END
$assertions$;
