export type AccessClass = "public" | "workspace" | "restricted" | "confidential";

export * from "./domain-notification.js";
export * from "./b1.js";

export type Confidence = "confirmed" | "strong" | "weak" | "unknown";

export type EntityKind =
  | "space"
  | "person"
  | "team"
  | "organization"
  | "initiative"
  | "activity"
  | "content"
  | "task"
  | "commitment"
  | "decision"
  | "use_case"
  | "readiness_profile";

export type AutonomyTier = "automatic_reversible" | "propose_for_approval" | "never_autonomous";

export type ImpactClass = "routine" | "material" | "consequential" | "restricted";

export interface ResourceRef {
  type:
    | EntityKind
    | "tenant"
    | "workspace"
    | "user"
    | "membership"
    | "service_principal"
    | "agent_principal"
    | "relationship"
    | "content_item"
    | "source"
    | "source_chunk";
  id: string;
  spaceId?: string;
}

export interface SecurityContext {
  requestId: string;
  traceId: string;
  tenantId: string;
  workspaceId: string;
  actorUserId?: string;
  actorMembershipId?: string;
  actorDisplayPersonId?: string;
  servicePrincipalId?: string;
  agentPrincipalId?: string;
  delegatedByUserId?: string;
  delegatedByMembershipId?: string;
  requestedSpaceIds: string[];
  membershipIds: string[];
  roleHints: string[];
  dataClassCeiling: AccessClass;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  explanation?: string;
  policyVersion: string;
  evaluatedRelationships?: string[];
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "deleted";
  defaultAccessClass: AccessClass;
  planCode: string;
  authProviderRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  status: "active" | "archived";
  profileId: string;
  profileVersion: string;
  defaultSpaceId?: string;
  defaultAccessClass: AccessClass;
  modelPolicyId: string;
  retentionPolicyId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  authProvider: string;
  authSubject: string;
  primaryEmail: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface Person {
  id: string;
  tenantId: string;
  workspaceId: string;
  displayName: string;
  primaryEmail?: string;
  isInternal: boolean;
  externalRefs: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  id: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  personId?: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "invited" | "active" | "suspended";
  createdAt: string;
  updatedAt: string;
}

export interface ServicePrincipal {
  id: string;
  tenantId: string;
  workspaceId: string;
  name: string;
  purpose: "worker" | "connector" | "system" | "product_notification_relay";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface AgentPrincipal {
  id: string;
  tenantId: string;
  workspaceId: string;
  name: string;
  runtimePolicyId: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface Space {
  id: string;
  tenantId: string;
  workspaceId: string;
  parentSpaceId?: string;
  kind: "workspace_root" | "organization" | "initiative" | "project" | "knowledge";
  name: string;
  slug: string;
  accessClass: AccessClass;
  inheritanceMode: "inherit" | "restricted";
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccessRelationship {
  id: string;
  tenantId: string;
  workspaceId: string;
  subjectType: "user" | "membership" | "service_principal" | "agent_principal";
  subjectId: string;
  relation: "owner" | "manager" | "contributor" | "viewer";
  resourceType: EntityKind;
  resourceId: string;
  source: "direct" | "inherited" | "system";
  createdAt: string;
}

export interface SkeletonModule {
  name: string;
  wave: "A1" | "A2";
  status: "placeholder" | "implemented";
}

export type { FoundationQueueEnvelope, FoundationScope } from "./async-foundation.js";
