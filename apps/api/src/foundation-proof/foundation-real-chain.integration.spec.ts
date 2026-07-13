import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgresAuthorizationService } from "@throughline/authorization";
import {
  applyMigrations,
  bootstrapWorkerContextReference,
  consumeFoundationWorkerJob,
  createPgPool,
  provisionTestAppRole,
  provisionTestFoundationRoles,
  seedWaveA2DeterministicData,
  type PgPool,
  type PgPoolClient
} from "@throughline/db";
import {
  createAsyncContextReferenceCodec,
  createDevSecurityContext,
  DEV_POLICY_VERSION,
  devFixtures
} from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFoundationContextKeys } from "../../../../scripts/foundation-test-config.js";
import { FoundationSqsConsumer } from "../../../agent-worker/src/foundation-consumer.js";
import { AwsSqsPort } from "../../../agent-worker/src/main.js";
import { rehydrateFoundationWorkerContext } from "../../../agent-worker/src/worker-context.js";
import { composeRelayRuntime } from "../../../outbox-relay/src/main.js";
import type { SqsSendMessageInput } from "../../../outbox-relay/src/relay.js";
import { FoundationProofModule } from "./foundation-proof.module.js";

const requiredEnvironment = [
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "TEST_RELAY_DATABASE_URL",
  "TEST_WORKER_DATABASE_URL",
  "FOUNDATION_SQS_ENDPOINT",
  "FOUNDATION_SQS_QUEUE_URL",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON",
  "FOUNDATION_CONTEXT_ACTIVE_KEY_ID"
] as const;

const enabled = requiredEnvironment.every((name) => Boolean(process.env[name]));
const integration = enabled ? describe.sequential : describe.skip;

const relayPublicationAuthorityCases = [
  {
    name: "tenant",
    revokeSql: "UPDATE identity.tenants SET status = 'suspended' WHERE id = $1",
    restoreSql: "UPDATE identity.tenants SET status = 'active' WHERE id = $1",
    parameters: [devFixtures.tenantA]
  },
  {
    name: "workspace",
    revokeSql: "UPDATE identity.workspaces SET status = 'archived' WHERE id = $1",
    restoreSql: "UPDATE identity.workspaces SET status = 'active' WHERE id = $1",
    parameters: [devFixtures.workspaceA]
  },
  {
    name: "policy version",
    revokeSql: `UPDATE identity.policy_versions SET status = 'retired'
                WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
    restoreSql: `UPDATE identity.policy_versions SET status = 'active'
                 WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
    parameters: [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
  },
  {
    name: "relay service principal",
    revokeSql: "UPDATE identity.service_principals SET status = 'disabled' WHERE id = $1",
    restoreSql: "UPDATE identity.service_principals SET status = 'active' WHERE id = $1",
    parameters: [devFixtures.relayServicePrincipalA]
  },
  {
    name: "Space",
    revokeSql: "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
    restoreSql: "UPDATE access.spaces SET archived_at = NULL WHERE id = $1",
    parameters: [devFixtures.restrictedSpaceA]
  },
  {
    name: "direct manager relationship",
    revokeSql: `UPDATE access.access_relationships SET relation = 'viewer'
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

interface FoundationChainBinding {
  eventId: string;
  jobId: string;
  referenceId: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  aggregateId: string;
  signedContextReference: string;
  workerServicePrincipalId: string;
  policyVersionId: string;
}

integration("Foundation real API to PostgreSQL to LocalStack to worker closure proof", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let workerPool: PgPool;
  let app: NestFastifyApplication;
  let sqs: {
    send(
      command: object,
      options?: { abortSignal?: AbortSignal }
    ): Promise<Record<string, unknown>>;
    destroy(): void;
  };
  let sdk: {
    SQSClient: new (configuration: object) => typeof sqs;
    PurgeQueueCommand: new (input: object) => object;
    SendMessageCommand: new (input: SqsSendMessageInput) => { input: SqsSendMessageInput };
  };
  let previousAuthAdapter: string | undefined;
  let previousNodeEnv: string | undefined;

  async function cleanupTestResources(): Promise<void> {
    const queueUrl = process.env.FOUNDATION_SQS_QUEUE_URL;
    const cleanupResults = await Promise.allSettled([
      sqs && queueUrl
        ? sqs.send(new sdk.PurgeQueueCommand({ QueueUrl: queueUrl })).then(() => undefined)
        : Promise.resolve(),
      app?.close() ?? Promise.resolve(),
      workerPool?.end() ?? Promise.resolve(),
      appPool?.end() ?? Promise.resolve()
    ]);
    let cleanupError = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )?.reason;
    if (ownerPool) {
      try {
        await applyMigrations(ownerPool, { reset: true });
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await ownerPool.end();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    sqs?.destroy();
    if (cleanupError) throw cleanupError;
  }

  beforeAll(async () => {
    if (!enabled) throw new Error("Complete Foundation environment is required");
    previousAuthAdapter = process.env.AUTH_ADAPTER;
    previousNodeEnv = process.env.NODE_ENV;
    process.env.AUTH_ADAPTER = "dev";
    process.env.NODE_ENV = "test";

    try {
      ownerPool = createPgPool(process.env.TEST_DATABASE_URL!);
      await applyMigrations(ownerPool, { reset: true });
      await provisionTestAppRole(ownerPool, process.env.TEST_APP_DATABASE_URL!);
      await provisionTestFoundationRoles(
        ownerPool,
        process.env.TEST_RELAY_DATABASE_URL!,
        process.env.TEST_WORKER_DATABASE_URL!
      );
      await seedWaveA2DeterministicData(ownerPool);
      appPool = createPgPool(process.env.TEST_APP_DATABASE_URL!);
      workerPool = createPgPool(process.env.TEST_WORKER_DATABASE_URL!);

      const contextKeys = parseFoundationContextKeys(process.env);
      const codec = createAsyncContextReferenceCodec({
        verificationKeys: new Map(Object.entries(contextKeys.verificationKeys)),
        activeKeyId: contextKeys.activeKeyId,
        clock: () => new Date()
      });
      const moduleRef = await Test.createTestingModule({
        imports: [
          FoundationProofModule.register({
            pool: appPool,
            contextReferenceCodec: codec,
            relayServicePrincipalId: devFixtures.relayServicePrincipalA,
            workerServicePrincipalId: devFixtures.servicePrincipalA
          })
        ]
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      const modulePath = "../../../agent-worker/node_modules/@aws-sdk/client-sqs/dist-es/index.js";
      sdk = (await import(/* @vite-ignore */ modulePath)) as typeof sdk;
      sqs = new sdk.SQSClient({
        endpoint: process.env.FOUNDATION_SQS_ENDPOINT,
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
      await sqs.send(new sdk.PurgeQueueCommand({ QueueUrl: process.env.FOUNDATION_SQS_QUEUE_URL }));
    } catch (error) {
      try {
        await cleanupTestResources();
      } finally {
        if (previousAuthAdapter === undefined) delete process.env.AUTH_ADAPTER;
        else process.env.AUTH_ADAPTER = previousAuthAdapter;
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
      }
      throw error;
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestResources();
    } finally {
      if (previousAuthAdapter === undefined) delete process.env.AUTH_ADAPTER;
      else process.env.AUTH_ADAPTER = previousAuthAdapter;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("commits one request-bound job and carries its exact reference and scope through relay receipt and one durable effect", async () => {
    const requestId = `real-chain-${Date.now()}`;
    const proofKey = `real-chain-proof-${Date.now()}`;
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "POST",
        url: "/__test/foundation-proof",
        headers: {
          "x-throughline-dev-identity": "tenant-a-owner",
          "x-request-id": requestId,
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01"
        },
        payload: { spaceId: devFixtures.restrictedSpaceA, proofKey }
      });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<{
      jobId: string;
      aggregateId: string;
      aggregateVersion: number;
    }>();

    const committed = await ownerPool.query<{
      eventId: string;
      jobId: string;
      referenceId: string;
      tenantId: string;
      workspaceId: string;
      spaceId: string;
      aggregateId: string;
      pendingJobId: string;
      signedContextReference: string;
      workerServicePrincipalId: string;
      policyVersionId: string;
      contextSnapshot: { requestedSpaceIds: string[] };
    }>(
      `SELECT event.id AS "eventId", event.job_id AS "jobId",
              event.context_reference_id AS "referenceId", event.tenant_id AS "tenantId",
              event.workspace_id AS "workspaceId", event.space_id AS "spaceId",
              aggregate.id AS "aggregateId", aggregate.pending_job_id AS "pendingJobId",
              event.signed_context_reference AS "signedContextReference",
              reference.worker_service_principal_id AS "workerServicePrincipalId",
              reference.policy_version_id AS "policyVersionId",
              reference.context_snapshot AS "contextSnapshot"
       FROM ops.outbox_events event
       JOIN ops.security_context_references reference
         ON (reference.id, reference.job_id, reference.tenant_id, reference.workspace_id, reference.space_id) =
            (event.context_reference_id, event.job_id, event.tenant_id, event.workspace_id, event.space_id)
       JOIN ops.foundation_test_aggregates aggregate
         ON (aggregate.id, aggregate.tenant_id, aggregate.workspace_id, aggregate.space_id) =
            (event.aggregate_id, event.tenant_id, event.workspace_id, event.space_id)
       WHERE event.request_id = $1 AND aggregate.proof_key = $2`,
      [requestId, proofKey]
    );
    expect(committed.rows).toHaveLength(1);
    const binding = committed.rows[0]!;
    expect(binding).toMatchObject({
      jobId: created.jobId,
      pendingJobId: created.jobId,
      aggregateId: created.aggregateId,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.restrictedSpaceA
    });

    const relayRuntime = await composeRelayRuntime({
      TEST_RELAY_DATABASE_URL: process.env.TEST_RELAY_DATABASE_URL!,
      FOUNDATION_SQS_ENDPOINT: process.env.FOUNDATION_SQS_ENDPOINT!,
      FOUNDATION_SQS_QUEUE_URL: process.env.FOUNDATION_SQS_QUEUE_URL!,
      AWS_REGION: process.env.AWS_REGION!,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY!
    });
    try {
      await expect(
        relayRuntime.relay.publishNext(relayContext(), {
          claimedBy: "real-chain-relay",
          leaseSeconds: 30
        })
      ).resolves.toMatchObject({ status: "published", eventId: binding.eventId });
    } finally {
      await relayRuntime.close();
    }

    const contextKeys = parseFoundationContextKeys(process.env);
    const codec = createAsyncContextReferenceCodec({
      verificationKeys: new Map(Object.entries(contextKeys.verificationKeys)),
      activeKeyId: contextKeys.activeKeyId,
      clock: () => new Date()
    });
    expect(binding.contextSnapshot.requestedSpaceIds).toEqual([binding.spaceId]);
    const verifiedClaims = codec.verify(binding.signedContextReference, {
      jobId: binding.jobId,
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId,
      spaceId: binding.spaceId,
      workerServicePrincipalId: binding.workerServicePrincipalId,
      policyVersionId: binding.policyVersionId
    });
    await expect(
      bootstrapWorkerContextReference({
        pool: workerPool,
        token: binding.signedContextReference,
        codec,
        expected: {
          jobId: verifiedClaims.jobId,
          tenantId: verifiedClaims.tenantId,
          workspaceId: verifiedClaims.workspaceId,
          spaceId: verifiedClaims.spaceId,
          workerServicePrincipalId: verifiedClaims.workerServicePrincipalId,
          policyVersionId: verifiedClaims.policyVersionId
        }
      })
    ).resolves.toMatchObject({ id: binding.referenceId });
    const authorization = new PostgresAuthorizationService(workerPool);
    const consumer = new FoundationSqsConsumer({
      queueUrl: process.env.FOUNDATION_SQS_QUEUE_URL!,
      sqs: new AwsSqsPort(sqs as never),
      scheduler: {
        now: Date.now,
        setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      rehydrate: async ({ body, messageAttributes }, { signal }) => {
        const envelope = JSON.parse(body) as {
          eventId: string;
          contextReference: string;
        };
        expect(envelope.eventId).toBe(binding.eventId);
        const result = await rehydrateFoundationWorkerContext({
          body,
          messageAttributes,
          codec,
          targetWorkerServicePrincipalId: devFixtures.servicePrincipalA,
          targetPolicyVersionId: DEV_POLICY_VERSION,
          bootstrapReference: (claims) =>
            bootstrapWorkerContextReference({
              pool: workerPool,
              token: (JSON.parse(body) as { contextReference: string }).contextReference,
              codec,
              expected: {
                jobId: claims.jobId,
                tenantId: claims.tenantId,
                workspaceId: claims.workspaceId,
                spaceId: claims.spaceId,
                workerServicePrincipalId: claims.workerServicePrincipalId,
                policyVersionId: claims.policyVersionId
              },
              signal
            }),
          clock: () => new Date(),
          signal
        });
        expect(result.metadata).toMatchObject({
          eventId: binding.eventId,
          jobId: binding.jobId,
          contextReferenceId: binding.referenceId
        });
        expect(result.securityContext).toMatchObject({
          tenantId: binding.tenantId,
          workspaceId: binding.workspaceId,
          requestedSpaceIds: [binding.spaceId]
        });
        return result;
      },
      consume: (job, { signal, deadline }) =>
        consumeFoundationWorkerJob({
          pool: workerPool,
          authorization,
          input: {
            context: job.securityContext,
            jobId: job.metadata.jobId,
            contextReferenceId: job.metadata.contextReferenceId
          },
          signal,
          deadline
        })
    });
    await expect(consumer.receiveOne()).resolves.toEqual({
      status: "deleted",
      outcome: "applied"
    });

    const final = await ownerPool.query(
      `SELECT aggregate.effect_count AS "effectCount",
              aggregate.pending_job_id AS "pendingJobId",
              aggregate.last_effect_job_id AS "lastEffectJobId",
              idempotency.job_id AS "idempotencyJobId",
              idempotency.context_reference_id AS "idempotencyReferenceId",
              idempotency.tenant_id AS "tenantId", idempotency.workspace_id AS "workspaceId",
              idempotency.space_id AS "spaceId"
       FROM ops.foundation_test_aggregates aggregate
       JOIN ops.idempotency_records idempotency ON idempotency.aggregate_id = aggregate.id
       WHERE aggregate.id = $1`,
      [binding.aggregateId]
    );
    expect(final.rows).toEqual([
      {
        effectCount: 1,
        pendingJobId: null,
        lastEffectJobId: binding.jobId,
        idempotencyJobId: binding.jobId,
        idempotencyReferenceId: binding.referenceId,
        tenantId: binding.tenantId,
        workspaceId: binding.workspaceId,
        spaceId: binding.spaceId
      }
    ]);
  });

  it.each(relayPublicationAuthorityCases)(
    "orders a full durable chain before the $name revocation",
    async (authority) => {
      const suffix = `${authority.name.replaceAll(" ", "-")}-${Date.now()}`;
      const binding = await createApiFoundationBinding(suffix);
      const releaseRealSend = deferred();
      const realSendReached = deferred();
      let relayRuntime: Awaited<ReturnType<typeof composeRelayRuntime>> | undefined;
      let publication: Promise<unknown> | undefined;
      let revocation: Promise<unknown> | undefined;
      let revocationSession: PgPoolClient | undefined;
      let realSendDelegations = 0;
      let cleanupError: unknown;

      try {
        relayRuntime = await composeRelayRuntime(
          {
            TEST_RELAY_DATABASE_URL: process.env.TEST_RELAY_DATABASE_URL!,
            FOUNDATION_SQS_ENDPOINT: process.env.FOUNDATION_SQS_ENDPOINT!,
            FOUNDATION_SQS_QUEUE_URL: process.env.FOUNDATION_SQS_QUEUE_URL!,
            AWS_REGION: process.env.AWS_REGION!,
            AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,
            AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY!
          },
          async () => ({
            SQSClient: class BarrierRealSqsPublisher {
              async send(command: object): Promise<{ MessageId?: string }> {
                realSendReached.resolve();
                await releaseRealSend.promise;
                realSendDelegations += 1;
                const acknowledgment = await sqs.send(command);
                return typeof acknowledgment.MessageId === "string"
                  ? { MessageId: acknowledgment.MessageId }
                  : {};
              }
            },
            SendMessageCommand: sdk.SendMessageCommand
          })
        );

        const claim = await relayRuntime.repository.claimNext(relayContext(), {
          claimedBy: `relay-wins-${suffix}`,
          leaseSeconds: 30
        });
        expect(claim).toMatchObject({ eventId: binding.eventId, publicationAttempt: 1 });

        publication = relayRuntime.relay.publishClaimed(relayContext(), claim!);
        await realSendReached.promise;

        revocationSession = await ownerPool.connect();
        const revocationPid = await revocationSession.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        );
        revocation = revocationSession.query(authority.revokeSql, [...authority.parameters]);
        await expect(
          waitForOwnerRevocationBlocked(ownerPool, revocationPid.rows[0]!.pid, authority.name)
        ).resolves.toBeUndefined();

        releaseRealSend.resolve();
        await expect(publication).resolves.toMatchObject({
          status: "published",
          eventId: binding.eventId
        });
        expect(realSendDelegations).toBe(1);
        await expect(revocation).resolves.toMatchObject({ rowCount: 1 });

        await ownerPool.query(authority.restoreSql, [...authority.parameters]);

        const consumer = createRealFoundationConsumer(binding);
        await expect(consumer.receiveOne()).resolves.toEqual({
          status: "deleted",
          outcome: "applied"
        });

        const durable = await ownerPool.query<{
          logicalEventCount: number;
          effectCount: number;
          idempotencyCount: number;
          idempotencyJobId: string | null;
          idempotencyReferenceId: string | null;
          handlerKey: string | null;
        }>(
          `SELECT
             (SELECT count(*)::integer FROM ops.outbox_events event
              WHERE event.job_id = $1 AND event.context_reference_id = $2
                AND event.aggregate_id = $3) AS "logicalEventCount",
             aggregate.effect_count AS "effectCount",
             (SELECT count(*)::integer FROM ops.idempotency_records record
              WHERE record.aggregate_id = aggregate.id) AS "idempotencyCount",
             (SELECT record.job_id FROM ops.idempotency_records record
              WHERE record.aggregate_id = aggregate.id) AS "idempotencyJobId",
             (SELECT record.context_reference_id FROM ops.idempotency_records record
              WHERE record.aggregate_id = aggregate.id) AS "idempotencyReferenceId",
             (SELECT record.handler_key FROM ops.idempotency_records record
              WHERE record.aggregate_id = aggregate.id) AS "handlerKey"
           FROM ops.foundation_test_aggregates aggregate
           WHERE aggregate.id = $4`,
          [binding.jobId, binding.referenceId, binding.aggregateId, binding.aggregateId]
        );
        expect(durable.rows).toEqual([
          {
            logicalEventCount: 1,
            effectCount: 1,
            idempotencyCount: 1,
            idempotencyJobId: binding.jobId,
            idempotencyReferenceId: binding.referenceId,
            handlerKey: "foundation.worker.consume.v1"
          }
        ]);
      } finally {
        releaseRealSend.resolve();
        await Promise.allSettled(
          [publication, revocation].filter(
            (value): value is Promise<unknown> => value !== undefined
          )
        );
        revocationSession?.release();
        const cleanupResults = await Promise.allSettled([
          ownerPool.query(authority.restoreSql, [...authority.parameters]),
          sqs.send(new sdk.PurgeQueueCommand({ QueueUrl: process.env.FOUNDATION_SQS_QUEUE_URL! })),
          relayRuntime ? relayRuntime.close() : Promise.resolve()
        ]);
        const cleanupFailure = cleanupResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (cleanupFailure) cleanupError = cleanupFailure.reason;
      }

      if (cleanupError) throw cleanupError;
    },
    30_000
  );

  it("keeps accepted-send retry at-least-once while duplicate deliveries create one durable worker effect", async () => {
    const binding = await createApiFoundationBinding(`ambiguous-worker-${Date.now()}`);
    const suffix = binding.eventId.replaceAll("-", "").slice(0, 16);
    const triggerName = `throughline_test_publish_${suffix}`;
    const functionName = `throughline_test_raise_${suffix}`;
    let triggerInstalled = false;
    let relayRuntime: Awaited<ReturnType<typeof composeRelayRuntime>> | undefined;
    let cleanupError: unknown;

    try {
      relayRuntime = await composeRelayRuntime({
        TEST_RELAY_DATABASE_URL: process.env.TEST_RELAY_DATABASE_URL!,
        FOUNDATION_SQS_ENDPOINT: process.env.FOUNDATION_SQS_ENDPOINT!,
        FOUNDATION_SQS_QUEUE_URL: process.env.FOUNDATION_SQS_QUEUE_URL!,
        AWS_REGION: process.env.AWS_REGION!,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY!
      });
      const firstClaim = await relayRuntime.repository.claimNext(relayContext(), {
        claimedBy: "ambiguous-worker-first",
        leaseSeconds: 30
      });
      expect(firstClaim).toMatchObject({ eventId: binding.eventId, publicationAttempt: 1 });

      await ownerPool.query(
        `CREATE FUNCTION ops.${functionName}() RETURNS trigger
         LANGUAGE plpgsql AS $test_failure$
         BEGIN
           RAISE EXCEPTION 'owner-installed exact-row publication marker failure';
         END
         $test_failure$`
      );
      await ownerPool.query(
        `CREATE TRIGGER ${triggerName}
         BEFORE UPDATE OF published_at ON ops.outbox_events
         FOR EACH ROW
         WHEN (OLD.id = '${binding.eventId}'::uuid AND NEW.published_at IS NOT NULL)
         EXECUTE FUNCTION ops.${functionName}()`
      );
      triggerInstalled = true;

      await expect(relayRuntime.relay.publishClaimed(relayContext(), firstClaim!)).rejects.toThrow(
        "SQS publication outcome remains unresolved and is retryable"
      );
      await ownerPool.query(`DROP TRIGGER ${triggerName} ON ops.outbox_events`);
      await ownerPool.query(`DROP FUNCTION ops.${functionName}()`);
      triggerInstalled = false;
      await ownerPool.query(
        "UPDATE ops.outbox_events SET next_attempt_at = clock_timestamp() WHERE id = $1",
        [binding.eventId]
      );

      const retryClaim = await relayRuntime.repository.claimNext(relayContext(), {
        claimedBy: "ambiguous-worker-retry",
        leaseSeconds: 30
      });
      expect(retryClaim).toMatchObject({ eventId: binding.eventId, publicationAttempt: 2 });
      expect(retryClaim?.claimToken).not.toBe(firstClaim?.claimToken);
      await expect(
        relayRuntime.relay.publishClaimed(relayContext(), retryClaim!)
      ).resolves.toMatchObject({ status: "published", eventId: binding.eventId });

      const consumer = createRealFoundationConsumer(binding);
      await expect(consumer.receiveOne()).resolves.toEqual({
        status: "deleted",
        outcome: "applied"
      });
      await expect(consumer.receiveOne()).resolves.toEqual({
        status: "deleted",
        outcome: "confirmed_duplicate"
      });

      const durable = await ownerPool.query<{
        effectCount: number;
        idempotencyCount: number;
        lastEffectJobId: string | null;
      }>(
        `SELECT aggregate.effect_count AS "effectCount",
                count(idempotency.id)::integer AS "idempotencyCount",
                aggregate.last_effect_job_id AS "lastEffectJobId"
         FROM ops.foundation_test_aggregates aggregate
         LEFT JOIN ops.idempotency_records idempotency ON idempotency.aggregate_id = aggregate.id
         WHERE aggregate.id = $1
         GROUP BY aggregate.id`,
        [binding.aggregateId]
      );
      expect(durable.rows).toEqual([
        { effectCount: 1, idempotencyCount: 1, lastEffectJobId: binding.jobId }
      ]);
      await expect(
        ownerPool.query(
          "SELECT publication_attempts AS attempts FROM ops.outbox_events WHERE id = $1",
          [binding.eventId]
        )
      ).resolves.toMatchObject({ rows: [{ attempts: 2 }] });
    } finally {
      const cleanupResults = await Promise.allSettled([
        triggerInstalled
          ? ownerPool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ops.outbox_events`)
          : Promise.resolve(),
        ownerPool.query(`DROP FUNCTION IF EXISTS ops.${functionName}()`),
        sqs.send(new sdk.PurgeQueueCommand({ QueueUrl: process.env.FOUNDATION_SQS_QUEUE_URL! })),
        relayRuntime ? relayRuntime.close() : Promise.resolve()
      ]);
      const cleanupFailure = cleanupResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (cleanupFailure) cleanupError = cleanupFailure.reason;
    }

    if (cleanupError) throw cleanupError;
    const leftovers = await ownerPool.query<{ count: number }>(
      `SELECT (
         (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname = $1)
         +
         (SELECT count(*) FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'ops' AND procedure.proname = $2)
       )::integer AS count`,
      [triggerName, functionName]
    );
    expect(leftovers.rows).toEqual([{ count: 0 }]);
  });

  it("publishes nothing and creates no durable effect when relay authority is revoked after claim commit but before SendMessage", async () => {
    const requestId = `relay-revocation-gap-${Date.now()}`;
    const proofKey = `relay-revocation-gap-proof-${Date.now()}`;
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "POST",
        url: "/__test/foundation-proof",
        headers: {
          "x-throughline-dev-identity": "tenant-a-owner",
          "x-request-id": requestId,
          traceparent: "00-33333333333333333333333333333333-4444444444444444-01"
        },
        payload: { spaceId: devFixtures.restrictedSpaceA, proofKey }
      });
    expect(response.statusCode, response.body).toBe(201);

    const committed = await ownerPool.query<{
      eventId: string;
      jobId: string;
      referenceId: string;
      tenantId: string;
      workspaceId: string;
      spaceId: string;
      aggregateId: string;
      signedContextReference: string;
      workerServicePrincipalId: string;
      policyVersionId: string;
    }>(
      `SELECT event.id AS "eventId", event.job_id AS "jobId",
              event.context_reference_id AS "referenceId", event.tenant_id AS "tenantId",
              event.workspace_id AS "workspaceId", event.space_id AS "spaceId",
              event.aggregate_id AS "aggregateId",
              event.signed_context_reference AS "signedContextReference",
              reference.worker_service_principal_id AS "workerServicePrincipalId",
              reference.policy_version_id AS "policyVersionId"
       FROM ops.outbox_events event
       JOIN ops.security_context_references reference
         ON (reference.id, reference.job_id, reference.tenant_id, reference.workspace_id, reference.space_id) =
            (event.context_reference_id, event.job_id, event.tenant_id, event.workspace_id, event.space_id)
       JOIN ops.foundation_test_aggregates aggregate
         ON (aggregate.id, aggregate.tenant_id, aggregate.workspace_id, aggregate.space_id) =
            (event.aggregate_id, event.tenant_id, event.workspace_id, event.space_id)
       WHERE event.request_id = $1 AND aggregate.proof_key = $2`,
      [requestId, proofKey]
    );
    expect(committed.rows).toHaveLength(1);
    const binding = committed.rows[0]!;

    const releasePublisher = deferred();
    let sendInvocations = 0;
    let realSendDelegations = 0;
    let realSendCompletions = 0;
    let revocationSession: PgPoolClient | undefined;
    let revocationTransactionOpen = false;
    let relayRuntime: Awaited<ReturnType<typeof composeRelayRuntime>> | undefined;
    let publication: Promise<unknown> | undefined;
    let observedEffectCount: number | undefined;
    let observedIdempotencyCount: number | undefined;
    let cleanupError: unknown;

    try {
      relayRuntime = await composeRelayRuntime(
        {
          TEST_RELAY_DATABASE_URL: process.env.TEST_RELAY_DATABASE_URL!,
          FOUNDATION_SQS_ENDPOINT: process.env.FOUNDATION_SQS_ENDPOINT!,
          FOUNDATION_SQS_QUEUE_URL: process.env.FOUNDATION_SQS_QUEUE_URL!,
          AWS_REGION: process.env.AWS_REGION!,
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY!
        },
        async () => ({
          SQSClient: class BarrierRealSqsPublisher {
            async send(command: object): Promise<{ MessageId?: string }> {
              sendInvocations += 1;
              await releasePublisher.promise;
              realSendDelegations += 1;
              const acknowledgment = await sqs.send(command);
              realSendCompletions += 1;
              return typeof acknowledgment.MessageId === "string"
                ? { MessageId: acknowledgment.MessageId }
                : {};
            }
          },
          SendMessageCommand: sdk.SendMessageCommand
        })
      );

      const claim = await relayRuntime.repository.claimNext(relayContext(), {
        claimedBy: "relay-revocation-gap",
        leaseSeconds: 30
      });
      expect(claim).toMatchObject({ eventId: binding.eventId });

      revocationSession = await ownerPool.connect();
      await revocationSession.query("BEGIN");
      revocationTransactionOpen = true;
      await expect(
        revocationSession.query(
          `SELECT publication_attempts AS "publicationAttempts", claimed_by AS "claimedBy",
                  published_at AS "publishedAt"
           FROM ops.outbox_events WHERE id = $1`,
          [binding.eventId]
        )
      ).resolves.toMatchObject({
        rows: [
          {
            publicationAttempts: 1,
            claimedBy: "relay-revocation-gap",
            publishedAt: null
          }
        ]
      });
      await expect(
        revocationSession.query(
          `UPDATE access.access_relationships SET relation = 'viewer'
           WHERE tenant_id = $1 AND workspace_id = $2
             AND subject_type = 'service_principal' AND subject_id = $3
             AND resource_type = 'space' AND resource_id = $4
             AND relation = 'manager' AND source = 'direct'`,
          [
            devFixtures.tenantA,
            devFixtures.workspaceA,
            devFixtures.relayServicePrincipalA,
            devFixtures.restrictedSpaceA
          ]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
      await revocationSession.query("COMMIT");
      revocationTransactionOpen = false;

      publication = relayRuntime.relay.publishClaimed(relayContext(), claim!);
      releasePublisher.resolve();
      await expect(publication).rejects.toThrow("Relay publication is not authorized");
      expect(sendInvocations).toBe(0);
      expect(realSendDelegations).toBe(0);
      expect(realSendCompletions).toBe(0);
      await expect(
        ownerPool.query(
          `SELECT published_at AS "publishedAt", published_message_id AS "publishedMessageId"
           FROM ops.outbox_events WHERE id = $1`,
          [binding.eventId]
        )
      ).resolves.toMatchObject({
        rows: [{ publishedAt: null, publishedMessageId: null }]
      });

      const contextKeys = parseFoundationContextKeys(process.env);
      const codec = createAsyncContextReferenceCodec({
        verificationKeys: new Map(Object.entries(contextKeys.verificationKeys)),
        activeKeyId: contextKeys.activeKeyId,
        clock: () => new Date()
      });
      const authorization = new PostgresAuthorizationService(workerPool);
      const consumer = new FoundationSqsConsumer({
        queueUrl: process.env.FOUNDATION_SQS_QUEUE_URL!,
        sqs: new AwsSqsPort(sqs as never),
        scheduler: {
          now: Date.now,
          setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        rehydrate: async ({ body, messageAttributes }, { signal }) => {
          const result = await rehydrateFoundationWorkerContext({
            body,
            messageAttributes,
            codec,
            targetWorkerServicePrincipalId: devFixtures.servicePrincipalA,
            targetPolicyVersionId: DEV_POLICY_VERSION,
            bootstrapReference: (claims) =>
              bootstrapWorkerContextReference({
                pool: workerPool,
                token: (JSON.parse(body) as { contextReference: string }).contextReference,
                codec,
                expected: {
                  jobId: claims.jobId,
                  tenantId: claims.tenantId,
                  workspaceId: claims.workspaceId,
                  spaceId: claims.spaceId,
                  workerServicePrincipalId: claims.workerServicePrincipalId,
                  policyVersionId: claims.policyVersionId
                },
                signal
              }),
            clock: () => new Date(),
            signal
          });
          expect(result.metadata).toMatchObject({
            eventId: binding.eventId,
            jobId: binding.jobId,
            contextReferenceId: binding.referenceId
          });
          return result;
        },
        consume: (job, { signal, deadline }) =>
          consumeFoundationWorkerJob({
            pool: workerPool,
            authorization,
            input: {
              context: job.securityContext,
              jobId: job.metadata.jobId,
              contextReferenceId: job.metadata.contextReferenceId
            },
            signal,
            deadline
          })
      });
      await expect(consumer.receiveOne()).resolves.toEqual({ status: "idle" });

      const durableState = await ownerPool.query<{
        effectCount: number;
        idempotencyCount: number;
      }>(
        `SELECT aggregate.effect_count AS "effectCount",
                count(idempotency.id)::integer AS "idempotencyCount"
         FROM ops.foundation_test_aggregates aggregate
         LEFT JOIN ops.idempotency_records idempotency
           ON idempotency.aggregate_id = aggregate.id
         WHERE aggregate.id = $1
         GROUP BY aggregate.id`,
        [binding.aggregateId]
      );
      expect(durableState.rows).toHaveLength(1);
      observedEffectCount = durableState.rows[0]!.effectCount;
      observedIdempotencyCount = durableState.rows[0]!.idempotencyCount;
      expect(observedEffectCount).toBe(0);
      expect(observedIdempotencyCount).toBe(0);
    } finally {
      releasePublisher.resolve();
      await Promise.allSettled(publication ? [publication] : []);
      if (revocationSession) {
        if (revocationTransactionOpen) {
          await revocationSession.query("ROLLBACK").catch(() => undefined);
        }
        revocationSession.release();
      }
      const cleanupResults = await Promise.allSettled([
        ownerPool.query(
          `UPDATE access.access_relationships SET relation = 'manager'
           WHERE tenant_id = $1 AND workspace_id = $2
             AND subject_type = 'service_principal' AND subject_id = $3
             AND resource_type = 'space' AND resource_id = $4
             AND relation = 'viewer' AND source = 'direct'`,
          [
            devFixtures.tenantA,
            devFixtures.workspaceA,
            devFixtures.relayServicePrincipalA,
            devFixtures.restrictedSpaceA
          ]
        ),
        sqs.send(new sdk.PurgeQueueCommand({ QueueUrl: process.env.FOUNDATION_SQS_QUEUE_URL! })),
        relayRuntime ? relayRuntime.close() : Promise.resolve()
      ]);
      const cleanupFailure = cleanupResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (cleanupFailure) cleanupError = cleanupFailure.reason;
    }

    if (cleanupError) throw cleanupError;

    expect.soft(realSendCompletions, "secure result requires zero SQS publications").toBe(0);
    expect.soft(observedEffectCount, "secure result requires zero durable effects").toBe(0);
    expect
      .soft(observedIdempotencyCount, "secure result requires zero durable idempotency effects")
      .toBe(0);
  });

  async function createApiFoundationBinding(suffix: string): Promise<FoundationChainBinding> {
    const requestId = `relay-wins-${suffix}`;
    const proofKey = `relay-wins-proof-${suffix}`;
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "POST",
        url: "/__test/foundation-proof",
        headers: {
          "x-throughline-dev-identity": "tenant-a-owner",
          "x-request-id": requestId,
          traceparent: "00-55555555555555555555555555555555-6666666666666666-01"
        },
        payload: { spaceId: devFixtures.restrictedSpaceA, proofKey }
      });
    expect(response.statusCode, response.body).toBe(201);

    const committed = await ownerPool.query<FoundationChainBinding>(
      `SELECT event.id AS "eventId", event.job_id AS "jobId",
              event.context_reference_id AS "referenceId", event.tenant_id AS "tenantId",
              event.workspace_id AS "workspaceId", event.space_id AS "spaceId",
              event.aggregate_id AS "aggregateId",
              event.signed_context_reference AS "signedContextReference",
              reference.worker_service_principal_id AS "workerServicePrincipalId",
              reference.policy_version_id AS "policyVersionId"
       FROM ops.outbox_events event
       JOIN ops.security_context_references reference
         ON (reference.id, reference.job_id, reference.tenant_id, reference.workspace_id, reference.space_id) =
            (event.context_reference_id, event.job_id, event.tenant_id, event.workspace_id, event.space_id)
       JOIN ops.foundation_test_aggregates aggregate
         ON (aggregate.id, aggregate.tenant_id, aggregate.workspace_id, aggregate.space_id) =
            (event.aggregate_id, event.tenant_id, event.workspace_id, event.space_id)
       WHERE event.request_id = $1 AND aggregate.proof_key = $2`,
      [requestId, proofKey]
    );
    expect(committed.rows).toHaveLength(1);
    return committed.rows[0]!;
  }

  function createRealFoundationConsumer(binding: FoundationChainBinding) {
    const contextKeys = parseFoundationContextKeys(process.env);
    const codec = createAsyncContextReferenceCodec({
      verificationKeys: new Map(Object.entries(contextKeys.verificationKeys)),
      activeKeyId: contextKeys.activeKeyId,
      clock: () => new Date()
    });
    const authorization = new PostgresAuthorizationService(workerPool);
    return new FoundationSqsConsumer({
      queueUrl: process.env.FOUNDATION_SQS_QUEUE_URL!,
      sqs: new AwsSqsPort(sqs as never),
      scheduler: {
        now: Date.now,
        setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      rehydrate: async ({ body, messageAttributes }, { signal }) => {
        const result = await rehydrateFoundationWorkerContext({
          body,
          messageAttributes,
          codec,
          targetWorkerServicePrincipalId: devFixtures.servicePrincipalA,
          targetPolicyVersionId: DEV_POLICY_VERSION,
          bootstrapReference: (claims) =>
            bootstrapWorkerContextReference({
              pool: workerPool,
              token: (JSON.parse(body) as { contextReference: string }).contextReference,
              codec,
              expected: {
                jobId: claims.jobId,
                tenantId: claims.tenantId,
                workspaceId: claims.workspaceId,
                spaceId: claims.spaceId,
                workerServicePrincipalId: claims.workerServicePrincipalId,
                policyVersionId: claims.policyVersionId
              },
              signal
            }),
          clock: () => new Date(),
          signal
        });
        expect(result.metadata).toMatchObject({
          eventId: binding.eventId,
          jobId: binding.jobId,
          contextReferenceId: binding.referenceId
        });
        expect(result.securityContext).toMatchObject({
          tenantId: binding.tenantId,
          workspaceId: binding.workspaceId,
          requestedSpaceIds: [binding.spaceId]
        });
        return result;
      },
      consume: (job, { signal, deadline }) =>
        consumeFoundationWorkerJob({
          pool: workerPool,
          authorization,
          input: {
            context: job.securityContext,
            jobId: job.metadata.jobId,
            contextReferenceId: job.metadata.contextReferenceId
          },
          signal,
          deadline
        })
    });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = () => innerResolve();
  });
  return { promise, resolve };
}

async function waitForOwnerRevocationBlocked(
  pool: PgPool,
  revocationPid: number,
  authorityName: string
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await pool.query<{ state: string; blockers: number[] }>(
      `SELECT activity.state, pg_blocking_pids(activity.pid)::integer[] AS blockers
       FROM pg_stat_activity activity
       WHERE activity.pid = $1
         AND activity.query LIKE 'UPDATE %'`,
      [revocationPid]
    );
    if (result.rows[0]?.state === "active" && result.rows[0].blockers.length > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${authorityName} revocation did not reach the PostgreSQL lock barrier`);
}

function relayContext() {
  const now = new Date();
  return {
    ...createDevSecurityContext("tenant-a-service", { now }),
    requestId: "real-chain-relay",
    traceId: "real-chain-relay-trace",
    servicePrincipalId: devFixtures.relayServicePrincipalA,
    requestedSpaceIds: [devFixtures.restrictedSpaceA],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
  };
}
