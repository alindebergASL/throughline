import { createHash } from "node:crypto";
import { AccountOperationsDomainCommandBus } from "../../account-operations/src/domain-command-bus.js";
import type {
  AccessClass,
  B2AuthorizedDomainCommand,
  B2CommandResultMap,
  SecurityContext
} from "@throughline/core-types";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  provisionWorkspaceProductRelayPrincipal,
  seedWaveA2DeterministicData,
  withTenantTransaction,
  type PgPool,
  type PgPoolClient
} from "@throughline/db";
import {
  PostgresAuthorizationService,
  type TransactionAwareAuthorizationService
} from "@throughline/authorization";
import { createDevSecurityContext, devFixtures, generateUuidV7 } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { B2CommandValidationError } from "./command-schemas.js";
import { TruthLedgerDomainCommandBus } from "./domain-command-bus.js";
import { TruthLedgerConflictError } from "./repository.js";

const ownerDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const connectedSuite = ownerDatabaseUrl && appDatabaseUrl ? describe.sequential : describe.skip;
const genericConflict = "TruthLedgerConflictError: Truth command precondition failed";

connectedSuite("Ordinary Fact lifecycle durable command bus", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let accountBus: AccountOperationsDomainCommandBus;
  let truthBus: TruthLedgerDomainCommandBus;
  let organizationId: string;
  let fixtureSequence = 0;

  beforeAll(async () => {
    if (!ownerDatabaseUrl || !appDatabaseUrl) {
      throw new Error("Fact lifecycle command-bus tests require both explicit test DSNs");
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
    const organization = await accountBus.execute(
      {
        kind: "organization.create",
        idempotencyKey: "fact-lifecycle-bus-organization",
        payload: { name: "Lifecycle Bus Organization", domains: ["lifecycle-bus.test"] }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    organizationId = organization.organizationId;
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it("executes lifecycle commands only under the restricted application role", async () => {
    const role = await appPool.query<{ current_user: string }>(
      "SELECT current_user AS current_user"
    );
    expect(role.rows[0]?.current_user).toBe("throughline_app");

    const fixture = await createFixture(1);
    const ownerRoleBus = new TruthLedgerDomainCommandBus(ownerPool);
    const outcome = await settle(
      ownerRoleBus.execute(supersedeCommand(fixture, "owner-role-denied"), context(fixture))
    );

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected")
      throw new Error("Owner-role lifecycle unexpectedly executed");
    expect(String(outcome.error)).toBe(genericConflict);
    expect(await residue(fixture, ["owner-role-denied"])).toEqual(cleanResidue(1));
  });

  it("supersedes a current Fact atomically through the durable command boundary", async () => {
    const fixture = await createFixture(2);
    const before = await snapshot(fixture.factId);

    const result = await execute(supersedeCommand(fixture, "bus-supersede"), context(fixture));

    expect(result).toMatchObject({
      factId: fixture.factId,
      version: 2,
      status: "superseded",
      replacementFactVersion: 1,
      replacementFactStatus: "current"
    });
    const after = await snapshot(fixture.factId);
    expect(withoutLifecycleColumns(after.predecessor)).toEqual(
      withoutLifecycleColumns(before.predecessor)
    );
    expect(after.predecessor).toMatchObject({ status: "superseded", version: 2 });
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
      from_status: "current",
      to_status: "superseded",
      reason_code: "newer_evidence",
      reason_rationale: "Newer evidence replaces prior truth."
    });
    expect(after.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
    expect(after.audits[0]).toMatchObject({
      action: "fact.supersede",
      resource_type: "accepted_fact",
      resource_id: fixture.factId,
      safe_detail: {
        factId: fixture.factId,
        factVersion: 2,
        reasonCode: "newer_evidence",
        replacementFactId: result.replacementFactId,
        replacementFactVersion: 1,
        status: "superseded"
      }
    });
    expect(after.outbox[0]).toMatchObject({
      event_type: "fact.superseded",
      aggregate_type: "accepted_fact",
      aggregate_id: fixture.factId,
      aggregate_version: 2,
      payload: {
        factId: fixture.factId,
        factVersion: 2,
        reasonCode: "newer_evidence",
        replacementFactId: result.replacementFactId,
        replacementFactVersion: 1,
        status: "superseded"
      }
    });
    expect(after.commands[0]).toMatchObject({
      command_kind: "fact.supersede.v1",
      state: "completed",
      reservation_space_id: fixture.spaceId,
      result_resource_type: "accepted_fact",
      result_resource_id: fixture.factId,
      safe_response: result
    });
  });

  it("revokes a current Fact atomically without a successor or current slot", async () => {
    const fixture = await createFixture(0);
    const before = await snapshot(fixture.factId);

    const result = await execute(revokeCommand(fixture, "bus-revoke"), context(fixture));

    expect(result).toEqual({ factId: fixture.factId, version: 2, status: "revoked" });
    const after = await snapshot(fixture.factId);
    expect(withoutLifecycleColumns(after.predecessor)).toEqual(
      withoutLifecycleColumns(before.predecessor)
    );
    expect(after.predecessorSupport).toEqual(before.predecessorSupport);
    expect(after.currentFacts).toEqual([]);
    expect(after.lifecycle).toHaveLength(1);
    expect(after.lifecycle[0]).toMatchObject({
      successor_fact_id: null,
      transition_kind: "revoke",
      to_status: "revoked",
      reason_code: "no_longer_true"
    });
    expect(after.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
    expect(after.audits[0]).toMatchObject({
      action: "fact.revoke",
      safe_detail: {
        factId: fixture.factId,
        factVersion: 2,
        reasonCode: "no_longer_true",
        status: "revoked"
      }
    });
    expect(after.outbox[0]).toMatchObject({
      event_type: "fact.revoked",
      aggregate_version: 2,
      payload: {
        factId: fixture.factId,
        factVersion: 2,
        reasonCode: "no_longer_true",
        status: "revoked"
      }
    });
  });

  it("returns the durable result on replay and rejects payload drift without new effects", async () => {
    const fixture = await createFixture(1);
    const command = supersedeCommand(fixture, "bus-supersede-replay");

    const first = await execute(command, context(fixture));
    const after = await snapshot(fixture.factId);
    const replay = await execute(command, context(fixture));

    expect(replay).toEqual(first);
    expect(await snapshot(fixture.factId)).toEqual(after);
    expect(after.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });

    const drift = {
      ...command,
      payload: {
        ...command.payload,
        reason: { code: "accepted_value_changed" as const, rationale: "Drifted payload." }
      }
    };
    const outcome = await settle(execute(drift, context(fixture)));
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Lifecycle payload drift unexpectedly ran");
    expect(String(outcome.error)).toBe(genericConflict);
    expect(await snapshot(fixture.factId)).toEqual(after);
  });

  it("rejects stale, forged, and cross-Space lifecycle inputs generically with zero residue", async () => {
    const fixture = await createFixture(1);
    const foreign = await createFixture(1);
    const baseline = supersedeCommand(fixture, "unused");
    const cases: Array<{ key: string; command: B2AuthorizedDomainCommand<"fact.supersede"> }> = [
      {
        key: "absent-fact",
        command: {
          ...baseline,
          idempotencyKey: "absent-fact",
          payload: { ...baseline.payload, factId: generateUuidV7() }
        }
      },
      {
        key: "stale-fact-version",
        command: {
          ...baseline,
          idempotencyKey: "stale-fact-version",
          payload: { ...baseline.payload, expectedFactVersion: 2 }
        }
      },
      {
        key: "forged-subject",
        command: {
          ...baseline,
          idempotencyKey: "forged-subject",
          payload: {
            ...baseline.payload,
            subject: { type: "activity", id: generateUuidV7(), expectedVersion: 1 }
          }
        }
      },
      {
        key: "stale-subject-version",
        command: {
          ...baseline,
          idempotencyKey: "stale-subject-version",
          payload: {
            ...baseline.payload,
            subject: { ...baseline.payload.subject, expectedVersion: 2 }
          }
        }
      },
      {
        key: "stale-replacement-version",
        command: {
          ...baseline,
          idempotencyKey: "stale-replacement-version",
          payload: {
            ...baseline.payload,
            replacementClaims: fixture.replacementClaims.map((claim) => ({
              ...claim,
              expectedVersion: 2
            }))
          }
        }
      },
      {
        key: "foreign-replacement-claims",
        command: {
          ...baseline,
          idempotencyKey: "foreign-replacement-claims",
          payload: { ...baseline.payload, replacementClaims: foreign.replacementClaims }
        }
      }
    ];

    for (const { command } of cases) {
      const outcome = await settle(execute(command, context(fixture)));
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new Error("Forged lifecycle input unexpectedly ran");
      expect(outcome.error).toBeInstanceOf(TruthLedgerConflictError);
      expect(String(outcome.error)).toBe(genericConflict);
    }

    expect(
      await residue(
        fixture,
        cases.map(({ key }) => key)
      )
    ).toEqual(cleanResidue(1));
    expect(await residue(foreign, ["foreign-replacement-claims"])).toEqual(cleanResidue(1));
  });

  it("reserves at the Fact's exact Space instead of any caller-supplied scope", async () => {
    const fixture = await createFixture(1);

    const result = await execute(supersedeCommand(fixture, "caller-supplied-scope"), {
      ...context(fixture),
      requestedSpaceIds: [devFixtures.rootSpaceA, devFixtures.restrictedSpaceA]
    });

    const after = await snapshot(fixture.factId);
    expect(result.factId).toBe(fixture.factId);
    expect(after.commands).toHaveLength(1);
    expect(after.commands[0]).toMatchObject({
      command_kind: "fact.supersede.v1",
      reservation_space_id: fixture.spaceId,
      state: "completed"
    });
    expect(after.audits[0]).toMatchObject({ space_id: fixture.spaceId });
    expect(after.outbox[0]).toMatchObject({ space_id: fixture.spaceId });
  });

  it("fails a supersession that names deferred conflict lifecycle closed before any connection", async () => {
    const fixture = await createFixture(1);
    const baseline = supersedeCommand(fixture, "conflict-reference");
    const command = {
      ...baseline,
      payload: {
        ...baseline.payload,
        conflict: { conflictId: generateUuidV7(), expectedVersion: 1 }
      }
    } as B2AuthorizedDomainCommand<"fact.supersede">;

    await expect(execute(command, context(fixture))).rejects.toBeInstanceOf(
      B2CommandValidationError
    );
    expect(await residue(fixture, ["conflict-reference"])).toEqual(cleanResidue(1));
  });

  it.each([
    ["a service principal", "tenant-a-service"],
    ["an agent principal", "tenant-a-agent"],
    ["a non-owner workspace admin", "tenant-a-viewer"],
    ["a foreign tenant member", "tenant-b-viewer"]
  ] as const)("denies %s with the same generic lifecycle conflict", async (_name, identity) => {
    const fixture = await createFixture(1);
    const key = `denied-${identity}-${fixtureSequence}`;
    let restore: () => Promise<void> = async () => undefined;
    if (identity === "tenant-a-viewer") restore = await promoteViewerToSpaceAdmin(fixture);
    try {
      const actorContext: SecurityContext = {
        ...createDevSecurityContext(identity),
        requestId: `fact-lifecycle-bus-${generateUuidV7()}`,
        requestedSpaceIds: [fixture.spaceId]
      };
      const outcome = await settle(execute(supersedeCommand(fixture, key), actorContext));

      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new Error("Unauthorized lifecycle unexpectedly ran");
      expect(outcome.error).toBeInstanceOf(TruthLedgerConflictError);
      expect(String(outcome.error)).toBe(genericConflict);
      expect(await residue(fixture, [key])).toEqual(cleanResidue(1));
    } finally {
      await restore();
    }
  });

  it.each(["owner change", "Space archive", "Membership suspension", "User disable"] as const)(
    "denies the lifecycle command when %s races the prelock seam",
    async (race) => {
      const fixture = await createFixture(1);
      const key = `race-${race.replaceAll(" ", "-")}-${fixtureSequence}`;
      const gate = openGate();
      let seamReached = false;
      let restore: () => Promise<void> = async () => undefined;
      const outcome = settle(
        execute(supersedeCommand(fixture, key), context(fixture), {
          beforeLifecycleAuthorization: async () => {
            seamReached = true;
            gate.arrive();
            await gate.released;
          }
        })
      );
      try {
        await withDeadline(gate.arrived, 5_000, "Lifecycle prelock seam was not reached");
        expect(seamReached).toBe(true);
        restore = await mutateAuthority(fixture, race);
        gate.release();
        const settled = await withDeadline(outcome, 10_000, "Lifecycle authority race timed out");

        expect(settled.status).toBe("rejected");
        if (settled.status !== "rejected") throw new Error("Raced lifecycle unexpectedly executed");
        expect(String(settled.error)).toBe(genericConflict);
        expect(await residue(fixture, [key])).toEqual(cleanResidue(1));
      } finally {
        gate.release();
        await outcome;
        await restore();
      }
    }
  );

  it("promotes the successor to a Space classification tightened at the prelock seam", async () => {
    const fixture = await createFixture(1);
    const key = `classification-refresh-${fixtureSequence}`;
    const gate = openGate();
    let seamReached = false;
    const outcome = settle(
      execute(
        supersedeCommand(fixture, key),
        { ...context(fixture), dataClassCeiling: "confidential" as const },
        {
          beforeLifecycleAuthorization: async () => {
            seamReached = true;
            gate.arrive();
            await gate.released;
          }
        }
      )
    );
    try {
      await withDeadline(gate.arrived, 5_000, "Lifecycle prelock seam was not reached");
      await withDeadline(
        ownerMutation("UPDATE access.spaces SET access_class = 'confidential' WHERE id = $1", [
          fixture.spaceId
        ]),
        3_000,
        "Space classification mutation unexpectedly blocked before authorization"
      );
      gate.release();
      const settled = await withDeadline(outcome, 10_000, "Classification refresh timed out");

      expect(seamReached).toBe(true);
      expect(settled.status).toBe("fulfilled");
      if (settled.status !== "fulfilled") throw settled.error;
      const after = await snapshot(fixture.factId);
      expect(after.predecessor).toMatchObject({ status: "superseded", version: 2 });
      expect(after.currentFacts).toHaveLength(1);
      expect(after.currentFacts[0]).toMatchObject({
        id: settled.value.replacementFactId,
        status: "current",
        access_class: "confidential"
      });
      expect(after.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
    } finally {
      gate.release();
      await outcome;
      await ownerMutation("UPDATE access.spaces SET access_class = 'workspace' WHERE id = $1", [
        fixture.spaceId
      ]);
    }
  });

  it("rejects a successor classified below the predecessor Fact with zero residue", async () => {
    const fixture = await createFixture(1, { priorSourceAccessClass: "confidential" });
    const key = `predecessor-classification-${fixtureSequence}`;
    const predecessorClass = await factAccessClass(fixture.factId);
    const spaceClass = await spaceAccessClass(fixture.spaceId);

    expect(predecessorClass).toBe("confidential");
    expect(spaceClass).toBe("workspace");

    const outcome = await settle(
      execute(supersedeCommand(fixture, key), {
        ...context(fixture),
        dataClassCeiling: "confidential" as const
      })
    );

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      throw new Error("Lower-class successor unexpectedly superseded a confidential Fact");
    }
    expect(outcome.error).toBeInstanceOf(TruthLedgerConflictError);
    expect(String(outcome.error)).toBe(genericConflict);
    expect(await residue(fixture, [key])).toEqual(cleanResidue(1));
    expect(await factAccessClass(fixture.factId)).toBe("confidential");
  });

  it.each(["owner change", "Space archive", "Membership suspension", "User disable"] as const)(
    "denies a durable lifecycle replay after %s removes the original actor's authority",
    async (mutation) => {
      const fixture = await createFixture(1);
      const key = `replay-${mutation.replaceAll(" ", "-")}-${fixtureSequence}`;
      const command = supersedeCommand(fixture, key);

      const first = await execute(command, context(fixture));
      const after = await snapshot(fixture.factId);
      expect(after.commandEffects).toEqual({ commands: 1, audits: 1, outbox: 1 });
      expect(after.commands[0]).toMatchObject({
        command_kind: "fact.supersede.v1",
        state: "completed"
      });

      const restore = await mutateAuthority(fixture, mutation);
      try {
        const outcome = await settle(execute(command, context(fixture)));

        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("De-authorized replay unexpectedly returned the durable result");
        }
        expect(outcome.error).toBeInstanceOf(TruthLedgerConflictError);
        expect(String(outcome.error)).toBe(genericConflict);
        expect(String(outcome.error)).not.toContain(first.replacementFactId);
        expect(await snapshot(fixture.factId)).toEqual(after);
        expect(await commandStates(key)).toEqual(["completed"]);
      } finally {
        await restore();
      }
    }
  );

  it("rejects a forced stale lower-class successor at the database backstop with zero residue", async () => {
    const fixture = await createFixture(1);
    const key = `classification-backstop-${fixtureSequence}`;
    let backstopMessage = "";
    try {
      await ownerMutation("UPDATE access.spaces SET access_class = 'confidential' WHERE id = $1", [
        fixture.spaceId
      ]);
      const outcome = await settle(
        execute(
          supersedeCommand(fixture, key),
          { ...context(fixture), dataClassCeiling: "confidential" as const },
          {
            forceSuccessorAccessClassAtDatabaseBoundary: "workspace",
            onDatabaseBackstopRejected: (error) => {
              backstopMessage = error instanceof Error ? error.message : String(error);
            }
          }
        )
      );

      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("Lower-class successor unexpectedly crossed the database backstop");
      }
      expect(String(outcome.error)).toBe(genericConflict);
      expect(backstopMessage).toContain("fact access class is below current Space classification");
      expect(await residue(fixture, [key])).toEqual(cleanResidue(1));
    } finally {
      await ownerMutation("UPDATE access.spaces SET access_class = 'workspace' WHERE id = $1", [
        fixture.spaceId
      ]);
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
    let injected: string | undefined;

    const outcome = await settle(
      execute(supersedeCommand(fixture, key), context(fixture), {
        fault,
        onFaultInjected: (boundary) => {
          injected = boundary;
        }
      })
    );

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Injected lifecycle fault did not fail");
    expect(injected).toBe(fault);
    expect(String(outcome.error)).toBe(genericConflict);
    expect(await residue(fixture, [key])).toEqual(cleanResidue(1));
  });

  async function execute<K extends "fact.supersede" | "fact.revoke">(
    command: B2AuthorizedDomainCommand<K>,
    actorContext: SecurityContext,
    options: LifecycleExecutionOptions = {}
  ): Promise<B2CommandResultMap[K]> {
    const bus = new TruthLedgerDomainCommandBus(
      instrumentedPool(appPool, options),
      instrumentedAuthorization(new PostgresAuthorizationService(appPool), options)
    );
    return bus.execute(command, actorContext);
  }

  async function createFixture(
    replacementCount: number,
    options: { priorSourceAccessClass?: AccessClass } = {}
  ): Promise<LifecycleFixture> {
    fixtureSequence += 1;
    const prefix = `lifecycle-bus-${fixtureSequence}`;
    const ownerContext = createDevSecurityContext("tenant-a-owner");
    const classifiedPrior = options.priorSourceAccessClass !== undefined;
    const priorContext = classifiedPrior
      ? { ...ownerContext, dataClassCeiling: "confidential" as const }
      : ownerContext;
    const initiative = await accountBus.execute(
      {
        kind: "initiative.create",
        idempotencyKey: `${prefix}-initiative`,
        payload: {
          primaryOrganizationId: organizationId,
          title: `Lifecycle bus initiative ${fixtureSequence}`,
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
          title: `Lifecycle bus activity ${fixtureSequence}`,
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
    const source = await accountBus.execute(
      {
        kind: "source.capture",
        idempotencyKey: `${prefix}-source`,
        payload: {
          activityId: activity.activityId,
          sourceType: "note",
          title: `Lifecycle bus evidence ${fixtureSequence}`,
          text: sourceText
        }
      },
      ownerContext
    );
    const snapshotRow = await sourceSnapshot(ownerPool, source.sourceArtifactId);
    let priorSnapshotRow = snapshotRow;
    if (classifiedPrior) {
      const classifiedSource = await accountBus.execute(
        {
          kind: "source.capture",
          idempotencyKey: `${prefix}-source-classified`,
          payload: {
            activityId: activity.activityId,
            sourceType: "note",
            title: `Lifecycle bus classified evidence ${fixtureSequence}`,
            text: `Classified capture ${fixtureSequence}. Prior outcome ${fixtureSequence}.`,
            requestedAccessClass: options.priorSourceAccessClass!
          }
        },
        priorContext
      );
      priorSnapshotRow = await sourceSnapshot(ownerPool, classifiedSource.sourceArtifactId);
    }
    const priorClaim = await truthBus.execute(
      claimCommand(
        `${prefix}-prior-claim`,
        activity.activityId,
        `Prior outcome ${fixtureSequence}`,
        priorSnapshotRow,
        `Prior outcome ${fixtureSequence}`
      ),
      priorContext
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
      priorContext
    );
    const replacementClaims: Array<{ claimId: string; expectedVersion: 1 }> = [];
    for (let index = 0; index < replacementCount; index += 1) {
      const replacement = await truthBus.execute(
        claimCommand(
          `${prefix}-replacement-${index}`,
          activity.activityId,
          `Replacement outcome ${fixtureSequence}`,
          snapshotRow,
          `Replacement evidence ${fixtureSequence}`
        ),
        ownerContext
      );
      replacementClaims.push({ claimId: replacement.claimId, expectedVersion: 1 });
    }
    replacementClaims.sort((left, right) => left.claimId.localeCompare(right.claimId));
    return {
      factId: accepted.factId,
      spaceId: activity.spaceId,
      subjectId: activity.activityId,
      subjectVersion: 1,
      priorClaimId: priorClaim.claimId,
      replacementClaims
    };
  }

  async function promoteViewerToSpaceAdmin(
    fixture: LifecycleFixture
  ): Promise<() => Promise<void>> {
    await ownerMutation("UPDATE identity.memberships SET role = 'admin' WHERE id = $1", [
      devFixtures.membershipAViewer
    ]);
    await ownerMutation(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id,
         relation, resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'contributor','space',$4,'direct')`,
      [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.membershipAViewer, fixture.spaceId]
    );
    return async () => {
      await ownerMutation(
        `DELETE FROM access.access_relationships
          WHERE tenant_id = $1 AND workspace_id = $2 AND subject_type = 'membership'
            AND subject_id = $3 AND resource_type = 'space' AND resource_id = $4`,
        [
          devFixtures.tenantA,
          devFixtures.workspaceA,
          devFixtures.membershipAViewer,
          fixture.spaceId
        ]
      );
      await ownerMutation("UPDATE identity.memberships SET role = 'viewer' WHERE id = $1", [
        devFixtures.membershipAViewer
      ]);
    };
  }

  async function mutateAuthority(
    fixture: LifecycleFixture,
    race: string
  ): Promise<() => Promise<void>> {
    if (race === "owner change") {
      await ownerMutation("UPDATE work.activities SET owner_person_id = $1 WHERE id = $2", [
        devFixtures.personBInTenantA,
        fixture.subjectId
      ]);
      return async () => undefined;
    }
    if (race === "Space archive") {
      await ownerMutation(
        "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
        [fixture.spaceId]
      );
      return async () => undefined;
    }
    if (race === "Membership suspension") {
      await ownerMutation("UPDATE identity.memberships SET status = 'suspended' WHERE id = $1", [
        devFixtures.membershipAOwner
      ]);
      return async () => {
        await ownerMutation("UPDATE identity.memberships SET status = 'active' WHERE id = $1", [
          devFixtures.membershipAOwner
        ]);
      };
    }
    await ownerMutation("UPDATE identity.users SET status = 'disabled' WHERE id = $1", [
      devFixtures.userA
    ]);
    return async () => {
      await ownerMutation("UPDATE identity.users SET status = 'active' WHERE id = $1", [
        devFixtures.userA
      ]);
    };
  }

  async function ownerMutation(sql: string, values: readonly unknown[]): Promise<void> {
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

  async function snapshot(predecessorFactId: string): Promise<LifecycleSnapshot> {
    return factSnapshot(ownerPool, predecessorFactId);
  }

  async function residue(fixture: LifecycleFixture, idempotencyKeys: readonly string[]) {
    return lifecycleResidue(ownerPool, fixture, idempotencyKeys);
  }

  async function factAccessClass(factId: string): Promise<string | undefined> {
    const result = await ownerPool.query<{ access_class: string }>(
      "SELECT access_class FROM truth.accepted_facts WHERE id = $1",
      [factId]
    );
    return result.rows[0]?.access_class;
  }

  async function spaceAccessClass(spaceId: string): Promise<string | undefined> {
    const result = await ownerPool.query<{ access_class: string }>(
      "SELECT access_class FROM access.spaces WHERE id = $1",
      [spaceId]
    );
    return result.rows[0]?.access_class;
  }

  async function commandStates(idempotencyKey: string): Promise<string[]> {
    const result = await ownerPool.query<{ state: string }>(
      "SELECT state FROM ops.domain_command_records WHERE idempotency_key = $1 ORDER BY id",
      [idempotencyKey]
    );
    return result.rows.map(({ state }) => state);
  }
});

interface LifecycleFixture {
  factId: string;
  spaceId: string;
  subjectId: string;
  subjectVersion: number;
  priorClaimId: string;
  replacementClaims: Array<{ claimId: string; expectedVersion: 1 }>;
}

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
  onFaultInjected?: (fault: LifecycleFault) => void;
  beforeLifecycleAuthorization?: () => Promise<void>;
  forceSuccessorAccessClassAtDatabaseBoundary?: AccessClass;
  onDatabaseBackstopRejected?: (error: unknown) => void;
}

interface LifecycleSnapshot {
  predecessor: Record<string, unknown>;
  predecessorSupport: string[];
  currentFacts: Array<Record<string, unknown>>;
  currentSupport: string[];
  lifecycle: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  outbox: Array<Record<string, unknown>>;
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

function context(fixture: LifecycleFixture): SecurityContext {
  return {
    ...createDevSecurityContext("tenant-a-owner"),
    requestId: `fact-lifecycle-bus-${generateUuidV7()}`,
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
  const startOffset = source.normalizedText.indexOf(excerpt);
  if (startOffset < 0) {
    throw new Error("Lifecycle bus fixture excerpt must use scalar-stable ASCII offsets");
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
        endOffset: startOffset + Array.from(excerpt).length,
        excerpt,
        sourceContentHash: source.sourceContentHash,
        sourceNormalizedContentHash: source.sourceNormalizedContentHash,
        chunkContentHash: source.chunkContentHash,
        excerptHash: sha256(excerpt)
      }
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
  if (!row) throw new Error("Lifecycle bus fixture source snapshot is unavailable");
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

function instrumentedPool(pool: PgPool, options: LifecycleExecutionOptions): PgPool {
  return {
    connect: async () => {
      const client = await pool.connect();
      const instrumented = {
        query: async (text: string, values?: readonly unknown[]) => {
          if (compact(text) === "BEGIN ISOLATION LEVEL READ COMMITTED") {
            const begun = await client.query(text);
            await client.query("SET LOCAL lock_timeout = '3s'");
            await client.query("SET LOCAL statement_timeout = '8s'");
            return begun;
          }
          const forcedClass = options.forceSuccessorAccessClassAtDatabaseBoundary;
          let result;
          if (
            forcedClass !== undefined &&
            compact(text).startsWith("INSERT INTO truth.accepted_facts") &&
            values !== undefined
          ) {
            const forcedValues = [...values];
            forcedValues[19] = forcedClass;
            try {
              result = await client.query(text, forcedValues);
            } catch (error) {
              options.onDatabaseBackstopRejected?.(error);
              throw error;
            }
          } else {
            result = await client.query(text, values === undefined ? undefined : [...values]);
          }
          if (options.fault !== undefined && matchesFaultBoundary(text, options.fault)) {
            options.onFaultInjected?.(options.fault);
            throw new Error(`Injected lifecycle fault: ${options.fault}`);
          }
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy)
      };
      return instrumented as unknown as PgPoolClient;
    }
  } as unknown as PgPool;
}

function instrumentedAuthorization(
  service: TransactionAwareAuthorizationService,
  options: LifecycleExecutionOptions
): TransactionAwareAuthorizationService {
  let lifecycleAuthorizations = 0;
  return {
    can: (context, action, resource, decisionOptions) =>
      service.can(context, action, resource, decisionOptions),
    canInTransaction: async (context, action, resource, tx, decisionOptions) => {
      if (
        (action === "fact.supersede" || action === "fact.revoke") &&
        lifecycleAuthorizations === 0
      ) {
        lifecycleAuthorizations += 1;
        await options.beforeLifecycleAuthorization?.();
      }
      return service.canInTransaction(context, action, resource, tx, decisionOptions);
    }
  };
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

async function factSnapshot(pool: PgPool, predecessorFactId: string): Promise<LifecycleSnapshot> {
  const result = await pool.query<{
    predecessor: Record<string, unknown>;
    predecessor_support: string[];
    current_facts: Array<Record<string, unknown>>;
    current_support: string[];
    lifecycle: Array<Record<string, unknown>>;
    command_records: Array<Record<string, unknown>>;
    audit_events: Array<Record<string, unknown>>;
    outbox_events: Array<Record<string, unknown>>;
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
       COALESCE((SELECT jsonb_agg(to_jsonb(command) ORDER BY command.id)
         FROM ops.domain_command_records command
        WHERE command.id IN (SELECT causation_command_id FROM lifecycle_commands)),
         '[]'::jsonb) AS command_records,
       COALESCE((SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)
         FROM ops.audit_events audit
        WHERE audit.causation_command_id IN (SELECT causation_command_id FROM lifecycle_commands)),
         '[]'::jsonb) AS audit_events,
       COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
         FROM ops.product_outbox_events event
        WHERE event.causation_command_id IN (SELECT causation_command_id FROM lifecycle_commands)),
         '[]'::jsonb) AS outbox_events`,
    [predecessorFactId]
  );
  const row = result.rows[0];
  if (!row?.predecessor) throw new Error("Lifecycle bus Fact snapshot is unavailable");
  return {
    predecessor: row.predecessor,
    predecessorSupport: row.predecessor_support,
    currentFacts: row.current_facts,
    currentSupport: row.current_support,
    lifecycle: row.lifecycle,
    commands: row.command_records,
    audits: row.audit_events,
    outbox: row.outbox_events,
    commandEffects: {
      commands: row.command_records.length,
      audits: row.audit_events.length,
      outbox: row.outbox_events.length
    }
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

function cleanResidue(replacementCount: number) {
  return {
    predecessorStatus: "current",
    predecessorVersion: 1,
    replacementStatuses: Array.from({ length: replacementCount }, () => "proposed"),
    successors: 0,
    lifecycle: 0,
    commands: 0,
    audits: 0,
    outbox: 0
  };
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

function openGate(): {
  arrived: Promise<void>;
  released: Promise<void>;
  arrive: () => void;
  release: () => void;
} {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, released, arrive, release };
}

function compact(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
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
  timeoutMessage: string
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
