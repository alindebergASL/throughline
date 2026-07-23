import { SOURCE_CHUNKING_VERSION, SOURCE_NORMALIZATION_VERSION } from "@throughline/core-types";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as publicApi from "./index.js";
import {
  VerifiedClaimSourceSpanAdmission,
  type AuthorizedClaimEvidenceSnapshot,
  type VerifiedClaimSourceSpan
} from "./source-span.js";
import {
  ACCEPTED_FACT_STATUSES,
  CLAIM_STATUSES,
  constructAcceptedFactAtTrustedBoundary,
  isAcceptedFact,
  type AcceptedFact,
  type Claim,
  type DerivedViewSnapshot,
  type DeterministicTruthViewFactInput,
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

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function verifiedSpan(
  subjectType: "activity" | "initiative" = "activity"
): Promise<VerifiedClaimSourceSpan> {
  const text = "Outcome agreed";
  const subjectId = subjectType === "activity" ? ids.activity : ids.initiative;
  const snapshot: AuthorizedClaimEvidenceSnapshot = {
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    spaceId: ids.space,
    subject: {
      type: subjectType,
      id: subjectId,
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space,
      version: 2,
      accessClass: "workspace"
    },
    sourceActivityLink: {
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space,
      sourceArtifactId: ids.source,
      activityId: ids.activity,
      governingInitiativeId: ids.initiative
    },
    source: {
      id: ids.source,
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space,
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
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
        spaceId: ids.space,
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
  return new VerifiedClaimSourceSpanAdmission(
    {
      async getAuthorizedClaimEvidenceSnapshot() {
        return snapshot;
      }
    },
    {
      tenantId: ids.tenant,
      workspaceId: ids.workspace
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
  subjectType: "activity" | "initiative" = "activity"
): Claim {
  const subjectId = subjectType === "activity" ? ids.activity : ids.initiative;
  return {
    id,
    version: 1,
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    spaceId: ids.space,
    subjectType,
    subjectId,
    predicate: subjectType === "activity" ? "activity.outcome" : "initiative.primary_objective",
    valueJson: "Outcome agreed",
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
        claims: [base, { ...claim(ids.claim2, span, "weak"), valueJson: "Different outcome" }]
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
      "B2CommandInvariantError",
      "B2CommandValidationError",
      "CANONICAL_PREDICATE_TEXT_MAX_SCALARS",
      "CLAIM_STATUSES",
      "PredicateRegistryError",
      "TRUTH_PREDICATE_CATALOG_VERSION",
      "TRUTH_PREDICATE_REGISTRY",
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
    expect(Object.keys(publicApi)).not.toContain("VerifiedClaimSourceSpanError");
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

  it("pins lifecycle authority, audience-visible conflict, reconciliation, and snapshot types", () => {
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
      Extract<
        DeterministicTruthViewFactInput,
        { status: "current" }
      >["authorizedVisibleConflictIds"]
    >().toEqualTypeOf<readonly []>();
    expectTypeOf<
      Extract<
        DeterministicTruthViewFactInput,
        { status: "contested" }
      >["authorizedVisibleConflictIds"]
    >().toEqualTypeOf<readonly [string, ...string[]]>();
    expectTypeOf<SourceReconciliationEvidence["kind"]>().toEqualTypeOf<
      | "fact.source_correction_review_required"
      | "fact.source_support_removed_independent_support"
      | "fact.source_revalidated_by_supersession"
      | "fact.source_removal_revoked"
    >();
    expectTypeOf<DerivedViewSnapshot["modelProvider"]>().toEqualTypeOf<"deterministic">();
    expectTypeOf<DerivedViewSnapshot["modelId"]>().toEqualTypeOf<"none">();
    expectTypeOf<
      DerivedViewSnapshot["skillId"]
    >().toEqualTypeOf<"truth-ledger.cited-current-truth">();
    expectTypeOf<DerivedViewSnapshot["skillVersion"]>().toEqualTypeOf<"v1">();
    expect(Object.isFrozen(CLAIM_STATUSES)).toBe(true);
    expect(Object.isFrozen(ACCEPTED_FACT_STATUSES)).toBe(true);
  });
});
