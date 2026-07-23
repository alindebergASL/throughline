import { describe, expect, it } from "vitest";
import {
  ACCEPTED_FACT_CONFIDENCE_RULE,
  assessRecordedConfidenceSupport,
  calculateAcceptedFactConfidence
} from "./confidence.js";

const claim = (suffix: string, confidence: "confirmed" | "strong" | "weak" | "unknown") => ({
  claimId: `018f0000-0000-7000-8000-0000000000${suffix}`,
  confidence,
  valid: true
});

describe("AcceptedFact confidence", () => {
  it("selects the strongest valid Claim with explicit audit metadata", () => {
    const result = calculateAcceptedFactConfidence({
      selectedClaims: [claim("01", "weak"), claim("02", "confirmed"), claim("03", "strong")]
    });
    expect(result).toMatchObject({
      rule: ACCEPTED_FACT_CONFIDENCE_RULE,
      confidence: "confirmed",
      strongestSupportingConfidence: "confirmed",
      strongestSupportingClaimIds: ["018f0000-0000-7000-8000-000000000002"],
      validSupportCount: 3,
      countBoostApplied: false,
      humanLowered: false
    });
  });

  it("never boosts confidence because corroborating Claim count increased", () => {
    const one = calculateAcceptedFactConfidence({ selectedClaims: [claim("01", "weak")] });
    const many = calculateAcceptedFactConfidence({
      selectedClaims: [claim("01", "weak"), claim("02", "weak"), claim("03", "weak")]
    });
    expect(one.confidence).toBe("weak");
    expect(many.confidence).toBe("weak");
    expect(many.countBoostApplied).toBe(false);
  });

  it("excludes invalid selections from the strongest-support decision", () => {
    const invalidConfirmed = { ...claim("01", "confirmed"), valid: false };
    const result = calculateAcceptedFactConfidence({
      selectedClaims: [invalidConfirmed, claim("02", "strong")]
    });
    expect(result.confidence).toBe("strong");
    expect(result.excludedInvalidClaimIds).toEqual(["018f0000-0000-7000-8000-000000000001"]);
  });

  it("allows a strictly lower human result only with a controlled rationale", () => {
    const result = calculateAcceptedFactConfidence({
      selectedClaims: [claim("01", "confirmed"), claim("02", "strong")],
      requestedLowering: {
        confidence: "weak",
        reason: {
          code: "residual_uncertainty",
          rationale: "The evidence is direct, but the time horizon remains uncertain."
        }
      }
    });
    expect(result).toMatchObject({
      confidence: "weak",
      strongestSupportingConfidence: "confirmed",
      humanLowered: true,
      lowering: {
        from: "confirmed",
        to: "weak",
        reason: { code: "residual_uncertainty" }
      }
    });
  });

  it("rejects an attempted raise, a no-op lowering, missing support, and unsafe rationale", () => {
    expect(() =>
      calculateAcceptedFactConfidence({
        selectedClaims: [claim("01", "weak")],
        requestedLowering: {
          confidence: "strong",
          reason: { code: "evidence_quality", rationale: "Cannot raise" }
        }
      })
    ).toThrow();
    expect(() =>
      calculateAcceptedFactConfidence({
        selectedClaims: [claim("01", "strong")],
        requestedLowering: {
          confidence: "strong",
          reason: { code: "evidence_quality", rationale: "No actual lowering" }
        }
      })
    ).toThrow();
    expect(() =>
      calculateAcceptedFactConfidence({
        selectedClaims: [{ ...claim("01", "confirmed"), valid: false }]
      })
    ).toThrow();
    expect(() =>
      calculateAcceptedFactConfidence({
        selectedClaims: [claim("01", "strong")],
        requestedLowering: {
          confidence: "weak",
          reason: { code: "evidence_quality", rationale: " unsafe " }
        }
      })
    ).toThrow();
  });

  it("never silently mutates recorded confidence when later support weakens", () => {
    const assessment = assessRecordedConfidenceSupport({
      recordedConfidence: "strong",
      activeClaims: [claim("01", "weak"), claim("02", "weak")]
    });
    expect(assessment).toEqual({
      rule: "recorded-confidence-support-assessment.v1",
      recordedConfidence: "strong",
      strongestActiveSupport: "weak",
      disposition: "review_required",
      recomputedStoredConfidence: false,
      activeValidClaimIds: [
        "018f0000-0000-7000-8000-000000000001",
        "018f0000-0000-7000-8000-000000000002"
      ]
    });
  });

  it("fails closed for prototype-key confidence values and duplicate support", () => {
    expect(() =>
      assessRecordedConfidenceSupport({
        recordedConfidence: "toString" as "strong",
        activeClaims: [claim("01", "strong")]
      })
    ).toThrow();
    expect(() =>
      calculateAcceptedFactConfidence({
        selectedClaims: [{ ...claim("01", "strong"), confidence: "constructor" as "strong" }]
      })
    ).toThrow();
    expect(() =>
      calculateAcceptedFactConfidence({
        selectedClaims: [claim("01", "strong"), claim("01", "weak")]
      })
    ).toThrow();
  });
});
