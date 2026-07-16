import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid
} from "drizzle-orm/pg-core";

export const identity = pgSchema("identity");
export const access = pgSchema("access");
export const ops = pgSchema("ops");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1)
};

export const tenants = identity.table("tenants", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  defaultAccessClass: text("default_access_class").notNull(),
  planCode: text("plan_code").notNull().default("dev"),
  authProviderRef: text("auth_provider_ref"),
  ...timestamps
});

export const workspaces = identity.table(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    profileId: text("profile_id").notNull(),
    profileVersion: text("profile_version").notNull(),
    defaultSpaceId: uuid("default_space_id"),
    defaultAccessClass: text("default_access_class").notNull(),
    modelPolicyId: text("model_policy_id").notNull().default("default"),
    retentionPolicyId: text("retention_policy_id"),
    ...timestamps
  },
  (table) => [unique().on(table.tenantId, table.id), unique().on(table.tenantId, table.slug)]
);

export const users = identity.table(
  "users",
  {
    id: uuid("id").primaryKey(),
    authProvider: text("auth_provider").notNull(),
    authSubject: text("auth_subject").notNull(),
    primaryEmail: text("primary_email").notNull(),
    status: text("status").notNull(),
    ...timestamps
  },
  (table) => [unique().on(table.authProvider, table.authSubject)]
);

export const people = identity.table(
  "people",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    displayName: text("display_name").notNull(),
    primaryEmail: text("primary_email"),
    titleFactId: uuid("title_fact_id"),
    employerOrganizationId: uuid("employer_organization_id"),
    isInternal: boolean("is_internal").notNull().default(false),
    externalRefs: jsonb("external_refs").notNull().default([]),
    ...timestamps
  },
  (table) => [unique().on(table.tenantId, table.workspaceId, table.id)]
);

export const memberships = identity.table(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    personId: uuid("person_id"),
    role: text("role").notNull(),
    status: text("status").notNull(),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    index("memberships_user_idx").on(table.userId)
  ]
);

export const servicePrincipals = identity.table(
  "service_principals",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull(),
    ...timestamps
  },
  (table) => [unique().on(table.tenantId, table.workspaceId, table.id)]
);

export const agentPrincipals = identity.table(
  "agent_principals",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    runtimePolicyId: text("runtime_policy_id").notNull(),
    status: text("status").notNull(),
    ...timestamps
  },
  (table) => [unique().on(table.tenantId, table.workspaceId, table.id)]
);

export const policyVersions = identity.table(
  "policy_versions",
  {
    id: text("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    status: text("status").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.workspaceId, table.id] })]
);

export const spaces = access.table(
  "spaces",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    parentSpaceId: uuid("parent_space_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    accessClass: text("access_class").notNull(),
    inheritanceMode: text("inheritance_mode").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [unique().on(table.tenantId, table.workspaceId, table.id)]
);

export const accessRelationships = access.table(
  "access_relationships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    relation: text("relation").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("access_relationships_resource_idx").on(
      table.tenantId,
      table.workspaceId,
      table.resourceType,
      table.resourceId
    ),
    index("access_relationships_subject_idx").on(
      table.tenantId,
      table.workspaceId,
      table.subjectType,
      table.subjectId
    )
  ]
);

export const securityContextReferences = ops.table(
  "security_context_references",
  {
    id: uuid("id").primaryKey(),
    jobId: uuid("job_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    workerServicePrincipalId: uuid("worker_service_principal_id").notNull(),
    delegatingUserId: uuid("delegating_user_id").notNull(),
    delegatingMembershipId: uuid("delegating_membership_id").notNull(),
    policyVersionId: text("policy_version_id").notNull(),
    contextSnapshot: jsonb("context_snapshot").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("active"),
    signingKeyId: text("signing_key_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id"),
    revocationReason: text("revocation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1)
  },
  (table) => [
    unique("security_context_references_scope_id_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.id
    ),
    unique("security_context_references_scope_job_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.jobId
    ),
    unique("security_context_references_outbox_binding_unique").on(
      table.id,
      table.jobId,
      table.tenantId,
      table.workspaceId,
      table.spaceId
    ),
    index("security_context_references_expiry_idx").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.expiresAt
    )
  ]
);

export const foundationTestAggregates = ops.table(
  "foundation_test_aggregates",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    proofKey: text("proof_key").notNull(),
    pendingJobId: uuid("pending_job_id"),
    lastEffectJobId: uuid("last_effect_job_id"),
    effectCount: integer("effect_count").notNull().default(0),
    aggregateVersion: integer("aggregate_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("foundation_test_aggregates_scope_id_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.id
    ),
    unique("foundation_test_aggregates_proof_key_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.proofKey
    ),
    index("foundation_test_aggregates_pending_job_idx").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.pendingJobId
    )
  ]
);

export const outboxEvents = ops.table(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    eventType: text("event_type").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    causationId: uuid("causation_id").notNull(),
    requestId: text("request_id").notNull(),
    traceparent: text("traceparent").notNull(),
    tracestate: text("tracestate"),
    jobId: uuid("job_id").notNull(),
    relayServicePrincipalId: uuid("relay_service_principal_id").notNull(),
    contextReferenceId: uuid("context_reference_id").notNull(),
    signedContextReference: text("signed_context_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publicationAttempts: integer("publication_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    lastRetryCode: text("last_retry_code"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedMessageId: text("published_message_id"),
    terminalFailedAt: timestamp("terminal_failed_at", { withTimezone: true }),
    terminalFailureCode: text("terminal_failure_code")
  },
  (table) => [
    unique("outbox_events_scope_id_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.id
    ),
    unique("outbox_events_scope_job_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.jobId
    ),
    index("outbox_events_publishable_idx").on(table.nextAttemptAt, table.createdAt),
    index("outbox_events_scope_created_idx").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.createdAt
    )
  ]
);

export const idempotencyRecords = ops.table(
  "idempotency_records",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    jobId: uuid("job_id").notNull(),
    handlerKey: text("handler_key").notNull(),
    contextReferenceId: uuid("context_reference_id").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    effectHash: text("effect_hash").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("idempotency_records_scope_id_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.id
    ),
    unique("idempotency_records_effect_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.jobId,
      table.handlerKey
    ),
    index("idempotency_records_aggregate_idx").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.aggregateId,
      table.completedAt
    )
  ]
);

export const domainCommandRecords = ops.table(
  "domain_command_records",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    reservationSpaceId: uuid("reservation_space_id").notNull(),
    commandKind: text("command_kind").notNull(),
    commandSchemaVersion: integer("command_schema_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    canonicalRequestHash: text("canonical_request_hash").notNull(),
    state: text("state").notNull().default("reserved"),
    resultResourceType: text("result_resource_type"),
    resultResourceId: uuid("result_resource_id"),
    safeResponse: jsonb("safe_response"),
    actorUserId: uuid("actor_user_id").notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    delegatingUserId: uuid("delegating_user_id"),
    delegatingMembershipId: uuid("delegating_membership_id"),
    agentPrincipalId: uuid("agent_principal_id"),
    policyVersionId: text("policy_version_id").notNull(),
    requestId: text("request_id").notNull(),
    traceparent: text("traceparent").notNull(),
    tracestate: text("tracestate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    unique("domain_command_records_scope_id_unique").on(
      table.tenantId,
      table.workspaceId,
      table.id
    ),
    unique("domain_command_records_idempotency_unique").on(
      table.tenantId,
      table.workspaceId,
      table.reservationSpaceId,
      table.commandKind,
      table.idempotencyKey
    ),
    index("domain_command_records_scope_created_idx").on(
      table.tenantId,
      table.workspaceId,
      table.reservationSpaceId,
      table.createdAt
    )
  ]
);

export const auditEvents = ops.table(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    causationCommandId: uuid("causation_command_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    delegatingUserId: uuid("delegating_user_id"),
    delegatingMembershipId: uuid("delegating_membership_id"),
    agentPrincipalId: uuid("agent_principal_id"),
    policyVersionId: text("policy_version_id").notNull(),
    requestId: text("request_id").notNull(),
    traceparent: text("traceparent").notNull(),
    tracestate: text("tracestate"),
    auditSchemaVersion: integer("audit_schema_version").notNull(),
    safeDetail: jsonb("safe_detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("audit_events_scope_id_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.id
    ),
    index("audit_events_resource_created_idx").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.resourceType,
      table.resourceId,
      table.createdAt
    ),
    index("audit_events_command_idx").on(
      table.tenantId,
      table.workspaceId,
      table.causationCommandId
    )
  ]
);

export const productOutboxEvents = ops.table(
  "product_outbox_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    relayServicePrincipalId: uuid("relay_service_principal_id").notNull(),
    policyVersionId: text("policy_version_id").notNull(),
    eventType: text("event_type").notNull(),
    eventSchemaVersion: integer("event_schema_version").notNull(),
    payloadSchemaVersion: integer("payload_schema_version").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    causationCommandId: uuid("causation_command_id").notNull(),
    payload: jsonb("payload").notNull(),
    requestId: text("request_id").notNull(),
    traceparent: text("traceparent").notNull(),
    tracestate: text("tracestate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publicationState: text("publication_state").notNull().default("pending"),
    publicationAttempt: integer("publication_attempt").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    lastOutcomeCode: text("last_outcome_code"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedMessageId: text("published_message_id"),
    terminalAt: timestamp("terminal_at", { withTimezone: true })
  },
  (table) => [
    unique("product_outbox_events_scope_id_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.id
    ),
    unique("product_outbox_events_semantic_unique").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.causationCommandId,
      table.eventType,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion
    ),
    index("product_outbox_events_publishable_idx").on(
      table.nextAttemptAt,
      table.createdAt,
      table.id
    ),
    index("product_outbox_events_scope_created_idx").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.createdAt,
      table.id
    )
  ]
);
