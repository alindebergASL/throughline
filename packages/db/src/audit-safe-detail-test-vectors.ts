import type { ProductAuditAction, ProductAuditSafeDetailInput } from "./audit-safe-detail.js";

export interface ProductAuditDetailTestVector {
  name: string;
  action: ProductAuditAction;
  resourceType: ProductAuditSafeDetailInput["resourceType"];
  resourceId: string;
  auditSchemaVersion: number;
  safeDetail: unknown;
  expectedSafeDetail?: unknown;
  valid: boolean;
}

const ids = {
  organization: "77abcdef-abcd-7abc-8def-abcdef000001",
  initiative: "77000000-0000-7000-8000-000000000002",
  activity: "77000000-0000-7000-8000-000000000003",
  source: "77000000-0000-7000-8000-000000000004",
  previousSource: "77000000-0000-7000-8000-000000000005",
  relationship: "77000000-0000-7000-8000-000000000006",
  content: "77000000-0000-7000-8000-000000000007",
  other: "77000000-0000-7000-8000-000000000099"
} as const;

const validVectors: ProductAuditDetailTestVector[] = [
  vector("organization.create", "organization", ids.organization, {
    organizationId: ids.organization
  }),
  vector("initiative.create", "initiative", ids.initiative, {
    initiativeId: ids.initiative
  }),
  vector("activity.create", "activity", ids.activity, { activityId: ids.activity }),
  vector("activity.capture_add", "activity", ids.activity, {
    activityId: ids.activity,
    sourceArtifactId: ids.source
  }),
  vector("relationship.create", "relationship", ids.relationship, {
    relationshipId: ids.relationship
  }),
  vector("relationship.end", "relationship", ids.relationship, {
    relationshipId: ids.relationship,
    validTo: "2026-07-15T12:30:45.123456789+00:00"
  }),
  vector("content.create", "content_item", ids.content, { contentItemId: ids.content }),
  vector("content.revise", "content_item", ids.content, {
    contentItemId: ids.content,
    revisionNumber: Number.MAX_SAFE_INTEGER
  }),
  vector("source_artifact.capture", "source_artifact", ids.source, {
    sourceArtifactId: ids.source
  }),
  vector("source_artifact.correct", "source_artifact", ids.source, {
    sourceArtifactId: ids.source,
    previousSourceArtifactId: ids.previousSource
  }),
  vector("source_artifact.tombstone", "source_artifact", ids.source, {
    sourceArtifactId: ids.source,
    deletionPolicyRef: "retention/default-v1",
    deletionReasonCategory: "workspace_retention",
    hashDisposition: "erased"
  }),
  {
    name: "normalizes uppercase UUIDv7 detail values",
    action: "organization.create",
    resourceType: "organization",
    resourceId: ids.organization.toUpperCase(),
    auditSchemaVersion: 1,
    safeDetail: { organizationId: ids.organization.toUpperCase() },
    expectedSafeDetail: { organizationId: ids.organization },
    valid: true
  }
];

const forbiddenExtraKeys = [
  "extra",
  "body",
  "rawBody",
  "transcript",
  "rawTranscript",
  "source",
  "rawSource",
  "sourceText",
  "immutableText",
  "normalizedText",
  "objectKey",
  "s3ObjectKey",
  "storageKey",
  "displayName",
  "primaryEmail",
  "titleFactId",
  "employerOrganizationId",
  "isInternal",
  "externalRefs",
  "credential",
  "credentials",
  "secret",
  "password",
  "token",
  "apiKey",
  "authorization",
  "contentHash",
  "normalizedContentHash",
  "policyErasedHash",
  "sourceHash",
  "sha256"
] as const;

const invalidVectors: ProductAuditDetailTestVector[] = [
  ...forbiddenExtraKeys.map((key) => ({
    name: `rejects forbidden or unknown key ${key}`,
    action: "organization.create" as const,
    resourceType: "organization" as const,
    resourceId: ids.organization,
    auditSchemaVersion: 1,
    safeDetail: { organizationId: ids.organization, [key]: "must-not-persist" },
    valid: false
  })),
  invalid("rejects schema version zero", { auditSchemaVersion: 0 }),
  invalid("rejects future schema versions", { auditSchemaVersion: 2 }),
  invalid("rejects action and resource mismatch", { resourceType: "initiative" }),
  invalid("rejects resource ID drift", {
    safeDetail: { organizationId: ids.other }
  }),
  invalid("rejects a missing required key", { safeDetail: {} }),
  invalid("rejects a null required value", { safeDetail: { organizationId: null } }),
  invalid("rejects null detail", { safeDetail: null }),
  invalid("rejects array detail", { safeDetail: [ids.organization] }),
  invalid("rejects scalar detail", { safeDetail: "organization" }),
  invalid("rejects nested detail values", {
    safeDetail: { organizationId: { value: ids.organization } }
  }),
  invalid("rejects non-v7 resource IDs", {
    resourceId: "77000000-0000-4000-8000-000000000001"
  }),
  {
    name: "rejects identical corrected source IDs",
    action: "source_artifact.correct",
    resourceType: "source_artifact",
    resourceId: ids.source,
    auditSchemaVersion: 1,
    safeDetail: {
      sourceArtifactId: ids.source,
      previousSourceArtifactId: ids.source
    },
    valid: false
  },
  {
    name: "rejects case-varied identical corrected source IDs",
    action: "source_artifact.correct",
    resourceType: "source_artifact",
    resourceId: ids.source,
    auditSchemaVersion: 1,
    safeDetail: {
      sourceArtifactId: ids.source,
      previousSourceArtifactId: ids.source.toUpperCase()
    },
    valid: false
  },
  {
    name: "rejects malformed relationship timestamps",
    action: "relationship.end",
    resourceType: "relationship",
    resourceId: ids.relationship,
    auditSchemaVersion: 1,
    safeDetail: { relationshipId: ids.relationship, validTo: "next Friday" },
    valid: false
  },
  {
    name: "rejects non-integer revisions",
    action: "content.revise",
    resourceType: "content_item",
    resourceId: ids.content,
    auditSchemaVersion: 1,
    safeDetail: { contentItemId: ids.content, revisionNumber: 1.5 },
    valid: false
  },
  {
    name: "rejects string revisions",
    action: "content.revise",
    resourceType: "content_item",
    resourceId: ids.content,
    auditSchemaVersion: 1,
    safeDetail: { contentItemId: ids.content, revisionNumber: "1" },
    valid: false
  },
  {
    name: "rejects unsafe integer revisions",
    action: "content.revise",
    resourceType: "content_item",
    resourceId: ids.content,
    auditSchemaVersion: 1,
    safeDetail: { contentItemId: ids.content, revisionNumber: Number.MAX_SAFE_INTEGER + 1 },
    valid: false
  },
  {
    name: "rejects numeric tombstone references",
    action: "source_artifact.tombstone",
    resourceType: "source_artifact",
    resourceId: ids.source,
    auditSchemaVersion: 1,
    safeDetail: {
      sourceArtifactId: ids.source,
      deletionPolicyRef: 1,
      deletionReasonCategory: "retention",
      hashDisposition: "erased"
    },
    valid: false
  },
  {
    name: "rejects invalid tombstone dispositions",
    action: "source_artifact.tombstone",
    resourceType: "source_artifact",
    resourceId: ids.source,
    auditSchemaVersion: 1,
    safeDetail: {
      sourceArtifactId: ids.source,
      deletionPolicyRef: "retention/default-v1",
      deletionReasonCategory: "retention",
      hashDisposition: "unknown"
    },
    valid: false
  }
];

export const PRODUCT_AUDIT_DETAIL_TEST_VECTORS = Object.freeze([
  ...validVectors,
  ...invalidVectors
]);

function vector<Action extends ProductAuditAction>(
  action: Action,
  resourceType: ProductAuditDetailMapResource<Action>,
  resourceId: string,
  safeDetail: unknown
): ProductAuditDetailTestVector {
  return {
    name: `accepts ${action} version 1 detail`,
    action,
    resourceType,
    resourceId,
    auditSchemaVersion: 1,
    safeDetail,
    valid: true
  };
}

type ProductAuditDetailMapResource<Action extends ProductAuditAction> = Extract<
  ProductAuditSafeDetailInput,
  { action: Action }
>["resourceType"];

function invalid(
  name: string,
  overrides: Partial<ProductAuditDetailTestVector>
): ProductAuditDetailTestVector {
  return {
    name,
    action: "organization.create",
    resourceType: "organization",
    resourceId: ids.organization,
    auditSchemaVersion: 1,
    safeDetail: { organizationId: ids.organization },
    valid: false,
    ...overrides
  };
}
