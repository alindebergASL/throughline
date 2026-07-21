import type { AccessClass, SecurityContext } from "./index.js";

export const B1_COMMAND_KINDS = [
  "organization.create",
  "initiative.create",
  "activity.create",
  "relationship.create",
  "relationship.end",
  "content.create",
  "content.revise",
  "source.capture",
  "source.correct",
  "source.tombstone"
] as const;
export type B1CommandKind = (typeof B1_COMMAND_KINDS)[number];

export interface B1CommandMetadata {
  idempotencyKey: string;
}

export interface CreateOrganizationPayload {
  name: string;
  domains: string[];
}

export interface CreateInitiativePayload {
  primaryOrganizationId: string;
  organizationIds?: string[];
  contributorPersonIds?: string[];
  title: string;
  typeKey: string;
  stageKey: string;
  health?: "active" | "stalled" | "paused" | "blocked" | "closed";
  ownerPersonId?: string;
}

export interface CreateActivityPayload {
  title: string;
  profileTemplateKey: string;
  status?: "planned" | "in_progress" | "captured" | "review_pending" | "completed" | "cancelled";
  occurredAt?: string;
  startsAt?: string;
  endsAt?: string;
  ownerPersonId?: string;
  governingInitiativeId?: string;
  governingOrganizationId?: string;
  organizationIds: string[];
  initiativeIds: string[];
  attendeePersonIds?: string[];
}

export interface CreateRelationshipPayload {
  subject: {
    type: "space" | "person" | "organization" | "initiative" | "activity" | "content";
    id: string;
  };
  predicate: string;
  object: {
    type: "space" | "person" | "organization" | "initiative" | "activity" | "content";
    id: string;
  };
  context?: {
    type: "space" | "person" | "organization" | "initiative" | "activity" | "content";
    id: string;
  };
  validFrom?: string;
}

export interface EndRelationshipPayload {
  relationshipId: string;
  expectedVersion: number;
  validTo: string;
}

export interface CreateContentPayload {
  spaceId: string;
  type: "page" | "note";
  title: string;
  body: string;
  ownerPersonId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviseContentPayload {
  contentItemId: string;
  expectedRevision: number;
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export type ManualSourceType = "note" | "transcript" | "human";

export interface CaptureSourcePayload {
  activityId: string;
  sourceType: ManualSourceType;
  title?: string;
  text: string;
  requestedAccessClass?: AccessClass;
  originContentItemId?: string;
  originContentRevision?: number;
  occurredAt?: string;
}

export interface CorrectSourcePayload {
  predecessorSourceArtifactId: string;
  activityId?: string;
  sourceType: ManualSourceType;
  title?: string;
  text: string;
  requestedAccessClass?: AccessClass;
  occurredAt?: string;
}

export interface TombstoneSourcePayload {
  sourceArtifactId: string;
  expectedVersion: number;
  deletionReasonCategory: string;
  deletionPolicyRef: string;
}

export interface B1CommandPayloadMap {
  "organization.create": CreateOrganizationPayload;
  "initiative.create": CreateInitiativePayload;
  "activity.create": CreateActivityPayload;
  "relationship.create": CreateRelationshipPayload;
  "relationship.end": EndRelationshipPayload;
  "content.create": CreateContentPayload;
  "content.revise": ReviseContentPayload;
  "source.capture": CaptureSourcePayload;
  "source.correct": CorrectSourcePayload;
  "source.tombstone": TombstoneSourcePayload;
}

export type B1AuthorizedDomainCommand<K extends B1CommandKind = B1CommandKind> = {
  [P in K]: B1CommandMetadata & { kind: P; payload: B1CommandPayloadMap[P] };
}[K];

export interface B1CommandResultMap {
  "organization.create": { organizationId: string; spaceId: string; version: 1 };
  "initiative.create": { initiativeId: string; spaceId: string; version: 1 };
  "activity.create": { activityId: string; spaceId: string; version: 1 };
  "relationship.create": { relationshipId: string; spaceId: string; version: 1 };
  "relationship.end": { relationshipId: string; version: number; validTo: string };
  "content.create": { contentItemId: string; revisionNumber: 1; version: 1 };
  "content.revise": { contentItemId: string; revisionNumber: number; version: number };
  "source.capture": {
    sourceArtifactId: string;
    activityId: string;
    chunkCount: number;
    version: 1;
  };
  "source.correct": {
    sourceArtifactId: string;
    previousSourceArtifactId: string;
    chunkCount: number;
    version: 1;
  };
  "source.tombstone": {
    sourceArtifactId: string;
    version: number;
    hashDisposition: "retained" | "erased";
  };
}

export interface B1DomainCommandBus {
  execute<K extends B1CommandKind>(
    command: B1AuthorizedDomainCommand<K>,
    context: SecurityContext
  ): Promise<B1CommandResultMap[K]>;
}

export interface SafePersonProjection {
  id: string;
  displayName: string;
  isInternal: boolean;
}
