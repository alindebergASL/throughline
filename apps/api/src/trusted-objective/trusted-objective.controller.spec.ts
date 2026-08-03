import { HttpException } from "@nestjs/common";
import { normalizeAndChunkSource } from "@throughline/content";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import {
  TrustedObjectiveInputError,
  TrustedObjectiveUnavailableError,
  parseProposalBody
} from "./trusted-objective.contract.js";
import { TrustedObjectiveController } from "./trusted-objective.controller.js";
import type { TrustedObjectiveRequest } from "./trusted-objective.guard.js";
import {
  TrustedObjectiveRuntime,
  deriveEvidenceCandidate,
  stableKey
} from "./trusted-objective.runtime.js";

const initiativeId = "70000000-0000-7000-8000-000000000204";

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
      exactExcerpt: "reduce response time"
    });
    await controller.accept(request(), initiativeId, {});
    await expect(controller.draftConfirmation(request(), initiativeId, {})).resolves.toEqual({
      question: "Confirm?",
      sent: false,
      status: "Not sent"
    });
    expect(runtime.capture).toHaveBeenCalledWith(expect.any(Object), initiativeId, "Exact note");
    expect(runtime.propose).toHaveBeenCalledWith(expect.any(Object), initiativeId, {
      objective: "Reduce response time.",
      exactExcerpt: "reduce response time"
    });
    expect(runtime.accept).toHaveBeenCalledWith(expect.any(Object), initiativeId);
  });

  it("rejects browser-supplied hashes, authority, scope, and identities", async () => {
    for (const injected of [
      { sourceContentHash: "a".repeat(64) },
      { tenantId: "tenant" },
      { accessClass: "public" },
      { acceptedByUserId: "actor" }
    ]) {
      expect(() =>
        parseProposalBody({
          objective: "Reduce response time.",
          exactExcerpt: "reduce response time",
          ...injected
        })
      ).toThrow(TrustedObjectiveInputError);
    }
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
    expect(evidence).toMatchObject({
      startOffset: 40,
      endOffset: 59,
      excerpt: "twelve days to five",
      expectedSourceVersion: 1,
      expectedChunkVersion: 1
    });
    expect(evidence.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.excerptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses stable semantic command keys", () => {
    expect(stableKey("accept", initiativeId, "claim")).toBe(
      stableKey("accept", initiativeId, "claim")
    );
    expect(stableKey("accept", initiativeId, "claim")).not.toBe(
      stableKey("accept", initiativeId, "other")
    );
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
