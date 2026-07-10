import { PostgresAuthorizationService } from "@throughline/authorization";
import type { SecurityContext } from "@throughline/core-types";
import { createPgPool, RelayOutboxRepository } from "@throughline/db";
import { parseSecurityContext } from "@throughline/tenancy";
import {
  FoundationOutboxRelay,
  type SqsCommandFactory,
  type SqsPublisherClient,
  type SqsSendMessageInput
} from "./relay.js";

interface AwsSqsModule {
  SQSClient: new (config: LocalSqsSdkConfiguration) => SqsPublisherClient;
  SendMessageCommand: new (input: SqsSendMessageInput) => { input: SqsSendMessageInput };
}

export interface LocalSqsSdkConfiguration {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

export interface RelayRuntimeEnvironment {
  TEST_RELAY_DATABASE_URL: string;
  FOUNDATION_SQS_ENDPOINT: string;
  FOUNDATION_SQS_QUEUE_URL: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

export async function composeRelayRuntime(
  environment: RelayRuntimeEnvironment,
  loadSdk: () => Promise<AwsSqsModule> = loadAwsSqsModule
) {
  const sqsConfig = parseLocalSqsConfiguration(environment);
  const sdk = await loadSdk();
  const sqs = new sdk.SQSClient(sqsConfig);
  const commands: SqsCommandFactory = {
    create: (input) => new sdk.SendMessageCommand(input)
  };
  const pool = createPgPool(environment.TEST_RELAY_DATABASE_URL);
  const authorization = new PostgresAuthorizationService(pool);
  const repository = new RelayOutboxRepository(pool, authorization);
  const relay = new FoundationOutboxRelay(
    repository,
    sqs,
    environment.FOUNDATION_SQS_QUEUE_URL,
    commands
  );
  return { relay, close: () => pool.end() };
}

export function parseLocalSqsConfiguration(
  environment: RelayRuntimeEnvironment
): LocalSqsSdkConfiguration {
  const endpoint = new URL(environment.FOUNDATION_SQS_ENDPOINT);
  if (
    endpoint.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1", "localstack"].includes(endpoint.hostname)
  ) {
    throw new Error("Foundation relay requires an explicit local-only SQS endpoint");
  }
  if (
    !environment.AWS_REGION ||
    !environment.AWS_ACCESS_KEY_ID.startsWith("test") ||
    !environment.AWS_SECRET_ACCESS_KEY.startsWith("test")
  ) {
    throw new Error("Foundation relay requires a region and dummy local AWS credentials");
  }
  const queueUrl = new URL(environment.FOUNDATION_SQS_QUEUE_URL);
  if (queueUrl.origin !== endpoint.origin || !/test/i.test(queueUrl.pathname)) {
    throw new Error("Foundation relay queue must be a test queue on the configured local endpoint");
  }
  return {
    endpoint: endpoint.toString(),
    region: environment.AWS_REGION,
    credentials: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID,
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY
    }
  };
}

export function parseRelaySecurityContext(value: unknown): SecurityContext {
  const context = parseSecurityContext(value);
  if (!context.servicePrincipalId || context.requestedSpaceIds.length !== 1) {
    throw new Error("Relay runtime requires one complete scoped service-principal context");
  }
  return context;
}

async function loadAwsSqsModule(): Promise<AwsSqsModule> {
  // The variable keeps the SDK replaceable in tests while production resolution still uses AWS SDK v3.
  const moduleName = "@aws-sdk/client-sqs";
  return import(moduleName) as Promise<AwsSqsModule>;
}
