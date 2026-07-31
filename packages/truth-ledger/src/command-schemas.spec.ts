import {
  B2_COMMAND_KINDS,
  B2_TRUTH_PREDICATES,
  B2_TRUTH_PREDICATE_CATALOG_VERSION,
  CONFIDENCE_LOWERING_REASON_CODES,
  CONTEST_REASON_CODES,
  EMERGENCY_REASON_CODES,
  REVOKE_REASON_CODES,
  SUPERSEDE_REASON_CODES,
  UPHOLD_REASON_CODES,
  type B2AuthorizedDomainCommand,
  type B2CanonicalCommandIdentityInput,
  type B2CommandKind,
  type B2CommandPayloadMap
} from "@throughline/core-types";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  canonicalB2CommandIdentity,
  hashB2CommandIdentity,
  parseB2Command,
  parseB2CommandResult,
  serializeB2Command,
  serializeB2CommandIdentity,
  serializeB2CommandResult
} from "./command-schemas.js";

const ids = {
  subject: "018f0000-0000-7000-8000-000000000001",
  source: "018f0000-0000-7000-8000-000000000002",
  chunk: "018f0000-0000-7000-8000-000000000003",
  claim1: "018f0000-0000-7000-8000-000000000004",
  claim2: "018f0000-0000-7000-8000-000000000005",
  fact: "018f0000-0000-7000-8000-000000000006",
  replacementFact: "018f0000-0000-7000-8000-000000000007",
  conflict: "018f0000-0000-7000-8000-000000000008",
  view: "018f0000-0000-7000-8000-000000000009"
} as const;

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const hashD = "d".repeat(64);
const metadata = {
  idempotencyKey: "b2-golden-idempotency-key",
  predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION
} as const;

const commands = {
  "claim.create": {
    ...metadata,
    kind: "claim.create",
    payload: {
      subject: { type: "activity", id: ids.subject, expectedVersion: 3 },
      predicate: "activity.outcome",
      valueJson: "Discovery scope agreed",
      normalizedText: "Discovery scope agreed",
      confidence: "strong",
      observedAt: "2026-07-22T18:51:45Z",
      evidence: {
        sourceArtifactId: ids.source,
        sourceChunkId: ids.chunk,
        expectedSourceVersion: 1,
        expectedChunkVersion: 1,
        normalizationVersion: "source-normalization.v1",
        chunkingVersion: "source-chunking.v1",
        startOffset: 4,
        endOffset: 11,
        excerpt: "outcome",
        sourceContentHash: hashA,
        sourceNormalizedContentHash: hashB,
        chunkContentHash: hashC,
        excerptHash: hashD
      }
    }
  },
  "fact.accept": {
    ...metadata,
    kind: "fact.accept",
    payload: {
      subject: { type: "activity", id: ids.subject, expectedVersion: 3 },
      claims: [
        { claimId: ids.claim1, expectedVersion: 1 },
        { claimId: ids.claim2, expectedVersion: 2 }
      ],
      expectedCurrentFactId: null,
      acceptanceScope: "engagement",
      confidenceLowering: {
        confidence: "weak",
        reason: {
          code: "residual_uncertainty",
          rationale: "The outcome is explicit, but the effective date is still uncertain."
        }
      }
    }
  },
  "fact.contest": {
    ...metadata,
    kind: "fact.contest",
    payload: {
      factId: ids.fact,
      expectedFactVersion: 2,
      competingClaim: { claimId: ids.claim2, expectedVersion: 2 },
      reason: {
        code: "conflicting_evidence",
        rationale: "A later source asserts a materially different outcome."
      }
    }
  },
  "fact.uphold": {
    ...metadata,
    kind: "fact.uphold",
    payload: {
      factId: ids.fact,
      expectedFactVersion: 3,
      conflict: { conflictId: ids.conflict, expectedVersion: 1 },
      challengerClaim: { claimId: ids.claim2, expectedVersion: 3 },
      reason: {
        code: "challenger_outdated",
        rationale: "The challenger predates the ratified customer decision."
      }
    }
  },
  "fact.supersede": {
    ...metadata,
    kind: "fact.supersede",
    payload: {
      factId: ids.fact,
      expectedFactVersion: 3,
      subject: { type: "activity", id: ids.subject, expectedVersion: 3 },
      replacementClaims: [{ claimId: ids.claim2, expectedVersion: 3 }],
      conflict: { conflictId: ids.conflict, expectedVersion: 1 },
      reason: {
        code: "newer_evidence",
        rationale: "The replacement reflects the later ratified outcome."
      }
    }
  },
  "fact.revoke": {
    ...metadata,
    kind: "fact.revoke",
    payload: {
      factId: ids.fact,
      expectedFactVersion: 3,
      reason: {
        code: "support_invalidated",
        rationale: "The sole supporting evidence is no longer current."
      }
    }
  },
  "fact.emergency_contest": {
    ...metadata,
    kind: "fact.emergency_contest",
    payload: {
      factId: ids.fact,
      expectedFactVersion: 3,
      competingClaim: { claimId: ids.claim2, expectedVersion: 2 },
      reason: {
        code: "material_truth_risk",
        rationale: "The current assertion creates an immediate material truth risk."
      }
    }
  },
  "fact.emergency_revoke": {
    ...metadata,
    kind: "fact.emergency_revoke",
    payload: {
      factId: ids.fact,
      expectedFactVersion: 3,
      reason: {
        code: "legal_or_compliance_risk",
        rationale: "Continued publication would create an immediate compliance risk."
      }
    }
  },
  "derived_view.regenerate": {
    ...metadata,
    kind: "derived_view.regenerate",
    payload: {
      target: { type: "initiative", id: ids.subject, expectedVersion: 4 },
      viewType: "initiative_summary",
      renderer: { id: "truth-ledger.cited-current-truth", version: "v1" },
      expectedAudienceFingerprint: hashA,
      expectedInputRevisionHash: hashB
    }
  }
} as const satisfies { [K in B2CommandKind]: B2AuthorizedDomainCommand<K> };

const results = {
  "claim.create": { claimId: ids.claim1, version: 1, status: "proposed" },
  "fact.accept": {
    factId: ids.fact,
    version: 1,
    status: "current",
    acceptedClaimIds: [ids.claim1, ids.claim2]
  },
  "fact.contest": {
    factId: ids.fact,
    version: 3,
    status: "contested",
    conflictId: ids.conflict,
    conflictVersion: 1,
    competingClaimId: ids.claim2,
    competingClaimVersion: 3,
    competingClaimStatus: "conflicted"
  },
  "fact.uphold": {
    factId: ids.fact,
    version: 4,
    status: "current",
    conflictId: ids.conflict,
    conflictVersion: 2,
    conflictStatus: "upheld",
    challengerClaimId: ids.claim2,
    challengerClaimVersion: 4,
    challengerClaimStatus: "rejected"
  },
  "fact.supersede": {
    factId: ids.fact,
    version: 4,
    status: "superseded",
    replacementFactId: ids.replacementFact,
    replacementFactVersion: 1,
    replacementFactStatus: "current"
  },
  "fact.revoke": { factId: ids.fact, version: 4, status: "revoked" },
  "fact.emergency_contest": {
    factId: ids.fact,
    version: 4,
    status: "contested",
    conflictId: ids.conflict,
    conflictVersion: 1,
    competingClaimId: ids.claim2,
    competingClaimVersion: 3,
    competingClaimStatus: "conflicted",
    emergency: true
  },
  "fact.emergency_revoke": {
    factId: ids.fact,
    version: 4,
    status: "revoked",
    emergency: true
  },
  "derived_view.regenerate": {
    derivedViewSnapshotId: ids.view,
    viewType: "initiative_summary",
    audienceFingerprint: hashA,
    inputRevisionHash: hashB,
    generatedAt: "2026-07-23T00:24:04Z"
  }
} as const;

describe("B2 strict command contracts", () => {
  it("pins the complete explicit command vocabulary and parses every exact shape", () => {
    expect(B2_COMMAND_KINDS).toEqual([
      "claim.create",
      "fact.accept",
      "fact.contest",
      "fact.uphold",
      "fact.supersede",
      "fact.revoke",
      "fact.emergency_contest",
      "fact.emergency_revoke",
      "derived_view.regenerate"
    ]);
    for (const kind of B2_COMMAND_KINDS) {
      expect(parseB2Command(commands[kind])).toEqual(commands[kind]);
      expect(parseB2CommandResult(kind, results[kind])).toEqual(results[kind]);
      expect(serializeB2CommandResult(kind, results[kind])).toBeTruthy();
    }
    for (const vocabulary of [
      B2_COMMAND_KINDS,
      B2_TRUTH_PREDICATES,
      CONTEST_REASON_CODES,
      UPHOLD_REASON_CODES,
      SUPERSEDE_REASON_CODES,
      REVOKE_REASON_CODES,
      EMERGENCY_REASON_CODES,
      CONFIDENCE_LOWERING_REASON_CODES
    ]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
    }
  });

  it("accepts both product-owned subject/predicate/scope pairs", () => {
    expect(
      parseB2Command({
        ...commands["claim.create"],
        payload: {
          ...commands["claim.create"].payload,
          subject: { type: "initiative", id: ids.subject, expectedVersion: 3 },
          predicate: "initiative.primary_objective",
          valueJson: "Reduce response time",
          normalizedText: "Reduce response time"
        }
      })
    ).toMatchObject({
      kind: "claim.create",
      payload: { predicate: "initiative.primary_objective", subject: { type: "initiative" } }
    });
    expect(
      parseB2Command({
        ...commands["fact.accept"],
        payload: {
          ...commands["fact.accept"].payload,
          subject: { type: "initiative", id: ids.subject, expectedVersion: 3 },
          acceptanceScope: "initiative"
        }
      })
    ).toMatchObject({ kind: "fact.accept", payload: { acceptanceScope: "initiative" } });
  });

  it("rejects missing, extra, type-confused, non-v7, noncanonical, and caller-trusted fields", () => {
    expect(() => parseB2Command({ ...commands["claim.create"], kind: "claim.propose" })).toThrow();
    expect(() =>
      parseB2Command({ ...commands["claim.create"], predicateCatalogVersion: "catalog.attacker" })
    ).toThrow();
    expect(() => parseB2Command({ ...commands["claim.create"], idempotencyKey: "" })).toThrow();
    expect(() =>
      parseB2Command({
        ...commands["claim.create"],
        payload: { ...commands["claim.create"].payload, predicate: "initiative.stage" }
      })
    ).toThrow();
    expect(() =>
      parseB2Command({
        ...commands["claim.create"],
        payload: {
          ...commands["claim.create"].payload,
          subject: { type: "initiative", id: ids.subject, expectedVersion: 3 }
        }
      })
    ).toThrow();
    expect(() =>
      parseB2Command({
        ...commands["claim.create"],
        payload: { ...commands["claim.create"].payload, valueJson: " Noncanonical" }
      })
    ).toThrow();
    expect(() =>
      parseB2Command({
        ...commands["claim.create"],
        payload: {
          ...commands["claim.create"].payload,
          canonicalValue: commands["claim.create"].payload.valueJson
        }
      })
    ).toThrow();
    expect(() =>
      parseB2Command({
        ...commands["claim.create"],
        payload: {
          ...commands["claim.create"].payload,
          subject: {
            type: "activity",
            id: "00000000-0000-4000-8000-000000000000",
            expectedVersion: 3
          }
        }
      })
    ).toThrow();
    expect(() => {
      const missingPayload: { payload?: unknown } & Record<string, unknown> = {
        ...commands["claim.create"]
      };
      delete missingPayload.payload;
      parseB2Command(missingPayload);
    }).toThrow();

    for (const key of [
      "actorUserId",
      "actorMembershipId",
      "authorityBasis",
      "policyVersion",
      "accessClass",
      "status",
      "createdAt",
      "acceptedAt",
      "recordedAt"
    ]) {
      expect(() =>
        parseB2Command({
          ...commands["claim.create"],
          payload: { ...commands["claim.create"].payload, [key]: "caller-controlled" }
        })
      ).toThrow();
    }
    expect(() =>
      parseB2Command({ ...commands["fact.revoke"], actorUserId: ids.subject })
    ).toThrow();
    const hiddenField = { ...commands["fact.revoke"] };
    Object.defineProperty(hiddenField, "actorMembershipId", {
      value: ids.subject,
      enumerable: false
    });
    expect(() => parseB2Command(hiddenField)).toThrow();
    expect(() =>
      parseB2Command({ ...commands["fact.revoke"], [Symbol("actor")]: ids.subject })
    ).toThrow();
  });

  it("requires sorted, unique support references and subject-matched acceptance scope", () => {
    expect(() =>
      parseB2Command({
        ...commands["fact.accept"],
        payload: {
          ...commands["fact.accept"].payload,
          claims: [...commands["fact.accept"].payload.claims].reverse()
        }
      })
    ).toThrow();
    expect(() =>
      parseB2Command({
        ...commands["fact.accept"],
        payload: {
          ...commands["fact.accept"].payload,
          claims: [
            commands["fact.accept"].payload.claims[0],
            commands["fact.accept"].payload.claims[0]
          ]
        }
      })
    ).toThrow();
    expect(() =>
      parseB2Command({
        ...commands["fact.accept"],
        payload: { ...commands["fact.accept"].payload, acceptanceScope: "initiative" }
      })
    ).toThrow();
  });

  it("keeps contest, uphold, supersede, and revoke result shapes distinct", () => {
    expect(() =>
      parseB2CommandResult("fact.contest", {
        ...results["fact.contest"],
        replacementFactId: ids.replacementFact
      })
    ).toThrow();
    expect(() =>
      parseB2CommandResult("fact.contest", {
        ...results["fact.contest"],
        acceptedFactId: ids.replacementFact
      })
    ).toThrow();
    expect(() => parseB2CommandResult("fact.uphold", results["fact.contest"])).toThrow();
    expect(() => parseB2CommandResult("fact.supersede", results["fact.revoke"])).toThrow();
    expect(() => parseB2CommandResult("fact.revoke", results["fact.supersede"])).toThrow();
    expect(() => parseB2CommandResult("unknown" as B2CommandKind, {})).toThrow();
  });

  it("strictly validates derived-view and timestamp fields", () => {
    for (const payload of [
      { ...commands["derived_view.regenerate"].payload, viewType: "organization_summary" },
      {
        ...commands["derived_view.regenerate"].payload,
        target: { type: "activity", id: ids.subject, expectedVersion: 4 }
      },
      {
        ...commands["derived_view.regenerate"].payload,
        renderer: { id: "attacker", version: "v1" }
      },
      { ...commands["derived_view.regenerate"].payload, expectedAudienceFingerprint: "bad" },
      { ...commands["derived_view.regenerate"].payload, expectedInputRevisionHash: "bad" }
    ]) {
      expect(() => parseB2Command({ ...commands["derived_view.regenerate"], payload })).toThrow();
    }
    for (const observedAt of ["2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z"]) {
      expect(() =>
        parseB2Command({
          ...commands["claim.create"],
          payload: { ...commands["claim.create"].payload, observedAt }
        })
      ).toThrow();
    }
  });

  it("permits emergency semantics only for the two explicit contest/revoke kinds", () => {
    expect(B2_COMMAND_KINDS.filter((kind) => kind.includes("emergency"))).toEqual([
      "fact.emergency_contest",
      "fact.emergency_revoke"
    ]);
    for (const forbidden of [
      "fact.emergency_accept",
      "fact.emergency_uphold",
      "fact.emergency_supersede"
    ]) {
      expect(() => parseB2Command({ ...commands["fact.revoke"], kind: forbidden })).toThrow();
    }
    expect(() =>
      parseB2Command({
        ...commands["fact.emergency_revoke"],
        payload: {
          ...commands["fact.emergency_revoke"].payload,
          reason: { code: "support_invalidated", rationale: "Not an emergency reason." }
        }
      })
    ).toThrow();
  });

  it("canonicalizes object-key order and includes all material identity fields", () => {
    const command = commands["claim.create"];
    const reordered = {
      payload: {
        evidence: { ...command.payload.evidence },
        confidence: command.payload.confidence,
        normalizedText: command.payload.normalizedText,
        valueJson: command.payload.valueJson,
        predicate: command.payload.predicate,
        observedAt: command.payload.observedAt,
        subject: { ...command.payload.subject }
      },
      predicateCatalogVersion: command.predicateCatalogVersion,
      idempotencyKey: command.idempotencyKey,
      kind: command.kind
    };
    expect(serializeB2Command(reordered)).toBe(serializeB2Command(command));
    expect(hashB2CommandIdentity(reordered)).toBe(hashB2CommandIdentity(command));
    expect(canonicalB2CommandIdentity(command)).toMatchObject({
      recipe: "truth-ledger-command-identity.v1",
      commandSchemaVersion: 1,
      predicateCatalogVersion: "truth-predicate-catalog.v1",
      kind: "claim.create"
    });
    expect(serializeB2CommandIdentity(command)).toContain(
      '"predicateCatalogVersion":"truth-predicate-catalog.v1"'
    );
    const identity: B2CanonicalCommandIdentityInput = canonicalB2CommandIdentity(
      commands["fact.revoke"]
    );
    if (identity.kind === "fact.revoke") {
      expectTypeOf(identity.payload).toEqualTypeOf<B2CommandPayloadMap["fact.revoke"]>();
    }
    expectTypeOf<{
      kind: "fact.revoke";
      payload: (typeof commands)["claim.create"]["payload"];
    }>().not.toMatchTypeOf<B2CanonicalCommandIdentityInput>();

    const hashes = [
      hashB2CommandIdentity(command),
      hashB2CommandIdentity({
        ...command,
        payload: { ...command.payload, confidence: "confirmed" }
      }),
      hashB2CommandIdentity({
        ...command,
        payload: {
          ...command.payload,
          subject: { ...command.payload.subject, expectedVersion: 4 }
        }
      }),
      hashB2CommandIdentity({
        ...command,
        payload: {
          ...command.payload,
          evidence: { ...command.payload.evidence, excerptHash: "e".repeat(64) }
        }
      }),
      hashB2CommandIdentity({
        ...command,
        payload: {
          ...command.payload,
          evidence: { ...command.payload.evidence, expectedSourceVersion: 3 }
        }
      }),
      hashB2CommandIdentity(commands["fact.revoke"]),
      hashB2CommandIdentity({
        ...commands["fact.revoke"],
        payload: {
          ...commands["fact.revoke"].payload,
          reason: {
            code: "entered_in_error",
            rationale: commands["fact.revoke"].payload.reason.rationale
          }
        }
      }),
      hashB2CommandIdentity({
        ...commands["fact.revoke"],
        payload: {
          ...commands["fact.revoke"].payload,
          reason: {
            ...commands["fact.revoke"].payload.reason,
            rationale: "The support was invalidated by a corrected source."
          }
        }
      })
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(
      hashB2CommandIdentity({ ...command, idempotencyKey: "a-different-reservation-key" })
    ).toBe(hashB2CommandIdentity(command));
  });

  it("matches the collision-sensitive command identity golden fixture", () => {
    const goldenHashes = Object.fromEntries(
      B2_COMMAND_KINDS.map((kind) => [kind, hashB2CommandIdentity(commands[kind])])
    );
    expect(goldenHashes).toEqual({
      "claim.create": "e0090b2ddb41bb906cf50e58400a129aad33b384097ee9d941dc180e017fb142",
      "fact.accept": "f794d35986417e2f26d519172a2cd2434e86da12122b68c67f3018c96be56691",
      "fact.contest": "fdd9683d7ddb66727dd5a9cf9457d6e8bb87902ed24a0fa7c88f46c117bb6753",
      "fact.uphold": "f71ba178ad3f3b6c033e4438697263932c598fd7db42bda7184d6c51e1587900",
      "fact.supersede": "5c12ed226680136d0042e765c541559af0e9c09eb3d8051d04a2e2d7fc6e9757",
      "fact.revoke": "91f362637596bf38f964f41e6e17ab71c82dd7dce8a5c9765a56c21f9bdf0a2d",
      "fact.emergency_contest": "634e17c53b2039281ebeb8ec0ea3ab68275e5cc0e4a966e50d1b80a9c244694c",
      "fact.emergency_revoke": "13371e6671c107d5ebee35f0cd1fa330e655232f0b9620c1ac0eb88a3fb71b77",
      "derived_view.regenerate": "f26f104ed217f67cdf79e3db66e43d9cde7d43f3684d96d51c022ac508367126"
    });
  });
});

export { commands as B2_TEST_COMMANDS };
