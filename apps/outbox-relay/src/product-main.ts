import { PostgresAuthorizationService } from "@throughline/authorization";
import { createPgPool, ProductOutboxRepository, type PgPool } from "@throughline/db";
import {
  ProductOutboxRelay,
  ProductSqsPublisher,
  type ProductGetQueueAttributesInput,
  type ProductSendMessageInput,
  type ProductSqsClient,
  type ProductSqsCommandFactory
} from "./product-relay.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface ProductRelayRuntimeEnvironment {
  TEST_PRODUCT_RELAY_DATABASE_URL: string;
  PRODUCT_SQS_ENDPOINT: string;
  PRODUCT_SQS_QUEUE_URL: string;
  PRODUCT_SQS_QUEUE_NAME: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

export interface ProductAwsSqsModule {
  SQSClient: new (configuration: ProductSqsSdkConfiguration) => ProductSqsClient;
  SendMessageCommand: new (input: ProductSendMessageInput) => unknown;
  GetQueueAttributesCommand: new (input: ProductGetQueueAttributesInput) => unknown;
}

export interface ProductSqsSdkConfiguration {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

export interface ProductRelayRuntimeDependencies {
  loadSdk?: () => Promise<ProductAwsSqsModule>;
  createPool?: (connectionString: string) => PgPool;
  sendTimeoutMs?: number;
  verificationTimeoutMs?: number;
}

export async function composeProductRelayRuntime(
  environment: ProductRelayRuntimeEnvironment,
  dependencies: ProductRelayRuntimeDependencies = {}
): Promise<{ relay: ProductOutboxRelay; close: () => Promise<void> }> {
  const configuration = parseProductRelayRuntimeEnvironment(environment);
  const sdk = await (dependencies.loadSdk ?? loadAwsSqsModule)();
  const sqs = new sdk.SQSClient(configuration.sqs);
  const commands: ProductSqsCommandFactory = {
    sendMessage: (input) => new sdk.SendMessageCommand(input),
    getQueueAttributes: (input) => new sdk.GetQueueAttributesCommand(input)
  };
  let pool: PgPool | undefined;
  try {
    pool = (dependencies.createPool ?? createPgPool)(configuration.databaseUrl);
    const publisher = await ProductSqsPublisher.createVerified(
      sqs,
      configuration.queueUrl,
      commands,
      dependencies.sendTimeoutMs,
      dependencies.verificationTimeoutMs
    );
    const authorization = new PostgresAuthorizationService(pool);
    const repository = new ProductOutboxRepository(pool, authorization);
    const relay = new ProductOutboxRelay(repository, publisher);
    let closePromise: Promise<void> | undefined;
    return {
      relay,
      close: () => {
        closePromise ??= disposeProductRelayResources(pool!, sqs, false);
        return closePromise;
      }
    };
  } catch (error) {
    await disposeProductRelayResources(pool, sqs, true);
    throw error;
  }
}

export function parseProductRelayRuntimeEnvironment(environment: ProductRelayRuntimeEnvironment): {
  databaseUrl: string;
  queueUrl: string;
  queueName: string;
  sqs: ProductSqsSdkConfiguration;
} {
  for (const value of Object.values(environment)) {
    if (typeof value !== "string" || value.trim() === "") throw configurationError();
  }

  const databaseUrl = parseUrl(environment.TEST_PRODUCT_RELAY_DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !LOOPBACK_HOSTS.has(databaseUrl.hostname) ||
    decodeURIComponent(databaseUrl.username) !== "throughline_product_relay" ||
    !/test/i.test(databaseUrl.pathname)
  ) {
    throw configurationError();
  }

  const endpoint = parseUrl(environment.PRODUCT_SQS_ENDPOINT);
  const queueUrl = parseUrl(environment.PRODUCT_SQS_QUEUE_URL);
  if (
    endpoint.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(endpoint.hostname) ||
    queueUrl.origin !== endpoint.origin
  ) {
    throw configurationError();
  }
  const queueSegments = queueUrl.pathname.split("/").filter(Boolean);
  if (
    queueSegments.length !== 2 ||
    queueSegments[1] !== environment.PRODUCT_SQS_QUEUE_NAME ||
    !/test/i.test(environment.PRODUCT_SQS_QUEUE_NAME) ||
    environment.PRODUCT_SQS_QUEUE_NAME.endsWith(".fifo")
  ) {
    throw configurationError();
  }
  if (
    !/^(?:us|af|ap|ca|eu|il|me|mx|sa)-(?:[a-z]+-)+\d$/.test(environment.AWS_REGION) ||
    environment.AWS_ACCESS_KEY_ID !== "test" ||
    environment.AWS_SECRET_ACCESS_KEY !== "test"
  ) {
    throw configurationError();
  }

  return {
    databaseUrl: databaseUrl.href,
    queueUrl: queueUrl.href,
    queueName: environment.PRODUCT_SQS_QUEUE_NAME,
    sqs: {
      endpoint: endpoint.href,
      region: environment.AWS_REGION,
      credentials: {
        accessKeyId: environment.AWS_ACCESS_KEY_ID,
        secretAccessKey: environment.AWS_SECRET_ACCESS_KEY
      }
    }
  };
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw configurationError();
  }
}

function configurationError(): Error {
  return new Error("Product relay runtime configuration is invalid");
}

async function loadAwsSqsModule(): Promise<ProductAwsSqsModule> {
  const moduleName = "@aws-sdk/client-sqs";
  return import(moduleName) as Promise<ProductAwsSqsModule>;
}

async function disposeProductRelayResources(
  pool: PgPool | undefined,
  sqs: ProductSqsClient,
  suppressFailure: boolean
): Promise<void> {
  const results = await Promise.allSettled([
    pool ? pool.end() : Promise.resolve(),
    Promise.resolve().then(() => sqs.destroy())
  ]);
  if (!suppressFailure && results.some((result) => result.status === "rejected")) {
    throw new Error("Product relay runtime resource disposal failed");
  }
}
