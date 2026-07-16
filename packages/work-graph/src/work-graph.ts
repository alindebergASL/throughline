import type { AccessClass } from "@throughline/core-types";
import { domainToASCII } from "node:url";

export const B1_RELATIONSHIP_ENTITY_KINDS = [
  "space",
  "person",
  "organization",
  "initiative",
  "activity",
  "content"
] as const;
export type B1RelationshipEntityKind = (typeof B1_RELATIONSHIP_ENTITY_KINDS)[number];
export type OrganizationStatus = "active" | "archived";
export type InitiativeHealth = "active" | "stalled" | "paused" | "blocked" | "closed";
export type ActivityStatus =
  | "planned"
  | "in_progress"
  | "captured"
  | "review_pending"
  | "completed"
  | "cancelled";

export interface ScopedAggregate {
  id: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  version: number;
}

export interface Organization extends ScopedAggregate {
  name: string;
  normalizedName: string;
  domains: string[];
  status: OrganizationStatus;
}

export interface Initiative extends ScopedAggregate {
  title: string;
  typeKey: string;
  stageKey: string;
  health: InitiativeHealth;
  ownerPersonId?: string;
  profileId: string;
  profileVersion: string;
  organizationIds: string[];
  primaryOrganizationId: string;
  contributorPersonIds: string[];
}

export interface Activity extends ScopedAggregate {
  subtype: string;
  profileTemplateKey: string;
  title: string;
  status: ActivityStatus;
  occurredAt?: string;
  startsAt?: string;
  endsAt?: string;
  ownerPersonId?: string;
  governingInitiativeId?: string;
  governingOrganizationId?: string;
  organizationIds: string[];
  initiativeIds: string[];
  attendeePersonIds: string[];
}

export interface RelationshipEndpoint {
  type: B1RelationshipEntityKind;
  id: string;
}

export interface Relationship extends ScopedAggregate {
  subject: RelationshipEndpoint;
  predicate: string;
  object: RelationshipEndpoint;
  context?: RelationshipEndpoint;
  validFrom?: string;
  validTo?: string;
}

export interface SpaceBearingEndpoint {
  tenantId: string;
  workspaceId: string;
  spaceId?: string;
  accessClass: AccessClass;
}

export type RelationshipEndpointResolver = (
  endpoint: RelationshipEndpoint
) => SpaceBearingEndpoint | undefined;

export class WorkGraphInvariantError extends Error {
  constructor(message = "Work graph invariant failed") {
    super(message);
    this.name = "WorkGraphInvariantError";
  }
}

export function normalizeOrganizationName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ").normalize("NFC").toLocaleLowerCase("en-US");
  if (!normalized) throw new WorkGraphInvariantError("Organization name is required");
  return normalized;
}

export function normalizeOrganizationDomain(input: string): string {
  const candidate = input.trim().replace(/\.$/, "").toLowerCase();
  if (
    !candidate ||
    candidate.includes("://") ||
    candidate.includes("/") ||
    candidate.includes("@")
  ) {
    throw new WorkGraphInvariantError("Organization domain must be a host name");
  }
  const ascii = domainToASCII(candidate).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.split(".").some((part) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(part)) ||
    !ascii.includes(".")
  ) {
    throw new WorkGraphInvariantError("Organization domain must be canonical IDNA ASCII");
  }
  return ascii;
}

export function normalizeOrganizationDomains(inputs: readonly string[]): string[] {
  const domains = inputs.map(normalizeOrganizationDomain);
  if (new Set(domains).size !== domains.length) {
    throw new WorkGraphInvariantError("Organization domains must be unique");
  }
  return domains.sort();
}

export function validateInitiativeAssociations(input: {
  organizationIds: readonly string[];
  primaryOrganizationId: string;
}): void {
  if (
    input.organizationIds.length === 0 ||
    new Set(input.organizationIds).size !== input.organizationIds.length ||
    input.organizationIds.filter((id) => id === input.primaryOrganizationId).length !== 1
  ) {
    throw new WorkGraphInvariantError("Initiative requires exactly one primary Organization");
  }
}

export function resolveActivityGoverningParent(input: {
  initiativeIds: readonly string[];
  organizationIds: readonly string[];
  governingInitiativeId?: string;
  governingOrganizationId?: string;
}): { type: "initiative" | "organization"; id: string } {
  const hasInitiative = input.governingInitiativeId !== undefined;
  const hasOrganization = input.governingOrganizationId !== undefined;
  if (hasInitiative === hasOrganization) {
    throw new WorkGraphInvariantError("Activity requires exactly one explicit governing parent");
  }
  if (hasInitiative) {
    if (!input.initiativeIds.includes(input.governingInitiativeId!)) {
      throw new WorkGraphInvariantError("Governing Initiative must be an Activity association");
    }
    return { type: "initiative", id: input.governingInitiativeId! };
  }
  if (!input.organizationIds.includes(input.governingOrganizationId!)) {
    throw new WorkGraphInvariantError("Governing Organization must be an Activity association");
  }
  return { type: "organization", id: input.governingOrganizationId! };
}

export function validateActivityTime(input: { startsAt?: string; endsAt?: string }): void {
  if (input.startsAt && input.endsAt && Date.parse(input.endsAt) < Date.parse(input.startsAt)) {
    throw new WorkGraphInvariantError("Activity end cannot precede its start");
  }
}

export function deriveRelationshipGoverningSpace(input: {
  tenantId: string;
  workspaceId: string;
  subject: RelationshipEndpoint;
  object: RelationshipEndpoint;
  context?: RelationshipEndpoint;
  predicate: string;
  validFrom?: string;
  validTo?: string;
  resolve: RelationshipEndpointResolver;
}): { spaceId: string; accessClass: AccessClass } {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(input.predicate)) {
    throw new WorkGraphInvariantError("Relationship predicate is not allowlisted syntax");
  }
  if (input.subject.type === input.object.type && input.subject.id === input.object.id) {
    throw new WorkGraphInvariantError("Reflexive relationships are not allowed in B1");
  }
  if (
    input.validFrom &&
    input.validTo &&
    Date.parse(input.validTo) <= Date.parse(input.validFrom)
  ) {
    throw new WorkGraphInvariantError("Relationship validity must be half-open and non-empty");
  }
  const subject = requireEndpoint(input.resolve(input.subject), input);
  const object = requireEndpoint(input.resolve(input.object), input);
  const context = input.context ? requireEndpoint(input.resolve(input.context), input) : undefined;
  if (input.context && !context?.spaceId) {
    throw new WorkGraphInvariantError("Relationship context must be Space-bearing");
  }
  const governing = context?.spaceId
    ? context
    : subject.spaceId
      ? subject
      : object.spaceId
        ? object
        : undefined;
  if (!governing?.spaceId) {
    throw new WorkGraphInvariantError("Relationship requires a Space-bearing endpoint or context");
  }
  const accessClass = mostRestrictive([
    governing.accessClass,
    subject.accessClass,
    object.accessClass,
    ...(context ? [context.accessClass] : [])
  ]);
  return { spaceId: governing.spaceId, accessClass };
}

function requireEndpoint(
  endpoint: SpaceBearingEndpoint | undefined,
  scope: { tenantId: string; workspaceId: string }
): SpaceBearingEndpoint {
  if (
    !endpoint ||
    endpoint.tenantId !== scope.tenantId ||
    endpoint.workspaceId !== scope.workspaceId
  ) {
    throw new WorkGraphInvariantError("Relationship endpoint is missing or cross-scope");
  }
  return endpoint;
}

function mostRestrictive(values: readonly AccessClass[]): AccessClass {
  const ranks: Record<AccessClass, number> = {
    public: 0,
    workspace: 1,
    restricted: 2,
    confidential: 3
  };
  return values.reduce((maximum, current) => (ranks[current] > ranks[maximum] ? current : maximum));
}
