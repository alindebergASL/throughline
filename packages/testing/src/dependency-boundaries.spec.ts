import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const corePackageDirs = [
  "packages/core-types",
  "packages/db",
  "packages/tenancy",
  "packages/authorization",
  "packages/work-graph",
  "packages/content",
  "packages/truth-ledger",
  "packages/agent-runtime",
  "packages/capability-broker",
  "packages/integrations",
  "packages/search",
  "packages/observability"
];

const forbiddenPatterns = [
  /@throughline\/account-operations/,
  /@throughline\/domain-profiles/,
  /\bprofiles\//,
  /\badapters\//
];

function trackedBoundaryFiles(packageDir: string) {
  const packagePath = join(repoRoot, packageDir);
  const files = [join(packagePath, "package.json")];
  const srcPath = join(packagePath, "src");

  function collect(dir: string) {
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        collect(entryPath);
      } else if (/\.(ts|tsx)$/.test(entryPath)) {
        files.push(entryPath);
      }
    }
  }

  collect(srcPath);
  return files;
}

describe("core dependency boundaries", () => {
  it("keeps core packages independent from Account Operations, profiles, and adapters", () => {
    const violations = corePackageDirs.flatMap((packageDir) =>
      trackedBoundaryFiles(packageDir).flatMap((filePath) => {
        const text = readFileSync(filePath, "utf8");
        return forbiddenPatterns
          .filter((pattern) => pattern.test(text))
          .map((pattern) => `${relative(repoRoot, filePath)} matches ${pattern.source}`);
      })
    );

    expect(violations).toEqual([]);
  });
});
