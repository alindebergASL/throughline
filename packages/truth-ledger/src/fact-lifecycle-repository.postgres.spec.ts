import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AccountOperationsDomainCommandBus } from "../../account-operations/src/domain-command-bus.js";
import { maxAccessClass } from "@throughline/core-types";
import type {
  AccessClass,
  B2AuthorizedDomainCommand,
  B2CommandResultMap,
  SecurityContext
} from "@throughline/core-types";
import {
  ProductDomainTransactionRepositories,
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  provisionWorkspaceProductRelayPrincipal,
  seedWaveA2DeterministicData,
  withTenantTransaction,
  type PgPool,
  type TenantDbTransaction
} from "@throughline/db";
import { PostgresAuthorizationService } from "@throughline/authorization";
import { createDevSecurityContext, devFixtures, generateUuidV7 } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashB2CommandIdentity, parseB2Command, parseB2CommandResult } from "./command-schemas.js";
import {
  TruthLedgerConflictError,
  TruthLedgerRepository,
  type PostAuthorizationCurrentFact,
  type PrelockedCurrentFact
} from "./repository.js";
import {
  VerifiedClaimSourceSpanAdmission,
  bindClaimEvidenceSnapshotLookupToTransaction
} from "./source-span.js";
import { constructAcceptedFactAtTrustedBoundary, type Claim } from "./types.js";
import { TruthLedgerDomainCommandBus } from "./domain-command-bus.js";

const repositoryUrl = new URL("./repository.ts", import.meta.url);
const commandBusUrl = new URL("./domain-command-bus.ts", import.meta.url);

const tenantId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "11111111-1111-4111-8111-111111111112";
const spaceId = "018f0000-0000-7000-8000-000000000003";
const subjectId = "018f0000-0000-7000-8000-000000000004";
const factId = "018f0000-0000-7000-8000-000000000005";
const claimA = "018f0000-0000-7000-8000-000000000011";
const claimB = "018f0000-0000-7000-8000-000000000012";

describe("Fact lifecycle repository query contract", () => {
  it("derives the canonical coordinate, takes its advisory lock, then prelocks the exact Fact", async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const repository = new TruthLedgerRepository(
      transactionStub((sql, values) => {
        statements.push({ sql, values });
        if (
          sql.includes("fact.predicate") &&
          !sql.includes("FOR UPDATE OF fact") &&
          !sql.includes("space.archived_at AS space_archived_at")
        ) {
          return {
            rows: [
              {
                id: factId,
                tenant_id: tenantId,
                workspace_id: workspaceId,
                space_id: spaceId,
                subject_type: "activity",
                subject_id: subjectId,
                predicate: "activity.outcome"
              }
            ]
          };
        }
        if (sql.includes("FOR UPDATE OF fact")) {
          return { rows: [lockedFactRow()] };
        }
        return { rows: [] };
      })
    );

    const target = await repository.prelockCurrentFact({
      tenantId,
      workspaceId,
      factId,
      expectedVersion: 1
    });

    expect(target).toMatchObject({
      tenantId,
      workspaceId,
      spaceId,
      factId,
      version: 1,
      status: "current",
      subjectType: "activity",
      subjectId,
      predicate: "activity.outcome"
    });
    expect(statements.map(({ sql }) => compact(sql))).toEqual([
      expect.stringContaining("SELECT fact.id, fact.tenant_id"),
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      expect.stringContaining("FOR UPDATE OF fact")
    ]);
    expect(statements[1]?.values).toEqual([
      `${tenantId}/${workspaceId}/${spaceId}/activity/${subjectId}/activity.outcome`
    ]);
    expect(statements.map(({ sql }) => sql).join("\n")).not.toMatch(/FOR SHARE/);
  });

  it("fails generically when the locked row no longer matches the derived header", async () => {
    const repository = new TruthLedgerRepository(
      transactionStub((sql) => {
        if (
          sql.includes("fact.predicate") &&
          !sql.includes("FOR UPDATE OF fact") &&
          !sql.includes("space.archived_at AS space_archived_at")
        ) {
          return {
            rows: [
              {
                id: factId,
                tenant_id: tenantId,
                workspace_id: workspaceId,
                space_id: spaceId,
                subject_type: "activity",
                subject_id: subjectId,
                predicate: "activity.outcome"
              }
            ]
          };
        }
        return { rows: [] };
      })
    );

    await expect(
      repository.prelockCurrentFact({ tenantId, workspaceId, factId, expectedVersion: 1 })
    ).rejects.toBeInstanceOf(TruthLedgerConflictError);
  });

  it("locks replacement Claims once in sorted unique order after predecessor prelock", async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const repository = new TruthLedgerRepository(
      transactionStub((sql, values) => {
        statements.push({ sql, values });
        if (
          sql.includes("fact.predicate") &&
          !sql.includes("FOR UPDATE OF fact") &&
          !sql.includes("space.archived_at AS space_archived_at")
        ) {
          return {
            rows: [
              {
                id: factId,
                tenant_id: tenantId,
                workspace_id: workspaceId,
                space_id: spaceId,
                subject_type: "activity",
                subject_id: subjectId,
                predicate: "activity.outcome"
              }
            ]
          };
        }
        if (sql.includes("FOR UPDATE OF fact")) return { rows: [lockedFactRow()] };
        if (sql.includes("space.archived_at AS space_archived_at")) {
          return { rows: [{ ...lockedFactRow(), space_archived_at: null }] };
        }
        return { rows: [] };
      })
    );
    const prelockedTarget = await repository.prelockCurrentFact({
      tenantId,
      workspaceId,
      factId,
      expectedVersion: 1
    });
    const target = await repository.refreshCurrentFactAfterAuthorization({
      target: prelockedTarget
    });

    await expect(
      repository.lockReplacementClaimsForSupersession({
        target,
        replacementClaims: [
          { claimId: claimB, expectedVersion: 1 },
          { claimId: claimA, expectedVersion: 1 }
        ]
      })
    ).rejects.toBeInstanceOf(TruthLedgerConflictError);

    const claimLock = statements.find(({ sql }) => sql.includes("FOR UPDATE OF claim"));
    expect(claimLock?.values?.[2]).toEqual([claimA, claimB]);
    expect(claimLock?.sql).toContain("ORDER BY claim.id");
    expect(claimLock?.sql).toContain("source.deleted_at IS NULL");
    expect(claimLock?.sql).toContain("active_fact.status = 'current'");

    await expect(
      repository.lockReplacementClaimsForSupersession({
        target,
        replacementClaims: [
          { claimId: claimA, expectedVersion: 1 },
          { claimId: claimA, expectedVersion: 1 }
        ]
      })
    ).rejects.toBeInstanceOf(TruthLedgerConflictError);
  });

  it("refreshes the exact target after authorization without acquiring or upgrading a lock", async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const repository = new TruthLedgerRepository(
      transactionStub((sql, values) => {
        statements.push({ sql, values });
        if (
          sql.includes("fact.predicate") &&
          !sql.includes("FOR UPDATE OF fact") &&
          !sql.includes("space.archived_at AS space_archived_at")
        ) {
          return {
            rows: [
              {
                id: factId,
                tenant_id: tenantId,
                workspace_id: workspaceId,
                space_id: spaceId,
                subject_type: "activity",
                subject_id: subjectId,
                predicate: "activity.outcome"
              }
            ]
          };
        }
        if (sql.includes("FOR UPDATE OF fact")) return { rows: [lockedFactRow()] };
        if (sql.includes("space.archived_at AS space_archived_at")) {
          return {
            rows: [
              {
                ...lockedFactRow(),
                space_access_class: "confidential",
                space_archived_at: null
              }
            ]
          };
        }
        return { rows: [] };
      })
    );
    const prelockedTarget = await repository.prelockCurrentFact({
      tenantId,
      workspaceId,
      factId,
      expectedVersion: 1
    });

    const refreshedTarget = await repository.refreshCurrentFactAfterAuthorization({
      target: prelockedTarget
    });

    expect(refreshedTarget).toMatchObject({
      factId,
      subjectId,
      subjectVersion: 1,
      status: "current",
      subjectAccessClass: "confidential"
    });
    const refresh = statements.at(-1)!;
    expect(refresh.values).toEqual([
      tenantId,
      workspaceId,
      factId,
      spaceId,
      "activity",
      subjectId,
      "activity.outcome"
    ]);
    expect(compact(refresh.sql)).toContain("space.archived_at AS space_archived_at");
    expect(refresh.sql).not.toMatch(/FOR (?:SHARE|UPDATE)/);
  });

  it("rejects forged and cross-repository post-authorization targets generically", async () => {
    const query = (sql: string) => {
      if (
        sql.includes("fact.predicate") &&
        !sql.includes("FOR UPDATE OF fact") &&
        !sql.includes("space.archived_at AS space_archived_at")
      ) {
        return {
          rows: [
            {
              id: factId,
              tenant_id: tenantId,
              workspace_id: workspaceId,
              space_id: spaceId,
              subject_type: "activity",
              subject_id: subjectId,
              predicate: "activity.outcome"
            }
          ]
        };
      }
      if (
        sql.includes("FOR UPDATE OF fact") ||
        sql.includes("space.archived_at AS space_archived_at")
      ) {
        return { rows: [{ ...lockedFactRow(), space_archived_at: null }] };
      }
      return { rows: [] };
    };
    const repository = new TruthLedgerRepository(transactionStub(query));
    const otherRepository = new TruthLedgerRepository(transactionStub(query));
    const prelockedTarget = await repository.prelockCurrentFact({
      tenantId,
      workspaceId,
      factId,
      expectedVersion: 1
    });
    const refreshedTarget = await repository.refreshCurrentFactAfterAuthorization({
      target: prelockedTarget
    });
    const forgedTarget = { ...refreshedTarget } as PostAuthorizationCurrentFact;

    for (const [owner, target] of [
      [otherRepository, refreshedTarget],
      [repository, forgedTarget]
    ] as const) {
      await expect(
        owner.lockReplacementClaimsForSupersession({
          target,
          replacementClaims: [{ claimId: claimA, expectedVersion: 1 }]
        })
      ).rejects.toBeInstanceOf(TruthLedgerConflictError);
    }
  });

  it("pins the predecessor update allowlist and append-only lifecycle mutation surface", async () => {
    const source = await readFile(repositoryUrl, "utf8");
    const lifecycleSection = source.slice(source.indexOf("async prelockCurrentFact"));

    expect(lifecycleSection).toMatch(
      /UPDATE truth\.accepted_facts\s+SET status = \$\d+, version = version \+ 1,\s+last_causation_command_id = \$\d+, updated_at = transaction_timestamp\(\)/
    );
    expect(lifecycleSection).not.toMatch(
      /UPDATE truth\.accepted_facts[\s\S]*?SET[\s\S]*?(canonical_value_text|normalized_text|confidence|access_class|recorded_at)\s*=/
    );
    expect(lifecycleSection).not.toMatch(/DELETE\s+FROM\s+truth\./i);
    expect(lifecycleSection).toContain("INSERT INTO truth.fact_lifecycle_events");
  });

  it("keeps Task 4A.5 command-bus activation outside the production change", async () => {
    const commandBus = await readFile(commandBusUrl, "utf8");
    const durableKinds = commandBus.slice(
      commandBus.indexOf("export type DurableTruthCommandKind"),
      commandBus.indexOf("type InternalCreateClaimCommand")
    );
    expect(durableKinds).not.toMatch(/fact\.supersede|fact\.revoke/);
  });
});

const ownerDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const connectedSuite = ownerDatabaseUrl && appDatabaseUrl ? describe.sequential : describe.skip;

connectedSuite("Fact lifecycle repository app-role PostgreSQL transactions", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let accountBus: AccountOperationsDomainCommandBus;
  let truthBus: TruthLedgerDomainCommandBus;
  let authorization: PostgresAuthorizationService;
  let organizationId: string;
  let fixtureSequence = 0;

  beforeAll(async () => {
    if (!ownerDatabaseUrl || !appDatabaseUrl) {
      throw new Error("Fact lifecycle PostgreSQL tests require both explicit test DSNs");
    }
    ownerPool = createPgPool(ownerDatabaseUrl);
    appPool = createPgPool(appDatabaseUrl);
    await applyMigrations(ownerPool, { reset: true });
    await seedWaveA2DeterministicData(ownerPool);
    await provisionTestAppRole(ownerPool, appDatabaseUrl);
    await withTenantTransaction(
      { pool: ownerPool, context: createDevSecurityContext("tenant-a-owner") },
      (tx) =>
        provisionWorkspaceProductRelayPrincipal(tx, {
          tenantId: devFixtures.tenantA,
          workspaceId: devFixtures.workspaceA
        })
    );
    accountBus = new AccountOperationsDomainCommandBus(appPool);
    truthBus = new TruthLedgerDomainCommandBus(appPool);
    authorization = new PostgresAuthorizationService(appPool);
    const organization = await accountBus.execute(
      {
        kind: "organization.create",
        idempotencyKey: "fact-lifecycle-repository-organization",
        payload: { name: "Lifecycle Test Organization", domains: ["lifecycle.test"] }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    organizationId = organization.organizationId;
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it("supersedes atomically with immutable predecessor support and one exact current successor", async () => {
    const fixture = await createFixture(2);
    const before = await factSnapshot(ownerPool, fixture.factId);
    const command = supersedeCommand(fixture, "happy-supersede");

    const result = await executeLifecycle(command, lifecycleContext(fixture));
    expect(result).toMatchObject({
      factId: fixture.factId,
      version: 2,
      status: "superseded",
      replacementFactStatus: "current",
      replacementFactVersion: 1
    });

    const after = await factSnapshot(ownerPool, fixture.factId);
    expect(withoutLifecycleColumns(after.predecessor)).toEqual(
      withoutLifecycleColumns(before.predecessor)
    );
    expect(after.predecessor).toMatchObject({
      id: fixture.factId,
      status: "superseded",
      version: 2
    });
    expect(after.predecessorSupport).toEqual(before.predecessorSupport);
    expect(after.currentFacts).toHaveLength(1);
    expect(after.currentFacts[0]).toMatchObject({
      id: result.replacementFactId,
      status: "current",
      version: 1
    });
    expect(after.currentSupport).toEqual(fixture.replacementClaims.map(({ claimId }) => claimId));
    expect(after.lifecycle).toHaveLength(1);
    expect(after.lifecycle[0]).toMatchObject({
      predecessor_fact_id: fixture.factId,
      successor_fact_id: result.replacementFactId,
      transition_kind: "supersede",
      reason_code: "newer_evidence"
    });
    expect(after.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
  });

  it("revokes atomically without a successor or current slot", async () => {
    const fixture = await createFixture(0);
    const before = await factSnapshot(ownerPool, fixture.factId);
    const result = await executeLifecycle(
      revokeCommand(fixture, "happy-revoke"),
      lifecycleContext(fixture)
    );
    expect(result).toEqual({ factId: fixture.factId, version: 2, status: "revoked" });
    const after = await factSnapshot(ownerPool, fixture.factId);
    expect(withoutLifecycleColumns(after.predecessor)).toEqual(
      withoutLifecycleColumns(before.predecessor)
    );
    expect(after.predecessorSupport).toEqual(before.predecessorSupport);
    expect(after.currentFacts).toEqual([]);
    expect(after.lifecycle).toHaveLength(1);
    expect(after.lifecycle[0]).toMatchObject({
      successor_fact_id: null,
      transition_kind: "revoke",
      reason_code: "no_longer_true"
    });
    expect(after.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
  });

  it("rejects stale and caller-invented coordinates without reserving residue", async () => {
    const fixture = await createFixture(1);
    const foreignFixture = await createFixture(1);
    const wrongPredicateClaim = await truthBus.execute(
      objectiveClaimCommand(
        `lifecycle-${fixtureSequence}-wrong-predicate`,
        fixture.initiativeId,
        `Wrong objective ${fixtureSequence}`,
        fixture.source,
        fixture.replacementExcerpt
      ),
      createDevSecurityContext("tenant-a-owner")
    );
    const cases: Array<B2AuthorizedDomainCommand<"fact.supersede">> = [
      {
        ...supersedeCommand(fixture, "stale-replacement"),
        payload: {
          ...supersedeCommand(fixture, "stale-replacement").payload,
          replacementClaims: fixture.replacementClaims.map((claim) => ({
            ...claim,
            expectedVersion: claim.expectedVersion + 1
          }))
        }
      },
      {
        ...supersedeCommand(fixture, "wrong-subject"),
        payload: {
          ...supersedeCommand(fixture, "wrong-subject").payload,
          subject: {
            type: "activity",
            id: generateUuidV7(),
            expectedVersion: fixture.subjectVersion
          }
        }
      },
      {
        ...supersedeCommand(fixture, "stale-subject"),
        payload: {
          ...supersedeCommand(fixture, "stale-subject").payload,
          subject: {
            ...supersedeCommand(fixture, "stale-subject").payload.subject,
            expectedVersion: fixture.subjectVersion + 1
          }
        }
      },
      {
        ...supersedeCommand(fixture, "foreign-coordinate"),
        payload: {
          ...supersedeCommand(fixture, "foreign-coordinate").payload,
          replacementClaims: foreignFixture.replacementClaims
        }
      },
      {
        ...supersedeCommand(fixture, "wrong-predicate"),
        payload: {
          ...supersedeCommand(fixture, "wrong-predicate").payload,
          replacementClaims: [{ claimId: wrongPredicateClaim.claimId, expectedVersion: 1 }]
        }
      }
    ];
    for (const command of cases) {
      await expect(executeLifecycle(command, lifecycleContext(fixture))).rejects.toBeInstanceOf(
        TruthLedgerConflictError
      );
    }
    const wrongSpaceOutcome = await settle(
      executeLifecycle(supersedeCommand(fixture, "wrong-space-context"), {
        ...lifecycleContext(fixture),
        requestedSpaceIds: [devFixtures.rootSpaceA]
      })
    );
    expect(wrongSpaceOutcome.status).toBe("rejected");
    if (wrongSpaceOutcome.status !== "rejected") {
      throw new Error("Wrong-Space lifecycle execution unexpectedly succeeded");
    }
    expect(wrongSpaceOutcome.error).toBeInstanceOf(TruthLedgerConflictError);
    expect(String(wrongSpaceOutcome.error)).toBe(
      "TruthLedgerConflictError: Truth command precondition failed"
    );
    const residue = await lifecycleResidue(
      ownerPool,
      fixture,
      cases.map(({ idempotencyKey }) => idempotencyKey).concat("wrong-space-context")
    );
    expect(residue).toEqual({
      predecessorStatus: "current",
      predecessorVersion: 1,
      replacementStatuses: ["proposed"],
      successors: 0,
      lifecycle: 0,
      commands: 0,
      audits: 0,
      outbox: 0
    });
  });

  it("rejects a stale Fact status/version after one winner", async () => {
    const fixture = await createFixture(1);
    await executeLifecycle(
      supersedeCommand(fixture, "stale-fact-winner"),
      lifecycleContext(fixture)
    );
    await expect(
      executeLifecycle(revokeCommand(fixture, "stale-fact-loser"), lifecycleContext(fixture))
    ).rejects.toBeInstanceOf(TruthLedgerConflictError);
    const effects = await commandEffectCounts(ownerPool, ["stale-fact-loser"]);
    expect(effects).toEqual({ commands: 0, audits: 0, outbox: 0 });
  });

  it("returns the completed result on replay and rejects payload drift with no new writes", async () => {
    const fixture = await createFixture(1);
    const command = supersedeCommand(fixture, "supersede-replay");
    const first = await executeLifecycle(command, lifecycleContext(fixture));
    const before = await factSnapshot(ownerPool, fixture.factId);
    const replay = await executeLifecycle(command, lifecycleContext(fixture));
    expect(replay).toEqual(first);
    expect(await factSnapshot(ownerPool, fixture.factId)).toEqual(before);

    const drift = {
      ...command,
      payload: {
        ...command.payload,
        reason: { code: "accepted_value_changed" as const, rationale: "Drifted payload." }
      }
    };
    await expect(executeLifecycle(drift, lifecycleContext(fixture))).rejects.toBeInstanceOf(
      TruthLedgerConflictError
    );
    expect(await factSnapshot(ownerPool, fixture.factId)).toEqual(before);
  });

  it.each([
    ["double supersede", "supersede", "supersede"],
    ["supersede versus revoke", "supersede", "revoke"],
    ["double revoke", "revoke", "revoke"]
  ] as const)("serializes %s without duplicate effects or a hang", async (_name, left, right) => {
    const fixture = await createFixture([left, right].includes("supersede") ? 1 : 0);
    const caseKey = _name.replaceAll(" ", "-");
    const leftCommand =
      left === "supersede"
        ? supersedeCommand(fixture, `concurrent-${caseKey}-left`)
        : revokeCommand(fixture, `concurrent-${caseKey}-left`);
    const rightCommand =
      right === "supersede"
        ? supersedeCommand(fixture, `concurrent-${caseKey}-right`)
        : revokeCommand(fixture, `concurrent-${caseKey}-right`);
    const leftOutcome = settle(executeLifecycle(leftCommand, lifecycleContext(fixture)));
    const rightOutcome = settle(executeLifecycle(rightCommand, lifecycleContext(fixture)));
    const outcomes = await withDeadline(Promise.all([leftOutcome, rightOutcome]), 10_000);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const snapshot = await factSnapshot(ownerPool, fixture.factId);
    expect(snapshot.lifecycle).toHaveLength(1);
    expect(snapshot.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
    expect(snapshot.currentFacts.length).toBeLessThanOrEqual(1);
  });

  it("refreshes a tightened Space after successful locked authorization and persists exact classification", async () => {
    const fixture = await createFixture(1);
    const context = {
      ...lifecycleContext(fixture),
      dataClassCeiling: "confidential" as const
    };
    const key = `classification-refresh-${fixtureSequence}`;
    let release!: () => void;
    let signalPrelocked!: () => void;
    const prelocked = new Promise<void>((resolve) => {
      signalPrelocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let authorityMutationCompleted = false;
    let refreshObserved = false;
    const outcome = settle(
      executeLifecycle(supersedeCommand(fixture, key), context, {
        afterPrelock: async () => {
          signalPrelocked();
          await gate;
        },
        afterPostAuthorizationRefresh: async (target) => {
          refreshObserved = true;
          expect(target.subjectAccessClass).toBe("confidential");
        }
      })
    );
    try {
      await withDeadline(prelocked, 5_000, "Classification refresh prelock was not reached");
      await withDeadline(
        runOwnerAuthorityMutation(
          "UPDATE access.spaces SET access_class = 'confidential' WHERE id = $1",
          [fixture.spaceId]
        ),
        3_000,
        "Space classification mutation unexpectedly blocked before authorization"
      );
      authorityMutationCompleted = true;
      expect(authorityMutationCompleted).toBe(true);
      release();
      const settled = await withDeadline(
        outcome,
        10_000,
        "Classification refresh lifecycle outcome timed out"
      );
      expect(settled.status).toBe("fulfilled");
      if (settled.status !== "fulfilled") throw settled.error;
      expect(refreshObserved).toBe(true);
      const snapshot = await factSnapshot(ownerPool, fixture.factId);
      expect(snapshot.predecessor).toMatchObject({ status: "superseded", version: 2 });
      expect(snapshot.predecessorSupport).toEqual([fixture.priorClaimId]);
      expect(snapshot.currentFacts).toHaveLength(1);
      expect(snapshot.currentFacts[0]).toMatchObject({
        id: settled.value.replacementFactId,
        status: "current",
        version: 1,
        access_class: "confidential"
      });
      expect(snapshot.currentSupport).toEqual(
        fixture.replacementClaims.map(({ claimId }) => claimId)
      );
      expect(snapshot.lifecycle).toHaveLength(1);
      expect(snapshot.lifecycle[0]).toMatchObject({
        predecessor_fact_id: fixture.factId,
        successor_fact_id: settled.value.replacementFactId,
        transition_kind: "supersede"
      });
      expect(snapshot.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
    } finally {
      release();
    }
  });

  it("reaches the database backstop and rolls back a forced lower-class successor exactly", async () => {
    const fixture = await createFixture(1);
    const key = `classification-backstop-${fixtureSequence}`;
    const context = {
      ...lifecycleContext(fixture),
      dataClassCeiling: "confidential" as const
    };
    let backstopReached = false;
    let backstopMessage = "";
    try {
      await runOwnerAuthorityMutation(
        "UPDATE access.spaces SET access_class = 'confidential' WHERE id = $1",
        [fixture.spaceId]
      );
      const outcome = await settle(
        executeLifecycle(supersedeCommand(fixture, key), context, {
          forceSuccessorAccessClassAtDatabaseBoundary: "workspace",
          onDatabaseBackstopRejected: (error) => {
            backstopReached = true;
            backstopMessage = error instanceof Error ? error.message : String(error);
          }
        })
      );
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("Lower-class successor unexpectedly crossed the database backstop");
      }
      expect(outcome.error).toBeInstanceOf(TruthLedgerConflictError);
      expect(String(outcome.error)).toBe(
        "TruthLedgerConflictError: Truth command precondition failed"
      );
      expect(backstopReached).toBe(true);
      expect(backstopMessage).toContain("fact access class is below current Space classification");
      expect(await lifecycleResidue(ownerPool, fixture, [key])).toEqual({
        predecessorStatus: "current",
        predecessorVersion: 1,
        replacementStatuses: ["proposed"],
        successors: 0,
        lifecycle: 0,
        commands: 0,
        audits: 0,
        outbox: 0
      });
    } finally {
      await runOwnerAuthorityMutation(
        "UPDATE access.spaces SET access_class = 'workspace' WHERE id = $1",
        [fixture.spaceId]
      );
    }
  });

  it.each([
    "owner change",
    "Space archive",
    "classification tightening",
    "Membership suspension",
    "User disable",
    "direct grant removal",
    "inherited grant removal",
    "inherited path restriction"
  ] as const)("reauthorizes after prelock when %s races", async (race) => {
    const viewerRace = race.includes("grant") || race.includes("path");
    const fixture = await createFixture(1);
    const caseKey = race.replaceAll(" ", "-");
    if (viewerRace) await makeViewerLifecycleOwner(fixture, race !== "direct grant removal");
    const context = lifecycleContext(fixture, viewerRace ? "tenant-a-viewer" : "tenant-a-owner");
    let release!: () => void;
    let signalPrelocked!: () => void;
    const prelocked = new Promise<void>((resolve) => {
      signalPrelocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let afterPrelockReached = false;
    let authorityMutationCompleted = false;
    let restore: () => Promise<void> = async () => undefined;
    const outcome = settle(
      executeLifecycle(supersedeCommand(fixture, `authority-${caseKey}`), context, {
        afterPrelock: async () => {
          afterPrelockReached = true;
          signalPrelocked();
          await gate;
        }
      })
    );
    try {
      await withDeadline(prelocked, 5_000, "Lifecycle afterPrelock signal was not reached");
      expect(afterPrelockReached).toBe(true);
      restore = await withDeadline(
        mutateAuthorityRace(fixture, race),
        3_000,
        "Authority mutation unexpectedly blocked before authorization"
      );
      authorityMutationCompleted = true;
      expect(authorityMutationCompleted).toBe(true);
      release();
      const settled = await withDeadline(
        outcome,
        10_000,
        "Lifecycle authority-race outcome timed out after gate release"
      );
      expect(settled.status).toBe("rejected");
      const residue = await lifecycleResidue(ownerPool, fixture, [`authority-${caseKey}`]);
      expect(residue.predecessorStatus).toBe("current");
      expect(residue.lifecycle).toBe(0);
      expect(residue.commands).toBe(0);
      expect(residue.audits).toBe(0);
      expect(residue.outbox).toBe(0);
    } finally {
      release();
      await restore();
    }
  });

  it.each([
    "predecessor_update",
    "successor_insert",
    "successor_support",
    "lifecycle_insert",
    "audit",
    "outbox",
    "completion"
  ] as const)("rolls back with exact zero residue after %s failure", async (fault) => {
    const fixture = await createFixture(1);
    const key = `fault-${fault}-${fixtureSequence}`;
    let faultInjected = false;
    await expect(
      executeLifecycle(supersedeCommand(fixture, key), lifecycleContext(fixture), {
        fault,
        onFaultInjected: () => {
          faultInjected = true;
        }
      })
    ).rejects.toBeInstanceOf(Error);
    expect(faultInjected).toBe(true);
    const residue = await lifecycleResidue(ownerPool, fixture, [key]);
    expect(residue).toEqual({
      predecessorStatus: "current",
      predecessorVersion: 1,
      replacementStatuses: ["proposed"],
      successors: 0,
      lifecycle: 0,
      commands: 0,
      audits: 0,
      outbox: 0
    });
  });

  async function createFixture(replacementCount: number): Promise<LifecycleFixture> {
    fixtureSequence += 1;
    const prefix = `lifecycle-${fixtureSequence}`;
    const ownerContext = createDevSecurityContext("tenant-a-owner");
    const initiative = await accountBus.execute(
      {
        kind: "initiative.create",
        idempotencyKey: `${prefix}-initiative`,
        payload: {
          primaryOrganizationId: organizationId,
          title: `Lifecycle initiative ${fixtureSequence}`,
          typeKey: "application",
          stageKey: "exploring"
        }
      },
      ownerContext
    );
    const activity = await accountBus.execute(
      {
        kind: "activity.create",
        idempotencyKey: `${prefix}-activity`,
        payload: {
          title: `Lifecycle activity ${fixtureSequence}`,
          profileTemplateKey: "discovery",
          status: "captured",
          governingInitiativeId: initiative.initiativeId,
          organizationIds: [organizationId],
          initiativeIds: [initiative.initiativeId]
        }
      },
      ownerContext
    );
    const sourceText = `Prior outcome ${fixtureSequence}. Replacement evidence ${fixtureSequence}.`;
    const replacementExcerpt = `Replacement evidence ${fixtureSequence}`;
    const source = await accountBus.execute(
      {
        kind: "source.capture",
        idempotencyKey: `${prefix}-source`,
        payload: {
          activityId: activity.activityId,
          sourceType: "note",
          title: `Lifecycle evidence ${fixtureSequence}`,
          text: sourceText
        }
      },
      ownerContext
    );
    const snapshot = await sourceSnapshot(ownerPool, source.sourceArtifactId);
    const priorClaim = await truthBus.execute(
      claimCommand(
        `${prefix}-prior-claim`,
        activity.activityId,
        `Prior outcome ${fixtureSequence}`,
        snapshot,
        `Prior outcome ${fixtureSequence}`
      ),
      ownerContext
    );
    const accepted = await truthBus.execute(
      {
        kind: "fact.accept",
        idempotencyKey: `${prefix}-fact`,
        predicateCatalogVersion: "truth-predicate-catalog.v1",
        payload: {
          subject: { type: "activity", id: activity.activityId, expectedVersion: 1 },
          claims: [{ claimId: priorClaim.claimId, expectedVersion: 1 }],
          expectedCurrentFactId: null,
          acceptanceScope: "engagement"
        }
      },
      ownerContext
    );
    const replacementClaims = [];
    for (let index = 0; index < replacementCount; index += 1) {
      const replacement = await truthBus.execute(
        claimCommand(
          `${prefix}-replacement-${index}`,
          activity.activityId,
          `Replacement outcome ${fixtureSequence}`,
          snapshot,
          replacementExcerpt
        ),
        ownerContext
      );
      replacementClaims.push({ claimId: replacement.claimId, expectedVersion: 1 as const });
    }
    replacementClaims.sort((left, right) => left.claimId.localeCompare(right.claimId));
    return {
      factId: accepted.factId,
      spaceId: activity.spaceId,
      initiativeId: initiative.initiativeId,
      subjectId: activity.activityId,
      subjectVersion: 1,
      priorClaimId: priorClaim.claimId,
      replacementClaims,
      replacementExcerpt,
      source: snapshot
    };
  }

  async function executeLifecycle(
    commandInput: B2AuthorizedDomainCommand<"fact.supersede">,
    context: SecurityContext,
    options?: LifecycleExecutionOptions
  ): Promise<B2CommandResultMap["fact.supersede"]>;
  async function executeLifecycle(
    commandInput: B2AuthorizedDomainCommand<"fact.revoke">,
    context: SecurityContext,
    options?: LifecycleExecutionOptions
  ): Promise<B2CommandResultMap["fact.revoke"]>;
  async function executeLifecycle(
    commandInput: LifecycleCommand,
    context: SecurityContext,
    options?: LifecycleExecutionOptions
  ): Promise<LifecycleResult>;
  async function executeLifecycle(
    commandInput: LifecycleCommand,
    context: SecurityContext,
    options: LifecycleExecutionOptions = {}
  ): Promise<LifecycleResult> {
    const command = parseB2Command(commandInput) as LifecycleCommand;
    const requestHash = hashB2CommandIdentity(command);
    const transactionContext = { ...context, requestedSpaceIds: [...context.requestedSpaceIds] };
    try {
      return await withTenantTransaction(
        { pool: appPool, context: transactionContext },
        async (baseTx) => {
          await baseTx.query("SET LOCAL lock_timeout = '3s'");
          await baseTx.query("SET LOCAL statement_timeout = '8s'");
          const tx = lifecycleTestTransaction(baseTx, options);
          const ledger = new TruthLedgerRepository(tx);
          const domain = new ProductDomainTransactionRepositories(tx);
          const reservationTarget = await ledger.readFactLifecycleReservation({
            tenantId: context.tenantId,
            workspaceId: context.workspaceId,
            factId: command.payload.factId,
            expectedVersion: command.payload.expectedFactVersion
          });
          const traceparent = traceparentFor(context);
          const commandId = generateUuidV7();
          const reservation = await domain.commands.reserve({
            id: commandId,
            tenantId: context.tenantId,
            workspaceId: context.workspaceId,
            reservationSpaceId: reservationTarget.spaceId,
            commandKind: `${command.kind}.v1`,
            commandSchemaVersion: 1,
            idempotencyKey: command.idempotencyKey,
            canonicalRequestHash: requestHash,
            safeRequest: safeLifecycleRequest(command),
            actorUserId: context.actorUserId!,
            actorMembershipId: context.actorMembershipId!,
            policyVersionId: context.policyVersion,
            requestId: context.requestId,
            traceparent
          });
          if (reservation.status === "replay") {
            return parseB2CommandResult(
              command.kind,
              reservation.command.safeResponse
            ) as LifecycleResult;
          }
          const prelockedTarget = await ledger.prelockCurrentFact({
            tenantId: context.tenantId,
            workspaceId: context.workspaceId,
            factId: command.payload.factId,
            expectedVersion: command.payload.expectedFactVersion
          });
          await options.afterPrelock?.(prelockedTarget);
          const decision = await authorization.canInTransaction(
            context,
            command.kind,
            { type: "fact", id: prelockedTarget.factId },
            tx,
            { lockAuthority: true }
          );
          if (!decision.allowed) throw new TruthLedgerConflictError();
          const target = await ledger.refreshCurrentFactAfterAuthorization({
            target: prelockedTarget
          });
          await options.afterPostAuthorizationRefresh?.(target);

          let result: B2CommandResultMap["fact.supersede"] | B2CommandResultMap["fact.revoke"];
          if (command.kind === "fact.supersede") {
            if (
              command.payload.subject.type !== target.subjectType ||
              command.payload.subject.id !== target.subjectId ||
              command.payload.subject.expectedVersion !== target.subjectVersion
            ) {
              throw new TruthLedgerConflictError();
            }
            const persisted = await ledger.lockReplacementClaimsForSupersession({
              target,
              replacementClaims: command.payload.replacementClaims
            });
            const admittedClaims: Claim[] = [];
            for (const replacement of persisted) {
              const claimDecision = await authorization.canInTransaction(
                context,
                "claim.read",
                { type: "claim", id: replacement.claim.id },
                tx,
                { lockAuthority: true }
              );
              const sourceDecision = await authorization.canInTransaction(
                context,
                "source.read",
                { type: "source", id: replacement.sourceArtifactId },
                tx,
                { lockAuthority: true }
              );
              if (!claimDecision.allowed || !sourceDecision.allowed) {
                throw new TruthLedgerConflictError();
              }
              const sourceSpan = await new VerifiedClaimSourceSpanAdmission(
                tx,
                bindClaimEvidenceSnapshotLookupToTransaction(tx, ledger),
                { tenantId: context.tenantId, workspaceId: context.workspaceId }
              ).admit({
                subject: {
                  type: target.subjectType,
                  id: target.subjectId,
                  expectedVersion: target.subjectVersion
                },
                evidence: replacement.evidence
              });
              if (
                maxAccessClass(sourceSpan.effectiveAccessClass, target.subjectAccessClass) !==
                sourceSpan.effectiveAccessClass
              ) {
                throw new TruthLedgerConflictError();
              }
              admittedClaims.push(Object.freeze({ ...replacement.claim, sourceSpan }));
            }
            const timestamp = await ledger.transactionTimestamp();
            const successor = constructAcceptedFactAtTrustedBoundary({
              id: generateUuidV7(),
              claims: admittedClaims,
              subjectAccessClass: target.subjectAccessClass,
              explicitPolicyAccessClass: target.subjectAccessClass,
              acceptedByUserId: context.actorUserId!,
              acceptedByMembershipId: context.actorMembershipId!,
              acceptanceScope: target.acceptanceScope,
              authorityBasis: target.authorityBasis,
              policyVersion: context.policyVersion,
              recordedAt: timestamp,
              createdAt: timestamp,
              supersedesFactId: target.factId,
              ...(command.payload.confidenceLowering === undefined
                ? {}
                : { confidenceLowering: command.payload.confidenceLowering })
            });
            result = await ledger.supersedePrelockedFact({
              target,
              replacementFact: successor,
              lifecycleEventId: generateUuidV7(),
              commandId: reservation.commandId,
              reason: command.payload.reason,
              actorUserId: context.actorUserId!,
              actorMembershipId: context.actorMembershipId!,
              policyVersion: context.policyVersion
            });
          } else {
            result = await ledger.revokePrelockedFact({
              target,
              lifecycleEventId: generateUuidV7(),
              commandId: reservation.commandId,
              reason: command.payload.reason,
              actorUserId: context.actorUserId!,
              actorMembershipId: context.actorMembershipId!,
              policyVersion: context.policyVersion
            });
          }
          await writeLifecycleAuditAndOutbox(
            tx,
            ledger,
            context,
            reservation.commandId,
            result,
            command,
            traceparent
          );
          await domain.commands.complete({
            commandId: reservation.commandId,
            tenantId: context.tenantId,
            workspaceId: context.workspaceId,
            reservationSpaceId: reservationTarget.spaceId,
            commandKind: `${command.kind}.v1`,
            idempotencyKey: command.idempotencyKey,
            canonicalRequestHash: requestHash,
            resultResourceType: "accepted_fact",
            resultResourceId: target.factId,
            safeResponse: result
          });
          return result;
        }
      );
    } catch {
      throw new TruthLedgerConflictError();
    }
  }

  async function makeViewerLifecycleOwner(
    fixture: LifecycleFixture,
    inherited: boolean
  ): Promise<void> {
    const resourceId = inherited ? devFixtures.rootSpaceA : fixture.spaceId;
    await ownerPool.query(
      `UPDATE work.activities SET owner_person_id = $1
       WHERE tenant_id = $2 AND workspace_id = $3 AND id = $4`,
      [devFixtures.personBInTenantA, devFixtures.tenantA, devFixtures.workspaceA, fixture.subjectId]
    );
    await ownerPool.query(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id,
         relation, resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'contributor','space',$4,$5)`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        resourceId,
        inherited ? "inherited" : "direct"
      ]
    );
  }

  async function mutateAuthorityRace(
    fixture: LifecycleFixture,
    race: string
  ): Promise<() => Promise<void>> {
    if (race === "owner change") {
      await runOwnerAuthorityMutation(
        "UPDATE work.activities SET owner_person_id = $1 WHERE id = $2",
        [devFixtures.personBInTenantA, fixture.subjectId]
      );
      return async () => undefined;
    }
    if (race === "Space archive") {
      await runOwnerAuthorityMutation(
        "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
        [fixture.spaceId]
      );
      return async () => undefined;
    }
    if (race === "classification tightening") {
      await runOwnerAuthorityMutation(
        "UPDATE access.spaces SET access_class = 'confidential' WHERE id = $1",
        [fixture.spaceId]
      );
      return async () => undefined;
    }
    if (race === "Membership suspension") {
      await runOwnerAuthorityMutation(
        "UPDATE identity.memberships SET status = 'suspended' WHERE id = $1",
        [devFixtures.membershipAOwner]
      );
      return async () => {
        await runOwnerAuthorityMutation(
          "UPDATE identity.memberships SET status = 'active' WHERE id = $1",
          [devFixtures.membershipAOwner]
        );
      };
    }
    if (race === "User disable") {
      await runOwnerAuthorityMutation(
        "UPDATE identity.users SET status = 'disabled' WHERE id = $1",
        [devFixtures.userA]
      );
      return async () => {
        await runOwnerAuthorityMutation(
          "UPDATE identity.users SET status = 'active' WHERE id = $1",
          [devFixtures.userA]
        );
      };
    }
    if (race === "inherited path restriction") {
      await runOwnerAuthorityMutation(
        "UPDATE access.spaces SET inheritance_mode = 'restricted' WHERE id = $1",
        [fixture.spaceId]
      );
      return async () => undefined;
    }
    const grantSpace = race === "direct grant removal" ? fixture.spaceId : devFixtures.rootSpaceA;
    await runOwnerAuthorityMutation(
      `DELETE FROM access.access_relationships
       WHERE tenant_id = $1 AND workspace_id = $2
         AND subject_type = 'membership' AND subject_id = $3
         AND relation = 'contributor' AND resource_type = 'space' AND resource_id = $4`,
      [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.membershipAViewer, grantSpace]
    );
    return async () => undefined;
  }

  async function runOwnerAuthorityMutation(sql: string, values: readonly unknown[]): Promise<void> {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query(sql, [...values]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});

interface LifecycleFixture {
  factId: string;
  spaceId: string;
  initiativeId: string;
  subjectId: string;
  subjectVersion: number;
  priorClaimId: string;
  replacementClaims: Array<{ claimId: string; expectedVersion: 1 }>;
  replacementExcerpt: string;
  source: SourceSnapshot;
}

type LifecycleCommand =
  | B2AuthorizedDomainCommand<"fact.supersede">
  | B2AuthorizedDomainCommand<"fact.revoke">;
type LifecycleResult = B2CommandResultMap["fact.supersede"] | B2CommandResultMap["fact.revoke"];

interface SourceSnapshot {
  sourceArtifactId: string;
  sourceVersion: number;
  sourceContentHash: string;
  sourceNormalizedContentHash: string;
  sourceChunkId: string;
  normalizedText: string;
  chunkContentHash: string;
}

type LifecycleFault =
  | "predecessor_update"
  | "successor_insert"
  | "successor_support"
  | "lifecycle_insert"
  | "audit"
  | "outbox"
  | "completion";

interface LifecycleExecutionOptions {
  fault?: LifecycleFault;
  afterPrelock?: (target: PrelockedCurrentFact) => Promise<void>;
  afterPostAuthorizationRefresh?: (target: PostAuthorizationCurrentFact) => Promise<void>;
  onFaultInjected?: (fault: LifecycleFault) => void;
  forceSuccessorAccessClassAtDatabaseBoundary?: AccessClass;
  onDatabaseBackstopRejected?: (error: unknown) => void;
}

interface FactSnapshot {
  predecessor: Record<string, unknown>;
  predecessorSupport: string[];
  currentFacts: Array<Record<string, unknown>>;
  currentSupport: string[];
  lifecycle: Array<Record<string, unknown>>;
  commandEffects: { commands: number; audits: number; outbox: number };
}

function supersedeCommand(
  fixture: LifecycleFixture,
  idempotencyKey: string
): B2AuthorizedDomainCommand<"fact.supersede"> {
  return {
    kind: "fact.supersede",
    idempotencyKey,
    predicateCatalogVersion: "truth-predicate-catalog.v1",
    payload: {
      factId: fixture.factId,
      expectedFactVersion: 1,
      subject: {
        type: "activity",
        id: fixture.subjectId,
        expectedVersion: fixture.subjectVersion
      },
      replacementClaims: fixture.replacementClaims.map((claim) => ({ ...claim })),
      reason: { code: "newer_evidence", rationale: "Newer evidence replaces prior truth." }
    }
  };
}

function revokeCommand(
  fixture: LifecycleFixture,
  idempotencyKey: string
): B2AuthorizedDomainCommand<"fact.revoke"> {
  return {
    kind: "fact.revoke",
    idempotencyKey,
    predicateCatalogVersion: "truth-predicate-catalog.v1",
    payload: {
      factId: fixture.factId,
      expectedFactVersion: 1,
      reason: { code: "no_longer_true", rationale: "The accepted statement is no longer true." }
    }
  };
}

function lifecycleContext(
  fixture: LifecycleFixture,
  identity: "tenant-a-owner" | "tenant-a-viewer" = "tenant-a-owner"
): SecurityContext {
  return {
    ...createDevSecurityContext(identity),
    requestId: `fact-lifecycle-${generateUuidV7()}`,
    requestedSpaceIds: [fixture.spaceId]
  };
}

function claimCommand(
  idempotencyKey: string,
  subjectId: string,
  canonicalValue: string,
  source: SourceSnapshot,
  excerpt: string
): B2AuthorizedDomainCommand<"claim.create"> {
  const scalars = Array.from(source.normalizedText);
  const excerptScalars = Array.from(excerpt);
  const startOffset = scalars.join("").indexOf(excerpt);
  if (
    startOffset < 0 ||
    Array.from(scalars.slice(0, startOffset).join("")).length !== startOffset
  ) {
    throw new Error("Lifecycle fixture excerpt must use scalar-stable ASCII offsets");
  }
  return {
    kind: "claim.create",
    idempotencyKey,
    predicateCatalogVersion: "truth-predicate-catalog.v1",
    payload: {
      subject: { type: "activity", id: subjectId, expectedVersion: 1 },
      predicate: "activity.outcome",
      valueJson: canonicalValue,
      normalizedText: canonicalValue,
      confidence: "strong",
      evidence: {
        sourceArtifactId: source.sourceArtifactId,
        sourceChunkId: source.sourceChunkId,
        expectedSourceVersion: source.sourceVersion,
        expectedChunkVersion: 1,
        normalizationVersion: "source-normalization.v1",
        chunkingVersion: "source-chunking.v1",
        startOffset,
        endOffset: startOffset + excerptScalars.length,
        excerpt,
        sourceContentHash: source.sourceContentHash,
        sourceNormalizedContentHash: source.sourceNormalizedContentHash,
        chunkContentHash: source.chunkContentHash,
        excerptHash: sha256(excerpt)
      }
    }
  };
}

function objectiveClaimCommand(
  idempotencyKey: string,
  initiativeId: string,
  canonicalValue: string,
  source: SourceSnapshot,
  excerpt: string
): B2AuthorizedDomainCommand<"claim.create"> {
  const activityCommand = claimCommand(
    idempotencyKey,
    initiativeId,
    canonicalValue,
    source,
    excerpt
  );
  return {
    ...activityCommand,
    payload: {
      ...activityCommand.payload,
      subject: { type: "initiative", id: initiativeId, expectedVersion: 1 },
      predicate: "initiative.primary_objective",
      supportConfirmation: { confirmed: true },
      expectedPrimaryObjectiveGeneration: { kind: "empty" }
    }
  };
}

async function sourceSnapshot(pool: PgPool, sourceArtifactId: string): Promise<SourceSnapshot> {
  const result = await pool.query<{
    source_artifact_id: string;
    source_version: number;
    source_content_hash: string;
    source_normalized_content_hash: string;
    source_chunk_id: string;
    normalized_text: string;
    chunk_content_hash: string;
  }>(
    `SELECT source.id AS source_artifact_id, source.version AS source_version,
            source.content_hash AS source_content_hash,
            source.normalized_content_hash AS source_normalized_content_hash,
            chunk.id AS source_chunk_id, chunk.normalized_text,
            chunk.content_hash AS chunk_content_hash
       FROM content.source_artifacts source
       JOIN content.source_chunks chunk
         ON chunk.tenant_id = source.tenant_id
        AND chunk.workspace_id = source.workspace_id
        AND chunk.space_id = source.space_id
        AND chunk.source_artifact_id = source.id
      WHERE source.id = $1 AND chunk.chunk_index = 0`,
    [sourceArtifactId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Lifecycle fixture source snapshot is unavailable");
  return {
    sourceArtifactId: row.source_artifact_id,
    sourceVersion: row.source_version,
    sourceContentHash: row.source_content_hash,
    sourceNormalizedContentHash: row.source_normalized_content_hash,
    sourceChunkId: row.source_chunk_id,
    normalizedText: row.normalized_text,
    chunkContentHash: row.chunk_content_hash
  };
}

function safeLifecycleRequest(command: LifecycleCommand): Readonly<Record<string, unknown>> {
  if (command.kind === "fact.revoke") {
    return {
      factId: command.payload.factId,
      expectedFactVersion: command.payload.expectedFactVersion,
      reason: command.payload.reason
    };
  }
  return {
    factId: command.payload.factId,
    expectedFactVersion: command.payload.expectedFactVersion,
    subject: command.payload.subject,
    replacementClaims: command.payload.replacementClaims,
    reason: command.payload.reason,
    ...(command.payload.confidenceLowering === undefined
      ? {}
      : { confidenceLowering: command.payload.confidenceLowering })
  };
}

async function writeLifecycleAuditAndOutbox(
  tx: TenantDbTransaction,
  ledger: TruthLedgerRepository,
  context: SecurityContext,
  commandId: string,
  result: LifecycleResult,
  command: LifecycleCommand,
  traceparent: string
): Promise<void> {
  // Task 4A.5 owns typed command-bus/event activation. This test-only app-role writer
  // exercises migration 0012's exact rows without widening the production bus here.
  const supersede = command.kind === "fact.supersede";
  const payload = supersede
    ? {
        factId: result.factId,
        factVersion: 2,
        reasonCode: command.payload.reason.code,
        replacementFactId: (result as B2CommandResultMap["fact.supersede"]).replacementFactId,
        replacementFactVersion: 1,
        status: "superseded"
      }
    : {
        factId: result.factId,
        factVersion: 2,
        reasonCode: command.payload.reason.code,
        status: "revoked"
      };
  const spaceId = (
    await ledger.readFactLifecycleReservation({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      factId: result.factId,
      expectedVersion: 1
    })
  ).spaceId;
  await tx.query(
    `INSERT INTO ops.audit_events (
       id, tenant_id, workspace_id, space_id, causation_command_id,
       action, resource_type, resource_id,
       actor_user_id, actor_membership_id, policy_version_id,
       request_id, traceparent, audit_schema_version, safe_detail
     ) VALUES ($1,$2,$3,$4,$5,$6,'accepted_fact',$7,$8,$9,$10,$11,$12,1,$13::jsonb)`,
    [
      generateUuidV7(),
      context.tenantId,
      context.workspaceId,
      spaceId,
      commandId,
      command.kind,
      result.factId,
      context.actorUserId,
      context.actorMembershipId,
      context.policyVersion,
      context.requestId,
      traceparent,
      JSON.stringify(payload)
    ]
  );
  const relayServicePrincipalId = await ledger.relayPrincipalForSpace(
    context.tenantId,
    context.workspaceId,
    spaceId
  );
  await tx.query(
    `INSERT INTO ops.product_outbox_events (
       id, tenant_id, workspace_id, space_id,
       relay_service_principal_id, policy_version_id,
       event_type, event_schema_version, payload_schema_version,
       aggregate_type, aggregate_id, aggregate_version, causation_command_id,
       payload, request_id, traceparent
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,'accepted_fact',$8,2,$9,$10::jsonb,$11,$12)`,
    [
      generateUuidV7(),
      context.tenantId,
      context.workspaceId,
      spaceId,
      relayServicePrincipalId,
      context.policyVersion,
      supersede ? "fact.superseded" : "fact.revoked",
      result.factId,
      commandId,
      JSON.stringify(payload),
      context.requestId,
      traceparent
    ]
  );
}

function lifecycleTestTransaction(
  transaction: TenantDbTransaction,
  options: LifecycleExecutionOptions
): TenantDbTransaction {
  if (!options.fault && options.forceSuccessorAccessClassAtDatabaseBoundary === undefined) {
    return transaction;
  }
  return {
    client: transaction.client,
    query: async (sql: string, values?: readonly unknown[]) => {
      let result;
      if (
        options.forceSuccessorAccessClassAtDatabaseBoundary !== undefined &&
        compact(sql).startsWith("INSERT INTO truth.accepted_facts") &&
        values !== undefined
      ) {
        const forcedValues = [...values];
        forcedValues[19] = options.forceSuccessorAccessClassAtDatabaseBoundary;
        try {
          result = await transaction.query(sql, forcedValues);
        } catch (error) {
          options.onDatabaseBackstopRejected?.(error);
          throw error;
        }
      } else {
        result = await transaction.query(sql, values);
      }
      if (options.fault !== undefined && matchesFaultBoundary(sql, options.fault)) {
        options.onFaultInjected?.(options.fault);
        throw new Error(`Injected lifecycle fault: ${options.fault}`);
      }
      return result;
    }
  } as TenantDbTransaction;
}

function matchesFaultBoundary(sql: string, fault: LifecycleFault): boolean {
  const normalized = compact(sql);
  switch (fault) {
    case "predecessor_update":
      return normalized.startsWith("UPDATE truth.accepted_facts");
    case "successor_insert":
      return normalized.startsWith("INSERT INTO truth.accepted_facts");
    case "successor_support":
      return normalized.startsWith("INSERT INTO truth.fact_claims");
    case "lifecycle_insert":
      return normalized.startsWith("INSERT INTO truth.fact_lifecycle_events");
    case "audit":
      return normalized.startsWith("INSERT INTO ops.audit_events");
    case "outbox":
      return normalized.startsWith("INSERT INTO ops.product_outbox_events");
    case "completion":
      return (
        normalized.startsWith("UPDATE ops.domain_command_records") &&
        normalized.includes("SET state = 'completed'")
      );
  }
}

async function factSnapshot(pool: PgPool, predecessorFactId: string): Promise<FactSnapshot> {
  const result = await pool.query<{
    predecessor: Record<string, unknown>;
    predecessor_support: string[];
    current_facts: Array<Record<string, unknown>>;
    current_support: string[];
    lifecycle: Array<Record<string, unknown>>;
    commands: number;
    audits: number;
    outbox: number;
  }>(
    `WITH predecessor AS (
       SELECT * FROM truth.accepted_facts WHERE id = $1
     ), lifecycle_commands AS (
       SELECT causation_command_id FROM truth.fact_lifecycle_events
        WHERE predecessor_fact_id = $1
     )
     SELECT
       (SELECT to_jsonb(predecessor) FROM predecessor) AS predecessor,
       COALESCE((SELECT jsonb_agg(claim_id::text ORDER BY claim_id)
         FROM truth.fact_claims WHERE fact_id = $1), '[]'::jsonb) AS predecessor_support,
       COALESCE((SELECT jsonb_agg(to_jsonb(fact) ORDER BY fact.id)
         FROM truth.accepted_facts fact, predecessor
        WHERE fact.tenant_id = predecessor.tenant_id
          AND fact.workspace_id = predecessor.workspace_id
          AND fact.space_id = predecessor.space_id
          AND fact.subject_type = predecessor.subject_type
          AND fact.subject_id = predecessor.subject_id
          AND fact.predicate = predecessor.predicate
          AND fact.status = 'current'), '[]'::jsonb) AS current_facts,
       COALESCE((SELECT jsonb_agg(support.claim_id::text ORDER BY support.claim_id)
         FROM truth.fact_claims support
         JOIN truth.accepted_facts fact ON fact.id = support.fact_id
         JOIN predecessor ON predecessor.tenant_id = fact.tenant_id
          AND predecessor.workspace_id = fact.workspace_id
          AND predecessor.space_id = fact.space_id
          AND predecessor.subject_type = fact.subject_type
          AND predecessor.subject_id = fact.subject_id
          AND predecessor.predicate = fact.predicate
        WHERE fact.status = 'current'), '[]'::jsonb) AS current_support,
       COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
         FROM truth.fact_lifecycle_events event
        WHERE event.predecessor_fact_id = $1), '[]'::jsonb) AS lifecycle,
       (SELECT count(*)::integer FROM ops.domain_command_records command
         WHERE command.id IN (SELECT causation_command_id FROM lifecycle_commands)) AS commands,
       (SELECT count(*)::integer FROM ops.audit_events audit
         WHERE audit.causation_command_id IN
           (SELECT causation_command_id FROM lifecycle_commands)) AS audits,
       (SELECT count(*)::integer FROM ops.product_outbox_events event
         WHERE event.causation_command_id IN
           (SELECT causation_command_id FROM lifecycle_commands)) AS outbox`,
    [predecessorFactId]
  );
  const row = result.rows[0];
  if (!row?.predecessor) throw new Error("Lifecycle Fact snapshot is unavailable");
  return {
    predecessor: row.predecessor,
    predecessorSupport: row.predecessor_support,
    currentFacts: row.current_facts,
    currentSupport: row.current_support,
    lifecycle: row.lifecycle,
    commandEffects: { commands: row.commands, audits: row.audits, outbox: row.outbox }
  };
}

async function lifecycleResidue(
  pool: PgPool,
  fixture: LifecycleFixture,
  idempotencyKeys: readonly string[]
) {
  const result = await pool.query<{
    predecessor_status: string;
    predecessor_version: number;
    replacement_statuses: string[];
    successors: number;
    lifecycle: number;
    commands: number;
    audits: number;
    outbox: number;
  }>(
    `SELECT
       (SELECT status FROM truth.accepted_facts WHERE id = $1) AS predecessor_status,
       (SELECT version FROM truth.accepted_facts WHERE id = $1) AS predecessor_version,
       COALESCE((SELECT jsonb_agg(status ORDER BY id) FROM truth.claims
         WHERE id = ANY($2::uuid[])), '[]'::jsonb) AS replacement_statuses,
       (SELECT count(*)::integer FROM truth.accepted_facts fact
         WHERE fact.id <> $1 AND fact.last_causation_command_id IN (
           SELECT id FROM ops.domain_command_records WHERE idempotency_key = ANY($3::text[])
         )) AS successors,
       (SELECT count(*)::integer FROM truth.fact_lifecycle_events
         WHERE predecessor_fact_id = $1) AS lifecycle,
       (SELECT count(*)::integer FROM ops.domain_command_records
         WHERE idempotency_key = ANY($3::text[])) AS commands,
       (SELECT count(*)::integer FROM ops.audit_events audit WHERE audit.causation_command_id IN (
         SELECT id FROM ops.domain_command_records WHERE idempotency_key = ANY($3::text[])
       )) AS audits,
       (SELECT count(*)::integer FROM ops.product_outbox_events event
         WHERE event.causation_command_id IN (
           SELECT id FROM ops.domain_command_records WHERE idempotency_key = ANY($3::text[])
         )) AS outbox`,
    [fixture.factId, fixture.replacementClaims.map(({ claimId }) => claimId), [...idempotencyKeys]]
  );
  const row = result.rows[0]!;
  return {
    predecessorStatus: row.predecessor_status,
    predecessorVersion: row.predecessor_version,
    replacementStatuses: row.replacement_statuses,
    successors: row.successors,
    lifecycle: row.lifecycle,
    commands: row.commands,
    audits: row.audits,
    outbox: row.outbox
  };
}

async function commandEffectCounts(pool: PgPool, idempotencyKeys: readonly string[]) {
  const result = await pool.query<{ commands: number; audits: number; outbox: number }>(
    `SELECT
       (SELECT count(*)::integer FROM ops.domain_command_records
         WHERE idempotency_key = ANY($1::text[])) AS commands,
       (SELECT count(*)::integer FROM ops.audit_events WHERE causation_command_id IN (
         SELECT id FROM ops.domain_command_records WHERE idempotency_key = ANY($1::text[])
       )) AS audits,
       (SELECT count(*)::integer FROM ops.product_outbox_events WHERE causation_command_id IN (
         SELECT id FROM ops.domain_command_records WHERE idempotency_key = ANY($1::text[])
       )) AS outbox`,
    [[...idempotencyKeys]]
  );
  return result.rows[0]!;
}

function withoutLifecycleColumns(row: Record<string, unknown>): Record<string, unknown> {
  const lifecycleColumns = new Set([
    "status",
    "version",
    "last_causation_command_id",
    "updated_at"
  ]);
  return Object.fromEntries(
    Object.entries(row).filter(([column]) => !lifecycleColumns.has(column))
  );
}

function traceparentFor(context: SecurityContext): string {
  const traceId = sha256(context.traceId).slice(0, 32);
  const spanId = sha256(`${context.requestId}:${context.traceId}:fact-lifecycle`).slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function settle<T>(
  promise: Promise<T>
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; error: unknown }> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error })
  );
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage = "Lifecycle concurrency proof timed out"
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lockedFactRow() {
  return {
    id: factId,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    version: 1,
    status: "current",
    space_id: spaceId,
    subject_type: "activity",
    subject_id: subjectId,
    subject_version: 1,
    predicate: "activity.outcome",
    access_class: "workspace",
    space_access_class: "workspace",
    acceptance_scope: "engagement",
    authority_basis: "activity_owner",
    context_actor_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    context_actor_membership_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
    context_policy_version: "dev-policy-v1"
  };
}

function compact(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function transactionStub(
  query: (sql: string, values?: readonly unknown[]) => { rows: unknown[] }
): TenantDbTransaction {
  return {
    client: {} as TenantDbTransaction["client"],
    query: async (sql: string, values?: readonly unknown[]) => {
      const result = query(sql, values);
      return result;
    }
  } as unknown as TenantDbTransaction;
}
