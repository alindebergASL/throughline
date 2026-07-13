import type { SecurityContext } from "@throughline/core-types";
import { parseSecurityContext } from "./security-context.js";

export const DEV_POLICY_VERSION = "default-v1";

export const devFixtures = {
  tenantA: "11111111-1111-4111-8111-111111111111",
  tenantB: "22222222-2222-4222-8222-222222222222",
  workspaceA: "11111111-1111-4111-8111-111111111112",
  workspaceB: "22222222-2222-4222-8222-222222222223",
  userA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  userB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  personA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  personB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
  personBInTenantA: "11111111-1111-4111-8111-111111111118",
  membershipAOwner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
  membershipBViewer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
  membershipAViewer: "11111111-1111-4111-8111-111111111119",
  rootSpaceA: "11111111-1111-4111-8111-111111111113",
  rootSpaceB: "22222222-2222-4222-8222-222222222224",
  restrictedSpaceA: "11111111-1111-4111-8111-111111111114",
  restrictedChildSpaceA: "11111111-1111-4111-8111-111111111120",
  externalPersonA: "11111111-1111-4111-8111-111111111115",
  servicePrincipalA: "11111111-1111-4111-8111-111111111116",
  relayServicePrincipalA: "11111111-1111-4111-8111-111111111121",
  agentPrincipalA: "11111111-1111-4111-8111-111111111117"
} as const;

export type DevIdentityKey =
  | "tenant-a-owner"
  | "tenant-a-viewer"
  | "tenant-b-viewer"
  | "tenant-a-service"
  | "tenant-a-agent";

type HeaderLike = Record<string, string | string[] | undefined>;

const forbiddenAuthorityHeaders = new Set([
  "x-throughline-tenant-id",
  "x-throughline-workspace-id",
  "x-throughline-user-id",
  "x-throughline-membership-id",
  "x-throughline-role",
  "x-throughline-permissions",
  "tenantid",
  "workspaceid",
  "userid",
  "role",
  "permissions"
]);

function readHeader(headers: HeaderLike, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function assertNoHeaderSourcedAuthority(headers: HeaderLike): void {
  for (const key of Object.keys(headers)) {
    if (forbiddenAuthorityHeaders.has(key.toLowerCase())) {
      throw new Error(`Header ${key} is not accepted as authorization authority`);
    }
  }
}

export function resolveDevIdentityFromHeaders(
  headers: HeaderLike,
  now = new Date()
): SecurityContext {
  if (process.env.NODE_ENV === "production" || process.env.AUTH_ADAPTER !== "dev") {
    throw new Error(
      "Dev identity resolver is disabled outside AUTH_ADAPTER=dev non-production runs"
    );
  }

  assertNoHeaderSourcedAuthority(headers);

  const identity = readHeader(headers, "x-throughline-dev-identity");
  if (!isDevIdentityKey(identity)) {
    throw new Error("Unknown deterministic dev identity");
  }

  return createDevSecurityContext(identity, {
    requestId: readHeader(headers, "x-request-id") ?? "dev-request",
    traceId: readHeader(headers, "x-trace-id") ?? "dev-trace",
    now
  });
}

export function createDevSecurityContext(
  identity: DevIdentityKey,
  options: { requestId?: string; traceId?: string; now?: Date } = {}
): SecurityContext {
  const issuedAt = options.now ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + 15 * 60 * 1000);
  const base = {
    requestId: options.requestId ?? "dev-request",
    traceId: options.traceId ?? "dev-trace",
    requestedSpaceIds: [],
    membershipIds: [],
    roleHints: [],
    dataClassCeiling: "restricted" as const,
    policyVersion: DEV_POLICY_VERSION,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };

  if (identity === "tenant-a-service") {
    return parseSecurityContext({
      ...base,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      servicePrincipalId: devFixtures.servicePrincipalA
    });
  }

  if (identity === "tenant-a-agent") {
    return parseSecurityContext({
      ...base,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      agentPrincipalId: devFixtures.agentPrincipalA
    });
  }

  if (identity === "tenant-b-viewer") {
    return parseSecurityContext({
      ...base,
      tenantId: devFixtures.tenantB,
      workspaceId: devFixtures.workspaceB,
      actorUserId: devFixtures.userB,
      actorMembershipId: devFixtures.membershipBViewer,
      actorDisplayPersonId: devFixtures.personB,
      membershipIds: [devFixtures.membershipBViewer],
      roleHints: ["viewer"]
    });
  }

  if (identity === "tenant-a-viewer") {
    return parseSecurityContext({
      ...base,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      actorUserId: devFixtures.userB,
      actorMembershipId: devFixtures.membershipAViewer,
      actorDisplayPersonId: devFixtures.personBInTenantA,
      membershipIds: [devFixtures.membershipAViewer],
      roleHints: ["viewer"]
    });
  }

  return parseSecurityContext({
    ...base,
    tenantId: devFixtures.tenantA,
    workspaceId: devFixtures.workspaceA,
    actorUserId: devFixtures.userA,
    actorMembershipId: devFixtures.membershipAOwner,
    actorDisplayPersonId: devFixtures.personA,
    membershipIds: [devFixtures.membershipAOwner],
    roleHints: ["owner"]
  });
}

function isDevIdentityKey(value: string | undefined): value is DevIdentityKey {
  return (
    value === "tenant-a-owner" ||
    value === "tenant-a-viewer" ||
    value === "tenant-b-viewer" ||
    value === "tenant-a-service" ||
    value === "tenant-a-agent"
  );
}
