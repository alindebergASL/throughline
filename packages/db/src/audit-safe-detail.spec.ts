import { describe, expect, it } from "vitest";
import { PRODUCT_AUDIT_DETAIL_TEST_VECTORS } from "./audit-safe-detail-test-vectors.js";
import {
  ProductAuditDetailValidationError,
  parseProductAuditSafeDetail
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
});
