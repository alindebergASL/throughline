import {
  CONFIDENCE_LOWERING_REASON_CODES,
  CONTEST_REASON_CODES,
  EMERGENCY_REASON_CODES,
  REVOKE_REASON_CODES,
  SUPERSEDE_REASON_CODES,
  UPHOLD_REASON_CODES
} from "@throughline/core-types";
import { describe, expect, it } from "vitest";
import { parseTruthLifecycleReason } from "./reasons.js";

const predecessor = "018f0000-0000-7000-8000-000000000001";
const successor = "018f0000-0000-7000-8000-000000000002";

describe("explicit lifecycle reason contracts", () => {
  it.each([
    ["contest", "conflicting_evidence"],
    ["uphold", "current_fact_confirmed"],
    ["supersede", "corrected_source_revalidated"],
    ["revoke", "support_invalidated"],
    ["emergency", "security_incident"],
    ["confidence_lowering", "evidence_quality"]
  ] as const)("parses the exact %s reason vocabulary", (kind, code) => {
    const reason = parseTruthLifecycleReason(kind, {
      code,
      rationale: "A bounded canonical rationale is required."
    });
    expect(reason).toEqual({ code, rationale: "A bounded canonical rationale is required." });
    expect(Object.isFrozen(reason)).toBe(true);
  });

  it("pins every code in each family and rejects cross-family substitution", () => {
    const vocabularies = [
      ["contest", CONTEST_REASON_CODES],
      ["uphold", UPHOLD_REASON_CODES],
      ["supersede", SUPERSEDE_REASON_CODES],
      ["revoke", REVOKE_REASON_CODES],
      ["emergency", EMERGENCY_REASON_CODES],
      ["confidence_lowering", CONFIDENCE_LOWERING_REASON_CODES]
    ] as const;
    for (const [kind, codes] of vocabularies) {
      for (const code of codes) {
        expect(
          parseTruthLifecycleReason(kind, {
            code,
            rationale: "Exact controlled rationale."
          })
        ).toMatchObject({ code });
      }
    }
    expect(() =>
      parseTruthLifecycleReason("uphold", {
        code: CONTEST_REASON_CODES[0],
        rationale: "Wrong family."
      })
    ).toThrow();
    expect(() =>
      parseTruthLifecycleReason("revoke", {
        code: EMERGENCY_REASON_CODES[0],
        rationale: "Wrong family."
      })
    ).toThrow();
  });

  it("pins source correction and revalidation linkage without rebinding old evidence", () => {
    expect(
      parseTruthLifecycleReason("source_correction", {
        code: "source_corrected",
        predecessorSourceArtifactId: predecessor,
        successorSourceArtifactId: successor
      })
    ).toEqual({
      code: "source_corrected",
      predecessorSourceArtifactId: predecessor,
      successorSourceArtifactId: successor
    });
    expect(
      parseTruthLifecycleReason("source_revalidation", {
        code: "source_revalidated",
        predecessorClaimId: predecessor,
        successorClaimId: successor,
        rationale: "The successor produced a newly verified same-value Claim."
      })
    ).toEqual({
      code: "source_revalidated",
      predecessorClaimId: predecessor,
      successorClaimId: successor,
      rationale: "The successor produced a newly verified same-value Claim."
    });
    expect(() =>
      parseTruthLifecycleReason("source_correction", {
        code: "source_corrected",
        predecessorSourceArtifactId: predecessor,
        successorSourceArtifactId: predecessor
      })
    ).toThrow();
    expect(() =>
      parseTruthLifecycleReason("source_revalidation", {
        code: "source_revalidated",
        predecessorClaimId: predecessor,
        successorClaimId: predecessor,
        rationale: "The same Claim cannot revalidate itself."
      })
    ).toThrow();
  });

  it("pins B1 hash disposition for tombstone and requires erased disposition for erasure", () => {
    expect(
      parseTruthLifecycleReason("source_tombstone", {
        code: "source_tombstoned",
        deletionReasonCategory: "retention_expired",
        deletionPolicyRef: "policy/retention-v1",
        hashDisposition: "retained"
      })
    ).toMatchObject({ code: "source_tombstoned", hashDisposition: "retained" });
    expect(
      parseTruthLifecycleReason("lawful_erasure", {
        code: "lawful_erasure",
        deletionReasonCategory: "data_subject_request",
        deletionPolicyRef: "policy/erasure-v1",
        hashDisposition: "erased"
      })
    ).toMatchObject({ code: "lawful_erasure", hashDisposition: "erased" });
    expect(() =>
      parseTruthLifecycleReason("lawful_erasure", {
        code: "lawful_erasure",
        deletionReasonCategory: "data_subject_request",
        deletionPolicyRef: "policy/erasure-v1",
        hashDisposition: "retained"
      })
    ).toThrow();
  });

  it("rejects unknown codes, missing rationale, unsafe rationale, and unknown fields", () => {
    expect(() =>
      parseTruthLifecycleReason("contest", { code: "anything", rationale: "No." })
    ).toThrow();
    expect(() => parseTruthLifecycleReason("uphold", { code: "current_fact_confirmed" })).toThrow();
    expect(() =>
      parseTruthLifecycleReason("emergency", {
        code: "security_incident",
        rationale: " attacker-controlled padding "
      })
    ).toThrow();
    expect(() =>
      parseTruthLifecycleReason("revoke", {
        code: "support_invalidated",
        rationale: "Valid rationale.",
        actorMembershipId: predecessor
      })
    ).toThrow();
  });
});
