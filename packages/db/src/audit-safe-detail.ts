import { isDomainNotificationTimestamp } from "@throughline/core-types";

export const PRODUCT_AUDIT_SCHEMA_VERSION = 1 as const;

export interface ProductAuditDetailMap {
  "organization.create": {
    resourceType: "organization";
    detail: { organizationId: string };
  };
  "initiative.create": {
    resourceType: "initiative";
    detail: { initiativeId: string };
  };
  "activity.create": {
    resourceType: "activity";
    detail: { activityId: string };
  };
  "activity.capture_add": {
    resourceType: "activity";
    detail: { activityId: string; sourceArtifactId: string };
  };
  "relationship.create": {
    resourceType: "relationship";
    detail: { relationshipId: string };
  };
  "relationship.end": {
    resourceType: "relationship";
    detail: { relationshipId: string; validTo: string };
  };
  "content.create": {
    resourceType: "content_item";
    detail: { contentItemId: string };
  };
  "content.revise": {
    resourceType: "content_item";
    detail: { contentItemId: string; revisionNumber: number };
  };
  "source_artifact.capture": {
    resourceType: "source_artifact";
    detail: { sourceArtifactId: string };
  };
  "source_artifact.correct": {
    resourceType: "source_artifact";
    detail: { sourceArtifactId: string; previousSourceArtifactId: string };
  };
  "source_artifact.tombstone": {
    resourceType: "source_artifact";
    detail: {
      sourceArtifactId: string;
      deletionPolicyRef: string;
      deletionReasonCategory: string;
      hashDisposition: "retained" | "erased";
    };
  };
  "claim.create": {
    resourceType: "claim";
    detail: { claimId: string; evidenceSpanId: string };
  };
  "fact.accept": {
    resourceType: "accepted_fact";
    detail: { factId: string };
  };
}

export type ProductAuditAction = keyof ProductAuditDetailMap;

export type ProductAuditSafeDetailInput = {
  [Action in ProductAuditAction]: {
    action: Action;
    resourceType: ProductAuditDetailMap[Action]["resourceType"];
    resourceId: string;
    auditSchemaVersion: typeof PRODUCT_AUDIT_SCHEMA_VERSION;
    safeDetail: ProductAuditDetailMap[Action]["detail"];
  };
}[ProductAuditAction];

export type ProductAuditSafeDetail = ProductAuditSafeDetailInput["safeDetail"];

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export class ProductAuditDetailValidationError extends Error {
  constructor() {
    super("Product audit safe detail is invalid");
    this.name = "ProductAuditDetailValidationError";
  }
}

export function parseProductAuditSafeDetail(
  action: ProductAuditAction,
  resourceType: ProductAuditSafeDetailInput["resourceType"],
  resourceIdInput: string,
  auditSchemaVersion: number,
  safeDetail: unknown
): ProductAuditSafeDetail {
  if (auditSchemaVersion !== PRODUCT_AUDIT_SCHEMA_VERSION) fail();
  const resourceId = requireUuidV7(resourceIdInput);

  switch (action) {
    case "organization.create":
      requireResourceType(resourceType, "organization");
      return singleResourceIdDetail(safeDetail, "organizationId", resourceId);
    case "initiative.create":
      requireResourceType(resourceType, "initiative");
      return singleResourceIdDetail(safeDetail, "initiativeId", resourceId);
    case "activity.create":
      requireResourceType(resourceType, "activity");
      return singleResourceIdDetail(safeDetail, "activityId", resourceId);
    case "activity.capture_add": {
      requireResourceType(resourceType, "activity");
      const detail = requireExactObject(safeDetail, ["activityId", "sourceArtifactId"]);
      const activityId = requireUuidV7(detail.activityId);
      if (activityId !== resourceId) fail();
      return { activityId, sourceArtifactId: requireUuidV7(detail.sourceArtifactId) };
    }
    case "relationship.create":
      requireResourceType(resourceType, "relationship");
      return singleResourceIdDetail(safeDetail, "relationshipId", resourceId);
    case "relationship.end": {
      requireResourceType(resourceType, "relationship");
      const detail = requireExactObject(safeDetail, ["relationshipId", "validTo"]);
      const relationshipId = requireUuidV7(detail.relationshipId);
      if (relationshipId !== resourceId || !isDomainNotificationTimestamp(detail.validTo)) fail();
      return { relationshipId, validTo: detail.validTo };
    }
    case "content.create":
      requireResourceType(resourceType, "content_item");
      return singleResourceIdDetail(safeDetail, "contentItemId", resourceId);
    case "content.revise": {
      requireResourceType(resourceType, "content_item");
      const detail = requireExactObject(safeDetail, ["contentItemId", "revisionNumber"]);
      const contentItemId = requireUuidV7(detail.contentItemId);
      if (contentItemId !== resourceId || !Number.isSafeInteger(detail.revisionNumber)) fail();
      const revisionNumber = detail.revisionNumber as number;
      if (revisionNumber < 1) fail();
      return { contentItemId, revisionNumber };
    }
    case "source_artifact.capture":
      requireResourceType(resourceType, "source_artifact");
      return singleResourceIdDetail(safeDetail, "sourceArtifactId", resourceId);
    case "source_artifact.correct": {
      requireResourceType(resourceType, "source_artifact");
      const detail = requireExactObject(safeDetail, [
        "sourceArtifactId",
        "previousSourceArtifactId"
      ]);
      const sourceArtifactId = requireUuidV7(detail.sourceArtifactId);
      const previousSourceArtifactId = requireUuidV7(detail.previousSourceArtifactId);
      if (sourceArtifactId !== resourceId || previousSourceArtifactId === sourceArtifactId) fail();
      return { sourceArtifactId, previousSourceArtifactId };
    }
    case "source_artifact.tombstone": {
      requireResourceType(resourceType, "source_artifact");
      const detail = requireExactObject(safeDetail, [
        "sourceArtifactId",
        "deletionPolicyRef",
        "deletionReasonCategory",
        "hashDisposition"
      ]);
      const sourceArtifactId = requireUuidV7(detail.sourceArtifactId);
      if (sourceArtifactId !== resourceId) fail();
      const hashDisposition = requireEnum(detail.hashDisposition, ["retained", "erased"] as const);
      return {
        sourceArtifactId,
        deletionPolicyRef: requireSafeReference(detail.deletionPolicyRef),
        deletionReasonCategory: requireSafeReference(detail.deletionReasonCategory),
        hashDisposition
      };
    }
    case "claim.create": {
      requireResourceType(resourceType, "claim");
      const detail = requireExactObject(safeDetail, ["claimId", "evidenceSpanId"]);
      const claimId = requireUuidV7(detail.claimId);
      if (claimId !== resourceId) fail();
      return {
        claimId,
        evidenceSpanId: requireUuidV7(detail.evidenceSpanId)
      };
    }
    case "fact.accept": {
      requireResourceType(resourceType, "accepted_fact");
      const detail = requireExactObject(safeDetail, ["factId"]);
      const factId = requireUuidV7(detail.factId);
      if (factId !== resourceId) fail();
      return { factId };
    }
  }

  fail();
}

function singleResourceIdDetail<Key extends string>(
  input: unknown,
  key: Key,
  resourceId: string
): Record<Key, string> {
  const detail = requireExactObject(input, [key]);
  const detailId = requireUuidV7(detail[key]);
  if (detailId !== resourceId) fail();
  return { [key]: detailId } as Record<Key, string>;
}

function requireExactObject(
  input: unknown,
  requiredKeys: readonly string[]
): Record<string, unknown> {
  if (!isPlainRecord(input)) fail();
  const keys = Object.keys(input);
  if (
    keys.length !== requiredKeys.length ||
    requiredKeys.some((key) => !Object.hasOwn(input, key)) ||
    keys.some((key) => !requiredKeys.includes(key))
  ) {
    fail();
  }
  return input;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function requireResourceType(actual: string, expected: string): void {
  if (actual !== expected) fail();
}

function requireUuidV7(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) fail();
  return value.toLowerCase();
}

function requireSafeReference(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REFERENCE_PATTERN.test(value)) fail();
  return value;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) fail();
  return value as Values[number];
}

function fail(): never {
  throw new ProductAuditDetailValidationError();
}
