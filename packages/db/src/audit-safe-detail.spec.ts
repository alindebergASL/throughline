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

  it("accepts exactly the B2 Slice 1 and objective-recovery audit shapes", () => {
    const resourceId = "77abcdef-abcd-7abc-8def-abcdef000001";
    const relatedId = "77abcdef-abcd-7abc-8def-abcdef000002";
    const evidenceSpanId = "77abcdef-abcd-7abc-8def-abcdef000003";
    const supportAttestationId = "77abcdef-abcd-7abc-8def-abcdef000004";
    const recoveryId = "77abcdef-abcd-7abc-8def-abcdef000005";
    const vectors: Array<{
      action: ProductAuditAction;
      resourceType: "claim" | "accepted_fact";
      resourceId: string;
      safeDetail: Record<string, unknown>;
    }> = [
      {
        action: "claim.create",
        resourceType: "claim",
        resourceId,
        safeDetail: { claimId: resourceId, evidenceSpanId }
      },
      {
        action: "claim.create",
        resourceType: "claim",
        resourceId,
        safeDetail: { claimId: resourceId, evidenceSpanId, supportAttestationId }
      },
      {
        action: "initiative.primary_objective.withdraw",
        resourceType: "claim",
        resourceId,
        safeDetail: {
          claimId: resourceId,
          claimVersion: 2,
          disposition: "withdrawn",
          reasonCode: "needs_rework",
          recoveryId
        }
      },
      {
        action: "initiative.primary_objective.reject",
        resourceType: "claim",
        resourceId,
        safeDetail: {
          claimId: resourceId,
          claimVersion: 2,
          disposition: "rejected",
          reasonCode: "unsupported",
          recoveryId
        }
      },
      {
        action: "initiative.primary_objective.rework",
        resourceType: "claim",
        resourceId,
        safeDetail: {
          predecessorClaimId: relatedId,
          predecessorVersion: 2,
          successorClaimId: resourceId,
          successorVersion: 1,
          evidenceSpanId,
          supportAttestationId,
          recoveryId,
          disposition: "reworked",
          reasonCode: "reworked"
        }
      },
      {
        action: "fact.accept",
        resourceType: "accepted_fact",
        resourceId,
        safeDetail: { factId: resourceId }
      },
      {
        action: "fact.supersede",
        resourceType: "accepted_fact",
        resourceId,
        safeDetail: {
          factId: resourceId,
          factVersion: 2,
          reasonCode: "newer_evidence",
          replacementFactId: relatedId,
          replacementFactVersion: 1,
          status: "superseded"
        }
      },
      {
        action: "fact.revoke",
        resourceType: "accepted_fact",
        resourceId,
        safeDetail: {
          factId: resourceId,
          factVersion: 2,
          reasonCode: "no_longer_true",
          status: "revoked"
        }
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

  it("rejects malformed ordinary Fact lifecycle audit fields", () => {
    const factId = "77abcdef-abcd-7abc-8def-abcdef000001";
    const replacementFactId = "77abcdef-abcd-7abc-8def-abcdef000002";
    const invalidVectors: Array<{
      action: ProductAuditAction;
      safeDetail: Record<string, unknown>;
    }> = [
      {
        action: "fact.supersede",
        safeDetail: {
          factId,
          factVersion: 1,
          reasonCode: "newer_evidence",
          replacementFactId,
          replacementFactVersion: 1,
          status: "superseded"
        }
      },
      {
        action: "fact.supersede",
        safeDetail: {
          factId,
          factVersion: 2,
          reasonCode: "no_longer_true",
          replacementFactId,
          replacementFactVersion: 1,
          status: "superseded"
        }
      },
      {
        action: "fact.supersede",
        safeDetail: {
          factId,
          factVersion: 2,
          reasonCode: "newer_evidence",
          replacementFactId,
          replacementFactVersion: 2,
          status: "superseded"
        }
      },
      {
        action: "fact.supersede",
        safeDetail: {
          factId,
          factVersion: 2,
          reasonCode: "newer_evidence",
          replacementFactId,
          replacementFactVersion: 1,
          status: "revoked"
        }
      },
      {
        action: "fact.revoke",
        safeDetail: {
          factId,
          factVersion: 2,
          reasonCode: "newer_evidence",
          status: "revoked"
        }
      },
      {
        action: "fact.revoke",
        safeDetail: {
          factId,
          factVersion: 2,
          reasonCode: "no_longer_true",
          replacementFactId,
          status: "revoked"
        }
      }
    ];

    for (const vector of invalidVectors) {
      expect(() =>
        parseProductAuditSafeDetail(vector.action, "accepted_fact", factId, 1, vector.safeDetail)
      ).toThrow(ProductAuditDetailValidationError);
      expect(() =>
        parseProductAuditSafeDetail(vector.action, "claim", factId, 1, vector.safeDetail)
      ).toThrow(ProductAuditDetailValidationError);
    }
  });

  it("rejects malformed objective support and recovery audit fields", () => {
    const claimId = "77abcdef-abcd-7abc-8def-abcdef000001";
    const predecessorClaimId = "77abcdef-abcd-7abc-8def-abcdef000002";
    const evidenceSpanId = "77abcdef-abcd-7abc-8def-abcdef000003";
    const supportAttestationId = "77abcdef-abcd-7abc-8def-abcdef000004";
    const recoveryId = "77abcdef-abcd-7abc-8def-abcdef000005";
    const invalidVectors: Array<{
      action: ProductAuditAction;
      safeDetail: Record<string, unknown>;
    }> = [
      {
        action: "claim.create",
        safeDetail: { claimId, evidenceSpanId, supportAttestationId: "not-a-uuid" }
      },
      {
        action: "initiative.primary_objective.withdraw",
        safeDetail: {
          claimId,
          claimVersion: 1,
          disposition: "withdrawn",
          reasonCode: "needs_rework",
          recoveryId
        }
      },
      {
        action: "initiative.primary_objective.withdraw",
        safeDetail: {
          claimId,
          claimVersion: 2,
          disposition: "superseded",
          reasonCode: "needs_rework",
          recoveryId
        }
      },
      {
        action: "initiative.primary_objective.withdraw",
        safeDetail: {
          claimId,
          claimVersion: 2,
          disposition: "rejected",
          reasonCode: "arbitrary_reason",
          recoveryId
        }
      },
      {
        action: "initiative.primary_objective.rework",
        safeDetail: {
          predecessorClaimId,
          predecessorVersion: 2,
          successorClaimId: claimId,
          successorVersion: 1,
          evidenceSpanId,
          supportAttestationId,
          recoveryId,
          disposition: "reworked",
          reasonCode: "arbitrary_reason"
        }
      }
    ];

    for (const vector of invalidVectors) {
      expect(() =>
        parseProductAuditSafeDetail(vector.action, "claim", claimId, 1, vector.safeDetail)
      ).toThrow(ProductAuditDetailValidationError);
    }
  });
});
