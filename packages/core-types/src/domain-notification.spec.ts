import { describe, expect, it } from "vitest";
import {
  DOMAIN_NOTIFICATION_AGGREGATE_TYPES,
  DOMAIN_NOTIFICATION_EVENT_AGGREGATE_PAIRS,
  DOMAIN_NOTIFICATION_EVENT_TYPES,
  canonicalJsonStringify,
  parseDomainNotificationEnvelope,
  serializeDomainNotificationEnvelope
} from "./domain-notification.js";

const ids = {
  event: "70000000-0000-7000-8000-000000000001",
  aggregate: "70000000-0000-7000-8000-000000000002",
  command: "70000000-0000-7000-8000-000000000003",
  source: "70000000-0000-7000-8000-000000000004",
  previousSource: "70000000-0000-7000-8000-000000000005",
  attestation: "70000000-0000-7000-8000-000000000006",
  recovery: "70000000-0000-7000-8000-000000000007",
  tenant: "10000000-0000-4000-8000-000000000001",
  workspace: "10000000-0000-4000-8000-000000000002",
  space: "10000000-0000-4000-8000-000000000003"
} as const;

function envelope(eventType: string): Record<string, unknown> {
  const aggregateType =
    DOMAIN_NOTIFICATION_EVENT_AGGREGATE_PAIRS[
      eventType as keyof typeof DOMAIN_NOTIFICATION_EVENT_AGGREGATE_PAIRS
    ];
  return {
    eventId: ids.event,
    eventType,
    eventSchemaVersion: 1,
    payloadSchemaVersion: 1,
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    spaceId: ids.space,
    aggregateType,
    aggregateId: ids.aggregate,
    aggregateVersion: 1,
    causationCommandId: ids.command,
    payload: payload(eventType),
    requestId: "request-1",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: "vendor=value"
  };
}

function payload(eventType: string): Record<string, unknown> {
  switch (eventType) {
    case "organization.created":
      return { organizationId: ids.aggregate };
    case "initiative.created":
      return { initiativeId: ids.aggregate };
    case "activity.created":
      return { activityId: ids.aggregate };
    case "activity.capture_added":
      return { activityId: ids.aggregate, sourceArtifactId: ids.source };
    case "relationship.created":
      return { relationshipId: ids.aggregate };
    case "relationship.ended":
      return { relationshipId: ids.aggregate, validTo: "2026-07-14T12:00:00Z" };
    case "content.created":
      return { contentItemId: ids.aggregate };
    case "content.revised":
      return { contentItemId: ids.aggregate, revisionNumber: 2 };
    case "source_artifact.captured":
      return { sourceArtifactId: ids.aggregate };
    case "source_artifact.corrected":
      return {
        sourceArtifactId: ids.aggregate,
        previousSourceArtifactId: ids.previousSource
      };
    case "source_artifact.tombstoned":
      return {
        sourceArtifactId: ids.aggregate,
        deletionReasonCategory: "retention.expired",
        deletionPolicyRef: "policy:retention-v1",
        hashDisposition: "erased"
      };
    case "claim.proposed":
      return {
        claimId: ids.aggregate,
        evidenceSpanId: ids.source,
        supportAttestationId: ids.attestation
      };
    case "initiative.primary_objective.proposal_withdrawn":
      return {
        claimId: ids.aggregate,
        claimVersion: 2,
        disposition: "withdrawn",
        reasonCode: "needs_rework",
        recoveryId: ids.recovery
      };
    case "initiative.primary_objective.proposal_rejected":
      return {
        claimId: ids.aggregate,
        claimVersion: 2,
        disposition: "rejected",
        reasonCode: "unsupported",
        recoveryId: ids.recovery
      };
    case "initiative.primary_objective.proposal_reworked":
      return {
        predecessorClaimId: ids.previousSource,
        predecessorVersion: 2,
        successorClaimId: ids.aggregate,
        successorVersion: 1,
        evidenceSpanId: ids.source,
        supportAttestationId: ids.attestation,
        recoveryId: ids.recovery,
        disposition: "reworked",
        reasonCode: "reworked"
      };
    case "fact.accepted":
      return { factId: ids.aggregate };
    default:
      throw new Error("test event is not allowlisted");
  }
}

describe("DomainNotificationEnvelope", () => {
  it("keeps the event, aggregate, and event/aggregate pair unions exactly closed", () => {
    expect(DOMAIN_NOTIFICATION_EVENT_TYPES).toEqual([
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
      "fact.accepted"
    ]);
    expect(DOMAIN_NOTIFICATION_AGGREGATE_TYPES).toEqual([
      "organization",
      "initiative",
      "activity",
      "relationship",
      "content_item",
      "source_artifact",
      "claim",
      "accepted_fact"
    ]);
    for (const eventType of DOMAIN_NOTIFICATION_EVENT_TYPES) {
      expect(parseDomainNotificationEnvelope(envelope(eventType))).toMatchObject({ eventType });
    }
  });

  it("keeps objective support and recovery payloads exact and fail closed", () => {
    expect(
      parseDomainNotificationEnvelope({
        ...envelope("claim.proposed"),
        payload: { claimId: ids.aggregate, evidenceSpanId: ids.source }
      })
    ).toMatchObject({ payload: { claimId: ids.aggregate, evidenceSpanId: ids.source } });

    for (const [eventType, payloadOverride] of [
      [
        "claim.proposed",
        { claimId: ids.aggregate, evidenceSpanId: ids.source, supportAttestationId: "not-a-uuid" }
      ],
      [
        "initiative.primary_objective.proposal_withdrawn",
        {
          ...payload("initiative.primary_objective.proposal_withdrawn"),
          reasonCode: "arbitrary_reason"
        }
      ],
      [
        "initiative.primary_objective.proposal_rejected",
        {
          ...payload("initiative.primary_objective.proposal_rejected"),
          disposition: "withdrawn"
        }
      ],
      [
        "initiative.primary_objective.proposal_reworked",
        {
          ...payload("initiative.primary_objective.proposal_reworked"),
          predecessorVersion: 1
        }
      ]
    ] as const) {
      expect(() =>
        parseDomainNotificationEnvelope({ ...envelope(eventType), payload: payloadOverride })
      ).toThrow("Domain notification envelope is invalid");
    }

    expect(() =>
      parseDomainNotificationEnvelope({
        ...envelope("initiative.primary_objective.proposal_reworked"),
        payload: {
          ...payload("initiative.primary_objective.proposal_reworked"),
          objectiveText: "must not enter the event"
        }
      })
    ).toThrow("Domain notification envelope is invalid");
  });

  it("rejects unknown fields, authority fields, wrong pairs, and payload/aggregate drift", () => {
    expect(() =>
      parseDomainNotificationEnvelope({ ...envelope("organization.created"), jobId: ids.event })
    ).toThrow("Domain notification envelope is invalid");
    expect(() =>
      parseDomainNotificationEnvelope({
        ...envelope("organization.created"),
        aggregateType: "initiative"
      })
    ).toThrow("Domain notification envelope is invalid");
    expect(() =>
      parseDomainNotificationEnvelope({
        ...envelope("organization.created"),
        payload: { organizationId: ids.source }
      })
    ).toThrow("Domain notification envelope is invalid");
    expect(() =>
      parseDomainNotificationEnvelope({
        ...envelope("organization.created"),
        payload: { organizationId: ids.aggregate, objectKey: "restricted/source.txt" }
      })
    ).toThrow("Domain notification envelope is invalid");
  });

  it("rejects relationship timestamps outside the shared PostgreSQL calendar and range contract", () => {
    const base = envelope("relationship.ended");
    for (const validTo of [
      "2026-02-30T12:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T12:00:60Z",
      "2026-01-01T12:00:00+16:00"
    ]) {
      expect(() =>
        parseDomainNotificationEnvelope({
          ...base,
          payload: { relationshipId: ids.aggregate, validTo }
        })
      ).toThrow("Domain notification envelope is invalid");
    }
  });

  it("serializes canonically without erasing trusted differences", () => {
    const first = envelope("content.revised");
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    expect(serializeDomainNotificationEnvelope(first)).toBe(
      serializeDomainNotificationEnvelope(reordered)
    );
    expect(canonicalJsonStringify({ b: 2, a: "é" })).toBe('{"a":"é","b":2}');
    expect(canonicalJsonStringify({ text: "e\u0301" })).not.toBe(
      canonicalJsonStringify({ text: "é" })
    );
    expect(() => canonicalJsonStringify({ value: -0 })).toThrow();
    expect(() => canonicalJsonStringify({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => canonicalJsonStringify({ value: undefined })).toThrow();
  });
});
