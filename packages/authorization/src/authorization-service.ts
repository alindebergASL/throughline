import type {
  AccessClass,
  AuthorizationDecision,
  ResourceRef,
  SecurityContext
} from "@throughline/core-types";
import type { PgPool, TenantQueryExecutor } from "@throughline/db";
import { withTenantTransaction } from "@throughline/db";
import { isSecurityContextExpired, parseSecurityContext } from "@throughline/tenancy";
import type {
  AuthorizationAction,
  AuthorizationDecisionOptions,
  RelationshipAuthorityBatchingAuthorizationService,
  RelationshipAuthorityRequest,
  TransactionAuthorizationDecisionOptions,
  WorkerAuthorizationBinding
} from "./types.js";

type MembershipRole = "owner" | "admin" | "member" | "viewer";

interface MembershipRecord {
  membership_id?: string;
  user_id?: string;
  person_id?: string;
  role: MembershipRole;
  membership_status: "invited" | "active" | "suspended";
  user_status: "active" | "disabled";
}

interface PolicyAuthorityRecord {
  id: string;
  status: "active";
}

interface RelationshipAuthoritySpaceRow {
  id: string;
  parent_space_id: string | null;
  kind: string;
  access_class: AccessClass;
  inheritance_mode: "inherit" | "restricted";
}

interface RelationshipAuthorityGrantRow {
  id: string;
  resource_id: string;
  resource_type: "space";
  subject_type: "membership" | "user";
  subject_id: string;
  relation: "owner" | "manager" | "contributor" | "viewer";
}

interface RelationshipAuthorityDiscovery {
  spaces: Map<string, RelationshipAuthoritySpaceRow>;
  grants: Map<string, RelationshipAuthorityGrantRow>;
  paths: Map<string, readonly string[]>;
  inconsistent: boolean;
}

export class PostgresAuthorizationService implements RelationshipAuthorityBatchingAuthorizationService {
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

  async lockAndReauthorizeRelationshipAuthorityInTransaction(
    inputContext: SecurityContext,
    requests: readonly RelationshipAuthorityRequest[],
    tx: TenantQueryExecutor
  ): Promise<AuthorizationDecision> {
    return lockAndReauthorizeRelationshipAuthority(tx, inputContext, requests);
  }

  async preauthorizeRelationshipEndInTransaction(
    inputContext: SecurityContext,
    resource: ResourceRef & { type: "relationship" },
    tx: TenantQueryExecutor
  ): Promise<AuthorizationDecision> {
    return preauthorizeRelationshipEnd(tx, inputContext, resource);
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

    const hasActivePolicyVersion = await loadActivePolicyVersion(tx, context, true);
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

    const membership = await loadActiveMembership(tx, context, options.lockAuthority === true);
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
      return b1Decision(
        tx,
        context,
        membership.role,
        action,
        resource,
        options,
        undefined,
        membership
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

    const canReadSpace = await canReadSpaceResource(tx, context, resource.id, membership.role, {
      lockAuthority: options.lockAuthority === true
    });
    if (!canReadSpace.allowed) {
      return deny(context.policyVersion, canReadSpace.reasonCode, canReadSpace.explanation);
    }

    if (action === "space.read") {
      return allow(
        context.policyVersion,
        canReadSpace.reasonCode,
        options.explain ? canReadSpace.explanation : undefined,
        canReadSpace.authorityTokens
      );
    }

    if (action === "space.create_child" || action === "space.manage_access") {
      return ownerOrAdminDecision(context.policyVersion, membership.role, action);
    }

    return deny(context.policyVersion, "unsupported_action", "Action is not implemented in A2");
  }
}

async function preauthorizeRelationshipEnd(
  tx: TenantQueryExecutor,
  inputContext: SecurityContext,
  resource: ResourceRef & { type: "relationship" }
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
    return nonLeakingB1Deny(context.policyVersion);
  }
  const policy = await loadActivePolicyRecord(tx, context, false);
  const membership = await loadActiveMembership(tx, context, false);
  if (
    !policy ||
    !membership ||
    membership.membership_status !== "active" ||
    membership.user_status !== "active"
  ) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  return b1Decision(tx, context, membership.role, "relationship.end", resource, {});
}

async function lockAndReauthorizeRelationshipAuthority(
  tx: TenantQueryExecutor,
  inputContext: SecurityContext,
  inputRequests: readonly RelationshipAuthorityRequest[]
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
  if (
    !context.actorUserId ||
    !context.actorMembershipId ||
    context.servicePrincipalId ||
    context.agentPrincipalId
  ) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const requests = normalizeRelationshipAuthorityRequests(inputRequests);
  if (!requests) return nonLeakingB1Deny(context.policyVersion);

  const expectedPolicy = await loadActivePolicyRecord(tx, context, false);
  const expectedMembership = await loadActiveMembership(tx, context, false);
  const expectedActor = exactHumanAuthorityActor(context, expectedMembership);
  if (!expectedPolicy || !expectedActor) return nonLeakingB1Deny(context.policyVersion);

  const expectedDiscovery = createRelationshipAuthorityDiscovery();
  const expectedDecisions = await evaluateRelationshipAuthorityRequests(
    tx,
    context,
    expectedActor.role,
    requests,
    expectedDiscovery
  );
  if (
    expectedDiscovery.inconsistent ||
    expectedDecisions.some(({ decision }) => !decision.allowed)
  ) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const expectedSnapshot = relationshipAuthoritySnapshot(
    expectedPolicy,
    expectedActor,
    expectedDiscovery,
    expectedDecisions
  );
  const expectedSpaces = [...expectedDiscovery.spaces.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const expectedGrants = [...expectedDiscovery.grants.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );

  const lockedPolicy = await loadActivePolicyRecord(tx, context, true);
  if (!lockedPolicy || !sameAuthorityValue(lockedPolicy, expectedPolicy)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const lockedMembership = await loadActiveMembership(tx, context, true);
  const lockedActor = exactHumanAuthorityActor(context, lockedMembership);
  if (!lockedActor || !sameAuthorityValue(lockedActor, expectedActor)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const lockedSpaces = await lockRelationshipAuthoritySpaces(
    tx,
    context,
    expectedSpaces.map(({ id }) => id)
  );
  if (!sameAuthorityValue(lockedSpaces, expectedSpaces)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const lockedGrants = await lockRelationshipAuthorityGrants(
    tx,
    context,
    expectedGrants.map(({ id }) => id)
  );
  if (!sameAuthorityValue(lockedGrants, expectedGrants)) {
    return nonLeakingB1Deny(context.policyVersion);
  }

  const currentDiscovery = createRelationshipAuthorityDiscovery();
  const currentDecisions = await evaluateRelationshipAuthorityRequests(
    tx,
    context,
    lockedActor.role,
    requests,
    currentDiscovery
  );
  if (currentDiscovery.inconsistent || currentDecisions.some(({ decision }) => !decision.allowed)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const currentSnapshot = relationshipAuthoritySnapshot(
    lockedPolicy,
    lockedActor,
    currentDiscovery,
    currentDecisions
  );
  if (!sameAuthorityValue(currentSnapshot, expectedSnapshot)) {
    return nonLeakingB1Deny(context.policyVersion);
  }

  const authorityTokens = [
    ...new Set(currentDecisions.flatMap(({ decision }) => decision.evaluatedRelationships ?? []))
  ].sort();
  return allow(context.policyVersion, "relationship_authority_batch", undefined, authorityTokens);
}

function normalizeRelationshipAuthorityRequests(
  requests: readonly RelationshipAuthorityRequest[]
): RelationshipAuthorityRequest[] | undefined {
  const expectedResourceTypes: Record<RelationshipAuthorityRequest["action"], ResourceRef["type"]> =
    {
      "relationship.end": "relationship",
      "space.read": "space",
      "person.read": "person",
      "organization.read": "organization",
      "initiative.read": "initiative",
      "activity.read": "activity",
      "content.read": "content_item"
    };
  const unique = new Map<string, RelationshipAuthorityRequest>();
  for (const request of requests) {
    if (expectedResourceTypes[request.action] !== request.resource.type) return undefined;
    if (request.action === "person.read" && request.personUseSite.type !== "relationship") {
      return undefined;
    }
    unique.set(relationshipAuthorityRequestKey(request), request);
  }
  const normalized = [...unique.values()].sort((left, right) =>
    relationshipAuthorityRequestKey(left).localeCompare(relationshipAuthorityRequestKey(right))
  );
  const relationshipRequests = normalized.filter(
    (request): request is Extract<RelationshipAuthorityRequest, { action: "relationship.end" }> =>
      request.action === "relationship.end"
  );
  if (relationshipRequests.length !== 1) return undefined;
  const relationshipId = relationshipRequests[0]!.resource.id;
  if (
    normalized.some(
      (request) => request.action === "person.read" && request.personUseSite.id !== relationshipId
    )
  ) {
    return undefined;
  }
  return normalized;
}

function relationshipAuthorityRequestKey(request: RelationshipAuthorityRequest): string {
  return `${request.action}:${request.resource.type}:${request.resource.id}:${
    request.action === "person.read" ? request.personUseSite.id : ""
  }`;
}

async function evaluateRelationshipAuthorityRequests(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  role: MembershipRole,
  requests: readonly RelationshipAuthorityRequest[],
  discovery: RelationshipAuthorityDiscovery
): Promise<Array<{ key: string; decision: AuthorizationDecision }>> {
  const decisions: Array<{ key: string; decision: AuthorizationDecision }> = [];
  for (const request of requests) {
    const decision =
      request.action === "space.read"
        ? await relationshipSpaceReadDecision(tx, context, role, request.resource, discovery)
        : await b1Decision(
            tx,
            context,
            role,
            request.action,
            request.resource,
            request.action === "person.read" ? { personUseSite: request.personUseSite } : {},
            discovery
          );
    decisions.push({ key: relationshipAuthorityRequestKey(request), decision });
  }
  return decisions;
}

async function relationshipSpaceReadDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  role: MembershipRole,
  resource: ResourceRef & { type: "space" },
  discovery: RelationshipAuthorityDiscovery
): Promise<AuthorizationDecision> {
  const readable = await canReadSpaceResource(tx, context, resource.id, role, {
    authorityDiscovery: discovery
  });
  return readable.allowed
    ? allow(context.policyVersion, readable.reasonCode, undefined, readable.authorityTokens)
    : nonLeakingB1Deny(context.policyVersion);
}

function createRelationshipAuthorityDiscovery(): RelationshipAuthorityDiscovery {
  return { spaces: new Map(), grants: new Map(), paths: new Map(), inconsistent: false };
}

function exactHumanAuthorityActor(
  context: SecurityContext,
  membership: MembershipRecord | undefined
):
  | {
      membershipId: string;
      userId: string;
      personId: string;
      role: MembershipRole;
      membershipStatus: "active";
      userStatus: "active";
    }
  | undefined {
  if (
    !membership ||
    !context.actorMembershipId ||
    !context.actorUserId ||
    membership.membership_id !== context.actorMembershipId ||
    membership.user_id !== context.actorUserId ||
    !membership.person_id ||
    membership.membership_status !== "active" ||
    membership.user_status !== "active"
  ) {
    return undefined;
  }
  return {
    membershipId: membership.membership_id,
    userId: membership.user_id,
    personId: membership.person_id,
    role: membership.role,
    membershipStatus: membership.membership_status,
    userStatus: membership.user_status
  };
}

function relationshipAuthoritySnapshot(
  policy: PolicyAuthorityRecord,
  actor: NonNullable<ReturnType<typeof exactHumanAuthorityActor>>,
  discovery: RelationshipAuthorityDiscovery,
  decisions: readonly { key: string; decision: AuthorizationDecision }[]
) {
  return {
    policy,
    actor,
    spaces: [...discovery.spaces.values()].sort((left, right) => left.id.localeCompare(right.id)),
    grants: [...discovery.grants.values()].sort((left, right) => left.id.localeCompare(right.id)),
    paths: [...discovery.paths.entries()].sort(([left], [right]) => left.localeCompare(right)),
    decisions: decisions.map(({ key, decision }) => ({
      key,
      authorityTokens: [...(decision.evaluatedRelationships ?? [])].sort()
    }))
  };
}

function sameAuthorityValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  "source.read",
  "claim.create",
  "claim.read",
  "fact.read",
  "fact.accept"
]);

function isB1Action(action: AuthorizationAction): boolean {
  return b1Actions.has(action);
}

const truthMutationActions = new Set<AuthorizationAction>(["claim.create", "fact.accept"]);

function isTruthMutationAction(action: AuthorizationAction): boolean {
  return truthMutationActions.has(action);
}

async function truthMutationDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  role: MembershipRole,
  action: AuthorizationAction,
  resource: ResourceRef,
  options: TransactionAuthorizationDecisionOptions,
  membership: MembershipRecord | undefined
): Promise<AuthorizationDecision> {
  const actor = exactHumanAuthorityActor(context, membership);
  if (!actor || context.actorDisplayPersonId !== actor.personId) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const target = await loadTruthAuthorityTarget(tx, context, action, resource, options);
  if (!target || !canReadDataClass(context.dataClassCeiling, target.accessClass)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const readable = await canReadSpaceResource(tx, context, target.spaceId, role, {
    lockAuthority: options.lockAuthority === true
  });
  if (!readable.allowed) return nonLeakingB1Deny(context.policyVersion);

  if (action === "claim.create") {
    const contributor = await contributorAuthority(
      tx,
      context,
      target.spaceId,
      role,
      options.lockAuthority === true
    );
    return contributor.allowed
      ? allow(context.policyVersion, "b2_live_contributor", undefined, [
          ...readable.authorityTokens,
          ...contributor.authorityTokens
        ])
      : nonLeakingB1Deny(context.policyVersion);
  }

  return target.ownerPersonId === actor.personId
    ? allow(
        context.policyVersion,
        target.subjectType === "activity" ? "b2_activity_owner" : "b2_initiative_owner",
        undefined,
        readable.authorityTokens
      )
    : nonLeakingB1Deny(context.policyVersion);
}

async function loadTruthAuthorityTarget(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  action: AuthorizationAction,
  resource: ResourceRef,
  options: TransactionAuthorizationDecisionOptions
): Promise<
  | {
      spaceId: string;
      accessClass: AccessClass;
      subjectType: "activity" | "initiative";
      ownerPersonId: string;
    }
  | undefined
> {
  if (action !== "claim.create" && action !== "fact.accept") return undefined;
  if (resource.type !== "activity" && resource.type !== "initiative") return undefined;
  const subjectType = resource.type;
  const subjectId = resource.id;
  const table = subjectType === "activity" ? "work.activities" : "work.initiatives";
  const subject = await tx.query<{
    space_id: string;
    owner_person_id: string;
    access_class: AccessClass;
  }>(
    `SELECT subject.space_id, subject.owner_person_id, space.access_class
     FROM ${table} subject
     JOIN access.spaces space
       ON space.tenant_id = subject.tenant_id
      AND space.workspace_id = subject.workspace_id
      AND space.id = subject.space_id
     WHERE subject.tenant_id = $1 AND subject.workspace_id = $2
       AND subject.id = $3 AND space.archived_at IS NULL
     LIMIT 1 ${options.lockAuthority === true ? "FOR SHARE OF subject, space" : ""}`,
    [context.tenantId, context.workspaceId, subjectId]
  );
  const row = subject.rows[0];
  if (!row) return undefined;
  return {
    spaceId: row.space_id,
    accessClass: row.access_class,
    subjectType,
    ownerPersonId: row.owner_person_id
  };
}

async function b1Decision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  role: MembershipRole,
  action: AuthorizationAction,
  resource: ResourceRef,
  options: TransactionAuthorizationDecisionOptions,
  authorityDiscovery?: RelationshipAuthorityDiscovery,
  membership?: MembershipRecord
): Promise<AuthorizationDecision> {
  if (action === "person.read") {
    return personReadDecision(tx, context, role, resource, options, authorityDiscovery);
  }
  if (isTruthMutationAction(action)) {
    return truthMutationDecision(tx, context, role, action, resource, options, membership);
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
    if (accessClass && options.requestedAccessClass) {
      accessClass = maxDataClass(accessClass, options.requestedAccessClass);
    }
  } else {
    const loaded = await loadB1ResourceScope(tx, context, action, resource, options);
    spaceId = loaded?.spaceId;
    accessClass = loaded?.accessClass;
  }
  if (!spaceId || !accessClass || !canReadDataClass(context.dataClassCeiling, accessClass)) {
    return nonLeakingB1Deny(context.policyVersion);
  }
  const readable = await canReadSpaceResource(tx, context, spaceId, role, {
    lockAuthority: options.lockAuthority === true,
    ...(authorityDiscovery ? { authorityDiscovery } : {})
  });
  if (!readable.allowed) return nonLeakingB1Deny(context.policyVersion);

  const readActions = new Set<AuthorizationAction>([
    "organization.read",
    "initiative.read",
    "activity.read",
    "relationship.read",
    "content.read",
    "source.read",
    "claim.read",
    "fact.read"
  ]);
  if (readActions.has(action)) {
    return allow(
      context.policyVersion,
      "b1_resource_read",
      options.explain ? "Current Space and data-class access allow this projection" : undefined,
      readable.authorityTokens
    );
  }
  if (action === "source.tombstone" || action === "organization.create") {
    return ownerOrAdminDecision(context.policyVersion, role, "b1_workspace_authority");
  }
  const contributor = await contributorAuthority(
    tx,
    context,
    spaceId,
    role,
    options.lockAuthority === true,
    authorityDiscovery
  );
  return contributor.allowed
    ? allow(context.policyVersion, "b1_contributor_authority", undefined, [
        ...readable.authorityTokens,
        ...contributor.authorityTokens
      ])
    : deny(context.policyVersion, "b1_resource_not_available");
}

async function loadB1ResourceScope(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  action: AuthorizationAction,
  resource: ResourceRef,
  options: TransactionAuthorizationDecisionOptions
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
  else if (action.startsWith("claim.")) [table, expectedType] = ["truth.claims", "claim"];
  else if (action.startsWith("fact.")) [table, expectedType] = ["truth.accepted_facts", "fact"];
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
         WHERE source.tenant_id = $1 AND source.workspace_id = $2 AND source.id = $3
         LIMIT 1`
      : table.startsWith("truth.")
        ? `SELECT resource.space_id,
             CASE GREATEST(
               CASE space.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END,
               CASE resource.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END
             ) WHEN 0 THEN 'public' WHEN 1 THEN 'workspace' WHEN 2 THEN 'restricted' ELSE 'confidential' END AS access_class
           FROM ${table} resource
           JOIN access.spaces space ON space.tenant_id = resource.tenant_id
             AND space.workspace_id = resource.workspace_id AND space.id = resource.space_id
           WHERE resource.tenant_id = $1 AND resource.workspace_id = $2 AND resource.id = $3
           LIMIT 1`
        : table === "content.content_items" && options.contentRevision !== undefined
          ? `SELECT resource.space_id,
             CASE GREATEST(
               CASE space.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END,
               CASE resource.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END,
               CASE revision.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END
             ) WHEN 0 THEN 'public' WHEN 1 THEN 'workspace' WHEN 2 THEN 'restricted' ELSE 'confidential' END AS access_class
           FROM content.content_items resource
           JOIN content.content_revisions revision
             ON revision.tenant_id = resource.tenant_id
            AND revision.workspace_id = resource.workspace_id
            AND revision.space_id = resource.space_id
            AND revision.content_item_id = resource.id
            AND revision.revision_number = $4
           JOIN access.spaces space ON space.tenant_id = resource.tenant_id
             AND space.workspace_id = resource.workspace_id AND space.id = resource.space_id
           WHERE resource.tenant_id = $1 AND resource.workspace_id = $2 AND resource.id = $3
             AND ($5::uuid IS NULL OR resource.space_id = $5)
           LIMIT 1`
          : table === "content.content_items"
            ? `SELECT resource.space_id,
               CASE GREATEST(
                 CASE space.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END,
                 CASE resource.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1 WHEN 'restricted' THEN 2 ELSE 3 END
               ) WHEN 0 THEN 'public' WHEN 1 THEN 'workspace' WHEN 2 THEN 'restricted' ELSE 'confidential' END AS access_class
             FROM content.content_items resource
             JOIN access.spaces space ON space.tenant_id = resource.tenant_id
               AND space.workspace_id = resource.workspace_id AND space.id = resource.space_id
             WHERE resource.tenant_id = $1 AND resource.workspace_id = $2 AND resource.id = $3
             LIMIT 1`
            : `SELECT resource.space_id, space.access_class
             FROM ${table} resource
             JOIN access.spaces space ON space.tenant_id = resource.tenant_id
               AND space.workspace_id = resource.workspace_id AND space.id = resource.space_id
             WHERE resource.tenant_id = $1 AND resource.workspace_id = $2 AND resource.id = $3
             LIMIT 1`,
    table === "content.content_items" && options.contentRevision !== undefined
      ? [
          context.tenantId,
          context.workspaceId,
          resource.id,
          options.contentRevision,
          options.requiredSpaceId ?? null
        ]
      : [context.tenantId, context.workspaceId, resource.id]
  );
  const row = result.rows[0];
  return row ? { spaceId: row.space_id, accessClass: row.access_class } : undefined;
}

async function personReadDecision(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  role: MembershipRole,
  resource: ResourceRef,
  options: TransactionAuthorizationDecisionOptions,
  authorityDiscovery?: RelationshipAuthorityDiscovery
): Promise<AuthorizationDecision> {
  const useSite = options.personUseSite;
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
    const readable = await canReadSpaceResource(tx, context, row.space_id, role, {
      lockAuthority: options.lockAuthority === true,
      ...(authorityDiscovery ? { authorityDiscovery } : {})
    });
    return readable.allowed
      ? allow(context.policyVersion, "person_use_site_read", undefined, readable.authorityTokens)
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
  const readable = await canReadSpaceResource(tx, context, row.space_id, role, {
    lockAuthority: options.lockAuthority === true,
    ...(authorityDiscovery ? { authorityDiscovery } : {})
  });
  return readable.allowed
    ? allow(context.policyVersion, "person_use_site_read", undefined, readable.authorityTokens)
    : nonLeakingB1Deny(context.policyVersion);
}

async function contributorAuthority(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  spaceId: string,
  role: MembershipRole,
  lockAuthority: boolean,
  authorityDiscovery?: RelationshipAuthorityDiscovery
): Promise<{ allowed: boolean; authorityTokens: string[] }> {
  if (role === "owner" || role === "admin") return { allowed: true, authorityTokens: [] };
  const result = await tx.query<RelationshipAuthorityGrantRow>(
    `SELECT grant_record.id, grant_record.resource_id, grant_record.resource_type,
            grant_record.subject_type, grant_record.subject_id, grant_record.relation
       FROM access.access_relationships grant_record
       WHERE grant_record.tenant_id = $1 AND grant_record.workspace_id = $2
         AND grant_record.resource_type = 'space' AND grant_record.resource_id = $3
         AND grant_record.relation IN ('owner','manager','contributor')
         AND ((grant_record.subject_type = 'membership' AND grant_record.subject_id = $4)
           OR (grant_record.subject_type = 'user' AND grant_record.subject_id = $5))
       ORDER BY grant_record.id LIMIT 1 ${lockAuthority ? "FOR SHARE" : ""}`,
    [context.tenantId, context.workspaceId, spaceId, context.actorMembershipId, context.actorUserId]
  );
  const row = result.rows[0];
  if (row && authorityDiscovery) recordRelationshipAuthorityGrant(authorityDiscovery, row);
  return row
    ? authorityDiscovery?.inconsistent
      ? { allowed: false, authorityTokens: [] }
      : { allowed: true, authorityTokens: [spaceGrantToken(row.id, row.resource_id)] }
    : { allowed: false, authorityTokens: [] };
}

function canReadDataClass(
  ceiling: "public" | "workspace" | "restricted" | "confidential",
  resource: "public" | "workspace" | "restricted" | "confidential"
): boolean {
  const rank = { public: 0, workspace: 1, restricted: 2, confidential: 3 } as const;
  return rank[resource] <= rank[ceiling];
}

function maxDataClass(left: AccessClass, right: AccessClass): AccessClass {
  const rank = { public: 0, workspace: 1, restricted: 2, confidential: 3 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function spaceGrantToken(grantId: string, resourceId: string): string {
  return `space_grant:${grantId}:${resourceId}`;
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
  context: SecurityContext,
  lockAuthority = false
): Promise<boolean> {
  return Boolean(await loadActivePolicyRecord(tx, context, lockAuthority));
}

async function loadActivePolicyRecord(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  lockAuthority: boolean
): Promise<PolicyAuthorityRecord | undefined> {
  const result = await tx.query<PolicyAuthorityRecord>(
    `
    SELECT id, status
    FROM identity.policy_versions
    WHERE id = $1
      AND tenant_id = $2
      AND workspace_id = $3
      AND status = 'active'
    LIMIT 1 ${lockAuthority ? "FOR SHARE" : ""}
    `,
    [context.policyVersion, context.tenantId, context.workspaceId]
  );
  return result.rows[0];
}

async function loadActiveMembership(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  lockAuthority = false
): Promise<MembershipRecord | undefined> {
  const result = await tx.query<MembershipRecord>(
    `
    SELECT m.id AS membership_id, m.user_id, m.person_id, m.role,
           m.status AS membership_status, u.status AS user_status
    FROM identity.memberships m
    JOIN identity.users u ON u.id = m.user_id
    WHERE m.id = $1
      AND m.user_id = $2
      AND m.tenant_id = $3
      AND m.workspace_id = $4
      AND m.person_id IS NOT NULL
    LIMIT 1 ${lockAuthority ? "FOR SHARE OF m, u" : ""}
    `,
    [context.actorMembershipId, context.actorUserId, context.tenantId, context.workspaceId]
  );

  return result.rows[0];
}

async function lockRelationshipAuthoritySpaces(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  spaceIds: readonly string[]
): Promise<RelationshipAuthoritySpaceRow[]> {
  if (spaceIds.length === 0) return [];
  const result = await tx.query<RelationshipAuthoritySpaceRow>(
    `/* relationship_authority_global_spaces */
     SELECT space_row.id, space_row.parent_space_id, space_row.kind,
            space_row.access_class, space_row.inheritance_mode
     FROM access.spaces space_row
     WHERE space_row.tenant_id = $1 AND space_row.workspace_id = $2
       AND space_row.id = ANY($3::uuid[]) AND space_row.archived_at IS NULL
     ORDER BY space_row.id
     FOR SHARE OF space_row`,
    [context.tenantId, context.workspaceId, [...spaceIds].sort()]
  );
  return result.rows;
}

async function lockRelationshipAuthorityGrants(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  grantIds: readonly string[]
): Promise<RelationshipAuthorityGrantRow[]> {
  if (grantIds.length === 0) return [];
  const result = await tx.query<RelationshipAuthorityGrantRow>(
    `/* relationship_authority_global_grants */
     SELECT grant_record.id, grant_record.resource_id, grant_record.resource_type,
            grant_record.subject_type, grant_record.subject_id, grant_record.relation
     FROM access.access_relationships grant_record
     WHERE grant_record.tenant_id = $1 AND grant_record.workspace_id = $2
       AND grant_record.id = ANY($3::uuid[])
       AND grant_record.resource_type = 'space'
       AND grant_record.relation IN ('owner','manager','contributor','viewer')
       AND ((grant_record.subject_type = 'membership' AND grant_record.subject_id = $4)
         OR (grant_record.subject_type = 'user' AND grant_record.subject_id = $5))
     ORDER BY grant_record.id
     FOR SHARE OF grant_record`,
    [
      context.tenantId,
      context.workspaceId,
      [...grantIds].sort(),
      context.actorMembershipId,
      context.actorUserId
    ]
  );
  return result.rows;
}

async function loadRelationshipAuthoritySpace(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  spaceId: string
): Promise<RelationshipAuthoritySpaceRow | undefined> {
  const result = await tx.query<RelationshipAuthoritySpaceRow>(
    `/* relationship_authority_space */
     SELECT space_row.id, space_row.parent_space_id, space_row.kind,
            space_row.access_class, space_row.inheritance_mode
     FROM access.spaces space_row
     WHERE space_row.tenant_id = $1 AND space_row.workspace_id = $2
       AND space_row.id = $3 AND space_row.archived_at IS NULL
     LIMIT 1`,
    [context.tenantId, context.workspaceId, spaceId]
  );
  return result.rows[0];
}

async function canReadSpaceResource(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  spaceId: string,
  role: MembershipRole,
  options: {
    lockedTarget?: { id: string };
    lockAuthority?: boolean;
    authorityDiscovery?: RelationshipAuthorityDiscovery;
  } = {}
): Promise<{
  allowed: boolean;
  reasonCode: string;
  explanation?: string;
  authorityTokens: string[];
}> {
  let discoveredTarget: RelationshipAuthoritySpaceRow | undefined;
  if (options.authorityDiscovery) {
    discoveredTarget = await loadRelationshipAuthoritySpace(tx, context, spaceId);
    if (!discoveredTarget) {
      return {
        allowed: false,
        reasonCode: "space_not_found",
        explanation: "Space is not visible in the current workspace",
        authorityTokens: []
      };
    }
    recordRelationshipAuthoritySpace(options.authorityDiscovery, discoveredTarget);
    if (options.authorityDiscovery.inconsistent) {
      return {
        allowed: false,
        reasonCode: "space_access_denied",
        explanation: "Current Space authority changed during evaluation",
        authorityTokens: []
      };
    }
  }
  let lockedTarget = options.lockedTarget;
  if (options.lockAuthority && !lockedTarget) {
    const locked = await tx.query<{ id: string }>(
      `SELECT id
       FROM access.spaces
       WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND archived_at IS NULL
       LIMIT 1
       FOR SHARE`,
      [spaceId, context.tenantId, context.workspaceId]
    );
    lockedTarget = locked.rows[0];
    if (!lockedTarget) {
      return {
        allowed: false,
        reasonCode: "space_not_found",
        explanation: "Space is not visible in the current workspace",
        authorityTokens: []
      };
    }
  }
  if (role === "owner" || role === "admin") {
    if (discoveredTarget) {
      return { allowed: true, reasonCode: "workspace_admin_space_read", authorityTokens: [] };
    }
    if (lockedTarget) {
      return lockedTarget.id === spaceId
        ? { allowed: true, reasonCode: "workspace_admin_space_read", authorityTokens: [] }
        : {
            allowed: false,
            reasonCode: "space_not_found",
            explanation: "Space is not visible in the current workspace",
            authorityTokens: []
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
      ? { allowed: true, reasonCode: "workspace_admin_space_read", authorityTokens: [] }
      : {
          allowed: false,
          reasonCode: "space_not_found",
          explanation: "Space is not visible in the current workspace",
          authorityTokens: []
        };
  }

  const result = await tx.query<{
    is_root: boolean;
    target_restricted: boolean;
    direct_grant_ids: string[];
    direct_grant_space_ids: string[];
    inherited_grant_ids: string[];
    inherited_grant_space_ids: string[];
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
      ARRAY(
        SELECT ar.id
        FROM access.access_relationships ar
        WHERE ar.resource_type = 'space'
          AND ar.resource_id = $1
          AND ar.relation IN ('owner', 'manager', 'contributor', 'viewer')
          AND (
            (ar.subject_type = 'membership' AND ar.subject_id = $4)
            OR (ar.subject_type = 'user' AND ar.subject_id = $5)
          )
        ORDER BY ar.id
      ) AS direct_grant_ids,
      ARRAY(
        SELECT ar.resource_id
        FROM access.access_relationships ar
        WHERE ar.resource_type = 'space'
          AND ar.resource_id = $1
          AND ar.relation IN ('owner', 'manager', 'contributor', 'viewer')
          AND (
            (ar.subject_type = 'membership' AND ar.subject_id = $4)
            OR (ar.subject_type = 'user' AND ar.subject_id = $5)
          )
        ORDER BY ar.id
      ) AS direct_grant_space_ids,
      ARRAY(
        SELECT ar.id
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
        ORDER BY a.depth, ar.id
      ) AS inherited_grant_ids,
      ARRAY(
        SELECT ar.resource_id
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
        ORDER BY a.depth, ar.id
      ) AS inherited_grant_space_ids
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
      explanation: "Space is not visible in the current workspace",
      authorityTokens: []
    };
  }
  if (access.is_root) {
    return { allowed: true, reasonCode: "workspace_root_read", authorityTokens: [] };
  }
  if (access.direct_grant_ids.length > 0) {
    const token = options.authorityDiscovery
      ? await discoverRelationshipAuthorityGrant(
          tx,
          context,
          access.direct_grant_ids[0]!,
          access.direct_grant_space_ids[0]!,
          options.authorityDiscovery
        )
      : await lockOrConfirmSpaceGrant(
          tx,
          context,
          access.direct_grant_ids[0]!,
          access.direct_grant_space_ids[0]!,
          options.lockAuthority === true
        );
    if (token) {
      return { allowed: true, reasonCode: "direct_space_grant", authorityTokens: [token] };
    }
  }
  if (!access.target_restricted && access.inherited_grant_ids.length > 0) {
    const token = options.authorityDiscovery
      ? await discoverInheritedRelationshipAuthorityGrant(
          tx,
          context,
          spaceId,
          access.inherited_grant_ids[0]!,
          access.inherited_grant_space_ids[0]!,
          options.authorityDiscovery
        )
      : options.lockAuthority === true
        ? await lockOrConfirmInheritedSpaceGrant(
            tx,
            context,
            spaceId,
            access.inherited_grant_ids[0]!,
            access.inherited_grant_space_ids[0]!
          )
        : spaceGrantToken(access.inherited_grant_ids[0]!, access.inherited_grant_space_ids[0]!);
    if (token) {
      return { allowed: true, reasonCode: "inherited_space_grant", authorityTokens: [token] };
    }
  }

  return {
    allowed: false,
    reasonCode: "space_access_denied",
    explanation: "No current Space grant authorizes this action",
    authorityTokens: []
  };
}

type InheritedAuthorityPathRow = RelationshipAuthoritySpaceRow & {
  depth: number;
};

async function loadInheritedAuthorityPath(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  targetSpaceId: string,
  grantSpaceId: string
): Promise<InheritedAuthorityPathRow[] | undefined> {
  const result = await tx.query<InheritedAuthorityPathRow>(
    `WITH RECURSIVE authority_path AS (
       SELECT id, parent_space_id, kind, access_class, inheritance_mode, 0 AS depth
       FROM access.spaces
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         AND archived_at IS NULL
       UNION ALL
       SELECT parent.id, parent.parent_space_id, parent.kind, parent.access_class,
              parent.inheritance_mode, authority_path.depth + 1
       FROM access.spaces parent
       JOIN authority_path ON authority_path.parent_space_id = parent.id
       WHERE parent.tenant_id = $1 AND parent.workspace_id = $2
         AND parent.archived_at IS NULL
     )
     SELECT id, parent_space_id, kind, access_class, inheritance_mode, depth
     FROM authority_path
     ORDER BY depth`,
    [context.tenantId, context.workspaceId, targetSpaceId]
  );
  const grantIndex = result.rows.findIndex(({ id }) => id === grantSpaceId);
  if (grantIndex <= 0) return undefined;
  const path = result.rows.slice(0, grantIndex + 1);
  return path.slice(0, -1).some(({ inheritance_mode }) => inheritance_mode === "restricted")
    ? undefined
    : path;
}

async function discoverInheritedRelationshipAuthorityGrant(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  targetSpaceId: string,
  grantId: string,
  grantSpaceId: string,
  discovery: RelationshipAuthorityDiscovery
): Promise<string | undefined> {
  const path = await loadInheritedAuthorityPath(tx, context, targetSpaceId, grantSpaceId);
  if (!path) return undefined;
  const pathKey = `${targetSpaceId}:${grantSpaceId}`;
  const pathIds = path.map(({ id }) => id);
  const priorPath = discovery.paths.get(pathKey);
  if (priorPath && !sameAuthorityValue(priorPath, pathIds)) discovery.inconsistent = true;
  else discovery.paths.set(pathKey, pathIds);
  for (const row of path) recordRelationshipAuthoritySpace(discovery, row);
  if (discovery.inconsistent) return undefined;
  return discoverRelationshipAuthorityGrant(tx, context, grantId, grantSpaceId, discovery);
}

async function discoverRelationshipAuthorityGrant(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  grantId: string,
  resourceId: string,
  discovery: RelationshipAuthorityDiscovery
): Promise<string | undefined> {
  const result = await tx.query<RelationshipAuthorityGrantRow>(
    `/* relationship_authority_grant */
     SELECT grant_record.id, grant_record.resource_id, grant_record.resource_type,
            grant_record.subject_type, grant_record.subject_id, grant_record.relation
     FROM access.access_relationships grant_record
     WHERE grant_record.tenant_id = $1 AND grant_record.workspace_id = $2
       AND grant_record.id = $3 AND grant_record.resource_id = $4
       AND grant_record.resource_type = 'space'
       AND grant_record.relation IN ('owner','manager','contributor','viewer')
       AND ((grant_record.subject_type = 'membership' AND grant_record.subject_id = $5)
         OR (grant_record.subject_type = 'user' AND grant_record.subject_id = $6))
     LIMIT 1`,
    [
      context.tenantId,
      context.workspaceId,
      grantId,
      resourceId,
      context.actorMembershipId,
      context.actorUserId
    ]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  recordRelationshipAuthorityGrant(discovery, row);
  return discovery.inconsistent ? undefined : spaceGrantToken(row.id, row.resource_id);
}

function recordRelationshipAuthoritySpace(
  discovery: RelationshipAuthorityDiscovery,
  row: RelationshipAuthoritySpaceRow
): void {
  const normalized: RelationshipAuthoritySpaceRow = {
    id: row.id,
    parent_space_id: row.parent_space_id,
    kind: row.kind,
    access_class: row.access_class,
    inheritance_mode: row.inheritance_mode
  };
  const prior = discovery.spaces.get(normalized.id);
  if (prior && !sameAuthorityValue(prior, normalized)) discovery.inconsistent = true;
  else discovery.spaces.set(normalized.id, normalized);
}

function recordRelationshipAuthorityGrant(
  discovery: RelationshipAuthorityDiscovery,
  row: RelationshipAuthorityGrantRow
): void {
  const normalized: RelationshipAuthorityGrantRow = {
    id: row.id,
    resource_id: row.resource_id,
    resource_type: row.resource_type,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    relation: row.relation
  };
  const prior = discovery.grants.get(normalized.id);
  if (prior && !sameAuthorityValue(prior, normalized)) discovery.inconsistent = true;
  else discovery.grants.set(normalized.id, normalized);
}

async function lockOrConfirmInheritedSpaceGrant(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  targetSpaceId: string,
  grantId: string,
  grantSpaceId: string
): Promise<string | undefined> {
  const expectedPath = await loadInheritedAuthorityPath(tx, context, targetSpaceId, grantSpaceId);
  if (!expectedPath) return undefined;
  const expectedIds = expectedPath.map(({ id }) => id);
  const locked = await tx.query<{ id: string }>(
    `SELECT space_row.id
     FROM access.spaces space_row
     WHERE space_row.tenant_id = $1 AND space_row.workspace_id = $2
       AND space_row.id = ANY($3::uuid[]) AND space_row.archived_at IS NULL
     ORDER BY space_row.id
     FOR SHARE OF space_row`,
    [context.tenantId, context.workspaceId, [...expectedIds].sort()]
  );
  if (
    locked.rows.length !== expectedIds.length ||
    new Set(locked.rows.map(({ id }) => id)).size !== expectedIds.length
  ) {
    return undefined;
  }
  const currentPath = await loadInheritedAuthorityPath(tx, context, targetSpaceId, grantSpaceId);
  if (
    !currentPath ||
    currentPath.length !== expectedPath.length ||
    currentPath.some(
      (row, index) =>
        row.id !== expectedPath[index]!.id ||
        row.parent_space_id !== expectedPath[index]!.parent_space_id ||
        row.inheritance_mode !== expectedPath[index]!.inheritance_mode ||
        row.depth !== expectedPath[index]!.depth
    )
  ) {
    return undefined;
  }
  return lockOrConfirmSpaceGrant(tx, context, grantId, grantSpaceId, true);
}

async function lockOrConfirmSpaceGrant(
  tx: TenantQueryExecutor,
  context: SecurityContext,
  grantId: string,
  resourceId: string,
  lockAuthority: boolean
): Promise<string | undefined> {
  if (!lockAuthority) return spaceGrantToken(grantId, resourceId);
  const locked = await tx.query<{ id: string; resource_id: string }>(
    `SELECT id, resource_id FROM access.access_relationships
     WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND resource_id = $4
       AND resource_type = 'space' AND relation IN ('owner','manager','contributor','viewer')
       AND ((subject_type = 'membership' AND subject_id = $5)
         OR (subject_type = 'user' AND subject_id = $6))
     LIMIT 1 FOR SHARE`,
    [
      context.tenantId,
      context.workspaceId,
      grantId,
      resourceId,
      context.actorMembershipId,
      context.actorUserId
    ]
  );
  const row = locked.rows[0];
  return row ? spaceGrantToken(row.id, row.resource_id) : undefined;
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
