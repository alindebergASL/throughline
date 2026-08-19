import { HttpException } from "@nestjs/common";
import { normalizeAndChunkSource } from "@throughline/content";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import {
  TrustedObjectiveConflictError,
  TrustedObjectiveInputError,
  TrustedObjectiveUnavailableError,
  parseAcceptBody,
  parseProposalBody,
  parseRevokeBody,
  parseReworkBody,
  parseSupersedeBody,
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
      supersede: vi.fn(async () => ({ state: "accepted" })),
      revoke: vi.fn(async () => ({ state: "revoked" })),
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
    await (
      controller as unknown as {
        supersede(
          request: TrustedObjectiveRequest,
          initiativeId: string,
          body: unknown
        ): Promise<unknown>;
      }
    ).supersede(request(), initiativeId, {
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "accepted_value_changed",
      rationale: "The engagement established a replacement primary objective."
    });
    await (
      controller as unknown as {
        revoke(
          request: TrustedObjectiveRequest,
          initiativeId: string,
          body: unknown
        ): Promise<unknown>;
      }
    ).revoke(request(), initiativeId, {
      factId: "70000000-0000-7000-8000-000000000502",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The initiative no longer has an accepted primary objective."
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
    expect(runtime.supersede).toHaveBeenCalledWith(expect.any(Object), initiativeId, {
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "accepted_value_changed",
      rationale: "The engagement established a replacement primary objective."
    });
    expect(runtime.revoke).toHaveBeenCalledWith(expect.any(Object), initiativeId, {
      factId: "70000000-0000-7000-8000-000000000502",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The initiative no longer has an accepted primary objective."
    });
  });

  it("rejects extra lifecycle identity, authority, context, command, and idempotency fields before runtime", async () => {
    const runtime = { supersede: vi.fn(), revoke: vi.fn() };
    const controller = new TrustedObjectiveController(runtime as never) as unknown as {
      supersede(
        request: TrustedObjectiveRequest,
        initiativeId: string,
        body: unknown
      ): Promise<unknown>;
      revoke(
        request: TrustedObjectiveRequest,
        initiativeId: string,
        body: unknown
      ): Promise<unknown>;
    };
    const supersede = {
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "newer_evidence",
      rationale: "New evidence supports the replacement objective."
    };
    const revoke = {
      factId: "70000000-0000-7000-8000-000000000502",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The objective is no longer accepted as current."
    };

    for (const injected of [
      { actorUserId: "70000000-0000-7000-8000-000000000001" },
      { persona: "owner" },
      { tenantId: "70000000-0000-7000-8000-000000000101" },
      { workspaceId: "70000000-0000-7000-8000-000000000102" },
      { spaceId: "70000000-0000-7000-8000-000000000103" },
      { authorityBasis: "initiative_owner" },
      { kind: "fact.supersede" },
      { predicateCatalogVersion: "truth-predicate-catalog.v1" },
      { accessClass: "public" },
      { audit: {} },
      { outbox: {} },
      { idempotencyKey: "browser-owned" }
    ]) {
      await expect(
        failureResponse(() =>
          controller.supersede(request(), initiativeId, { ...supersede, ...injected })
        )
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        failureResponse(() =>
          controller.revoke(request(), initiativeId, { ...revoke, ...injected })
        )
      ).resolves.toMatchObject({ status: 400 });
    }
    expect(runtime.supersede).not.toHaveBeenCalled();
    expect(runtime.revoke).not.toHaveBeenCalled();
  });

  it("rejects exotic lifecycle objects that cannot originate from exact JSON", () => {
    const revoke = {
      factId: "70000000-0000-7000-8000-000000000502",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The objective is no longer accepted as current."
    };
    const inherited = Object.assign(Object.create({ tenantId: "inherited" }), revoke);
    const nonEnumerable = { ...revoke };
    Object.defineProperty(nonEnumerable, "rationale", {
      value: revoke.rationale,
      enumerable: false
    });
    const symbolKeyed = { ...revoke, [Symbol("authority")]: "browser-owned" };
    const prototypeKeyed = JSON.parse(
      '{"factId":"70000000-0000-7000-8000-000000000502","expectedFactVersion":1,"reasonCode":"no_longer_true","rationale":"The objective is no longer accepted as current.","__proto__":{"polluted":true}}'
    );

    expect(() => parseRevokeBody(inherited)).toThrow(TrustedObjectiveInputError);
    expect(() => parseRevokeBody(nonEnumerable)).toThrow(TrustedObjectiveInputError);
    expect(() => parseRevokeBody(symbolKeyed)).toThrow(TrustedObjectiveInputError);
    expect(() => parseRevokeBody(prototypeKeyed)).toThrow(TrustedObjectiveInputError);
    expect(() =>
      parseSupersedeBody({
        factId: "70000000-0000-7000-8000-000000000501",
        expectedFactVersion: 1,
        replacementClaimId: "70000000-0000-7000-8000-000000000402",
        expectedReplacementClaimVersion: 1,
        expectedInitiativeVersion: 2,
        reasonCode: "accepted_value_changed",
        rationale: "The accepted objective changed.",
        [Symbol("authority")]: "browser-owned"
      })
    ).toThrow(TrustedObjectiveInputError);
  });

  it("keeps stale lifecycle mutations generic conflicts", async () => {
    const controller = new TrustedObjectiveController({
      revoke: vi.fn(async () => {
        throw new TrustedObjectiveConflictError();
      })
    } as never) as unknown as {
      revoke(
        request: TrustedObjectiveRequest,
        initiativeId: string,
        body: unknown
      ): Promise<unknown>;
    };

    await expect(
      failureResponse(() =>
        controller.revoke(request(), initiativeId, {
          factId: "70000000-0000-7000-8000-000000000502",
          expectedFactVersion: 1,
          reasonCode: "no_longer_true",
          rationale: "The objective is no longer accepted as current."
        })
      )
    ).resolves.toEqual({
      status: 409,
      body: { statusCode: 409, message: "Command precondition failed", error: "Conflict" }
    });
  });

  it("binds revoke to the path Initiative's currently projected Fact before the command bus", async () => {
    const runtime = new TrustedObjectiveRuntime();
    const execute = vi.fn();
    const factForPath = "70000000-0000-7000-8000-000000000501";
    const seam = runtime as unknown as Record<string, ReturnType<typeof vi.fn>>;
    seam.read = vi.fn(async (_context, callback: (tx: object) => Promise<unknown>) => callback({}));
    seam.readScope = vi.fn(async () => ({ initiativeId }));
    seam.readAcceptedMemory = vi.fn(async () => ({ factId: factForPath }));
    seam.truthCommandBus = vi.fn(() => ({ execute }));

    await expect(
      runtime.revoke(createDevSecurityContext("tenant-a-owner"), initiativeId, {
        factId: "70000000-0000-7000-8000-000000000599",
        expectedFactVersion: 1,
        reasonCode: "no_longer_true",
        rationale: "The objective is no longer accepted as current."
      })
    ).rejects.toBeInstanceOf(TrustedObjectiveUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows a rendered post-revocation proposal through ordinary fact.accept", async () => {
    const runtime = new TrustedObjectiveRuntime();
    const execute = vi.fn(async () => ({}));
    const claimId = "70000000-0000-7000-8000-000000000402";
    const seam = runtime as unknown as Record<string, ReturnType<typeof vi.fn>>;
    seam.read = vi.fn(async (_context, callback: (tx: object) => Promise<unknown>) => callback({}));
    seam.readScope = vi.fn(async () => ({ initiativeId, initiativeVersion: 2 }));
    seam.requireCurrentSource = vi.fn(async () => ({}));
    seam.readAcceptedMemory = vi.fn(async () => null);
    seam.readLifecycleHistory = vi.fn(async () => [
      {
        factId: "70000000-0000-7000-8000-000000000501",
        availability: "redacted",
        objective: null,
        status: "Revoked",
        transition: "Accepted → Revoked",
        acceptedAt: "2026-08-01T00:00:00.000Z",
        changedAt: "2026-08-02T00:00:00.000Z"
      }
    ]);
    seam.readOnlyValidClaim = vi.fn(async (_tx, _context, _scope, _source, status) =>
      status === "proposed" ? { id: claimId, version: 1 } : null
    );
    seam.truthCommandBus = vi.fn(() => ({ execute }));
    vi.spyOn(runtime, "getState").mockResolvedValue({ state: "accepted" } as never);

    await expect(
      runtime.accept(createDevSecurityContext("tenant-a-owner"), initiativeId, {
        claimId,
        expectedClaimVersion: 1,
        expectedInitiativeVersion: 2
      })
    ).resolves.toMatchObject({ state: "accepted" });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "fact.accept" }),
      expect.any(Object)
    );
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
  it("keeps accepted A current while replacement B is proposed with exact evidence and an A to B preview", async () => {
    const runtime = new TrustedObjectiveRuntime();
    const accepted = {
      factId: "70000000-0000-7000-8000-000000000501",
      version: 1,
      supportingClaimId: "70000000-0000-7000-8000-000000000401",
      objective: "Objective A",
      status: "Accepted",
      exactExcerpt: "evidence for A",
      sourceTitle: "Engagement note",
      whyBelieved: "Accepted from exact evidence.",
      transition: "Proposed → Accepted",
      acceptedBy: "Owner A",
      acceptedAt: "2026-08-01T00:00:00.000Z",
      effectiveVisibility: "Workspace"
    };
    const replacement = {
      id: "70000000-0000-7000-8000-000000000402",
      version: 1,
      status: "proposed",
      objective: "Objective B",
      exactExcerpt: "exact evidence for B",
      sourceTitle: "Engagement note",
      accessClass: "workspace",
      createdByUserId: "70000000-0000-7000-8000-000000000001",
      createdByMembershipId: "70000000-0000-7000-8000-000000000002",
      supportConfirmed: true
    };
    const source = {
      projection: normalizeSourceFixture({
        id: "70000000-0000-7000-8000-000000000301",
        version: 1,
        immutableText: "evidence for A and exact evidence for B",
        accessClass: "workspace"
      }),
      createdAt: "2026-08-01T00:00:00.000Z"
    };
    const scope = {
      initiativeId,
      initiativeVersion: 2,
      initiativeTitle: "Initiative",
      initiativeSpaceId: "70000000-0000-7000-8000-000000000201",
      initiativeAccessClass: "workspace",
      organizationId: "70000000-0000-7000-8000-000000000202",
      organizationName: "Organization",
      activityId: "70000000-0000-7000-8000-000000000203",
      activityTitle: "Engagement"
    };
    const acceptedLineage = [
      {
        predecessorClaimId: "70000000-0000-7000-8000-000000000399",
        successorClaimId: accepted.supportingClaimId,
        disposition: "reworked" as const,
        reasonCode: "reworked" as const,
        reworkedAt: "2026-07-31T00:00:00.000Z"
      }
    ];
    const replacementLineage = [
      {
        predecessorClaimId: "70000000-0000-7000-8000-000000000400",
        successorClaimId: replacement.id,
        disposition: "reworked" as const,
        reasonCode: "reworked" as const,
        reworkedAt: "2026-08-02T00:00:00.000Z"
      }
    ];
    const seam = runtime as unknown as Record<string, ReturnType<typeof vi.fn>>;
    seam.read = vi.fn(async (_context, callback: (tx: object) => Promise<unknown>) => callback({}));
    seam.readScope = vi.fn(async () => scope);
    seam.readLatestPrimaryObjectiveClaim = vi.fn(async () => ({
      id: replacement.id,
      version: 1,
      status: "proposed"
    }));
    seam.isAllowed = vi.fn(async () => true);
    seam.readCurrentSource = vi.fn(async () => source);
    seam.readAcceptedMemory = vi.fn(async () => accepted);
    seam.readOnlyValidClaim = vi.fn(async () => replacement);
    seam.readReworkLineage = vi.fn(async (_tx, _context, _scope, claimId) =>
      claimId === accepted.supportingClaimId ? acceptedLineage : replacementLineage
    );
    seam.readLifecycleHistory = vi.fn(async () => []);

    const state = await runtime.getState(createDevSecurityContext("tenant-a-owner"), initiativeId);

    expect(state).toMatchObject({
      state: "accepted",
      acceptedMemory: { factId: accepted.factId, objective: "Objective A", canRevoke: false },
      proposal: {
        claimId: replacement.id,
        objective: "Objective B",
        exactExcerpt: "exact evidence for B"
      },
      replacementReview: {
        currentFactId: accepted.factId,
        replacementClaimId: replacement.id,
        exactExcerpt: "exact evidence for B",
        changePreview: { from: "Objective A", to: "Objective B" },
        reworkLineage: replacementLineage
      },
      reworkLineage: acceptedLineage,
      history: []
    });
    expect(state.reworkLineage).toEqual(acceptedLineage);
    expect(state.replacementReview?.reworkLineage).toEqual(replacementLineage);
  });

  it("advertises revoke only when a standalone accepted Fact is authorized", async () => {
    const runtime = new TrustedObjectiveRuntime();
    const accepted = {
      factId: "70000000-0000-7000-8000-000000000501",
      version: 1,
      supportingClaimId: "70000000-0000-7000-8000-000000000401",
      objective: "Objective A",
      status: "Accepted",
      exactExcerpt: "evidence for A",
      sourceTitle: "Engagement note",
      whyBelieved: "Accepted from exact evidence.",
      transition: "Proposed → Accepted",
      acceptedBy: "Owner A",
      acceptedAt: "2026-08-01T00:00:00.000Z",
      effectiveVisibility: "Workspace"
    };
    const scope = {
      initiativeId,
      initiativeVersion: 2,
      initiativeTitle: "Initiative",
      initiativeSpaceId: "70000000-0000-7000-8000-000000000201",
      initiativeAccessClass: "workspace",
      organizationId: "70000000-0000-7000-8000-000000000202",
      organizationName: "Organization",
      activityId: "70000000-0000-7000-8000-000000000203",
      activityTitle: "Engagement"
    };
    const seam = runtime as unknown as Record<string, ReturnType<typeof vi.fn>>;
    seam.read = vi.fn(async (_context, callback: (tx: object) => Promise<unknown>) => callback({}));
    seam.readScope = vi.fn(async () => scope);
    seam.readLatestPrimaryObjectiveClaim = vi.fn(async () => ({
      id: accepted.supportingClaimId,
      version: 1,
      status: "accepted"
    }));
    seam.isAllowed = vi.fn(async (_tx, _context, action) => action === "fact.revoke");
    seam.readCurrentSource = vi.fn(async () => null);
    seam.readAcceptedMemory = vi.fn(async () => accepted);
    seam.readOnlyValidClaim = vi.fn(async () => null);
    seam.readReworkLineage = vi.fn(async () => []);
    seam.readLifecycleHistory = vi.fn(async () => []);

    const state = await runtime.getState(createDevSecurityContext("tenant-a-owner"), initiativeId);

    expect(state).toMatchObject({
      state: "accepted",
      acceptedMemory: { factId: accepted.factId, canRevoke: true },
      proposal: null,
      replacementReview: null
    });
    expect(seam.isAllowed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "fact.revoke",
      "fact",
      accepted.factId
    );
  });
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
    (runtime as unknown as { authorization: object }).authorization = {
      canInTransaction: vi.fn(async () => ({ allowed: true }))
    };
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

  it("does not materialize inaccessible Claim, evidence, or lifecycle detail before authorization", async () => {
    const claimId = "70000000-0000-7000-8000-000000000402";
    const factId = "70000000-0000-7000-8000-000000000501";
    const predecessorFactId = "70000000-0000-7000-8000-000000000500";
    const runtime = new TrustedObjectiveRuntime();
    const canInTransaction = vi.fn(async () => ({ allowed: false }));
    (runtime as unknown as { authorization: object }).authorization = { canInTransaction };

    const latestQuery = vi.fn(async () => ({ rows: [{ id: claimId }] }));
    await expect(
      (
        runtime as unknown as {
          readLatestPrimaryObjectiveClaim(
            tx: object,
            context: object,
            scope: object
          ): Promise<unknown>;
        }
      ).readLatestPrimaryObjectiveClaim(
        { query: latestQuery },
        createDevSecurityContext("tenant-a-owner"),
        { initiativeId }
      )
    ).resolves.toBeNull();
    expect(latestQuery).toHaveBeenCalledTimes(1);

    const evidenceQuery = vi.fn();
    await expect(
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
        { query: evidenceQuery },
        createDevSecurityContext("tenant-a-owner"),
        { initiativeAccessClass: "workspace" },
        { projection: {}, createdAt: "2026-08-01T00:00:00.000Z" },
        claimId,
        "proposed"
      )
    ).resolves.toBeNull();
    expect(evidenceQuery).not.toHaveBeenCalled();

    const historyQuery = vi.fn(async () => ({
      rows: [{ predecessor_fact_id: predecessorFactId }]
    }));
    await expect(
      (
        runtime as unknown as {
          readLifecycleHistory(
            tx: object,
            context: object,
            scope: object,
            current: object
          ): Promise<unknown>;
        }
      ).readLifecycleHistory(
        { query: historyQuery },
        createDevSecurityContext("tenant-a-owner"),
        { initiativeId },
        { factId }
      )
    ).rejects.toBeInstanceOf(TrustedObjectiveUnavailableError);
    expect(historyQuery).toHaveBeenCalledTimes(1);
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
