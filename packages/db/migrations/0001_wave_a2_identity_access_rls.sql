CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS access;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'throughline_app') THEN
    CREATE ROLE throughline_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE throughline_app
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS identity.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
  default_access_class text NOT NULL CHECK (default_access_class IN ('public', 'workspace', 'restricted', 'confidential')),
  plan_code text NOT NULL DEFAULT 'dev',
  auth_provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS identity.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES identity.tenants(id),
  slug text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  profile_id text NOT NULL,
  profile_version text NOT NULL,
  default_space_id uuid,
  default_access_class text NOT NULL CHECK (default_access_class IN ('public', 'workspace', 'restricted', 'confidential')),
  model_policy_id text NOT NULL DEFAULT 'default',
  retention_policy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_provider text NOT NULL,
  auth_subject text NOT NULL,
  primary_email text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (auth_provider, auth_subject)
);

CREATE TABLE IF NOT EXISTS identity.people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  display_name text NOT NULL,
  primary_email text,
  title_fact_id uuid,
  employer_organization_id uuid,
  is_internal boolean NOT NULL DEFAULT false,
  external_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS identity.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  person_id uuid,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status text NOT NULL CHECK (status IN ('invited', 'active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (status <> 'active' OR person_id IS NOT NULL),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, person_id) REFERENCES identity.people(tenant_id, workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_workspace_user_active_unique
  ON identity.memberships (workspace_id, user_id)
  WHERE status IN ('invited', 'active');

CREATE TABLE IF NOT EXISTS identity.service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('worker', 'connector', 'system')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS identity.agent_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  runtime_policy_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS identity.policy_versions (
  id text NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS access.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  parent_space_id uuid,
  kind text NOT NULL CHECK (kind IN ('workspace_root', 'organization', 'initiative', 'project', 'knowledge')),
  name text NOT NULL,
  slug text NOT NULL,
  access_class text NOT NULL CHECK (access_class IN ('public', 'workspace', 'restricted', 'confidential')),
  inheritance_mode text NOT NULL CHECK (inheritance_mode IN ('inherit', 'restricted')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, parent_space_id) REFERENCES access.spaces(tenant_id, workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS spaces_workspace_root_unique
  ON access.spaces (workspace_id)
  WHERE kind = 'workspace_root' AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS spaces_root_slug_unique
  ON access.spaces (workspace_id, slug)
  WHERE parent_space_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS spaces_child_slug_unique
  ON access.spaces (workspace_id, parent_space_id, slug)
  WHERE parent_space_id IS NOT NULL;

ALTER TABLE identity.workspaces
  ADD CONSTRAINT workspaces_default_space_fk
  FOREIGN KEY (tenant_id, id, default_space_id) REFERENCES access.spaces(tenant_id, workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS access.access_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'membership', 'service_principal', 'agent_principal')),
  subject_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('owner', 'manager', 'contributor', 'viewer')),
  resource_type text NOT NULL CHECK (resource_type IN ('space')),
  resource_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('direct', 'inherited', 'system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES identity.workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id, resource_id) REFERENCES access.spaces(tenant_id, workspace_id, id)
);

CREATE INDEX IF NOT EXISTS access_relationships_resource_idx
  ON access.access_relationships (tenant_id, workspace_id, resource_type, resource_id);

CREATE INDEX IF NOT EXISTS access_relationships_subject_idx
  ON access.access_relationships (tenant_id, workspace_id, subject_type, subject_id);

CREATE OR REPLACE FUNCTION ops.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_membership_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.membership_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_service_principal_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.service_principal_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_agent_principal_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.agent_principal_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_policy_version()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.policy_version', true), '')
$$;

ALTER TABLE identity.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.users FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.people FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.service_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.service_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.agent_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.agent_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE access.spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.spaces FORCE ROW LEVEL SECURITY;
ALTER TABLE access.access_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.access_relationships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_current_tenant ON identity.tenants;
CREATE POLICY tenants_current_tenant
ON identity.tenants
USING (id = ops.current_tenant_id())
WITH CHECK (id = ops.current_tenant_id());

DROP POLICY IF EXISTS workspaces_current_workspace ON identity.workspaces;
CREATE POLICY workspaces_current_workspace
ON identity.workspaces
USING (tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id());

DROP POLICY IF EXISTS users_current_user_self_read ON identity.users;
CREATE POLICY users_current_user_self_read
ON identity.users
FOR SELECT
USING (id = ops.current_user_id());

DROP POLICY IF EXISTS people_current_workspace ON identity.people;
CREATE POLICY people_current_workspace
ON identity.people
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS memberships_current_workspace ON identity.memberships;
CREATE POLICY memberships_current_workspace
ON identity.memberships
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS service_principals_current_workspace ON identity.service_principals;
CREATE POLICY service_principals_current_workspace
ON identity.service_principals
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS agent_principals_current_workspace ON identity.agent_principals;
CREATE POLICY agent_principals_current_workspace
ON identity.agent_principals
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS policy_versions_current_workspace ON identity.policy_versions;
CREATE POLICY policy_versions_current_workspace
ON identity.policy_versions
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS spaces_current_workspace ON access.spaces;
CREATE POLICY spaces_current_workspace
ON access.spaces
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS access_relationships_current_workspace ON access.access_relationships;
CREATE POLICY access_relationships_current_workspace
ON access.access_relationships
USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

GRANT USAGE ON SCHEMA identity, access, ops TO throughline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO throughline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA access TO throughline_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ops TO throughline_app;
