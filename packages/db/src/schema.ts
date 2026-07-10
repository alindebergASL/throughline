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
