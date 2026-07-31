import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

type GateLeaf = {
  readonly workspace: string;
  readonly files: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

const leaves: readonly GateLeaf[] = [
  { workspace: "@throughline/testing", files: ["src/b2-architecture.spec.ts"] },
  {
    workspace: "@throughline/truth-ledger",
    files: [
      "src/command-schemas.spec.ts",
      "src/confidence.spec.ts",
      "src/domain-command-bus.spec.ts",
      "src/predicate-registry.spec.ts",
      "src/reasons.spec.ts",
      "src/source-span.spec.ts",
      "src/truth-ledger.postgres.spec.ts",
      "src/types.spec.ts"
    ]
  },
  { workspace: "@throughline/account-operations", files: ["src/domain-command-bus.spec.ts"] },
  {
    workspace: "@throughline/authorization",
    files: ["src/b2-authorization.spec.ts", "src/authorization-service.spec.ts"]
  },
  {
    workspace: "@throughline/db",
    files: [
      "src/transaction.spec.ts",
      "src/b1-catalog-contract.spec.ts",
      "src/b2-migration.spec.ts",
      "src/b2-catalog-contract.spec.ts",
      "src/b2-catalog-contract.postgres.spec.ts"
    ]
  },
  {
    workspace: "@throughline/api",
    files: ["src/b2-truth/b2-truth.controller.spec.ts", "src/b2-truth/b2-truth.postgres.spec.ts"],
    env: { AUTH_ADAPTER: "dev", NODE_ENV: "test" }
  }
] as const;

const expectedFiles = new Set(
  leaves.flatMap((leaf) =>
    leaf.files.map((file) => `${leaf.workspace}:${file.replace(/^src\//, "")}`)
  )
);
async function main(): Promise<void> {
  const observedFiles = new Set<string>();
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "throughline-b2-gate-"));

  try {
    for (const [index, leaf] of leaves.entries()) {
      const outputFile = resolve(outputDirectory, `${index}-${basename(leaf.workspace)}.json`);
      const exitCode = await runLeaf(leaf, outputFile);
      if (exitCode !== 0) {
        throw new Error(`B2 gate leaf failed for ${leaf.workspace} with exit code ${exitCode}`);
      }
      const report = JSON.parse(await readFile(outputFile, "utf8")) as {
        numFailedTests?: number;
        numPendingTests?: number;
        numPassedTests?: number;
        testResults?: Array<{
          name?: string;
          assertionResults?: Array<{ status?: string }>;
        }>;
        unhandledErrors?: unknown[];
      };
      if (
        report.numFailedTests !== 0 ||
        report.numPendingTests !== 0 ||
        (report.unhandledErrors?.length ?? 0) !== 0 ||
        !report.testResults?.length
      ) {
        throw new Error(
          `B2 gate leaf did not report a complete zero-skip result for ${leaf.workspace}`
        );
      }
      for (const testFile of report.testResults) {
        if (
          testFile.assertionResults?.some(
            ({ status }) => status === "pending" || status === "skipped" || status === "todo"
          )
        ) {
          throw new Error(`B2 gate leaf contained a non-authoritative test in ${leaf.workspace}`);
        }
        const sourceName = testFile.name;
        const marker = sourceName?.lastIndexOf("/src/");
        if (sourceName === undefined || marker === undefined || marker < 0) {
          throw new Error(`B2 gate leaf emitted an unrecognized test path for ${leaf.workspace}`);
        }
        observedFiles.add(`${leaf.workspace}:${sourceName.slice(marker + 5)}`);
      }
    }

    if (
      observedFiles.size !== expectedFiles.size ||
      [...expectedFiles].some((file) => !observedFiles.has(file))
    ) {
      throw new Error(
        `B2 gate file inventory drifted: expected ${JSON.stringify([...expectedFiles].sort())}, ` +
          `observed ${JSON.stringify([...observedFiles].sort())}`
      );
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function runLeaf(leaf: GateLeaf, outputFile: string): Promise<number> {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      leaf.workspace,
      "exec",
      "vitest",
      "run",
      ...leaf.files,
      "--poolOptions.threads.singleThread",
      "--no-file-parallelism",
      "--reporter=json",
      `--outputFile=${outputFile}`
    ],
    {
      env: { ...process.env, ...leaf.env },
      stdio: "inherit"
    }
  );
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`B2 gate leaf terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
}
