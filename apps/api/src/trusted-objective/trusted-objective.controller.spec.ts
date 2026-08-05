import { HttpException } from "@nestjs/common";
import { normalizeAndChunkSource } from "@throughline/content";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import {
  TrustedObjectiveInputError,
  TrustedObjectiveUnavailableError,
  parseAcceptBody,
  parseProposalBody,
  parseReworkBody,
  parseWithdrawBody
} from "./trusted-objective.contract.js";
import { TrustedObjectiveController } from "./trusted-objective.controller.js";
import type { TrustedObjectiveRequest } from "./trusted-objective.guard.js";
import {
  TrustedObjectiveRuntime,
  deriveEvidenceCandidate,
  primaryObjectiveProposalKey,
  primaryObjectiveGenerationAnchor,
  primaryObjectiveSourceRevisionAnchor,
  stableKey
} from "./trusted-objective.runtime.js";

const initiativeId = "70000000-0000-7000-8000-000000000204";
const proposalGenerationAnchor = primaryObjectiveGenerationAnchor(null);
const sourceRevisionAnchor = `trusted-objective:source-revision:${"b".repeat(64)}`;

function request(): TrustedObjectiveRequest {
  return {
    headers: {},
    method: "GET",
    trustedObjectiveContext: createDevSecurityContext("tenant-a-owner")
  };
}

describe("TrustedObjectiveController", () => {
  it("passes only plain-language capture/proposal/accept/draft inputs to the product runtime", async () => {
    const state = { state: "captured" };
    const runtime = {
      capture: vi.fn(async () => state),
      propose: vi.fn(async () => ({ state: "proposed" })),
      rework: vi.fn(async () => ({ state: "proposed" })),
      withdraw: vi.fn(async () => ({ state: "captured" })),
      accept: vi.fn(async () => ({ state: "accepted" })),
      draftConfirmation: vi.fn(async () => ({
        question: "Confirm?",
        sent: false,
        status: "Not sent"
      }))
    };
    const controller = new TrustedObjectiveController(runtime as never);
    await controller.capture(request(), initiativeId, { note: "Exact note" });
    await controller.propose(request(), initiativeId, {
      objective: "Reduce response time.",
      exactExcerpt: "reduce response time",
      supportConfirmed: true,
      proposalGenerationAnchor,
      sourceRevisionAnchor
    });
    await controller.rework(request(), initiativeId, {
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 2,
      objective: "Reduce governed response time.",
      exactExcerpt: "reduce response time",
      supportConfirmed: true,
      sourceRevisionAnchor
    });
    await controller.accept(request(), initiativeId, {
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 2
    });
    await expect(controller.draftConfirmation(request(), initiativeId, {})).resolves.toEqual({
      question: "Confirm?",
      sent: false,
      status: "Not sent"
    });
    expect(runtime.capture).toHaveBeenCalledWith(expect.any(Object), initiativeId, "Exact note");
    expect(runtime.propose).toHaveBeenCalledWith(expect.any(Object), initiativeId, {
      objective: "Reduce response time.",
      exactExcerpt: "reduce response time",
      supportConfirmed: true,
      proposalGenerationAnchor,
      sourceRevisionAnchor
    });
    expect(runtime.rework).toHaveBeenCalledWith(expect.any(Object), initiativeId, {
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 2,
      objective: "Reduce governed response time.",
      exactExcerpt: "reduce response time",
      supportConfirmed: true,
      sourceRevisionAnchor
    });
    expect(runtime.accept).toHaveBeenCalledWith(expect.any(Object), initiativeId, {
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 2
    });
  });

  it("rejects browser-supplied hashes, authority, scope, and identities", async () => {
    for (const injected of [
      { sourceContentHash: "a".repeat(64) },
      { tenantId: "tenant" },
      { accessClass: "public" },
      { acceptedByUserId: "actor" },
      { proposalGeneration: 2 },
      { latestObjectiveClaimId: "70000000-0000-7000-8000-000000000401" }
    ]) {
      expect(() =>
        parseProposalBody({
          objective: "Reduce response time.",
          exactExcerpt: "reduce response time",
          supportConfirmed: true,
          proposalGenerationAnchor,
          sourceRevisionAnchor,
          ...injected
        })
      ).toThrow(TrustedObjectiveInputError);
    }
  });

  it("requires a fresh exact support confirmation for initial proposals and rework", () => {
    for (const supportConfirmed of [undefined, false, "true", 1, { confirmed: true }]) {
      expect(() =>
        parseProposalBody({
          objective: "Reduce response time.",
          exactExcerpt: "reduce response time",
          proposalGenerationAnchor,
          sourceRevisionAnchor,
          supportConfirmed
        })
      ).toThrow(TrustedObjectiveInputError);
      expect(() =>
        parseReworkBody({
          claimId: "70000000-0000-7000-8000-000000000401",
          expectedClaimVersion: 1,
          expectedInitiativeVersion: 1,
          objective: "Reduce response time.",
          exactExcerpt: "reduce response time",
          sourceRevisionAnchor,
          supportConfirmed
        })
      ).toThrow(TrustedObjectiveInputError);
    }
  });

  it("requires the opaque server-derived source revision anchor for proposal confirmation", () => {
    for (const invalidAnchor of [undefined, "", "trusted-objective:source-revision:decoded"]) {
      expect(() =>
        parseProposalBody({
          objective: "Reduce response time.",
          exactExcerpt: "reduce response time",
          supportConfirmed: true,
          proposalGenerationAnchor,
          sourceRevisionAnchor: invalidAnchor
        })
      ).toThrow(TrustedObjectiveInputError);
      expect(() =>
        parseReworkBody({
          claimId: "70000000-0000-7000-8000-000000000401",
          expectedClaimVersion: 1,
          expectedInitiativeVersion: 1,
          objective: "Reduce response time.",
          exactExcerpt: "reduce response time",
          supportConfirmed: true,
          sourceRevisionAnchor: invalidAnchor
        })
      ).toThrow(TrustedObjectiveInputError);
    }
  });

  it("requires the exact rendered Claim and Initiative versions for acceptance", () => {
    expect(
      parseAcceptBody({
        claimId: "70000000-0000-7000-8000-000000000401",
        expectedClaimVersion: 1,
        expectedInitiativeVersion: 3
      })
    ).toEqual({
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 3
    });
    for (const invalid of [
      {},
      { claimId: "70000000-0000-7000-8000-000000000401" },
      {
        claimId: "70000000-0000-7000-8000-000000000401",
        expectedClaimVersion: 2,
        expectedInitiativeVersion: 3
      }
    ]) {
      expect(() => parseAcceptBody(invalid)).toThrow(TrustedObjectiveInputError);
    }
  });

  it("accepts only objective-specific bounded recovery request shapes", () => {
    expect(
      parseWithdrawBody({
        claimId: "70000000-0000-7000-8000-000000000401",
        expectedClaimVersion: 1,
        expectedInitiativeVersion: 3,
        disposition: "withdrawn",
        reasonCode: "needs_rework"
      })
    ).toMatchObject({ disposition: "withdrawn", reasonCode: "needs_rework" });
    expect(() =>
      parseWithdrawBody({
        claimId: "70000000-0000-7000-8000-000000000401",
        expectedClaimVersion: 1,
        expectedInitiativeVersion: 3,
        disposition: "withdrawn",
        reasonCode: "needs_rework",
        claimText: "must never enter audit detail"
      })
    ).toThrow(TrustedObjectiveInputError);
  });

  it("makes unavailable and missing resources outwardly identical", async () => {
    const results = [];
    for (const failure of [
      new TrustedObjectiveUnavailableError(),
      new TrustedObjectiveUnavailableError()
    ]) {
      const controller = new TrustedObjectiveController({
        getState: vi.fn(async () => {
          throw failure;
        })
      } as never);
      results.push(await failureResponse(() => controller.getState(request(), initiativeId)));
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      status: 404,
      body: { error: "Not Found", message: "Resource unavailable", statusCode: 404 }
    });
  });
});

describe("trusted objective evidence and idempotency contracts", () => {
  it("derives hashes and Unicode-scalar offsets from the authorized stored chunk", () => {
    const source = {
      id: "70000000-0000-7000-8000-000000000301",
      version: 1,
      immutableText: "Maya: Reduce average response time from twelve days to five. 👩🏽‍💻",
      contentHash: "",
      normalizedContentHash: "",
      accessClass: "workspace",
      chunks: []
    } as never;
    const normalized = normalizeSourceFixture(source as never);
    const evidence = deriveEvidenceCandidate(normalized as never, "twelve days to five");
    const anchor = primaryObjectiveSourceRevisionAnchor(normalized as never);
    expect(evidence).toMatchObject({
      startOffset: 40,
      endOffset: 59,
      excerpt: "twelve days to five",
      expectedSourceVersion: 1,
      expectedChunkVersion: 1
    });
    expect(evidence.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.excerptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(anchor).toMatch(/^trusted-objective:source-revision:[a-f0-9]{64}$/);
    expect(primaryObjectiveSourceRevisionAnchor({ ...normalized, version: 2 } as never)).not.toBe(
      anchor
    );
  });

  it("uses stable semantic command keys", () => {
    expect(stableKey("accept", initiativeId, "claim")).toBe(
      stableKey("accept", initiativeId, "claim")
    );
    expect(stableKey("accept", initiativeId, "claim")).not.toBe(
      stableKey("accept", initiativeId, "other")
    );
  });

  it("converges an initial proposal but starts a fresh generation after terminal history", () => {
    const evidence = {
      sourceArtifactId: "70000000-0000-7000-8000-000000000301",
      sourceChunkId: "70000000-0000-7000-8000-000000000302",
      startOffset: 6,
      endOffset: 26
    };
    const initialA = primaryObjectiveProposalKey(
      initiativeId,
      "Reduce response time.",
      evidence,
      primaryObjectiveGenerationAnchor(null),
      sourceRevisionAnchor
    );
    const initialB = primaryObjectiveProposalKey(
      initiativeId,
      "Reduce response time.",
      evidence,
      primaryObjectiveGenerationAnchor(null),
      sourceRevisionAnchor
    );
    const afterTerminal = primaryObjectiveProposalKey(
      initiativeId,
      "Reduce response time.",
      evidence,
      primaryObjectiveGenerationAnchor({
        id: "70000000-0000-7000-8000-000000000401",
        version: 2,
        status: "superseded"
      }),
      sourceRevisionAnchor
    );
    const afterSourceRevision = primaryObjectiveProposalKey(
      initiativeId,
      "Reduce response time.",
      evidence,
      primaryObjectiveGenerationAnchor(null),
      `trusted-objective:source-revision:${"c".repeat(64)}`
    );

    expect(initialA).toBe(initialB);
    expect(afterTerminal).not.toBe(initialA);
    expect(afterSourceRevision).not.toBe(initialA);
  });

  it("derives the proposal generation from the latest durable objective Claim", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "70000000-0000-7000-8000-000000000401",
          version: 2,
          status: "rejected"
        }
      ]
    }));
    const runtime = new TrustedObjectiveRuntime();
    const anchor = await (
      runtime as unknown as {
        readLatestPrimaryObjectiveClaim(
          tx: object,
          context: object,
          scope: object
        ): Promise<unknown>;
      }
    ).readLatestPrimaryObjectiveClaim({ query }, createDevSecurityContext("tenant-a-owner"), {
      initiativeId
    });

    expect(anchor).toEqual({
      id: "70000000-0000-7000-8000-000000000401",
      version: 2,
      status: "rejected"
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY created_at DESC, id DESC"),
      expect.arrayContaining([initiativeId, "initiative.primary_objective"])
    );
  });

  it("projects a bounded authorized rework lineage rooted at the rendered successor", async () => {
    const predecessorClaimId = "70000000-0000-7000-8000-000000000401";
    const successorClaimId = "70000000-0000-7000-8000-000000000402";
    const query = vi.fn(async () => ({
      rows: [
        {
          predecessor_claim_id: predecessorClaimId,
          successor_claim_id: successorClaimId,
          disposition: "reworked",
          reason_code: "reworked",
          reworked_at: new Date("2026-08-05T01:00:00.000Z")
        }
      ]
    }));
    const canInTransaction = vi.fn(async () => ({ allowed: true }));
    const runtime = new TrustedObjectiveRuntime();
    (runtime as unknown as { authorization: object }).authorization = { canInTransaction };
    const lineage = await (
      runtime as unknown as {
        readReworkLineage(
          tx: object,
          context: object,
          scope: object,
          currentClaimId: string
        ): Promise<unknown>;
      }
    ).readReworkLineage(
      { query },
      createDevSecurityContext("tenant-a-owner"),
      { initiativeId },
      successorClaimId
    );

    expect(lineage).toEqual([
      {
        predecessorClaimId,
        successorClaimId,
        disposition: "reworked",
        reasonCode: "reworked",
        reworkedAt: "2026-08-05T01:00:00.000Z"
      }
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("lineage.depth < 20"), [
      expect.any(String),
      expect.any(String),
      initiativeId,
      successorClaimId
    ]);
    expect(canInTransaction).toHaveBeenCalledTimes(2);
  });

  it("fails the read projection closed when persisted source, chunk, or excerpt relationships are invalid", async () => {
    const source = normalizeSourceFixture({
      id: "70000000-0000-7000-8000-000000000301",
      version: 1,
      immutableText: "Maya: Reduce average response time from twelve days to five.",
      accessClass: "workspace"
    });
    const evidence = deriveEvidenceCandidate(source as never, "twelve days to five");
    const validRow = {
      claim_id: "70000000-0000-7000-8000-000000000401",
      claim_version: 1,
      claim_status: "accepted",
      canonical_value_text: "Reduce average response time.",
      normalized_text: "Reduce average response time.",
      predicate: "initiative.primary_objective",
      claim_access_class: "workspace",
      source_artifact_id: evidence.sourceArtifactId,
      source_chunk_id: evidence.sourceChunkId,
      source_version: evidence.expectedSourceVersion,
      chunk_version: evidence.expectedChunkVersion,
      normalization_version: evidence.normalizationVersion,
      chunking_version: evidence.chunkingVersion,
      source_start_offset: evidence.startOffset,
      source_end_offset: evidence.endOffset,
      source_excerpt: evidence.excerpt,
      source_content_hash: evidence.sourceContentHash,
      source_normalized_content_hash: evidence.sourceNormalizedContentHash,
      chunk_content_hash: evidence.chunkContentHash,
      excerpt_hash: evidence.excerptHash,
      span_access_class: "workspace"
    };
    const runtime = new TrustedObjectiveRuntime();
    (runtime as unknown as { authorization: object }).authorization = {
      canInTransaction: vi.fn(async () => ({ allowed: true }))
    };
    const read = (row: Record<string, unknown>) =>
      (
        runtime as unknown as {
          readValidClaim(
            tx: object,
            context: object,
            scope: object,
            source: object,
            claimId: string,
            status: string
          ): Promise<unknown>;
        }
      ).readValidClaim(
        { query: vi.fn(async () => ({ rows: [row] })) },
        createDevSecurityContext("tenant-a-owner"),
        { initiativeAccessClass: "workspace" },
        { projection: source, createdAt: "2026-06-18T14:00:00.000Z" },
        validRow.claim_id,
        "accepted"
      );

    await expect(read(validRow)).resolves.toMatchObject({ exactExcerpt: evidence.excerpt });
    await expect(read({ ...validRow, source_content_hash: "0".repeat(64) })).resolves.toBeNull();
    await expect(read({ ...validRow, chunk_content_hash: "0".repeat(64) })).resolves.toBeNull();
    await expect(read({ ...validRow, excerpt_hash: "0".repeat(64) })).resolves.toBeNull();
  });
});

function normalizeSourceFixture(source: {
  id: string;
  version: number;
  immutableText: string;
  accessClass: string;
}) {
  const normalized = normalizeAndChunkSource(source.immutableText);
  return {
    ...source,
    contentHash: normalized.source.contentHash,
    normalizedContentHash: normalized.source.normalizedContentHash,
    chunks: normalized.chunks.map((chunk, index) => ({
      ...chunk,
      id: `70000000-0000-7000-8000-00000000030${index + 2}`,
      accessClass: source.accessClass
    }))
  };
}

async function failureResponse(callback: () => Promise<unknown>) {
  try {
    await callback();
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), body: error.getResponse() };
    }
    throw error;
  }
  throw new Error("Expected failure");
}
