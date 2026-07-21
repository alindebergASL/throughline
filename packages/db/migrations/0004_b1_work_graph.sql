SET LOCAL search_path TO pg_catalog;

CREATE SCHEMA work;
REVOKE ALL ON SCHEMA work FROM PUBLIC;

CREATE FUNCTION work.canonical_domain(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
  SELECT value = lower(value)
    AND length(value) BETWEEN 3 AND 253
    AND value LIKE '%.%'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(string_to_array(value, '.')) AS labels(label)
      WHERE length(label) NOT BETWEEN 1 AND 63
        OR label !~ '^(?!-)[a-z0-9-]+(?<!-)$'
    )
$function$;

CREATE TABLE work.organizations (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 300),
  status text NOT NULL CHECK (status IN ('active', 'archived')) DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id) REFERENCES access.spaces(tenant_id, workspace_id, id)
);

CREATE TABLE work.organization_domains (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  domain text NOT NULL CHECK (work.canonical_domain(domain)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, organization_id, domain),
  FOREIGN KEY (tenant_id, workspace_id, space_id, organization_id)
    REFERENCES work.organizations(tenant_id, workspace_id, space_id, id)
);

CREATE TABLE work.initiatives (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  type_key text NOT NULL CHECK (type_key ~ '^[a-z][a-z0-9_]*$'),
  stage_key text NOT NULL CHECK (stage_key ~ '^[a-z][a-z0-9_]*$'),
  health text NOT NULL CHECK (health IN ('active', 'stalled', 'paused', 'blocked', 'closed')),
  owner_person_id uuid NOT NULL,
  profile_id text NOT NULL,
  profile_version text NOT NULL,
  evidence_score numeric,
  evidence_challenge text,
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

CREATE TABLE work.initiative_organizations (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  initiative_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  association_role text NOT NULL CHECK (association_role IN ('primary', 'supporting')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at > created_at),
  PRIMARY KEY (tenant_id, workspace_id, initiative_id, organization_id, created_at),
  FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id)
    REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, organization_id)
    REFERENCES work.organizations(tenant_id, workspace_id, id)
);
CREATE UNIQUE INDEX initiative_organizations_active_unique
  ON work.initiative_organizations (tenant_id, workspace_id, initiative_id, organization_id)
  WHERE ended_at IS NULL;
CREATE UNIQUE INDEX initiative_organizations_one_primary_unique
  ON work.initiative_organizations (tenant_id, workspace_id, initiative_id)
  WHERE association_role = 'primary' AND ended_at IS NULL;

CREATE TABLE work.initiative_people (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  initiative_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role = 'contributor'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at > created_at),
  PRIMARY KEY (tenant_id, workspace_id, initiative_id, person_id, created_at),
  FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id)
    REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, person_id)
    REFERENCES identity.people(tenant_id, workspace_id, id)
);
CREATE UNIQUE INDEX initiative_people_active_unique
  ON work.initiative_people (tenant_id, workspace_id, initiative_id, person_id)
  WHERE ended_at IS NULL;

CREATE TABLE work.activities (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  subtype text NOT NULL CHECK (subtype ~ '^[a-z][a-z0-9_]*$'),
  profile_template_key text NOT NULL CHECK (profile_template_key ~ '^[a-z][a-z0-9_]*$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (
    status IN ('planned', 'in_progress', 'captured', 'review_pending', 'completed', 'cancelled')
  ),
  occurred_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  owner_person_id uuid NOT NULL,
  governing_initiative_id uuid,
  governing_organization_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (subtype = profile_template_key),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
  CHECK ((governing_initiative_id IS NULL) <> (governing_organization_id IS NULL)),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id) REFERENCES access.spaces(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, owner_person_id)
    REFERENCES identity.people(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, governing_initiative_id)
    REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, governing_organization_id)
    REFERENCES work.organizations(tenant_id, workspace_id, space_id, id)
);

CREATE TABLE work.activity_organizations (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, activity_id, organization_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, activity_id)
    REFERENCES work.activities(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, organization_id)
    REFERENCES work.organizations(tenant_id, workspace_id, id)
);

CREATE TABLE work.activity_initiatives (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  initiative_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, activity_id, initiative_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, activity_id)
    REFERENCES work.activities(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, initiative_id)
    REFERENCES work.initiatives(tenant_id, workspace_id, id)
);

CREATE TABLE work.activity_attendees (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  person_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, activity_id, person_id),
  FOREIGN KEY (tenant_id, workspace_id, space_id, activity_id)
    REFERENCES work.activities(tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id, person_id)
    REFERENCES identity.people(tenant_id, workspace_id, id)
);

CREATE TABLE work.relationships (
  id uuid PRIMARY KEY CHECK (ops.is_uuid_v7(id)),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (
    subject_type IN ('space', 'person', 'organization', 'initiative', 'activity', 'content')
  ),
  subject_id uuid NOT NULL,
  predicate text NOT NULL CHECK (predicate ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  object_type text NOT NULL CHECK (
    object_type IN ('space', 'person', 'organization', 'initiative', 'activity', 'content')
  ),
  object_id uuid NOT NULL,
  context_type text CHECK (
    context_type IS NULL OR context_type IN ('space', 'person', 'organization', 'initiative', 'activity', 'content')
  ),
  context_id uuid,
  supporting_fact_id uuid,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((context_type IS NULL) = (context_id IS NULL)),
  CHECK (supporting_fact_id IS NULL),
  CHECK (subject_type <> object_type OR subject_id <> object_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, space_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, space_id) REFERENCES access.spaces(tenant_id, workspace_id, id)
);

CREATE INDEX organizations_space_idx ON work.organizations (tenant_id, workspace_id, space_id, name);
CREATE INDEX initiatives_space_idx ON work.initiatives (tenant_id, workspace_id, space_id, stage_key);
CREATE INDEX activities_space_time_idx
  ON work.activities (tenant_id, workspace_id, space_id, occurred_at DESC);
CREATE INDEX relationships_subject_idx
  ON work.relationships (tenant_id, workspace_id, subject_type, subject_id, created_at DESC);
CREATE INDEX relationships_object_idx
  ON work.relationships (tenant_id, workspace_id, object_type, object_id, created_at DESC);

CREATE FUNCTION work.require_one_primary_organization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  target_tenant uuid;
  target_workspace uuid;
  target_initiative uuid;
  aggregate_exists boolean;
  primary_count integer;
BEGIN
  IF TG_TABLE_NAME = 'initiatives' THEN
    target_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
    target_workspace := COALESCE(NEW.workspace_id, OLD.workspace_id);
    target_initiative := COALESCE(NEW.id, OLD.id);
  ELSE
    target_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
    target_workspace := COALESCE(NEW.workspace_id, OLD.workspace_id);
    target_initiative := COALESCE(NEW.initiative_id, OLD.initiative_id);
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM work.initiatives
    WHERE tenant_id = target_tenant AND workspace_id = target_workspace AND id = target_initiative
  ) INTO aggregate_exists;
  IF NOT aggregate_exists THEN RETURN NULL; END IF;
  SELECT count(*) INTO primary_count
  FROM work.initiative_organizations
  WHERE tenant_id = target_tenant AND workspace_id = target_workspace
    AND initiative_id = target_initiative AND association_role = 'primary' AND ended_at IS NULL;
  IF primary_count <> 1 THEN RAISE EXCEPTION 'initiative requires exactly one active primary organization'; END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER initiatives_primary_organization_deferred
AFTER INSERT OR UPDATE OR DELETE ON work.initiatives
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.require_one_primary_organization();
CREATE CONSTRAINT TRIGGER initiative_organizations_primary_deferred
AFTER INSERT OR UPDATE OR DELETE ON work.initiative_organizations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.require_one_primary_organization();

CREATE FUNCTION work.require_activity_governing_association()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  target_tenant uuid;
  target_workspace uuid;
  target_activity uuid;
  activity_record record;
BEGIN
  target_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  target_workspace := COALESCE(NEW.workspace_id, OLD.workspace_id);
  IF TG_TABLE_NAME = 'activities' THEN
    target_activity := COALESCE(NEW.id, OLD.id);
  ELSE
    target_activity := COALESCE(NEW.activity_id, OLD.activity_id);
  END IF;
  SELECT space_id, governing_initiative_id, governing_organization_id INTO activity_record
  FROM work.activities
  WHERE tenant_id = target_tenant AND workspace_id = target_workspace AND id = target_activity;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF activity_record.governing_initiative_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM work.activity_initiatives
      WHERE tenant_id = target_tenant AND workspace_id = target_workspace
        AND activity_id = target_activity AND initiative_id = activity_record.governing_initiative_id
    ) THEN RAISE EXCEPTION 'governing initiative must be associated to activity'; END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM work.activity_organizations
      WHERE tenant_id = target_tenant AND workspace_id = target_workspace
        AND activity_id = target_activity AND organization_id = activity_record.governing_organization_id
    ) THEN RAISE EXCEPTION 'governing organization must be associated to activity'; END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER activities_governing_association_deferred
AFTER INSERT OR UPDATE OR DELETE ON work.activities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.require_activity_governing_association();
CREATE CONSTRAINT TRIGGER activity_initiatives_governing_deferred
AFTER INSERT OR UPDATE OR DELETE ON work.activity_initiatives
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.require_activity_governing_association();
CREATE CONSTRAINT TRIGGER activity_organizations_governing_deferred
AFTER INSERT OR UPDATE OR DELETE ON work.activity_organizations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION work.require_activity_governing_association();

CREATE FUNCTION work.resolve_relationship_endpoint(
  endpoint_type text,
  endpoint_id uuid,
  endpoint_tenant uuid,
  endpoint_workspace uuid,
  OUT endpoint_found boolean,
  OUT resolved_space_id uuid
)
RETURNS record
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
BEGIN
  endpoint_found := false;
  resolved_space_id := NULL;
  CASE endpoint_type
    WHEN 'space' THEN
      SELECT true, id INTO endpoint_found, resolved_space_id FROM access.spaces
      WHERE tenant_id = endpoint_tenant AND workspace_id = endpoint_workspace
        AND id = endpoint_id AND archived_at IS NULL;
    WHEN 'person' THEN
      SELECT true, NULL::uuid INTO endpoint_found, resolved_space_id FROM identity.people
      WHERE tenant_id = endpoint_tenant AND workspace_id = endpoint_workspace AND id = endpoint_id;
    WHEN 'organization' THEN
      SELECT true, space_id INTO endpoint_found, resolved_space_id FROM work.organizations
      WHERE tenant_id = endpoint_tenant AND workspace_id = endpoint_workspace AND id = endpoint_id;
    WHEN 'initiative' THEN
      SELECT true, space_id INTO endpoint_found, resolved_space_id FROM work.initiatives
      WHERE tenant_id = endpoint_tenant AND workspace_id = endpoint_workspace AND id = endpoint_id;
    WHEN 'activity' THEN
      SELECT true, space_id INTO endpoint_found, resolved_space_id FROM work.activities
      WHERE tenant_id = endpoint_tenant AND workspace_id = endpoint_workspace AND id = endpoint_id;
    WHEN 'content' THEN
      SELECT true, space_id INTO endpoint_found, resolved_space_id FROM content.content_items
      WHERE tenant_id = endpoint_tenant AND workspace_id = endpoint_workspace AND id = endpoint_id;
    ELSE
      RAISE EXCEPTION 'relationship endpoint type is not implemented';
  END CASE;
END
$function$;

CREATE FUNCTION work.validate_relationship_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  subject_found boolean;
  subject_space uuid;
  object_found boolean;
  object_space uuid;
  context_found boolean;
  context_space uuid;
  derived_space uuid;
BEGIN
  SELECT endpoint_found, resolved_space_id INTO subject_found, subject_space
  FROM work.resolve_relationship_endpoint(NEW.subject_type, NEW.subject_id, NEW.tenant_id, NEW.workspace_id);
  SELECT endpoint_found, resolved_space_id INTO object_found, object_space
  FROM work.resolve_relationship_endpoint(NEW.object_type, NEW.object_id, NEW.tenant_id, NEW.workspace_id);
  IF NOT COALESCE(subject_found, false) OR NOT COALESCE(object_found, false) THEN
    RAISE EXCEPTION 'relationship endpoint is missing or cross-scope';
  END IF;
  IF NEW.context_type IS NOT NULL THEN
    SELECT endpoint_found, resolved_space_id INTO context_found, context_space
    FROM work.resolve_relationship_endpoint(NEW.context_type, NEW.context_id, NEW.tenant_id, NEW.workspace_id);
    IF NOT COALESCE(context_found, false) OR context_space IS NULL THEN
      RAISE EXCEPTION 'relationship context must be Space-bearing';
    END IF;
    derived_space := context_space;
  ELSE
    derived_space := COALESCE(subject_space, object_space);
  END IF;
  IF derived_space IS NULL OR NEW.space_id <> derived_space THEN
    RAISE EXCEPTION 'relationship governing Space mismatch';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER relationships_scope_integrity
BEFORE INSERT OR UPDATE ON work.relationships
FOR EACH ROW EXECUTE FUNCTION work.validate_relationship_scope();

CREATE FUNCTION work.reject_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'work graph association rows are append-only';
END
$function$;
CREATE TRIGGER organization_domains_append_only BEFORE UPDATE OR DELETE ON work.organization_domains
FOR EACH ROW EXECUTE FUNCTION work.reject_append_only_mutation();

CREATE FUNCTION work.enforce_historical_association_end()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
    OR NEW.ended_at <= OLD.created_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'historical work graph associations may only be ended once';
  END IF;
  IF TG_TABLE_NAME = 'initiative_organizations' AND ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.space_id, NEW.initiative_id,
    NEW.organization_id, NEW.association_role
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.space_id, OLD.initiative_id,
    OLD.organization_id, OLD.association_role
  ) THEN RAISE EXCEPTION 'initiative organization identity is immutable'; END IF;
  IF TG_TABLE_NAME = 'initiative_people' AND ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.space_id, NEW.initiative_id, NEW.person_id, NEW.role
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.space_id, OLD.initiative_id, OLD.person_id, OLD.role
  ) THEN RAISE EXCEPTION 'initiative contributor identity is immutable'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER initiative_organizations_end_only
BEFORE UPDATE OR DELETE ON work.initiative_organizations
FOR EACH ROW EXECUTE FUNCTION work.enforce_historical_association_end();
CREATE TRIGGER initiative_people_end_only
BEFORE UPDATE OR DELETE ON work.initiative_people
FOR EACH ROW EXECUTE FUNCTION work.enforce_historical_association_end();
CREATE TRIGGER activity_organizations_append_only BEFORE UPDATE OR DELETE ON work.activity_organizations
FOR EACH ROW EXECUTE FUNCTION work.reject_append_only_mutation();
CREATE TRIGGER activity_initiatives_append_only BEFORE UPDATE OR DELETE ON work.activity_initiatives
FOR EACH ROW EXECUTE FUNCTION work.reject_append_only_mutation();
CREATE TRIGGER activity_attendees_append_only BEFORE UPDATE OR DELETE ON work.activity_attendees
FOR EACH ROW EXECUTE FUNCTION work.reject_append_only_mutation();

DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organizations', 'organization_domains', 'initiatives', 'initiative_organizations',
    'initiative_people', 'activities', 'activity_organizations', 'activity_initiatives',
    'activity_attendees', 'relationships'
  ] LOOP
    EXECUTE format('ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE work.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON work.%I FOR SELECT TO throughline_app USING (
        tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
      )', table_name || '_app_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON work.%I FOR INSERT TO throughline_app WITH CHECK (
        tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
        AND space_id = ops.current_space_id()
      )', table_name || '_app_insert', table_name
    );
  END LOOP;
END
$security$;

CREATE POLICY relationships_app_update ON work.relationships
FOR UPDATE TO throughline_app
USING (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
)
WITH CHECK (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
);

CREATE POLICY activities_app_source_capture_lock ON work.activities
AS PERMISSIVE FOR UPDATE TO throughline_app
USING (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND status IN ('planned', 'in_progress', 'captured', 'review_pending', 'completed')
  AND EXISTS (
    SELECT 1 FROM access.spaces governing_space
    WHERE governing_space.tenant_id = work.activities.tenant_id
      AND governing_space.workspace_id = work.activities.workspace_id
      AND governing_space.id = work.activities.space_id
      AND governing_space.archived_at IS NULL
  )
)
WITH CHECK (false);

CREATE POLICY activities_app_permanent_no_write ON work.activities
AS RESTRICTIVE FOR UPDATE TO throughline_app
USING (true)
WITH CHECK (false);

GRANT USAGE ON SCHEMA work TO throughline_app;
GRANT SELECT, INSERT ON
  work.organizations, work.organization_domains, work.initiatives,
  work.initiative_organizations, work.initiative_people, work.activities,
  work.activity_organizations, work.activity_initiatives, work.activity_attendees,
  work.relationships
TO throughline_app;
GRANT UPDATE (id) ON work.activities TO throughline_app;
GRANT UPDATE (valid_to, updated_at, version) ON work.relationships TO throughline_app;

REVOKE ALL ON ALL TABLES IN SCHEMA work FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA work FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.resolve_relationship_endpoint(text, uuid, uuid, uuid)
  TO throughline_app;
GRANT EXECUTE ON FUNCTION work.canonical_domain(text) TO throughline_app;

DO $assertions$
DECLARE unsecured_count integer;
BEGIN
  SELECT count(*) INTO unsecured_count
  FROM pg_class relation_record
  JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
  WHERE namespace_record.nspname = 'work' AND relation_record.relkind = 'r'
    AND (NOT relation_record.relrowsecurity OR NOT relation_record.relforcerowsecurity);
  IF unsecured_count <> 0 THEN RAISE EXCEPTION 'every work table must have forced RLS'; END IF;
  IF has_table_privilege('throughline_relay', 'work.organizations', 'SELECT')
    OR has_table_privilege('throughline_worker', 'work.organizations', 'SELECT')
    OR has_table_privilege('throughline_product_relay', 'work.organizations', 'SELECT') THEN
    RAISE EXCEPTION 'non-application roles must not receive B1 work graph access';
  END IF;
END
$assertions$;
