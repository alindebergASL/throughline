import { HttpException } from "@nestjs/common";
import { B2_TRUTH_PREDICATE_CATALOG_VERSION } from "@throughline/core-types";
import {
  B2AuthorizationError,
  B2CommandValidationError,
  B2IdempotencyConflictError,
  TruthLedgerConflictError,
  VerifiedClaimSourceSpanError
} from "@throughline/truth-ledger";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import { B2TruthController } from "./b2-truth.controller.js";
import type { B2TruthRequest } from "./b2-truth.guard.js";
import type { B2TruthRuntime } from "./b2-truth.runtime.js";

const subjectId = "70000000-0000-7000-8000-000000000101";
const sourceId = "70000000-0000-7000-8000-000000000102";
const chunkId = "70000000-0000-7000-8000-000000000103";
const claimId = "70000000-0000-7000-8000-000000000104";
const factId = "70000000-0000-7000-8000-000000000105";

function request(idempotencyKey = "b2-request-key"): B2TruthRequest {
  return {
    headers: { "idempotency-key": idempotencyKey },
    b2Context: createDevSecurityContext("tenant-a-owner")
  };
}

function claimBody() {
  return {
    subject: { type: "activity", id: subjectId, expectedVersion: 1 },
    predicate: "activity.outcome",
    valueJson: "Approved the governed discovery outcome.",
    normalizedText: "Approved the governed discovery outcome.",
    confidence: "strong",
    evidence: {
      sourceArtifactId: sourceId,
      sourceChunkId: chunkId,
      expectedSourceVersion: 1,
      expectedChunkVersion: 1,
      normalizationVersion: "source-normalization.v1",
      chunkingVersion: "source-chunking.v1",
      startOffset: 0,
      endOffset: 8,
      excerpt: "Approved",
      sourceContentHash: "a".repeat(64),
      sourceNormalizedContentHash: "b".repeat(64),
      chunkContentHash: "c".repeat(64),
      excerptHash: "d".repeat(64)
    }
  };
}

describe("B2TruthController", () => {
  it("submits claim.create through the canonical command facade", async () => {
    const execute = vi.fn(async () => ({ claimId, version: 1, status: "proposed" }));
    const controller = new B2TruthController({ execute } as unknown as B2TruthRuntime);

    await expect(controller.createClaim(request(), claimBody())).resolves.toEqual({
      claimId,
      version: 1,
      status: "proposed"
    });
    expect(execute).toHaveBeenCalledWith(
      {
        kind: "claim.create",
        idempotencyKey: "b2-request-key",
        predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
        payload: claimBody()
      },
      expect.objectContaining({ actorMembershipId: expect.any(String) })
    );
  });

  it("submits fact.accept and never exposes a claim.propose alias", async () => {
    const execute = vi.fn(async () => ({
      factId,
      version: 1,
      status: "current",
      acceptedClaimIds: [claimId]
    }));
    const controller = new B2TruthController({ execute } as unknown as B2TruthRuntime);
    const body = {
      subject: { type: "activity", id: subjectId, expectedVersion: 1 },
      claims: [{ claimId, expectedVersion: 1 }],
      expectedCurrentFactId: null,
      acceptanceScope: "engagement"
    };

    await controller.acceptFact(request("accept-key"), body);
    expect(execute).toHaveBeenCalledWith(
      {
        kind: "fact.accept",
        idempotencyKey: "accept-key",
        predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
        payload: body
      },
      expect.any(Object)
    );
    expect(JSON.stringify(execute.mock.calls)).not.toContain("claim.propose");
  });

  it.each(["", "bad\nkey", "x".repeat(201)])(
    "rejects an invalid Idempotency-Key before the runtime",
    async (key) => {
      const execute = vi.fn();
      const controller = new B2TruthController({ execute } as unknown as B2TruthRuntime);
      await expect(controller.createClaim(request(key), claimBody())).rejects.toMatchObject({
        status: 400
      });
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("maps stale/idempotency conflicts to one generic non-disclosing conflict", async () => {
    const failures = [new TruthLedgerConflictError(), new B2IdempotencyConflictError()];
    const responses = [];
    for (const failure of failures) {
      const controller = new B2TruthController({
        execute: vi.fn(async () => {
          throw failure;
        })
      } as unknown as B2TruthRuntime);
      responses.push(await controllerFailure(() => controller.createClaim(request(), claimBody())));
    }
    expect(
      responses.map((response) => ({
        status: response.getStatus(),
        body: response.getResponse()
      }))
    ).toEqual([
      {
        status: 409,
        body: {
          error: "Conflict",
          message: "Command precondition failed",
          statusCode: 409
        }
      },
      {
        status: 409,
        body: {
          error: "Conflict",
          message: "Command precondition failed",
          statusCode: 409
        }
      }
    ]);
  });

  it("makes malformed, fabricated, inaccessible, cross-scope, and missing evidence outwardly identical", async () => {
    const failures = [
      new B2CommandValidationError(),
      new VerifiedClaimSourceSpanError(),
      new B2AuthorizationError(),
      new VerifiedClaimSourceSpanError(),
      new B2AuthorizationError()
    ];
    const responses = [];
    for (const failure of failures) {
      const controller = new B2TruthController({
        execute: vi.fn(async () => {
          throw failure;
        })
      } as unknown as B2TruthRuntime);
      responses.push(await controllerFailure(() => controller.createClaim(request(), claimBody())));
    }
    const publicResults = responses.map((response) => ({
      status: response.getStatus(),
      body: response.getResponse()
    }));
    for (const result of publicResults.slice(1)) expect(result).toEqual(publicResults[0]);
    expect(publicResults[0]).toEqual({
      status: 404,
      body: {
        error: "Not Found",
        message: "Resource unavailable",
        statusCode: 404
      }
    });
    expect(JSON.stringify(publicResults)).not.toContain(sourceId);
  });
});

async function controllerFailure(callback: () => Promise<unknown>): Promise<HttpException> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error("Expected controller request to fail");
}
