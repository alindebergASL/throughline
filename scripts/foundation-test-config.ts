const REQUIRED_VARIABLES = [
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "TEST_RELAY_DATABASE_URL",
  "TEST_WORKER_DATABASE_URL",
  "FOUNDATION_SQS_ENDPOINT",
  "FOUNDATION_SQS_QUEUE_URL",
  "FOUNDATION_SQS_DLQ_URL",
  "FOUNDATION_S3_BUCKET",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON",
  "FOUNDATION_CONTEXT_ACTIVE_KEY_ID"
] as const;

export type FoundationTestConfigErrorCode =
  | "MISSING_VARIABLE"
  | "MALFORMED_URL"
  | "DATABASE_URLS_NOT_DISTINCT"
  | "NON_LOOPBACK_DATABASE_URL"
  | "DATABASE_ROLE_MISMATCH"
  | "NON_LOOPBACK_LOCALSTACK_URL"
  | "QUEUE_URLS_NOT_DISTINCT"
  | "QUEUE_ENDPOINT_MISMATCH"
  | "QUEUE_ACCOUNT_MISMATCH"
  | "NON_TEST_RESOURCE_NAME"
  | "NON_DUMMY_AWS_CREDENTIALS"
  | "INVALID_AWS_REGION"
  | "INVALID_VERIFICATION_KEY_MAP"
  | "ACTIVE_KEY_NOT_FOUND"
  | "UNSAFE_KEY_ID"
  | "INVALID_VERIFICATION_KEY";

const ERROR_MESSAGES: Record<FoundationTestConfigErrorCode, string> = {
  MISSING_VARIABLE: "A required Foundation test variable is missing or blank.",
  MALFORMED_URL: "A Foundation test URL is malformed or uses an unsupported protocol.",
  DATABASE_URLS_NOT_DISTINCT: "Foundation database role URLs must be pairwise distinct.",
  NON_LOOPBACK_DATABASE_URL: "Foundation PostgreSQL URLs must use a loopback host.",
  DATABASE_ROLE_MISMATCH: "Foundation PostgreSQL URLs must use their exact test roles.",
  NON_LOOPBACK_LOCALSTACK_URL: "Foundation LocalStack URLs must use a loopback host.",
  QUEUE_URLS_NOT_DISTINCT: "Foundation source and dead-letter queues must be distinct.",
  QUEUE_ENDPOINT_MISMATCH: "Foundation queue URLs must use the configured LocalStack endpoint.",
  QUEUE_ACCOUNT_MISMATCH: "Foundation queue URLs must use the same LocalStack account.",
  NON_TEST_RESOURCE_NAME: "Foundation resources must have explicit test-only names.",
  NON_DUMMY_AWS_CREDENTIALS: "Foundation tests require fixed dummy AWS credentials.",
  INVALID_AWS_REGION: "The Foundation test AWS region is invalid.",
  INVALID_VERIFICATION_KEY_MAP: "The Foundation verification key map is invalid.",
  ACTIVE_KEY_NOT_FOUND: "The active Foundation verification key is not present.",
  UNSAFE_KEY_ID: "A Foundation verification key identifier is unsafe.",
  INVALID_VERIFICATION_KEY: "A Foundation verification key is invalid."
};

export class FoundationTestConfigError extends Error {
  readonly code: FoundationTestConfigErrorCode;

  constructor(code: FoundationTestConfigErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "FoundationTestConfigError";
    this.code = code;
  }
}

export interface FoundationContextKeys {
  activeKeyId: string;
  verificationKeys: Record<string, Uint8Array>;
}

export interface FoundationTestConfig {
  databaseUrls: {
    owner: string;
    app: string;
    relay: string;
    worker: string;
  };
  localstack: {
    endpoint: string;
    sourceQueueUrl: string;
    dlqUrl: string;
    bucket: string;
    region: string;
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
    };
  };
  contextKeys: FoundationContextKeys;
}

type Environment = Record<string, string | undefined>;

const SAFE_KEY_ID = /^[A-Za-z0-9_-]+$/;
const AWS_REGION = /^(?:us|af|ap|ca|eu|il|me|mx|sa)-(?:[a-z]+-)+\d$/;
const TEST_RESOURCE_NAME = /test/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const EXPECTED_DATABASE_ROLES = [
  new Set<string>(["postgres", "throughline"]),
  new Set<string>(["throughline_app"]),
  new Set<string>(["throughline_relay"]),
  new Set<string>(["throughline_worker"])
] as const;

function fail(code: FoundationTestConfigErrorCode): never {
  throw new FoundationTestConfigError(code);
}

function requireValues(
  environment: Environment
): Record<(typeof REQUIRED_VARIABLES)[number], string> {
  const values = {} as Record<(typeof REQUIRED_VARIABLES)[number], string>;
  for (const name of REQUIRED_VARIABLES) {
    const value = environment[name];
    if (!value?.trim()) fail("MISSING_VARIABLE");
    values[name] = value;
  }
  return values;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    fail("MALFORMED_URL");
  }
}

function parsePostgresUrl(value: string): URL {
  const url = parseUrl(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") fail("MALFORMED_URL");
  return url;
}

function parseLoopbackUrl(value: string): URL {
  const url = parseUrl(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    fail("NON_LOOPBACK_LOCALSTACK_URL");
  }
  return url;
}

function queueIdentity(url: URL): { account: string; name: string } {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || !segments[0] || !segments[1]) fail("MALFORMED_URL");
  return { account: segments[0], name: segments[1] };
}

function strictBase64Key(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    fail("INVALID_VERIFICATION_KEY");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    fail("INVALID_VERIFICATION_KEY");
  }
  return new Uint8Array(decoded);
}

export function parseFoundationContextKeys(environment: Environment): FoundationContextKeys {
  const serialized = environment.FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON;
  const activeKeyId = environment.FOUNDATION_CONTEXT_ACTIVE_KEY_ID;
  if (!serialized?.trim() || !activeKeyId?.trim()) fail("MISSING_VARIABLE");

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("INVALID_VERIFICATION_KEY_MAP");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    fail("INVALID_VERIFICATION_KEY_MAP");
  }

  const verificationKeys: Record<string, Uint8Array> = {};
  for (const [keyId, material] of Object.entries(parsed)) {
    if (!SAFE_KEY_ID.test(keyId)) fail("UNSAFE_KEY_ID");
    verificationKeys[keyId] = strictBase64Key(material);
  }
  if (!SAFE_KEY_ID.test(activeKeyId)) fail("UNSAFE_KEY_ID");
  if (!Object.hasOwn(verificationKeys, activeKeyId)) fail("ACTIVE_KEY_NOT_FOUND");
  return { activeKeyId, verificationKeys };
}

export function parseFoundationTestEnv(environment: Environment): FoundationTestConfig {
  const values = requireValues(environment);
  const databaseUrls = [
    values.TEST_DATABASE_URL,
    values.TEST_APP_DATABASE_URL,
    values.TEST_RELAY_DATABASE_URL,
    values.TEST_WORKER_DATABASE_URL
  ];
  const parsedDatabaseUrls = databaseUrls.map((value) => parsePostgresUrl(value));
  const databaseIdentities = parsedDatabaseUrls.map((url) => url.href);
  if (new Set(databaseIdentities).size !== databaseIdentities.length) {
    fail("DATABASE_URLS_NOT_DISTINCT");
  }
  for (const [index, url] of parsedDatabaseUrls.entries()) {
    if (!LOOPBACK_HOSTS.has(url.hostname)) fail("NON_LOOPBACK_DATABASE_URL");
    if (!EXPECTED_DATABASE_ROLES[index]?.has(decodeURIComponent(url.username))) {
      fail("DATABASE_ROLE_MISMATCH");
    }
    const databaseName = url.pathname.replace(/^\//, "");
    if (!databaseName || databaseName.includes("/") || !TEST_RESOURCE_NAME.test(databaseName)) {
      fail("NON_TEST_RESOURCE_NAME");
    }
  }

  const endpoint = parseLoopbackUrl(values.FOUNDATION_SQS_ENDPOINT);
  const source = parseLoopbackUrl(values.FOUNDATION_SQS_QUEUE_URL);
  const dlq = parseLoopbackUrl(values.FOUNDATION_SQS_DLQ_URL);
  if (source.href === dlq.href) fail("QUEUE_URLS_NOT_DISTINCT");
  if (source.origin !== endpoint.origin || dlq.origin !== endpoint.origin) {
    fail("QUEUE_ENDPOINT_MISMATCH");
  }
  const sourceIdentity = queueIdentity(source);
  const dlqIdentity = queueIdentity(dlq);
  if (sourceIdentity.account !== dlqIdentity.account) fail("QUEUE_ACCOUNT_MISMATCH");
  if (
    !TEST_RESOURCE_NAME.test(sourceIdentity.name) ||
    !TEST_RESOURCE_NAME.test(dlqIdentity.name) ||
    !TEST_RESOURCE_NAME.test(values.FOUNDATION_S3_BUCKET)
  ) {
    fail("NON_TEST_RESOURCE_NAME");
  }

  if (values.AWS_ACCESS_KEY_ID !== "test" || values.AWS_SECRET_ACCESS_KEY !== "test") {
    fail("NON_DUMMY_AWS_CREDENTIALS");
  }
  if (!AWS_REGION.test(values.AWS_REGION)) fail("INVALID_AWS_REGION");

  return {
    databaseUrls: {
      owner: values.TEST_DATABASE_URL,
      app: values.TEST_APP_DATABASE_URL,
      relay: values.TEST_RELAY_DATABASE_URL,
      worker: values.TEST_WORKER_DATABASE_URL
    },
    localstack: {
      endpoint: values.FOUNDATION_SQS_ENDPOINT,
      sourceQueueUrl: values.FOUNDATION_SQS_QUEUE_URL,
      dlqUrl: values.FOUNDATION_SQS_DLQ_URL,
      bucket: values.FOUNDATION_S3_BUCKET,
      region: values.AWS_REGION,
      credentials: {
        accessKeyId: values.AWS_ACCESS_KEY_ID,
        secretAccessKey: values.AWS_SECRET_ACCESS_KEY
      }
    },
    contextKeys: parseFoundationContextKeys(values)
  };
}

export function foundationTestConfigErrorMessage(code: FoundationTestConfigErrorCode): string {
  return ERROR_MESSAGES[code];
}
