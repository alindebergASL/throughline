import type { AuthorizationDecision, ResourceRef, SecurityContext } from "@throughline/core-types";
import type { PgPool, TenantQueryExecutor } from "@throughline/db";
import { withTenantTransaction } from "@throughline/db";
import { isSecurityContextExpired, parseSecurityContext } from "@throughline/tenancy";
import type {
  AuthorizationAction,
  AuthorizationDecisionOptions,
  TransactionAuthorizationDecisionOptions,
  TransactionAwareAuthorizationService,
  WorkerAuthorizationBinding
} from "./types.js";

type MembershipRole = "owner" | "admin" | "member" | "viewer";

interface MembershipRecord {
  role: MembershipRole;
  membership_status: "invited" | "active" | "suspended";
  user_status: "active" | "disabled";
}

export class PostgresAuthorizationService implements TransactionAwareAuthorizationService {
  constructor(private readonly pool: PgPool) {}

  async can(
    inputContext: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    options: AuthorizationDecisionOptions = {}
  ): Promise<AuthorizationDecision> {
    const contextResult = parseContextForDecision(inputContext);
    if (!contextResult.ok) {
      return deny(
        inputContext.policyVersion ?? "unknown",
        contextResult.reasonCode,
        contextResult.explanation
      );
    }

    const context = contextResult.context;
    if (isSecurityContextExpired(context)) {
      return deny(context.policyVersion, "context_expired", "SecurityContext has expired");
    }

    return withTenantTransaction({ pool: this.pool, context }, (tx) =>
      this.decideInTransaction(context, action, resource, tx, options)
    );
  }

  async canInTransaction(
    inputContext: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    tx: TenantQueryExecutor,
    options: TransactionAuthorizationDecisionOptions = {}
  ): Promise<AuthorizationDecision> {
    const contextResult = parseContextForDecision(inputContext);
    if (!contextResult.ok) {
      return deny(
        inputContext.policyVersion ?? "unknown",
        contextResult.reasonCode,
        contextResult.explanation
      );
    }
    if (isSecurityContextExpired(contextResult.context)) {
      return deny(
        contextResult.context.policyVersion,
        "context_expired",
        "SecurityContext has expired"
      );
    }
    return this.decideInTransaction(contextResult.context, action, resource, tx, options);
  }

  private async decideInTransaction(
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    tx: TenantQueryExecutor,
    options: TransactionAuthorizationDecisionOptions
  ): Promise<AuthorizationDecision> {
    if (action === "foundation.proof.create") {
      return foundationProofCreateDecision(tx, context, resource, options);
    }
    if (action === "foundation.relay.publish") {
      return foundationRelayPublishDecision(tx, context, resource, options);
    }
    if (action === "foundation.worker.consume") {
      return foundationWorkerConsumeDecision(tx, context, resource, options);
    }
    if (action === "product_outbox.relay.publish") {
      return productOutboxRelayPublishDecision(tx, context, resource, options);
    }

    const hasActivePolicyVersion = await loadActivePolicyVersion(tx, context);
    if (!hasActivePolicyVersion) {
      return deny(
        context.policyVersion,
        "policy_version_not_active",
        "SecurityContext policy version is not active for the current tenant and workspace"
      );
    }

    if (context.servicePrincipalId || context.agentPrincipalId) {
      return deny(
        context.policyVersion,
        "principal_default_denied",
        "Service and agent principals have no A2 allow rules"
      );
    }

    const membership = await loadActiveMembership(tx, context);
    if (!membership) {
      return deny(
        context.policyVersion,
        "membership_not_active",
        "No active membership matches the current context"
      );
    }

    if (membership.user_status !== "active" || membership.membership_status !== "active") {
      return deny(
        context.policyVersion,
        "principal_not_active",
        "User or membership is not active"
      );
    }

    if (isB1Action(action)) {
      return b1Decision(tx, context, membership.role, action, resource, options);
    }

    if (action === "tenant.read") {
      if (resource.type !== "tenant" || resource.id !== context.tenantId) {
        return deny(
          context.policyVersion,
          "wrong_tenant",
          "Resource is outside the current tenant"
        );
      }

      return allow(
        context.policyVersion,
        "tenant_member",
        options.explain ? "Active membership may read current tenant" : undefined
      );
    }

    if (action === "workspace.read") {
      if (resource.type !== "workspace" || resource.id !== context.workspaceId) {
        return deny(
          context.policyVersion,
          "wrong_workspace",
          "Resource is outside the current workspace"
        );
      }
      return allow(context.policyVersion, "workspace_member");
    }

    if (action === "identity.me.read") {
      if (resource.type !== "user" || resource.id !== context.actorUserId) {
        return deny(
          context.policyVersion,
          "not_self",
          "identity.me.read only allows the current user"
        );
      }
      return allow(context.policyVersion, "current_user_self_read");
    }

    if (action === "membership.read") {
      if (resource.type !== "membership" || resource.id !== context.actorMembershipId) {
        return deny(
          context.policyVersion,
          "not_current_membership",
          "Membership read is limited to the current membership in A2"
        );
      }
      return allow(context.policyVersion, "current_membership_read");
    }

    if (action === "workspace.manage_members") {
      if (resource.type !== "workspace" || resource.id !== context.workspaceId) {
        return deny(
          context.policyVersion,
          "wrong_workspace",
          "Resource is outside the current workspace"
        );
      }

      return ownerOrAdminDecision(
        context.policyVersion,
        membership.role,
        "workspace_members_manage"
      );
    }

    if (resource.type !== "space") {
      return deny(
        context.policyVersion,
        "unsupported_resource",
        "A2 action requires a Space resource"
      );
    }

    const canReadSpace = await canReadSpaceResource(tx, context, resource.id, membership.role);
    if (!canReadSpace.allowed) {
      return deny(context.policyVersion, canReadSpace.reasonCode, canReadSpace.explanation);
    }

    if (action === "space.read") {
      return allow(
        context.policyVersion,
        canReadSpace.reasonCode,
        options.explain ? canReadSpace.explanation : undefined,
        [canReadSpace.reasonCode]
      );
    }

    if (action === "space.create_child" || action === "space.manage_access") {
      return ownerOrAdminDecision(context.policyVersion, membership.role, action);
    }

    return deny(context.policyVersion, "unsupported_action", "Action is not implemented in A2");
  }
}

const b1Actions = new Set<AuthorizationAction>([
  "organization.create",
  "organization.read",
  "initiative.create",
  "initiative.read",
  "activity.create",
  "activity.read",
  "person.read",
  "relationship.create",
  "relationship.end",
  "relationship.read",
  "content.create",
  "content.revise",
  "content.read",
  "source.capture",
  "source.correct",
  "source.tombstone",
  "source.read"
]);

function isB1Action(action: AuthorizationAction): boolean {
  return b1Actions.has(action);
}

async function b1Decision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  role: MembershipRole,
  action: AuthorizationAction,
  resource: ResourceRef,
  options: AuthorizationDecisionOptions
): Promise<AuthorizationDecision> {
  if (action === "person.read") {
    return personReadDecision(tx, context, role, resource, options.personUseSite);
  }

  const createActions = new Set<AuthorizationAction>([
    "organization.create",
    "initiative.create",
    "activity.create",
    "relationship.create",
    "content.create",
    "source.capture"
  ]);
  let spaceId: string | undefined;
  let accessClass: "public" | "workspace" | "restricted" | "confidential" | undefined;
  if (createActions.has(action)) {
    if (resource.type !== "space") return nonLeakingB1Deny(context.policyVersion);
    spaceId = resource.id;
    const space = await tx.query<{ access_class: typeof accessClass }>(
      `SELECT access_class FROM access.spaces
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL LIMIT 1`,
      [context.tenantId, context.workspaceId, spaceId]
    );
    accessClass = space.rows[0]?.access_class;
  } else {
    const loaded = await loadB1ResourceScope(tx, context, action, resource);
    spaceId = loaded?.spaceId;
    accessClass = loaded?.accessClass;
  }
  if (!spaceId || !accessClass || !canReadDataClass(context.dataClassCeiling, accessClass)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const readable = await canReadSpaceResource(tx, context, spaceId, role);
  if (!readable.allowed) return nonLeakingB1Deny(context.policyVersion);

  const readActions = new Set<AuthorizationAction>([
    "organization.read",
    "initiative.read",
    "activity.read",
    "relationship.read",
    "content.read",
    "source.read"
  ]);
  if (readActions.has(action)) {
    return allow(
      context.policyVersion,
      "b1_resource_read",
      options.explain ? "Current Space and data-class access allow this projection" : undefined,
      [readable.reasonCode]
    );
  }
  if (action === "source.tombstone" || action === "organization.create") {
    return ownerOrAdminDecision(context.policyVersion, role, "b1_workspace_authority");
  }
  const contributor = await hasContributorAuthority(tx, context, spaceId, role);
  return contributor
    ? allow(context.policyVersion, "b1_contributor_authority", undefined, [readable.reasonCode])
    : deny(context.policyVersion, "b1_resource_not_available");
}

async function loadB1ResourceScope(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  action: AuthorizationAction,
  resource: ResourceRef
): Promise<
  | {
      spaceId: string;
      accessClass: "public" | "workspace" | "restricted" | "confidential";
    }
  | undefined
> {
  let table: string;
  let expectedType: ResourceRef["type"];
  if (action.startsWith("organization."))
    [table, expectedType] = ["work.organizations", "organization"];
  else if (action.startsWith("initiative."))
    [table, expectedType] = ["work.initiatives", "initiative"];
  else if (action.startsWith("activity.")) [table, expectedType] = ["work.activities", "activity"];
  else if (action.startsWith("relationship."))
    [table, expectedType] = ["work.relationships", "relationship"];
  else if (action.startsWith("content."))
    [table, expectedType] = ["content.content_items", "content_item"];
  else if (action.startsWith("source."))
    [table, expectedType] = ["content.source_artifacts", "source"];
  else return undefined;
  if (resource.type !== expectedType) return undefined;
  const result = await tx.query<{
    space_id: string;
    access_class: "public" | "workspace" | "restricted" | "confidential";
  }>(
    table === "content.source_artifacts"
      ? `SELECT source.space_id,
           CASE GREATEST(
             CASE space.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END,
             CASE source.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END
           ) WHEN 0 THEN 'public' WHEN 1 THEN 'workspace' WHEN 2 THEN 'restricted' ELSE 'confidential' END AS access_class
         FROM content.source_artifacts source
         JOIN access.spaces space ON space.tenant_id = source.tenant_id
           AND space.workspace_id = source.workspace_id AND space.id = source.space_id
         WHERE source.tenant_id = $1 AND source.workspace_id = $2 AND source.id = $3 LIMIT 1`
      : `SELECT resource.space_id, space.access_class
         FROM ${table} resource
         JOIN access.spaces space ON space.tenant_id = resource.tenant_id
           AND space.workspace_id = resource.workspace_id AND space.id = resource.space_id
         WHERE resource.tenant_id = $1 AND resource.workspace_id = $2 AND resource.id = $3 LIMIT 1`,
    [context.tenantId, context.workspaceId, resource.id]
  );
  const row = result.rows[0];
  return row ? { spaceId: row.space_id, accessClass: row.access_class } : undefined;
}

async function personReadDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  role: MembershipRole,
  resource: ResourceRef,
  useSite: ResourceRef | undefined
): Promise<AuthorizationDecision> {
  if (resource.type !== "person" || !useSite) return nonLeakingB1Deny(context.policyVersion);
  let associationQuery: string;
  let table: string;
  if (useSite.type === "activity") {
    table = "work.activities";
    associationQuery = `resource.owner_person_id = $4 OR EXISTS (
      SELECT 1 FROM work.activity_attendees attendee
      WHERE attendee.tenant_id = resource.tenant_id AND attendee.workspace_id = resource.workspace_id
        AND attendee.activity_id = resource.id AND attendee.person_id = $4)`;
  } else if (useSite.type === "initiative") {
    table = "work.initiatives";
    associationQuery = `resource.owner_person_id = $4 OR EXISTS (
      SELECT 1 FROM work.initiative_people contributor
      WHERE contributor.tenant_id = resource.tenant_id AND contributor.workspace_id = resource.workspace_id
        AND contributor.initiative_id = resource.id AND contributor.person_id = $4
        AND contributor.ended_at IS NULL)`;
  } else if (useSite.type === "relationship") {
    table = "work.relationships";
    associationQuery = `
      (resource.subject_type = 'person' AND resource.subject_id = $4)
      OR (resource.object_type = 'person' AND resource.object_id = $4)
      OR (resource.context_type = 'person' AND resource.context_id = $4)`;
  } else if (useSite.type === "organization") {
    table = "work.organizations";
    associationQuery = "true";
  } else if (useSite.type === "content_item") {
    table = "content.content_items";
    associationQuery = "true";
  } else if (useSite.type === "space") {
    const result = await tx.query<{
      space_id: string;
      access_class: "public" | "workspace" | "restricted" | "confidential";
    }>(
      `SELECT space.id AS space_id, space.access_class
       FROM access.spaces space
       JOIN identity.people person ON person.tenant_id = space.tenant_id
         AND person.workspace_id = space.workspace_id AND person.id = $4
       WHERE space.tenant_id = $1 AND space.workspace_id = $2 AND space.id = $3
         AND space.archived_at IS NULL LIMIT 1`,
      [context.tenantId, context.workspaceId, useSite.id, resource.id]
    );
    const row = result.rows[0];
    if (!row || !canReadDataClass(context.dataClassCeiling, row.access_class)) {
      return nonLeakingB1Deny(context.policyVersion);
    }
    const readable = await canReadSpaceResource(tx, context, row.space_id, role);
    return readable.allowed
      ? allow(context.policyVersion, "person_use_site_read", undefined, [readable.reasonCode])
      : nonLeakingB1Deny(context.policyVersion);
  } else return nonLeakingB1Deny(context.policyVersion);
  const result = await tx.query<{
    space_id: string;
    access_class: "public" | "workspace" | "restricted" | "confidential";
  }>(
    `SELECT resource.space_id, space.access_class
     FROM ${table} resource
     JOIN access.spaces space ON space.tenant_id = resource.tenant_id
       AND space.workspace_id = resource.workspace_id AND space.id = resource.space_id
     JOIN identity.people person ON person.tenant_id = resource.tenant_id
       AND person.workspace_id = resource.workspace_id AND person.id = $4
     WHERE resource.tenant_id = $1 AND resource.workspace_id = $2 AND resource.id = $3
       AND (${associationQuery}) LIMIT 1`,
    [context.tenantId, context.workspaceId, useSite.id, resource.id]
  );
  const row = result.rows[0];
  if (!row || !canReadDataClass(context.dataClassCeiling, row.access_class)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const readable = await canReadSpaceResource(tx, context, row.space_id, role);
  return readable.allowed
    ? allow(context.policyVersion, "person_use_site_read", undefined, [readable.reasonCode])
    : nonLeakingB1Deny(context.policyVersion);
}

async function hasContributorAuthority(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  spaceId: string,
  role: MembershipRole
): Promise<boolean> {
  if (role === "owner" || role === "admin") return true;
  const result = await tx.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM access.access_relationships grant_record
       WHERE grant_record.tenant_id = $1 AND grant_record.workspace_id = $2
         AND grant_record.resource_type = 'space' AND grant_record.resource_id = $3
         AND grant_record.relation IN ('owner','manager','contributor')
         AND ((grant_record.subject_type = 'membership' AND grant_record.subject_id = $4)
           OR (grant_record.subject_type = 'user' AND grant_record.subject_id = $5))
     ) AS allowed`,
    [context.tenantId, context.workspaceId, spaceId, context.actorMembershipId, context.actorUserId]
  );
  return result.rows[0]?.allowed === true;
}

function canReadDataClass(
  ceiling: "public" | "workspace" | "restricted" | "confidential",
  resource: "public" | "workspace" | "restricted" | "confidential"
): boolean {
  const rank = { public: 0, workspace: 1, restricted: 2, confidential: 3 } as const;
  return rank[resource] <= rank[ceiling];
}

function nonLeakingB1Deny(policyVersion: string): AuthorizationDecision {
  return deny(policyVersion, "b1_resource_not_available");
}

async function productOutboxRelayPublishDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  resource: ResourceRef,
  options: { explain?: boolean }
): Promise<AuthorizationDecision> {
  if (
    !context.servicePrincipalId ||
    context.actorUserId ||
    context.actorMembershipId ||
    context.agentPrincipalId ||
    context.delegatedByUserId ||
    context.delegatedByMembershipId
  ) {
    return deny(
      context.policyVersion,
      "product_relay_service_principal_required",
      "Product notification publication requires one non-delegated service principal"
    );
  }
  if (
    resource.type !== "space" ||
    context.requestedSpaceIds.length !== 1 ||
    context.requestedSpaceIds[0] !== resource.id
  ) {
    return deny(
      context.policyVersion,
      "product_relay_space_scope_mismatch",
      "Product notification publication is bound to one exact Space"
    );
  }

  const tenant = await tx.query<{ status: string }>(
    `SELECT status FROM identity.tenants
     WHERE id = $1 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [context.tenantId]
  );
  if (tenant.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "tenant_not_active", "Tenant is not active");
  }

  const workspace = await tx.query<{ status: string }>(
    `SELECT status FROM identity.workspaces
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [context.tenantId, context.workspaceId]
  );
  if (workspace.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "workspace_not_active", "Workspace is not active");
  }

  const policy = await tx.query<{ status: string }>(
    `SELECT status FROM identity.policy_versions
     WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [context.tenantId, context.workspaceId, context.policyVersion]
  );
  if (policy.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "policy_version_not_active", "Policy version is not active");
  }

  const principal = await tx.query<{ purpose: string; status: string }>(
    `SELECT purpose, status FROM identity.service_principals
     WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
       AND purpose = 'product_notification_relay' AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [context.tenantId, context.workspaceId, context.servicePrincipalId]
  );
  if (principal.rows[0]?.status !== "active") {
    return deny(
      context.policyVersion,
      "product_relay_principal_not_active",
      "Product notification relay principal is not active in the exact scope"
    );
  }
  if (principal.rows[0]?.purpose !== "product_notification_relay") {
    return deny(
      context.policyVersion,
      "product_relay_principal_wrong_purpose",
      "Service principal is not the notification-only product relay"
    );
  }

  const space = await tx.query<{ id: string }>(
    `SELECT id FROM access.spaces
     WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [context.tenantId, context.workspaceId, resource.id]
  );
  if (space.rows.length !== 1) {
    return deny(context.policyVersion, "space_not_found", "Space is not active in the exact scope");
  }

  const grant = await tx.query<{ id: string }>(
    `SELECT id FROM access.access_relationships
     WHERE tenant_id = $1 AND workspace_id = $2
       AND subject_type = 'service_principal' AND subject_id = $3
       AND relation = 'manager' AND resource_type = 'space' AND resource_id = $4
       AND source = 'direct'
     LIMIT 1
     FOR UPDATE`,
    [context.tenantId, context.workspaceId, context.servicePrincipalId, resource.id]
  );
  if (grant.rows.length !== 1) {
    return deny(
      context.policyVersion,
      "product_relay_direct_manager_required",
      "Product relay requires one live direct manager grant on the exact Space"
    );
  }

  return allow(
    context.policyVersion,
    "product_relay_direct_manager",
    options.explain
      ? "The notification-only product relay has a locked direct manager grant on the exact Space"
      : undefined,
    ["product_relay_direct_manager"]
  );
}

async function foundationWorkerConsumeDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  resource: ResourceRef,
  options: TransactionAuthorizationDecisionOptions
): Promise<AuthorizationDecision> {
  const binding = options.workerBinding;
  if (!binding) {
    return deny(
      context.policyVersion,
      "foundation_worker_binding_required",
      "Foundation worker consumption requires an exact transaction binding"
    );
  }

  const reference = await tx.query<{
    referenceId: string;
    status: string;
    revokedAt: Date | null;
    expiresAt: Date;
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    jobId: string;
    workerServicePrincipalId: string;
    policyVersionId: string;
    delegatingUserId: string;
    delegatingMembershipId: string;
  }>(
    `SELECT
       id AS "referenceId",
       status,
       revoked_at AS "revokedAt",
       expires_at AS "expiresAt",
       tenant_id AS "tenantId",
       workspace_id AS "workspaceId",
       space_id AS "spaceId",
       job_id AS "jobId",
       worker_service_principal_id AS "workerServicePrincipalId",
       policy_version_id AS "policyVersionId",
       delegating_user_id AS "delegatingUserId",
       delegating_membership_id AS "delegatingMembershipId"
     FROM ops.security_context_references
     WHERE id = $1
       AND job_id = $2
       AND tenant_id = $3
       AND workspace_id = $4
       AND space_id = $5
       AND worker_service_principal_id = $6
       AND policy_version_id = $7
       AND delegating_user_id = $8
       AND delegating_membership_id = $9
       AND status = 'active'
       AND revoked_at IS NULL
       AND expires_at > clock_timestamp()
     LIMIT 1
     FOR UPDATE`,
    workerBindingValues(binding)
  );

  if (!workerBindingMatchesContext(context, resource, binding)) {
    return deny(
      context.policyVersion,
      "foundation_worker_binding_mismatch",
      "Foundation worker transaction binding does not match the rehydrated context"
    );
  }
  const lockedReference = reference.rows[0];
  if (lockedReference && !workerBindingMatchesReference(binding, lockedReference)) {
    return deny(
      context.policyVersion,
      "foundation_worker_binding_mismatch",
      "Foundation worker transaction binding does not match the locked reference"
    );
  }
  if (
    !lockedReference ||
    lockedReference.status !== "active" ||
    lockedReference.revokedAt !== null ||
    new Date(lockedReference.expiresAt).getTime() <= Date.now()
  ) {
    return deny(
      context.policyVersion,
      "context_reference_not_active",
      "Worker context reference is not active"
    );
  }

  const tenant = await tx.query<{ status: string }>(
    `SELECT status FROM identity.tenants
     WHERE id = $1 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [binding.tenantId]
  );
  if (tenant.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "tenant_not_active", "Tenant is not active");
  }

  const workspace = await tx.query<{ status: string }>(
    `SELECT status FROM identity.workspaces
     WHERE id = $1 AND tenant_id = $2 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [binding.workspaceId, binding.tenantId]
  );
  if (workspace.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "workspace_not_active", "Workspace is not active");
  }

  const policy = await tx.query<{ status: string }>(
    `SELECT status FROM identity.policy_versions
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [binding.policyVersionId, binding.tenantId, binding.workspaceId]
  );
  if (policy.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "policy_version_not_active", "Policy version is not active");
  }

  const worker = await tx.query<{ purpose: string; status: string }>(
    `SELECT purpose, status FROM identity.service_principals
     WHERE id = $1
       AND tenant_id = $2
       AND workspace_id = $3
       AND purpose = 'worker'
       AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [binding.workerServicePrincipalId, binding.tenantId, binding.workspaceId]
  );
  if (worker.rows[0]?.status !== "active") {
    return deny(
      context.policyVersion,
      "worker_principal_not_active",
      "Worker principal is not active"
    );
  }
  if (worker.rows[0]?.purpose !== "worker") {
    return deny(
      context.policyVersion,
      "worker_principal_wrong_purpose",
      "Worker principal purpose must be worker"
    );
  }

  const user = await tx.query<{ status: string }>(
    `SELECT status FROM identity.users
     WHERE id = $1 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [binding.delegatingUserId]
  );
  if (user.rows[0]?.status !== "active") {
    return deny(
      context.policyVersion,
      "delegator_user_not_active",
      "Delegating user is not active"
    );
  }

  const membership = await tx.query<{ status: string; role: MembershipRole }>(
    `SELECT status, role FROM identity.memberships
     WHERE id = $1
       AND user_id = $2
       AND tenant_id = $3
       AND workspace_id = $4
       AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [
      binding.delegatingMembershipId,
      binding.delegatingUserId,
      binding.tenantId,
      binding.workspaceId
    ]
  );
  const delegator = membership.rows[0];
  if (!delegator || delegator.status !== "active") {
    return deny(
      context.policyVersion,
      "delegator_membership_not_active",
      "Delegating membership is not active"
    );
  }

  const space = await tx.query<{ id: string }>(
    `SELECT id FROM access.spaces
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND archived_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [binding.spaceId, binding.tenantId, binding.workspaceId]
  );
  if (space.rows.length !== 1) {
    return deny(context.policyVersion, "space_not_found", "Space is not active in the exact scope");
  }

  const workerGrant = await tx.query<{ relation: string; source: string }>(
    `SELECT relation, source FROM access.access_relationships
     WHERE subject_type = 'service_principal'
       AND subject_id = $1
       AND relation = 'contributor'
       AND resource_type = 'space'
       AND resource_id = $2
       AND source = 'direct'
       AND tenant_id = $3
       AND workspace_id = $4
     LIMIT 1
     FOR UPDATE`,
    [binding.workerServicePrincipalId, binding.spaceId, binding.tenantId, binding.workspaceId]
  );
  if (workerGrant.rows[0]?.relation !== "contributor" || workerGrant.rows[0]?.source !== "direct") {
    return deny(
      context.policyVersion,
      "worker_direct_contributor_required",
      "Worker requires a direct contributor grant on the exact Space"
    );
  }

  if (delegator.role !== "owner" && delegator.role !== "admin") {
    const delegatorGrant = await tx.query<{ id: string }>(
      `SELECT id FROM access.access_relationships
       WHERE subject_type IN ('membership', 'user')
         AND subject_id IN ($1, $2)
         AND relation IN ('owner', 'manager', 'contributor', 'viewer')
         AND resource_type = 'space'
         AND resource_id = $3
         AND source = 'direct'
         AND tenant_id = $4
         AND workspace_id = $5
       LIMIT 1
       FOR UPDATE`,
      [
        binding.delegatingMembershipId,
        binding.delegatingUserId,
        binding.spaceId,
        binding.tenantId,
        binding.workspaceId
      ]
    );
    if (delegatorGrant.rows.length !== 1) {
      return deny(
        context.policyVersion,
        "delegator_space_access_denied",
        "Delegator has no direct current-Space authority"
      );
    }
  }

  return allow(
    context.policyVersion,
    "foundation_worker_direct_contributor",
    options.explain
      ? "Active worker and delegator are authorized on the exact current Space"
      : undefined,
    ["worker_direct_contributor", "delegator_current_space_access"]
  );
}

function workerBindingValues(binding: WorkerAuthorizationBinding): readonly string[] {
  return [
    binding.referenceId,
    binding.jobId,
    binding.tenantId,
    binding.workspaceId,
    binding.spaceId,
    binding.workerServicePrincipalId,
    binding.policyVersionId,
    binding.delegatingUserId,
    binding.delegatingMembershipId
  ];
}

function workerBindingMatchesReference(
  binding: WorkerAuthorizationBinding,
  reference: {
    referenceId: string;
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    jobId: string;
    workerServicePrincipalId: string;
    policyVersionId: string;
    delegatingUserId: string;
    delegatingMembershipId: string;
  }
): boolean {
  return (
    binding.referenceId === reference.referenceId &&
    binding.tenantId === reference.tenantId &&
    binding.workspaceId === reference.workspaceId &&
    binding.spaceId === reference.spaceId &&
    binding.jobId === reference.jobId &&
    binding.workerServicePrincipalId === reference.workerServicePrincipalId &&
    binding.policyVersionId === reference.policyVersionId &&
    binding.delegatingUserId === reference.delegatingUserId &&
    binding.delegatingMembershipId === reference.delegatingMembershipId
  );
}

function workerBindingMatchesContext(
  context: SecurityContext,
  resource: ResourceRef,
  binding: WorkerAuthorizationBinding
): boolean {
  return (
    !context.actorUserId &&
    !context.actorMembershipId &&
    !context.agentPrincipalId &&
    context.servicePrincipalId === binding.workerServicePrincipalId &&
    context.delegatedByUserId === binding.delegatingUserId &&
    context.delegatedByMembershipId === binding.delegatingMembershipId &&
    context.tenantId === binding.tenantId &&
    context.workspaceId === binding.workspaceId &&
    context.policyVersion === binding.policyVersionId &&
    resource.type === "space" &&
    resource.id === binding.spaceId &&
    context.requestedSpaceIds.length === 1 &&
    context.requestedSpaceIds[0] === binding.spaceId
  );
}

async function foundationRelayPublishDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  resource: ResourceRef,
  options: { explain?: boolean }
): Promise<AuthorizationDecision> {
  if (
    !context.servicePrincipalId ||
    context.actorUserId ||
    context.actorMembershipId ||
    context.agentPrincipalId
  ) {
    return deny(
      context.policyVersion,
      "foundation_relay_service_principal_required",
      "Foundation relay publication requires one complete service principal"
    );
  }
  if (
    resource.type !== "space" ||
    context.requestedSpaceIds.length !== 1 ||
    context.requestedSpaceIds[0] !== resource.id
  ) {
    return deny(
      context.policyVersion,
      "foundation_space_scope_mismatch",
      "Foundation relay publication is bound to one exact requested Space"
    );
  }

  const tenant = await tx.query<{ status: string }>(
    `SELECT status FROM identity.tenants
     WHERE id = $1
     LIMIT 1
     FOR SHARE`,
    [context.tenantId]
  );
  if (tenant.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "tenant_not_active", "Tenant is not active");
  }

  const workspace = await tx.query<{ status: string }>(
    `SELECT status FROM identity.workspaces
     WHERE id = $1 AND tenant_id = $2
     LIMIT 1
     FOR SHARE`,
    [context.workspaceId, context.tenantId]
  );
  if (workspace.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "workspace_not_active", "Workspace is not active");
  }

  const policy = await tx.query<{ status: string }>(
    `SELECT status FROM identity.policy_versions
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
     LIMIT 1
     FOR SHARE`,
    [context.policyVersion, context.tenantId, context.workspaceId]
  );
  if (policy.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "policy_version_not_active", "Policy version is not active");
  }

  const principal = await tx.query<{ purpose: string; status: string }>(
    `SELECT purpose, status FROM identity.service_principals
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
     LIMIT 1
     FOR SHARE`,
    [context.servicePrincipalId, context.tenantId, context.workspaceId]
  );
  if (principal.rows[0]?.status !== "active") {
    return deny(
      context.policyVersion,
      "relay_principal_not_active",
      "Relay service principal is not active in the exact scope"
    );
  }
  if (principal.rows[0]?.purpose !== "system") {
    return deny(
      context.policyVersion,
      "relay_principal_wrong_purpose",
      "Relay service principal purpose must be system"
    );
  }

  const space = await tx.query<{ id: string }>(
    `SELECT id FROM access.spaces
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND archived_at IS NULL
     LIMIT 1
     FOR SHARE`,
    [resource.id, context.tenantId, context.workspaceId]
  );
  if (!space.rows[0]) {
    return deny(context.policyVersion, "space_not_found", "Space is not active in the exact scope");
  }

  const grant = await tx.query<{ id: string }>(
    `SELECT id FROM access.access_relationships
     WHERE tenant_id = $1
       AND workspace_id = $2
       AND subject_type = 'service_principal'
       AND subject_id = $3
       AND relation = 'manager'
       AND resource_type = 'space'
       AND resource_id = $4
       AND source = 'direct'
     LIMIT 1
     FOR SHARE`,
    [context.tenantId, context.workspaceId, context.servicePrincipalId, resource.id]
  );
  if (!grant.rows[0]) {
    return deny(
      context.policyVersion,
      "relay_direct_manager_required",
      "Relay service principal requires a direct manager grant on the exact Space"
    );
  }

  return allow(
    context.policyVersion,
    "foundation_relay_direct_manager",
    options.explain
      ? "Active system relay principal has a direct manager grant on the exact Space"
      : undefined,
    ["direct_manager_space_grant"]
  );
}

async function foundationProofCreateDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  resource: ResourceRef,
  options: { explain?: boolean }
): Promise<AuthorizationDecision> {
  if (
    context.servicePrincipalId ||
    context.agentPrincipalId ||
    !context.actorUserId ||
    !context.actorMembershipId
  ) {
    return deny(
      context.policyVersion,
      "foundation_human_actor_required",
      "Foundation proof creation requires a complete human user and membership actor"
    );
  }
  if (
    resource.type !== "space" ||
    context.requestedSpaceIds.length !== 1 ||
    context.requestedSpaceIds[0] !== resource.id
  ) {
    return deny(
      context.policyVersion,
      "foundation_space_scope_mismatch",
      "Foundation proof creation is bound to one exact requested Space"
    );
  }

  const tenant = await tx.query<{ status: string }>(
    `SELECT status FROM identity.tenants
     WHERE id = $1
     LIMIT 1
     FOR SHARE`,
    [context.tenantId]
  );
  if (tenant.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "tenant_not_active", "Tenant is not active");
  }

  const workspace = await tx.query<{ status: string }>(
    `SELECT status FROM identity.workspaces
     WHERE id = $1 AND tenant_id = $2
     LIMIT 1
     FOR SHARE`,
    [context.workspaceId, context.tenantId]
  );
  if (workspace.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "workspace_not_active", "Workspace is not active");
  }

  const policy = await tx.query<{ status: string }>(
    `SELECT status FROM identity.policy_versions
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
     LIMIT 1
     FOR SHARE`,
    [context.policyVersion, context.tenantId, context.workspaceId]
  );
  if (policy.rows[0]?.status !== "active") {
    return deny(context.policyVersion, "policy_version_not_active", "Policy version is not active");
  }

  const membership = await tx.query<MembershipRecord>(
    `SELECT m.role, m.status AS membership_status, u.status AS user_status
     FROM identity.memberships m
     JOIN identity.users u ON u.id = m.user_id
     WHERE m.id = $1
       AND m.user_id = $2
       AND m.tenant_id = $3
       AND m.workspace_id = $4
       AND m.person_id IS NOT NULL
     LIMIT 1
     FOR SHARE OF m, u`,
    [context.actorMembershipId, context.actorUserId, context.tenantId, context.workspaceId]
  );
  const actor = membership.rows[0];
  if (!actor || actor.user_status !== "active" || actor.membership_status !== "active") {
    return deny(
      context.policyVersion,
      "foundation_actor_not_active",
      "User and membership must both be active"
    );
  }
  if (actor.role !== "owner" && actor.role !== "admin") {
    return deny(
      context.policyVersion,
      "role_denied",
      "Only owners or admins may create the Foundation proof"
    );
  }

  const space = await tx.query<{ id: string }>(
    `SELECT id FROM access.spaces
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND archived_at IS NULL
     LIMIT 1
     FOR SHARE`,
    [resource.id, context.tenantId, context.workspaceId]
  );
  if (!space.rows[0]) {
    return deny(
      context.policyVersion,
      "space_not_found",
      "Space is not visible in the current workspace"
    );
  }

  const canReadSpace = await canReadSpaceResource(tx, context, resource.id, actor.role, {
    lockedTarget: space.rows[0]
  });
  if (!canReadSpace.allowed) {
    return deny(context.policyVersion, canReadSpace.reasonCode, canReadSpace.explanation);
  }

  return allow(
    context.policyVersion,
    "foundation_owner_or_admin_space_authorized",
    options.explain ? "Active owner or admin is authorized on the exact current Space" : undefined,
    [canReadSpace.reasonCode]
  );
}

async function loadActivePolicyVersion(
  tx: TenantQueryExecutor,
  context: SecurityContext
): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `
    SELECT id
    FROM identity.policy_versions
    WHERE id = $1
      AND tenant_id = $2
      AND workspace_id = $3
      AND status = 'active'
    LIMIT 1
    FOR SHARE
    `,
    [context.policyVersion, context.tenantId, context.workspaceId]
  );

  return result.rows.length === 1;
}

async function loadActiveMembership(
  tx: TenantQueryExecutor,
  context: SecurityContext
): Promise<MembershipRecord | undefined> {
  const result = await tx.query<MembershipRecord>(
    `
    SELECT m.role, m.status AS membership_status, u.status AS user_status
    FROM identity.memberships m
    JOIN identity.users u ON u.id = m.user_id
    WHERE m.id = $1
      AND m.user_id = $2
      AND m.tenant_id = $3
      AND m.workspace_id = $4
      AND m.person_id IS NOT NULL
    LIMIT 1
    `,
    [context.actorMembershipId, context.actorUserId, context.tenantId, context.workspaceId]
  );

  return result.rows[0];
}

async function canReadSpaceResource(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  spaceId: string,
  role: MembershipRole,
  options: { lockedTarget?: { id: string } } = {}
): Promise<{ allowed: boolean; reasonCode: string; explanation?: string }> {
  if (role === "owner" || role === "admin") {
    if (options.lockedTarget) {
      return options.lockedTarget.id === spaceId
        ? { allowed: true, reasonCode: "workspace_admin_space_read" }
        : {
            allowed: false,
            reasonCode: "space_not_found",
            explanation: "Space is not visible in the current workspace"
          };
    }
    const exists = await tx.query<{ id: string }>(
      `
      SELECT id
      FROM access.spaces
      WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND archived_at IS NULL
      LIMIT 1
      `,
      [spaceId, context.tenantId, context.workspaceId]
    );
    return exists.rows.length > 0
      ? { allowed: true, reasonCode: "workspace_admin_space_read" }
      : {
          allowed: false,
          reasonCode: "space_not_found",
          explanation: "Space is not visible in the current workspace"
        };
  }

  const result = await tx.query<{
    is_root: boolean;
    target_restricted: boolean;
    has_direct_grant: boolean;
    has_inherited_grant: boolean;
  }>(
    `
    WITH RECURSIVE target AS (
      SELECT id, parent_space_id, kind, inheritance_mode
      FROM access.spaces
      WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND archived_at IS NULL
    ),
    ancestors AS (
      SELECT id, parent_space_id, inheritance_mode, 0 AS depth
      FROM target
      UNION ALL
      SELECT s.id, s.parent_space_id, s.inheritance_mode, ancestors.depth + 1
      FROM access.spaces s
      JOIN ancestors ON ancestors.parent_space_id = s.id
      WHERE s.tenant_id = $2 AND s.workspace_id = $3 AND s.archived_at IS NULL
    )
    SELECT
      EXISTS (SELECT 1 FROM target WHERE kind = 'workspace_root') AS is_root,
      EXISTS (SELECT 1 FROM target WHERE inheritance_mode = 'restricted') AS target_restricted,
      EXISTS (
        SELECT 1
        FROM access.access_relationships ar
        WHERE ar.resource_type = 'space'
          AND ar.resource_id = $1
          AND ar.relation IN ('owner', 'manager', 'contributor', 'viewer')
          AND (
            (ar.subject_type = 'membership' AND ar.subject_id = $4)
            OR (ar.subject_type = 'user' AND ar.subject_id = $5)
          )
      ) AS has_direct_grant,
      EXISTS (
        SELECT 1
        FROM ancestors a
        JOIN access.access_relationships ar ON ar.resource_type = 'space' AND ar.resource_id = a.id
        WHERE a.depth > 0
          AND NOT EXISTS (
            SELECT 1
            FROM ancestors boundary
            WHERE boundary.depth < a.depth
              AND boundary.inheritance_mode = 'restricted'
          )
          AND ar.relation IN ('owner', 'manager', 'contributor', 'viewer')
          AND (
            (ar.subject_type = 'membership' AND ar.subject_id = $4)
            OR (ar.subject_type = 'user' AND ar.subject_id = $5)
          )
      ) AS has_inherited_grant
    FROM target
    LIMIT 1
    `,
    [spaceId, context.tenantId, context.workspaceId, context.actorMembershipId, context.actorUserId]
  );

  const access = result.rows[0];
  if (!access) {
    return {
      allowed: false,
      reasonCode: "space_not_found",
      explanation: "Space is not visible in the current workspace"
    };
  }
  if (access.is_root) {
    return { allowed: true, reasonCode: "workspace_root_read" };
  }
  if (access.has_direct_grant) {
    return { allowed: true, reasonCode: "direct_space_grant" };
  }
  if (!access.target_restricted && access.has_inherited_grant) {
    return { allowed: true, reasonCode: "inherited_space_grant" };
  }

  return {
    allowed: false,
    reasonCode: "space_access_denied",
    explanation: "No current Space grant authorizes this action"
  };
}

function ownerOrAdminDecision(
  policyVersion: string,
  role: MembershipRole,
  reasonCode: string
): AuthorizationDecision {
  return role === "owner" || role === "admin"
    ? allow(policyVersion, reasonCode)
    : deny(policyVersion, "role_denied", "Only owners or admins may perform this action");
}

function parseContextForDecision(
  context: SecurityContext
): { ok: true; context: SecurityContext } | { ok: false; reasonCode: string; explanation: string } {
  try {
    return { ok: true, context: parseSecurityContext(context) };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "invalid_context",
      explanation: error instanceof Error ? error.message : "SecurityContext validation failed"
    };
  }
}

function allow(
  policyVersion: string,
  reasonCode: string,
  explanation?: string,
  evaluatedRelationships?: string[]
): AuthorizationDecision {
  return {
    allowed: true,
    reasonCode,
    ...(explanation ? { explanation } : {}),
    policyVersion,
    ...(evaluatedRelationships ? { evaluatedRelationships } : {})
  };
}

function deny(
  policyVersion: string,
  reasonCode: string,
  explanation?: string
): AuthorizationDecision {
  return {
    allowed: false,
    reasonCode,
    ...(explanation ? { explanation } : {}),
    policyVersion
  };
}
