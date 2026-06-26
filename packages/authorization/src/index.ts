import type { ResourceRef, SecurityContext, SkeletonModule } from "@throughline/core-types";

export interface AuthorizationDecision {
  allowed: boolean;
  reason: "not_implemented";
}

export interface AuthorizationService {
  can(
    context: SecurityContext,
    action: string,
    resource: ResourceRef,
    options?: { explain?: boolean }
  ): Promise<AuthorizationDecision>;
}

export const authorizationSkeleton: SkeletonModule = {
  name: "@throughline/authorization",
  wave: "A1",
  status: "placeholder"
};
