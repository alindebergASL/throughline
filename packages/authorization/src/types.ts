import type {
  AccessClass,
  AuthorizationDecision,
  ResourceRef,
  SecurityContext
} from "@throughline/core-types";
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
  | "foundation.worker.consume"
  | "product_outbox.relay.publish"
  | "organization.create"
  | "organization.read"
  | "initiative.create"
  | "initiative.read"
  | "activity.create"
  | "activity.read"
  | "person.read"
  | "relationship.create"
  | "relationship.end"
  | "relationship.read"
  | "content.create"
  | "content.revise"
  | "content.read"
  | "source.capture"
  | "source.correct"
  | "source.tombstone"
  | "source.read"
  | "claim.create"
  | "claim.read"
  | "initiative.primary_objective.proposal.withdraw"
  | "initiative.primary_objective.proposal.reject"
  | "initiative.primary_objective.proposal.rework"
  | "fact.read"
  | "fact.accept"
  | "fact.supersede"
  | "fact.revoke";

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
  personUseSite?: ResourceRef;
  contentRevision?: number;
  requiredSpaceId?: string;
  requestedAccessClass?: AccessClass;
}

export interface TransactionAuthorizationDecisionOptions extends AuthorizationDecisionOptions {
  workerBinding?: WorkerAuthorizationBinding;
  lockAuthority?: boolean;
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

type ExactResourceRef<T extends ResourceRef["type"]> = ResourceRef & { type: T };

export type RelationshipAuthorityRequest =
  | {
      action: "relationship.end";
      resource: ExactResourceRef<"relationship">;
    }
  | {
      action: "space.read";
      resource: ExactResourceRef<"space">;
    }
  | {
      action: "person.read";
      resource: ExactResourceRef<"person">;
      personUseSite: ExactResourceRef<"relationship">;
    }
  | {
      action: "organization.read";
      resource: ExactResourceRef<"organization">;
    }
  | {
      action: "initiative.read";
      resource: ExactResourceRef<"initiative">;
    }
  | {
      action: "activity.read";
      resource: ExactResourceRef<"activity">;
    }
  | {
      action: "content.read";
      resource: ExactResourceRef<"content_item">;
    };

export interface RelationshipAuthorityBatchingAuthorizationService extends TransactionAwareAuthorizationService {
  preauthorizeRelationshipEndInTransaction(
    context: SecurityContext,
    resource: ExactResourceRef<"relationship">,
    tx: TenantDbTransaction
  ): Promise<AuthorizationDecision>;

  lockAndReauthorizeRelationshipAuthorityInTransaction(
    context: SecurityContext,
    requests: readonly RelationshipAuthorityRequest[],
    tx: TenantDbTransaction
  ): Promise<AuthorizationDecision>;
}
