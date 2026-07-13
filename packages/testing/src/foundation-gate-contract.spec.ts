import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("root Foundation gate contract", () => {
  it("defines a fail-closed serial root command without weakening test:security", async () => {
    const manifest = JSON.parse(await read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const foundationCommand = manifest.scripts?.["test:foundation"];

    expect(manifest.scripts?.["test:security"]).toContain("require-security-dsns.ts");
    expect(foundationCommand).toBeTypeOf("string");
    expect(foundationCommand).toContain("require-foundation-test-env");
    expect(foundationCommand).toMatch(
      /(?:concurrency[= ]1|runInBand|poolOptions[^&]*singleThread)/i
    );
  });

  it("keeps the complete PostgreSQL, API, relay, worker, and S3 evidence explicit", async () => {
    const manifest = JSON.parse(await read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const command = manifest.scripts?.["test:foundation"] ?? "";

    expect(command).toMatch(/(?:test:security|foundation-security)/);
    expect(command).toMatch(/api/);
    expect(command).toMatch(/outbox-relay/);
    expect(command).toMatch(/agent-worker/);
    expect(command).toMatch(/(?:s3|marker)/i);
  });

  it("retains exactly 22 worker PostgreSQL plus LocalStack integrations behind the fail-closed gate", async () => {
    const worker = await read("apps/agent-worker/src/foundation-consumer.integration.spec.ts");
    const runner = await read("apps/agent-worker/scripts/run-foundation-worker-integration.mjs");

    const directCases = worker.match(/^\s*it\("/gm)?.length ?? 0;
    const eachBlocks = [...worker.matchAll(/it\.each\(\[([\s\S]*?)\]\s+as const\)/g)];
    const tableCases = eachBlocks.reduce(
      (total, match) => total + (match[1]?.match(/^\s{4}\[/gm)?.length ?? 0),
      0
    );
    expect(directCases + tableCases).toBe(22);
    expect(worker).toContain("describe.sequential");
    expect(runner).toContain("Foundation worker real-service preflight failed");
    expect(runner).toContain("foundation-consumer.integration.spec.ts");
  });
});

describe("CI Foundation gate contract", () => {
  it("starts LocalStack with both SQS and S3 while retaining PostgreSQL", async () => {
    const workflow = await read(".github/workflows/ci.yml");

    expect(workflow).toMatch(/postgres:/);
    expect(workflow).toMatch(/localstack\/localstack:/);
    expect(workflow).toMatch(/SERVICES[^\n]*(?:sqs[^\n]*s3|s3[^\n]*sqs)/i);
    expect(workflow).toContain("pnpm test:security");
  });

  it("provisions and reads back an isolated source queue, same-type DLQ, redrive count three, and test bucket", async () => {
    const workflow = await read(".github/workflows/ci.yml");

    expect(workflow).toMatch(/create-queue[\s\S]*create-queue/i);
    expect(workflow).toMatch(/RedrivePolicy/);
    expect(workflow).toMatch(/maxReceiveCount[^0-9\n]*3/i);
    expect(workflow).toMatch(/get-queue-attributes/i);
    expect(workflow).toMatch(/create-bucket/i);
    expect(workflow).toMatch(/(?:foundation|throughline)[^\n]*test[^\n]*(?:source|queue)/i);
    expect(workflow).toMatch(/(?:foundation|throughline)[^\n]*test[^\n]*dlq/i);
    expect(workflow).toMatch(/(?:foundation|throughline)[^\n]*test[^\n]*bucket/i);
  });

  it("runs the root gate with every explicit variable", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    const requiredVariables = [
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
    ];

    expect(workflow).toContain("pnpm test:foundation");
    for (const variable of requiredVariables) {
      expect(workflow, variable).toMatch(new RegExp(`^\\s+${variable}:`, "m"));
    }
  });
});

describe("scoped S3 marker proof contract", () => {
  it("uses a generated tenant/workspace/Space object prefix and only local explicit AWS wiring", async () => {
    const proof = await read("tests/integration/foundation-s3-marker.integration.spec.ts");

    expect(proof).toContain("buildScopedObjectKey");
    expect(proof.match(/randomUUID\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(proof).toMatch(/PutObjectCommand/);
    expect(proof).toMatch(/(?:GetObjectCommand|HeadObjectCommand)/);
    expect(proof).toMatch(/FOUNDATION_SQS_ENDPOINT/);
    expect(proof).toMatch(/FOUNDATION_S3_BUCKET/);
    expect(proof).toMatch(/AWS_ACCESS_KEY_ID/);
    expect(proof).toMatch(/AWS_SECRET_ACCESS_KEY/);
    expect(proof).toMatch(/(?:127\.0\.0\.1|localhost|\[::1\])/);
    expect(proof).not.toMatch(/s3\.amazonaws\.com|amazonaws\.com\/s3/i);
  });
});
