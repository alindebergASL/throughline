import type { AuthorizationDecision, ResourceRef, SecurityContext } from "@throughline/core-types";

export type AuthorizationAction =
  | "tenant.read"
  | "workspace.read"
  | "workspace.manage_members"
  | "space.read"
  | "space.create_child"
  | "space.manage_access"
  | "identity.me.read"
  | "membership.read";

export interface AuthorizationService {
  can(
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    options?: { explain?: boolean }
  ): Promise<AuthorizationDecision>;
}
