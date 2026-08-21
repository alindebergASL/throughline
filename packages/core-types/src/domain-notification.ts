import {
  PRIMARY_OBJECTIVE_WITHDRAW_REASON_CODES,
  REVOKE_REASON_CODES,
  SUPERSEDE_REASON_CODES
} from "./b2.js";

export const DOMAIN_NOTIFICATION_EVENT_TYPES = [
  "organization.created",
  "initiative.created",
  "activity.created",
  "activity.capture_added",
  "relationship.created",
  "relationship.ended",
  "content.created",
  "content.revised",
  "source_artifact.captured",
  "source_artifact.corrected",
  "source_artifact.tombstoned",
  "claim.proposed",
  "initiative.primary_objective.proposal_withdrawn",
  "initiative.primary_objective.proposal_rejected",
  "initiative.primary_objective.proposal_reworked",
  "fact.accepted",
  "fact.superseded",
  "fact.revoked"
] as const;

export type DomainNotificationEventType = (typeof DOMAIN_NOTIFICATION_EVENT_TYPES)[number];

export const DOMAIN_NOTIFICATION_AGGREGATE_TYPES = [
  "organization",
  "initiative",
  "activity",
  "relationship",
  "content_item",
  "source_artifact",
  "claim",
  "accepted_fact"
] as const;

export type DomainNotificationAggregateType = (typeof DOMAIN_NOTIFICATION_AGGREGATE_TYPES)[number];

export const DOMAIN_NOTIFICATION_EVENT_AGGREGATE_PAIRS = {
  "organization.created": "organization",
  "initiative.created": "initiative",
  "activity.created": "activity",
  "activity.capture_added": "activity",
  "relationship.created": "relationship",
  "relationship.ended": "relationship",
  "content.created": "content_item",
  "content.revised": "content_item",
  "source_artifact.captured": "source_artifact",
  "source_artifact.corrected": "source_artifact",
  "source_artifact.tombstoned": "source_artifact",
  "claim.proposed": "claim",
  "initiative.primary_objective.proposal_withdrawn": "claim",
  "initiative.primary_objective.proposal_rejected": "claim",
  "initiative.primary_objective.proposal_reworked": "claim",
  "fact.accepted": "accepted_fact",
  "fact.superseded": "accepted_fact",
  "fact.revoked": "accepted_fact"
} as const satisfies Record<DomainNotificationEventType, DomainNotificationAggregateType>;

export interface DomainNotificationPayloadMap {
  "organization.created": { organizationId: string };
  "initiative.created": { initiativeId: string };
  "activity.created": { activityId: string };
  "activity.capture_added": { activityId: string; sourceArtifactId: string };
  "relationship.created": { relationshipId: string };
  "relationship.ended": { relationshipId: string; validTo: string };
  "content.created": { contentItemId: string };
  "content.revised": { contentItemId: string; revisionNumber: number };
  "source_artifact.captured": { sourceArtifactId: string };
  "source_artifact.corrected": {
    sourceArtifactId: string;
    previousSourceArtifactId: string;
  };
  "source_artifact.tombstoned": {
    sourceArtifactId: string;
    deletionReasonCategory: string;
    deletionPolicyRef: string;
    hashDisposition: "retained" | "erased";
  };
  "claim.proposed": {
    claimId: string;
    evidenceSpanId: string;
    supportAttestationId?: string;
  };
  "initiative.primary_objective.proposal_withdrawn": {
    claimId: string;
    claimVersion: 2;
    disposition: "withdrawn";
    reasonCode: (typeof PRIMARY_OBJECTIVE_WITHDRAW_REASON_CODES)[number];
    recoveryId: string;
  };
  "initiative.primary_objective.proposal_rejected": {
    claimId: string;
    claimVersion: 2;
    disposition: "rejected";
    reasonCode: (typeof PRIMARY_OBJECTIVE_WITHDRAW_REASON_CODES)[number];
    recoveryId: string;
  };
  "initiative.primary_objective.proposal_reworked": {
    predecessorClaimId: string;
    predecessorVersion: 2;
    successorClaimId: string;
    successorVersion: 1;
    evidenceSpanId: string;
    supportAttestationId: string;
    recoveryId: string;
    disposition: "reworked";
    reasonCode: "reworked";
  };
  "fact.accepted": { factId: string };
  "fact.superseded": {
    factId: string;
    factVersion: 2;
    reasonCode: (typeof SUPERSEDE_REASON_CODES)[number];
    replacementFactId: string;
    replacementFactVersion: 1;
    status: "superseded";
  };
  "fact.revoked": {
    factId: string;
    factVersion: 2;
    reasonCode: (typeof REVOKE_REASON_CODES)[number];
    status: "revoked";
  };
}

export type DomainNotificationEnvelopeFor<T extends DomainNotificationEventType> = {
  eventId: string;
  eventType: T;
  eventSchemaVersion: 1;
  payloadSchemaVersion: 1;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  aggregateType: (typeof DOMAIN_NOTIFICATION_EVENT_AGGREGATE_PAIRS)[T];
  aggregateId: string;
  aggregateVersion: number;
  causationCommandId: string;
  payload: DomainNotificationPayloadMap[T];
  requestId: string;
  traceparent: string;
  tracestate?: string;
};

export type DomainNotificationEnvelope = {
  [T in DomainNotificationEventType]: DomainNotificationEnvelopeFor<T>;
}[DomainNotificationEventType];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-(?:0[0-9a-f]|[1-9a-f][0-9a-f])$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ENVELOPE_KEYS = [
  "eventId",
  "eventType",
  "eventSchemaVersion",
  "payloadSchemaVersion",
  "tenantId",
  "workspaceId",
  "spaceId",
  "aggregateType",
  "aggregateId",
  "aggregateVersion",
  "causationCommandId",
  "payload",
  "requestId",
  "traceparent"
] as const;

export class DomainNotificationValidationError extends Error {
  constructor() {
    super("Domain notification envelope is invalid");
    this.name = "DomainNotificationValidationError";
  }
}

export function parseDomainNotificationEnvelope(input: unknown): DomainNotificationEnvelope {
  const envelope = requireExactObject(input, ENVELOPE_KEYS, ["tracestate"]);
  const eventType = requireEnum(envelope.eventType, DOMAIN_NOTIFICATION_EVENT_TYPES);
  const aggregateType = requireEnum(envelope.aggregateType, DOMAIN_NOTIFICATION_AGGREGATE_TYPES);
  const eventId = requireUuidV7(envelope.eventId);
  const aggregateId = requireUuidV7(envelope.aggregateId);

  if (
    envelope.eventSchemaVersion !== 1 ||
    envelope.payloadSchemaVersion !== 1 ||
    aggregateType !== DOMAIN_NOTIFICATION_EVENT_AGGREGATE_PAIRS[eventType]
  ) {
    fail();
  }

  const base = {
    eventId,
    eventSchemaVersion: 1 as const,
    payloadSchemaVersion: 1 as const,
    tenantId: requireUuid(envelope.tenantId),
    workspaceId: requireUuid(envelope.workspaceId),
    spaceId: requireUuid(envelope.spaceId),
    aggregateId,
    aggregateVersion: requirePositiveInteger(envelope.aggregateVersion),
    causationCommandId: requireUuidV7(envelope.causationCommandId),
    requestId: requireBoundedString(envelope.requestId, 200),
    traceparent: requireTraceparent(envelope.traceparent),
    ...(envelope.tracestate === undefined
      ? {}
      : { tracestate: requireBoundedString(envelope.tracestate, 512) })
  };

  switch (eventType) {
    case "organization.created":
      return {
        ...base,
        eventType,
        aggregateType: "organization",
        payload: singleIdPayload(envelope.payload, "organizationId", aggregateId)
      };
    case "initiative.created":
      return {
        ...base,
        eventType,
        aggregateType: "initiative",
        payload: singleIdPayload(envelope.payload, "initiativeId", aggregateId)
      };
    case "activity.created":
      return {
        ...base,
        eventType,
        aggregateType: "activity",
        payload: singleIdPayload(envelope.payload, "activityId", aggregateId)
      };
    case "activity.capture_added": {
      const payload = requireExactObject(envelope.payload, ["activityId", "sourceArtifactId"]);
      const activityId = requireUuidV7(payload.activityId);
      if (activityId !== aggregateId) fail();
      return {
        ...base,
        eventType,
        aggregateType: "activity",
        payload: { activityId, sourceArtifactId: requireUuidV7(payload.sourceArtifactId) }
      };
    }
    case "relationship.created":
      return {
        ...base,
        eventType,
        aggregateType: "relationship",
        payload: singleIdPayload(envelope.payload, "relationshipId", aggregateId)
      };
    case "relationship.ended": {
      const payload = requireExactObject(envelope.payload, ["relationshipId", "validTo"]);
      const relationshipId = requireUuidV7(payload.relationshipId);
      if (relationshipId !== aggregateId || !isDomainNotificationTimestamp(payload.validTo)) fail();
      return {
        ...base,
        eventType,
        aggregateType: "relationship",
        payload: { relationshipId, validTo: payload.validTo as string }
      };
    }
    case "content.created":
      return {
        ...base,
        eventType,
        aggregateType: "content_item",
        payload: singleIdPayload(envelope.payload, "contentItemId", aggregateId)
      };
    case "content.revised": {
      const payload = requireExactObject(envelope.payload, ["contentItemId", "revisionNumber"]);
      const contentItemId = requireUuidV7(payload.contentItemId);
      if (contentItemId !== aggregateId) fail();
      return {
        ...base,
        eventType,
        aggregateType: "content_item",
        payload: {
          contentItemId,
          revisionNumber: requirePositiveInteger(payload.revisionNumber)
        }
      };
    }
    case "source_artifact.captured":
      return {
        ...base,
        eventType,
        aggregateType: "source_artifact",
        payload: singleIdPayload(envelope.payload, "sourceArtifactId", aggregateId)
      };
    case "source_artifact.corrected": {
      const payload = requireExactObject(envelope.payload, [
        "sourceArtifactId",
        "previousSourceArtifactId"
      ]);
      const sourceArtifactId = requireUuidV7(payload.sourceArtifactId);
      const previousSourceArtifactId = requireUuidV7(payload.previousSourceArtifactId);
      if (sourceArtifactId !== aggregateId || sourceArtifactId === previousSourceArtifactId) fail();
      return {
        ...base,
        eventType,
        aggregateType: "source_artifact",
        payload: { sourceArtifactId, previousSourceArtifactId }
      };
    }
    case "source_artifact.tombstoned": {
      const payload = requireExactObject(envelope.payload, [
        "sourceArtifactId",
        "deletionReasonCategory",
        "deletionPolicyRef",
        "hashDisposition"
      ]);
      const sourceArtifactId = requireUuidV7(payload.sourceArtifactId);
      if (sourceArtifactId !== aggregateId) fail();
      return {
        ...base,
        eventType,
        aggregateType: "source_artifact",
        payload: {
          sourceArtifactId,
          deletionReasonCategory: requireSafeReference(payload.deletionReasonCategory),
          deletionPolicyRef: requireSafeReference(payload.deletionPolicyRef),
          hashDisposition: requireEnum(payload.hashDisposition, ["retained", "erased"] as const)
        }
      };
    }
    case "claim.proposed": {
      const payload = requireExactObject(
        envelope.payload,
        ["claimId", "evidenceSpanId"],
        ["supportAttestationId"]
      );
      const claimId = requireUuidV7(payload.claimId);
      if (claimId !== aggregateId) fail();
      return {
        ...base,
        eventType,
        aggregateType: "claim",
        payload: {
          claimId,
          evidenceSpanId: requireUuidV7(payload.evidenceSpanId),
          ...(Object.hasOwn(payload, "supportAttestationId")
            ? { supportAttestationId: requireUuidV7(payload.supportAttestationId) }
            : {})
        }
      };
    }
    case "initiative.primary_objective.proposal_withdrawn":
    case "initiative.primary_objective.proposal_rejected": {
      const payload = requireExactObject(envelope.payload, [
        "claimId",
        "claimVersion",
        "disposition",
        "reasonCode",
        "recoveryId"
      ]);
      const claimId = requireUuidV7(payload.claimId);
      if (claimId !== aggregateId || payload.claimVersion !== 2) fail();
      const detail = {
        claimId,
        claimVersion: 2 as const,
        reasonCode: requireEnum(payload.reasonCode, PRIMARY_OBJECTIVE_WITHDRAW_REASON_CODES),
        recoveryId: requireUuidV7(payload.recoveryId)
      };
      if (eventType === "initiative.primary_objective.proposal_rejected") {
        return {
          ...base,
          eventType,
          aggregateType: "claim",
          payload: {
            ...detail,
            disposition: requireEnum(payload.disposition, ["rejected"] as const)
          }
        };
      }
      return {
        ...base,
        eventType,
        aggregateType: "claim",
        payload: {
          ...detail,
          disposition: requireEnum(payload.disposition, ["withdrawn"] as const)
        }
      };
    }
    case "initiative.primary_objective.proposal_reworked": {
      const payload = requireExactObject(envelope.payload, [
        "predecessorClaimId",
        "predecessorVersion",
        "successorClaimId",
        "successorVersion",
        "evidenceSpanId",
        "supportAttestationId",
        "recoveryId",
        "disposition",
        "reasonCode"
      ]);
      const successorClaimId = requireUuidV7(payload.successorClaimId);
      if (
        successorClaimId !== aggregateId ||
        payload.predecessorVersion !== 2 ||
        payload.successorVersion !== 1 ||
        payload.disposition !== "reworked" ||
        payload.reasonCode !== "reworked"
      ) {
        fail();
      }
      return {
        ...base,
        eventType,
        aggregateType: "claim",
        payload: {
          predecessorClaimId: requireUuidV7(payload.predecessorClaimId),
          predecessorVersion: 2,
          successorClaimId,
          successorVersion: 1,
          evidenceSpanId: requireUuidV7(payload.evidenceSpanId),
          supportAttestationId: requireUuidV7(payload.supportAttestationId),
          recoveryId: requireUuidV7(payload.recoveryId),
          disposition: "reworked",
          reasonCode: "reworked"
        }
      };
    }
    case "fact.accepted": {
      const payload = requireExactObject(envelope.payload, ["factId"]);
      const factId = requireUuidV7(payload.factId);
      if (factId !== aggregateId) fail();
      return {
        ...base,
        eventType,
        aggregateType: "accepted_fact",
        payload: { factId }
      };
    }
    case "fact.superseded": {
      const payload = requireExactObject(envelope.payload, [
        "factId",
        "factVersion",
        "reasonCode",
        "replacementFactId",
        "replacementFactVersion",
        "status"
      ]);
      const factId = requireUuidV7(payload.factId);
      if (
        factId !== aggregateId ||
        payload.factVersion !== 2 ||
        payload.replacementFactVersion !== 1 ||
        payload.status !== "superseded"
      ) {
        fail();
      }
      return {
        ...base,
        eventType,
        aggregateType: "accepted_fact",
        payload: {
          factId,
          factVersion: 2,
          reasonCode: requireEnum(payload.reasonCode, SUPERSEDE_REASON_CODES),
          replacementFactId: requireUuidV7(payload.replacementFactId),
          replacementFactVersion: 1,
          status: "superseded"
        }
      };
    }
    case "fact.revoked": {
      const payload = requireExactObject(envelope.payload, [
        "factId",
        "factVersion",
        "reasonCode",
        "status"
      ]);
      const factId = requireUuidV7(payload.factId);
      if (factId !== aggregateId || payload.factVersion !== 2 || payload.status !== "revoked") {
        fail();
      }
      return {
        ...base,
        eventType,
        aggregateType: "accepted_fact",
        payload: {
          factId,
          factVersion: 2,
          reasonCode: requireEnum(payload.reasonCode, REVOKE_REASON_CODES),
          status: "revoked"
        }
      };
    }
  }
}

export function serializeDomainNotificationEnvelope(input: unknown): string {
  return canonicalJsonStringify(parseDomainNotificationEnvelope(input));
}

export function canonicalJsonStringify(input: unknown): string {
  return serializeCanonicalValue(input);
}

function serializeCanonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      fail();
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonicalValue(entry)).join(",")}]`;
  }
  if (!isPlainRecord(value)) fail();
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalValue(value[key])}`);
  return `{${entries.join(",")}}`;
}

function singleIdPayload<K extends string>(
  input: unknown,
  key: K,
  aggregateId: string
): Record<K, string> {
  const payload = requireExactObject(input, [key]);
  const id = requireUuidV7(payload[key]);
  if (id !== aggregateId) fail();
  return { [key]: id } as Record<K, string>;
}

function requireExactObject(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (!isPlainRecord(input)) fail();
  const keys = Object.keys(input);
  if (requiredKeys.some((key) => !Object.hasOwn(input, key))) fail();
  if (keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) fail();
  return input;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function requireEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail();
  return value as T[number];
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail();
  return value.toLowerCase();
}

function requireUuidV7(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) fail();
  return value.toLowerCase();
}

function requirePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
}

function requireBoundedString(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    hasControlCharacters(value)
  ) {
    fail();
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });
}

function requireSafeReference(value: unknown): string {
  const result = requireBoundedString(value, 200);
  if (!SAFE_REFERENCE_PATTERN.test(result)) fail();
  return result;
}

function requireTraceparent(value: unknown): string {
  if (typeof value !== "string" || !TRACEPARENT_PATTERN.test(value)) fail();
  if (value.slice(3, 35) === "0".repeat(32) || value.slice(36, 52) === "0".repeat(16)) fail();
  return value;
}

export function isDomainNotificationTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const offsetHour = value.endsWith("Z") ? 0 : Number(value.slice(-5, -3));
  const offsetMinute = value.endsWith("Z") ? 0 : Number(value.slice(-2));
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 15 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function fail(): never {
  throw new DomainNotificationValidationError();
}
