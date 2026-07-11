import { describe, expect, it, vi } from "vitest";

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

type FoundationEnvironment = Record<(typeof REQUIRED_VARIABLES)[number], string> &
  Record<string, string | undefined>;

type FoundationConfigModule = {
  parseFoundationTestEnv: (environment: Record<string, string | undefined>) => unknown;
};

const keyMaterial = Buffer.alloc(32, 7).toString("base64");

function validEnvironment(): FoundationEnvironment {
  return {
    TEST_DATABASE_URL: "postgres://foundation_owner@127.0.0.1:5432/throughline_foundation_test",
    TEST_APP_DATABASE_URL: "postgres://throughline_app@127.0.0.1:5432/throughline_foundation_test",
    TEST_RELAY_DATABASE_URL:
      "postgres://throughline_relay@127.0.0.1:5432/throughline_foundation_test",
    TEST_WORKER_DATABASE_URL:
      "postgres://throughline_worker@127.0.0.1:5432/throughline_foundation_test",
    FOUNDATION_SQS_ENDPOINT: "http://127.0.0.1:4566",
    FOUNDATION_SQS_QUEUE_URL:
      "http://127.0.0.1:4566/000000000000/throughline-foundation-test-source",
    FOUNDATION_SQS_DLQ_URL: "http://127.0.0.1:4566/000000000000/throughline-foundation-test-dlq",
    FOUNDATION_S3_BUCKET: "throughline-foundation-test-bucket",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({ test_key_1: keyMaterial }),
    FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "test_key_1"
  };
}

async function loadConfigModule(): Promise<FoundationConfigModule> {
  const moduleUrl = new URL("../../../scripts/foundation-test-config.ts", import.meta.url).href;
  const loaded: unknown = await import(/* @vite-ignore */ moduleUrl);
  expect(loaded).toBeTypeOf("object");
  expect(loaded).toHaveProperty("parseFoundationTestEnv");
  return loaded as FoundationConfigModule;
}

async function parse(environment: Record<string, string | undefined>): Promise<unknown> {
  const module = await loadConfigModule();
  return module.parseFoundationTestEnv(environment);
}

async function expectRejected(
  environment: Record<string, string | undefined>,
  code: string,
  sensitiveValues: readonly string[] = []
): Promise<void> {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let failure: unknown;
  let errorCalls: unknown[][] = [];
  let logCalls: unknown[][] = [];

  try {
    await parse(environment);
  } catch (error) {
    failure = error;
  } finally {
    errorCalls = [...errorSpy.mock.calls];
    logCalls = [...logSpy.mock.calls];
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }

  expect(failure).toMatchObject({
    name: "FoundationTestConfigError",
    code
  });
  expect(errorCalls).toEqual([]);
  expect(logCalls).toEqual([]);

  const rendered =
    failure instanceof Error
      ? `${failure.name}\n${failure.message}\n${JSON.stringify(failure.cause)}`
      : JSON.stringify(failure);
  const suppliedValues = Object.values(environment).filter(
    (value): value is string => typeof value === "string" && value.length > 4
  );
  for (const value of new Set([...suppliedValues, ...sensitiveValues])) {
    expect(rendered).not.toContain(value);
  }
}

describe("Foundation test environment preflight", () => {
  it("fails closed for every absent or blank explicit variable", async () => {
    for (const variable of REQUIRED_VARIABLES) {
      const absent = validEnvironment();
      delete absent[variable];
      await expectRejected(absent, "MISSING_VARIABLE");

      await expectRejected({ ...validEnvironment(), [variable]: "   " }, "MISSING_VARIABLE");
    }
  });

  it("requires all four PostgreSQL role URLs to be pairwise distinct", async () => {
    const names = [
      "TEST_DATABASE_URL",
      "TEST_APP_DATABASE_URL",
      "TEST_RELAY_DATABASE_URL",
      "TEST_WORKER_DATABASE_URL"
    ] as const;

    for (let left = 0; left < names.length; left += 1) {
      for (let right = left + 1; right < names.length; right += 1) {
        const environment = validEnvironment();
        environment[names[right]!] = environment[names[left]!]!;
        await expectRejected(environment, "DATABASE_URLS_NOT_DISTINCT", [
          environment[names[left]!]!
        ]);
      }
    }
  });

  it("rejects malformed PostgreSQL, endpoint, and queue URLs without echoing them", async () => {
    for (const variable of [
      "TEST_DATABASE_URL",
      "TEST_APP_DATABASE_URL",
      "TEST_RELAY_DATABASE_URL",
      "TEST_WORKER_DATABASE_URL",
      "FOUNDATION_SQS_ENDPOINT",
      "FOUNDATION_SQS_QUEUE_URL",
      "FOUNDATION_SQS_DLQ_URL"
    ] as const) {
      const malformed = `not-a-url-${variable.toLowerCase()}`;
      await expectRejected({ ...validEnvironment(), [variable]: malformed }, "MALFORMED_URL", [
        malformed
      ]);
    }
  });

  it("allows only loopback LocalStack endpoint and queue hosts", async () => {
    for (const [variable, value] of [
      ["FOUNDATION_SQS_ENDPOINT", "https://sqs.us-east-1.amazonaws.com"],
      [
        "FOUNDATION_SQS_QUEUE_URL",
        "http://localstack.internal:4566/000000000000/throughline-foundation-test-source"
      ],
      [
        "FOUNDATION_SQS_DLQ_URL",
        "http://192.168.1.20:4566/000000000000/throughline-foundation-test-dlq"
      ]
    ] as const) {
      await expectRejected(
        { ...validEnvironment(), [variable]: value },
        "NON_LOOPBACK_LOCALSTACK_URL",
        [value]
      );
    }
  });

  it("requires source and DLQ URLs to share endpoint and account while remaining distinct", async () => {
    const environment = validEnvironment();
    await expectRejected(
      { ...environment, FOUNDATION_SQS_DLQ_URL: environment.FOUNDATION_SQS_QUEUE_URL },
      "QUEUE_URLS_NOT_DISTINCT"
    );
    await expectRejected(
      {
        ...environment,
        FOUNDATION_SQS_ENDPOINT: "http://localhost:4567"
      },
      "QUEUE_ENDPOINT_MISMATCH"
    );
    await expectRejected(
      {
        ...environment,
        FOUNDATION_SQS_DLQ_URL: "http://localhost:4567/000000000000/throughline-foundation-test-dlq"
      },
      "QUEUE_ENDPOINT_MISMATCH"
    );
    await expectRejected(
      {
        ...environment,
        FOUNDATION_SQS_DLQ_URL: "http://127.0.0.1:4566/111111111111/throughline-foundation-test-dlq"
      },
      "QUEUE_ACCOUNT_MISMATCH"
    );
  });

  it("rejects queue and bucket names that are not explicitly test-only", async () => {
    await expectRejected(
      {
        ...validEnvironment(),
        FOUNDATION_SQS_QUEUE_URL: "http://127.0.0.1:4566/000000000000/customer-events"
      },
      "NON_TEST_RESOURCE_NAME"
    );
    await expectRejected(
      { ...validEnvironment(), FOUNDATION_S3_BUCKET: "throughline-production-artifacts" },
      "NON_TEST_RESOURCE_NAME"
    );
  });

  it("rejects non-dummy AWS credentials and invalid regions without exposing credentials", async () => {
    const accessKey = "AKIAIOSFODNN7EXAMPLE";
    const secretKey = "real-looking-secret-value-marker";
    await expectRejected(
      { ...validEnvironment(), AWS_ACCESS_KEY_ID: accessKey },
      "NON_DUMMY_AWS_CREDENTIALS",
      [accessKey]
    );
    await expectRejected(
      { ...validEnvironment(), AWS_SECRET_ACCESS_KEY: secretKey },
      "NON_DUMMY_AWS_CREDENTIALS",
      [secretKey]
    );
    await expectRejected(
      { ...validEnvironment(), AWS_REGION: "invalid_local_region" },
      "INVALID_AWS_REGION"
    );
  });

  it("requires the verification key map to be a JSON object containing the active safe key ID", async () => {
    for (const value of ["not-json", "null", "[]", JSON.stringify("key")]) {
      await expectRejected(
        { ...validEnvironment(), FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: value },
        "INVALID_VERIFICATION_KEY_MAP",
        [value]
      );
    }
    await expectRejected(
      { ...validEnvironment(), FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "missing_key" },
      "ACTIVE_KEY_NOT_FOUND"
    );
    await expectRejected(
      {
        ...validEnvironment(),
        FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({ "unsafe.key": keyMaterial }),
        FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "unsafe.key"
      },
      "UNSAFE_KEY_ID",
      [keyMaterial]
    );
    await expectRejected(
      {
        ...validEnvironment(),
        FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({
          test_key_1: keyMaterial,
          "unsafe.key": keyMaterial
        })
      },
      "UNSAFE_KEY_ID",
      [keyMaterial]
    );
  });

  it("requires strict base64 encoding of exactly 32 key bytes and never exposes key material", async () => {
    for (const invalidKey of [
      "not-base64!!!",
      Buffer.alloc(31, 9).toString("base64"),
      Buffer.alloc(33, 9).toString("base64")
    ]) {
      await expectRejected(
        {
          ...validEnvironment(),
          FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({ test_key_1: invalidKey })
        },
        "INVALID_VERIFICATION_KEY",
        [invalidKey]
      );
    }
  });

  it("returns only the typed, decoded local test configuration for valid inputs", async () => {
    const config = await parse({ ...validEnvironment(), UNRELATED_SECRET: "must-not-propagate" });

    expect(config).toEqual({
      databaseUrls: {
        owner: validEnvironment().TEST_DATABASE_URL,
        app: validEnvironment().TEST_APP_DATABASE_URL,
        relay: validEnvironment().TEST_RELAY_DATABASE_URL,
        worker: validEnvironment().TEST_WORKER_DATABASE_URL
      },
      localstack: {
        endpoint: validEnvironment().FOUNDATION_SQS_ENDPOINT,
        sourceQueueUrl: validEnvironment().FOUNDATION_SQS_QUEUE_URL,
        dlqUrl: validEnvironment().FOUNDATION_SQS_DLQ_URL,
        bucket: validEnvironment().FOUNDATION_S3_BUCKET,
        region: validEnvironment().AWS_REGION,
        credentials: { accessKeyId: "test", secretAccessKey: "test" }
      },
      contextKeys: {
        activeKeyId: "test_key_1",
        verificationKeys: { test_key_1: new Uint8Array(Buffer.alloc(32, 7)) }
      }
    });
    expect(JSON.stringify(config)).not.toContain("must-not-propagate");
  });
});
