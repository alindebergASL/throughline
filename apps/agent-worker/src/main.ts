import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import { PostgresAuthorizationService } from "@throughline/authorization";
import {
  bootstrapWorkerContextReference,
  consumeFoundationWorkerJob,
  createPgPool,
  type FoundationWorkerAuthorization,
  type PgPool
} from "@throughline/db";
import { withPropagatedSpan, type TraceCarrier } from "@throughline/observability";
import {
  createAsyncContextReferenceCodec,
  type AsyncContextReferenceCodec
} from "@throughline/tenancy";
import {
  FoundationSqsConsumer,
  type FoundationChangeVisibilityInput,
  type FoundationConsumerResult,
  type FoundationConsumerScheduler,
  type FoundationDeleteMessageInput,
  type FoundationReceiveMessageInput,
  type FoundationSqsMessage,
  type FoundationSqsPort
} from "./foundation-consumer.js";
import {
  rehydrateFoundationWorkerContext,
  type FoundationQueueEnvelope
} from "./worker-context.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface FoundationWorkerRuntimeEnvironment {
  TEST_WORKER_DATABASE_URL: string;
  FOUNDATION_SQS_ENDPOINT: string;
  FOUNDATION_SQS_QUEUE_URL: string;
  FOUNDATION_WORKER_SERVICE_PRINCIPAL_ID: string;
  FOUNDATION_POLICY_VERSION_ID: string;
  FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: string;
  FOUNDATION_CONTEXT_ACTIVE_KEY_ID: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

export interface FoundationWorkerContextKeys {
  activeKeyId: string;
  verificationKeys: ReadonlyMap<string, Uint8Array>;
}

export type ParsedFoundationWorkerRuntimeEnvironment = FoundationWorkerRuntimeEnvironment & {
  contextKeys: FoundationWorkerContextKeys;
};

export interface FoundationWorkerRuntime {
  consumer: FoundationSqsConsumer<RuntimeRehydratedJob>;
  run: (signal?: AbortSignal) => Promise<void>;
  close: () => Promise<void>;
}

export interface RuntimeRehydratedJob {
  jobId: string;
  contextReferenceId: string;
  securityContext: Awaited<ReturnType<typeof rehydrateFoundationWorkerContext>>["securityContext"];
  continuationCarrier: TraceCarrier;
}

interface RuntimeLogger {
  debug: (...values: unknown[]) => void;
  info: (...values: unknown[]) => void;
  warn: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
}

export function parseFoundationWorkerRuntimeEnvironment(
  source: NodeJS.ProcessEnv | Partial<FoundationWorkerRuntimeEnvironment>
): ParsedFoundationWorkerRuntimeEnvironment {
  const required = [
    "TEST_WORKER_DATABASE_URL",
    "FOUNDATION_SQS_ENDPOINT",
    "FOUNDATION_SQS_QUEUE_URL",
    "FOUNDATION_WORKER_SERVICE_PRINCIPAL_ID",
    "FOUNDATION_POLICY_VERSION_ID",
    "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON",
    "FOUNDATION_CONTEXT_ACTIVE_KEY_ID",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY"
  ] as const;
  const entries = required.map((name) => {
    const value = source[name];
    if (!value) throw new Error(`Foundation worker runtime configuration is incomplete: ${name}`);
    return [name, value] as const;
  });
  const configured = Object.fromEntries(entries) as unknown as FoundationWorkerRuntimeEnvironment;
  const environment: ParsedFoundationWorkerRuntimeEnvironment = {
    ...configured,
    contextKeys: parseFoundationContextVerificationKeys(configured)
  };
  validateWorkerDatabaseUrl(environment.TEST_WORKER_DATABASE_URL);
  validateLocalSqs(environment);
  if (!UUID_PATTERN.test(environment.FOUNDATION_WORKER_SERVICE_PRINCIPAL_ID)) {
    throw new Error("Foundation worker service principal configuration is invalid");
  }
  if (!POLICY_VERSION_PATTERN.test(environment.FOUNDATION_POLICY_VERSION_ID)) {
    throw new Error("Foundation worker policy configuration is invalid");
  }
  return environment;
}

export function parseFoundationContextVerificationKeys(
  environment: Pick<
    FoundationWorkerRuntimeEnvironment,
    "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON" | "FOUNDATION_CONTEXT_ACTIVE_KEY_ID"
  >
): FoundationWorkerContextKeys {
  return parseVerificationKeys(environment);
}

export function composeFoundationWorkerRuntime(
  input: FoundationWorkerRuntimeEnvironment,
  dependencies: {
    pool?: PgPool;
    codec?: AsyncContextReferenceCodec;
    sqs?: FoundationSqsPort;
    scheduler?: FoundationConsumerScheduler;
    logger?: RuntimeLogger;
    clock?: () => Date;
  } = {}
): FoundationWorkerRuntime {
  const environment = parseFoundationWorkerRuntimeEnvironment(input);
  const pool = dependencies.pool ?? createPgPool(environment.TEST_WORKER_DATABASE_URL);
  const clock = dependencies.clock ?? (() => new Date());
  const codec =
    dependencies.codec ??
    createAsyncContextReferenceCodec({
      verificationKeys: environment.contextKeys.verificationKeys,
      activeKeyId: environment.contextKeys.activeKeyId,
      clock
    });
  const logger = dependencies.logger ?? fixedConsoleLogger;
  const sqsClient = dependencies.sqs ? undefined : createLocalSqsClient(environment);
  const sqs = dependencies.sqs ?? new AwsSqsPort(sqsClient!);
  const scheduler = dependencies.scheduler ?? systemScheduler;
  const authorization = new PostgresAuthorizationService(pool);

  const consumer = new FoundationSqsConsumer<RuntimeRehydratedJob>({
    queueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
    sqs,
    scheduler,
    logger,
    rehydrate: async ({ body, messageAttributes }, { signal }) => {
      const contextReference = extractContextReference(body);
      const result = await rehydrateFoundationWorkerContext({
        body,
        messageAttributes,
        codec,
        targetWorkerServicePrincipalId: environment.FOUNDATION_WORKER_SERVICE_PRINCIPAL_ID,
        targetPolicyVersionId: environment.FOUNDATION_POLICY_VERSION_ID,
        bootstrapReference: (claims) =>
          bootstrapWorkerContextReference({
            pool,
            token: contextReference,
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
        clock,
        logger,
        signal
      });
      return {
        jobId: result.metadata.jobId,
        contextReferenceId: result.metadata.contextReferenceId,
        securityContext: result.securityContext,
        continuationCarrier: result.metadata.continuationCarrier
      };
    },
    consume: (job, { signal, deadline }) =>
      consumeFoundationRuntimeJob({
        pool,
        authorization,
        job,
        signal,
        deadline
      })
  });

  return {
    consumer,
    run: (signal) => runConsumerLoop(consumer, signal),
    close: async () => {
      sqsClient?.destroy();
      if (!dependencies.pool) await pool.end();
    }
  };
}

export function consumeFoundationRuntimeJob(input: {
  pool: PgPool;
  authorization: FoundationWorkerAuthorization;
  job: RuntimeRehydratedJob;
  signal?: AbortSignal;
  deadline: { absoluteDeadlineMs: number; now(): number };
}) {
  const context = input.job.securityContext;
  const spaceId = context.requestedSpaceIds[0];
  const attributes = {
    "throughline.request.id": context.requestId,
    "throughline.job.id": input.job.jobId,
    "throughline.tenant.id": context.tenantId,
    "throughline.workspace.id": context.workspaceId,
    "throughline.space.id": spaceId
  } as const;
  return withPropagatedSpan(
    {
      name: "foundation.worker.authorize",
      parentCarrier: input.job.continuationCarrier,
      attributes
    },
    ({ carrier: authorizationCarrier }) =>
      withPropagatedSpan(
        {
          name: "foundation.worker.handle",
          parentCarrier: authorizationCarrier,
          attributes
        },
        () =>
          consumeFoundationWorkerJob({
            pool: input.pool,
            authorization: input.authorization,
            input: {
              context,
              jobId: input.job.jobId,
              contextReferenceId: input.job.contextReferenceId
            },
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            deadline: input.deadline
          })
      )
  );
}

export async function runConsumerLoop(
  consumer: Pick<FoundationSqsConsumer<RuntimeRehydratedJob>, "receiveOne">,
  signal?: AbortSignal
): Promise<void> {
  while (!signal?.aborted) {
    const result = await consumer.receiveOne();
    if (result.status === "idle") await waitForNextPoll(signal);
  }
}

export class AwsSqsPort implements FoundationSqsPort {
  constructor(private readonly client: SQSClient) {}

  async receiveMessage(input: FoundationReceiveMessageInput, options?: { signal?: AbortSignal }) {
    const response = await this.client.send(
      new ReceiveMessageCommand(input),
      options?.signal ? { abortSignal: options.signal } : undefined
    );
    if (!response.Messages) return {};
    const messages: FoundationSqsMessage[] = response.Messages.map((message) => ({
      ...(typeof message.MessageId === "string" ? { MessageId: message.MessageId } : {}),
      ...(typeof message.ReceiptHandle === "string"
        ? { ReceiptHandle: message.ReceiptHandle }
        : {}),
      ...(typeof message.Body === "string" ? { Body: message.Body } : {}),
      ...(message.MessageAttributes ? { MessageAttributes: message.MessageAttributes } : {})
    }));
    return { Messages: messages };
  }

  async changeMessageVisibility(
    input: FoundationChangeVisibilityInput,
    options: { signal: AbortSignal; remainingDeadlineMs: number }
  ): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand(input), {
      abortSignal: options.signal
    });
  }

  async deleteMessage(
    input: FoundationDeleteMessageInput,
    options: { signal: AbortSignal; remainingDeadlineMs: number }
  ): Promise<void> {
    await this.client.send(new DeleteMessageCommand(input), {
      abortSignal: options.signal
    });
  }
}

function createLocalSqsClient(environment: FoundationWorkerRuntimeEnvironment): SQSClient {
  return new SQSClient({
    endpoint: environment.FOUNDATION_SQS_ENDPOINT,
    region: environment.AWS_REGION,
    credentials: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID,
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY
    }
  });
}

function validateWorkerDatabaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TEST_WORKER_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.username) !== "throughline_worker"
  ) {
    throw new Error("TEST_WORKER_DATABASE_URL must use the dedicated throughline_worker role");
  }
}

function validateLocalSqs(environment: FoundationWorkerRuntimeEnvironment): void {
  let endpoint: URL;
  let queue: URL;
  try {
    endpoint = new URL(environment.FOUNDATION_SQS_ENDPOINT);
    queue = new URL(environment.FOUNDATION_SQS_QUEUE_URL);
  } catch {
    throw new Error("Foundation worker SQS configuration must contain valid URLs");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "localstack"]);
  if (endpoint.protocol !== "http:" || !localHosts.has(endpoint.hostname)) {
    throw new Error("Foundation worker requires an explicit local-only SQS endpoint");
  }
  if (queue.origin !== endpoint.origin || !/test/i.test(queue.pathname)) {
    throw new Error("Foundation worker queue must be a test queue on the local endpoint");
  }
  if (
    !environment.AWS_REGION ||
    !environment.AWS_ACCESS_KEY_ID.startsWith("test") ||
    !environment.AWS_SECRET_ACCESS_KEY.startsWith("test")
  ) {
    throw new Error("Foundation worker requires a region and dummy local AWS credentials");
  }
}

function parseVerificationKeys(
  environment: Pick<
    FoundationWorkerRuntimeEnvironment,
    "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON" | "FOUNDATION_CONTEXT_ACTIVE_KEY_ID"
  >
): FoundationWorkerContextKeys {
  let parsed: unknown;
  try {
    parsed = JSON.parse(environment.FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON);
  } catch {
    throw new Error("Foundation worker verification key map is invalid");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Foundation worker verification key map is invalid");
  }
  const verificationKeys = new Map<string, Uint8Array>();
  for (const [keyId, material] of Object.entries(parsed)) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof material !== "string") {
      throw new Error("Foundation worker verification key is invalid");
    }
    if (!/^[A-Za-z0-9+/]{43}=$/.test(material)) {
      throw new Error("Foundation worker verification key is invalid");
    }
    const decoded = Buffer.from(material, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== material) {
      throw new Error("Foundation worker verification key is invalid");
    }
    verificationKeys.set(keyId, new Uint8Array(decoded));
  }
  const activeKeyId = environment.FOUNDATION_CONTEXT_ACTIVE_KEY_ID;
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error("Foundation worker active verification key is invalid");
  }
  if (!verificationKeys.has(activeKeyId)) {
    throw new Error("Foundation worker active verification key is not present");
  }
  return { activeKeyId, verificationKeys: new Map(verificationKeys) };
}

function extractContextReference(body: string): string {
  const parsed = JSON.parse(body) as FoundationQueueEnvelope;
  return parsed.contextReference;
}

function waitForNextPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, 250);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true }
    );
  });
}

const systemScheduler: FoundationConsumerScheduler = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

const fixedConsoleLogger: RuntimeLogger = {
  debug: (...values) => console.debug(...values),
  info: (...values) => console.info(...values),
  warn: (...values) => console.warn(...values),
  error: (...values) => console.error(...values)
};

async function start(): Promise<void> {
  const runtime = composeFoundationWorkerRuntime(
    parseFoundationWorkerRuntimeEnvironment(process.env)
  );
  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  try {
    await runtime.run(shutdown.signal);
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  start().catch(() => {
    console.error("foundation_worker_start_failed");
    process.exitCode = 1;
  });
}

export type { FoundationConsumerResult };
