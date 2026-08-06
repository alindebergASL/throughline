// Encoded from the authorized PostgreSQL phase snapshot
// SHA-256 93eb0616fc26877250121f47f6545a4d55361b797e78886a9e4173d7ec3d95cb.
// Cross-checked against final catalog snapshot
// SHA-256 d813c15e491711a0536da5fb1b9b2cef47d1104fb7115fb9db7fbfb1684b37fb.
export type ExactTruthRelation = {
  name: string;
  kind: string;
  persistence: string;
  rls: boolean;
  forced_rls: boolean;
  owner: string;
};

export type ExactTruthPolicy = {
  table_name: string;
  policy_name: string;
  operation: string;
  permissive: boolean;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
};

export type ExactTruthConstraint = {
  table_name: string;
  name: string;
  type: string;
  definition: string;
  deferrable: boolean;
  initially_deferred: boolean;
  validated: boolean;
};

export type ExactTruthIndex = {
  table_name: string;
  index_name: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  ready: boolean;
  live: boolean;
  definition: string;
};

export type ExactTruthCatalog = {
  relations: ExactTruthRelation[];
  policies: ExactTruthPolicy[];
  constraints: ExactTruthConstraint[];
  indexes: ExactTruthIndex[];
};

const phase1: ExactTruthCatalog = {
  relations: [
    {
      name: "accepted_facts",
      kind: "r",
      persistence: "p",
      rls: true,
      forced_rls: true,
      owner: "migration_owner"
    },
    {
      name: "claims",
      kind: "r",
      persistence: "p",
      rls: true,
      forced_rls: true,
      owner: "migration_owner"
    },
    {
      name: "fact_claims",
      kind: "r",
      persistence: "p",
      rls: true,
      forced_rls: true,
      owner: "migration_owner"
    },
    {
      name: "verified_evidence_spans",
      kind: "r",
      persistence: "p",
      rls: true,
      forced_rls: true,
      owner: "migration_owner"
    }
  ],
  policies: [
    {
      table_name: "accepted_facts",
      policy_name: "accepted_facts_insert",
      operation: "a",
      permissive: true,
      roles: ["throughline_app"],
      using_expression: null,
      check_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class) AND (accepted_by_user_id = ops.current_user_id()) AND (accepted_by_membership_id = ops.current_membership_id()) AND (acceptance_policy_version = ops.current_policy_version()))"
    },
    {
      table_name: "accepted_facts",
      policy_name: "accepted_facts_select",
      operation: "r",
      permissive: true,
      roles: ["throughline_app"],
      using_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, access_class))",
      check_expression: null
    },
    {
      table_name: "claims",
      policy_name: "claims_insert",
      operation: "a",
      permissive: true,
      roles: ["throughline_app"],
      using_expression: null,
      check_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class) AND (created_by_user_id = ops.current_user_id()) AND (created_by_membership_id = ops.current_membership_id()))"
    },
    {
      table_name: "claims",
      policy_name: "claims_select",
      operation: "r",
      permissive: true,
      roles: ["throughline_app"],
      using_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, access_class))",
      check_expression: null
    },
    {
      table_name: "claims",
      policy_name: "claims_update",
      operation: "w",
      permissive: true,
      roles: ["throughline_app"],
      using_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class))",
      check_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class))"
    },
    {
      table_name: "fact_claims",
      policy_name: "fact_claims_insert",
      operation: "a",
      permissive: true,
      roles: ["throughline_app"],
      using_expression: null,
      check_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, ( SELECT fact.access_class\n   FROM truth.accepted_facts fact\n  WHERE ((fact.tenant_id = fact_claims.tenant_id) AND (fact.workspace_id = fact_claims.workspace_id) AND (fact.id = fact_claims.fact_id)))))"
    },
    {
      table_name: "fact_claims",
      policy_name: "fact_claims_select",
      operation: "r",
      permissive: true,
      roles: ["throughline_app"],
      using_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, ( SELECT fact.access_class\n   FROM truth.accepted_facts fact\n  WHERE ((fact.tenant_id = fact_claims.tenant_id) AND (fact.workspace_id = fact_claims.workspace_id) AND (fact.id = fact_claims.fact_id)))))",
      check_expression: null
    },
    {
      table_name: "verified_evidence_spans",
      policy_name: "verified_evidence_insert",
      operation: "a",
      permissive: true,
      roles: ["throughline_app"],
      using_expression: null,
      check_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class) AND (created_by_user_id = ops.current_user_id()) AND (created_by_membership_id = ops.current_membership_id()))"
    },
    {
      table_name: "verified_evidence_spans",
      policy_name: "verified_evidence_select",
      operation: "r",
      permissive: true,
      roles: ["throughline_app"],
      using_expression:
        "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, access_class))",
      check_expression: null
    }
  ],
  constraints: [
    {
      table_name: "accepted_facts",
      name: "accepted_facts_accepted_by_user_id_fkey",
      type: "f",
      definition: "FOREIGN KEY (accepted_by_user_id) REFERENCES identity.users(id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_access_class_check",
      type: "c",
      definition:
        "CHECK ((access_class = ANY (ARRAY['public'::text, 'workspace'::text, 'restricted'::text, 'confidential'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_check",
      type: "c",
      definition:
        "CHECK ((((subject_type = 'activity'::text) AND (predicate = 'activity.outcome'::text)) OR ((subject_type = 'initiative'::text) AND (predicate = 'initiative.primary_objective'::text))))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_check1",
      type: "c",
      definition:
        "CHECK ((((subject_type = 'activity'::text) AND (acceptance_scope = 'engagement'::text)) OR ((subject_type = 'initiative'::text) AND (acceptance_scope = 'initiative'::text))))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_check2",
      type: "c",
      definition:
        "CHECK ((((subject_type = 'activity'::text) AND (authority_basis = 'activity_owner'::text)) OR ((subject_type = 'initiative'::text) AND (authority_basis = 'initiative_owner'::text))))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_check3",
      type: "c",
      definition:
        "CHECK ((((value_json #>> '{}'::text[]) = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000))))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_check4",
      type: "c",
      definition:
        "CHECK (((human_lowered AND (confidence_lowering_reason_code = ANY (ARRAY['conservative_human_judgment'::text, 'evidence_quality'::text, 'residual_uncertainty'::text])) AND (confidence_lowering_rationale IS NOT NULL) AND (confidence_lowering_rationale = NORMALIZE(confidence_lowering_rationale, NFC)) AND (confidence_lowering_rationale = btrim(confidence_lowering_rationale)) AND ((length(confidence_lowering_rationale) >= 1) AND (length(confidence_lowering_rationale) <= 2000))) OR ((NOT human_lowered) AND (confidence_lowering_reason_code IS NULL) AND (confidence_lowering_rationale IS NULL))))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_check5",
      type: "c",
      definition:
        "CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from)))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_confidence_check",
      type: "c",
      definition:
        "CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'strong'::text, 'weak'::text, 'unknown'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_confidence_rule_check",
      type: "c",
      definition: "CHECK ((confidence_rule = 'strongest-selected-valid-claim.v1'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_id_check",
      type: "c",
      definition: "CHECK (ops.is_uuid_v7(id))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_pkey",
      type: "p",
      definition: "PRIMARY KEY (id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_predicate_catalog_version_check",
      type: "c",
      definition: "CHECK ((predicate_catalog_version = 'truth-predicate-catalog.v1'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_status_check",
      type: "c",
      definition: "CHECK ((status = 'current'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_strongest_supporting_confidence_check",
      type: "c",
      definition:
        "CHECK ((strongest_supporting_confidence = ANY (ARRAY['confirmed'::text, 'strong'::text, 'weak'::text, 'unknown'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_subject_type_check",
      type: "c",
      definition: "CHECK ((subject_type = ANY (ARRAY['activity'::text, 'initiative'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_support_deferred",
      type: "t",
      definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
      deferrable: true,
      initially_deferred: true,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_tenant_id_workspace_id_acceptance_policy_ve_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, acceptance_policy_version) REFERENCES identity.policy_versions(tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_tenant_id_workspace_id_accepted_by_membersh_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, accepted_by_membership_id, accepted_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_tenant_id_workspace_id_id_key",
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_tenant_id_workspace_id_last_causation_comma_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, last_causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_tenant_id_workspace_id_space_id_id_key",
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, space_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_value_hash_check",
      type: "c",
      definition: "CHECK ((value_hash ~ '^[a-f0-9]{64}$'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_value_json_check",
      type: "c",
      definition: "CHECK ((jsonb_typeof(value_json) = 'string'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "accepted_facts",
      name: "accepted_facts_version_check",
      type: "c",
      definition: "CHECK ((version = 1))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_access_class_check",
      type: "c",
      definition:
        "CHECK ((access_class = ANY (ARRAY['public'::text, 'workspace'::text, 'restricted'::text, 'confidential'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_asserted_by_type_check",
      type: "c",
      definition: "CHECK ((asserted_by_type = 'person'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_check",
      type: "c",
      definition:
        "CHECK ((((subject_type = 'activity'::text) AND (predicate = 'activity.outcome'::text)) OR ((subject_type = 'initiative'::text) AND (predicate = 'initiative.primary_objective'::text))))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_check1",
      type: "c",
      definition:
        "CHECK ((((value_json #>> '{}'::text[]) = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000)) AND (((status = 'proposed'::text) AND (version = 1)) OR ((status = 'accepted'::text) AND (version = 2)))))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_check2",
      type: "c",
      definition:
        "CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from)))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_confidence_check",
      type: "c",
      definition:
        "CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'strong'::text, 'weak'::text, 'unknown'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_created_by_user_id_fkey",
      type: "f",
      definition: "FOREIGN KEY (created_by_user_id) REFERENCES identity.users(id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_id_check",
      type: "c",
      definition: "CHECK (ops.is_uuid_v7(id))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_pkey",
      type: "p",
      definition: "PRIMARY KEY (id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_predicate_catalog_version_check",
      type: "c",
      definition: "CHECK ((predicate_catalog_version = 'truth-predicate-catalog.v1'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_status_check",
      type: "c",
      definition: "CHECK ((status = ANY (ARRAY['proposed'::text, 'accepted'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_subject_type_check",
      type: "c",
      definition: "CHECK ((subject_type = ANY (ARRAY['activity'::text, 'initiative'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_tenant_id_workspace_id_asserted_by_id_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, asserted_by_id) REFERENCES identity.people(tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_tenant_id_workspace_id_causation_command_id_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_tenant_id_workspace_id_created_by_membership_id_cre_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, created_by_membership_id, created_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_tenant_id_workspace_id_id_key",
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_tenant_id_workspace_id_space_id_id_key",
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, space_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_tenant_id_workspace_id_space_id_verified_evidence_s_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, verified_evidence_span_id) REFERENCES truth.verified_evidence_spans(tenant_id, workspace_id, space_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_value_hash_check",
      type: "c",
      definition: "CHECK ((value_hash ~ '^[a-f0-9]{64}$'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "claims",
      name: "claims_value_json_check",
      type: "c",
      definition: "CHECK ((jsonb_typeof(value_json) = 'string'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "fact_claims",
      name: "fact_claims_pkey",
      type: "p",
      definition: "PRIMARY KEY (tenant_id, workspace_id, fact_id, claim_id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "fact_claims",
      name: "fact_claims_support_deferred",
      type: "t",
      definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
      deferrable: true,
      initially_deferred: true,
      validated: true
    },
    {
      table_name: "fact_claims",
      name: "fact_claims_tenant_id_workspace_id_space_id_claim_id_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, claim_id) REFERENCES truth.claims(tenant_id, workspace_id, space_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "fact_claims",
      name: "fact_claims_tenant_id_workspace_id_space_id_fact_id_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, fact_id) REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_access_class_check",
      type: "c",
      definition:
        "CHECK ((access_class = ANY (ARRAY['public'::text, 'workspace'::text, 'restricted'::text, 'confidential'::text])))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_check",
      type: "c",
      definition: "CHECK ((source_end_offset > source_start_offset))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_chunk_content_hash_check",
      type: "c",
      definition: "CHECK ((chunk_content_hash ~ '^[a-f0-9]{64}$'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_chunk_version_check",
      type: "c",
      definition: "CHECK ((chunk_version = 1))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_chunking_version_check",
      type: "c",
      definition: "CHECK ((chunking_version = 'source-chunking.v1'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_created_by_user_id_fkey",
      type: "f",
      definition: "FOREIGN KEY (created_by_user_id) REFERENCES identity.users(id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_excerpt_hash_check",
      type: "c",
      definition: "CHECK ((excerpt_hash ~ '^[a-f0-9]{64}$'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_id_check",
      type: "c",
      definition: "CHECK (ops.is_uuid_v7(id))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_normalization_version_check",
      type: "c",
      definition: "CHECK ((normalization_version = 'source-normalization.v1'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_pkey",
      type: "p",
      definition: "PRIMARY KEY (id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_source_content_hash_check",
      type: "c",
      definition: "CHECK ((source_content_hash ~ '^[a-f0-9]{64}$'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_source_excerpt_check",
      type: "c",
      definition: "CHECK ((length(source_excerpt) > 0))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_source_normalized_content_hash_check",
      type: "c",
      definition: "CHECK ((source_normalized_content_hash ~ '^[a-f0-9]{64}$'::text))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_source_start_offset_check",
      type: "c",
      definition: "CHECK ((source_start_offset >= 0))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_source_version_check",
      type: "c",
      definition: "CHECK ((source_version > 0))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_tenant_id_workspace_id_causation_c_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_tenant_id_workspace_id_created_by__fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, created_by_membership_id, created_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_tenant_id_workspace_id_id_key",
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_tenant_id_workspace_id_space_id_id_key",
      type: "u",
      definition: "UNIQUE (tenant_id, workspace_id, space_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_tenant_id_workspace_id_space_id_so_fkey",
      type: "f",
      definition:
        "FOREIGN KEY (tenant_id, workspace_id, space_id, source_artifact_id) REFERENCES content.source_artifacts(tenant_id, workspace_id, space_id, id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      table_name: "verified_evidence_spans",
      name: "verified_evidence_spans_version_check",
      type: "c",
      definition: "CHECK ((version = 1))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    }
  ],
  indexes: [
    {
      table_name: "accepted_facts",
      index_name: "accepted_facts_one_current_slot",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX accepted_facts_one_current_slot ON truth.accepted_facts USING btree (tenant_id, workspace_id, space_id, subject_type, subject_id, predicate) WHERE (status = 'current'::text)"
    },
    {
      table_name: "accepted_facts",
      index_name: "accepted_facts_pkey",
      unique: true,
      primary: true,
      valid: true,
      ready: true,
      live: true,
      definition: "CREATE UNIQUE INDEX accepted_facts_pkey ON truth.accepted_facts USING btree (id)"
    },
    {
      table_name: "accepted_facts",
      index_name: "accepted_facts_tenant_id_workspace_id_id_key",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX accepted_facts_tenant_id_workspace_id_id_key ON truth.accepted_facts USING btree (tenant_id, workspace_id, id)"
    },
    {
      table_name: "accepted_facts",
      index_name: "accepted_facts_tenant_id_workspace_id_space_id_id_key",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX accepted_facts_tenant_id_workspace_id_space_id_id_key ON truth.accepted_facts USING btree (tenant_id, workspace_id, space_id, id)"
    },
    {
      table_name: "claims",
      index_name: "claims_pkey",
      unique: true,
      primary: true,
      valid: true,
      ready: true,
      live: true,
      definition: "CREATE UNIQUE INDEX claims_pkey ON truth.claims USING btree (id)"
    },
    {
      table_name: "claims",
      index_name: "claims_subject_predicate_idx",
      unique: false,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE INDEX claims_subject_predicate_idx ON truth.claims USING btree (tenant_id, workspace_id, space_id, subject_type, subject_id, predicate, created_at)"
    },
    {
      table_name: "claims",
      index_name: "claims_tenant_id_workspace_id_id_key",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX claims_tenant_id_workspace_id_id_key ON truth.claims USING btree (tenant_id, workspace_id, id)"
    },
    {
      table_name: "claims",
      index_name: "claims_tenant_id_workspace_id_space_id_id_key",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX claims_tenant_id_workspace_id_space_id_id_key ON truth.claims USING btree (tenant_id, workspace_id, space_id, id)"
    },
    {
      table_name: "fact_claims",
      index_name: "fact_claims_pkey",
      unique: true,
      primary: true,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX fact_claims_pkey ON truth.fact_claims USING btree (tenant_id, workspace_id, fact_id, claim_id)"
    },
    {
      table_name: "verified_evidence_spans",
      index_name: "evidence_spans_source_idx",
      unique: false,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE INDEX evidence_spans_source_idx ON truth.verified_evidence_spans USING btree (tenant_id, workspace_id, source_artifact_id, created_at)"
    },
    {
      table_name: "verified_evidence_spans",
      index_name: "verified_evidence_spans_pkey",
      unique: true,
      primary: true,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX verified_evidence_spans_pkey ON truth.verified_evidence_spans USING btree (id)"
    },
    {
      table_name: "verified_evidence_spans",
      index_name: "verified_evidence_spans_tenant_id_workspace_id_id_key",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX verified_evidence_spans_tenant_id_workspace_id_id_key ON truth.verified_evidence_spans USING btree (tenant_id, workspace_id, id)"
    },
    {
      table_name: "verified_evidence_spans",
      index_name: "verified_evidence_spans_tenant_id_workspace_id_space_id_id_key",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      live: true,
      definition:
        "CREATE UNIQUE INDEX verified_evidence_spans_tenant_id_workspace_id_space_id_id_key ON truth.verified_evidence_spans USING btree (tenant_id, workspace_id, space_id, id)"
    }
  ]
};
const phase2PolicyAdditions: ExactTruthPolicy[] = [
  {
    table_name: "accepted_facts",
    policy_name: "accepted_facts_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  },
  {
    table_name: "claims",
    policy_name: "claims_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  },
  {
    table_name: "fact_claims",
    policy_name: "fact_claims_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  },
  {
    table_name: "verified_evidence_spans",
    policy_name: "verified_evidence_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  }
];
const phase3ConstraintAdditions: ExactTruthConstraint[] = [
  {
    table_name: "accepted_facts",
    name: "accepted_facts_canonical_value_text_valid",
    type: "c",
    definition:
      "CHECK (((canonical_value_text = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "claims",
    name: "claims_canonical_value_text_valid",
    type: "c",
    definition:
      "CHECK (((canonical_value_text = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000)) AND (((status = 'proposed'::text) AND (version = 1)) OR ((status = 'accepted'::text) AND (version = 2)))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  }
];
const phase3ConstraintRemovals: ExactTruthConstraint[] = [
  {
    table_name: "accepted_facts",
    name: "accepted_facts_check3",
    type: "c",
    definition:
      "CHECK ((((value_json #>> '{}'::text[]) = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "accepted_facts",
    name: "accepted_facts_value_json_check",
    type: "c",
    definition: "CHECK ((jsonb_typeof(value_json) = 'string'::text))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "claims",
    name: "claims_check1",
    type: "c",
    definition:
      "CHECK ((((value_json #>> '{}'::text[]) = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000)) AND (((status = 'proposed'::text) AND (version = 1)) OR ((status = 'accepted'::text) AND (version = 2)))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "claims",
    name: "claims_value_json_check",
    type: "c",
    definition: "CHECK ((jsonb_typeof(value_json) = 'string'::text))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  }
];
const phase5RelationAdditions: ExactTruthRelation[] = [
  {
    name: "initiative_objective_proposal_recoveries",
    kind: "r",
    persistence: "p",
    rls: true,
    forced_rls: true,
    owner: "migration_owner"
  },
  {
    name: "initiative_objective_support_attestations",
    kind: "r",
    persistence: "p",
    rls: true,
    forced_rls: true,
    owner: "migration_owner"
  }
];
const phase5PolicyAdditions: ExactTruthPolicy[] = [
  {
    table_name: "initiative_objective_proposal_recoveries",
    policy_name: "objective_recovery_insert",
    operation: "a",
    permissive: true,
    roles: ["throughline_app"],
    using_expression: null,
    check_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (acted_by_user_id = ops.current_user_id()) AND (acted_by_membership_id = ops.current_membership_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class\n   FROM truth.claims claim\n  WHERE ((claim.tenant_id = initiative_objective_proposal_recoveries.tenant_id) AND (claim.workspace_id = initiative_objective_proposal_recoveries.workspace_id) AND (claim.id = initiative_objective_proposal_recoveries.predecessor_claim_id)))))"
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    policy_name: "objective_recovery_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    policy_name: "objective_recovery_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_app"],
    using_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class\n   FROM truth.claims claim\n  WHERE ((claim.tenant_id = initiative_objective_proposal_recoveries.tenant_id) AND (claim.workspace_id = initiative_objective_proposal_recoveries.workspace_id) AND (claim.id = initiative_objective_proposal_recoveries.predecessor_claim_id)))))",
    check_expression: null
  },
  {
    table_name: "initiative_objective_support_attestations",
    policy_name: "objective_support_insert",
    operation: "a",
    permissive: true,
    roles: ["throughline_app"],
    using_expression: null,
    check_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (confirmed_by_user_id = ops.current_user_id()) AND (confirmed_by_membership_id = ops.current_membership_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class\n   FROM truth.claims claim\n  WHERE ((claim.tenant_id = initiative_objective_support_attestations.tenant_id) AND (claim.workspace_id = initiative_objective_support_attestations.workspace_id) AND (claim.id = initiative_objective_support_attestations.claim_id)))))"
  },
  {
    table_name: "initiative_objective_support_attestations",
    policy_name: "objective_support_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  },
  {
    table_name: "initiative_objective_support_attestations",
    policy_name: "objective_support_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_app"],
    using_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND access.can_read_space(space_id, ( SELECT claim.access_class\n   FROM truth.claims claim\n  WHERE ((claim.tenant_id = initiative_objective_support_attestations.tenant_id) AND (claim.workspace_id = initiative_objective_support_attestations.workspace_id) AND (claim.id = initiative_objective_support_attestations.claim_id)))))",
    check_expression: null
  }
];
const phase5ConstraintAdditions: ExactTruthConstraint[] = [
  {
    table_name: "claims",
    name: "claims_canonical_value_text_valid",
    type: "c",
    definition:
      "CHECK (((canonical_value_text = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000)) AND (((status = 'proposed'::text) AND (version = 1)) OR ((status = ANY (ARRAY['accepted'::text, 'rejected'::text, 'superseded'::text])) AND (version = 2)))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "claims",
    name: "claims_objective_recovery_deferred",
    type: "t",
    definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "claims",
    name: "claims_objective_support_deferred",
    type: "t",
    definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "claims",
    name: "claims_status_check",
    type: "c",
    definition:
      "CHECK ((status = ANY (ARRAY['proposed'::text, 'accepted'::text, 'rejected'::text, 'superseded'::text])))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposa_tenant_id_workspace_id_space_fkey1",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_claim_id) REFERENCES truth.claims(tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposa_tenant_id_workspace_id_space_fkey2",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, successor_claim_id) REFERENCES truth.claims(tenant_id, workspace_id, space_id, id) DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_rec_tenant_id_workspace_id_id_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_recoveries_check",
    type: "c",
    definition:
      "CHECK ((((disposition = 'reworked'::text) AND (reason_code = 'reworked'::text) AND (successor_claim_id IS NOT NULL)) OR ((disposition = ANY (ARRAY['withdrawn'::text, 'rejected'::text])) AND (reason_code <> 'reworked'::text) AND (successor_claim_id IS NULL))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_recoveries_disposition_check",
    type: "c",
    definition:
      "CHECK ((disposition = ANY (ARRAY['withdrawn'::text, 'rejected'::text, 'reworked'::text])))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_recoveries_id_check",
    type: "c",
    definition: "CHECK (ops.is_uuid_v7(id))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_recoveries_pkey",
    type: "p",
    definition: "PRIMARY KEY (id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_recoveries_reason_code_check",
    type: "c",
    definition:
      "CHECK ((reason_code = ANY (ARRAY['needs_rework'::text, 'unsupported'::text, 'incorrect'::text, 'duplicate'::text, 'not_useful'::text, 'sensitive'::text, 'other'::text, 'reworked'::text])))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_recoveries_version_check",
    type: "c",
    definition: "CHECK ((version = 1))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_tenant_id_workspace_id_acted_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, acted_by_membership_id, acted_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_tenant_id_workspace_id_causa_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_tenant_id_workspace_id_causat_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, causation_command_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_tenant_id_workspace_id_predec_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, predecessor_claim_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_tenant_id_workspace_id_space__key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "initiative_objective_proposal_tenant_id_workspace_id_space_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id) REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    name: "objective_recovery_valid_deferred",
    type: "t",
    definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "attestations_objective_support_deferred",
    type: "t",
    definition: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    deferrable: true,
    initially_deferred: true,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support__tenant_id_workspace_id_causa_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support__tenant_id_workspace_id_claim__key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, claim_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support__tenant_id_workspace_id_confi_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, confirmed_by_membership_id, confirmed_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support__tenant_id_workspace_id_space__key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support__tenant_id_workspace_id_space_fkey",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, initiative_id) REFERENCES work.initiatives(tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_atte_tenant_id_workspace_id_id_key",
    type: "u",
    definition: "UNIQUE (tenant_id, workspace_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_attesta_objective_value_hash_check",
    type: "c",
    definition: "CHECK ((objective_value_hash ~ '^[a-f0-9]{64}$'::text))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_attestations_excerpt_hash_check",
    type: "c",
    definition: "CHECK ((excerpt_hash ~ '^[a-f0-9]{64}$'::text))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_attestations_id_check",
    type: "c",
    definition: "CHECK (ops.is_uuid_v7(id))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_attestations_pkey",
    type: "p",
    definition: "PRIMARY KEY (id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_attestations_version_check",
    type: "c",
    definition: "CHECK ((version = 1))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_tenant_id_workspace_id_space_fkey1",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, claim_id) REFERENCES truth.claims(tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "initiative_objective_support_attestations",
    name: "initiative_objective_support_tenant_id_workspace_id_space_fkey2",
    type: "f",
    definition:
      "FOREIGN KEY (tenant_id, workspace_id, space_id, verified_evidence_span_id) REFERENCES truth.verified_evidence_spans(tenant_id, workspace_id, space_id, id)",
    deferrable: false,
    initially_deferred: false,
    validated: true
  }
];
const phase5ConstraintRemovals: ExactTruthConstraint[] = [
  {
    table_name: "claims",
    name: "claims_canonical_value_text_valid",
    type: "c",
    definition:
      "CHECK (((canonical_value_text = normalized_text) AND (normalized_text = NORMALIZE(normalized_text, NFC)) AND ((length(btrim(normalized_text)) >= 1) AND (length(btrim(normalized_text)) <= 2000)) AND (((status = 'proposed'::text) AND (version = 1)) OR ((status = 'accepted'::text) AND (version = 2)))))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "claims",
    name: "claims_status_check",
    type: "c",
    definition: "CHECK ((status = ANY (ARRAY['proposed'::text, 'accepted'::text])))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  }
];
const phase5IndexAdditions: ExactTruthIndex[] = [
  {
    table_name: "claims",
    index_name: "claims_one_active_primary_objective_proposal",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX claims_one_active_primary_objective_proposal ON truth.claims USING btree (tenant_id, workspace_id, space_id, subject_type, subject_id, predicate) WHERE ((subject_type = 'initiative'::text) AND (predicate = 'initiative.primary_objective'::text) AND (status = 'proposed'::text))"
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    index_name: "initiative_objective_proposal_rec_tenant_id_workspace_id_id_key",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_proposal_rec_tenant_id_workspace_id_id_key ON truth.initiative_objective_proposal_recoveries USING btree (tenant_id, workspace_id, id)"
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    index_name: "initiative_objective_proposal_recoveries_pkey",
    unique: true,
    primary: true,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_proposal_recoveries_pkey ON truth.initiative_objective_proposal_recoveries USING btree (id)"
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    index_name: "initiative_objective_proposal_tenant_id_workspace_id_causat_key",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_proposal_tenant_id_workspace_id_causat_key ON truth.initiative_objective_proposal_recoveries USING btree (tenant_id, workspace_id, causation_command_id)"
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    index_name: "initiative_objective_proposal_tenant_id_workspace_id_predec_key",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_proposal_tenant_id_workspace_id_predec_key ON truth.initiative_objective_proposal_recoveries USING btree (tenant_id, workspace_id, predecessor_claim_id)"
  },
  {
    table_name: "initiative_objective_proposal_recoveries",
    index_name: "initiative_objective_proposal_tenant_id_workspace_id_space__key",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_proposal_tenant_id_workspace_id_space__key ON truth.initiative_objective_proposal_recoveries USING btree (tenant_id, workspace_id, space_id, id)"
  },
  {
    table_name: "initiative_objective_support_attestations",
    index_name: "initiative_objective_support__tenant_id_workspace_id_claim__key",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_support__tenant_id_workspace_id_claim__key ON truth.initiative_objective_support_attestations USING btree (tenant_id, workspace_id, claim_id)"
  },
  {
    table_name: "initiative_objective_support_attestations",
    index_name: "initiative_objective_support__tenant_id_workspace_id_space__key",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_support__tenant_id_workspace_id_space__key ON truth.initiative_objective_support_attestations USING btree (tenant_id, workspace_id, space_id, id)"
  },
  {
    table_name: "initiative_objective_support_attestations",
    index_name: "initiative_objective_support_atte_tenant_id_workspace_id_id_key",
    unique: true,
    primary: false,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_support_atte_tenant_id_workspace_id_id_key ON truth.initiative_objective_support_attestations USING btree (tenant_id, workspace_id, id)"
  },
  {
    table_name: "initiative_objective_support_attestations",
    index_name: "initiative_objective_support_attestations_pkey",
    unique: true,
    primary: true,
    valid: true,
    ready: true,
    live: true,
    definition:
      "CREATE UNIQUE INDEX initiative_objective_support_attestations_pkey ON truth.initiative_objective_support_attestations USING btree (id)"
  }
];
const phase6RelationAdditions: ExactTruthRelation[] = [
  {
    name: "fact_lifecycle_events",
    kind: "r",
    persistence: "p",
    rls: true,
    forced_rls: true,
    owner: "migration_owner"
  }
];
const phase6PolicyAdditions: ExactTruthPolicy[] = [
  {
    table_name: "accepted_facts",
    policy_name: "accepted_facts_lifecycle_update",
    operation: "w",
    permissive: true,
    roles: ["throughline_app"],
    using_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class))",
    check_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND access.can_read_space(space_id, access_class))"
  },
  {
    table_name: "fact_lifecycle_events",
    policy_name: "fact_lifecycle_insert",
    operation: "a",
    permissive: true,
    roles: ["throughline_app"],
    using_expression: null,
    check_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (acted_by_user_id = ops.current_user_id()) AND (acted_by_membership_id = ops.current_membership_id()) AND (policy_version = ops.current_policy_version()) AND (EXISTS ( SELECT 1\n   FROM truth.accepted_facts predecessor\n  WHERE ((predecessor.tenant_id = fact_lifecycle_events.tenant_id) AND (predecessor.workspace_id = fact_lifecycle_events.workspace_id) AND (predecessor.space_id = fact_lifecycle_events.space_id) AND (predecessor.id = fact_lifecycle_events.predecessor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)))) AND ((successor_fact_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM truth.accepted_facts successor\n  WHERE ((successor.tenant_id = fact_lifecycle_events.tenant_id) AND (successor.workspace_id = fact_lifecycle_events.workspace_id) AND (successor.space_id = fact_lifecycle_events.space_id) AND (successor.id = fact_lifecycle_events.successor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class))))))"
  },
  {
    table_name: "fact_lifecycle_events",
    policy_name: "fact_lifecycle_integrity_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_b1_0_integrity"],
    using_expression: "true",
    check_expression: null
  },
  {
    table_name: "fact_lifecycle_events",
    policy_name: "fact_lifecycle_select",
    operation: "r",
    permissive: true,
    roles: ["throughline_app"],
    using_expression:
      "((tenant_id = ops.current_tenant_id()) AND (workspace_id = ops.current_workspace_id()) AND (space_id = ops.current_space_id()) AND (EXISTS ( SELECT 1\n   FROM truth.accepted_facts predecessor\n  WHERE ((predecessor.tenant_id = fact_lifecycle_events.tenant_id) AND (predecessor.workspace_id = fact_lifecycle_events.workspace_id) AND (predecessor.space_id = fact_lifecycle_events.space_id) AND (predecessor.id = fact_lifecycle_events.predecessor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, predecessor.access_class)))) AND ((successor_fact_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM truth.accepted_facts successor\n  WHERE ((successor.tenant_id = fact_lifecycle_events.tenant_id) AND (successor.workspace_id = fact_lifecycle_events.workspace_id) AND (successor.space_id = fact_lifecycle_events.space_id) AND (successor.id = fact_lifecycle_events.successor_fact_id) AND access.can_read_space(fact_lifecycle_events.space_id, successor.access_class))))))",
    check_expression: null
  }
];
const phase6ConstraintRemovals: ExactTruthConstraint[] = [
  {
    table_name: "accepted_facts",
    name: "accepted_facts_status_check",
    type: "c",
    definition: "CHECK ((status = 'current'::text))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  },
  {
    table_name: "accepted_facts",
    name: "accepted_facts_version_check",
    type: "c",
    definition: "CHECK ((version = 1))",
    deferrable: false,
    initially_deferred: false,
    validated: true
  }
];
const phase6ConstraintAdditions: ExactTruthConstraint[] = [
  [
    "accepted_facts",
    "accepted_facts_lifecycle_deferred",
    "t",
    "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    true
  ],
  [
    "accepted_facts",
    "accepted_facts_status_check",
    "c",
    "CHECK ((status = ANY (ARRAY['current'::text, 'superseded'::text, 'revoked'::text])))",
    false
  ],
  [
    "accepted_facts",
    "accepted_facts_version_check",
    "c",
    "CHECK ((((status = 'current'::text) AND (version = 1)) OR ((status = ANY (ARRAY['superseded'::text, 'revoked'::text])) AND (version = 2))))",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_actor_membership_fkey",
    "f",
    "FOREIGN KEY (tenant_id, workspace_id, acted_by_membership_id, acted_by_user_id) REFERENCES identity.memberships(tenant_id, workspace_id, id, user_id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    true
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_actor_user_fkey",
    "f",
    "FOREIGN KEY (acted_by_user_id) REFERENCES identity.users(id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    true
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_authority_check",
    "c",
    "CHECK ((authority_basis = ANY (ARRAY['activity_owner'::text, 'initiative_owner'::text])))",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_command_fkey",
    "f",
    "FOREIGN KEY (tenant_id, workspace_id, causation_command_id) REFERENCES ops.domain_command_records(tenant_id, workspace_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    true
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_command_key",
    "u",
    "UNIQUE (tenant_id, workspace_id, causation_command_id)",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_id_check",
    "c",
    "CHECK (ops.is_uuid_v7(id))",
    false
  ],
  ["fact_lifecycle_events", "fact_lifecycle_events_pkey", "p", "PRIMARY KEY (id)", false],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_policy_fkey",
    "f",
    "FOREIGN KEY (tenant_id, workspace_id, policy_version) REFERENCES identity.policy_versions(tenant_id, workspace_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    true
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_predecessor_fkey",
    "f",
    "FOREIGN KEY (tenant_id, workspace_id, space_id, predecessor_fact_id) REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id) MATCH FULL ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    true
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_predecessor_key",
    "u",
    "UNIQUE (tenant_id, workspace_id, predecessor_fact_id)",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_rationale_check",
    "c",
    "CHECK (((reason_rationale = NORMALIZE(reason_rationale, NFC)) AND (reason_rationale = btrim(reason_rationale)) AND ((length(reason_rationale) >= 1) AND (length(reason_rationale) <= 2000))))",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_reason_check",
    "c",
    "CHECK ((((transition_kind = 'supersede'::text) AND (reason_code = ANY (ARRAY['newer_evidence'::text, 'accepted_value_changed'::text, 'corrected_source_revalidated'::text]))) OR ((transition_kind = 'revoke'::text) AND (reason_code = ANY (ARRAY['no_longer_true'::text, 'support_invalidated'::text, 'entered_in_error'::text])))))",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_successor_fkey",
    "f",
    "FOREIGN KEY (tenant_id, workspace_id, space_id, successor_fact_id) REFERENCES truth.accepted_facts(tenant_id, workspace_id, space_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    true
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_successor_key",
    "u",
    "UNIQUE (tenant_id, workspace_id, successor_fact_id)",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_tenant_workspace_id_key",
    "u",
    "UNIQUE (tenant_id, workspace_id, id)",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_tenant_workspace_space_id_key",
    "u",
    "UNIQUE (tenant_id, workspace_id, space_id, id)",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_timestamp_check",
    "c",
    "CHECK ((recorded_at = transaction_timestamp()))",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_transition_shape_check",
    "c",
    "CHECK ((((transition_kind = 'supersede'::text) AND (from_status = 'current'::text) AND (to_status = 'superseded'::text) AND (successor_fact_id IS NOT NULL) AND (successor_fact_id <> predecessor_fact_id)) OR ((transition_kind = 'revoke'::text) AND (from_status = 'current'::text) AND (to_status = 'revoked'::text) AND (successor_fact_id IS NULL))))",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_events_version_check",
    "c",
    "CHECK ((version = 1))",
    false
  ],
  [
    "fact_lifecycle_events",
    "fact_lifecycle_valid_deferred",
    "t",
    "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    true
  ]
].map(([table_name, name, type, definition, deferred]) => ({
  table_name: table_name as string,
  name: name as string,
  type: type as string,
  definition: definition as string,
  deferrable: deferred as boolean,
  initially_deferred: deferred as boolean,
  validated: true
}));
const phase6IndexDefinitions = [
  ["fact_lifecycle_events_command_key", "tenant_id, workspace_id, causation_command_id"],
  ["fact_lifecycle_events_pkey", "id"],
  ["fact_lifecycle_events_predecessor_key", "tenant_id, workspace_id, predecessor_fact_id"],
  ["fact_lifecycle_events_successor_key", "tenant_id, workspace_id, successor_fact_id"],
  ["fact_lifecycle_events_tenant_workspace_id_key", "tenant_id, workspace_id, id"],
  ["fact_lifecycle_events_tenant_workspace_space_id_key", "tenant_id, workspace_id, space_id, id"]
] as const;
const phase6IndexAdditions: ExactTruthIndex[] = phase6IndexDefinitions.map(
  ([index_name, columns]) => ({
    table_name: "fact_lifecycle_events",
    index_name,
    unique: true,
    primary: index_name === "fact_lifecycle_events_pkey",
    valid: true,
    ready: true,
    live: true,
    definition: `CREATE UNIQUE INDEX ${index_name} ON truth.fact_lifecycle_events USING btree (${columns})`
  })
);
const withoutRows = <T>(rows: T[], removals: T[]): T[] => {
  const removed = new Set(removals.map((row) => JSON.stringify(row)));
  return rows.filter((row) => !removed.has(JSON.stringify(row)));
};

export function exactTruthCatalogForPhase(phase: number): ExactTruthCatalog {
  const relations = [...phase1.relations];
  const policies = [...phase1.policies];
  let constraints = [...phase1.constraints];
  const indexes = [...phase1.indexes];
  if (phase >= 2) policies.push(...phase2PolicyAdditions);
  if (phase >= 3) {
    constraints = withoutRows(constraints, phase3ConstraintRemovals);
    constraints.push(...phase3ConstraintAdditions);
  }
  if (phase >= 5) {
    relations.push(...phase5RelationAdditions);
    policies.push(...phase5PolicyAdditions);
    constraints = withoutRows(constraints, phase5ConstraintRemovals);
    constraints.push(...phase5ConstraintAdditions);
    indexes.push(...phase5IndexAdditions);
  }
  if (phase >= 6) {
    relations.push(...phase6RelationAdditions);
    policies.push(...phase6PolicyAdditions);
    constraints = withoutRows(constraints, phase6ConstraintRemovals);
    constraints.push(...phase6ConstraintAdditions);
    indexes.push(...phase6IndexAdditions);
  }
  relations.sort((left, right) => left.name.localeCompare(right.name));
  policies.sort((left, right) =>
    `${left.table_name}|${left.policy_name}`.localeCompare(
      `${right.table_name}|${right.policy_name}`
    )
  );
  constraints.sort((left, right) =>
    `${left.table_name}|${left.name}`.localeCompare(`${right.table_name}|${right.name}`)
  );
  indexes.sort((left, right) =>
    `${left.table_name}|${left.index_name}`.localeCompare(`${right.table_name}|${right.index_name}`)
  );
  return { relations, policies, constraints, indexes };
}
