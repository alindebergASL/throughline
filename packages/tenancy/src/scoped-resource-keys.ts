import type { FoundationScope } from "@throughline/core-types";

type ScopedResourceKeyInput = FoundationScope & {
  resourceType: string;
  resourceId: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const INFRASTRUCTURE_HOST_NAMES = new Set(["localhost", "localhost.localdomain"]);

function validateScope(scope: FoundationScope): void {
  validateScopeIdentifier("tenantId", scope.tenantId);
  validateScopeIdentifier("workspaceId", scope.workspaceId);
  validateScopeIdentifier("spaceId", scope.spaceId);
}

function validateScopeIdentifier(name: keyof FoundationScope, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a canonical UUID identifier`);
  }
}

function validateResourceScope(
  expectedScope: FoundationScope,
  resource: ScopedResourceKeyInput
): void {
  validateScope(expectedScope);
  validateScope(resource);

  if (
    resource.tenantId !== expectedScope.tenantId ||
    resource.workspaceId !== expectedScope.workspaceId ||
    resource.spaceId !== expectedScope.spaceId
  ) {
    throw new Error("Resource scope must exactly match the requested Foundation scope");
  }
}

function encodeResourceSegment(name: "resourceType" | "resourceId", value: string): string {
  if (
    !SAFE_SEGMENT_PATTERN.test(value) ||
    INFRASTRUCTURE_HOST_NAMES.has(value) ||
    value.includes("..")
  ) {
    throw new Error(`${name} must be a safe, non-infrastructure resource segment`);
  }

  return encodeURIComponent(value);
}

function queueScopeSegments(scope: FoundationScope): string[] {
  validateScope(scope);
  return ["tenant", scope.tenantId, "workspace", scope.workspaceId, "space", scope.spaceId];
}

export function buildScopedQueueKey(scope: FoundationScope): string {
  return queueScopeSegments(scope).join("/");
}

export function buildScopedCacheKey(
  scope: FoundationScope,
  resource: ScopedResourceKeyInput
): string {
  validateResourceScope(scope, resource);

  return [
    "tenant",
    scope.tenantId,
    "workspace",
    scope.workspaceId,
    "space",
    scope.spaceId,
    encodeResourceSegment("resourceType", resource.resourceType),
    encodeResourceSegment("resourceId", resource.resourceId)
  ].join(":");
}

export function buildScopedObjectKey(
  scope: FoundationScope,
  resource: ScopedResourceKeyInput
): string {
  validateResourceScope(scope, resource);

  return [
    ...queueScopeSegments(scope),
    encodeResourceSegment("resourceType", resource.resourceType),
    encodeResourceSegment("resourceId", resource.resourceId)
  ].join("/");
}
