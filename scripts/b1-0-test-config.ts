import {
  FoundationTestConfigError,
  parseFoundationTestEnv,
  type FoundationContextKeys
} from "./foundation-test-config.js";

const REQUIRED_PRODUCT_VARIABLES = [
  "TEST_PRODUCT_RELAY_DATABASE_URL",
  "PRODUCT_SQS_ENDPOINT",
  "PRODUCT_SQS_QUEUE_URL",
  "PRODUCT_SQS_QUEUE_NAME"
] as const;

export type B10TestConfigErrorCode =
  | "MISSING_VARIABLE"
  | "MALFORMED_URL"
  | "NON_LOOPBACK_DATABASE_URL"
  | "DATABASE_ROLE_MISMATCH"
  | "DATABASE_URLS_NOT_DISTINCT"
  | "NON_TEST_RESOURCE_NAME"
  | "UNSAFE_RESOURCE_NAME"
  | "NON_LOOPBACK_LOCALSTACK_URL"
  | "QUEUE_URLS_NOT_DISTINCT"
  | "QUEUE_NAMES_NOT_DISTINCT"
  | "QUEUE_ENDPOINT_MISMATCH"
  | "QUEUE_ACCOUNT_MISMATCH"
  | "QUEUE_NAME_MISMATCH"
  | "FIFO_QUEUE_FORBIDDEN"
  | "INVALID_AWS_REGION"
  | "NON_DUMMY_AWS_CREDENTIALS"
  | "INVALID_VERIFICATION_KEY_MAP"
  | "ACTIVE_KEY_NOT_FOUND"
  | "UNSAFE_KEY_ID"
  | "INVALID_VERIFICATION_KEY";

const ERROR_MESSAGES: Record<B10TestConfigErrorCode, string> = {
  MISSING_VARIABLE: "A required B1.0 test variable is missing or blank.",
  MALFORMED_URL: "A B1.0 test URL is malformed or uses an unsupported protocol.",
  NON_LOOPBACK_DATABASE_URL: "B1.0 PostgreSQL URLs must use a loopback host.",
  DATABASE_ROLE_MISMATCH: "B1.0 PostgreSQL URLs must use their exact test roles.",
  DATABASE_URLS_NOT_DISTINCT: "B1.0 database role URLs must be pairwise distinct.",
  NON_TEST_RESOURCE_NAME: "B1.0 resources must have explicit test-only names.",
  UNSAFE_RESOURCE_NAME: "A B1.0 test resource name is malformed or unsafe.",
  NON_LOOPBACK_LOCALSTACK_URL: "B1.0 LocalStack URLs must use a loopback host.",
  QUEUE_URLS_NOT_DISTINCT: "B1.0 source, dead-letter, and product queues must be distinct.",
  QUEUE_NAMES_NOT_DISTINCT: "B1.0 queue names must be pairwise distinct.",
  QUEUE_ENDPOINT_MISMATCH: "B1.0 queues must use the same configured LocalStack endpoint.",
  QUEUE_ACCOUNT_MISMATCH: "B1.0 queues must use the same LocalStack account.",
  QUEUE_NAME_MISMATCH: "The B1.0 product queue URL and dedicated queue name do not match.",
  FIFO_QUEUE_FORBIDDEN: "The B1.0 product queue must be Standard, never FIFO.",
  INVALID_AWS_REGION: "The B1.0 test AWS region is invalid.",
  NON_DUMMY_AWS_CREDENTIALS: "B1.0 tests require fixed dummy AWS credentials.",
  INVALID_VERIFICATION_KEY_MAP: "The B1.0 Foundation verification key map is invalid.",
  ACTIVE_KEY_NOT_FOUND: "The active B1.0 Foundation verification key is not present.",
  UNSAFE_KEY_ID: "A B1.0 Foundation verification key identifier is unsafe.",
  INVALID_VERIFICATION_KEY: "A B1.0 Foundation verification key is invalid."
};

export class B10TestConfigError extends Error {
  readonly code: B10TestConfigErrorCode;

  constructor(code: B10TestConfigErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "B10TestConfigError";
    this.code = code;
  }
}

export interface B10TestConfig {
  databaseUrls: {
    owner: string;
    app: string;
    relay: string;
    worker: string;
    productRelay: string;
  };
  localstack: {
    endpoint: string;
    sourceQueueUrl: string;
    dlqUrl: string;
    bucket: string;
    queueUrl: string;
    queueName: string;
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  };
  contextKeys: FoundationContextKeys;
}

type Environment = Record<string, string | undefined>;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SAFE_TEST_DATABASE_NAME = /^(?=.{1,63}$)(?=.*test)[A-Za-z0-9_-]+$/;
const SAFE_TEST_QUEUE_NAME = /^(?=.{1,80}(?:\.fifo)?$)(?=.*test)[A-Za-z0-9_-]+(?:\.fifo)?$/;
const SAFE_TEST_BUCKET_NAME = /^(?=.{3,63}$)(?=.*test)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const LOCALSTACK_ACCOUNT = /^\d{12}$/;

export function parseB10TestEnv(environment: Environment): B10TestConfig {
  let foundation: ReturnType<typeof parseFoundationTestEnv>;
  try {
    foundation = parseFoundationTestEnv(environment);
  } catch (error) {
    if (error instanceof FoundationTestConfigError) fail(error.code);
    fail("MALFORMED_URL");
  }

  const productValues = {} as Record<(typeof REQUIRED_PRODUCT_VARIABLES)[number], string>;
  for (const variable of REQUIRED_PRODUCT_VARIABLES) {
    const value = environment[variable];
    if (!value?.trim()) fail("MISSING_VARIABLE");
    productValues[variable] = value;
  }

  const databaseValues = [
    foundation.databaseUrls.owner,
    foundation.databaseUrls.app,
    foundation.databaseUrls.relay,
    foundation.databaseUrls.worker,
    productValues.TEST_PRODUCT_RELAY_DATABASE_URL
  ];
  const databases = databaseValues.map(parsePostgresUrl);
  if (new Set(databases.map(({ href }) => href)).size !== databases.length) {
    fail("DATABASE_URLS_NOT_DISTINCT");
  }
  const roles = [
    new Set(["postgres", "throughline"]),
    new Set(["throughline_app"]),
    new Set(["throughline_relay"]),
    new Set(["throughline_worker"]),
    new Set(["throughline_product_relay"])
  ] as const;
  for (const [index, database] of databases.entries()) {
    if (!LOOPBACK_HOSTS.has(database.hostname)) fail("NON_LOOPBACK_DATABASE_URL");
    if (!roles[index]?.has(decodeURIComponent(database.username))) fail("DATABASE_ROLE_MISMATCH");
    const databaseName = decodePathName(database.pathname);
    if (!/test/i.test(databaseName)) fail("NON_TEST_RESOURCE_NAME");
    if (!SAFE_TEST_DATABASE_NAME.test(databaseName)) fail("UNSAFE_RESOURCE_NAME");
  }

  const foundationEndpoint = parseLoopbackHttpUrl(foundation.localstack.endpoint);
  const productEndpoint = parseLoopbackHttpUrl(productValues.PRODUCT_SQS_ENDPOINT);
  const sourceQueue = parseLoopbackHttpUrl(foundation.localstack.sourceQueueUrl);
  const dlq = parseLoopbackHttpUrl(foundation.localstack.dlqUrl);
  const productQueue = parseLoopbackHttpUrl(productValues.PRODUCT_SQS_QUEUE_URL);
  for (const url of [foundationEndpoint, productEndpoint]) assertSafeEndpointUrl(url);
  for (const url of [sourceQueue, dlq, productQueue]) assertSafeQueueUrl(url);
  if (
    productEndpoint.origin !== foundationEndpoint.origin ||
    sourceQueue.origin !== foundationEndpoint.origin ||
    dlq.origin !== foundationEndpoint.origin ||
    productQueue.origin !== foundationEndpoint.origin
  ) {
    fail("QUEUE_ENDPOINT_MISMATCH");
  }

  const queues = [queueIdentity(sourceQueue), queueIdentity(dlq), queueIdentity(productQueue)];
  if (new Set([sourceQueue.href, dlq.href, productQueue.href]).size !== 3) {
    fail("QUEUE_URLS_NOT_DISTINCT");
  }
  if (new Set(queues.map(({ name }) => name)).size !== queues.length) {
    fail("QUEUE_NAMES_NOT_DISTINCT");
  }
  if (new Set(queues.map(({ account }) => account)).size !== 1) {
    fail("QUEUE_ACCOUNT_MISMATCH");
  }
  if (queues[2]?.name !== productValues.PRODUCT_SQS_QUEUE_NAME) {
    fail("QUEUE_NAME_MISMATCH");
  }
  if (productValues.PRODUCT_SQS_QUEUE_NAME.endsWith(".fifo")) fail("FIFO_QUEUE_FORBIDDEN");
  for (const { name } of queues) {
    if (!/test/i.test(name)) fail("NON_TEST_RESOURCE_NAME");
    if (!SAFE_TEST_QUEUE_NAME.test(name)) fail("UNSAFE_RESOURCE_NAME");
  }
  assertSafeBucket(foundation.localstack.bucket);

  return {
    databaseUrls: {
      owner: foundation.databaseUrls.owner,
      app: foundation.databaseUrls.app,
      relay: foundation.databaseUrls.relay,
      worker: foundation.databaseUrls.worker,
      productRelay: productValues.TEST_PRODUCT_RELAY_DATABASE_URL
    },
    localstack: {
      endpoint: foundation.localstack.endpoint,
      sourceQueueUrl: foundation.localstack.sourceQueueUrl,
      dlqUrl: foundation.localstack.dlqUrl,
      bucket: foundation.localstack.bucket,
      queueUrl: productValues.PRODUCT_SQS_QUEUE_URL,
      queueName: productValues.PRODUCT_SQS_QUEUE_NAME,
      region: foundation.localstack.region,
      credentials: foundation.localstack.credentials
    },
    contextKeys: foundation.contextKeys
  };
}

export function b10TestConfigErrorMessage(code: B10TestConfigErrorCode): string {
  return ERROR_MESSAGES[code];
}

function parsePostgresUrl(value: string): URL {
  const url = parseUrl(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") fail("MALFORMED_URL");
  return url;
}

function parseLoopbackHttpUrl(value: string): URL {
  const url = parseUrl(value);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    fail("NON_LOOPBACK_LOCALSTACK_URL");
  }
  return url;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    fail("MALFORMED_URL");
  }
}

function decodePathName(pathname: string): string {
  try {
    const decoded = decodeURIComponent(pathname.replace(/^\//, ""));
    if (!decoded || decoded.includes("/")) fail("UNSAFE_RESOURCE_NAME");
    return decoded;
  } catch (error) {
    if (error instanceof B10TestConfigError) throw error;
    fail("UNSAFE_RESOURCE_NAME");
  }
}

function queueIdentity(url: URL): { account: string; name: string } {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || !segments[0] || !segments[1]) fail("MALFORMED_URL");
  let account: string;
  let name: string;
  try {
    account = decodeURIComponent(segments[0]);
    name = decodeURIComponent(segments[1]);
  } catch {
    fail("MALFORMED_URL");
  }
  if (!LOCALSTACK_ACCOUNT.test(account)) fail("MALFORMED_URL");
  return { account, name };
}

function assertSafeEndpointUrl(url: URL): void {
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    fail("MALFORMED_URL");
  }
}

function assertSafeQueueUrl(url: URL): void {
  if (url.username || url.password || url.search || url.hash) fail("MALFORMED_URL");
}

function assertSafeBucket(bucket: string): void {
  if (!/test/i.test(bucket)) fail("NON_TEST_RESOURCE_NAME");
  if (
    !SAFE_TEST_BUCKET_NAME.test(bucket) ||
    bucket.includes("..") ||
    bucket.includes(".-") ||
    bucket.includes("-.") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    fail("UNSAFE_RESOURCE_NAME");
  }
}

function fail(code: B10TestConfigErrorCode): never {
  throw new B10TestConfigError(code);
}
