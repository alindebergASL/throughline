import { B2_TRUTH_PREDICATES } from "@throughline/core-types";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PREDICATE_TEXT_MAX_SCALARS,
  TRUTH_PREDICATE_CATALOG_VERSION,
  TRUTH_PREDICATE_REGISTRY,
  canonicalizePredicateText,
  parseCanonicalPredicateText,
  parsePredicateAssertion,
  resolvePredicateDefinition
} from "./predicate-registry.js";

describe("truth-predicate-catalog.v1", () => {
  it("contains exactly the two product-owned single-valued predicates", () => {
    expect(TRUTH_PREDICATE_CATALOG_VERSION).toBe("truth-predicate-catalog.v1");
    expect(B2_TRUTH_PREDICATES).toEqual(["activity.outcome", "initiative.primary_objective"]);
    expect(Object.keys(TRUTH_PREDICATE_REGISTRY)).toEqual(B2_TRUTH_PREDICATES);
    expect(TRUTH_PREDICATE_REGISTRY["activity.outcome"]).toMatchObject({
      allowedSubjectKind: "activity",
      cardinality: "single",
      authorityScope: "activity_owner",
      deterministicViewTreatment: {
        viewType: "initiative_summary",
        section: "activity_outcomes",
        includeStatuses: ["current", "contested"],
        reviewVisibilityByBasis: {
          claimConflict: {
            visibleWhen: "challenger_and_conflict_are_authorized_for_audience",
            challengerRequired: true
          },
          sourceCorrection: {
            visibleWhen: "review_basis_is_authorized_for_audience",
            challengerRequired: false
          },
          supportInvalidation: {
            visibleWhen: "review_basis_is_authorized_for_audience",
            challengerRequired: false
          }
        },
        excludeStatuses: ["superseded", "revoked"]
      }
    });
    expect(TRUTH_PREDICATE_REGISTRY["initiative.primary_objective"]).toMatchObject({
      allowedSubjectKind: "initiative",
      cardinality: "single",
      authorityScope: "initiative_owner",
      deterministicViewTreatment: {
        viewType: "initiative_summary",
        section: "primary_objective"
      }
    });
    expect(Object.isFrozen(TRUTH_PREDICATE_REGISTRY)).toBe(true);
    for (const definition of Object.values(TRUTH_PREDICATE_REGISTRY)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.deterministicViewTreatment)).toBe(true);
      expect(Object.isFrozen(definition.deterministicViewTreatment.includeStatuses)).toBe(true);
      expect(Object.isFrozen(definition.deterministicViewTreatment.reviewVisibilityByBasis)).toBe(
        true
      );
      expect(
        Object.values(definition.deterministicViewTreatment.reviewVisibilityByBasis).every(
          Object.isFrozen
        )
      ).toBe(true);
      expect(Object.isFrozen(definition.deterministicViewTreatment.excludeStatuses)).toBe(true);
    }
  });

  it("fails closed for unknown predicates and wrong subject kinds", () => {
    expect(() => resolvePredicateDefinition("initiative.stage")).toThrow();
    expect(() => resolvePredicateDefinition("activity.outcome", "initiative")).toThrow();
    expect(() => resolvePredicateDefinition("initiative.primary_objective", "activity")).toThrow();
  });

  it("canonicalizes NFC/newlines/edge whitespace but admits only already canonical values", () => {
    expect(canonicalizePredicateText("  Cafe\u0301\r\nOutcome  ")).toBe("Café\nOutcome");
    expect(parseCanonicalPredicateText("Café\nOutcome")).toBe("Café\nOutcome");
    for (const malformed of [
      "",
      "   ",
      " Cafe",
      "Cafe ",
      "Cafe\u0301",
      "line\r\nnext",
      "bad\0text",
      "bad\u007ftext",
      "unpaired-\ud800"
    ]) {
      expect(() => parseCanonicalPredicateText(malformed)).toThrow();
    }
    expect(() =>
      parseCanonicalPredicateText("x".repeat(CANONICAL_PREDICATE_TEXT_MAX_SCALARS + 1))
    ).toThrow();
    expect(
      parseCanonicalPredicateText("x".repeat(CANONICAL_PREDICATE_TEXT_MAX_SCALARS))
    ).toHaveLength(CANONICAL_PREDICATE_TEXT_MAX_SCALARS);
    expect(() => parseCanonicalPredicateText({ text: "Outcome" })).toThrow();
  });

  it("uses canonical equality and inequality as the single-value conflict comparator", () => {
    const definition = resolvePredicateDefinition("activity.outcome", "activity");
    expect(definition.equals("Outcome agreed", "Outcome agreed")).toBe(true);
    expect(definition.conflicts("Outcome agreed", "Outcome changed")).toBe(true);
    expect(() => definition.equals("Outcome agreed", " Outcome agreed")).toThrow();
  });

  it("requires valueJson and normalizedText to be the same canonical assertion", () => {
    expect(
      parsePredicateAssertion({
        predicate: "initiative.primary_objective",
        subjectKind: "initiative",
        valueJson: "Reduce response time",
        normalizedText: "Reduce response time"
      })
    ).toEqual({
      predicate: "initiative.primary_objective",
      canonicalValue: "Reduce response time",
      normalizedText: "Reduce response time"
    });
    expect(() =>
      parsePredicateAssertion({
        predicate: "initiative.primary_objective",
        subjectKind: "initiative",
        valueJson: "Reduce response time",
        normalizedText: "Increase throughput"
      })
    ).toThrow();
  });
});
