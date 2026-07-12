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
  type PgPool
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
});

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
