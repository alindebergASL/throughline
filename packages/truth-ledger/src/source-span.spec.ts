import {
  ACCESS_CLASS_RANK,
  SOURCE_CHUNKING_VERSION,
  SOURCE_NORMALIZATION_VERSION,
  type AccessClass,
  type ClaimSourceSpanCandidate
} from "@throughline/core-types";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VerifiedClaimSourceSpanAdmission,
  isVerifiedClaimSourceSpan,
  type AuthorizedClaimEvidenceSnapshot,
  type AuthorizedClaimEvidenceSnapshotLookup
} from "./source-span.js";

const ids = {
  tenant: "018f0000-0000-7000-8000-000000000001",
  workspace: "018f0000-0000-7000-8000-000000000002",
  space: "018f0000-0000-7000-8000-000000000003",
  activity: "018f0000-0000-7000-8000-000000000004",
  initiative: "018f0000-0000-7000-8000-000000000005",
  source: "018f0000-0000-7000-8000-000000000006",
  chunk1: "018f0000-0000-7000-8000-000000000007",
  chunk2: "018f0000-0000-7000-8000-000000000008",
  other: "018f0000-0000-7000-8000-000000000009"
} as const;

interface Fixture {
  snapshot: AuthorizedClaimEvidenceSnapshot;
  candidate: {
    subject: { type: "activity" | "initiative"; id: string; expectedVersion: number };
    evidence: ClaimSourceSpanCandidate;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture(input?: {
  raw?: string;
  normalized?: string;
  chunks?: readonly string[];
  selectedChunk?: number;
  localStart?: number;
  localEnd?: number;
  subjectType?: "activity" | "initiative";
}): Fixture {
  const raw = input?.raw ?? "A😀e\u0301Z\r\nnext";
  const normalized = input?.normalized ?? "A😀éZ\nnext";
  const chunkTexts = input?.chunks ?? [normalized];
  const selectedChunk = input?.selectedChunk ?? 0;
  const localStart = input?.localStart ?? 1;
  const localEnd = input?.localEnd ?? 3;
  const subjectType = input?.subjectType ?? "activity";
  let globalStart = 0;
  const chunks = chunkTexts.map((text, index) => {
    const startOffset = globalStart;
    const endOffset = startOffset + Array.from(text).length;
    globalStart = endOffset;
    return {
      id: index === 0 ? ids.chunk1 : ids.chunk2,
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space,
      sourceArtifactId: ids.source,
      version: 1 as const,
      normalizationVersion: SOURCE_NORMALIZATION_VERSION,
      chunkingVersion: SOURCE_CHUNKING_VERSION,
      chunkIndex: index,
      startOffset,
      endOffset,
      normalizedText: text,
      contentHash: sha256(text),
      accessClass: "workspace" as const
    };
  });
  const selected = chunks[selectedChunk]!;
  const excerpt = Array.from(selected.normalizedText).slice(localStart, localEnd).join("");
  const subjectId = subjectType === "activity" ? ids.activity : ids.initiative;
  return {
    snapshot: {
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space,
      subject: {
        type: subjectType,
        id: subjectId,
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
        spaceId: ids.space,
        version: 4,
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
        version: 2,
        immutableText: raw,
        contentHash: sha256(raw),
        normalizedContentHash: sha256(normalized),
        normalizationVersion: SOURCE_NORMALIZATION_VERSION,
        chunkingVersion: SOURCE_CHUNKING_VERSION,
        accessClass: "workspace",
        deletedAt: null,
        successorSourceArtifactId: null
      },
      chunks,
      explicitPolicyAccessClass: "public"
    },
    candidate: {
      subject: { type: subjectType, id: subjectId, expectedVersion: 4 },
      evidence: {
        sourceArtifactId: ids.source,
        sourceChunkId: selected.id,
        expectedSourceVersion: 2,
        expectedChunkVersion: 1,
        normalizationVersion: SOURCE_NORMALIZATION_VERSION,
        chunkingVersion: SOURCE_CHUNKING_VERSION,
        startOffset: localStart,
        endOffset: localEnd,
        excerpt,
        sourceContentHash: sha256(raw),
        sourceNormalizedContentHash: sha256(normalized),
        chunkContentHash: selected.contentHash,
        excerptHash: sha256(excerpt)
      }
    }
  };
}

function admission(snapshot: AuthorizedClaimEvidenceSnapshot | null, requests?: unknown[]) {
  const lookup: AuthorizedClaimEvidenceSnapshotLookup = {
    async getAuthorizedClaimEvidenceSnapshot(input) {
      requests?.push(input);
      return snapshot;
    }
  };
  return new VerifiedClaimSourceSpanAdmission(lookup, {
    tenantId: ids.tenant,
    workspaceId: ids.workspace
  });
}

function cloneFixture(value = fixture()): Fixture {
  return structuredClone(value) as Fixture;
}

describe("VerifiedClaimSourceSpan admission", () => {
  it("uses the authoritative lookup and admits an exact CRLF-normalized, NFC, emoji span", async () => {
    const value = fixture();
    const requests: unknown[] = [];
    const verified = await admission(value.snapshot, requests).admit(value.candidate);
    expect(requests).toEqual([
      {
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
        subjectType: "activity",
        subjectId: ids.activity,
        sourceArtifactId: ids.source,
        sourceChunkId: ids.chunk1
      }
    ]);
    expect(verified).toMatchObject({
      subject: { type: "activity", id: ids.activity, version: 4 },
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space,
      sourceArtifactId: ids.source,
      sourceChunkId: ids.chunk1,
      sourceVersion: 2,
      chunkVersion: 1,
      startOffset: 1,
      endOffset: 3,
      excerpt: "😀é",
      effectiveAccessClass: "workspace"
    });
    expect(isVerifiedClaimSourceSpan(verified)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.keys(verified)).not.toContain("verifiedClaimSourceSpanBrand");
  });

  it("supports ASCII and exact start/end boundaries at the B1 maximum", async () => {
    const ascii = fixture({ raw: "abcdef", normalized: "abcdef", localStart: 0, localEnd: 6 });
    await expect(admission(ascii.snapshot).admit(ascii.candidate)).resolves.toMatchObject({
      excerpt: "abcdef",
      startOffset: 0,
      endOffset: 6
    });
    const maximum = "x".repeat(2_000);
    const maxFixture = fixture({
      raw: maximum,
      normalized: maximum,
      localStart: 0,
      localEnd: 2_000
    });
    await expect(admission(maxFixture.snapshot).admit(maxFixture.candidate)).resolves.toMatchObject(
      {
        excerpt: maximum,
        startOffset: 0,
        endOffset: 2_000
      }
    );
    const overMaximum = fixture({
      raw: "x".repeat(2_001),
      normalized: "x".repeat(2_001),
      localStart: 0,
      localEnd: 2_001
    });
    await expect(admission(overMaximum.snapshot).admit(overMaximum.candidate)).rejects.toThrow();
  });

  it("admits exact chunk-local boundaries across deterministic multi-chunk evidence", async () => {
    const value = fixture({
      raw: "abcdef",
      normalized: "abcdef",
      chunks: ["abc", "def"],
      selectedChunk: 1,
      localStart: 0,
      localEnd: 2
    });
    await expect(admission(value.snapshot).admit(value.candidate)).resolves.toMatchObject({
      sourceChunkId: ids.chunk2,
      startOffset: 0,
      endOffset: 2,
      excerpt: "de"
    });
  });

  it("accepts the exact B1 raw hash when TextDecoder stripped one UTF-8 BOM", async () => {
    const value = fixture({ raw: "abc", normalized: "abc", localStart: 0, localEnd: 3 });
    const originalB1BytesHash = sha256("\uFEFFabc");
    (value.snapshot.source as { contentHash: string }).contentHash = originalB1BytesHash;
    value.candidate.evidence.sourceContentHash = originalB1BytesHash;
    await expect(admission(value.snapshot).admit(value.candidate)).resolves.toMatchObject({
      excerpt: "abc",
      sourceContentHash: originalB1BytesHash
    });
  });

  it("rejects lookup misses, fabricated IDs, and every scope/ownership mismatch", async () => {
    const base = fixture();
    await expect(admission(null).admit(base.candidate)).rejects.toThrow(
      "Claim evidence is unavailable or invalid"
    );
    await expect(
      new VerifiedClaimSourceSpanAdmission(
        {
          async getAuthorizedClaimEvidenceSnapshot() {
            return base.snapshot;
          }
        },
        { tenantId: ids.other, workspaceId: ids.workspace }
      ).admit(base.candidate)
    ).rejects.toThrow("Claim evidence is unavailable or invalid");
    await expect(
      new VerifiedClaimSourceSpanAdmission(
        {
          async getAuthorizedClaimEvidenceSnapshot() {
            return base.snapshot;
          }
        },
        { tenantId: ids.tenant, workspaceId: ids.other }
      ).admit(base.candidate)
    ).rejects.toThrow("Claim evidence is unavailable or invalid");
    const mutations: Array<(value: Fixture) => void> = [
      (value) => {
        value.candidate.evidence.sourceArtifactId = ids.other;
      },
      (value) => {
        value.candidate.evidence.sourceChunkId = ids.other;
      },
      (value) => {
        (value.snapshot as { tenantId: string }).tenantId = ids.other;
      },
      (value) => {
        (value.snapshot as { workspaceId: string }).workspaceId = ids.other;
      },
      (value) => {
        (value.snapshot as { spaceId: string }).spaceId = ids.other;
      },
      (value) => {
        (value.snapshot.subject as { tenantId: string }).tenantId = ids.other;
      },
      (value) => {
        (value.snapshot.subject as { workspaceId: string }).workspaceId = ids.other;
      },
      (value) => {
        (value.snapshot.subject as { spaceId: string }).spaceId = ids.other;
      },
      (value) => {
        (value.snapshot.sourceActivityLink as { tenantId: string }).tenantId = ids.other;
      },
      (value) => {
        (value.snapshot.sourceActivityLink as { workspaceId: string }).workspaceId = ids.other;
      },
      (value) => {
        (value.snapshot.sourceActivityLink as { spaceId: string }).spaceId = ids.other;
      },
      (value) => {
        (value.snapshot.source as { tenantId: string }).tenantId = ids.other;
      },
      (value) => {
        (value.snapshot.source as { id: string }).id = ids.other;
      },
      (value) => {
        (value.snapshot.source as { workspaceId: string }).workspaceId = ids.other;
      },
      (value) => {
        (value.snapshot.source as { spaceId: string }).spaceId = ids.other;
      },
      (value) => {
        (value.snapshot.chunks[0] as { tenantId: string }).tenantId = ids.other;
      },
      (value) => {
        (value.snapshot.chunks[0] as { workspaceId: string }).workspaceId = ids.other;
      },
      (value) => {
        (value.snapshot.chunks[0] as { spaceId: string }).spaceId = ids.other;
      },
      (value) => {
        (value.snapshot.chunks[0] as { sourceArtifactId: string }).sourceArtifactId = ids.other;
      },
      (value) => {
        (value.snapshot.sourceActivityLink as { sourceArtifactId: string }).sourceArtifactId =
          ids.other;
      },
      (value) => {
        (value.snapshot.sourceActivityLink as { activityId: string }).activityId = ids.other;
      },
      (value) => {
        (value.snapshot.subject as { id: string }).id = ids.other;
      },
      (value) => {
        value.candidate.subject.id = ids.other;
      },
      (value) => {
        value.candidate.subject.type = "initiative";
      }
    ];
    for (const mutate of mutations) {
      const value = cloneFixture(base);
      mutate(value);
      await expect(admission(value.snapshot).admit(value.candidate)).rejects.toThrow(
        "Claim evidence is unavailable or invalid"
      );
    }

    const initiative = fixture({ subjectType: "initiative" });
    await expect(admission(initiative.snapshot).admit(initiative.candidate)).resolves.toMatchObject(
      {
        subject: { type: "initiative", id: ids.initiative }
      }
    );
    (
      initiative.snapshot.sourceActivityLink as { governingInitiativeId: string }
    ).governingInitiativeId = ids.other;
    await expect(admission(initiative.snapshot).admit(initiative.candidate)).rejects.toThrow();
  });

  it("rejects source/chunk/version/offset/excerpt/hash/version attacks independently", async () => {
    const mutations: Array<(value: Fixture) => void> = [
      (value) => {
        value.candidate.subject.expectedVersion += 1;
      },
      (value) => {
        value.candidate.evidence.expectedSourceVersion += 1;
      },
      (value) => {
        (value.snapshot.source as { version: number }).version += 1;
      },
      (value) => {
        (value.candidate.evidence as { expectedChunkVersion: number }).expectedChunkVersion = 2;
      },
      (value) => {
        (value.candidate.evidence as { normalizationVersion: string }).normalizationVersion = "bad";
      },
      (value) => {
        (value.candidate.evidence as { chunkingVersion: string }).chunkingVersion = "bad";
      },
      (value) => {
        (value.snapshot.source as { normalizationVersion: string }).normalizationVersion = "bad";
      },
      (value) => {
        (value.snapshot.source as { chunkingVersion: string }).chunkingVersion = "bad";
      },
      (value) => {
        (value.snapshot.chunks[0] as { normalizationVersion: string }).normalizationVersion = "bad";
      },
      (value) => {
        (value.snapshot.chunks[0] as { chunkingVersion: string }).chunkingVersion = "bad";
      },
      (value) => {
        (value.snapshot.chunks[0] as { version: number }).version = 2;
      },
      (value) => {
        (value.snapshot.chunks[0] as { startOffset: number }).startOffset = 1;
      },
      (value) => {
        value.candidate.evidence.startOffset = -1;
      },
      (value) => {
        value.candidate.evidence.endOffset = 1;
      },
      (value) => {
        value.candidate.evidence.startOffset = 3;
        value.candidate.evidence.endOffset = 2;
      },
      (value) => {
        value.candidate.evidence.startOffset = 99;
      },
      (value) => {
        value.candidate.evidence.excerpt = "😀e\u0301";
      },
      (value) => {
        value.candidate.evidence.excerpt = "😀É";
      },
      (value) => {
        value.candidate.evidence.excerpt = " 😀é";
      },
      (value) => {
        value.candidate.evidence.excerpt = "😀é\n";
      },
      (value) => {
        value.candidate.evidence.sourceContentHash = "0".repeat(64);
      },
      (value) => {
        value.candidate.evidence.sourceNormalizedContentHash = "0".repeat(64);
      },
      (value) => {
        value.candidate.evidence.chunkContentHash = "0".repeat(64);
      },
      (value) => {
        value.candidate.evidence.excerptHash = "0".repeat(64);
      },
      (value) => {
        (value.snapshot.source as { contentHash: string }).contentHash = "0".repeat(64);
      },
      (value) => {
        (value.snapshot.source as { normalizedContentHash: string }).normalizedContentHash =
          "0".repeat(64);
      },
      (value) => {
        (value.snapshot.chunks[0] as { contentHash: string }).contentHash = "0".repeat(64);
      },
      (value) => {
        const duplicate = structuredClone(value.snapshot.chunks[0]!);
        (duplicate as { chunkIndex: number }).chunkIndex = 1;
        (duplicate as { startOffset: number }).startOffset = value.snapshot.chunks[0]!.endOffset;
        (duplicate as { endOffset: number }).endOffset =
          value.snapshot.chunks[0]!.endOffset + Array.from(duplicate.normalizedText).length;
        (value.snapshot as { chunks: AuthorizedClaimEvidenceSnapshot["chunks"] }).chunks = [
          value.snapshot.chunks[0]!,
          duplicate
        ];
      }
    ];
    for (const mutate of mutations) {
      const value = cloneFixture();
      mutate(value);
      await expect(admission(value.snapshot).admit(value.candidate)).rejects.toThrow();
    }
  });

  it("rejects UTF-16/code-unit and artifact-global offsets substituted for chunk-local offsets", async () => {
    const utf16 = fixture({ raw: "A😀B", normalized: "A😀B", localStart: 1, localEnd: 2 });
    utf16.candidate.evidence.endOffset = 3;
    await expect(admission(utf16.snapshot).admit(utf16.candidate)).rejects.toThrow();

    const secondChunk = fixture({
      raw: "abcdef",
      normalized: "abcdef",
      chunks: ["abc", "def"],
      selectedChunk: 1,
      localStart: 0,
      localEnd: 2
    });
    secondChunk.candidate.evidence.startOffset = 3;
    secondChunk.candidate.evidence.endOffset = 5;
    await expect(admission(secondChunk.snapshot).admit(secondChunk.candidate)).rejects.toThrow();
  });

  it("rejects deleted and superseded/nonterminal corrected evidence", async () => {
    const deleted = cloneFixture();
    (deleted.snapshot.source as { deletedAt: string | null }).deletedAt = "2026-07-23T00:00:00Z";
    await expect(admission(deleted.snapshot).admit(deleted.candidate)).rejects.toThrow();

    const superseded = cloneFixture();
    (
      superseded.snapshot.source as { successorSourceArtifactId: string | null }
    ).successorSourceArtifactId = ids.other;
    await expect(admission(superseded.snapshot).admit(superseded.candidate)).rejects.toThrow();
  });

  it("mechanically links stored raw text to the reconstructed normalized chunks", async () => {
    const mismatched = cloneFixture();
    const differentRaw = "A different raw artifact";
    (mismatched.snapshot.source as { immutableText: string }).immutableText = differentRaw;
    (mismatched.snapshot.source as { contentHash: string }).contentHash = sha256(differentRaw);
    mismatched.candidate.evidence.sourceContentHash = sha256(differentRaw);
    await expect(admission(mismatched.snapshot).admit(mismatched.candidate)).rejects.toThrow();
  });

  it("uses the single access lattice for all combinations and exposes no downgrade field", async () => {
    const classes = Object.keys(ACCESS_CLASS_RANK) as AccessClass[];
    for (const sourceClass of classes) {
      for (const chunkClass of classes) {
        for (const subjectClass of classes) {
          for (const policyClass of classes) {
            const value = cloneFixture();
            (value.snapshot.source as { accessClass: AccessClass }).accessClass = sourceClass;
            (value.snapshot.chunks[0] as { accessClass: AccessClass }).accessClass = chunkClass;
            (value.snapshot.subject as { accessClass: AccessClass }).accessClass = subjectClass;
            (
              value.snapshot as { explicitPolicyAccessClass: AccessClass }
            ).explicitPolicyAccessClass = policyClass;
            const verified = await admission(value.snapshot).admit(value.candidate);
            const expected = [sourceClass, chunkClass, subjectClass, policyClass].reduce(
              (maximum, current) =>
                ACCESS_CLASS_RANK[current] > ACCESS_CLASS_RANK[maximum] ? current : maximum
            );
            expect(verified.effectiveAccessClass).toBe(expected);
          }
        }
      }
    }
    const downgrade = cloneFixture();
    const evidenceWithDowngrade = {
      ...downgrade.candidate.evidence,
      requestedAccessClass: "public"
    };
    await expect(
      admission(downgrade.snapshot).admit({
        subject: downgrade.candidate.subject,
        evidence: evidenceWithDowngrade
      })
    ).rejects.toThrow();
  });
});
