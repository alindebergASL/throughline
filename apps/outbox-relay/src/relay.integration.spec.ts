import { PostgresAuthorizationService } from "@throughline/authorization";
import type { SecurityContext } from "@throughline/core-types";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  provisionTestFoundationRoles,
  RelayOutboxRepository,
  seedWaveA2DeterministicData,
  type PgPool,
  type PgPoolClient
} from "@throughline/db";
import { DEV_POLICY_VERSION, devFixtures, generateUuidV7 } from "@throughline/tenancy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeRelayRuntime, type RelayRuntimeEnvironment } from "./main.js";
import { FoundationOutboxRelay } from "./relay.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const relayUrl = process.env.TEST_RELAY_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const endpoint = process.env.FOUNDATION_SQS_ENDPOINT;
const queueUrl = process.env.FOUNDATION_SQS_QUEUE_URL;
const region = process.env.AWS_REGION;
const accessKey = process.env.AWS_ACCESS_KEY_ID;
const secretKey = process.env.AWS_SECRET_ACCESS_KEY;

const enabled = Boolean(
  ownerUrl &&
  appUrl &&
  relayUrl &&
  workerUrl &&
  endpoint &&
  queueUrl &&
  region &&
  accessKey &&
  secretKey
);
const integration = enabled ? describe.sequential : describe.skip;

interface AwsTestSdk {
  SQSClient: new (configuration: object) => {
    send(command: object): Promise<Record<string, unknown>>;
  };
  SendMessageCommand: new (input: object) => object;
  ReceiveMessageCommand: new (input: object) => object;
  DeleteMessageCommand: new (input: object) => object;
  PurgeQueueCommand: new (input: object) => object;
}

const relayAuthorityMutationCases = [
  {
    name: "tenant",
    mutateSql: "UPDATE identity.tenants SET status = 'suspended' WHERE id = $1",
    restoreSql: "UPDATE identity.tenants SET status = 'active' WHERE id = $1",
    parameters: [devFixtures.tenantA]
  },
  {
    name: "workspace",
    mutateSql: "UPDATE identity.workspaces SET status = 'archived' WHERE id = $1",
    restoreSql: "UPDATE identity.workspaces SET status = 'active' WHERE id = $1",
    parameters: [devFixtures.workspaceA]
  },
  {
    name: "policy version",
    mutateSql: `UPDATE identity.policy_versions SET status = 'retired'
                WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
    restoreSql: `UPDATE identity.policy_versions SET status = 'active'
                 WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
    parameters: [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
  },
  {
    name: "relay service principal",
    mutateSql: "UPDATE identity.service_principals SET status = 'disabled' WHERE id = $1",
    restoreSql: "UPDATE identity.service_principals SET status = 'active' WHERE id = $1",
    parameters: [devFixtures.relayServicePrincipalA]
  },
  {
    name: "Space",
    mutateSql: "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
    restoreSql: "UPDATE access.spaces SET archived_at = NULL WHERE id = $1",
    parameters: [devFixtures.restrictedSpaceA]
  },
  {
    name: "direct manager relationship",
    mutateSql: `UPDATE access.access_relationships SET relation = 'viewer'
                WHERE tenant_id = $1 AND workspace_id = $2
                  AND subject_type = 'service_principal' AND subject_id = $3
                  AND resource_type = 'space' AND resource_id = $4
                  AND relation = 'manager' AND source = 'direct'`,
    restoreSql: `UPDATE access.access_relationships SET relation = 'manager'
                 WHERE tenant_id = $1 AND workspace_id = $2
                   AND subject_type = 'service_principal' AND subject_id = $3
                   AND resource_type = 'space' AND resource_id = $4
                   AND relation = 'viewer' AND source = 'direct'`,
    parameters: [
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.relayServicePrincipalA,
      devFixtures.restrictedSpaceA
    ]
  }
] as const;

const relayFirstBarrierCases = relayAuthorityMutationCases.flatMap((authority) => [
  { authority, relayOutcome: "commit" as const },
  { authority, relayOutcome: "rollback" as const }
]);

integration("Foundation relay PostgreSQL + LocalStack integration", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let relayPool: PgPool;
  let workerPool: PgPool;
  let repository: RelayOutboxRepository;
  let sdk: AwsTestSdk;
  let sqs: InstanceType<AwsTestSdk["SQSClient"]>;
  let runtimeEnvironment: RelayRuntimeEnvironment;

  beforeAll(async () => {
    if (!enabled)
      throw new Error("Complete Foundation PostgreSQL and LocalStack environment is required");
    runtimeEnvironment = {
      TEST_RELAY_DATABASE_URL: relayUrl!,
      FOUNDATION_SQS_ENDPOINT: endpoint!,
      FOUNDATION_SQS_QUEUE_URL: queueUrl!,
      AWS_REGION: region!,
      AWS_ACCESS_KEY_ID: accessKey!,
      AWS_SECRET_ACCESS_KEY: secretKey!
    };
    const moduleName = "@aws-sdk/client-sqs";
    sdk = (await import(moduleName)) as unknown as AwsTestSdk;
    sqs = new sdk.SQSClient({
      endpoint,
      region,
      credentials: { accessKeyId: accessKey!, secretAccessKey: secretKey! }
    });
    ownerPool = createPgPool(ownerUrl!);
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, appUrl!);
    await provisionTestFoundationRoles(ownerPool, relayUrl!, workerUrl!);
    await seedWaveA2DeterministicData(ownerPool);
    appPool = createPgPool(appUrl!);
    relayPool = createPgPool(relayUrl!);
    workerPool = createPgPool(workerUrl!);
    repository = new RelayOutboxRepository(relayPool, new PostgresAuthorizationService(relayPool));
    await sqs.send(new sdk.PurgeQueueCommand({ QueueUrl: queueUrl }));
  });

  afterAll(async () => {
    await relayPool?.end();
    await workerPool?.end();
    await appPool?.end();
    await ownerPool?.end();
  });

  beforeEach(async () => {
    await ownerPool.query(
      `UPDATE ops.outbox_events
       SET terminal_failed_at = clock_timestamp(), terminal_failure_code = 'test_isolation',
           claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
       WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
         AND published_at IS NULL AND terminal_failed_at IS NULL`,
      [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.restrictedSpaceA]
    );
    await sqs.send(new sdk.PurgeQueueCommand({ QueueUrl: queueUrl }));
  });

  it("publishes one committed event and marks it only after a real SendMessage acknowledgment", async () => {
    const event = await insertCommittedEvent(ownerPool, "published");
    const runtime = await composeRelayRuntime(runtimeEnvironment);
    try {
      const result = await runtime.relay.publishNext(relayContext(), {
        claimedBy: "integration-relay",
        leaseSeconds: 30
      });
      expect(result).toMatchObject({ status: "published", eventId: event.eventId });
    } finally {
      await runtime.close();
    }
    const persisted = await ownerPool.query<{
      published_at: Date | null;
      published_message_id: string | null;
    }>("SELECT published_at, published_message_id FROM ops.outbox_events WHERE id = $1", [
      event.eventId
    ]);
    expect(persisted.rows[0]?.published_at).not.toBeNull();
    expect(persisted.rows[0]?.published_message_id).toBeTruthy();

    const message = await receiveEvent(event.eventId);
    const body = JSON.parse(message.Body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ eventId: event.eventId, jobId: event.jobId });
    expect(message.MessageAttributes).toMatchObject({
      tenantId: { StringValue: devFixtures.tenantA },
      workspaceId: { StringValue: devFixtures.workspaceA },
      spaceId: { StringValue: devFixtures.restrictedSpaceA },
      eventId: { StringValue: event.eventId },
      jobId: { StringValue: event.jobId }
    });
    expect(message.Body).not.toMatch(
      /actorUserId|servicePrincipalId|membershipIds|secretAccessKey/i
    );
  });

  it("ignores a structurally valid rogue same-scope event while publishing the exact Foundation event", async () => {
    const rogue = await insertCommittedEvent(ownerPool, "rogue", {
      eventType: "foundation.other.created.v1"
    });
    const exact = await insertCommittedEvent(ownerPool, "exact-after-rogue");
    const runtime = await composeRelayRuntime(runtimeEnvironment);
    try {
      await expect(
        runtime.relay.publishNext(relayContext(), {
          claimedBy: "integration-exact-type",
          leaseSeconds: 30
        })
      ).resolves.toMatchObject({ status: "published", eventId: exact.eventId });
    } finally {
      await runtime.close();
    }

    const persisted = await ownerPool.query<{
      id: string;
      publication_attempts: number;
      claimed_by: string | null;
      published_at: Date | null;
    }>(
      `SELECT id, publication_attempts, claimed_by, published_at
       FROM ops.outbox_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[rogue.eventId, exact.eventId]]
    );
    const byId = new Map(persisted.rows.map((row) => [row.id, row]));
    expect(byId.get(rogue.eventId)).toMatchObject({
      publication_attempts: 0,
      claimed_by: null,
      published_at: null
    });
    expect(byId.get(exact.eventId)?.published_at).not.toBeNull();
    await expect(receiveEvent(exact.eventId)).resolves.toBeTruthy();
  });

  it("records a real terminal send failure and never marks publication success", async () => {
    const event = await insertCommittedEvent(ownerPool, "terminal");
    const relay = new FoundationOutboxRelay(
      repository,
      sqs as never,
      `${endpoint}/000000000000/throughline-missing-test`,
      { create: (input) => new sdk.SendMessageCommand(input) as never }
    );
    await expect(
      relay.publishNext(relayContext(), { claimedBy: "integration-terminal", leaseSeconds: 30 })
    ).rejects.toBeTruthy();
    const persisted = await ownerPool.query<{
      published_at: Date | null;
      terminal_failed_at: Date | null;
      terminal_failure_code: string | null;
    }>(
      "SELECT published_at, terminal_failed_at, terminal_failure_code FROM ops.outbox_events WHERE id = $1",
      [event.eventId]
    );
    expect(persisted.rows[0]?.published_at).toBeNull();
    expect(persisted.rows[0]?.terminal_failed_at).not.toBeNull();
    expect(persisted.rows[0]?.terminal_failure_code).toBeTruthy();
  });

  it("records a retryable ambiguous send failure without marking publication success", async () => {
    const event = await insertCommittedEvent(ownerPool, "retryable");
    const relay = new FoundationOutboxRelay(
      repository,
      {
        send: async () => {
          throw Object.assign(new Error("injected ambiguous transport failure"), {
            name: "TimeoutError"
          });
        }
      },
      queueUrl!
    );
    await expect(
      relay.publishNext(relayContext(), { claimedBy: "integration-retry", leaseSeconds: 30 })
    ).rejects.toThrow("injected ambiguous transport failure");
    const persisted = await ownerPool.query<{
      published_at: Date | null;
      last_retry_code: string | null;
      terminal_failed_at: Date | null;
    }>(
      "SELECT published_at, last_retry_code, terminal_failed_at FROM ops.outbox_events WHERE id = $1",
      [event.eventId]
    );
    expect(persisted.rows[0]).toMatchObject({
      published_at: null,
      last_retry_code: "timeout_error",
      terminal_failed_at: null
    });
  });

  it("two concurrent relay attempts cannot both claim one row", async () => {
    const event = await insertCommittedEvent(ownerPool, "concurrent");
    const [first, second] = await Promise.all([
      repository.claimNext(relayContext(), { claimedBy: "concurrent-a", leaseSeconds: 30 }),
      repository.claimNext(relayContext(), { claimedBy: "concurrent-b", leaseSeconds: 30 })
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first ?? second)?.eventId).toBe(event.eventId);
  });

  it.each(relayFirstBarrierCases)(
    "holds $authority.name mutation behind relay authorization until relay $relayOutcome",
    async ({ authority, relayOutcome }) => {
      const event = await insertCommittedEvent(
        ownerPool,
        `relay-first-${authority.name}-${relayOutcome}`
      );
      const claimed = await repository.claimNext(relayContext(), {
        claimedBy: `relay-result-${relayOutcome}`,
        leaseSeconds: 30
      });
      expect(claimed).toMatchObject({ eventId: event.eventId });
      const realAuthorization = new PostgresAuthorizationService(relayPool);
      let releaseAuthorization!: () => void;
      const authorizationReleased = new Promise<void>((resolve) => {
        releaseAuthorization = resolve;
      });
      let authorizationReached!: () => void;
      const reachedAuthorization = new Promise<void>((resolve) => {
        authorizationReached = resolve;
      });
      const barrierAuthorization = {
        canInTransaction: async (
          ...args: Parameters<typeof realAuthorization.canInTransaction>
        ) => {
          const decision = await realAuthorization.canInTransaction(...args);
          authorizationReached();
          await authorizationReleased;
          if (relayOutcome === "rollback") throw new Error("injected relay rollback");
          return decision;
        }
      };
      const barrierRepository = new RelayOutboxRepository(relayPool, barrierAuthorization as never);
      const owner = await ownerPool.connect();
      let resultWrite: Promise<unknown> | undefined;
      let mutation: Promise<unknown> | undefined;
      try {
        resultWrite = barrierRepository.markPublished(
          relayContext(),
          claimed!,
          `relay-result-${relayOutcome}`
        );
        await reachedAuthorization;

        const pid = await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        mutation = owner.query(authority.mutateSql, [...authority.parameters]);
        await expect(waitForBlockingPid(ownerPool, pid.rows[0]!.pid)).resolves.toBeUndefined();

        releaseAuthorization();
        if (relayOutcome === "commit") {
          await expect(resultWrite).resolves.toBeUndefined();
        } else {
          await expect(resultWrite).rejects.toThrow("injected relay rollback");
        }
        await expect(mutation).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        releaseAuthorization();
        await Promise.allSettled([resultWrite, mutation].filter(Boolean) as Promise<unknown>[]);
        owner.release();
        await ownerPool.query(authority.restoreSql, [...authority.parameters]);
      }

      const result = await resultFields(event.eventId);
      expect(result?.published_at === null, `${authority.name}: ${relayOutcome}`).toBe(
        relayOutcome === "rollback"
      );
      expect(result?.terminal_failed_at).toBeNull();
    }
  );

  it.each(relayAuthorityMutationCases)(
    "denies and publishes nothing when the $name mutation commits first",
    async (authority) => {
      const event = await insertCommittedEvent(ownerPool, `authority-first-${authority.name}`);
      const before = await eventState(event.eventId);
      const owner = await ownerPool.connect();
      let publication: Promise<unknown> | undefined;
      let sends = 0;
      const proofRelay = new FoundationOutboxRelay(
        repository,
        {
          send: async () => {
            sends += 1;
            return { MessageId: generateUuidV7() };
          }
        },
        queueUrl!
      );
      try {
        await owner.query("BEGIN");
        const pid = await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await expect(
          owner.query(authority.mutateSql, [...authority.parameters])
        ).resolves.toMatchObject({ rowCount: 1 });

        publication = proofRelay.publishNext(relayContext(), {
          claimedBy: `authority-first-${authority.name}`,
          leaseSeconds: 30
        });
        await expect(waitForRelayBlockedBy(ownerPool, pid.rows[0]!.pid)).resolves.toBeUndefined();
        await owner.query("COMMIT");
        await expect(publication).rejects.toThrow("Relay publication is not authorized");
      } finally {
        await owner.query("ROLLBACK").catch(() => undefined);
        await Promise.allSettled(publication ? [publication] : []);
        owner.release();
        await ownerPool.query(authority.restoreSql, [...authority.parameters]);
      }
      expect(sends).toBe(0);
      await expect(eventState(event.eventId)).resolves.toEqual(before);
    }
  );

  it.each(relayAuthorityMutationCases)(
    "releases the relay after a winning $name mutation rolls back without deadlock",
    async (authority) => {
      const event = await insertCommittedEvent(ownerPool, `authority-rollback-${authority.name}`);
      const owner = await ownerPool.connect();
      let claim: Promise<unknown> | undefined;
      try {
        await owner.query("BEGIN");
        const pid = await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await expect(
          owner.query(authority.mutateSql, [...authority.parameters])
        ).resolves.toMatchObject({ rowCount: 1 });
        claim = repository.claimNext(relayContext(), {
          claimedBy: `authority-rollback-${authority.name}`,
          leaseSeconds: 30
        });
        await expect(waitForRelayBlockedBy(ownerPool, pid.rows[0]!.pid)).resolves.toBeUndefined();
        await owner.query("ROLLBACK");
        await expect(claim).resolves.toMatchObject({ eventId: event.eventId });
      } finally {
        await owner.query("ROLLBACK").catch(() => undefined);
        await Promise.allSettled(claim ? [claim] : []);
        owner.release();
        await ownerPool.query(authority.restoreSql, [...authority.parameters]);
      }
    }
  );

  it("uses one deterministic authority lock order for concurrent relay transactions", async () => {
    const first = await insertCommittedEvent(ownerPool, "deterministic-order-a");
    const second = await insertCommittedEvent(ownerPool, "deterministic-order-b");
    const results = await Promise.all([
      repository.claimNext(relayContext(), { claimedBy: "ordered-a", leaseSeconds: 30 }),
      repository.claimNext(relayContext(), { claimedBy: "ordered-b", leaseSeconds: 30 })
    ]);
    expect(results.map((result) => result?.eventId).sort()).toEqual(
      [first.eventId, second.eventId].sort()
    );
  });

  it("cannot see or complete an owner event before commit, then claims it after commit", async () => {
    const owner = await ownerPool.connect();
    let event: Awaited<ReturnType<typeof insertEventRows>>;
    try {
      await owner.query("BEGIN");
      event = await insertEventRows(owner, "commit-barrier");

      await expect(
        repository.claimNext(relayContext(), {
          claimedBy: "barrier-before-commit",
          leaseSeconds: 30
        })
      ).resolves.toBeUndefined();
      await expect(
        repository.markPublished(
          relayContext(),
          {
            eventId: event.eventId,
            claimedBy: "barrier-before-commit",
            publicationAttempt: 1
          },
          "impossible-before-commit"
        )
      ).rejects.toThrow(/stale or outside/);

      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    } finally {
      owner.release();
    }

    const claimed = await repository.claimNext(relayContext(), {
      claimedBy: "barrier-after-commit",
      leaseSeconds: 30
    });
    expect(claimed).toMatchObject({ eventId: event!.eventId, publicationAttempt: 1 });
  });

  it("authorizes only the active real relay principal with its exact direct-manager grant", async () => {
    const event = await insertCommittedEvent(ownerPool, "authorization-evidence");
    const authorization = new PostgresAuthorizationService(relayPool);
    await expect(
      authorization.can(relayContext(), "foundation.relay.publish", {
        type: "space",
        id: devFixtures.restrictedSpaceA
      })
    ).resolves.toMatchObject({ allowed: true, reasonCode: "foundation_relay_direct_manager" });

    try {
      await removeRelayGrant();
      await expectDeniedWithoutEventUpdate(
        relayContext(),
        "relay_direct_manager_required",
        event.eventId
      );

      await replaceRelayGrant("viewer");
      await expectDeniedWithoutEventUpdate(
        relayContext(),
        "relay_direct_manager_required",
        event.eventId
      );

      await replaceRelayGrant("manager");
      await ownerPool.query(
        "UPDATE identity.service_principals SET status = 'disabled' WHERE id = $1",
        [devFixtures.relayServicePrincipalA]
      );
      await expectDeniedWithoutEventUpdate(
        relayContext(),
        "relay_principal_not_active",
        event.eventId
      );

      await ownerPool.query(
        "UPDATE identity.service_principals SET status = 'active' WHERE id = $1",
        [devFixtures.relayServicePrincipalA]
      );
      await expectDeniedWithoutEventUpdate(
        { ...relayContext(), servicePrincipalId: devFixtures.servicePrincipalA },
        "relay_principal_not_active",
        event.eventId
      );
    } finally {
      await ownerPool.query(
        "UPDATE identity.service_principals SET status = 'active' WHERE id = $1",
        [devFixtures.relayServicePrincipalA]
      );
      await replaceRelayGrant("manager");
    }
  });

  it("reauthorizes a claimed result update after live relay authority is removed", async () => {
    const event = await insertCommittedEvent(ownerPool, "result-reauthorization");
    const claim = await repository.claimNext(relayContext(), {
      claimedBy: "result-reauthorization",
      leaseSeconds: 30
    });
    expect(claim).toMatchObject({ eventId: event.eventId, publicationAttempt: 1 });

    const before = await resultFields(event.eventId);
    try {
      await removeRelayGrant();
      await expect(
        repository.markPublished(relayContext(), claim!, "must-not-be-persisted")
      ).rejects.toThrow("Relay publication is not authorized");
      expect(await resultFields(event.eventId)).toEqual(before);
    } finally {
      await replaceRelayGrant("manager");
    }
  });

  it("rejects missing/cross scope, owner/app/worker pools, and immutable updates", async () => {
    await expect(
      repository.claimNext(
        { ...relayContext(), requestedSpaceIds: [] },
        { claimedBy: "x", leaseSeconds: 30 }
      )
    ).rejects.toThrow(/one exact requested Space/);
    await expect(
      repository.claimNext(
        { ...relayContext(), requestedSpaceIds: [devFixtures.rootSpaceB] },
        { claimedBy: "x", leaseSeconds: 30 }
      )
    ).rejects.toThrow(/not authorized/);
    for (const pool of [ownerPool, appPool, workerPool]) {
      const unsafe = new RelayOutboxRepository(pool, new PostgresAuthorizationService(pool));
      await expect(
        unsafe.claimNext(relayContext(), { claimedBy: "x", leaseSeconds: 30 })
      ).rejects.toThrow("Dedicated relay database role is required");
    }
    await expect(
      relayPool.query("UPDATE ops.outbox_events SET event_type = 'forbidden'")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot mark an unpublished/unclaimed event successful and duplicate publication keeps stable identity", async () => {
    const event = await insertCommittedEvent(ownerPool, "duplicate");
    await expect(
      repository.markPublished(
        relayContext(),
        {
          eventId: event.eventId,
          claimedBy: "never-claimed",
          publicationAttempt: 1
        },
        "forbidden-message"
      )
    ).rejects.toThrow(/stale or outside/);

    const bodies: string[] = [];
    const duplicateRelay = new FoundationOutboxRelay(
      repository,
      {
        send: async (command) => {
          bodies.push(command.input.MessageBody);
          return { MessageId: generateUuidV7() };
        }
      },
      queueUrl!
    );
    await duplicateRelay.publishNext(relayContext(), {
      claimedBy: "duplicate-a",
      leaseSeconds: 30
    });
    await ownerPool.query(
      `UPDATE ops.outbox_events SET published_at = NULL, published_message_id = NULL,
       claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL WHERE id = $1`,
      [event.eventId]
    );
    await duplicateRelay.publishNext(relayContext(), {
      claimedBy: "duplicate-b",
      leaseSeconds: 30
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  async function receiveEvent(eventId: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = (await sqs.send(
        new sdk.ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ["All"]
        })
      )) as { Messages?: Array<Record<string, unknown>> };
      for (const message of response.Messages ?? []) {
        const body = JSON.parse(message.Body as string) as { eventId?: string };
        if (message.ReceiptHandle) {
          await sqs.send(
            new sdk.DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle
            })
          );
        }
        if (body.eventId === eventId) return message;
      }
    }
    throw new Error("Expected LocalStack queue message was not received");
  }

  async function replaceRelayGrant(relation: "manager" | "viewer"): Promise<void> {
    await removeRelayGrant();
    await ownerPool.query(
      `INSERT INTO access.access_relationships
       (id, tenant_id, workspace_id, subject_type, subject_id, relation,
        resource_type, resource_id, source)
       VALUES ($1,$2,$3,'service_principal',$4,$5,'space',$6,'direct')`,
      [
        generateUuidV7(),
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.relayServicePrincipalA,
        relation,
        devFixtures.restrictedSpaceA
      ]
    );
  }

  async function removeRelayGrant(): Promise<void> {
    await ownerPool.query(
      `DELETE FROM access.access_relationships
       WHERE tenant_id = $1 AND workspace_id = $2
         AND subject_type = 'service_principal' AND subject_id = $3
         AND resource_type = 'space' AND resource_id = $4`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.relayServicePrincipalA,
        devFixtures.restrictedSpaceA
      ]
    );
  }

  async function expectDeniedWithoutEventUpdate(
    context: SecurityContext,
    reasonCode: string,
    eventId: string
  ): Promise<void> {
    const authorization = new PostgresAuthorizationService(relayPool);
    await expect(
      authorization.can(context, "foundation.relay.publish", {
        type: "space",
        id: context.requestedSpaceIds[0]!
      })
    ).resolves.toMatchObject({ allowed: false, reasonCode });
    const scopedRepository = new RelayOutboxRepository(relayPool, authorization);
    await expect(
      scopedRepository.claimNext(context, {
        claimedBy: `denied-${reasonCode}`,
        leaseSeconds: 30
      })
    ).rejects.toThrow(/not authorized/);
    const persisted = await ownerPool.query<{
      publication_attempts: number;
      claimed_by: string | null;
      published_at: Date | null;
      terminal_failed_at: Date | null;
    }>(
      `SELECT publication_attempts, claimed_by, published_at, terminal_failed_at
       FROM ops.outbox_events WHERE id = $1`,
      [eventId]
    );
    expect(persisted.rows[0]).toEqual({
      publication_attempts: 0,
      claimed_by: null,
      published_at: null,
      terminal_failed_at: null
    });
  }

  async function resultFields(eventId: string) {
    const result = await ownerPool.query<{
      published_at: Date | null;
      published_message_id: string | null;
      terminal_failed_at: Date | null;
      terminal_failure_code: string | null;
      last_retry_code: string | null;
      next_attempt_at: Date;
    }>(
      `SELECT published_at, published_message_id, terminal_failed_at, terminal_failure_code,
              last_retry_code, next_attempt_at
       FROM ops.outbox_events WHERE id = $1`,
      [eventId]
    );
    return result.rows[0];
  }

  async function eventState(eventId: string) {
    const result = await ownerPool.query<{
      publication_attempts: number;
      claimed_at: Date | null;
      claimed_by: string | null;
      claim_expires_at: Date | null;
      published_at: Date | null;
      published_message_id: string | null;
      terminal_failed_at: Date | null;
      terminal_failure_code: string | null;
    }>(
      `SELECT publication_attempts, claimed_at, claimed_by, claim_expires_at,
              published_at, published_message_id, terminal_failed_at, terminal_failure_code
       FROM ops.outbox_events WHERE id = $1`,
      [eventId]
    );
    return result.rows[0];
  }
});

function relayContext(): SecurityContext {
  const now = new Date();
  return {
    requestId: "relay-integration",
    traceId: "relay-integration-trace",
    tenantId: devFixtures.tenantA,
    workspaceId: devFixtures.workspaceA,
    servicePrincipalId: devFixtures.relayServicePrincipalA,
    requestedSpaceIds: [devFixtures.restrictedSpaceA],
    membershipIds: [],
    roleHints: [],
    dataClassCeiling: "restricted",
    policyVersion: DEV_POLICY_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
  };
}

async function insertCommittedEvent(
  pool: PgPool,
  suffix: string,
  identity: { eventType?: string; aggregateType?: string } = {}
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await insertEventRows(client, suffix, identity);
    await client.query("COMMIT");
    return event;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertEventRows(
  client: PgPoolClient,
  suffix: string,
  identity: { eventType?: string; aggregateType?: string } = {}
) {
  const eventId = generateUuidV7();
  const jobId = generateUuidV7();
  const aggregateId = generateUuidV7();
  const referenceId = generateUuidV7();
  const token = "tlctx.v1.hs256.test.cGF5bG9hZA.bWFj";
  const snapshot = relayContext();
  await client.query(
    `INSERT INTO ops.security_context_references
       (id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
        delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
        issued_at, expires_at, status, signing_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,clock_timestamp(),clock_timestamp()+interval '15 minutes','active','test')`,
    [
      referenceId,
      jobId,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      devFixtures.servicePrincipalA,
      devFixtures.userA,
      devFixtures.membershipAOwner,
      DEV_POLICY_VERSION,
      JSON.stringify(snapshot)
    ]
  );
  await client.query(
    `INSERT INTO ops.foundation_test_aggregates
       (id, tenant_id, workspace_id, space_id, proof_key, pending_job_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      aggregateId,
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      `relay-${suffix}-${eventId}`,
      jobId
    ]
  );
  await client.query(
    `INSERT INTO ops.outbox_events
       (id,event_type,tenant_id,workspace_id,space_id,aggregate_type,aggregate_id,
        aggregate_version,causation_id,request_id,traceparent,tracestate,job_id,
        relay_service_principal_id,context_reference_id,signed_context_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
        1,$8,'relay-integration','00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'vendor=value',$9,$10,$11,$12)`,
    [
      eventId,
      identity.eventType ?? "foundation.proof.created.v1",
      devFixtures.tenantA,
      devFixtures.workspaceA,
      devFixtures.restrictedSpaceA,
      identity.aggregateType ?? "foundation_test_aggregate",
      aggregateId,
      generateUuidV7(),
      jobId,
      devFixtures.relayServicePrincipalA,
      referenceId,
      token
    ]
  );
  return { eventId, jobId };
}

async function waitForBlockingPid(pool: PgPool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blockers: number[] }>(
      "SELECT pg_blocking_pids($1)::integer[] AS blockers",
      [pid]
    );
    if ((result.rows[0]?.blockers.length ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Concurrent relay authority revocation did not wait for decision locks");
}

async function waitForRelayBlockedBy(pool: PgPool, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid
       FROM pg_stat_activity AS activity
       WHERE activity.usename = 'throughline_relay'
         AND $1 = ANY(pg_blocking_pids(activity.pid))
       ORDER BY activity.pid
       LIMIT 1`,
      [blockerPid]
    );
    if (result.rows.length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Relay did not expose the expected authority blocker ${blockerPid}`);
}
