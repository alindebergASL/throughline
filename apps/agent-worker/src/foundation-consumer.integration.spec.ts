import { createHash, randomBytes } from "node:crypto";
import { parseFoundationContextKeys } from "../../../scripts/foundation-test-config.js";
import { PostgresAuthorizationService } from "../../../packages/authorization/src/index.js";
import type {
  AuthorizationDecision,
  ResourceRef,
  SecurityContext
} from "../../../packages/core-types/src/index.js";
import {
  createAsyncContextReferenceCodec,
  DEV_POLICY_VERSION,
  devFixtures,
  generateUuidV7,
  type AsyncContextReferenceClaims,
  type AsyncContextReferenceCodec
} from "../../../packages/tenancy/src/index.js";
import {
  applyMigrations,
  bootstrapWorkerContextReference,
  createPgPool,
  provisionTestAppRole,
  provisionTestFoundationRoles,
  seedWaveA2DeterministicData,
  type PgPool
} from "../../../packages/db/src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const requiredEnvironment = [
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "TEST_RELAY_DATABASE_URL",
  "TEST_WORKER_DATABASE_URL",
  "FOUNDATION_SQS_ENDPOINT",
  "FOUNDATION_SQS_QUEUE_URL",
  "FOUNDATION_SQS_DLQ_URL",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON",
  "FOUNDATION_CONTEXT_ACTIVE_KEY_ID"
] as const;

type RequiredEnvironmentName = (typeof requiredEnvironment)[number];
type TestEnvironment = Record<RequiredEnvironmentName, string>;

const suppliedEnvironment = requiredEnvironment.filter((name) => Boolean(process.env[name]));
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);

if (suppliedEnvironment.length > 0 && missingEnvironment.length > 0) {
  throw new Error(
    `Foundation worker integration environment is incomplete; missing: ${missingEnvironment.join(", ")}`
  );
}

const integration =
  suppliedEnvironment.length === requiredEnvironment.length ? describe.sequential : describe.skip;

const ids = {
  aggregate: "72000000-0000-7000-8000-000000000001",
  job: "72000000-0000-7000-8000-000000000021",
  otherJob: "72000000-0000-7000-8000-000000000022",
  reference: "72000000-0000-7000-8000-000000000031",
  otherReference: "72000000-0000-7000-8000-000000000032",
  worker: "72000000-0000-7000-8000-000000000051",
  otherWorker: "72000000-0000-7000-8000-000000000052",
  workerGrant: "72000000-0000-7000-8000-000000000071",
  delegatorGrant: "72000000-0000-7000-8000-000000000072",
  delegatorUser: "72000000-0000-7000-8000-000000000081",
  delegatorPerson: "72000000-0000-7000-8000-000000000082",
  delegatorMembership: "72000000-0000-7000-8000-000000000083",
  idempotency: "72000000-0000-7000-8000-000000000061"
} as const;

let signingKeyId: string;
let signingKey: Buffer;
const fixedHandlerKey = "foundation.worker.consume.v1";
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

type SqsMessage = {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<string, { DataType?: string; StringValue?: string }>;
};

interface AwsSdk {
  SQSClient: new (configuration: object) => {
    send(
      command: object,
      options?: { abortSignal?: AbortSignal }
    ): Promise<Record<string, unknown>>;
    destroy(): void;
  };
  SendMessageCommand: new (input: Record<string, unknown>) => object;
  ReceiveMessageCommand: new (input: Record<string, unknown>) => object;
  DeleteMessageCommand: new (input: Record<string, unknown>) => object;
  ChangeMessageVisibilityCommand: new (input: Record<string, unknown>) => object;
  GetQueueAttributesCommand: new (input: Record<string, unknown>) => object;
  SetQueueAttributesCommand: new (input: Record<string, unknown>) => object;
  CreateQueueCommand: new (input: Record<string, unknown>) => object;
  DeleteQueueCommand: new (input: Record<string, unknown>) => object;
}

type SqsClient = InstanceType<AwsSdk["SQSClient"]>;

type RehydratedJob = {
  jobId: string;
  contextReferenceId: string;
  securityContext: SecurityContext;
};

type WorkerInput = {
  context: SecurityContext;
  jobId: string;
  contextReferenceId: string;
  idempotencyRecordId?: string;
};

type WorkerAuthorization = {
  canInTransaction(
    context: SecurityContext,
    action: "foundation.worker.consume",
    resource: ResourceRef,
    tx: { query: PgPool["query"] },
    options: { workerBinding: Record<string, string> }
  ): Promise<AuthorizationDecision>;
};

type ConsumeResult =
  | { status: "applied"; aggregateVersion: number }
  | { status: "confirmed_duplicate"; aggregateVersion: number };

type ConsumerResult =
  | { status: "idle" }
  | { status: "deleted"; outcome: "applied" | "confirmed_duplicate" }
  | { status: "undeleted"; reasonCode: string };

type FoundationSqsConsumer = {
  receiveOne(): Promise<ConsumerResult>;
};

type ConsumerConstructor = new (options: {
  queueUrl: string;
  sqs: RealSqsPort;
  scheduler: ManualScheduler;
  rehydrate: (
    input: { body: string; messageAttributes: Readonly<Record<string, unknown>> },
    options: { signal: AbortSignal }
  ) => Promise<RehydratedJob>;
  consume: (
    job: RehydratedJob,
    options: {
      signal: AbortSignal;
      deadline: { absoluteDeadlineMs: number; now(): number };
    }
  ) => Promise<ConsumeResult>;
  logger: CapturedLogger;
}) => FoundationSqsConsumer;

type Rehydrate = (input: {
  body: string;
  messageAttributes?: Readonly<Record<string, unknown>>;
  codec: AsyncContextReferenceCodec;
  targetWorkerServicePrincipalId: string;
  targetPolicyVersionId: string;
  bootstrapReference: (
    claims: AsyncContextReferenceClaims
  ) => Promise<Awaited<ReturnType<typeof bootstrapWorkerContextReference>>>;
  clock: () => Date;
  logger: CapturedLogger;
}) => Promise<{
  securityContext: SecurityContext;
  metadata: {
    eventId: string;
    jobId: string;
    contextReferenceId: string;
  };
}>;

type Consume = (options: {
  pool: PgPool;
  authorization: WorkerAuthorization;
  input: WorkerInput;
  signal?: AbortSignal;
  deadline?: { absoluteDeadlineMs: number; now(): number };
}) => Promise<ConsumeResult>;

type TimerHandle = { id: number };
type TimerCallback = () => void | Promise<void>;

class ManualScheduler {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: TimerCallback; cancelled: boolean }
  >();

  now = () => this.current;

  setTimeout = (callback: TimerCallback, delayMs: number): TimerHandle => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback, cancelled: false });
    return { id };
  };

  clearTimeout = (handle: TimerHandle): void => {
    const timer = this.timers.get(handle.id);
    if (timer) timer.cancelled = true;
  };

  async advanceTo(target: number): Promise<void> {
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.at;
      await timer.callback();
      await Promise.resolve();
    }
    this.current = target;
    await Promise.resolve();
  }
}

class CapturedLogger {
  readonly entries: Array<{ level: string; values: unknown[] }> = [];

  debug = (...values: unknown[]) => this.entries.push({ level: "debug", values });
  info = (...values: unknown[]) => this.entries.push({ level: "info", values });
  warn = (...values: unknown[]) => this.entries.push({ level: "warn", values });
  error = (...values: unknown[]) => this.entries.push({ level: "error", values });

  serialized(): string {
    return this.entries
      .flatMap(({ level, values }) => [level, ...values.map((value) => safeSerialize(value))])
      .join("\n");
  }
}

class RealSqsPort {
  readonly receiveInputs: Record<string, unknown>[] = [];
  readonly deleteInputs: Record<string, unknown>[] = [];
  readonly visibilityInputs: Record<string, unknown>[] = [];
  readonly receipts: SqsMessage[] = [];
  failNextDelete = false;
  failNextVisibility = false;

  constructor(
    private readonly sqs: SqsClient,
    private readonly sdk: AwsSdk
  ) {}

  async receiveMessage(
    input: Record<string, unknown>,
    guard?: { signal?: AbortSignal }
  ): Promise<{ Messages?: SqsMessage[] }> {
    const exactInput = {
      ...input,
      AttributeNames: ["All"],
      MessageAttributeNames: ["All"],
      WaitTimeSeconds: 1
    };
    this.receiveInputs.push(exactInput);
    const response = (await this.sqs.send(
      new this.sdk.ReceiveMessageCommand(exactInput),
      guard?.signal ? { abortSignal: guard.signal } : undefined
    )) as {
      Messages?: SqsMessage[];
    };
    this.receipts.push(...(response.Messages ?? []));
    return response;
  }

  async changeMessageVisibility(
    input: Record<string, unknown>,
    guard: { signal: AbortSignal; remainingDeadlineMs: number }
  ): Promise<void> {
    this.visibilityInputs.push(input);
    if (this.failNextVisibility) {
      this.failNextVisibility = false;
      throw Object.assign(new Error("test harness injected visibility failure"), {
        name: "TimeoutError"
      });
    }
    await this.sqs.send(new this.sdk.ChangeMessageVisibilityCommand(input), {
      abortSignal: guard.signal
    });
  }

  async deleteMessage(
    input: Record<string, unknown>,
    guard: { signal: AbortSignal; remainingDeadlineMs: number }
  ): Promise<void> {
    this.deleteInputs.push(input);
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw Object.assign(new Error("test harness injected DeleteMessage failure"), {
        name: "TimeoutError"
      });
    }
    await this.sqs.send(new this.sdk.DeleteMessageCommand(input), {
      abortSignal: guard.signal
    });
  }
}

integration("Foundation worker PostgreSQL + LocalStack integration RED contract", () => {
  let environment: TestEnvironment;
  let ownerPool: PgPool;
  let appPool: PgPool;
  let relayPool: PgPool;
  let workerPool: PgPool;
  let sdk: AwsSdk;
  let sqs: SqsClient;
  let rawSqs: SqsClient;
  let commandLog: Array<{ name: string; input: Record<string, unknown> }>;
  let sqsPort: RealSqsPort;
  let codec: AsyncContextReferenceCodec;
  let Consumer: ConsumerConstructor;
  let rehydrate: Rehydrate;
  let consume: Consume;
  let authorization: WorkerAuthorization;
  let token: string;
  let snapshot: SecurityContext;
  let logger: CapturedLogger;

  beforeAll(async () => {
    environment = readAndValidateEnvironment();
    const contextKeys = parseFoundationContextKeys(environment);
    signingKeyId = contextKeys.activeKeyId;
    signingKey = Buffer.from(contextKeys.verificationKeys[signingKeyId]!);
    const moduleName = "@aws-sdk/client-sqs";
    sdk = (await import(moduleName)) as unknown as AwsSdk;
    rawSqs = new sdk.SQSClient({
      endpoint: environment.FOUNDATION_SQS_ENDPOINT,
      region: environment.AWS_REGION,
      credentials: {
        accessKeyId: environment.AWS_ACCESS_KEY_ID,
        secretAccessKey: environment.AWS_SECRET_ACCESS_KEY
      }
    });
    commandLog = [];
    sqs = {
      send: (command: object, options?: { abortSignal?: AbortSignal }) => {
        const recorded = command as {
          constructor?: { name?: string };
          input?: Record<string, unknown>;
        };
        commandLog.push({
          name: recorded.constructor?.name ?? "UnknownCommand",
          input: recorded.input ?? {}
        });
        return rawSqs.send(command, options);
      },
      destroy: () => rawSqs.destroy()
    };

    ownerPool = createPgPool(environment.TEST_DATABASE_URL);
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, environment.TEST_APP_DATABASE_URL);
    await provisionTestFoundationRoles(
      ownerPool,
      environment.TEST_RELAY_DATABASE_URL,
      environment.TEST_WORKER_DATABASE_URL
    );
    await seedWaveA2DeterministicData(ownerPool);
    appPool = createPgPool(environment.TEST_APP_DATABASE_URL);
    relayPool = createPgPool(environment.TEST_RELAY_DATABASE_URL);
    workerPool = createPgPool(environment.TEST_WORKER_DATABASE_URL);
    authorization = new PostgresAuthorizationService(workerPool) as unknown as WorkerAuthorization;

    codec = createAsyncContextReferenceCodec({
      verificationKeys: new Map(
        Object.entries(contextKeys.verificationKeys).map(([keyId, key]) => [keyId, key])
      ),
      activeKeyId: signingKeyId,
      clock: () => new Date()
    });

    const consumerModulePath = "./foundation-consumer.js";
    const consumerModule = (await import(consumerModulePath)) as {
      FoundationSqsConsumer?: ConsumerConstructor;
    };
    if (typeof consumerModule.FoundationSqsConsumer !== "function") {
      throw new Error("Task 7 requires FoundationSqsConsumer");
    }
    Consumer = consumerModule.FoundationSqsConsumer;

    const contextModulePath = "./worker-context.js";
    const contextModule = (await import(contextModulePath)) as {
      rehydrateFoundationWorkerContext?: Rehydrate;
    };
    if (typeof contextModule.rehydrateFoundationWorkerContext !== "function") {
      throw new Error("Task 7 requires rehydrateFoundationWorkerContext");
    }
    rehydrate = contextModule.rehydrateFoundationWorkerContext;

    const transactionModulePath = "../../../packages/db/src/worker-transaction.js";
    const transactionModule = (await import(transactionModulePath)) as {
      consumeFoundationWorkerJob?: Consume;
    };
    if (typeof transactionModule.consumeFoundationWorkerJob !== "function") {
      throw new Error("Task 7 requires consumeFoundationWorkerJob");
    }
    consume = transactionModule.consumeFoundationWorkerJob;

    await configureNativeRedrive();
  });

  beforeEach(async () => {
    await clearQueues();
    await resetFixture();
    commandLog.length = 0;
    sqsPort = new RealSqsPort(sqs, sdk);
    logger = new CapturedLogger();
  });

  afterAll(async () => {
    if (ownerPool) await removeRollbackTrigger().catch(() => undefined);
    sqs?.destroy();
    await workerPool?.end();
    await relayPool?.end();
    await appPool?.end();
    await ownerPool?.end();
  });

  it("uses four distinct NOBYPASSRLS roles and rejects owner/app/relay worker transactions before effects", async () => {
    const roleRows = await ownerPool.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolbypassrls
       FROM pg_roles
       WHERE rolname IN ('throughline_app', 'throughline_relay', 'throughline_worker')
       ORDER BY rolname`
    );
    expect(roleRows.rows).toEqual([
      { rolname: "throughline_app", rolbypassrls: false },
      { rolname: "throughline_relay", rolbypassrls: false },
      { rolname: "throughline_worker", rolbypassrls: false }
    ]);
    await expect(workerPool.query("SELECT current_user AS value")).resolves.toMatchObject({
      rows: [{ value: "throughline_worker" }]
    });

    for (const pool of [ownerPool, appPool, relayPool]) {
      await expect(consume({ pool, authorization, input: workerInput() })).rejects.toBeDefined();
      await expectState({ effectCount: 0, idempotencyCount: 0, pendingJobId: ids.job });
    }
  });

  it("receives, verifies, bootstraps, live-authorizes, commits one effect/idempotency pair, then really deletes", async () => {
    const sent = await sendSource(envelope());
    const result = await createConsumer().receiveOne();

    expect(result).toEqual({ status: "deleted", outcome: "applied" });
    expect(sqsPort.receiveInputs).toEqual([
      expect.objectContaining({
        QueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 30
      })
    ]);
    expect(sqsPort.receipts[0]).toMatchObject({ MessageId: sent.MessageId });
    expect(sqsPort.deleteInputs).toHaveLength(1);
    await expectExactAppliedState();
    await expectQueueEmpty(environment.FOUNDATION_SQS_QUEUE_URL);
  });

  it("processes two concurrent actual duplicate deliveries as one applied and one exact confirmed duplicate", async () => {
    const body = JSON.stringify(envelope());
    await sendSourceBody(body);
    await sendSourceBody(body);

    const firstPort = new RealSqsPort(sqs, sdk);
    const secondPort = new RealSqsPort(sqs, sdk);
    const [first, second] = await Promise.all([
      createConsumer(firstPort).receiveOne(),
      createConsumer(secondPort).receiveOne()
    ]);

    expect([first, second].map((result) => JSON.stringify(result)).sort()).toEqual(
      [
        { status: "deleted", outcome: "applied" },
        { status: "deleted", outcome: "confirmed_duplicate" }
      ]
        .map((result) => JSON.stringify(result))
        .sort()
    );
    expect(firstPort.deleteInputs).toHaveLength(1);
    expect(secondPort.deleteInputs).toHaveLength(1);
    await expectExactAppliedState();
    await expectQueueEmpty(environment.FOUNDATION_SQS_QUEUE_URL);
  });

  it("leaves the receipt and rolls back both writes after a harness-forced crash following idempotency insertion, then retries once", async () => {
    await installRollbackAfterIdempotencyTrigger();
    await sendSource(envelope());

    const failed = await createConsumer().receiveOne();
    expect(failed).toMatchObject({ status: "undeleted" });
    expect(sqsPort.deleteInputs).toHaveLength(0);
    await expectState({ effectCount: 0, idempotencyCount: 0, pendingJobId: ids.job });

    await removeRollbackTrigger();
    await accelerateLastReceipt(sqsPort);
    const retried = await createConsumer().receiveOne();
    expect(retried).toEqual({ status: "deleted", outcome: "applied" });
    await expectExactAppliedState();
  });

  it("extends real receipt visibility at 15s, then the unchanged 20s deadline aborts the aggregate-lock-blocked transaction", async () => {
    const blocker = await ownerPool.connect();
    const unrelatedWorker = await workerPool.connect();
    const scheduler = new ManualScheduler();
    let unrelatedQuery: Promise<unknown> | undefined;
    let unrelatedPid: number | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM ops.foundation_test_aggregates WHERE id = $1 FOR UPDATE",
        [ids.aggregate]
      );
      const blockerPid = await backendPid(blocker);
      unrelatedPid = await backendPid(unrelatedWorker);
      unrelatedQuery = unrelatedWorker.query("SELECT pg_sleep(10)");
      await waitForActiveBackend(unrelatedPid);
      await sendSource(envelope());

      const result = createConsumer(sqsPort, scheduler).receiveOne();
      const targetPid = await waitForWorkerAggregateLock(blockerPid);
      expect(targetPid).not.toBe(unrelatedPid);
      await scheduler.advanceTo(15_000);
      expect(sqsPort.visibilityInputs).toEqual([
        {
          QueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
          ReceiptHandle: sqsPort.receipts[0]?.ReceiptHandle,
          VisibilityTimeout: 30
        }
      ]);
      expect(sqsPort.deleteInputs).toHaveLength(0);

      await scheduler.advanceTo(20_000);
      await expect(result).resolves.toEqual({
        status: "undeleted",
        reasonCode: "deadline_exceeded"
      });
      await expectWorkerAggregateLockWaitGone(targetPid);
      await expectState({ effectCount: 0, idempotencyCount: 0, pendingJobId: ids.job });
      expect(sqsPort.deleteInputs).toHaveLength(0);
      await expectStillPending(unrelatedQuery);
      await expectBackendState(unrelatedPid, { state: "active", waitEventType: "Timeout" });
    } finally {
      if (unrelatedQuery) {
        if (unrelatedPid) await ownerPool.query("SELECT pg_cancel_backend($1)", [unrelatedPid]);
        await unrelatedQuery.catch(() => undefined);
      }
      unrelatedWorker.release();
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("rolls back the real aggregate-lock-blocked transaction when the 15s visibility extension fails", async () => {
    const blocker = await ownerPool.connect();
    const scheduler = new ManualScheduler();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM ops.foundation_test_aggregates WHERE id = $1 FOR UPDATE",
        [ids.aggregate]
      );
      const blockerPid = await backendPid(blocker);
      await sendSource(envelope());
      sqsPort.failNextVisibility = true;

      const result = createConsumer(sqsPort, scheduler).receiveOne();
      const targetPid = await waitForWorkerAggregateLock(blockerPid);
      await scheduler.advanceTo(15_000);
      await expect(result).resolves.toEqual({
        status: "undeleted",
        reasonCode: "visibility_extension_failed"
      });
      await expectWorkerAggregateLockWaitGone(targetPid);
      await expectState({ effectCount: 0, idempotencyCount: 0, pendingJobId: ids.job });
      expect(sqsPort.visibilityInputs).toHaveLength(1);
      expect(sqsPort.deleteInputs).toHaveLength(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("keeps a post-commit DeleteMessage failure receipt, then deletes its exact duplicate redelivery without a second effect", async () => {
    await sendSource(envelope());
    sqsPort.failNextDelete = true;

    const ambiguous = await createConsumer().receiveOne();
    expect(ambiguous).toMatchObject({ status: "undeleted" });
    await expectExactAppliedState();
    await accelerateLastReceipt(sqsPort);

    const redelivery = await createConsumer().receiveOne();
    expect(redelivery).toEqual({ status: "deleted", outcome: "confirmed_duplicate" });
    await expectExactAppliedState();
    await expectQueueEmpty(environment.FOUNDATION_SQS_QUEUE_URL);
  });

  it("uses isolated broker-native redrive for one forged full cycle at exact receives 1,2,3", async () => {
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    let sourceQueueUrl: string | undefined;
    let dlqQueueUrl: string | undefined;
    try {
      const createdDlq = (await sqs.send(
        new sdk.CreateQueueCommand({ QueueName: `throughline-task7-dlq-${suffix}` })
      )) as { QueueUrl?: string };
      dlqQueueUrl = createdDlq.QueueUrl;
      expect(dlqQueueUrl).toBeTruthy();
      const dlqAttributes = (await sqs.send(
        new sdk.GetQueueAttributesCommand({
          QueueUrl: dlqQueueUrl,
          AttributeNames: ["QueueArn"]
        })
      )) as { Attributes?: { QueueArn?: string } };
      const deadLetterTargetArn = dlqAttributes.Attributes?.QueueArn;
      expect(deadLetterTargetArn).toBeTruthy();

      const createdSource = (await sqs.send(
        new sdk.CreateQueueCommand({ QueueName: `throughline-task7-source-${suffix}` })
      )) as { QueueUrl?: string };
      sourceQueueUrl = createdSource.QueueUrl;
      expect(sourceQueueUrl).toBeTruthy();
      await sqs.send(
        new sdk.SetQueueAttributesCommand({
          QueueUrl: sourceQueueUrl,
          Attributes: {
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: "3" })
          }
        })
      );
      const sourceAttributes = (await sqs.send(
        new sdk.GetQueueAttributesCommand({
          QueueUrl: sourceQueueUrl,
          AttributeNames: ["QueueArn", "RedrivePolicy"]
        })
      )) as { Attributes?: { QueueArn?: string; RedrivePolicy?: string } };
      expect(JSON.parse(sourceAttributes.Attributes?.RedrivePolicy ?? "null")).toEqual({
        deadLetterTargetArn,
        maxReceiveCount: "3"
      });
      const sourceArn = sourceAttributes.Attributes?.QueueArn;
      expect(sourceArn).toBeTruthy();

      const forgedEnvelope = envelope(forgeMac(token));
      const body = JSON.stringify(forgedEnvelope);
      await sqs.send(
        new sdk.SendMessageCommand({
          QueueUrl: sourceQueueUrl,
          MessageBody: body,
          MessageAttributes: queueMessageAttributes(forgedEnvelope)
        })
      );
      const isolatedPort = new RealSqsPort(sqs, sdk);
      const workerCommandStart = commandLog.length;

      for (let receiptNumber = 1; receiptNumber <= 3; receiptNumber += 1) {
        const result = await createConsumer(
          isolatedPort,
          new ManualScheduler(),
          sourceQueueUrl!
        ).receiveOne();
        expect(result).toEqual({
          status: "undeleted",
          reasonCode: "context_reference_denied"
        });
        const receipt = isolatedPort.receipts.at(-1)!;
        expect(receipt.Attributes?.ApproximateReceiveCount).toBe(String(receiptNumber));
        expect(isolatedPort.deleteInputs).toHaveLength(0);
        expect(
          commandLog
            .slice(workerCommandStart)
            .filter(
              ({ name, input }) => name === "SendMessageCommand" && input.QueueUrl === dlqQueueUrl
            )
        ).toEqual([]);
        await expectState({ effectCount: 0, idempotencyCount: 0, pendingJobId: ids.job });
        await sqs.send(
          new sdk.ChangeMessageVisibilityCommand({
            QueueUrl: sourceQueueUrl,
            ReceiptHandle: receipt.ReceiptHandle,
            VisibilityTimeout: 0
          })
        );
      }

      const fourthSourceAttempt = (await sqs.send(
        new sdk.ReceiveMessageCommand({
          QueueUrl: sourceQueueUrl,
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 0,
          WaitTimeSeconds: 1,
          AttributeNames: ["All"],
          MessageAttributeNames: ["All"]
        })
      )) as { Messages?: SqsMessage[] };
      expect(fourthSourceAttempt.Messages ?? []).toEqual([]);

      const redriveDeadline = performance.now() + 15_000;
      let dlqMessage: SqsMessage | undefined;
      while (!dlqMessage && performance.now() < redriveDeadline) {
        const response = (await sqs.send(
          new sdk.ReceiveMessageCommand({
            QueueUrl: dlqQueueUrl,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 0,
            WaitTimeSeconds: 1,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"]
          })
        )) as { Messages?: SqsMessage[] };
        dlqMessage = response.Messages?.[0];
      }
      expect(dlqMessage).toBeDefined();
      expect(dlqMessage!.Body).toBe(body);
      const redrivenEnvelope = JSON.parse(dlqMessage!.Body!) as ReturnType<typeof envelope>;
      expect(redrivenEnvelope.eventId).toBe(forgedEnvelope.eventId);
      expect(redrivenEnvelope.jobId).toBe(forgedEnvelope.jobId);
      expect(redrivenEnvelope.contextReference).toBe(forgedEnvelope.contextReference);
      expect(dlqMessage!.Attributes?.DeadLetterQueueSourceArn).toBe(sourceArn);
      expect(dlqMessage!.MessageAttributes).toMatchObject({
        eventId: { StringValue: forgedEnvelope.eventId },
        jobId: { StringValue: ids.job }
      });
      expect(isolatedPort.deleteInputs).toHaveLength(0);
    } finally {
      for (const QueueUrl of [sourceQueueUrl, dlqQueueUrl]) {
        if (!QueueUrl) continue;
        await sqs.send(new sdk.DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      }
    }
  }, 25_000);

  it.each([
    ["removed worker contributor grant", ids.workerGrant],
    ["removed delegator restricted-Space authority", ids.delegatorGrant]
  ])("%s produces zero effects and remains undeleted", async (_case, grantId) => {
    await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [grantId]);
    await sendSource(envelope());

    await expect(createConsumer().receiveOne()).resolves.toEqual({
      status: "undeleted",
      reasonCode: "terminal_denial"
    });
    expect(sqsPort.deleteInputs).toHaveLength(0);
    await expectState({ effectCount: 0, idempotencyCount: 0, pendingJobId: ids.job });
  });

  it.each([
    ["expired token", async () => ({ message: envelope(issueExpiredToken()) })],
    [
      "revoked reference",
      async () => {
        await ownerPool.query(
          "UPDATE ops.security_context_references SET status = 'revoked', revoked_at = clock_timestamp(), revocation_reason = 'task7-integration' WHERE id = $1",
          [ids.reference]
        );
        return { message: envelope() };
      }
    ],
    [
      "retired policy",
      async () => {
        await ownerPool.query(
          "UPDATE identity.policy_versions SET status = 'retired' WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
          [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
        );
        return { message: envelope() };
      }
    ],
    ["wrong envelope job", async () => ({ message: envelope(token, { jobId: ids.otherJob }) })],
    [
      "wrong signed reference",
      async () => ({
        message: envelope(issueToken({ referenceId: ids.otherReference }).token)
      })
    ],
    [
      "wrong worker principal",
      async () => ({
        message: envelope(issueToken({ workerServicePrincipalId: ids.otherWorker }).token)
      })
    ],
    [
      "wrong worker purpose",
      async () => {
        await ownerPool.query(
          "UPDATE identity.service_principals SET purpose = 'system' WHERE id = $1",
          [ids.worker]
        );
        return { message: envelope() };
      }
    ],
    [
      "cross-tenant scope",
      async () => ({
        message: scopedEnvelope({ tenantId: devFixtures.tenantB })
      })
    ],
    [
      "cross-workspace scope",
      async () => ({
        message: scopedEnvelope({ workspaceId: devFixtures.workspaceB })
      })
    ],
    [
      "cross-Space scope",
      async () => ({
        message: scopedEnvelope({ spaceId: devFixtures.rootSpaceB })
      })
    ],
    [
      "out-of-order pending job",
      async () => {
        await ownerPool.query(
          "UPDATE ops.foundation_test_aggregates SET pending_job_id = $2 WHERE id = $1",
          [ids.aggregate, ids.otherJob]
        );
        return { message: envelope() };
      }
    ]
  ] as const)(
    "%s produces zero effects and leaves the actual receipt undeleted",
    async (_case, arrange) => {
      const { message } = await arrange();
      await sendSource(message);

      const expectedReasonCode =
        _case === "retired policy" || _case === "wrong worker purpose"
          ? "terminal_denial"
          : _case === "out-of-order pending job"
            ? "out_of_order"
            : "context_reference_denied";
      await expect(createConsumer().receiveOne()).resolves.toEqual({
        status: "undeleted",
        reasonCode: expectedReasonCode
      });
      expect(sqsPort.deleteInputs).toHaveLength(0);
      await expectState({ effectCount: 0, idempotencyCount: 0 });
    }
  );

  it("puts only the opaque signed reference and scoped metadata on SQS and captures neither token nor raw context in errors/logs", async () => {
    const message = envelope(forgeMac(token));
    const sent = await sendSource(message);
    expect(JSON.parse(sent.Body!)).toEqual({
      version: "v1",
      eventId: message.eventId,
      jobId: ids.job,
      scope: {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA
      },
      contextReference: message.contextReference,
      requestId: "task-7-integration",
      traceparent,
      tracestate: "throughline=test"
    });
    expect(sent.MessageAttributes).toEqual({
      tenantId: { DataType: "String", StringValue: devFixtures.tenantA },
      workspaceId: { DataType: "String", StringValue: devFixtures.workspaceA },
      spaceId: { DataType: "String", StringValue: devFixtures.restrictedSpaceA },
      eventId: { DataType: "String", StringValue: message.eventId },
      jobId: { DataType: "String", StringValue: ids.job },
      traceparent: { DataType: "String", StringValue: traceparent }
    });
    expect(sent.Body).not.toMatch(
      /actorUserId|actorMembershipId|membershipIds|roleHints|dataClassCeiling|servicePrincipalId/i
    );

    const outcome = await createConsumer().receiveOne();
    const captured = `${safeSerialize(outcome)}\n${logger.serialized()}`;
    for (const fieldName of [
      "actorUserId",
      "actorMembershipId",
      "delegatedByUserId",
      "delegatedByMembershipId",
      "membershipIds",
      "roleHints",
      "requestedSpaceIds",
      "signingKeyId",
      "contextReference"
    ]) {
      expect(captured, fieldName).not.toContain(fieldName);
    }
    for (const sensitiveValue of [
      ids.delegatorUser,
      ids.delegatorMembership,
      ids.worker,
      devFixtures.restrictedSpaceA,
      snapshot.roleHints[0],
      signingKeyId,
      signingKey.toString("hex"),
      signingKey.toString("base64"),
      message.contextReference,
      JSON.stringify(snapshot)
    ]) {
      expect(captured, sensitiveValue).not.toContain(sensitiveValue);
    }
    expect(sqsPort.deleteInputs).toHaveLength(0);
    await expectState({ effectCount: 0, idempotencyCount: 0, pendingJobId: ids.job });
  });

  function createConsumer(
    port = sqsPort,
    scheduler = new ManualScheduler(),
    queueUrl = environment.FOUNDATION_SQS_QUEUE_URL
  ): FoundationSqsConsumer {
    return new Consumer({
      queueUrl,
      sqs: port,
      scheduler,
      rehydrate: async ({ body, messageAttributes }) => {
        const parsed = JSON.parse(body) as { contextReference: string };
        const result = await rehydrate({
          body,
          messageAttributes,
          codec,
          targetWorkerServicePrincipalId: ids.worker,
          targetPolicyVersionId: DEV_POLICY_VERSION,
          bootstrapReference: (claims) =>
            bootstrapWorkerContextReference({
              pool: workerPool,
              token: parsed.contextReference,
              codec,
              expected: {
                jobId: claims.jobId,
                tenantId: claims.tenantId,
                workspaceId: claims.workspaceId,
                spaceId: claims.spaceId,
                workerServicePrincipalId: claims.workerServicePrincipalId,
                policyVersionId: claims.policyVersionId
              }
            }),
          clock: () => new Date(),
          logger
        });
        return {
          jobId: result.metadata.jobId,
          contextReferenceId: result.metadata.contextReferenceId,
          securityContext: result.securityContext
        };
      },
      consume: (job, { signal, deadline }) =>
        consume({
          pool: workerPool,
          authorization,
          input: {
            context: job.securityContext,
            jobId: job.jobId,
            contextReferenceId: job.contextReferenceId,
            idempotencyRecordId: ids.idempotency
          },
          signal,
          deadline
        }),
      logger
    });
  }

  function issueExpiredToken(): string {
    const expiredCodec = createAsyncContextReferenceCodec({
      verificationKeys: new Map([[signingKeyId, signingKey]]),
      activeKeyId: signingKeyId,
      clock: () => new Date(Date.now() - 2_000)
    });
    return issueToken({}, expiredCodec, 1).token;
  }

  function issueToken(
    overrides: Partial<{
      referenceId: string;
      jobId: string;
      tenantId: string;
      workspaceId: string;
      spaceId: string;
      workerServicePrincipalId: string;
    }> = {},
    signer = codec,
    ttlSeconds = 600
  ) {
    return signer.issue({
      referenceId: ids.reference,
      jobId: ids.job,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.restrictedSpaceA,
      workerServicePrincipalId: ids.worker,
      policyVersionId: DEV_POLICY_VERSION,
      ttlSeconds,
      ...overrides
    });
  }

  function envelope(
    contextReference = token,
    overrides: Partial<{
      eventId: string;
      jobId: string;
      scope: { tenantId: string; workspaceId: string; spaceId: string };
    }> = {}
  ) {
    return {
      version: "v1",
      eventId: overrides.eventId ?? generateUuidV7(),
      jobId: overrides.jobId ?? ids.job,
      scope: overrides.scope ?? {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA
      },
      contextReference,
      requestId: "task-7-integration",
      traceparent,
      tracestate: "throughline=test"
    };
  }

  function scopedEnvelope(
    scopeOverride: Partial<{ tenantId: string; workspaceId: string; spaceId: string }>
  ) {
    const scope = {
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.restrictedSpaceA,
      ...scopeOverride
    };
    const scopedToken = issueToken(scope).token;
    return envelope(scopedToken, { scope });
  }

  function workerInput(overrides: Partial<WorkerInput> = {}): WorkerInput {
    return {
      context: {
        requestId: snapshot.requestId,
        traceId: snapshot.traceId,
        tenantId: snapshot.tenantId,
        workspaceId: snapshot.workspaceId,
        servicePrincipalId: ids.worker,
        delegatedByUserId: ids.delegatorUser,
        delegatedByMembershipId: ids.delegatorMembership,
        requestedSpaceIds: [devFixtures.restrictedSpaceA],
        membershipIds: [],
        roleHints: [],
        dataClassCeiling: snapshot.dataClassCeiling,
        policyVersion: snapshot.policyVersion,
        issuedAt: snapshot.issuedAt,
        expiresAt: snapshot.expiresAt
      },
      jobId: ids.job,
      contextReferenceId: ids.reference,
      idempotencyRecordId: ids.idempotency,
      ...overrides
    };
  }

  async function resetFixture(): Promise<void> {
    await removeRollbackTrigger();
    await ownerPool.query("DELETE FROM ops.idempotency_records WHERE aggregate_id = $1", [
      ids.aggregate
    ]);
    await ownerPool.query("DELETE FROM ops.security_context_references WHERE id = $1", [
      ids.reference
    ]);
    await ownerPool.query("DELETE FROM ops.foundation_test_aggregates WHERE id = $1", [
      ids.aggregate
    ]);
    await ownerPool.query("DELETE FROM access.access_relationships WHERE id IN ($1, $2)", [
      ids.workerGrant,
      ids.delegatorGrant
    ]);
    await ownerPool.query("DELETE FROM identity.service_principals WHERE id = $1", [ids.worker]);
    await ownerPool.query("DELETE FROM identity.memberships WHERE id = $1", [
      ids.delegatorMembership
    ]);
    await ownerPool.query("DELETE FROM identity.people WHERE id = $1", [ids.delegatorPerson]);
    await ownerPool.query("DELETE FROM identity.users WHERE id = $1", [ids.delegatorUser]);
    await ownerPool.query("UPDATE identity.tenants SET status = 'active' WHERE id = $1", [
      devFixtures.tenantA
    ]);
    await ownerPool.query("UPDATE identity.workspaces SET status = 'active' WHERE id = $1", [
      devFixtures.workspaceA
    ]);
    await ownerPool.query(
      "UPDATE identity.policy_versions SET status = 'active' WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
      [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
    );
    await ownerPool.query("UPDATE access.spaces SET archived_at = NULL WHERE id = $1", [
      devFixtures.restrictedSpaceA
    ]);
    await ownerPool.query(
      `INSERT INTO identity.users (id, auth_provider, auth_subject, primary_email, status)
       VALUES ($1, 'dev', 'task-7-integration-member', 'task-7-integration-member@example.com', 'active')`,
      [ids.delegatorUser]
    );
    await ownerPool.query(
      `INSERT INTO identity.people
         (id, tenant_id, workspace_id, display_name, primary_email, is_internal)
       VALUES ($1,$2,$3,'Task 7 Integration Member','task-7-integration-member@example.com',true)`,
      [ids.delegatorPerson, devFixtures.tenantA, devFixtures.workspaceA]
    );
    await ownerPool.query(
      `INSERT INTO identity.memberships
         (id, tenant_id, workspace_id, user_id, person_id, role, status)
       VALUES ($1,$2,$3,$4,$5,'member','active')`,
      [
        ids.delegatorMembership,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        ids.delegatorUser,
        ids.delegatorPerson
      ]
    );
    await ownerPool.query(
      `INSERT INTO identity.service_principals
         (id, tenant_id, workspace_id, name, purpose, status)
       VALUES ($1,$2,$3,'Task 7 Integration Worker','worker','active')`,
      [ids.worker, devFixtures.tenantA, devFixtures.workspaceA]
    );
    await ownerPool.query(
      `INSERT INTO access.access_relationships
         (id, tenant_id, workspace_id, subject_type, subject_id, relation,
          resource_type, resource_id, source)
       VALUES
         ($1,$3,$4,'service_principal',$5,'contributor','space',$6,'direct'),
         ($2,$3,$4,'membership',$7,'contributor','space',$6,'direct')`,
      [
        ids.workerGrant,
        ids.delegatorGrant,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        ids.worker,
        devFixtures.restrictedSpaceA,
        ids.delegatorMembership
      ]
    );

    const issued = issueToken();
    token = issued.token;
    const issuedAt = new Date(issued.claims.issuedAt * 1_000);
    const expiresAt = new Date(issued.claims.expiresAt * 1_000);
    snapshot = {
      requestId: "task-7-integration",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      actorUserId: ids.delegatorUser,
      actorMembershipId: ids.delegatorMembership,
      requestedSpaceIds: [devFixtures.restrictedSpaceA],
      membershipIds: [ids.delegatorMembership],
      roleHints: ["member"],
      dataClassCeiling: "restricted",
      policyVersion: DEV_POLICY_VERSION,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    await ownerPool.query(
      `INSERT INTO ops.security_context_references
         (id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
          delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
          issued_at, expires_at, status, signing_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,'active',$13)`,
      [
        ids.reference,
        ids.job,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.restrictedSpaceA,
        ids.worker,
        ids.delegatorUser,
        ids.delegatorMembership,
        DEV_POLICY_VERSION,
        JSON.stringify(snapshot),
        issuedAt,
        expiresAt,
        signingKeyId
      ]
    );
    await ownerPool.query(
      `INSERT INTO ops.foundation_test_aggregates
         (id, tenant_id, workspace_id, space_id, proof_key, pending_job_id)
       VALUES ($1,$2,$3,$4,'task-7-real-consumer',$5)`,
      [
        ids.aggregate,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.restrictedSpaceA,
        ids.job
      ]
    );
  }

  async function sendSource(message: ReturnType<typeof envelope>) {
    return sendSourceBody(JSON.stringify(message), message);
  }

  function queueMessageAttributes(message: ReturnType<typeof envelope>) {
    return {
      tenantId: { DataType: "String", StringValue: message.scope.tenantId },
      workspaceId: { DataType: "String", StringValue: message.scope.workspaceId },
      spaceId: { DataType: "String", StringValue: message.scope.spaceId },
      eventId: { DataType: "String", StringValue: message.eventId },
      jobId: { DataType: "String", StringValue: message.jobId },
      traceparent: { DataType: "String", StringValue: traceparent }
    };
  }

  async function sendSourceBody(
    body: string,
    parsed = JSON.parse(body) as ReturnType<typeof envelope>
  ) {
    const response = (await sqs.send(
      new sdk.SendMessageCommand({
        QueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
        MessageBody: body,
        MessageAttributes: queueMessageAttributes(parsed)
      })
    )) as { MessageId?: string };
    expect(response.MessageId).toBeTruthy();
    return {
      MessageId: response.MessageId,
      Body: body,
      MessageAttributes: {
        tenantId: { DataType: "String", StringValue: parsed.scope.tenantId },
        workspaceId: { DataType: "String", StringValue: parsed.scope.workspaceId },
        spaceId: { DataType: "String", StringValue: parsed.scope.spaceId },
        eventId: { DataType: "String", StringValue: parsed.eventId },
        jobId: { DataType: "String", StringValue: parsed.jobId },
        traceparent: { DataType: "String", StringValue: traceparent }
      }
    };
  }

  async function configureNativeRedrive(): Promise<void> {
    const dlqAttributes = (await sqs.send(
      new sdk.GetQueueAttributesCommand({
        QueueUrl: environment.FOUNDATION_SQS_DLQ_URL,
        AttributeNames: ["QueueArn"]
      })
    )) as { Attributes?: { QueueArn?: string } };
    const deadLetterTargetArn = dlqAttributes.Attributes?.QueueArn;
    if (!deadLetterTargetArn) throw new Error("LocalStack DLQ did not expose QueueArn");
    await sqs.send(
      new sdk.SetQueueAttributesCommand({
        QueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: "3" })
        }
      })
    );
    const sourceAttributes = (await sqs.send(
      new sdk.GetQueueAttributesCommand({
        QueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
        AttributeNames: ["RedrivePolicy"]
      })
    )) as { Attributes?: { RedrivePolicy?: string } };
    expect(JSON.parse(sourceAttributes.Attributes?.RedrivePolicy ?? "null")).toEqual({
      deadLetterTargetArn,
      maxReceiveCount: "3"
    });
  }

  async function clearQueues(): Promise<void> {
    for (const receipt of sqsPort?.receipts ?? []) {
      if (!receipt.ReceiptHandle) continue;
      await sqs
        .send(
          new sdk.ChangeMessageVisibilityCommand({
            QueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
            ReceiptHandle: receipt.ReceiptHandle,
            VisibilityTimeout: 0
          })
        )
        .catch(() => undefined);
    }
    for (const QueueUrl of [
      environment.FOUNDATION_SQS_QUEUE_URL,
      environment.FOUNDATION_SQS_DLQ_URL
    ]) {
      await drainQueue(QueueUrl);
    }
  }

  async function drainQueue(QueueUrl: string): Promise<void> {
    let consecutiveEmptyReceives = 0;
    for (let attempt = 0; attempt < 50 && consecutiveEmptyReceives < 2; attempt += 1) {
      const response = (await sqs.send(
        new sdk.ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 0,
          WaitTimeSeconds: 0
        })
      )) as { Messages?: SqsMessage[] };
      const messages = response.Messages ?? [];
      if (messages.length === 0) {
        consecutiveEmptyReceives += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      consecutiveEmptyReceives = 0;
      for (const message of messages) {
        if (!message.ReceiptHandle) continue;
        await sqs.send(
          new sdk.DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle })
        );
      }
    }
    expect((await queueCounts(QueueUrl)).total).toBe(0);
  }

  async function queueCounts(
    QueueUrl: string
  ): Promise<{ visible: number; invisible: number; total: number }> {
    const response = (await sqs.send(
      new sdk.GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"]
      })
    )) as {
      Attributes?: {
        ApproximateNumberOfMessages?: string;
        ApproximateNumberOfMessagesNotVisible?: string;
      };
    };
    const visible = Number(response.Attributes?.ApproximateNumberOfMessages ?? 0);
    const invisible = Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    return { visible, invisible, total: visible + invisible };
  }

  async function accelerateLastReceipt(port: RealSqsPort): Promise<void> {
    const receipt = port.receipts.at(-1);
    expect(receipt?.ReceiptHandle).toBeTruthy();
    await sqs.send(
      new sdk.ChangeMessageVisibilityCommand({
        QueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
        ReceiptHandle: receipt!.ReceiptHandle,
        VisibilityTimeout: 0
      })
    );
  }

  async function expectQueueEmpty(QueueUrl: string): Promise<void> {
    await pollUntil(async () => (await queueCounts(QueueUrl)).total === 0, {
      timeoutMs: 5_000,
      description: `empty ${new URL(QueueUrl).pathname}`
    });
  }

  async function expectState(expected: {
    effectCount: number;
    idempotencyCount: number;
    pendingJobId?: string | null;
  }): Promise<void> {
    const aggregate = await ownerPool.query<{
      effectCount: number;
      pendingJobId: string | null;
    }>(
      `SELECT effect_count AS "effectCount", pending_job_id AS "pendingJobId"
       FROM ops.foundation_test_aggregates WHERE id = $1`,
      [ids.aggregate]
    );
    expect(aggregate.rows[0]?.effectCount).toBe(expected.effectCount);
    if ("pendingJobId" in expected) {
      expect(aggregate.rows[0]?.pendingJobId).toBe(expected.pendingJobId);
    }
    const idempotency = await ownerPool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM ops.idempotency_records WHERE aggregate_id = $1",
      [ids.aggregate]
    );
    expect(idempotency.rows[0]?.count).toBe(expected.idempotencyCount);
  }

  async function expectExactAppliedState(): Promise<void> {
    const aggregate = await ownerPool.query<{
      effectCount: number;
      aggregateVersion: number;
      pendingJobId: string | null;
      lastEffectJobId: string | null;
    }>(
      `SELECT effect_count AS "effectCount", aggregate_version AS "aggregateVersion",
              pending_job_id AS "pendingJobId", last_effect_job_id AS "lastEffectJobId"
       FROM ops.foundation_test_aggregates WHERE id = $1`,
      [ids.aggregate]
    );
    expect(aggregate.rows).toEqual([
      {
        effectCount: 1,
        aggregateVersion: 2,
        pendingJobId: null,
        lastEffectJobId: ids.job
      }
    ]);
    const records = await ownerPool.query<{
      tenantId: string;
      workspaceId: string;
      spaceId: string;
      jobId: string;
      contextReferenceId: string;
      handlerKey: string;
      aggregateId: string;
      aggregateVersion: number;
      effectHash: string;
    }>(
      `SELECT tenant_id AS "tenantId", workspace_id AS "workspaceId", space_id AS "spaceId",
              job_id AS "jobId", context_reference_id AS "contextReferenceId",
              handler_key AS "handlerKey", aggregate_id AS "aggregateId",
              aggregate_version AS "aggregateVersion", effect_hash AS "effectHash"
       FROM ops.idempotency_records WHERE aggregate_id = $1`,
      [ids.aggregate]
    );
    expect(records.rows).toEqual([
      {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA,
        jobId: ids.job,
        contextReferenceId: ids.reference,
        handlerKey: fixedHandlerKey,
        aggregateId: ids.aggregate,
        aggregateVersion: 2,
        effectHash: deterministicEffectHash(ids.aggregate, 2)
      }
    ]);
  }

  async function installRollbackAfterIdempotencyTrigger(): Promise<void> {
    await ownerPool.query(`
      CREATE OR REPLACE FUNCTION ops.task7_force_rollback_after_idempotency()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM ops.idempotency_records
          WHERE tenant_id = OLD.tenant_id AND workspace_id = OLD.workspace_id
            AND space_id = OLD.space_id AND job_id = OLD.pending_job_id
            AND handler_key = 'foundation.worker.consume.v1'
        ) THEN
          RAISE EXCEPTION 'Task 7 forced rollback occurred before idempotency insertion';
        END IF;
        RAISE EXCEPTION 'Task 7 forced rollback after idempotency insertion';
      END
      $function$;
      CREATE TRIGGER task7_force_rollback
      BEFORE UPDATE ON ops.foundation_test_aggregates
      FOR EACH ROW WHEN (OLD.id = '${ids.aggregate}'::uuid)
      EXECUTE FUNCTION ops.task7_force_rollback_after_idempotency();
    `);
  }

  async function removeRollbackTrigger(): Promise<void> {
    await ownerPool.query(
      "DROP TRIGGER IF EXISTS task7_force_rollback ON ops.foundation_test_aggregates"
    );
    await ownerPool.query("DROP FUNCTION IF EXISTS ops.task7_force_rollback_after_idempotency() ");
  }

  async function waitForWorkerAggregateLock(blockerPid: number): Promise<number> {
    let targetPid: number | undefined;
    await pollUntil(
      async () => {
        const result = await ownerPool.query<{ pid: number }>(
          `SELECT pid::integer AS pid FROM pg_stat_activity
           WHERE usename = 'throughline_worker'
             AND wait_event_type = 'Lock'
             AND state = 'active'
             AND $1 = ANY(pg_blocking_pids(pid))
             AND query LIKE '%foundation_test_aggregates%FOR UPDATE%'`,
          [blockerPid]
        );
        if (result.rows.length === 1) targetPid = result.rows[0]!.pid;
        return targetPid !== undefined;
      },
      { timeoutMs: 5_000, description: "worker aggregate lock wait" }
    );
    return targetPid!;
  }

  async function expectWorkerAggregateLockWaitGone(targetPid: number): Promise<void> {
    await pollUntil(
      async () => {
        const result = await ownerPool.query<{
          state: string | null;
          waitEventType: string | null;
          lockCount: number;
        }>(
          `SELECT activity.state,
                  activity.wait_event_type AS "waitEventType",
                  count(locks.*)::integer AS "lockCount"
           FROM (SELECT $1::integer AS pid) target
           LEFT JOIN pg_stat_activity activity ON activity.pid = target.pid
           LEFT JOIN pg_locks locks ON locks.pid = target.pid
           GROUP BY activity.state, activity.wait_event_type`,
          [targetPid]
        );
        const row = result.rows[0];
        return Boolean(
          row &&
          row.waitEventType !== "Lock" &&
          row.state !== "idle in transaction" &&
          row.lockCount === 0
        );
      },
      { timeoutMs: 2_000, description: `worker backend ${targetPid} rollback to idle` }
    );
  }

  async function backendPid(client: { query: PgPool["query"] }): Promise<number> {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid()::integer AS "pid"');
    return result.rows[0]!.pid;
  }

  async function waitForActiveBackend(pid: number): Promise<void> {
    await pollUntil(
      async () => {
        const result = await ownerPool.query<{ active: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active') AS active",
          [pid]
        );
        return result.rows[0]?.active === true;
      },
      { timeoutMs: 2_000, description: `backend ${pid} active query` }
    );
  }

  async function expectBackendState(
    pid: number,
    expected: { state: string; waitEventType: string }
  ): Promise<void> {
    const result = await ownerPool.query<{ state: string; waitEventType: string }>(
      `SELECT state, wait_event_type AS "waitEventType"
       FROM pg_stat_activity WHERE pid = $1`,
      [pid]
    );
    expect(result.rows).toEqual([expected]);
  }

  async function expectStillPending(promise: Promise<unknown>): Promise<void> {
    const state = await Promise.race([
      promise.then(
        () => "resolved",
        () => "rejected"
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100))
    ]);
    expect(state).toBe("pending");
  }
});

function deterministicEffectHash(aggregateId: string, committedVersion: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        handlerKey: fixedHandlerKey,
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA,
        jobId: ids.job,
        contextReferenceId: ids.reference,
        aggregateId,
        loadedAggregateVersion: committedVersion - 1,
        committedAggregateVersion: committedVersion
      })
    )
    .digest("hex");
}

function readAndValidateEnvironment(): TestEnvironment {
  const entries = requiredEnvironment.map((name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for the Foundation worker integration suite`);
    return [name, value] as const;
  });
  const environment = Object.fromEntries(entries) as TestEnvironment;
  assertDistinctDatabaseRoles(environment);
  const endpoint = assertLocalSqsUrl(
    environment.FOUNDATION_SQS_ENDPOINT,
    "FOUNDATION_SQS_ENDPOINT"
  );
  const source = assertLocalSqsUrl(
    environment.FOUNDATION_SQS_QUEUE_URL,
    "FOUNDATION_SQS_QUEUE_URL"
  );
  const dlq = assertLocalSqsUrl(environment.FOUNDATION_SQS_DLQ_URL, "FOUNDATION_SQS_DLQ_URL");
  if (source.origin !== endpoint.origin || dlq.origin !== endpoint.origin) {
    throw new Error("Foundation queue URLs must use the exact configured local SQS origin");
  }
  if (source.href === dlq.href) throw new Error("Foundation source queue and DLQ must be distinct");
  return environment;
}

function assertDistinctDatabaseRoles(environment: TestEnvironment): void {
  const names = [
    environment.TEST_DATABASE_URL,
    environment.TEST_APP_DATABASE_URL,
    environment.TEST_RELAY_DATABASE_URL,
    environment.TEST_WORKER_DATABASE_URL
  ].map((value, index) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${requiredEnvironment[index]} must be a valid PostgreSQL URL`);
    }
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error(`${requiredEnvironment[index]} must use postgres:// or postgresql://`);
    }
    return decodeURIComponent(parsed.username);
  });
  if (names[1] !== "throughline_app") {
    throw new Error("TEST_APP_DATABASE_URL must use throughline_app");
  }
  if (names[2] !== "throughline_relay") {
    throw new Error("TEST_RELAY_DATABASE_URL must use throughline_relay");
  }
  if (names[3] !== "throughline_worker") {
    throw new Error("TEST_WORKER_DATABASE_URL must use throughline_worker");
  }
  if (new Set(names).size !== 4) {
    throw new Error("Foundation integration requires four distinct database role usernames");
  }
}

function assertLocalSqsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "localstack"]);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !localHosts.has(url.hostname)) {
    throw new Error(`${name} must use an explicit local-only LocalStack URL`);
  }
  return url;
}

function forgeMac(value: string): string {
  const replacement = value.endsWith("A") ? "B" : "A";
  return `${value.slice(0, -1)}${replacement}`;
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  options: { timeoutMs: number; description: string }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.description}`);
}

function safeSerialize(value: unknown): string {
  if (value instanceof Error) return `${value.name}:${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
