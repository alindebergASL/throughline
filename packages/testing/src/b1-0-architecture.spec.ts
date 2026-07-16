import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const foundationProductionHashes = {
  "packages/core-types/src/async-foundation.ts":
    "1db76800b42ec54d656d4b2bab74c65315e7731e1d8d090ea524fd254bd5fc9b",
  "packages/db/src/relay-transaction.ts":
    "b175d92f2e9b392f0b484d99c989eafc91914f67c84571885dcb3b1fa0fcb584",
  "packages/db/src/foundation-proof-repository.ts":
    "8fa93ead8a3aa72c8aac0a3dd4cf498d153efec5945131485c73398a7a83d1cb",
  "packages/db/src/worker-transaction.ts":
    "7f11daf4a5f9e8585fa2d106f85d87e6f71c7cc2384a90a4587c348a1d6a1b38",
  "packages/db/src/worker-bootstrap.ts":
    "bf35602c274aa003a1564c5d5da3c06637e0ad7a7073f1e6afcd15957330001d",
  "apps/outbox-relay/src/relay.ts":
    "5176a0890990f21aec6455b345f4c13a9370a2e86b96f39a0fa8a25b4d1cfcc6",
  "apps/outbox-relay/src/main.ts":
    "a9d29bc912ce3f801158da8a98b7ffd2da6dd531df6058eea3ff2a90427441c3",
  "apps/agent-worker/src/worker-context.ts":
    "2e769aea15c191d02389b30701d52da3935c54c2e4375fb01284450fda52c61a",
  "apps/agent-worker/src/main.ts":
    "c4335bf73af6662219503f7cda632825e5ca61ae3fe510b69312553f6ab7cb4e"
} as const;

describe("B1.0 architecture and Foundation isolation", () => {
  it("preserves exact Foundation production bytes while the complete Foundation gate remains nested", async () => {
    for (const [relativePath, expectedHash] of Object.entries(foundationProductionHashes)) {
      const bytes = await readFile(join(repositoryRoot, relativePath));
      expect(createHash("sha256").update(bytes).digest("hex"), relativePath).toBe(expectedHash);
    }
    const packageJson = await source("package.json");
    const gate = JSON.parse(packageJson) as { scripts: Record<string, string> };
    const b10Gate = gate.scripts["test:b1-0"];
    expect(b10Gate).toContain("scripts/require-b1-0-test-env.ts && pnpm test:foundation");
    expect(b10Gate?.indexOf("pnpm test:foundation")).toBeLessThan(
      b10Gate?.indexOf("b1-0-product-domain.postgres.spec.ts") ?? -1
    );
  });

  it("runs one combined sanitized preflight before either nested gate", async () => {
    const config = await source("scripts/b1-0-test-config.ts");
    const gateScript = await source("scripts/require-b1-0-test-env.ts");
    const turbo = JSON.parse(await source("turbo.json")) as { globalEnv: string[] };
    expect(config).toContain('from "./foundation-test-config.js"');
    expect(config.indexOf("parseFoundationTestEnv(environment)")).toBeLessThan(
      config.indexOf("for (const variable of REQUIRED_PRODUCT_VARIABLES)")
    );
    expect(config).not.toMatch(/createPgPool|new Pool|fetch\(|SQSClient|S3Client/);
    expect(gateScript).not.toMatch(/turbo|vitest|createPgPool|SQSClient|S3Client/);
    for (const variable of [
      "TEST_RELAY_DATABASE_URL",
      "TEST_WORKER_DATABASE_URL",
      "TEST_PRODUCT_RELAY_DATABASE_URL",
      "FOUNDATION_SQS_QUEUE_URL",
      "FOUNDATION_SQS_DLQ_URL",
      "FOUNDATION_S3_BUCKET",
      "PRODUCT_SQS_QUEUE_URL",
      "FOUNDATION_CONTEXT_VERIFICATION_KEYS_JSON",
      "FOUNDATION_CONTEXT_ACTIVE_KEY_ID"
    ]) {
      expect(turbo.globalEnv).toContain(variable);
    }
  });

  it("keeps the B1.0 migration isolated from later additive migrations and shadow ledgers", async () => {
    const migrationDirectory = join(repositoryRoot, "packages/db/migrations");
    const migrationFiles = (await readdir(migrationDirectory)).sort();
    expect(migrationFiles.slice(0, 3)).toEqual([
      "0001_wave_a2_identity_access_rls.sql",
      "0002_foundation_closure_async_isolation.sql",
      "0003_b1_0_canonical_product_outbox.sql"
    ]);
    const migration = await source("packages/db/migrations/0003_b1_0_canonical_product_outbox.sql");
    expect(migration).not.toContain("ops.domain_events");
    expect(
      [...migration.matchAll(/CREATE TABLE IF NOT EXISTS ops\.([a-z_]+)/g)].map((match) => match[1])
    ).toEqual(["domain_command_records", "audit_events", "product_outbox_events"]);
    expect(migration).not.toMatch(/CREATE TABLE (?:public|test|shadow)\./i);
  });

  it("adds no product consumer, worker, or event-source mapping to the B1.0 runtime", async () => {
    const productionRoots = ["apps/agent-worker/src", "apps/connector-worker/src"];
    for (const root of productionRoots) {
      const files = await typescriptFiles(join(repositoryRoot, root));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(content, file).not.toMatch(
          /product_outbox|DomainNotificationEnvelope|b1_0\.fixture|source_artifact\.tombstoned/i
        );
      }
    }
    const productRuntime = [
      await source("apps/outbox-relay/src/product-main.ts"),
      await source("apps/outbox-relay/src/product-relay.ts")
    ].join("\n");
    expect(productRuntime).not.toMatch(
      /ReceiveMessageCommand|DeleteMessageCommand|ChangeMessageVisibilityCommand|EventSourceMapping|RedrivePolicyCommand/
    );
    expect(productRuntime).not.toMatch(/ops\.outbox_events|foundation\.relay|foundation\.worker/);
  });

  it("keeps production SQS authority to SendMessage/GetQueueAttributes and no FIFO fields", async () => {
    const main = await source("apps/outbox-relay/src/product-main.ts");
    const relay = await source("apps/outbox-relay/src/product-relay.ts");
    expect(main).toContain("SendMessageCommand");
    expect(main).toContain("GetQueueAttributesCommand");
    expect(main).not.toMatch(/ReceiveMessage|DeleteMessage|ChangeMessageVisibility/);
    expect(relay).toContain('event_id: { DataType: "String"');
    expect(relay).not.toMatch(/MessageGroupId|MessageDeduplicationId/);
    expect(relay).toContain("PRODUCT_NOTIFICATION_RETENTION_SECONDS = 86_400");
    expect(relay).not.toMatch(/setTimeout\([^)]*PRODUCT_NOTIFICATION_RETENTION/);
  });

  it("keeps transaction writers pool-free and fixed-statement-only", async () => {
    const repositories = await source("packages/db/src/product-domain-repositories.ts");
    const provisioning = await source("packages/db/src/product-relay-provisioning.ts");
    expect(repositories).toContain("constructor(private readonly tx: TenantDbTransaction)");
    expect(repositories).not.toMatch(/PgPool|createPgPool|withTenantTransaction/);
    expect(provisioning).not.toMatch(/PgPool|createPgPool|withTenantTransaction/);
    for (const content of [repositories, provisioning]) {
      expect(content).not.toMatch(
        /queryCallback|genericQuery|executeSql|arbitrarySql|callerSql|commandBus|handler|route/
      );
    }
  });

  it("uses sanitized errors and emits no product payload/credential logging", async () => {
    const files = [
      "packages/db/src/product-domain-repositories.ts",
      "packages/db/src/product-outbox-repository.ts",
      "packages/db/src/product-relay-provisioning.ts",
      "apps/outbox-relay/src/product-main.ts",
      "apps/outbox-relay/src/product-relay.ts",
      "scripts/b1-0-test-config.ts",
      "scripts/require-b1-0-test-env.ts"
    ];
    const content = (await Promise.all(files.map(source))).join("\n");
    expect(content).not.toMatch(/console\.(?:log|info|warn|debug)/);
    expect(content).not.toMatch(/JSON\.stringify\(error\)|error\.message|provider.*body/i);
    expect(content).not.toMatch(/AWS_SECRET_ACCESS_KEY.*console|MessageBody.*console/);
    expect(content).not.toContain("credential=secret");
  });

  it("wires a unique Standard queue and serialized fail-closed real-service gate in CI", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    expect(workflow).toContain(
      "PRODUCT_QUEUE_NAME: throughline-b1-0-test-product-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(workflow).toContain("--attributes MessageRetentionPeriod=86400");
    expect(workflow).toContain('has("RedrivePolicy")');
    expect(workflow).toContain("Run fail-closed Foundation PostgreSQL and LocalStack gate");
    expect(workflow).toContain("Run fail-closed B1.0 PostgreSQL and LocalStack gate");
    expect(workflow).toContain("run: pnpm test:b1-0");
  });
});

async function source(relativePath: string): Promise<string> {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
    })
  );
  return nested.flat();
}
