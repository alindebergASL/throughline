import type { AuthorizationDecision, ResourceRef, SecurityContext } from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";

export type AuthorizationAction =
  | "tenant.read"
  | "workspace.read"
  | "workspace.manage_members"
  | "space.read"
  | "space.create_child"
  | "space.manage_access"
  | "identity.me.read"
  | "membership.read"
  | "foundation.proof.create"
  | "foundation.relay.publish"
  | "foundation.worker.consume";

export interface WorkerAuthorizationBinding {
  referenceId: string;
  jobId: string;
  workerServicePrincipalId: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  policyVersionId: string;
  delegatingUserId: string;
  delegatingMembershipId: string;
}

export interface AuthorizationDecisionOptions {
  explain?: boolean;
}

export interface TransactionAuthorizationDecisionOptions extends AuthorizationDecisionOptions {
  workerBinding?: WorkerAuthorizationBinding;
}

export interface AuthorizationService {
  can(
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    options?: AuthorizationDecisionOptions
  ): Promise<AuthorizationDecision>;
}

export interface TransactionAwareAuthorizationService extends AuthorizationService {
  canInTransaction(
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    tx: TenantDbTransaction,
    options?: TransactionAuthorizationDecisionOptions
  ): Promise<AuthorizationDecision>;
}
