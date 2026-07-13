DO $$
DECLARE
  granted_role text;
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['throughline_relay', 'throughline_worker']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      IF runtime_role = 'throughline_relay' THEN
        CREATE ROLE throughline_relay
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      ELSE
        CREATE ROLE throughline_worker
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      END IF;
    END IF;

    FOR granted_role IN
      SELECT granted.rolname
      FROM pg_auth_members AS membership
      JOIN pg_roles AS granted ON granted.oid = membership.roleid
      JOIN pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname = runtime_role
    LOOP
      EXECUTE format('REVOKE %I FROM %I', granted_role, runtime_role);
    END LOOP;
  END LOOP;

  ALTER ROLE throughline_relay
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  ALTER ROLE throughline_worker
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
END $$;

CREATE OR REPLACE FUNCTION ops.current_space_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.space_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_job_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.job_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_context_reference_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.context_reference_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_worker_principal_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.worker_principal_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_handler_key()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.handler_key', true), '')
$$;

CREATE OR REPLACE FUNCTION ops.current_aggregate_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.aggregate_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION ops.current_aggregate_version()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.aggregate_version', true), '')::integer
$$;

CREATE OR REPLACE FUNCTION ops.current_effect_hash()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.effect_hash', true), '')
$$;

CREATE UNIQUE INDEX IF NOT EXISTS memberships_scope_id_user_unique
  ON identity.memberships (tenant_id, workspace_id, id, user_id);

CREATE TABLE IF NOT EXISTS ops.security_context_references (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  worker_service_principal_id uuid NOT NULL,
  delegating_user_id uuid NOT NULL,
  delegating_membership_id uuid NOT NULL,
  policy_version_id text NOT NULL,
  context_snapshot jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  signing_key_id text NOT NULL CHECK (signing_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES identity.users(id),
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT security_context_references_scope_id_unique
    UNIQUE (tenant_id, workspace_id, space_id, id),
  CONSTRAINT security_context_references_scope_job_unique
    UNIQUE (tenant_id, workspace_id, space_id, job_id),
  CONSTRAINT security_context_references_outbox_binding_unique
    UNIQUE (id, job_id, tenant_id, workspace_id, space_id),
  CONSTRAINT security_context_references_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  CONSTRAINT security_context_references_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  CONSTRAINT security_context_references_worker_fk
    FOREIGN KEY (tenant_id, workspace_id, worker_service_principal_id)
    REFERENCES identity.service_principals(tenant_id, workspace_id, id),
  CONSTRAINT security_context_references_delegator_fk
    FOREIGN KEY (tenant_id, workspace_id, delegating_membership_id, delegating_user_id)
    REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id),
  CONSTRAINT security_context_references_policy_fk
    FOREIGN KEY (tenant_id, workspace_id, policy_version_id)
    REFERENCES identity.policy_versions(tenant_id, workspace_id, id),
  CONSTRAINT security_context_references_time_check CHECK (expires_at > issued_at),
  CONSTRAINT security_context_references_context_object_check
    CHECK (jsonb_typeof(context_snapshot) = 'object'),
  CONSTRAINT security_context_references_revocation_check CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS ops.foundation_test_aggregates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  proof_key text NOT NULL CHECK (length(proof_key) BETWEEN 1 AND 200),
  pending_job_id uuid,
  last_effect_job_id uuid,
  effect_count integer NOT NULL DEFAULT 0 CHECK (effect_count >= 0),
  aggregate_version integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT foundation_test_aggregates_scope_id_unique
    UNIQUE (tenant_id, workspace_id, space_id, id),
  CONSTRAINT foundation_test_aggregates_proof_key_unique
    UNIQUE (tenant_id, workspace_id, space_id, proof_key),
  CONSTRAINT foundation_test_aggregates_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  CONSTRAINT foundation_test_aggregates_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id)
);

CREATE TABLE IF NOT EXISTS ops.outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 200),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  aggregate_type text NOT NULL CHECK (aggregate_type = 'foundation_test_aggregate'),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  causation_id uuid NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  traceparent text NOT NULL CHECK (length(traceparent) BETWEEN 1 AND 200),
  tracestate text CHECK (tracestate IS NULL OR length(tracestate) BETWEEN 1 AND 512),
  job_id uuid NOT NULL,
  relay_service_principal_id uuid NOT NULL,
  context_reference_id uuid NOT NULL,
  signed_context_reference text NOT NULL CHECK (length(signed_context_reference) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  publication_attempts integer NOT NULL DEFAULT 0 CHECK (publication_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  claimed_by text,
  claim_token text CHECK (claim_token IS NULL OR claim_token ~ '^[A-Za-z0-9_-]{43}$'),
  claim_expires_at timestamptz,
  last_retry_code text,
  published_at timestamptz,
  published_message_id text,
  terminal_failed_at timestamptz,
  terminal_failure_code text,
  CONSTRAINT outbox_events_scope_id_unique
    UNIQUE (tenant_id, workspace_id, space_id, id),
  CONSTRAINT outbox_events_scope_job_unique
    UNIQUE (tenant_id, workspace_id, space_id, job_id),
  CONSTRAINT outbox_events_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  CONSTRAINT outbox_events_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  CONSTRAINT outbox_events_aggregate_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id, aggregate_id)
    REFERENCES ops.foundation_test_aggregates(tenant_id, workspace_id, space_id, id),
  CONSTRAINT outbox_events_relay_fk
    FOREIGN KEY (tenant_id, workspace_id, relay_service_principal_id)
    REFERENCES identity.service_principals(tenant_id, workspace_id, id),
  CONSTRAINT outbox_events_context_reference_fk
    FOREIGN KEY (context_reference_id, job_id, tenant_id, workspace_id, space_id)
    REFERENCES ops.security_context_references(id, job_id, tenant_id, workspace_id, space_id),
  CONSTRAINT outbox_events_claim_check CHECK (
    (claimed_at IS NULL AND claimed_by IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
    OR (
      claimed_at IS NOT NULL AND claimed_by IS NOT NULL AND claim_token IS NOT NULL
      AND claim_expires_at > claimed_at
    )
  ),
  CONSTRAINT outbox_events_publication_check CHECK (
    (published_at IS NULL AND published_message_id IS NULL)
    OR (published_at IS NOT NULL AND published_message_id IS NOT NULL)
  ),
  CONSTRAINT outbox_events_terminal_failure_check CHECK (
    (terminal_failed_at IS NULL AND terminal_failure_code IS NULL)
    OR (terminal_failed_at IS NOT NULL AND terminal_failure_code IS NOT NULL)
  ),
  CONSTRAINT outbox_events_single_terminal_state_check
    CHECK (published_at IS NULL OR terminal_failed_at IS NULL)
);

CREATE TABLE IF NOT EXISTS ops.idempotency_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL,
  job_id uuid NOT NULL,
  handler_key text NOT NULL CHECK (length(handler_key) BETWEEN 1 AND 200),
  context_reference_id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  effect_hash text NOT NULL CHECK (effect_hash ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT idempotency_records_scope_id_unique
    UNIQUE (tenant_id, workspace_id, space_id, id),
  CONSTRAINT idempotency_records_effect_unique
    UNIQUE (tenant_id, workspace_id, space_id, job_id, handler_key),
  CONSTRAINT idempotency_records_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES identity.workspaces(tenant_id, id),
  CONSTRAINT idempotency_records_space_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id)
    REFERENCES access.spaces(tenant_id, workspace_id, id),
  CONSTRAINT idempotency_records_context_reference_fk
    FOREIGN KEY (context_reference_id, job_id, tenant_id, workspace_id, space_id)
    REFERENCES ops.security_context_references(id, job_id, tenant_id, workspace_id, space_id),
  CONSTRAINT idempotency_records_aggregate_fk
    FOREIGN KEY (tenant_id, workspace_id, space_id, aggregate_id)
    REFERENCES ops.foundation_test_aggregates(tenant_id, workspace_id, space_id, id)
);

CREATE INDEX IF NOT EXISTS security_context_references_expiry_idx
  ON ops.security_context_references (tenant_id, workspace_id, space_id, expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS foundation_test_aggregates_pending_job_idx
  ON ops.foundation_test_aggregates (tenant_id, workspace_id, space_id, pending_job_id)
  WHERE pending_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbox_events_publishable_idx
  ON ops.outbox_events (next_attempt_at, created_at)
  WHERE published_at IS NULL AND terminal_failed_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_events_scope_created_idx
  ON ops.outbox_events (tenant_id, workspace_id, space_id, created_at);

CREATE INDEX IF NOT EXISTS idempotency_records_aggregate_idx
  ON ops.idempotency_records (tenant_id, workspace_id, space_id, aggregate_id, completed_at);

ALTER TABLE ops.foundation_test_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.foundation_test_aggregates FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.security_context_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.security_context_references FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.idempotency_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_current_tenant ON identity.tenants;
CREATE POLICY tenants_current_tenant ON identity.tenants
  TO throughline_app
  USING (id = ops.current_tenant_id())
  WITH CHECK (id = ops.current_tenant_id());

DROP POLICY IF EXISTS workspaces_current_workspace ON identity.workspaces;
CREATE POLICY workspaces_current_workspace ON identity.workspaces
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND id = ops.current_workspace_id());

DROP POLICY IF EXISTS users_current_user_self_read ON identity.users;
CREATE POLICY users_current_user_self_read ON identity.users
  FOR SELECT TO throughline_app
  USING (id = ops.current_user_id());

DROP POLICY IF EXISTS users_current_user_lock_only ON identity.users;
CREATE POLICY users_current_user_lock_only ON identity.users
  FOR UPDATE TO throughline_app
  USING (id = ops.current_user_id())
  WITH CHECK (false);

DROP POLICY IF EXISTS people_current_workspace ON identity.people;
CREATE POLICY people_current_workspace ON identity.people
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS memberships_current_workspace ON identity.memberships;
CREATE POLICY memberships_current_workspace ON identity.memberships
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS service_principals_current_workspace ON identity.service_principals;
CREATE POLICY service_principals_current_workspace ON identity.service_principals
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS agent_principals_current_workspace ON identity.agent_principals;
CREATE POLICY agent_principals_current_workspace ON identity.agent_principals
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS policy_versions_current_workspace ON identity.policy_versions;
CREATE POLICY policy_versions_current_workspace ON identity.policy_versions
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS spaces_current_workspace ON access.spaces;
CREATE POLICY spaces_current_workspace ON access.spaces
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS access_relationships_current_workspace ON access.access_relationships;
CREATE POLICY access_relationships_current_workspace ON access.access_relationships
  TO throughline_app
  USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id())
  WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id());

DROP POLICY IF EXISTS foundation_test_aggregates_app_scope ON ops.foundation_test_aggregates;
CREATE POLICY foundation_test_aggregates_app_scope ON ops.foundation_test_aggregates
  TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  )
  WITH CHECK (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  );

DROP POLICY IF EXISTS outbox_events_app_scope ON ops.outbox_events;
CREATE POLICY outbox_events_app_scope ON ops.outbox_events
  TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  )
  WITH CHECK (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  );

DROP POLICY IF EXISTS security_context_references_app_scope ON ops.security_context_references;
CREATE POLICY security_context_references_app_scope ON ops.security_context_references
  TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  )
  WITH CHECK (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  );

DROP POLICY IF EXISTS idempotency_records_app_scope ON ops.idempotency_records;
CREATE POLICY idempotency_records_app_scope ON ops.idempotency_records
  TO throughline_app
  USING (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  )
  WITH CHECK (
    tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
  );

DROP POLICY IF EXISTS tenants_relay_scope ON identity.tenants;
CREATE POLICY tenants_relay_scope ON identity.tenants
  FOR SELECT TO throughline_relay
  USING (current_user = 'throughline_relay' AND id = ops.current_tenant_id());

DROP POLICY IF EXISTS tenants_relay_lock_only ON identity.tenants;
CREATE POLICY tenants_relay_lock_only ON identity.tenants
  AS PERMISSIVE
  FOR UPDATE TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND id = ops.current_tenant_id()
    AND status = 'active'
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS tenants_relay_no_write ON identity.tenants;
CREATE POLICY tenants_relay_no_write ON identity.tenants
  AS RESTRICTIVE
  FOR UPDATE TO throughline_relay
  USING (true)
  WITH CHECK (false);

DROP POLICY IF EXISTS workspaces_relay_scope ON identity.workspaces;
CREATE POLICY workspaces_relay_scope ON identity.workspaces
  FOR SELECT TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND id = ops.current_workspace_id()
  );

DROP POLICY IF EXISTS workspaces_relay_lock_only ON identity.workspaces;
CREATE POLICY workspaces_relay_lock_only ON identity.workspaces
  AS PERMISSIVE
  FOR UPDATE TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND id = ops.current_workspace_id()
    AND status = 'active'
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS workspaces_relay_no_write ON identity.workspaces;
CREATE POLICY workspaces_relay_no_write ON identity.workspaces
  AS RESTRICTIVE
  FOR UPDATE TO throughline_relay
  USING (true)
  WITH CHECK (false);

DROP POLICY IF EXISTS service_principals_relay_scope ON identity.service_principals;
CREATE POLICY service_principals_relay_scope ON identity.service_principals
  FOR SELECT TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_service_principal_id()
  );

DROP POLICY IF EXISTS service_principals_relay_lock_only ON identity.service_principals;
CREATE POLICY service_principals_relay_lock_only ON identity.service_principals
  AS PERMISSIVE
  FOR UPDATE TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_service_principal_id()
    AND purpose = 'system'
    AND status = 'active'
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS service_principals_relay_no_write ON identity.service_principals;
CREATE POLICY service_principals_relay_no_write ON identity.service_principals
  AS RESTRICTIVE
  FOR UPDATE TO throughline_relay
  USING (true)
  WITH CHECK (false);

DROP POLICY IF EXISTS policy_versions_relay_scope ON identity.policy_versions;
CREATE POLICY policy_versions_relay_scope ON identity.policy_versions
  FOR SELECT TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_policy_version()
  );

DROP POLICY IF EXISTS policy_versions_relay_lock_only ON identity.policy_versions;
CREATE POLICY policy_versions_relay_lock_only ON identity.policy_versions
  AS PERMISSIVE
  FOR UPDATE TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_policy_version()
    AND status = 'active'
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS policy_versions_relay_no_write ON identity.policy_versions;
CREATE POLICY policy_versions_relay_no_write ON identity.policy_versions
  AS RESTRICTIVE
  FOR UPDATE TO throughline_relay
  USING (true)
  WITH CHECK (false);

DROP POLICY IF EXISTS spaces_relay_scope ON access.spaces;
CREATE POLICY spaces_relay_scope ON access.spaces
  FOR SELECT TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_space_id()
  );

DROP POLICY IF EXISTS spaces_relay_lock_only ON access.spaces;
CREATE POLICY spaces_relay_lock_only ON access.spaces
  AS PERMISSIVE
  FOR UPDATE TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_space_id()
    AND archived_at IS NULL
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS spaces_relay_no_write ON access.spaces;
CREATE POLICY spaces_relay_no_write ON access.spaces
  AS RESTRICTIVE
  FOR UPDATE TO throughline_relay
  USING (true)
  WITH CHECK (false);

DROP POLICY IF EXISTS access_relationships_relay_scope ON access.access_relationships;
CREATE POLICY access_relationships_relay_scope ON access.access_relationships
  FOR SELECT TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND resource_type = 'space'
    AND resource_id = ops.current_space_id()
    AND subject_type = 'service_principal'
    AND subject_id = ops.current_service_principal_id()
  );

DROP POLICY IF EXISTS access_relationships_relay_lock_only ON access.access_relationships;
CREATE POLICY access_relationships_relay_lock_only ON access.access_relationships
  AS PERMISSIVE
  FOR UPDATE TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND resource_type = 'space'
    AND resource_id = ops.current_space_id()
    AND subject_type = 'service_principal'
    AND subject_id = ops.current_service_principal_id()
    AND relation = 'manager'
    AND source = 'direct'
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS access_relationships_relay_no_write ON access.access_relationships;
CREATE POLICY access_relationships_relay_no_write ON access.access_relationships
  AS RESTRICTIVE
  FOR UPDATE TO throughline_relay
  USING (true)
  WITH CHECK (false);

DROP POLICY IF EXISTS outbox_events_relay_scope ON ops.outbox_events;
CREATE POLICY outbox_events_relay_scope ON ops.outbox_events
  TO throughline_relay
  USING (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND relay_service_principal_id = ops.current_service_principal_id()
  )
  WITH CHECK (
    current_user = 'throughline_relay'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND relay_service_principal_id = ops.current_service_principal_id()
  );

DROP POLICY IF EXISTS tenants_worker_scope ON identity.tenants;
CREATE POLICY tenants_worker_scope ON identity.tenants
  FOR SELECT TO throughline_worker
  USING (current_user = 'throughline_worker' AND id = ops.current_tenant_id());

DROP POLICY IF EXISTS tenants_worker_lock_only ON identity.tenants;
CREATE POLICY tenants_worker_lock_only ON identity.tenants
  FOR UPDATE TO throughline_worker
  USING (current_user = 'throughline_worker' AND id = ops.current_tenant_id())
  WITH CHECK (false);

DROP POLICY IF EXISTS workspaces_worker_scope ON identity.workspaces;
CREATE POLICY workspaces_worker_scope ON identity.workspaces
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND id = ops.current_workspace_id()
  );

DROP POLICY IF EXISTS workspaces_worker_lock_only ON identity.workspaces;
CREATE POLICY workspaces_worker_lock_only ON identity.workspaces
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND id = ops.current_workspace_id()
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS users_worker_scope ON identity.users;
CREATE POLICY users_worker_scope ON identity.users
  FOR SELECT TO throughline_worker
  USING (current_user = 'throughline_worker' AND id = ops.current_user_id());

DROP POLICY IF EXISTS users_worker_lock_only ON identity.users;
CREATE POLICY users_worker_lock_only ON identity.users
  FOR UPDATE TO throughline_worker
  USING (current_user = 'throughline_worker' AND id = ops.current_user_id())
  WITH CHECK (false);

DROP POLICY IF EXISTS memberships_worker_scope ON identity.memberships;
CREATE POLICY memberships_worker_scope ON identity.memberships
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_membership_id()
    AND user_id = ops.current_user_id()
  );

DROP POLICY IF EXISTS memberships_worker_lock_only ON identity.memberships;
CREATE POLICY memberships_worker_lock_only ON identity.memberships
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_membership_id()
    AND user_id = ops.current_user_id()
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS service_principals_worker_scope ON identity.service_principals;
CREATE POLICY service_principals_worker_scope ON identity.service_principals
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_worker_principal_id()
  );

DROP POLICY IF EXISTS service_principals_worker_lock_only ON identity.service_principals;
CREATE POLICY service_principals_worker_lock_only ON identity.service_principals
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_worker_principal_id()
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS policy_versions_worker_scope ON identity.policy_versions;
CREATE POLICY policy_versions_worker_scope ON identity.policy_versions
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_policy_version()
  );

DROP POLICY IF EXISTS policy_versions_worker_lock_only ON identity.policy_versions;
CREATE POLICY policy_versions_worker_lock_only ON identity.policy_versions
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_policy_version()
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS spaces_worker_scope ON access.spaces;
CREATE POLICY spaces_worker_scope ON access.spaces
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_space_id()
  );

DROP POLICY IF EXISTS spaces_worker_lock_only ON access.spaces;
CREATE POLICY spaces_worker_lock_only ON access.spaces
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND id = ops.current_space_id()
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS access_relationships_worker_scope ON access.access_relationships;
CREATE POLICY access_relationships_worker_scope ON access.access_relationships
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND resource_type = 'space'
    AND resource_id = ops.current_space_id()
    AND (
      (subject_type = 'service_principal' AND subject_id = ops.current_worker_principal_id())
      OR (subject_type = 'membership' AND subject_id = ops.current_membership_id())
      OR (subject_type = 'user' AND subject_id = ops.current_user_id())
    )
  );

DROP POLICY IF EXISTS access_relationships_worker_principal_lock_only ON access.access_relationships;
CREATE POLICY access_relationships_worker_principal_lock_only ON access.access_relationships
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND resource_type = 'space'
    AND resource_id = ops.current_space_id()
    AND relation = 'contributor'
    AND source = 'direct'
    AND subject_type = 'service_principal'
    AND subject_id = ops.current_worker_principal_id()
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS access_relationships_worker_delegator_lock_only ON access.access_relationships;
CREATE POLICY access_relationships_worker_delegator_lock_only ON access.access_relationships
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND resource_type = 'space'
    AND resource_id = ops.current_space_id()
    AND (relation = 'contributor' OR relation IN ('owner', 'manager', 'viewer'))
    AND source = 'direct'
    AND (
      (subject_type = 'membership' AND subject_id = ops.current_membership_id())
      OR (subject_type = 'user' AND subject_id = ops.current_user_id())
    )
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS security_context_references_worker_bootstrap ON ops.security_context_references;
CREATE POLICY security_context_references_worker_bootstrap ON ops.security_context_references
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND job_id = ops.current_job_id()
    AND id = ops.current_context_reference_id()
    AND worker_service_principal_id = ops.current_worker_principal_id()
    AND policy_version_id = ops.current_policy_version()
  );

DROP POLICY IF EXISTS security_context_references_worker_lock_only ON ops.security_context_references;
CREATE POLICY security_context_references_worker_lock_only ON ops.security_context_references
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND id = ops.current_context_reference_id()
    AND job_id = ops.current_job_id()
    AND worker_service_principal_id = ops.current_worker_principal_id()
    AND policy_version_id = ops.current_policy_version()
    AND delegating_user_id = ops.current_user_id()
    AND delegating_membership_id = ops.current_membership_id()
  )
  WITH CHECK (false);

DROP POLICY IF EXISTS foundation_test_aggregates_worker_scope ON ops.foundation_test_aggregates;
DROP POLICY IF EXISTS foundation_test_aggregates_worker_job_select ON ops.foundation_test_aggregates;
CREATE POLICY foundation_test_aggregates_worker_job_select ON ops.foundation_test_aggregates
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND (pending_job_id = ops.current_job_id() OR last_effect_job_id = ops.current_job_id())
  );

DROP POLICY IF EXISTS foundation_test_aggregates_worker_pending_update ON ops.foundation_test_aggregates;
CREATE POLICY foundation_test_aggregates_worker_pending_update ON ops.foundation_test_aggregates
  FOR UPDATE TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND pending_job_id = ops.current_job_id()
  )
  WITH CHECK (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND pending_job_id IS NULL
    AND last_effect_job_id = ops.current_job_id()
  );

DROP POLICY IF EXISTS idempotency_records_worker_scope ON ops.idempotency_records;
CREATE POLICY idempotency_records_worker_scope ON ops.idempotency_records
  FOR SELECT TO throughline_worker
  USING (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND job_id = ops.current_job_id()
    AND context_reference_id = ops.current_context_reference_id()
    AND handler_key = ops.current_handler_key()
    AND aggregate_id = ops.current_aggregate_id()
    AND aggregate_version = ops.current_aggregate_version()
    AND effect_hash = ops.current_effect_hash()
  );

DROP POLICY IF EXISTS idempotency_records_worker_insert ON ops.idempotency_records;
CREATE POLICY idempotency_records_worker_insert ON ops.idempotency_records
  FOR INSERT TO throughline_worker
  WITH CHECK (
    current_user = 'throughline_worker'
    AND tenant_id = ops.current_tenant_id()
    AND workspace_id = ops.current_workspace_id()
    AND space_id = ops.current_space_id()
    AND job_id = ops.current_job_id()
    AND context_reference_id = ops.current_context_reference_id()
    AND handler_key = ops.current_handler_key()
    AND aggregate_id = ops.current_aggregate_id()
    AND aggregate_version = ops.current_aggregate_version()
    AND effect_hash = ops.current_effect_hash()
  );

REVOKE ALL PRIVILEGES ON SCHEMA identity, access, ops FROM throughline_relay, throughline_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA identity FROM throughline_relay, throughline_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA access FROM throughline_relay, throughline_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ops FROM throughline_relay, throughline_worker;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ops FROM PUBLIC, throughline_relay, throughline_worker;

GRANT USAGE ON SCHEMA identity, access, ops TO throughline_relay, throughline_worker;

GRANT EXECUTE ON FUNCTION
  ops.current_tenant_id(),
  ops.current_workspace_id(),
  ops.current_space_id(),
  ops.current_service_principal_id(),
  ops.current_policy_version()
TO throughline_relay;

GRANT EXECUTE ON FUNCTION
  ops.current_tenant_id(),
  ops.current_workspace_id(),
  ops.current_space_id(),
  ops.current_user_id(),
  ops.current_membership_id(),
  ops.current_policy_version(),
  ops.current_job_id(),
  ops.current_context_reference_id(),
  ops.current_worker_principal_id(),
  ops.current_handler_key(),
  ops.current_aggregate_id(),
  ops.current_aggregate_version(),
  ops.current_effect_hash()
TO throughline_worker;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ops TO throughline_app;

GRANT SELECT (id, status) ON identity.tenants TO throughline_relay, throughline_worker;
GRANT SELECT (id, tenant_id, status) ON identity.workspaces TO throughline_relay, throughline_worker;
GRANT SELECT (id, tenant_id, workspace_id, status) ON identity.policy_versions
  TO throughline_relay, throughline_worker;
GRANT SELECT (id, tenant_id, workspace_id, purpose, status) ON identity.service_principals
  TO throughline_relay, throughline_worker;
GRANT SELECT (id, tenant_id, workspace_id, archived_at) ON access.spaces
  TO throughline_relay, throughline_worker;
GRANT SELECT (
  id, tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source
) ON access.access_relationships TO throughline_relay, throughline_worker;

GRANT SELECT (id, status) ON identity.users TO throughline_worker;
GRANT SELECT (id, tenant_id, workspace_id, user_id, role, status) ON identity.memberships
  TO throughline_worker;

GRANT UPDATE (id) ON identity.tenants TO throughline_relay, throughline_worker;
GRANT UPDATE (id) ON identity.workspaces TO throughline_relay, throughline_worker;
GRANT UPDATE (id) ON identity.users TO throughline_worker;
GRANT UPDATE (id) ON identity.memberships TO throughline_worker;
GRANT UPDATE (id) ON identity.policy_versions TO throughline_relay, throughline_worker;
GRANT UPDATE (id) ON identity.service_principals TO throughline_relay, throughline_worker;
GRANT UPDATE (id) ON access.spaces TO throughline_relay, throughline_worker;
GRANT UPDATE (id) ON access.access_relationships TO throughline_relay, throughline_worker;

GRANT SELECT (
  id, event_type, tenant_id, workspace_id, space_id, aggregate_type, aggregate_id,
  aggregate_version, causation_id, request_id, traceparent, tracestate, job_id,
  relay_service_principal_id, context_reference_id, signed_context_reference, created_at,
  publication_attempts, next_attempt_at, claimed_at, claimed_by, claim_token, claim_expires_at,
  last_retry_code, published_at, published_message_id, terminal_failed_at, terminal_failure_code
) ON ops.outbox_events TO throughline_relay;

GRANT UPDATE (
  publication_attempts, next_attempt_at, claimed_at, claimed_by, claim_token, claim_expires_at,
  last_retry_code, published_at, published_message_id, terminal_failed_at, terminal_failure_code
) ON ops.outbox_events TO throughline_relay;

GRANT SELECT ON ops.security_context_references TO throughline_worker;
GRANT UPDATE (id) ON ops.security_context_references TO throughline_worker;
GRANT SELECT (
  id, tenant_id, workspace_id, space_id, proof_key, pending_job_id, last_effect_job_id,
  effect_count, aggregate_version, created_at, updated_at
) ON ops.foundation_test_aggregates TO throughline_worker;
GRANT UPDATE (pending_job_id, last_effect_job_id, effect_count, aggregate_version, updated_at)
  ON ops.foundation_test_aggregates TO throughline_worker;
GRANT SELECT, INSERT ON ops.idempotency_records TO throughline_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  ops.security_context_references,
  ops.foundation_test_aggregates,
  ops.outbox_events,
  ops.idempotency_records
TO throughline_app;
