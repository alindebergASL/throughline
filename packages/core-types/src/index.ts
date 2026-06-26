export type AccessClass = "public" | "workspace" | "restricted" | "confidential";

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
  type: EntityKind;
  id: string;
}

export interface SecurityContext {
  requestId: string;
  traceId: string;
  tenantId: string;
  workspaceId: string;
  actorUserId?: string;
  actorMembershipId?: string;
  actorDisplayPersonId?: string;
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

export interface SkeletonModule {
  name: string;
  wave: "A1";
  status: "placeholder";
}
