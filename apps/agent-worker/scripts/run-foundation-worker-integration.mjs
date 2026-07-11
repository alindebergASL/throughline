import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

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
  "AWS_SECRET_ACCESS_KEY"
];

const missing = requiredEnvironment.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Foundation worker real-service preflight failed; missing: ${missing.join(", ")}`);
  process.exit(2);
}

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "vitest", "run", "src/foundation-consumer.integration.spec.ts"],
  {
    cwd: appDirectory,
    env: process.env,
    stdio: "inherit"
  }
);

if (result.error) {
  console.error("Foundation worker real-service gate could not start");
  process.exit(1);
}
process.exit(result.status ?? 1);
