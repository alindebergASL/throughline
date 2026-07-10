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
  | "foundation.relay.publish";

export interface AuthorizationService {
  can(
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    options?: { explain?: boolean }
  ): Promise<AuthorizationDecision>;
}

export interface TransactionAwareAuthorizationService extends AuthorizationService {
  canInTransaction(
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    tx: TenantDbTransaction,
    options?: { explain?: boolean }
  ): Promise<AuthorizationDecision>;
}
