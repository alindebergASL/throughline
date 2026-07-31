import { SOURCE_CHUNKING_VERSION, SOURCE_NORMALIZATION_VERSION } from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as publicApi from "./index.js";
import {
  VerifiedClaimSourceSpanAdmission,
  bindClaimEvidenceSnapshotLookupToTransaction,
  type AuthorizedClaimEvidenceSnapshot,
  type VerifiedClaimSourceSpan
} from "./source-span.js";
import {
  ACCEPTED_FACT_STATUSES,
  CLAIM_STATUSES,
  constructAcceptedFactAtTrustedBoundary,
  isAcceptedFact,
  type AcceptedFact,
  type AudienceFilteredConflictIds,
  type Claim,
  type DerivedViewSnapshot,
  type DeterministicTruthViewClaimInput,
  type DeterministicTruthViewConflictInput,
  type DeterministicTruthViewFactInput,
  type DeterministicTruthViewInput,
  type FactLifecycleEvidence,
  type NewlyAcceptedFact,
  type SourceReconciliationEvidence
} from "./types.js";

const ids = {
  tenant: "018f0000-0000-7000-8000-000000000001",
  workspace: "018f0000-0000-7000-8000-000000000002",
  space: "018f0000-0000-7000-8000-000000000003",
  activity: "018f0000-0000-7000-8000-000000000004",
  source: "018f0000-0000-7000-8000-000000000005",
  chunk: "018f0000-0000-7000-8000-000000000006",
  claim1: "018f0000-0000-7000-8000-000000000007",
  claim2: "018f0000-0000-7000-8000-000000000008",
  fact: "018f0000-0000-7000-8000-000000000009",
  user: "018f0000-0000-7000-8000-00000000000a",
  membership: "018f0000-0000-7000-8000-00000000000b",
  person: "018f0000-0000-7000-8000-00000000000c",
  initiative: "018f0000-0000-7000-8000-00000000000d"
} as const;

interface ScopeReferences {
  tenant: string;
  workspace: string;
  space: string;
}

const generatedScopeReferences: ScopeReferences = {
  tenant: ids.tenant,
  workspace: ids.workspace,
  space: ids.space
};

const establishedUuidV4ScopeReferences: ScopeReferences = {
  tenant: "11111111-1111-4111-8111-111111111111",
  workspace: "11111111-1111-4111-8111-111111111112",
  space: "11111111-1111-4111-8111-111111111113"
};

const establishedUuidV4IdentityReferences = {
  person: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  membership: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"
} as const;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function verifiedSpan(
  subjectType: "activity" | "initiative" = "activity",
  scope: ScopeReferences = generatedScopeReferences
): Promise<VerifiedClaimSourceSpan> {
  const text = "Outcome agreed";
  const subjectId = subjectType === "activity" ? ids.activity : ids.initiative;
  const snapshot: AuthorizedClaimEvidenceSnapshot = {
    tenantId: scope.tenant,
    workspaceId: scope.workspace,
    spaceId: scope.space,
    subject: {
      type: subjectType,
      id: subjectId,
      tenantId: scope.tenant,
      workspaceId: scope.workspace,
      spaceId: scope.space,
      version: 2,
      accessClass: "workspace"
    },
    sourceActivityLink: {
      tenantId: scope.tenant,
      workspaceId: scope.workspace,
      spaceId: scope.space,
      sourceArtifactId: ids.source,
      activityId: ids.activity,
      governingInitiativeId: ids.initiative
    },
    source: {
      id: ids.source,
      tenantId: scope.tenant,
      workspaceId: scope.workspace,
      spaceId: scope.space,
      version: 1,
      immutableText: text,
      contentHash: hash(text),
      normalizedContentHash: hash(text),
      normalizationVersion: SOURCE_NORMALIZATION_VERSION,
      chunkingVersion: SOURCE_CHUNKING_VERSION,
      accessClass: "restricted",
      deletedAt: null,
      successorSourceArtifactId: null
    },
    chunks: [
      {
        id: ids.chunk,
        tenantId: scope.tenant,
        workspaceId: scope.workspace,
        spaceId: scope.space,
        sourceArtifactId: ids.source,
        version: 1,
        normalizationVersion: SOURCE_NORMALIZATION_VERSION,
        chunkingVersion: SOURCE_CHUNKING_VERSION,
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 14,
        normalizedText: text,
        contentHash: hash(text),
        accessClass: "restricted"
      }
    ],
    explicitPolicyAccessClass: "workspace"
  };
  const transaction = {
    client: {} as TenantDbTransaction["client"],
    async query() {
      return { rows: [] };
    }
  } as unknown as TenantDbTransaction;
  return new VerifiedClaimSourceSpanAdmission(
    transaction,
    bindClaimEvidenceSnapshotLookupToTransaction(transaction, {
      transaction,
      async getAuthorizedClaimEvidenceSnapshot() {
        return snapshot;
      }
    }),
    {
      tenantId: scope.tenant,
      workspaceId: scope.workspace
    }
  ).admit({
    subject: { type: subjectType, id: subjectId, expectedVersion: 2 },
    evidence: {
      sourceArtifactId: ids.source,
      sourceChunkId: ids.chunk,
      expectedSourceVersion: 1,
      expectedChunkVersion: 1,
      normalizationVersion: SOURCE_NORMALIZATION_VERSION,
      chunkingVersion: SOURCE_CHUNKING_VERSION,
      startOffset: 0,
      endOffset: 14,
      excerpt: text,
      sourceContentHash: hash(text),
      sourceNormalizedContentHash: hash(text),
      chunkContentHash: hash(text),
      excerptHash: hash(text)
    }
  });
}

function claim(
  id: string,
  sourceSpan: VerifiedClaimSourceSpan,
  confidence: "strong" | "weak",
  subjectType: "activity" | "initiative" = "activity",
  scope: ScopeReferences = generatedScopeReferences
): Claim {
  const subjectId = subjectType === "activity" ? ids.activity : ids.initiative;
  return {
    id,
    version: 1,
    tenantId: scope.tenant,
    workspaceId: scope.workspace,
    spaceId: scope.space,
    subjectType,
    subjectId,
    predicate: subjectType === "activity" ? "activity.outcome" : "initiative.primary_objective",
    canonicalValue: "Outcome agreed",
    normalizedText: "Outcome agreed",
    sourceSpan,
    assertedByType: "person",
    assertedById: ids.person,
    confidence,
    status: "proposed",
    accessClass: "restricted",
    createdAt: "2026-07-23T00:00:00Z"
  };
}

describe("construction-controlled truth records", () => {
  it("constructs a branded AcceptedFact only from verified compatible supports", async () => {
    const span = await verifiedSpan();
    const fact = constructAcceptedFactAtTrustedBoundary({
      id: ids.fact,
      claims: [claim(ids.claim1, span, "weak"), claim(ids.claim2, span, "strong")],
      subjectAccessClass: "public",
      explicitPolicyAccessClass: "workspace",
      acceptedByUserId: ids.user,
      acceptedByMembershipId: ids.membership,
      acceptanceScope: "engagement",
      authorityBasis: "activity_owner",
      policyVersion: "policy-v7",
      recordedAt: "2026-07-23T00:24:04Z",
      createdAt: "2026-07-23T00:24:04Z"
    });
    expect(isAcceptedFact(fact)).toBe(true);
    expect(Object.isFrozen(fact)).toBe(true);
    expect(fact).toMatchObject({
      status: "current",
      version: 1,
      confidence: "strong",
      supportingClaimIds: [ids.claim1, ids.claim2],
      accessClass: "restricted",
      acceptedByUserId: ids.user,
      acceptedByMembershipId: ids.membership,
      acceptanceScope: "engagement",
      authorityBasis: "activity_owner"
    });
  });

  it("constructs the product-owned Initiative fact through its distinct owner scope", async () => {
    const span = await verifiedSpan("initiative");
    const fact = constructAcceptedFactAtTrustedBoundary({
      id: ids.fact,
      claims: [claim(ids.claim1, span, "strong", "initiative")],
      subjectAccessClass: "workspace",
      explicitPolicyAccessClass: "workspace",
      acceptedByUserId: ids.user,
      acceptedByMembershipId: ids.membership,
      acceptanceScope: "initiative",
      authorityBasis: "initiative_owner",
      policyVersion: "policy-v7",
      recordedAt: "2026-07-23T00:24:04Z",
      createdAt: "2026-07-23T00:24:04Z"
    });
    expect(fact).toMatchObject({
      subjectType: "initiative",
      subjectId: ids.initiative,
      predicate: "initiative.primary_objective",
      acceptanceScope: "initiative",
      authorityBasis: "initiative_owner"
    });
  });

  it("accepts established UUIDv4 scope references while retaining UUIDv7 entity IDs", async () => {
    const span = await verifiedSpan("activity", establishedUuidV4ScopeReferences);
    const fact = constructAcceptedFactAtTrustedBoundary({
      id: ids.fact,
      claims: [claim(ids.claim1, span, "strong", "activity", establishedUuidV4ScopeReferences)],
      subjectAccessClass: "workspace",
      explicitPolicyAccessClass: "workspace",
      acceptedByUserId: ids.user,
      acceptedByMembershipId: ids.membership,
      acceptanceScope: "engagement",
      authorityBasis: "activity_owner",
      policyVersion: "policy-v7",
      recordedAt: "2026-07-23T00:24:04Z",
      createdAt: "2026-07-23T00:24:04Z"
    });

    expect(fact).toMatchObject({
      id: ids.fact,
      tenantId: establishedUuidV4ScopeReferences.tenant,
      workspaceId: establishedUuidV4ScopeReferences.workspace,
      spaceId: establishedUuidV4ScopeReferences.space,
      supportingClaimIds: [ids.claim1]
    });
  });

  it("accepts established UUIDv4 identity references at the trusted Fact boundary", async () => {
    const span = await verifiedSpan();
    const fact = constructAcceptedFactAtTrustedBoundary({
      id: ids.fact,
      claims: [
        {
          ...claim(ids.claim1, span, "strong"),
          assertedById: establishedUuidV4IdentityReferences.person
        }
      ],
      subjectAccessClass: "workspace",
      explicitPolicyAccessClass: "workspace",
      acceptedByUserId: establishedUuidV4IdentityReferences.user,
      acceptedByMembershipId: establishedUuidV4IdentityReferences.membership,
      acceptanceScope: "engagement",
      authorityBasis: "activity_owner",
      policyVersion: "policy-v7",
      recordedAt: "2026-07-23T00:24:04Z",
      createdAt: "2026-07-23T00:24:04Z"
    });

    expect(fact).toMatchObject({
      id: ids.fact,
      acceptedByUserId: establishedUuidV4IdentityReferences.user,
      acceptedByMembershipId: establishedUuidV4IdentityReferences.membership,
      supportingClaimIds: [ids.claim1]
    });
  });

  it("rejects malformed or noncanonical identity references without loosening entity UUIDv7", async () => {
    const span = await verifiedSpan();
    const base = claim(ids.claim1, span, "strong");
    const construction = {
      id: ids.fact,
      claims: [base],
      subjectAccessClass: "workspace" as const,
      explicitPolicyAccessClass: "workspace" as const,
      acceptedByUserId: ids.user,
      acceptedByMembershipId: ids.membership,
      acceptanceScope: "engagement" as const,
      authorityBasis: "activity_owner" as const,
      policyVersion: "policy-v7",
      recordedAt: "2026-07-23T00:24:04Z",
      createdAt: "2026-07-23T00:24:04Z"
    };

    for (const input of [
      { ...construction, claims: [{ ...base, assertedById: "not-a-uuid" }] },
      {
        ...construction,
        acceptedByUserId: "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaa1"
      },
      {
        ...construction,
        acceptedByMembershipId: "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaa5"
      },
      {
        ...construction,
        claims: [{ ...base, assertedById: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA3" }]
      }
    ]) {
      expect(() => constructAcceptedFactAtTrustedBoundary(input)).toThrow();
    }
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        id: establishedUuidV4IdentityReferences.user
      })
    ).toThrow();
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        claims: [{ ...base, id: establishedUuidV4IdentityReferences.person }]
      })
    ).toThrow();
  });

  it("rejects malformed or noncanonical scope references without loosening entity UUIDv7", async () => {
    const span = await verifiedSpan();
    const base = claim(ids.claim1, span, "strong");
    const construction = {
      id: ids.fact,
      claims: [base],
      subjectAccessClass: "workspace" as const,
      explicitPolicyAccessClass: "workspace" as const,
      acceptedByUserId: ids.user,
      acceptedByMembershipId: ids.membership,
      acceptanceScope: "engagement" as const,
      authorityBasis: "activity_owner" as const,
      policyVersion: "policy-v7",
      recordedAt: "2026-07-23T00:24:04Z",
      createdAt: "2026-07-23T00:24:04Z"
    };

    for (const claims of [
      [{ ...base, tenantId: "not-a-uuid" }],
      [{ ...base, workspaceId: "11111111-1111-0111-8111-111111111112" }],
      [{ ...base, spaceId: "11111111-1111-4111-7111-111111111113" }],
      [{ ...base, tenantId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }]
    ]) {
      expect(() => constructAcceptedFactAtTrustedBoundary({ ...construction, claims })).toThrow();
    }
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        id: establishedUuidV4ScopeReferences.tenant
      })
    ).toThrow();
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        claims: [{ ...base, id: establishedUuidV4ScopeReferences.tenant }]
      })
    ).toThrow();
  });

  it("rejects forged evidence, incompatible supports, and non-owner authority shape", async () => {
    const span = await verifiedSpan();
    const base = claim(ids.claim1, span, "strong");
    const construction = {
      id: ids.fact,
      claims: [base],
      subjectAccessClass: "workspace" as const,
      explicitPolicyAccessClass: "workspace" as const,
      acceptedByUserId: ids.user,
      acceptedByMembershipId: ids.membership,
      acceptanceScope: "engagement" as const,
      authorityBasis: "activity_owner" as const,
      policyVersion: "policy-v7",
      recordedAt: "2026-07-23T00:24:04Z",
      createdAt: "2026-07-23T00:24:04Z"
    };
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        claims: [{ ...base, sourceSpan: { ...span } as VerifiedClaimSourceSpan }]
      })
    ).toThrow();
    const reflectedForgery = Object.defineProperties(
      { ...span },
      Object.getOwnPropertyDescriptors(span)
    ) as VerifiedClaimSourceSpan;
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        claims: [{ ...base, sourceSpan: reflectedForgery }]
      })
    ).toThrow();
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        claims: [{ ...base, sourceSpan: new Proxy(span, {}) }]
      })
    ).toThrow();
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        claims: [base, { ...claim(ids.claim2, span, "weak"), canonicalValue: "Different outcome" }]
      })
    ).toThrow();
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        authorityBasis: "initiative_owner"
      })
    ).toThrow();
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        supersedesFactId: ids.fact
      })
    ).toThrow();
    expect(() =>
      constructAcceptedFactAtTrustedBoundary({
        ...construction,
        claims: [
          {
            ...base,
            validFrom: "2026-07-24T00:00:00Z",
            validTo: "2026-07-23T00:00:00Z"
          }
        ]
      })
    ).toThrow();
  });

  it("does not expose AcceptedFact or verified-span constructors through the package root", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { exports: unknown };
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
    expect(Object.keys(publicApi).sort()).toEqual([
      "ACCEPTED_FACT_CONFIDENCE_RULE",
      "ACCEPTED_FACT_STATUSES",
      "B2AuthorizationError",
      "B2CommandInvariantError",
      "B2CommandValidationError",
      "B2IdempotencyConflictError",
      "CANONICAL_PREDICATE_TEXT_MAX_SCALARS",
      "CLAIM_STATUSES",
      "PredicateRegistryError",
      "TRUTH_PREDICATE_CATALOG_VERSION",
      "TRUTH_PREDICATE_REGISTRY",
      "TruthLedgerConflictError",
      "TruthLedgerDomainCommandBus",
      "VerifiedClaimSourceSpanError",
      "VerifiedClaimSourceSpanOperationalError",
      "assessRecordedConfidenceSupport",
      "calculateAcceptedFactConfidence",
      "canonicalB2CommandIdentity",
      "canonicalizePredicateText",
      "hashB2CommandIdentity",
      "parseB2Command",
      "parseB2CommandResult",
      "parseCanonicalPredicateText",
      "parsePredicateAssertion",
      "parseTruthLifecycleReason",
      "resolvePredicateDefinition",
      "serializeB2Command",
      "serializeB2CommandIdentity",
      "serializeB2CommandResult"
    ]);
    expect(Object.keys(publicApi)).not.toContain("constructAcceptedFactAtTrustedBoundary");
    expect(Object.keys(publicApi)).not.toContain("isAcceptedFact");
    expect(Object.keys(publicApi)).not.toContain("isVerifiedClaimSourceSpan");
    expect(Object.keys(publicApi)).not.toContain("VerifiedClaimSourceSpanAdmission");
    expect(Object.keys(publicApi)).not.toContain("truthLedgerSkeleton");
    expect(Object.keys(publicApi).some((key) => /model|provider|agent|changeset/i.test(key))).toBe(
      false
    );
    expectTypeOf<Claim["assertedByType"]>().toEqualTypeOf<"person">();
    expectTypeOf<AcceptedFact["status"]>().toEqualTypeOf<
      "current" | "contested" | "superseded" | "revoked"
    >();
    expectTypeOf<NewlyAcceptedFact["status"]>().toEqualTypeOf<"current">();
    expectTypeOf<Record<string, unknown>>().not.toMatchTypeOf<VerifiedClaimSourceSpan>();
    expectTypeOf<Record<string, unknown>>().not.toMatchTypeOf<AcceptedFact>();
  });

  it("pins lifecycle authority, audience-filtered review states, reconciliation, and snapshots", () => {
    type RoutineAuthority = Extract<
      FactLifecycleEvidence,
      { kind: "fact.accepted" | "fact.contested" | "fact.upheld" | "fact.superseded" }
    >["authority"]["authorityBasis"];
    type EmergencyAuthority = Extract<
      FactLifecycleEvidence,
      { kind: "fact.emergency_contested" | "fact.emergency_revoked" }
    >["authority"]["authorityBasis"];
    expectTypeOf<RoutineAuthority>().toEqualTypeOf<"activity_owner" | "initiative_owner">();
    expectTypeOf<EmergencyAuthority>().toEqualTypeOf<"workspace_owner_emergency">();
    expectTypeOf<
      Extract<DeterministicTruthViewFactInput, { status: "current" }>["reviewState"]["kind"]
    >().toEqualTypeOf<"none">();

    expectTypeOf<
      Extract<
        Extract<DeterministicTruthViewFactInput, { status: "contested" }>["reviewState"],
        { kind: "visible_claim_conflict" }
      >["audienceFilteredConflictIds"]
    >().toEqualTypeOf<readonly [string, ...string[]]>();

    expectTypeOf<
      Extract<
        Extract<DeterministicTruthViewFactInput, { status: "contested" }>["reviewState"],
        { kind: "source_support_review" }
      >["reason"]
    >().toEqualTypeOf<"source_corrected" | "support_invalidated">();
    type SourceSupportReviewState = Extract<
      Extract<DeterministicTruthViewFactInput, { status: "contested" }>["reviewState"],
      { kind: "source_support_review" }
    >;
    type SourceReviewHasChallengerClaimId =
      "challengerClaimId" extends keyof SourceSupportReviewState ? true : false;
    type SourceReviewHasConflictIds =
      "audienceFilteredConflictIds" extends keyof SourceSupportReviewState ? true : false;
    expectTypeOf<SourceReviewHasChallengerClaimId>().toEqualTypeOf<false>();
    expectTypeOf<SourceReviewHasConflictIds>().toEqualTypeOf<false>();
    type HasRawLifecycleVersion = "version" extends keyof DeterministicTruthViewFactInput
      ? true
      : false;
    type HasHiddenConflictIds = "hiddenConflictIds" extends keyof DeterministicTruthViewFactInput
      ? true
      : false;
    type HasUnfilteredConflicts = "conflicts" extends keyof DeterministicTruthViewInput
      ? true
      : false;
    expectTypeOf<HasRawLifecycleVersion>().toEqualTypeOf<false>();
    expectTypeOf<HasHiddenConflictIds>().toEqualTypeOf<false>();
    expectTypeOf<HasUnfilteredConflicts>().toEqualTypeOf<false>();
    expectTypeOf<{ visibleToAudience: false }>().not.toMatchTypeOf<
      Pick<DeterministicTruthViewClaimInput, "visibleToAudience">
    >();
    expectTypeOf<{ visibleToAudience: false }>().not.toMatchTypeOf<
      Pick<DeterministicTruthViewConflictInput, "visibleToAudience">
    >();
    expectTypeOf<SourceReconciliationEvidence["kind"]>().toEqualTypeOf<
      | "fact.source_correction_review_required"
      | "fact.source_support_review_required"
      | "fact.source_support_removed_independent_support"
      | "fact.source_revalidated_by_supersession"
      | "fact.source_removal_revoked"
    >();
    expectTypeOf<
      Extract<
        SourceReconciliationEvidence,
        { kind: "fact.source_support_review_required"; fromStatus: "current" }
      >["reviewReasonAdded"]
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extract<
        SourceReconciliationEvidence,
        { kind: "fact.source_support_review_required" }
      >["supportAssessment"]["disposition"]
    >().toEqualTypeOf<"review_required">();
    expectTypeOf<
      Extract<
        SourceReconciliationEvidence,
        { kind: "fact.source_support_review_required"; fromStatus: "contested" }
      >["reviewReasonAdded"]
    >().toEqualTypeOf<true>();
    expectTypeOf<DerivedViewSnapshot["modelProvider"]>().toEqualTypeOf<"deterministic">();
    expectTypeOf<DerivedViewSnapshot["modelId"]>().toEqualTypeOf<"none">();
    expectTypeOf<
      DerivedViewSnapshot["skillId"]
    >().toEqualTypeOf<"truth-ledger.cited-current-truth">();
    expectTypeOf<DerivedViewSnapshot["skillVersion"]>().toEqualTypeOf<"v1">();
    expectTypeOf<
      DerivedViewSnapshot["unresolvedConflictIds"]
    >().toEqualTypeOf<AudienceFilteredConflictIds>();
    expectTypeOf<AudienceFilteredConflictIds>().toMatchTypeOf<readonly string[]>();
    expectTypeOf<readonly string[]>().not.toMatchTypeOf<AudienceFilteredConflictIds>();
    type RawConflictIdSnapshotInput = Omit<DerivedViewSnapshot, "unresolvedConflictIds"> & {
      readonly unresolvedConflictIds: readonly string[];
    };
    expectTypeOf<RawConflictIdSnapshotInput>().not.toMatchTypeOf<DerivedViewSnapshot>();
    expect(Object.isFrozen(CLAIM_STATUSES)).toBe(true);
    expect(Object.isFrozen(ACCEPTED_FACT_STATUSES)).toBe(true);
  });
});
