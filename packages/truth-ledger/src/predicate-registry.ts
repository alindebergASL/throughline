import {
  B2_TRUTH_PREDICATE_CATALOG_VERSION,
  B2_TRUTH_PREDICATES,
  isUnicodeScalarString,
  unicodeScalarLength,
  type B2TruthPredicate
} from "@throughline/core-types";

export const TRUTH_PREDICATE_CATALOG_VERSION = B2_TRUTH_PREDICATE_CATALOG_VERSION;
export const CANONICAL_PREDICATE_TEXT_MAX_SCALARS = 2_000 as const;

export type TruthSubjectKind = "activity" | "initiative";

export interface CanonicalTextSchema {
  readonly kind: "canonical_text";
  readonly minScalars: 1;
  readonly maxScalars: typeof CANONICAL_PREDICATE_TEXT_MAX_SCALARS;
  parse(input: unknown): string;
}

export interface PredicateDefinition {
  readonly predicate: B2TruthPredicate;
  readonly allowedSubjectKind: TruthSubjectKind;
  readonly valueSchema: CanonicalTextSchema;
  readonly canonicalize: (input: string) => string;
  readonly equals: (left: string, right: string) => boolean;
  readonly conflicts: (left: string, right: string) => boolean;
  readonly cardinality: "single";
  readonly proposalSlotPolicy: "multiple_open" | "single_open";
  readonly authorityScope: "activity_owner" | "initiative_owner";
  readonly deterministicViewTreatment: {
    readonly viewType: "initiative_summary";
    readonly section: "activity_outcomes" | "primary_objective";
    readonly includeStatuses: readonly ["current", "contested"];
    readonly reviewVisibilityByBasis: {
      readonly claimConflict: {
        readonly visibleWhen: "challenger_and_conflict_are_authorized_for_audience";
        readonly challengerRequired: true;
      };
      readonly sourceCorrection: {
        readonly visibleWhen: "review_basis_is_authorized_for_audience";
        readonly challengerRequired: false;
      };
      readonly supportInvalidation: {
        readonly visibleWhen: "review_basis_is_authorized_for_audience";
        readonly challengerRequired: false;
      };
    };
    readonly excludeStatuses: readonly ["superseded", "revoked"];
  };
}

export class PredicateRegistryError extends Error {
  constructor() {
    super("Truth predicate or value is unsupported");
    this.name = "PredicateRegistryError";
  }
}

export function canonicalizePredicateText(input: string): string {
  if (!isUnicodeScalarString(input)) throw new PredicateRegistryError();
  const canonical = input.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (
    unicodeScalarLength(canonical) < 1 ||
    unicodeScalarLength(canonical) > CANONICAL_PREDICATE_TEXT_MAX_SCALARS ||
    Array.from(canonical).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return (codePoint < 32 && codePoint !== 9 && codePoint !== 10) || codePoint === 127;
    })
  ) {
    throw new PredicateRegistryError();
  }
  return canonical;
}

export function parseCanonicalPredicateText(input: unknown): string {
  if (typeof input !== "string") throw new PredicateRegistryError();
  const canonical = canonicalizePredicateText(input);
  if (canonical !== input) throw new PredicateRegistryError();
  return canonical;
}

const canonicalTextSchema: CanonicalTextSchema = Object.freeze({
  kind: "canonical_text",
  minScalars: 1,
  maxScalars: CANONICAL_PREDICATE_TEXT_MAX_SCALARS,
  parse: parseCanonicalPredicateText
});

function textEquals(left: string, right: string): boolean {
  return parseCanonicalPredicateText(left) === parseCanonicalPredicateText(right);
}

function textConflicts(left: string, right: string): boolean {
  return !textEquals(left, right);
}

const includedViewStatuses = Object.freeze(["current", "contested"] as const);
const excludedViewStatuses = Object.freeze(["superseded", "revoked"] as const);
const reviewVisibilityByBasis = Object.freeze({
  claimConflict: Object.freeze({
    visibleWhen: "challenger_and_conflict_are_authorized_for_audience",
    challengerRequired: true
  }),
  sourceCorrection: Object.freeze({
    visibleWhen: "review_basis_is_authorized_for_audience",
    challengerRequired: false
  }),
  supportInvalidation: Object.freeze({
    visibleWhen: "review_basis_is_authorized_for_audience",
    challengerRequired: false
  })
} as const);

const sharedViewTreatment = Object.freeze({
  viewType: "initiative_summary",
  includeStatuses: includedViewStatuses,
  reviewVisibilityByBasis,
  excludeStatuses: excludedViewStatuses
} as const);

const registry = Object.freeze({
  "activity.outcome": Object.freeze({
    predicate: "activity.outcome",
    allowedSubjectKind: "activity",
    valueSchema: canonicalTextSchema,
    canonicalize: canonicalizePredicateText,
    equals: textEquals,
    conflicts: textConflicts,
    cardinality: "single",
    proposalSlotPolicy: "multiple_open",
    authorityScope: "activity_owner",
    deterministicViewTreatment: Object.freeze({
      ...sharedViewTreatment,
      section: "activity_outcomes"
    })
  }),
  "initiative.primary_objective": Object.freeze({
    predicate: "initiative.primary_objective",
    allowedSubjectKind: "initiative",
    valueSchema: canonicalTextSchema,
    canonicalize: canonicalizePredicateText,
    equals: textEquals,
    conflicts: textConflicts,
    cardinality: "single",
    proposalSlotPolicy: "single_open",
    authorityScope: "initiative_owner",
    deterministicViewTreatment: Object.freeze({
      ...sharedViewTreatment,
      section: "primary_objective"
    })
  })
} as const satisfies Record<B2TruthPredicate, PredicateDefinition>);

export const TRUTH_PREDICATE_REGISTRY: Readonly<Record<B2TruthPredicate, PredicateDefinition>> =
  registry;

export function resolvePredicateDefinition(
  predicate: unknown,
  subjectKind?: unknown
): PredicateDefinition {
  if (
    typeof predicate !== "string" ||
    !(B2_TRUTH_PREDICATES as readonly string[]).includes(predicate)
  ) {
    throw new PredicateRegistryError();
  }
  const definition = registry[predicate as B2TruthPredicate];
  if (subjectKind !== undefined && definition.allowedSubjectKind !== subjectKind) {
    throw new PredicateRegistryError();
  }
  return definition;
}

export function parsePredicateAssertion(input: {
  predicate: unknown;
  subjectKind: unknown;
  canonicalValue: unknown;
  normalizedText: unknown;
}): { predicate: B2TruthPredicate; canonicalValue: string; normalizedText: string } {
  const definition = resolvePredicateDefinition(input.predicate, input.subjectKind);
  const canonicalValue = definition.valueSchema.parse(input.canonicalValue);
  const normalizedText = definition.valueSchema.parse(input.normalizedText);
  if (!definition.equals(canonicalValue, normalizedText)) throw new PredicateRegistryError();
  return { predicate: definition.predicate, canonicalValue, normalizedText };
}
