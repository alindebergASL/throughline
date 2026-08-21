import "reflect-metadata";
import { HttpException } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { B2_TRUTH_PREDICATE_CATALOG_VERSION } from "@throughline/core-types";
import {
  B2AuthorizationError,
  B2CommandInvariantError,
  B2CommandValidationError,
  B2IdempotencyConflictError,
  parseB2Command,
  TruthLedgerConflictError,
  VerifiedClaimSourceSpanError
} from "@throughline/truth-ledger";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import { B2TruthController } from "./b2-truth.controller.js";
import { B2TruthGuard, type B2TruthRequest } from "./b2-truth.guard.js";
import { B2TruthRuntime } from "./b2-truth.runtime.js";

const subjectId = "70000000-0000-7000-8000-000000000101";
const sourceId = "70000000-0000-7000-8000-000000000102";
const chunkId = "70000000-0000-7000-8000-000000000103";
const claimId = "70000000-0000-7000-8000-000000000104";
const factId = "70000000-0000-7000-8000-000000000105";
const replacementClaimId = "70000000-0000-7000-8000-000000000106";

function request(idempotencyKey = "b2-request-key"): B2TruthRequest {
  return {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": idempotencyKey
    },
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

function supersedeBody() {
  return {
    factId,
    expectedFactVersion: 1,
    subject: { type: "activity", id: subjectId, expectedVersion: 1 },
    replacementClaims: [{ claimId: replacementClaimId, expectedVersion: 1 }],
    reason: {
      code: "newer_evidence",
      rationale: "Newer evidence replaces the accepted outcome."
    }
  };
}

function revokeBody() {
  return {
    factId,
    expectedFactVersion: 1,
    reason: {
      code: "no_longer_true",
      rationale: "The accepted outcome is no longer true."
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

  it.each([
    {
      name: "fact.supersede",
      invoke: (controller: B2TruthController, req: B2TruthRequest, body: Record<string, unknown>) =>
        controller.supersedeFact(req, body),
      body: supersedeBody(),
      result: {
        factId,
        version: 2,
        status: "superseded",
        replacementFactId: "70000000-0000-7000-8000-000000000107",
        replacementFactVersion: 1,
        replacementFactStatus: "current"
      }
    },
    {
      name: "fact.revoke",
      invoke: (controller: B2TruthController, req: B2TruthRequest, body: Record<string, unknown>) =>
        controller.revokeFact(req, body),
      body: revokeBody(),
      result: { factId, version: 2, status: "revoked" }
    }
  ])(
    "constructs fixed $name metadata from the request and preserves the exact body",
    async (test) => {
      const execute = vi.fn(
        async (
          _command: {
            kind: string;
            idempotencyKey: string;
            predicateCatalogVersion: string;
            payload: unknown;
          },
          _context: unknown
        ) => {
          void _command;
          void _context;
          return test.result;
        }
      );
      const controller = new B2TruthController({ execute } as unknown as B2TruthRuntime);
      const req = request(`${test.name}-key`);
      const context = req.b2Context;

      await expect(test.invoke(controller, req, test.body)).resolves.toBe(test.result);
      expect(execute).toHaveBeenCalledOnce();
      const [command, receivedContext] = execute.mock.calls[0]!;
      expect(command).toEqual({
        kind: test.name,
        idempotencyKey: `${test.name}-key`,
        predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
        payload: test.body
      });
      expect(command.payload).toBe(test.body);
      expect(receivedContext).toBe(context);
    }
  );

  it("registers both routes and admits only trusted JSON at the real Fastify boundary", async () => {
    vi.stubEnv("AUTH_ADAPTER", "dev");
    const execute = vi.fn(async (command: { kind: string }) =>
      command.kind === "fact.supersede"
        ? {
            factId,
            version: 2,
            status: "superseded",
            replacementFactId: "70000000-0000-7000-8000-000000000107",
            replacementFactVersion: 1,
            replacementFactStatus: "current"
          }
        : { factId, version: 2, status: "revoked" }
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [B2TruthController],
      providers: [B2TruthGuard, { provide: B2TruthRuntime, useValue: { execute } }]
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    const headers = {
      "x-throughline-dev-identity": "tenant-a-owner",
      "x-request-id": "controller-http",
      "idempotency-key": "controller-http"
    };
    try {
      const accepted = [
        "application/json",
        "application/json; charset=utf-8",
        'application/json;charset="utf-8"',
        'Application/JSON; Charset="UTF-8"',
        "application/json ; charset = utf-8",
        ' application/json ; charset = "utf-8" '
      ];
      for (const [index, contentType] of accepted.entries()) {
        const supersede = index % 2 === 0;
        const response = await app.inject({
          method: "POST",
          url: supersede ? "/internal/v1/facts/supersede" : "/internal/v1/facts/revoke",
          headers: {
            ...headers,
            "content-type": contentType,
            "idempotency-key": `controller-http-accepted-${index}`
          },
          payload: supersede ? supersedeBody() : revokeBody()
        });
        expect(response.statusCode, `${contentType}: ${response.body}`).toBe(201);
      }
      expect(execute).toHaveBeenCalledTimes(accepted.length);

      execute.mockClear();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/v1/facts/revoke",
        headers,
        payload: JSON.stringify(revokeBody())
      });
      expect(missing.statusCode, missing.body).toBe(415);
      expect(missing.json()).toEqual({
        message: "Unsupported Media Type",
        statusCode: 415
      });
      expect(execute).not.toHaveBeenCalled();

      const rejected = [
        "text/plain",
        "application/json; charset=iso-8859-1",
        'application/json; charset="utf-16"',
        "application/json; charset=utf-8; charset=utf-8",
        "application/json; profile=example",
        "application/json; charset=utf-8; profile=example"
      ];
      for (const [index, contentType] of rejected.entries()) {
        const supersede = index % 2 === 0;
        const response = await app.inject({
          method: "POST",
          url: supersede ? "/internal/v1/facts/supersede" : "/internal/v1/facts/revoke",
          headers: {
            ...headers,
            "content-type": contentType,
            "idempotency-key": `controller-http-rejected-${index}`
          },
          payload: supersede ? supersedeBody() : revokeBody()
        });
        expect(response.statusCode, `${contentType}: ${response.body}`).toBe(400);
        expect(response.json()).toEqual({
          message: "Request is invalid",
          error: "Bad Request",
          statusCode: 400
        });
      }
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      name: "supersede hidden key",
      invoke: (controller: B2TruthController, body: Record<string, unknown>) =>
        controller.supersedeFact(request("hidden-supersede"), body),
      body: () => {
        const body = supersedeBody();
        Object.defineProperty(body, "actorUserId", {
          value: subjectId,
          enumerable: false
        });
        return body;
      }
    },
    {
      name: "revoke symbol key",
      invoke: (controller: B2TruthController, body: Record<string, unknown>) =>
        controller.revokeFact(request("symbol-revoke"), body),
      body: () => Object.assign(revokeBody(), { [Symbol("actor")]: subjectId })
    }
  ])("preserves and rejects a $name through the canonical parser seam", async (test) => {
    const mutation = vi.fn();
    const controller = new B2TruthController({
      execute: async (command: unknown) => {
        const parsed = parseB2Command(command);
        mutation(parsed);
        return {};
      }
    } as unknown as B2TruthRuntime);

    await expect(test.invoke(controller, test.body())).rejects.toMatchObject({ status: 400 });
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each([
    [
      "supersede",
      (controller: B2TruthController, body: Record<string, unknown>) =>
        controller.supersedeFact(request("extra-supersede"), body),
      supersedeBody
    ],
    [
      "revoke",
      (controller: B2TruthController, body: Record<string, unknown>) =>
        controller.revokeFact(request("extra-revoke"), body),
      revokeBody
    ]
  ] as const)(
    "rejects caller-supplied metadata in the %s body without mutation",
    async (_name, invoke, createBody) => {
      const mutation = vi.fn();
      const controller = new B2TruthController({
        execute: async (command: unknown) => {
          const parsed = parseB2Command(command);
          mutation(parsed);
          return {};
        }
      } as unknown as B2TruthRuntime);
      const forbiddenKeys = [
        "kind",
        "predicateCatalogVersion",
        "actorUserId",
        "actorMembershipId",
        "tenantId",
        "workspaceId",
        "spaceId",
        "policyVersion",
        "authorityBasis",
        "idempotencyKey",
        "safeResponse",
        "audit",
        "outbox"
      ];

      for (const key of forbiddenKeys) {
        await expect(
          invoke(controller, { ...createBody(), [key]: "caller-controlled" })
        ).rejects.toMatchObject({ status: 400 });
      }
      expect(mutation).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "supersede",
      (controller: B2TruthController, req: B2TruthRequest) =>
        controller.supersedeFact(req, supersedeBody())
    ],
    [
      "revoke",
      (controller: B2TruthController, req: B2TruthRequest) =>
        controller.revokeFact(req, revokeBody())
    ]
  ] as const)(
    "rejects an invalid lifecycle Idempotency-Key before the %s runtime",
    async (_name, invoke) => {
      const execute = vi.fn();
      const controller = new B2TruthController({ execute } as unknown as B2TruthRuntime);

      for (const key of ["", "bad\nkey", "x".repeat(201)]) {
        await expect(invoke(controller, request(key))).rejects.toMatchObject({ status: 400 });
      }
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it.each([
    [new B2CommandValidationError(), 400, "Request is invalid"],
    [new B2AuthorizationError(), 404, "Resource unavailable"],
    [new VerifiedClaimSourceSpanError(), 404, "Resource unavailable"],
    [new TruthLedgerConflictError(), 409, "Command precondition failed"],
    [new B2IdempotencyConflictError(), 409, "Command precondition failed"],
    [new B2CommandInvariantError(), 409, "Command precondition failed"],
    [new Error(`infrastructure ${factId}`), 500, "Request could not be completed"]
  ])("maps lifecycle failure %# generically", async (failure, status, message) => {
    const controller = new B2TruthController({
      execute: vi.fn(async () => {
        throw failure;
      })
    } as unknown as B2TruthRuntime);

    const response = await controllerFailure(() =>
      controller.revokeFact(request("mapped-revoke"), revokeBody())
    );
    expect(response.getStatus()).toBe(status);
    expect(response.getResponse()).toMatchObject({ statusCode: status, message });
    expect(JSON.stringify(response.getResponse())).not.toContain(factId);
    expect(JSON.stringify(response.getResponse())).not.toContain(failure.message);
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
