import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Wave B1 authoritative gate wiring", () => {
  it("fails closed before nested tests and reuses the exhaustive disposable B1.0 resource validation", async () => {
    const [packageJson, config, preflight] = await Promise.all([
      readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../../scripts/b1-test-config.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../scripts/require-b1-test-env.ts", import.meta.url), "utf8")
    ]);
    const gate = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts[
      "test:b1"
    ]!;
    expect(
      gate.startsWith("node --import tsx scripts/require-b1-test-env.ts && pnpm test:b1-0")
    ).toBe(true);
    expect(gate).toContain("B1_AUTHORITATIVE_GATE=1");
    expect(gate).toContain("b1-account-operations.runtime.spec.ts");
    expect(gate.match(/b1-account-operations\.runtime\.spec\.ts/g)).toHaveLength(1);
    expect(gate).toContain("b1-manual-workflow.postgres.spec.ts");
    expect(gate.indexOf("scripts/require-b1-test-env.ts")).toBeLessThan(
      gate.indexOf("pnpm test:b1-0")
    );
    expect(config).toContain("parseB10TestEnv(environment)");
    expect(preflight).not.toMatch(/createPgPool|new Pool|fetch\(|SQSClient|S3Client|vitest|turbo/);
  });
});
