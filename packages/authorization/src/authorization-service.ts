import type { AuthorizationDecision, ResourceRef, SecurityContext } from "@throughline/core-types";
import type { PgPool, TenantQueryExecutor } from "@throughline/db";
import { withTenantTransaction } from "@throughline/db";
import { isSecurityContextExpired, parseSecurityContext } from "@throughline/tenancy";
import type { AuthorizationAction, AuthorizationService } from "./types.js";

type MembershipRole = "owner" | "admin" | "member" | "viewer";

interface MembershipRecord {
  role: MembershipRole;
  membership_status: "invited" | "active" | "suspended";
  user_status: "active" | "disabled";
}

export class PostgresAuthorizationService implements AuthorizationService {
  constructor(private readonly pool: PgPool) {}

  async can(
    inputContext: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    options: { explain?: boolean } = {}
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

    if (context.servicePrincipalId || context.agentPrincipalId) {
      return deny(
        context.policyVersion,
        "principal_default_denied",
        "Service and agent principals have no A2 allow rules"
      );
    }

    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
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
    });
  }
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
  role: MembershipRole
): Promise<{ allowed: boolean; reasonCode: string; explanation?: string }> {
  if (role === "owner" || role === "admin") {
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
