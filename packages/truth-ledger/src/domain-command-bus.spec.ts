import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import type { B2AuthorizedDomainCommand, SecurityContext } from "@throughline/core-types";
import {
  DomainCommandRepository,
  type PgPool,
  type PgPoolClient,
  type TenantDbTransaction
} from "@throughline/db";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2AuthorizationError, TruthLedgerDomainCommandBus } from "./domain-command-bus.js";
import { TruthLedgerConflictError, TruthLedgerRepository } from "./repository.js";
import { VerifiedClaimSourceSpanAdmission } from "./source-span.js";

const id = (suffix: string) => `0190a000-0000-7000-8000-${suffix.padStart(12, "0")}`;
const spaceId = id("3");

describe.sequential("durable truth command boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not execute dormant PR 1 lifecycle command contracts", async () => {
    const pool = transactionPool(true).pool;
    const command = {
      kind: "fact.revoke",
      idempotencyKey: "future-command",
      predicateCatalogVersion: "truth-predicate-catalog.v1",
      payload: {
        factId: id("20"),
        expectedFactVersion: 1,
        reason: { code: "no_longer_true", rationale: "The statement changed." }
      }
    } as unknown as B2AuthorizedDomainCommand<"claim.create">;

    await expect(new TruthLedgerDomainCommandBus(pool).execute(command, context())).rejects.toThrow(
      "B2 command request is invalid"
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a stale subject version before authorization or mutation", async () => {
    const { pool, client } = transactionPool(true);
    vi.spyOn(TruthLedgerRepository.prototype, "getSubjectScope").mockResolvedValue({
      subjectType: "activity",
      subjectId: id("4"),
      spaceId,
      accessClass: "workspace",
      version: 3
    });
    const insert = vi.spyOn(TruthLedgerRepository.prototype, "insertEvidenceAndClaim");
    const auth = authorization(true);

    await expect(
      new TruthLedgerDomainCommandBus(pool, auth).execute(claimCommand(2), context())
    ).rejects.toEqual(new TruthLedgerConflictError());

    expect(auth.canInTransaction).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("uses the same non-disclosing error for missing and denied subject authority", async () => {
    const missing = await captureError(
      new TruthLedgerDomainCommandBus(transactionPool(false).pool, authorization(true)).execute(
        claimCommand(3),
        context()
      )
    );
    vi.spyOn(TruthLedgerRepository.prototype, "getSubjectScope").mockResolvedValue({
      subjectType: "activity",
      subjectId: id("4"),
      spaceId,
      accessClass: "workspace",
      version: 3
    });
    const denied = await captureError(
      new TruthLedgerDomainCommandBus(transactionPool(true).pool, authorization(false)).execute(
        claimCommand(3),
        context()
      )
    );

    expect({ name: missing.name, message: missing.message }).toEqual({
      name: denied.name,
      message: denied.message
    });
    expect(denied).toEqual(new B2AuthorizationError());
  });

  it("fails closed when acceptance names prior truth that would require deferred lifecycle work", async () => {
    const { pool } = transactionPool(true);
    const baseline = factCommand();
    const command = {
      ...baseline,
      payload: { ...baseline.payload, expectedCurrentFactId: id("14") }
    } as unknown as B2AuthorizedDomainCommand<"fact.accept">;

    await expect(new TruthLedgerDomainCommandBus(pool).execute(command, context())).rejects.toThrow(
      "B2 command request is invalid"
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("reserves after subject authorization and replays before any Claim or source lock", async () => {
    const { pool } = transactionPool(true);
    vi.spyOn(TruthLedgerRepository.prototype, "getSubjectScope").mockResolvedValue({
      subjectType: "activity",
      subjectId: id("4"),
      spaceId,
      accessClass: "workspace",
      version: 3
    });
    const lockHeaders = vi
      .spyOn(TruthLedgerRepository.prototype, "lockClaimSupportHeaders")
      .mockResolvedValue([
        {
          claimId: id("10"),
          evidenceSpanId: id("11"),
          sourceArtifactId: id("5"),
          spaceId
        }
      ]);
    const loadClaims = vi
      .spyOn(TruthLedgerRepository.prototype, "loadClaimsForAcceptance")
      .mockResolvedValue([
        {
          claim: {
            id: id("10"),
            version: 2,
            tenantId: id("1"),
            workspaceId: id("2"),
            spaceId,
            subjectType: "activity",
            subjectId: id("4"),
            predicate: "activity.outcome",
            canonicalValue: "Outcome agreed",
            normalizedText: "Outcome agreed",
            assertedByType: "person",
            assertedById: id("9"),
            confidence: "strong",
            status: "accepted",
            accessClass: "workspace",
            createdAt: "2026-07-22T00:00:00.000Z"
          },
          evidence: claimCommand(3).payload.evidence,
          evidenceSpanId: id("11"),
          sourceArtifactId: id("5"),
          claimVersion: 2
        }
      ]);
    const admission = vi
      .spyOn(VerifiedClaimSourceSpanAdmission.prototype, "admit")
      .mockResolvedValue({} as never);
    const reserve = vi.spyOn(DomainCommandRepository.prototype, "reserve").mockResolvedValue({
      status: "replay",
      command: {
        id: id("12"),
        safeResponse: {
          factId: id("13"),
          version: 1,
          status: "current",
          acceptedClaimIds: [id("10")]
        },
        completedAt: new Date("2026-07-22T00:01:00.000Z")
      }
    });
    const auth = authorization(true);

    await expect(
      new TruthLedgerDomainCommandBus(pool, auth).execute(factCommand(), context())
    ).resolves.toEqual({
      factId: id("13"),
      version: 1,
      status: "current",
      acceptedClaimIds: [id("10")]
    });
    expect(auth.canInTransaction).toHaveBeenCalledOnce();
    expect(auth.canInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      "fact.accept",
      { type: "activity", id: id("4") },
      expect.anything(),
      { lockAuthority: true }
    );
    expect(vi.mocked(auth.canInTransaction).mock.invocationCallOrder[0]).toBeLessThan(
      reserve.mock.invocationCallOrder[0]!
    );
    expect(lockHeaders).not.toHaveBeenCalled();
    expect(loadClaims).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  });

  it("rolls back an early Fact reservation when downstream Claim locking fails", async () => {
    const { pool, client } = transactionPool(true);
    vi.spyOn(TruthLedgerRepository.prototype, "getSubjectScope").mockResolvedValue({
      subjectType: "activity",
      subjectId: id("4"),
      spaceId,
      accessClass: "workspace",
      version: 3
    });
    const auth = authorization(true);
    const reserve = vi
      .spyOn(DomainCommandRepository.prototype, "reserve")
      .mockImplementation(async (input) => ({ status: "reserved", commandId: input.id }));
    const lockHeaders = vi
      .spyOn(TruthLedgerRepository.prototype, "lockClaimSupportHeaders")
      .mockRejectedValue(new Error("simulated Claim lock failure"));

    await expect(
      new TruthLedgerDomainCommandBus(pool, auth).execute(factCommand(), context())
    ).rejects.toEqual(new B2AuthorizationError());

    expect(vi.mocked(auth.canInTransaction).mock.invocationCallOrder[0]).toBeLessThan(
      reserve.mock.invocationCallOrder[0]!
    );
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      lockHeaders.mock.invocationCallOrder[0]!
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("locks mutable source and authority rows without locking immutable evidence rows", async () => {
    const statements: string[] = [];
    const governingInitiativeId = id("15");
    const tx = {
      client: {} as TenantDbTransaction["client"],
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes("FROM work.initiatives subject")) {
          return { rows: [{ space_id: spaceId, access_class: "workspace", version: 1 }] };
        }
        if (sql.includes("JOIN work.activity_sources activity_source")) {
          return {
            rows: [
              {
                id: id("5"),
                space_id: spaceId,
                access_class: "workspace",
                version: 1,
                deleted_at: null,
                immutable_text: "Outcome",
                content_hash: "a".repeat(64),
                normalized_content_hash: "b".repeat(64),
                normalization_version: "source-normalization.v1",
                chunking_version: "source-chunking.v1",
                space_access_class: "workspace",
                activity_id: id("4"),
                governing_initiative_id: governingInitiativeId
              }
            ]
          };
        }
        if (sql.includes("supersedes_source_id")) return { rows: [] };
        if (sql.includes("FROM content.source_chunks")) {
          return {
            rows: [
              {
                id: id("6"),
                source_artifact_id: id("5"),
                space_id: spaceId,
                normalization_version: "source-normalization.v1",
                chunking_version: "source-chunking.v1",
                chunk_index: 0,
                start_offset: 0,
                end_offset: 7,
                normalized_text: "Outcome",
                content_hash: "c".repeat(64),
                access_class: "workspace"
              }
            ]
          };
        }
        throw new Error(`Unexpected evidence snapshot query: ${sql}`);
      }
    } as unknown as TenantDbTransaction;

    await new TruthLedgerRepository(tx).getAuthorizedClaimEvidenceSnapshot({
      tenantId: id("1"),
      workspaceId: id("2"),
      subjectType: "initiative",
      subjectId: governingInitiativeId,
      sourceArtifactId: id("5"),
      sourceChunkId: id("6")
    });

    expect(
      statements.map((statement) => statement.match(/FOR SHARE(?: OF [a-z_, ]+)?/)?.[0])
    ).toEqual([
      "FOR SHARE OF subject, space",
      "FOR SHARE OF source, activity, space",
      "FOR SHARE",
      undefined
    ]);
    expect(statements[1]).toContain("JOIN work.activity_sources activity_source");
    expect(statements[1]).not.toContain("FOR SHARE OF activity_source");
  });

  it("locks Claim and source lifecycle rows without locking immutable evidence or chunks", async () => {
    const repository = await readFile(new URL("./repository.ts", import.meta.url), "utf8");
    expect(repository).toContain("FOR SHARE OF claim`");
    expect(repository).toContain("FOR UPDATE OF claim\n       FOR SHARE OF source`");
    expect(repository).not.toMatch(/FOR SHARE OF (?:claim, )?span/);
    expect(repository).not.toMatch(/FOR SHARE OF (?:span, )?source, chunk/);
  });

  it("serializes first acceptance with an advisory lock before a plain prior-Fact read", async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const tx = {
      client: {} as TenantDbTransaction["client"],
      async query(sql: string, values?: readonly unknown[]) {
        statements.push({ sql, values });
        return { rows: [] };
      }
    } as unknown as TenantDbTransaction;

    await new TruthLedgerRepository(tx).lockFirstAcceptanceSlot({
      tenantId: id("1"),
      workspaceId: id("2"),
      spaceId,
      subjectType: "activity",
      subjectId: id("4"),
      predicate: "activity.outcome"
    });

    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toBe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(statements[0]?.values).toEqual([
      `${id("1")}/${id("2")}/${spaceId}/activity/${id("4")}/activity.outcome`
    ]);
    expect(statements[1]?.sql).toContain("FROM truth.accepted_facts");
    expect(statements[1]?.sql).toContain("LIMIT 1");
    expect(statements[1]?.sql).not.toMatch(/\bFOR\s+(?:NO KEY )?(?:UPDATE|SHARE)\b/i);
  });

  it("locks acceptance at the persisted Claim coordinate without Initiative-wide narrowing", async () => {
    const implementation = await readFile(
      new URL("./domain-command-bus.ts", import.meta.url),
      "utf8"
    );

    expect(implementation).toContain("predicate: acceptedCoordinate.predicate");
    expect(implementation).toContain("subjectType: acceptedCoordinate.subjectType");
    expect(implementation).not.toContain("assertSolePrimaryObjectiveProposal");
    expect(implementation).not.toMatch(
      /command\.payload\.subject\.type === "initiative"[\s\S]{0,300}lockFirstAcceptanceSlot/
    );
    expect(implementation).toContain(
      'command.payload.predicate === "initiative.primary_objective"'
    );
  });
});

function claimCommand(expectedVersion: number): B2AuthorizedDomainCommand<"claim.create"> {
  return {
    kind: "claim.create",
    idempotencyKey: "claim-create-command",
    predicateCatalogVersion: "truth-predicate-catalog.v1",
    payload: {
      subject: { type: "activity", id: id("4"), expectedVersion },
      predicate: "activity.outcome",
      valueJson: "Outcome agreed",
      normalizedText: "Outcome agreed",
      confidence: "strong",
      evidence: {
        sourceArtifactId: id("5"),
        sourceChunkId: id("6"),
        expectedSourceVersion: 1,
        expectedChunkVersion: 1,
        normalizationVersion: "source-normalization.v1",
        chunkingVersion: "source-chunking.v1",
        startOffset: 0,
        endOffset: 7,
        excerpt: "Outcome",
        sourceContentHash: "a".repeat(64),
        sourceNormalizedContentHash: "b".repeat(64),
        chunkContentHash: "c".repeat(64),
        excerptHash: "d".repeat(64)
      }
    }
  };
}

function factCommand(): B2AuthorizedDomainCommand<"fact.accept"> {
  return {
    kind: "fact.accept",
    idempotencyKey: "fact-accept-command",
    predicateCatalogVersion: "truth-predicate-catalog.v1",
    payload: {
      subject: { type: "activity", id: id("4"), expectedVersion: 3 },
      claims: [{ claimId: id("10"), expectedVersion: 1 }],
      expectedCurrentFactId: null,
      acceptanceScope: "engagement"
    }
  };
}

function context(): SecurityContext {
  return {
    requestId: "b2-command-test",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    tenantId: id("1"),
    workspaceId: id("2"),
    actorUserId: id("7"),
    actorMembershipId: id("8"),
    actorDisplayPersonId: id("9"),
    requestedSpaceIds: [spaceId],
    membershipIds: [id("8")],
    roleHints: ["owner"],
    dataClassCeiling: "confidential",
    policyVersion: "default-v1",
    issuedAt: "2026-07-22T00:00:00.000Z",
    expiresAt: "2099-07-22T00:00:00.000Z"
  };
}

function authorization(allowed: boolean): TransactionAwareAuthorizationService {
  const decision = { allowed, reasonCode: "test", policyVersion: "default-v1" };
  return {
    can: vi.fn(async () => decision),
    canInTransaction: vi.fn(async () => decision)
  };
}

function transactionPool(subjectExists: boolean): { pool: PgPool; client: PgPoolClient } {
  const query = vi.fn(async (sql: string) => {
    if (sql === "SELECT current_user AS current_user") {
      return { rows: [{ current_user: "throughline_app" }] };
    }
    if (sql.includes("FROM work.activities") && sql.includes("SELECT space_id")) {
      return { rows: subjectExists ? [{ space_id: spaceId }] : [] };
    }
    if (sql.includes("AS settings_cleared")) return { rows: [{ settings_cleared: true }] };
    if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED" || sql === "COMMIT" || sql === "ROLLBACK")
      return { rows: [] };
    if (sql === "SELECT set_config($1, $2, true)") return { rows: [] };
    throw new Error(`Unexpected durable truth transaction query: ${sql}`);
  });
  const client = { query, release: vi.fn() } as unknown as PgPoolClient;
  return {
    client,
    pool: { connect: vi.fn(async () => client) } as unknown as PgPool
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected durable truth command to fail");
}
