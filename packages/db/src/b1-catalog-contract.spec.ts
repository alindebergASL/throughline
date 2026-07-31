import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { approvedB2LifecycleTriggerContracts } from "./b1-catalog-contract.js";

const lifecycleUrl = new URL(
  "../migrations/0009_b2_source_truth_lifecycle_interlock.sql",
  import.meta.url
);

describe("B1 catalog approved B2 lifecycle trigger extension", () => {
  it("accepts exactly the three approved phase-3 trigger contracts", async () => {
    const source = await readFile(lifecycleUrl, "utf8");

    expect(approvedB2LifecycleTriggerContracts(source)).toEqual([
      {
        name: "source_artifacts_z_b2_correction_interlock",
        tableName: "content.source_artifacts",
        statement: expect.stringContaining("BEFORE INSERT ON content.source_artifacts")
      },
      {
        name: "source_artifacts_z_b2_tombstone_interlock",
        tableName: "content.source_artifacts",
        statement: expect.stringContaining("BEFORE UPDATE ON content.source_artifacts")
      },
      {
        name: "source_chunks_z_b2_delete_interlock",
        tableName: "content.source_chunks",
        statement: expect.stringContaining("BEFORE DELETE ON content.source_chunks")
      }
    ]);
  });

  it.each([
    [
      "missing",
      (source: string) =>
        source.replace(/CREATE TRIGGER source_chunks_z_b2_delete_interlock[\s\S]*?;\n/, "")
    ],
    [
      "extra",
      (source: string) =>
        `${source}
CREATE TRIGGER source_artifacts_z_b2_extra_interlock
BEFORE UPDATE ON content.source_artifacts
FOR EACH ROW
EXECUTE FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock();
`
    ],
    [
      "renamed",
      (source: string) =>
        source.replace(
          "source_artifacts_z_b2_correction_interlock",
          "source_artifacts_z_b2_correction_interlock_renamed"
        )
    ],
    [
      "wrongly bound",
      (source: string) =>
        source.replace(
          "BEFORE INSERT ON content.source_artifacts",
          "BEFORE INSERT ON content.source_chunks"
        )
    ],
    [
      "wrong function",
      (source: string) =>
        source.replace(
          "EXECUTE FUNCTION ops.enforce_b2_source_truth_lifecycle_interlock();",
          "EXECUTE FUNCTION content.reject_immutable_row_mutation();"
        )
    ],
    [
      "condition drift",
      (source: string) =>
        source.replace(
          "WHEN (NEW.supersedes_source_id IS NOT NULL)",
          "WHEN (NEW.supersedes_source_id IS NULL)"
        )
    ]
  ])("rejects %s lifecycle trigger drift", async (_case, mutate) => {
    const source = await readFile(lifecycleUrl, "utf8");

    expect(() => approvedB2LifecycleTriggerContracts(mutate(source))).toThrow(
      "Approved B2 lifecycle trigger source drifted"
    );
  });

  it("uses a journal phase rather than rewriting immutable B1 migration source", async () => {
    const runner = await readFile(new URL("./migrations.ts", import.meta.url), "utf8");

    expect(runner).toContain("additiveB2Phase: 3");
    expect(runner).not.toContain("b1SourcesWithApprovedB2LifecycleInterlock");
    expect(runner).not.toContain("`${b1Content}\\n${lifecycle}`");
  });
});
