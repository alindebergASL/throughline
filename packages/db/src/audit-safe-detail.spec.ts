import { describe, expect, it } from "vitest";
import { PRODUCT_AUDIT_DETAIL_TEST_VECTORS } from "./audit-safe-detail-test-vectors.js";
import {
  ProductAuditDetailValidationError,
  parseProductAuditSafeDetail,
  type ProductAuditAction
} from "./audit-safe-detail.js";

describe("closed B1.0 audit safe-detail language", () => {
  for (const vector of PRODUCT_AUDIT_DETAIL_TEST_VECTORS) {
    it(vector.name, () => {
      const parse = () =>
        parseProductAuditSafeDetail(
          vector.action,
          vector.resourceType,
          vector.resourceId,
          vector.auditSchemaVersion,
          vector.safeDetail
        );

      if (vector.valid) {
        expect(parse()).toEqual(vector.expectedSafeDetail ?? vector.safeDetail);
      } else {
        expect(parse).toThrow(ProductAuditDetailValidationError);
      }
    });
  }

  it("rejects an unknown runtime action", () => {
    expect(() =>
      parseProductAuditSafeDetail(
        "unknown.action" as never,
        "organization",
        "77abcdef-abcd-7abc-8def-abcdef000001",
        1,
        { organizationId: "77abcdef-abcd-7abc-8def-abcdef000001" }
      )
    ).toThrow(ProductAuditDetailValidationError);
  });

  it("accepts exactly the two B2 Slice 1 audit shapes and rejects added keys", () => {
    const factId = "77abcdef-abcd-7abc-8def-abcdef000001";
    const relatedId = "77abcdef-abcd-7abc-8def-abcdef000002";
    const vectors: Array<{
      action: ProductAuditAction;
      resourceType: "claim" | "accepted_fact";
      resourceId: string;
      safeDetail: Record<string, unknown>;
    }> = [
      {
        action: "claim.create",
        resourceType: "claim",
        resourceId: factId,
        safeDetail: { claimId: factId, evidenceSpanId: relatedId }
      },
      {
        action: "fact.accept",
        resourceType: "accepted_fact",
        resourceId: factId,
        safeDetail: { factId }
      }
    ];

    for (const vector of vectors) {
      expect(
        parseProductAuditSafeDetail(
          vector.action,
          vector.resourceType,
          vector.resourceId,
          1,
          vector.safeDetail
        )
      ).toEqual(vector.safeDetail);
      expect(() =>
        parseProductAuditSafeDetail(vector.action, vector.resourceType, vector.resourceId, 1, {
          ...vector.safeDetail,
          unexpected: true
        })
      ).toThrow(ProductAuditDetailValidationError);
    }
  });
});
