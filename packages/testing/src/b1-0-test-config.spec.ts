import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const REQUIRED_VARIABLES = [
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "TEST_RELAY_DATABASE_URL",
  "TEST_WORKER_DATABASE_URL",
  "TEST_PRODUCT_RELAY_DATABASE_URL",
  "FOUNDATION_SQS_ENDPOINT",
  "FOUNDATION_SQS_QUEUE_URL",
  "FOUNDATION_SQS_DLQ_URL",
  "FOUNDATION_S3_BUCKET",
  "PRODUCT_SQS_ENDPOINT",
  "PRODUCT_SQS_QUEUE_URL",
  "PRODUCT_SQS_QUEUE_NAME",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON",
  "FOUNDATION_CONTEXT_ACTIVE_KEY_ID"
] as const;

const DATABASE_VARIABLES = [
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "TEST_RELAY_DATABASE_URL",
  "TEST_WORKER_DATABASE_URL",
  "TEST_PRODUCT_RELAY_DATABASE_URL"
] as const;

const keyMaterial = Buffer.alloc(32, 7).toString("base64");

function validEnvironment(): Record<string, string | undefined> {
  return {
    TEST_DATABASE_URL:
      "postgres://postgres:owner-password-marker@127.0.0.1:5432/throughline_b1_0_test",
    TEST_APP_DATABASE_URL:
      "postgres://throughline_app:app-password-marker@127.0.0.1:5432/throughline_b1_0_test",
    TEST_RELAY_DATABASE_URL:
      "postgres://throughline_relay:relay-password-marker@127.0.0.1:5432/throughline_b1_0_test",
    TEST_WORKER_DATABASE_URL:
      "postgres://throughline_worker:worker-password-marker@127.0.0.1:5432/throughline_b1_0_test",
    TEST_PRODUCT_RELAY_DATABASE_URL:
      "postgres://throughline_product_relay:product-password-marker@127.0.0.1:5432/throughline_b1_0_test",
    FOUNDATION_SQS_ENDPOINT: "http://127.0.0.1:4566",
    FOUNDATION_SQS_QUEUE_URL:
      "http://127.0.0.1:4566/000000000000/throughline-foundation-test-source",
    FOUNDATION_SQS_DLQ_URL: "http://127.0.0.1:4566/000000000000/throughline-foundation-test-dlq",
    FOUNDATION_S3_BUCKET: "throughline-foundation-test-bucket",
    PRODUCT_SQS_ENDPOINT: "http://127.0.0.1:4566",
    PRODUCT_SQS_QUEUE_URL: "http://127.0.0.1:4566/000000000000/throughline-b1-0-test-product",
    PRODUCT_SQS_QUEUE_NAME: "throughline-b1-0-test-product",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({ test_key_1: keyMaterial }),
    FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "test_key_1"
  };
}

async function parse(environment: Record<string, string | undefined>): Promise<unknown> {
  const moduleUrl = new URL("../../../scripts/b1-0-test-config.ts", import.meta.url).href;
  const module = (await import(/* @vite-ignore */ moduleUrl)) as {
    parseB10TestEnv: (value: Record<string, string | undefined>) => unknown;
  };
  return module.parseB10TestEnv(environment);
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

  expect(failure).toMatchObject({ name: "B10TestConfigError", code });
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

describe("combined B1.0 fail-closed environment preflight", () => {
  it("rejects every absent or blank Foundation and product variable", async () => {
    for (const variable of REQUIRED_VARIABLES) {
      const absent = validEnvironment();
      delete absent[variable];
      await expectRejected(absent, "MISSING_VARIABLE");
      await expectRejected({ ...validEnvironment(), [variable]: "   " }, "MISSING_VARIABLE");
    }
  }, 60_000);

  it("requires all five PostgreSQL role URLs to be pairwise distinct", async () => {
    for (let left = 0; left < DATABASE_VARIABLES.length; left += 1) {
      for (let right = left + 1; right < DATABASE_VARIABLES.length; right += 1) {
        const environment = validEnvironment();
        environment[DATABASE_VARIABLES[right]!] = environment[DATABASE_VARIABLES[left]!]!;
        await expectRejected(environment, "DATABASE_URLS_NOT_DISTINCT");
      }
    }
  });

  it("requires every database URL to use its exact role", async () => {
    for (const variable of DATABASE_VARIABLES) {
      const environment = validEnvironment();
      const wrongRole = new URL(environment[variable]!);
      wrongRole.username = `wrong_${variable.toLowerCase()}`;
      environment[variable] = wrongRole.href;
      await expectRejected(environment, "DATABASE_ROLE_MISMATCH", [wrongRole.href]);
    }
  });

  it("allows only loopback PostgreSQL and safe test-only database names", async () => {
    for (const variable of DATABASE_VARIABLES) {
      const nonLoopback = validEnvironment();
      const remote = new URL(nonLoopback[variable]!);
      remote.hostname = "database.internal";
      nonLoopback[variable] = remote.href;
      await expectRejected(nonLoopback, "NON_LOOPBACK_DATABASE_URL", [remote.href]);

      const production = validEnvironment();
      const productionUrl = new URL(production[variable]!);
      productionUrl.pathname = "/throughline_production";
      production[variable] = productionUrl.href;
      await expectRejected(production, "NON_TEST_RESOURCE_NAME", [productionUrl.href]);

      const unsafe = validEnvironment();
      const unsafeUrl = new URL(unsafe[variable]!);
      unsafeUrl.pathname = "/throughline.test";
      unsafe[variable] = unsafeUrl.href;
      await expectRejected(unsafe, "UNSAFE_RESOURCE_NAME", [unsafeUrl.href]);
    }
  });

  it("rejects every malformed PostgreSQL and LocalStack URL without echoing it", async () => {
    for (const variable of [
      ...DATABASE_VARIABLES,
      "FOUNDATION_SQS_ENDPOINT",
      "FOUNDATION_SQS_QUEUE_URL",
      "FOUNDATION_SQS_DLQ_URL",
      "PRODUCT_SQS_ENDPOINT",
      "PRODUCT_SQS_QUEUE_URL"
    ] as const) {
      const malformed = `not-a-url-${variable.toLowerCase()}-marker`;
      await expectRejected({ ...validEnvironment(), [variable]: malformed }, "MALFORMED_URL", [
        malformed
      ]);
    }
  });

  it("allows only loopback Foundation and product LocalStack URLs", async () => {
    const replacements = {
      FOUNDATION_SQS_ENDPOINT: "http://localstack.internal:4566",
      FOUNDATION_SQS_QUEUE_URL:
        "http://localstack.internal:4566/000000000000/throughline-foundation-test-source",
      FOUNDATION_SQS_DLQ_URL:
        "http://localstack.internal:4566/000000000000/throughline-foundation-test-dlq",
      PRODUCT_SQS_ENDPOINT: "http://localstack.internal:4566",
      PRODUCT_SQS_QUEUE_URL:
        "http://localstack.internal:4566/000000000000/throughline-b1-0-test-product"
    } as const;
    for (const [variable, value] of Object.entries(replacements)) {
      await expectRejected(
        { ...validEnvironment(), [variable]: value },
        "NON_LOOPBACK_LOCALSTACK_URL",
        [value]
      );
    }
  });

  it("requires all queues to share the exact endpoint and account", async () => {
    await expectRejected(
      { ...validEnvironment(), PRODUCT_SQS_ENDPOINT: "http://127.0.0.1:4567" },
      "QUEUE_ENDPOINT_MISMATCH"
    );
    await expectRejected(
      {
        ...validEnvironment(),
        PRODUCT_SQS_QUEUE_URL: "http://127.0.0.1:4567/000000000000/throughline-b1-0-test-product"
      },
      "QUEUE_ENDPOINT_MISMATCH"
    );
    await expectRejected(
      {
        ...validEnvironment(),
        PRODUCT_SQS_QUEUE_URL: "http://127.0.0.1:4566/111111111111/throughline-b1-0-test-product"
      },
      "QUEUE_ACCOUNT_MISMATCH"
    );
    await expectRejected(
      {
        ...validEnvironment(),
        PRODUCT_SQS_QUEUE_URL: "http://127.0.0.1:4566/not-an-account/throughline-b1-test"
      },
      "MALFORMED_URL"
    );
  });

  it("rejects every source, DLQ, and product collision", async () => {
    const valid = validEnvironment();
    await expectRejected(
      { ...valid, FOUNDATION_SQS_DLQ_URL: valid.FOUNDATION_SQS_QUEUE_URL },
      "QUEUE_URLS_NOT_DISTINCT"
    );
    await expectRejected(
      {
        ...valid,
        PRODUCT_SQS_QUEUE_URL: valid.FOUNDATION_SQS_QUEUE_URL,
        PRODUCT_SQS_QUEUE_NAME: "throughline-foundation-test-source"
      },
      "QUEUE_URLS_NOT_DISTINCT"
    );
    await expectRejected(
      {
        ...valid,
        PRODUCT_SQS_QUEUE_URL: valid.FOUNDATION_SQS_DLQ_URL,
        PRODUCT_SQS_QUEUE_NAME: "throughline-foundation-test-dlq"
      },
      "QUEUE_URLS_NOT_DISTINCT"
    );
  });

  it("rejects mismatched, FIFO, non-test, and unsafe queue names", async () => {
    await expectRejected(
      { ...validEnvironment(), PRODUCT_SQS_QUEUE_NAME: "throughline-b1-0-test-other" },
      "QUEUE_NAME_MISMATCH"
    );
    await expectRejected(
      {
        ...validEnvironment(),
        PRODUCT_SQS_QUEUE_NAME: "throughline-b1-0-test-product.fifo",
        PRODUCT_SQS_QUEUE_URL:
          "http://127.0.0.1:4566/000000000000/throughline-b1-0-test-product.fifo"
      },
      "FIFO_QUEUE_FORBIDDEN"
    );
    for (const [variable, value, code] of [
      [
        "FOUNDATION_SQS_QUEUE_URL",
        "http://127.0.0.1:4566/000000000000/throughline.foundation.test-source",
        "UNSAFE_RESOURCE_NAME"
      ],
      [
        "FOUNDATION_SQS_DLQ_URL",
        "http://127.0.0.1:4566/000000000000/throughline.foundation.test-dlq",
        "UNSAFE_RESOURCE_NAME"
      ],
      [
        "FOUNDATION_SQS_QUEUE_URL",
        "http://127.0.0.1:4566/000000000000/customer-events",
        "NON_TEST_RESOURCE_NAME"
      ],
      [
        "FOUNDATION_SQS_DLQ_URL",
        "http://127.0.0.1:4566/000000000000/customer-dlq",
        "NON_TEST_RESOURCE_NAME"
      ]
    ] as const) {
      await expectRejected({ ...validEnvironment(), [variable]: value }, code, [value]);
    }
    await expectRejected(
      {
        ...validEnvironment(),
        PRODUCT_SQS_QUEUE_NAME: "throughline.b1.test-product",
        PRODUCT_SQS_QUEUE_URL: "http://127.0.0.1:4566/000000000000/throughline.b1.test-product"
      },
      "UNSAFE_RESOURCE_NAME"
    );
    await expectRejected(
      {
        ...validEnvironment(),
        PRODUCT_SQS_QUEUE_NAME: "throughline-production-product",
        PRODUCT_SQS_QUEUE_URL: "http://127.0.0.1:4566/000000000000/throughline-production-product"
      },
      "NON_TEST_RESOURCE_NAME"
    );
  });

  it("preserves Foundation bucket test-only and syntax safety", async () => {
    await expectRejected(
      { ...validEnvironment(), FOUNDATION_S3_BUCKET: "throughline-production-bucket" },
      "NON_TEST_RESOURCE_NAME"
    );
    for (const unsafeBucket of [
      "Throughline-Test-Bucket",
      "throughline_test_bucket",
      "throughline..test-bucket"
    ]) {
      await expectRejected(
        { ...validEnvironment(), FOUNDATION_S3_BUCKET: unsafeBucket },
        "UNSAFE_RESOURCE_NAME",
        [unsafeBucket]
      );
    }
  });

  it("rejects non-dummy credentials and invalid regions without exposing markers", async () => {
    for (const [variable, marker] of [
      ["AWS_ACCESS_KEY_ID", "AKIA-REAL-MARKER-12345"],
      ["AWS_SECRET_ACCESS_KEY", "real-secret-material-marker"]
    ] as const) {
      await expectRejected(
        { ...validEnvironment(), [variable]: marker },
        "NON_DUMMY_AWS_CREDENTIALS",
        [marker]
      );
    }
    await expectRejected(
      { ...validEnvironment(), AWS_REGION: "unsafe-region-marker" },
      "INVALID_AWS_REGION"
    );
  });

  it("rejects malformed, unsafe, absent, and inconsistent signing keys", async () => {
    for (const value of ["not-json-marker", "null", "[]", JSON.stringify("test-key-marker")]) {
      await expectRejected(
        { ...validEnvironment(), FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: value },
        "INVALID_VERIFICATION_KEY_MAP",
        [value]
      );
    }
    await expectRejected(
      { ...validEnvironment(), FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "missing_test_key" },
      "ACTIVE_KEY_NOT_FOUND"
    );
    await expectRejected(
      {
        ...validEnvironment(),
        FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON: JSON.stringify({
          "unsafe.test.key": keyMaterial
        }),
        FOUNDATION_CONTEXT_ACTIVE_KEY_ID: "unsafe.test.key"
      },
      "UNSAFE_KEY_ID",
      [keyMaterial]
    );
    for (const invalidKey of [
      "invalid-key-material-marker",
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

  it("returns one combined validated configuration without unrelated values", async () => {
    const environment = validEnvironment();
    const config = await parse({ ...environment, UNRELATED_SECRET: "unrelated-secret-marker" });
    expect(config).toMatchObject({
      databaseUrls: {
        owner: environment.TEST_DATABASE_URL,
        app: environment.TEST_APP_DATABASE_URL,
        relay: environment.TEST_RELAY_DATABASE_URL,
        worker: environment.TEST_WORKER_DATABASE_URL,
        productRelay: environment.TEST_PRODUCT_RELAY_DATABASE_URL
      },
      localstack: {
        endpoint: environment.FOUNDATION_SQS_ENDPOINT,
        sourceQueueUrl: environment.FOUNDATION_SQS_QUEUE_URL,
        dlqUrl: environment.FOUNDATION_SQS_DLQ_URL,
        bucket: environment.FOUNDATION_S3_BUCKET,
        queueUrl: environment.PRODUCT_SQS_QUEUE_URL,
        queueName: environment.PRODUCT_SQS_QUEUE_NAME,
        region: "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" }
      },
      contextKeys: { activeKeyId: "test_key_1" }
    });
    expect(JSON.stringify(config)).not.toContain("unrelated-secret-marker");
  });

  it("refuses in a representative subprocess before Turbo, Vitest, or service startup", () => {
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const supplied = validEnvironment();
    const environment = { ...process.env, ...supplied };
    delete environment.FOUNDATION_CONTEXT_ACTIVE_KEY_ID;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/require-b1-0-test-env.ts"],
      { cwd: repositoryRoot, env: environment, encoding: "utf8" }
    );
    if (result.error) {
      expect((result.error as NodeJS.ErrnoException).code).toBe("EPERM");
      return;
    }
    const output = `${result.stderr}${result.stdout}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("B1.0 test preflight failed [MISSING_VARIABLE]");
    expect(output).not.toMatch(/turbo|vitest|service startup/i);
    for (const value of Object.values(supplied)) {
      if (value && value.length > 4) expect(output).not.toContain(value);
    }
  });
});
