import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
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
export const work = pgSchema("work");
export const content = pgSchema("content");
export const truth = pgSchema("truth");

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

export const organizations = work.table(
  "organizations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    status: text("status").notNull(),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id)
  ]
);

export const organizationDomains = work.table(
  "organization_domains",
  {
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    domain: text("domain").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.workspaceId, table.organizationId, table.domain] })
  ]
);

export const initiatives = work.table(
  "initiatives",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    title: text("title").notNull(),
    typeKey: text("type_key").notNull(),
    stageKey: text("stage_key").notNull(),
    health: text("health").notNull(),
    ownerPersonId: uuid("owner_person_id").notNull(),
    profileId: text("profile_id").notNull(),
    profileVersion: text("profile_version").notNull(),
    evidenceScore: numeric("evidence_score"),
    evidenceChallenge: text("evidence_challenge"),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id)
  ]
);

export const initiativeOrganizations = work.table(
  "initiative_organizations",
  {
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    initiativeId: uuid("initiative_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    associationRole: text("association_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.workspaceId,
        table.initiativeId,
        table.organizationId,
        table.createdAt
      ]
    })
  ]
);

export const initiativePeople = work.table(
  "initiative_people",
  {
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    initiativeId: uuid("initiative_id").notNull(),
    personId: uuid("person_id").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.workspaceId,
        table.initiativeId,
        table.personId,
        table.createdAt
      ]
    })
  ]
);

export const activities = work.table(
  "activities",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    subtype: text("subtype").notNull(),
    profileTemplateKey: text("profile_template_key").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    ownerPersonId: uuid("owner_person_id").notNull(),
    governingInitiativeId: uuid("governing_initiative_id"),
    governingOrganizationId: uuid("governing_organization_id"),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id)
  ]
);

function activityAssociationColumns(name: string) {
  return {
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    activityId: uuid("activity_id").notNull(),
    relatedId: uuid(name).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  };
}

export const activityOrganizations = work.table(
  "activity_organizations",
  activityAssociationColumns("organization_id"),
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workspaceId, table.activityId, table.relatedId]
    })
  ]
);
export const activityInitiatives = work.table(
  "activity_initiatives",
  activityAssociationColumns("initiative_id"),
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workspaceId, table.activityId, table.relatedId]
    })
  ]
);
export const activityAttendees = work.table(
  "activity_attendees",
  activityAssociationColumns("person_id"),
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workspaceId, table.activityId, table.relatedId]
    })
  ]
);

export const relationships = work.table(
  "relationships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    predicate: text("predicate").notNull(),
    objectType: text("object_type").notNull(),
    objectId: uuid("object_id").notNull(),
    contextType: text("context_type"),
    contextId: uuid("context_id"),
    supportingFactId: uuid("supporting_fact_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id)
  ]
);

export const contentItems = content.table(
  "content_items",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    ownerPersonId: uuid("owner_person_id").notNull(),
    accessClass: text("access_class").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    currentRevision: integer("current_revision").notNull().default(1),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id)
  ]
);

export const contentRevisions = content.table(
  "content_revisions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    contentItemId: uuid("content_item_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    accessClass: text("access_class").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.contentItemId, table.revisionNumber),
    unique().on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.contentItemId,
      table.revisionNumber
    )
  ]
);

export const sourceArtifacts = content.table(
  "source_artifacts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    sourceType: text("source_type").notNull(),
    trustClass: text("trust_class").notNull(),
    title: text("title"),
    immutableText: text("immutable_text"),
    objectKey: text("object_key"),
    contentHash: text("content_hash"),
    sourceUri: text("source_uri"),
    externalRef: jsonb("external_ref"),
    providerId: text("provider_id"),
    providerVersion: text("provider_version"),
    adapterVersion: text("adapter_version"),
    normalizationVersion: text("normalization_version").notNull(),
    chunkingVersion: text("chunking_version").notNull(),
    normalizedContentHash: text("normalized_content_hash"),
    hashRetentionPolicy: text("hash_retention_policy").notNull(),
    originContentItemId: uuid("origin_content_item_id"),
    originContentRevision: integer("origin_content_revision"),
    supersedesSourceId: uuid("supersedes_source_id"),
    capturedByUserId: uuid("captured_by_user_id").notNull(),
    capturedByMembershipId: uuid("captured_by_membership_id").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    accessClass: text("access_class").notNull(),
    sourceSnapshotPolicy: text("source_snapshot_policy").notNull(),
    retentionPolicyId: text("retention_policy_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletionReason: text("deletion_reason"),
    deletionPolicyRef: text("deletion_policy_ref"),
    hashDisposition: text("hash_disposition"),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.supersedesSourceId)
  ]
);

export const sourceChunks = content.table(
  "source_chunks",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    sourceArtifactId: uuid("source_artifact_id").notNull(),
    normalizationVersion: text("normalization_version").notNull(),
    chunkingVersion: text("chunking_version").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    normalizedText: text("normalized_text").notNull(),
    contentHash: text("content_hash").notNull(),
    accessClass: text("access_class").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id),
    unique().on(
      table.tenantId,
      table.workspaceId,
      table.sourceArtifactId,
      table.normalizationVersion,
      table.chunkingVersion,
      table.chunkIndex
    )
  ]
);

export const activitySources = work.table(
  "activity_sources",
  activityAssociationColumns("source_artifact_id"),
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workspaceId, table.activityId, table.relatedId]
    }),
    unique().on(table.tenantId, table.workspaceId, table.relatedId)
  ]
);

const truthScope = {
  tenantId: uuid("tenant_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  spaceId: uuid("space_id").notNull()
};

export const verifiedEvidenceSpans = truth.table(
  "verified_evidence_spans",
  {
    id: uuid("id").primaryKey(),
    ...truthScope,
    sourceArtifactId: uuid("source_artifact_id").notNull(),
    sourceChunkId: uuid("source_chunk_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    chunkVersion: integer("chunk_version").notNull(),
    normalizationVersion: text("normalization_version").notNull(),
    chunkingVersion: text("chunking_version").notNull(),
    sourceStartOffset: integer("source_start_offset").notNull(),
    sourceEndOffset: integer("source_end_offset").notNull(),
    sourceExcerpt: text("source_excerpt"),
    sourceContentHash: text("source_content_hash"),
    sourceNormalizedContentHash: text("source_normalized_content_hash"),
    chunkContentHash: text("chunk_content_hash"),
    excerptHash: text("excerpt_hash"),
    accessClass: text("access_class").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    causationCommandId: uuid("causation_command_id").notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    redactionCommandId: uuid("redaction_command_id"),
    hashDisposition: text("hash_disposition"),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id),
    index("evidence_spans_source_idx").on(
      table.tenantId,
      table.workspaceId,
      table.sourceArtifactId,
      table.createdAt
    )
  ]
);

export const claims = truth.table(
  "claims",
  {
    id: uuid("id").primaryKey(),
    ...truthScope,
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    predicateCatalogVersion: text("predicate_catalog_version").notNull(),
    predicate: text("predicate").notNull(),
    valueJson: jsonb("value_json"),
    valueHash: text("value_hash"),
    normalizedText: text("normalized_text"),
    verifiedEvidenceSpanId: uuid("verified_evidence_span_id").notNull(),
    assertedByType: text("asserted_by_type").notNull(),
    assertedById: uuid("asserted_by_id").notNull(),
    confidence: text("confidence").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    status: text("status").notNull(),
    accessClass: text("access_class").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    causationCommandId: uuid("causation_command_id").notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    redactionCommandId: uuid("redaction_command_id"),
    hashDisposition: text("hash_disposition"),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id),
    index("claims_subject_predicate_idx").on(
      table.tenantId,
      table.workspaceId,
      table.spaceId,
      table.subjectType,
      table.subjectId,
      table.predicate,
      table.createdAt
    )
  ]
);

export const acceptedFacts = truth.table(
  "accepted_facts",
  {
    id: uuid("id").primaryKey(),
    ...truthScope,
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    predicateCatalogVersion: text("predicate_catalog_version").notNull(),
    predicate: text("predicate").notNull(),
    valueJson: jsonb("value_json"),
    valueHash: text("value_hash"),
    normalizedText: text("normalized_text"),
    confidence: text("confidence").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    accessClass: text("access_class").notNull(),
    acceptedByUserId: uuid("accepted_by_user_id").notNull(),
    acceptedByMembershipId: uuid("accepted_by_membership_id").notNull(),
    acceptanceScope: text("acceptance_scope").notNull(),
    authorityBasis: text("authority_basis").notNull(),
    acceptancePolicyVersion: text("acceptance_policy_version").notNull(),
    lastCausationCommandId: uuid("last_causation_command_id").notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    redactionSourceArtifactId: uuid("redaction_source_artifact_id"),
    hashDisposition: text("hash_disposition"),
    ...timestamps
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.spaceId, table.id)
  ]
);

export const factClaims = truth.table(
  "fact_claims",
  {
    ...truthScope,
    factId: uuid("fact_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.workspaceId, table.factId, table.claimId] })
  ]
);

export const factLifecycleEvents = truth.table(
  "fact_lifecycle_events",
  {
    id: uuid("id").primaryKey(),
    ...truthScope,
    factId: uuid("fact_id").notNull(),
    eventType: text("event_type").notNull(),
    toStatus: text("to_status").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    authorityBasis: text("authority_basis").notNull(),
    policyVersion: text("policy_version").notNull(),
    confidenceRule: text("confidence_rule").notNull(),
    confidence: text("confidence").notNull(),
    strongestSupportingConfidence: text("strongest_supporting_confidence").notNull(),
    humanLowered: boolean("human_lowered").notNull(),
    confidenceLoweringReasonCode: text("confidence_lowering_reason_code"),
    confidenceLoweringRationale: text("confidence_lowering_rationale"),
    causationCommandId: uuid("causation_command_id").notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    redactionCommandId: uuid("redaction_command_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique().on(table.tenantId, table.workspaceId, table.id),
    unique().on(table.tenantId, table.workspaceId, table.factId, table.eventType)
  ]
);
