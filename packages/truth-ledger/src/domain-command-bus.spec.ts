import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import type { B2AuthorizedDomainCommand, SecurityContext } from "@throughline/core-types";
import {
  DomainCommandRepository,
  type PgPool,
  type PgPoolClient,
  type TenantDbTransaction
} from "@throughline/db";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as publicApi from "./index.js";
import { parseB2Command } from "./command-schemas.js";
import { B2AuthorizationError, TruthLedgerDomainCommandBus } from "./domain-command-bus.js";
import {
  TruthLedgerConflictError,
  TruthLedgerInvariantError,
  TruthLedgerRepository,
  TruthLedgerUnavailableError
} from "./repository.js";
import { VerifiedClaimSourceSpanAdmission } from "./source-span.js";

const id = (suffix: string) => `0190a000-0000-7000-8000-${suffix.padStart(12, "0")}`;
const spaceId = id("3");

describe.sequential("durable truth command boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not execute dormant conflict, emergency, or derived-view command contracts", async () => {
    const pool = transactionPool(true).pool;

    for (const command of dormantCommands()) {
      await expect(
        new TruthLedgerDomainCommandBus(pool).execute(command, context())
      ).rejects.toThrow("B2 command request is invalid");
    }

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["fact.supersede", supersedeCommand, supersedeResult()],
    ["fact.revoke", revokeCommand, revokeResult()]
  ] as const)(
    "executes the activated %s contract through the durable reservation boundary",
    async (kind, buildCommand, durableResult) => {
      const { pool } = transactionPool(true);
      const prelock = vi.spyOn(TruthLedgerRepository.prototype, "prelockCurrentFact");
      const reserve = vi.spyOn(DomainCommandRepository.prototype, "reserve").mockResolvedValue({
        status: "replay",
        command: {
          id: id("12"),
          safeResponse: durableResult,
          completedAt: new Date("2026-08-07T00:01:00.000Z")
        }
      });
      const auth = authorization(true);

      await expect(
        new TruthLedgerDomainCommandBus(pool, auth).execute(buildCommand(), context())
      ).resolves.toEqual(durableResult);

      expect(reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          commandKind: `${kind}.v1`,
          commandSchemaVersion: 1,
          reservationSpaceId: spaceId,
          safeRequest: safeLifecycleRequest(kind)
        })
      );
      expect(prelock).not.toHaveBeenCalled();
      expect(auth.canInTransaction).toHaveBeenCalledOnce();
      expect(auth.canInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        kind,
        { type: "fact", id: id("20") },
        expect.anything(),
        { lockAuthority: true, factLifecycleReplay: true }
      );
      expect(vi.mocked(auth.canInTransaction).mock.invocationCallOrder[0]).toBeGreaterThan(
        reserve.mock.invocationCallOrder[0]!
      );
    }
  );

  it.each([
    ["fact.supersede", supersedeCommand, supersedeResult()],
    ["fact.revoke", revokeCommand, revokeResult()]
  ] as const)(
    "withholds the durable %s result when the replaying actor lost lifecycle authority",
    async (_kind, buildCommand, durableResult) => {
      const { pool, client } = transactionPool(true);
      const prelock = vi.spyOn(TruthLedgerRepository.prototype, "prelockCurrentFact");
      vi.spyOn(DomainCommandRepository.prototype, "reserve").mockResolvedValue({
        status: "replay",
        command: {
          id: id("12"),
          safeResponse: durableResult,
          completedAt: new Date("2026-08-07T00:01:00.000Z")
        }
      });
      const auth = authorization(false);

      const error = await captureError(
        new TruthLedgerDomainCommandBus(pool, auth).execute(buildCommand(), context())
      );

      expect(error).toEqual(new B2AuthorizationError());
      expect(error.message).not.toMatch(/fact|claim|evidence|0190a000/iu);
      expect(auth.canInTransaction).toHaveBeenCalledOnce();
      expect(prelock).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    }
  );

  it("rejects a successor classified below the predecessor Fact before the lifecycle mutation", async () => {
    const { pool, client } = transactionPool(true);
    vi.spyOn(DomainCommandRepository.prototype, "reserve").mockImplementation(async (input) => ({
      status: "reserved",
      commandId: input.id
    }));
    const prelock = vi
      .spyOn(TruthLedgerRepository.prototype, "prelockCurrentFact")
      .mockResolvedValue({ factId: id("20") } as never);
    vi.spyOn(
      TruthLedgerRepository.prototype,
      "refreshCurrentFactAfterAuthorization"
    ).mockResolvedValue(confidentialPredecessorInWorkspaceSpace() as never);
    const lockReplacements = vi
      .spyOn(TruthLedgerRepository.prototype, "lockReplacementClaimsForSupersession")
      .mockResolvedValue([workspaceReplacementClaim()] as never);
    vi.spyOn(
      TruthLedgerRepository.prototype,
      "getAuthorizedClaimEvidenceSnapshot"
    ).mockResolvedValue(workspaceEvidenceSnapshot() as never);
    vi.spyOn(TruthLedgerRepository.prototype, "transactionTimestamp").mockResolvedValue(
      "2026-08-07T00:00:00.000Z"
    );
    const supersede = vi.spyOn(TruthLedgerRepository.prototype, "supersedePrelockedFact");

    const error = await captureError(
      new TruthLedgerDomainCommandBus(pool, authorization(true)).execute(
        supersedeCommand(),
        context()
      )
    );

    expect({ name: error.name, message: error.message }).toEqual({
      name: "TruthLedgerConflictError",
      message: "Truth command precondition failed"
    });
    expect(prelock).toHaveBeenCalledOnce();
    expect(lockReplacements).toHaveBeenCalledOnce();
    expect(supersede).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("fails a supersession that names deferred conflict lifecycle closed before connecting", async () => {
    const { pool } = transactionPool(true);
    const baseline = supersedeCommand();
    const command = {
      ...baseline,
      payload: {
        ...baseline.payload,
        conflict: { conflictId: id("22"), expectedVersion: 1 }
      }
    } as B2AuthorizedDomainCommand<"fact.supersede">;

    await expect(new TruthLedgerDomainCommandBus(pool).execute(command, context())).rejects.toThrow(
      "B2 command request is invalid"
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("uses one generic unavailable error for absent or hidden, denied, and non-human lifecycle requests", async () => {
    const absent = await captureError(
      new TruthLedgerDomainCommandBus(transactionPool(false).pool, authorization(true)).execute(
        revokeCommand(),
        context()
      )
    );
    vi.spyOn(DomainCommandRepository.prototype, "reserve").mockImplementation(async (input) => ({
      status: "reserved",
      commandId: input.id
    }));
    vi.spyOn(TruthLedgerRepository.prototype, "prelockCurrentFact").mockResolvedValue({
      factId: id("20")
    } as never);
    const denied = await captureError(
      new TruthLedgerDomainCommandBus(transactionPool(true).pool, authorization(false)).execute(
        revokeCommand(),
        context()
      )
    );
    const servicePool = transactionPool(true).pool;
    const nonHuman = await captureError(
      new TruthLedgerDomainCommandBus(servicePool, authorization(true)).execute(revokeCommand(), {
        ...context(),
        servicePrincipalId: id("23")
      })
    );

    for (const error of [absent, denied, nonHuman]) {
      expect(error).toEqual(new B2AuthorizationError());
      expect(error.message).not.toMatch(/fact|claim|evidence|0190a000/iu);
    }
    expect(servicePool.connect).not.toHaveBeenCalled();
  });

  it.each([
    [new TruthLedgerUnavailableError(), B2AuthorizationError],
    [new TruthLedgerConflictError(), TruthLedgerConflictError]
  ] as const)(
    "classifies a replacement-row failure at the bus boundary without weakening semantic conflicts",
    async (repositoryFailure, expectedClass) => {
      const { pool, client } = transactionPool(true);
      vi.spyOn(DomainCommandRepository.prototype, "reserve").mockImplementation(async (input) => ({
        status: "reserved",
        commandId: input.id
      }));
      vi.spyOn(TruthLedgerRepository.prototype, "prelockCurrentFact").mockResolvedValue({
        factId: id("20")
      } as never);
      vi.spyOn(
        TruthLedgerRepository.prototype,
        "refreshCurrentFactAfterAuthorization"
      ).mockResolvedValue(workspacePredecessor() as never);
      vi.spyOn(
        TruthLedgerRepository.prototype,
        "lockReplacementClaimsForSupersession"
      ).mockRejectedValue(repositoryFailure);

      const error = await captureError(
        new TruthLedgerDomainCommandBus(pool, authorization(true)).execute(
          supersedeCommand(),
          context()
        )
      );

      expect(error).toBeInstanceOf(expectedClass);
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(error.message).not.toMatch(/0190a000|replacement/i);
    }
  );

  it("preserves an injected lifecycle repository failure and rolls the transaction back exactly", async () => {
    const { pool, client } = transactionPool(true);
    vi.spyOn(DomainCommandRepository.prototype, "reserve").mockImplementation(async (input) => ({
      status: "reserved",
      commandId: input.id
    }));
    const failure = new TruthLedgerInvariantError();
    vi.spyOn(TruthLedgerRepository.prototype, "prelockCurrentFact").mockRejectedValue(failure);

    const error = await captureError(
      new TruthLedgerDomainCommandBus(pool, authorization(true)).execute(revokeCommand(), context())
    );

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(TruthLedgerConflictError);
    expect(vi.mocked(client.query).mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
    expect(vi.mocked(client.query).mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(
      1
    );
  });

  it("keeps the internal unavailable classification out of the public root export inventory", () => {
    expect(Object.keys(publicApi)).not.toContain("TruthLedgerUnavailableError");
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
    const readHeaders = vi
      .spyOn(TruthLedgerRepository.prototype, "readClaimSupportHeaders")
      .mockResolvedValue([
        {
          claimId: id("10"),
          evidenceSpanId: id("11"),
          sourceArtifactId: id("5"),
          spaceId,
          subjectType: "activity",
          subjectId: id("4"),
          predicate: "activity.outcome"
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
    expect(readHeaders).not.toHaveBeenCalled();
    expect(loadClaims).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  });

  it("rolls back an early Fact reservation when RLS-constrained Claim discovery fails", async () => {
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
    const readHeaders = vi
      .spyOn(TruthLedgerRepository.prototype, "readClaimSupportHeaders")
      .mockRejectedValue(new Error("simulated Claim discovery failure"));

    await expect(
      new TruthLedgerDomainCommandBus(pool, auth).execute(factCommand(), context())
    ).rejects.toEqual(new B2AuthorizationError());

    expect(vi.mocked(auth.canInTransaction).mock.invocationCallOrder[0]).toBeLessThan(
      reserve.mock.invocationCallOrder[0]!
    );
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      readHeaders.mock.invocationCallOrder[0]!
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

  it("discovers acceptance headers without locks and locks only the final Claim/source load", async () => {
    const repository = await readFile(new URL("./repository.ts", import.meta.url), "utf8");
    const discovery = repository.slice(
      repository.indexOf("async readClaimSupportHeaders"),
      repository.indexOf("async loadClaimsForAcceptance")
    );
    expect(discovery).not.toMatch(/\bFOR\s+(?:NO KEY )?(?:UPDATE|SHARE)\b/i);
    expect(repository).toContain("FOR UPDATE OF claim\n       FOR SHARE OF source`");
    expect(repository).not.toMatch(/FOR SHARE OF (?:claim, )?span/);
    expect(repository).not.toMatch(/FOR SHARE OF (?:span, )?source, chunk/);
  });

  it("serializes first acceptance and reserves only an active Fact slot", async () => {
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
    expect(statements[1]?.sql).toContain("status IN ('current', 'contested')");
    expect(statements[1]?.sql).toContain("LIMIT 1");
    expect(statements[1]?.sql).not.toMatch(/\bFOR\s+(?:NO KEY )?(?:UPDATE|SHARE)\b/i);

    const occupiedTx = {
      client: {} as TenantDbTransaction["client"],
      async query(sql: string) {
        if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("FROM truth.accepted_facts")) return { rows: [{ id: id("9") }] };
        throw new Error(`Unexpected acceptance-slot query: ${sql}`);
      }
    } as unknown as TenantDbTransaction;
    await expect(
      new TruthLedgerRepository(occupiedTx).lockFirstAcceptanceSlot({
        tenantId: id("1"),
        workspaceId: id("2"),
        spaceId,
        subjectType: "activity",
        subjectId: id("4"),
        predicate: "activity.outcome"
      })
    ).rejects.toBeInstanceOf(TruthLedgerConflictError);
  });

  it("checks the open primary-objective proposal policy before revocation mutation", async () => {
    const repository = await readFile(new URL("./repository.ts", import.meta.url), "utf8");
    const revoke = repository.slice(
      repository.indexOf("async revokePrelockedFact"),
      repository.indexOf("async lockFirstAcceptanceSlot")
    );

    expect(revoke).toContain("status = 'proposed'");
    expect(revoke).toContain("TruthLedgerConflictError");
    expect(revoke.indexOf("status = 'proposed'")).toBeLessThan(
      revoke.indexOf("terminalizePrelockedFact")
    );
  });

  it("locks acceptance at the persisted Claim coordinate without Initiative-wide narrowing", async () => {
    const implementation = await readFile(
      new URL("./domain-command-bus.ts", import.meta.url),
      "utf8"
    );

    expect(implementation).toContain("predicate: discoveredCoordinate.predicate");
    expect(implementation).toContain("subjectType: discoveredCoordinate.subjectType");
    expect(implementation).not.toContain("assertSolePrimaryObjectiveProposal");
    expect(implementation).not.toMatch(
      /command\.payload\.subject\.type === "initiative"[\s\S]{0,300}lockFirstAcceptanceSlot/
    );
    expect(implementation).toContain('proposalSlotPolicy === "single_open"');
    expect(implementation).toContain("resolvePredicateDefinition(");
    expect(implementation).not.toMatch(
      /command\.payload\.predicate === ["']initiative\.primary_objective["']/
    );
    const acceptance = implementation.slice(
      implementation.indexOf("const claimIds = command.payload.claims.map"),
      implementation.indexOf("const admittedClaims: Claim[]")
    );
    expect(acceptance.indexOf("readClaimSupportHeaders(")).toBeLessThan(
      acceptance.indexOf("lockFirstAcceptanceSlot({")
    );
    expect(acceptance.indexOf("lockFirstAcceptanceSlot({")).toBeLessThan(
      acceptance.indexOf('await this.authorize(tx, context, "claim.read"')
    );
    expect(acceptance.indexOf('await this.authorize(tx, context, "claim.read"')).toBeLessThan(
      acceptance.indexOf("loadClaimsForAcceptance(")
    );
  });

  it("locks the shared objective coordinate before revalidating and locking the predecessor", async () => {
    const statements: string[] = [];
    const tx = {
      client: {} as TenantDbTransaction["client"],
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes("FROM truth.claims") && sql.includes("FOR UPDATE")) {
          return {
            rows: [
              {
                id: id("10"),
                created_by_user_id: id("7"),
                created_by_membership_id: id("8")
              }
            ]
          };
        }
        if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        throw new Error(`Unexpected objective recovery lock query: ${sql}`);
      }
    } as unknown as TenantDbTransaction;

    await new TruthLedgerRepository(tx).lockPrimaryObjectiveProposal({
      tenantId: id("1"),
      workspaceId: id("2"),
      spaceId,
      initiativeId: id("4"),
      claimId: id("10"),
      expectedVersion: 1
    });

    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(statements[1]).toContain("space_id = $3");
    expect(statements[1]).toContain("id = $4");
    expect(statements[1]).toContain("subject_type = 'initiative' AND subject_id = $5");
    expect(statements[1]).toContain("predicate = 'initiative.primary_objective'");
    expect(statements[1]).toContain("status = 'proposed' AND version = $6");
    expect(statements[1]).not.toContain("NOT EXISTS");
    expect(statements[1]).not.toContain("FROM truth.accepted_facts");
    expect(statements[1]).toContain("FOR UPDATE");
  });

  it("reserves the objective proposal slot independently of the current accepted Fact", async () => {
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const tx = {
      client: {} as TenantDbTransaction["client"],
      async query(sql: string, values?: readonly unknown[]) {
        statements.push({ sql, ...(values === undefined ? {} : { values }) });
        if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("ORDER BY created_at DESC, id DESC")) {
          return { rows: [{ id: id("10"), version: 2, status: "rejected" }] };
        }
        if (sql.includes("AS occupied")) return { rows: [{ occupied: false }] };
        throw new Error(`Unexpected objective generation query: ${sql}`);
      }
    } as unknown as TenantDbTransaction;

    await new TruthLedgerRepository(tx).lockPrimaryObjectiveProposalSlot({
      tenantId: id("1"),
      workspaceId: id("2"),
      spaceId,
      subjectId: id("4"),
      expectedLatestClaim: {
        kind: "claim",
        claimId: id("10"),
        expectedVersion: 2,
        expectedStatus: "rejected"
      }
    });

    expect(statements).toHaveLength(3);
    expect(statements[0]?.sql).toBe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(statements[1]?.sql).toContain("FOR SHARE");
    expect(statements[1]?.values).toEqual([
      id("1"),
      id("2"),
      spaceId,
      id("4"),
      "initiative.primary_objective"
    ]);
    expect(statements[2]?.sql).toContain("AS occupied");
    expect(statements[2]?.sql).toContain("FROM truth.claims");
    expect(statements[2]?.sql).toContain("status = 'proposed'");
    expect(statements[2]?.sql).not.toContain("truth.accepted_facts");
    expect(statements[2]?.sql).not.toContain("status IN ('current', 'contested')");

    const occupiedTx = {
      ...tx,
      async query(sql: string, values?: readonly unknown[]) {
        if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("ORDER BY created_at DESC, id DESC")) {
          return { rows: [{ id: id("10"), version: 2, status: "rejected" }] };
        }
        if (sql.includes("AS occupied")) return { rows: [{ occupied: true }] };
        return tx.query(sql, values);
      }
    } as unknown as TenantDbTransaction;
    await expect(
      new TruthLedgerRepository(occupiedTx).lockPrimaryObjectiveProposalSlot({
        tenantId: id("1"),
        workspaceId: id("2"),
        spaceId,
        subjectId: id("4"),
        expectedLatestClaim: {
          kind: "claim",
          claimId: id("10"),
          expectedVersion: 2,
          expectedStatus: "rejected"
        }
      })
    ).rejects.toBeInstanceOf(TruthLedgerConflictError);

    const staleTx = {
      ...tx,
      async query(sql: string, values?: readonly unknown[]) {
        if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("ORDER BY created_at DESC, id DESC")) {
          return { rows: [{ id: id("11"), version: 2, status: "rejected" }] };
        }
        return tx.query(sql, values);
      }
    } as unknown as TenantDbTransaction;
    await expect(
      new TruthLedgerRepository(staleTx).lockPrimaryObjectiveProposalSlot({
        tenantId: id("1"),
        workspaceId: id("2"),
        spaceId,
        subjectId: id("4"),
        expectedLatestClaim: {
          kind: "claim",
          claimId: id("10"),
          expectedVersion: 2,
          expectedStatus: "rejected"
        }
      })
    ).rejects.toBeInstanceOf(TruthLedgerConflictError);

    const implementation = await readFile(
      new URL("./domain-command-bus.ts", import.meta.url),
      "utf8"
    );
    expect(implementation).toContain("expectedPrimaryObjectiveGeneration");
    expect(implementation).toContain("expectedLatestClaimId");
    expect(implementation).toContain("expectedLatestClaimStatus");
    expect(implementation).toContain("expectedLatestClaimVersion");
  });

  it("serializes recovery identity and takes locking authorization only after the coordinate", async () => {
    const implementation = await readFile(
      new URL("./domain-command-bus.ts", import.meta.url),
      "utf8"
    );
    const recovery = implementation.slice(
      implementation.indexOf(
        'command.kind === "initiative.primary_objective.withdraw" ||\n      command.kind === "initiative.primary_objective.rework"'
      ),
      implementation.indexOf("const timestamp = await ledger.transactionTimestamp()")
    );

    expect(recovery).toContain("domain.commands.lockReservationIdentity({");
    const preauthorization = recovery.indexOf("await this.authorize(");
    const reservation = recovery.indexOf("const reservation = await reserveCommand(");
    const coordinateAndClaimLock = recovery.indexOf("await ledger.lockPrimaryObjectiveProposal({");
    const lockingReauthorization = recovery.indexOf(
      "await this.authorize(",
      coordinateAndClaimLock
    );
    expect(recovery.indexOf("lockReservationIdentity({")).toBeLessThan(preauthorization);
    expect(preauthorization).toBeLessThan(reservation);
    expect(recovery.slice(preauthorization, reservation)).toContain("false");
    expect(reservation).toBeLessThan(coordinateAndClaimLock);
    expect(coordinateAndClaimLock).toBeLessThan(lockingReauthorization);
    expect(recovery.slice(lockingReauthorization)).toContain("true");
    expect(recovery).toMatch(/if \(reservation\.replay\) \{[\s\S]*?this\.authorize[\s\S]*?true/);
    expect(recovery).not.toMatch(/40P01|deadlock|retry/i);
  });

  it("terminalizes objective proposals without mutating their objective or evidence payload", async () => {
    const repository = await readFile(new URL("./repository.ts", import.meta.url), "utf8");
    const terminalize = repository.slice(
      repository.indexOf("async terminalizePrimaryObjectiveProposal"),
      repository.indexOf("async requirePrimaryObjectiveSupportConfirmations")
    );
    expect(terminalize).toContain("SET status = $6, version = 2, updated_at = $7");
    expect(terminalize).toContain("predicate = 'initiative.primary_objective'");
    expect(terminalize).not.toMatch(
      /SET[\s\S]*?(?:canonical_value_text|normalized_text|verified_evidence_span_id|value_hash)\s*=/
    );
    expect(terminalize).not.toMatch(/DELETE FROM truth\.(?:claims|verified_evidence_spans)/);
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

function supersedeCommand(): B2AuthorizedDomainCommand<"fact.supersede"> {
  return {
    kind: "fact.supersede",
    idempotencyKey: "fact-supersede-command",
    predicateCatalogVersion: "truth-predicate-catalog.v1",
    payload: {
      factId: id("20"),
      expectedFactVersion: 1,
      subject: { type: "activity", id: id("4"), expectedVersion: 3 },
      replacementClaims: [{ claimId: id("10"), expectedVersion: 1 }],
      reason: { code: "newer_evidence", rationale: "Newer evidence replaces prior truth." }
    }
  };
}

function revokeCommand(): B2AuthorizedDomainCommand<"fact.revoke"> {
  return {
    kind: "fact.revoke",
    idempotencyKey: "fact-revoke-command",
    predicateCatalogVersion: "truth-predicate-catalog.v1",
    payload: {
      factId: id("20"),
      expectedFactVersion: 1,
      reason: { code: "no_longer_true", rationale: "The accepted statement is no longer true." }
    }
  };
}

const lifecycleSourceText = "Outcome agreed";
const lifecycleExcerpt = "Outcome";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function workspaceReplacementEvidence() {
  return {
    sourceArtifactId: id("5"),
    sourceChunkId: id("6"),
    expectedSourceVersion: 1,
    expectedChunkVersion: 1,
    normalizationVersion: "source-normalization.v1",
    chunkingVersion: "source-chunking.v1",
    startOffset: 0,
    endOffset: lifecycleExcerpt.length,
    excerpt: lifecycleExcerpt,
    sourceContentHash: sha256Hex(lifecycleSourceText),
    sourceNormalizedContentHash: sha256Hex(lifecycleSourceText),
    chunkContentHash: sha256Hex(lifecycleSourceText),
    excerptHash: sha256Hex(lifecycleExcerpt)
  };
}

function workspaceEvidenceSnapshot() {
  return {
    tenantId: id("1"),
    workspaceId: id("2"),
    spaceId,
    subject: {
      type: "activity",
      id: id("4"),
      tenantId: id("1"),
      workspaceId: id("2"),
      spaceId,
      version: 3,
      accessClass: "workspace"
    },
    sourceActivityLink: {
      tenantId: id("1"),
      workspaceId: id("2"),
      spaceId,
      sourceArtifactId: id("5"),
      activityId: id("4"),
      governingInitiativeId: null
    },
    source: {
      id: id("5"),
      tenantId: id("1"),
      workspaceId: id("2"),
      spaceId,
      version: 1,
      immutableText: lifecycleSourceText,
      contentHash: sha256Hex(lifecycleSourceText),
      normalizedContentHash: sha256Hex(lifecycleSourceText),
      normalizationVersion: "source-normalization.v1",
      chunkingVersion: "source-chunking.v1",
      accessClass: "workspace",
      deletedAt: null,
      successorSourceArtifactId: null
    },
    chunks: [
      {
        id: id("6"),
        tenantId: id("1"),
        workspaceId: id("2"),
        spaceId,
        sourceArtifactId: id("5"),
        version: 1,
        normalizationVersion: "source-normalization.v1",
        chunkingVersion: "source-chunking.v1",
        chunkIndex: 0,
        startOffset: 0,
        endOffset: lifecycleSourceText.length,
        normalizedText: lifecycleSourceText,
        contentHash: sha256Hex(lifecycleSourceText),
        accessClass: "workspace"
      }
    ],
    explicitPolicyAccessClass: "workspace"
  };
}

function workspaceReplacementClaim() {
  return {
    claim: {
      id: id("10"),
      version: 1,
      tenantId: id("1"),
      workspaceId: id("2"),
      spaceId,
      subjectType: "activity",
      subjectId: id("4"),
      predicate: "activity.outcome",
      canonicalValue: lifecycleSourceText,
      normalizedText: lifecycleSourceText,
      assertedByType: "person",
      assertedById: id("9"),
      confidence: "strong",
      status: "proposed",
      accessClass: "workspace",
      createdAt: "2026-08-07T00:00:00.000Z"
    },
    evidence: workspaceReplacementEvidence(),
    evidenceSpanId: id("11"),
    sourceArtifactId: id("5"),
    claimVersion: 1
  };
}

function confidentialPredecessorInWorkspaceSpace() {
  return Object.freeze({
    tenantId: id("1"),
    workspaceId: id("2"),
    spaceId,
    factId: id("20"),
    version: 1,
    status: "current",
    subjectType: "activity",
    subjectId: id("4"),
    predicate: "activity.outcome",
    subjectVersion: 3,
    factAccessClass: "confidential",
    subjectAccessClass: "workspace",
    acceptanceScope: "engagement",
    authorityBasis: "activity_owner"
  });
}

function workspacePredecessor() {
  return Object.freeze({
    ...confidentialPredecessorInWorkspaceSpace(),
    factAccessClass: "workspace" as const
  });
}

function supersedeResult() {
  return {
    factId: id("20"),
    version: 2,
    status: "superseded",
    replacementFactId: id("21"),
    replacementFactVersion: 1,
    replacementFactStatus: "current"
  };
}

function revokeResult() {
  return { factId: id("20"), version: 2, status: "revoked" };
}

function safeLifecycleRequest(kind: "fact.supersede" | "fact.revoke") {
  if (kind === "fact.revoke") {
    return {
      factId: id("20"),
      expectedFactVersion: 1,
      reason: revokeCommand().payload.reason
    };
  }
  return {
    factId: id("20"),
    expectedFactVersion: 1,
    subject: supersedeCommand().payload.subject,
    replacementClaims: supersedeCommand().payload.replacementClaims,
    reason: supersedeCommand().payload.reason
  };
}

function dormantCommands(): B2AuthorizedDomainCommand<"claim.create">[] {
  const commands = [
    {
      kind: "fact.contest",
      idempotencyKey: "dormant-contest",
      predicateCatalogVersion: "truth-predicate-catalog.v1",
      payload: {
        factId: id("20"),
        expectedFactVersion: 1,
        competingClaim: { claimId: id("10"), expectedVersion: 1 },
        reason: { code: "conflicting_evidence", rationale: "Sources disagree." }
      }
    },
    {
      kind: "fact.uphold",
      idempotencyKey: "dormant-uphold",
      predicateCatalogVersion: "truth-predicate-catalog.v1",
      payload: {
        factId: id("20"),
        expectedFactVersion: 1,
        conflict: { conflictId: id("24"), expectedVersion: 1 },
        challengerClaim: { claimId: id("10"), expectedVersion: 1 },
        reason: { code: "challenger_not_supported", rationale: "The challenger lacks support." }
      }
    },
    {
      kind: "fact.emergency_contest",
      idempotencyKey: "dormant-emergency-contest",
      predicateCatalogVersion: "truth-predicate-catalog.v1",
      payload: {
        factId: id("20"),
        expectedFactVersion: 1,
        competingClaim: { claimId: id("10"), expectedVersion: 1 },
        reason: { code: "safety_risk", rationale: "Immediate safety risk." }
      }
    },
    {
      kind: "fact.emergency_revoke",
      idempotencyKey: "dormant-emergency-revoke",
      predicateCatalogVersion: "truth-predicate-catalog.v1",
      payload: {
        factId: id("20"),
        expectedFactVersion: 1,
        reason: { code: "security_incident", rationale: "Security incident response." }
      }
    },
    {
      kind: "derived_view.regenerate",
      idempotencyKey: "dormant-derived-view",
      predicateCatalogVersion: "truth-predicate-catalog.v1",
      payload: {
        target: { type: "initiative", id: id("15"), expectedVersion: 1 },
        viewType: "initiative_summary",
        renderer: { id: "truth-ledger.cited-current-truth", version: "v1" },
        expectedAudienceFingerprint: "a".repeat(64),
        expectedInputRevisionHash: "b".repeat(64)
      }
    }
  ];
  for (const command of commands) {
    expect(parseB2Command(command).kind).toBe(command.kind);
  }
  return commands as unknown as B2AuthorizedDomainCommand<"claim.create">[];
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
    if (sql.includes("FROM truth.accepted_facts fact") && sql.includes("SELECT fact.id")) {
      return { rows: subjectExists ? [{ id: id("20"), space_id: spaceId }] : [] };
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
