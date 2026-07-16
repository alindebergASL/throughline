import type { TenantDbTransaction } from "@throughline/db";
import { describe, expect, it, vi } from "vitest";
import { ContentRepository } from "./repository.js";

const tenantId = "70000000-0000-7000-8000-000000000001";
const workspaceId = "70000000-0000-7000-8000-000000000002";
const spaceId = "70000000-0000-7000-8000-000000000003";
const sourceA = "70000000-0000-7000-8000-000000000004";
const sourceB = "70000000-0000-7000-8000-000000000005";

describe("ContentRepository source lifecycle", () => {
  it("resolves the terminal tombstone and never falls back to readable predecessor evidence", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH RECURSIVE chain")) return { rows: [{ id: sourceB }] };
      if (sql.includes("FROM content.source_artifacts") && sql.includes("SELECT id, space_id")) {
        return {
          rows: [
            {
              id: sourceB,
              space_id: spaceId,
              source_type: "human",
              title: "Corrected",
              immutable_text: null,
              content_hash: "a".repeat(64),
              normalized_content_hash: "b".repeat(64),
              hash_retention_policy: "retain",
              supersedes_source_id: sourceA,
              access_class: "restricted",
              deleted_at: new Date("2026-07-16T00:00:00.000Z"),
              deletion_reason: "retention",
              deletion_policy_ref: "policy:test",
              hash_disposition: "retained",
              version: 2
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = new ContentRepository({ query } as unknown as TenantDbTransaction);

    await expect(repository.resolveCurrentSource(tenantId, workspaceId, sourceA)).resolves.toEqual(
      expect.objectContaining({
        id: sourceB,
        supersedesSourceId: sourceA,
        hashDisposition: "retained",
        version: 2,
        chunks: []
      })
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toContain("ORDER BY chunk_index");
  });

  it.each([
    ["retain", "retained"],
    ["erase_on_tombstone", "erased"]
  ] as const)(
    "derives the %s policy disposition and removes chunks atomically",
    async (policy, disposition) => {
      const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.startsWith("SELECT space_id, hash_retention_policy")) {
          return { rows: [{ space_id: spaceId, hash_retention_policy: policy }] };
        }
        if (sql.startsWith("UPDATE content.source_artifacts")) {
          expect(values?.[6]).toBe(disposition);
          expect(sql).toContain("CASE WHEN hash_retention_policy = 'retain'");
          return { rows: [{ version: 2 }] };
        }
        if (sql.startsWith("DELETE FROM content.source_chunks")) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      });
      const repository = new ContentRepository({ query } as unknown as TenantDbTransaction);

      await expect(
        repository.tombstoneSource({
          tenantId,
          workspaceId,
          sourceArtifactId: sourceB,
          expectedVersion: 1,
          deletionReasonCategory: "retention",
          deletionPolicyRef: "policy:test"
        })
      ).resolves.toEqual({ spaceId, version: 2, hashDisposition: disposition });
      expect(query).toHaveBeenCalledTimes(3);
    }
  );

  it("derives retention and source access without allowing a downgrade", () => {
    expect(ContentRepository.deriveHashRetentionPolicy(undefined)).toBe("retain");
    expect(ContentRepository.deriveHashRetentionPolicy("erase_on_tombstone:legal")).toBe(
      "erase_on_tombstone"
    );
    expect(ContentRepository.deriveSourceAccessClass("workspace", "public", "restricted")).toBe(
      "restricted"
    );
    expect(ContentRepository.canProjectSource("workspace", "restricted")).toBe(false);
  });

  it("locks and rereads only an exact live terminal correction predecessor", async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      expect(values).toEqual([tenantId, workspaceId, spaceId, sourceA]);
      if (sql.includes("FOR UPDATE OF predecessor")) return { rows: [{ id: sourceA }] };
      if (sql.includes("SELECT predecessor.id, predecessor.space_id")) {
        return {
          rows: [
            {
              id: sourceA,
              space_id: spaceId,
              source_type: "human",
              title: "Current predecessor",
              immutable_text: "opaque",
              content_hash: "a".repeat(64),
              normalized_content_hash: "b".repeat(64),
              hash_retention_policy: "retain",
              supersedes_source_id: null,
              access_class: "restricted",
              deleted_at: null,
              deletion_reason: null,
              deletion_policy_ref: null,
              hash_disposition: null,
              version: 1
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = new ContentRepository({ query } as unknown as TenantDbTransaction);

    await expect(
      repository.lockCurrentSourceForCorrection(tenantId, workspaceId, spaceId, sourceA)
    ).resolves.toMatchObject({ id: sourceA, spaceId, chunks: [] });

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain("predecessor.tenant_id = $1");
      expect(sql).toContain("predecessor.workspace_id = $2");
      expect(sql).toContain("predecessor.space_id = $3");
      expect(sql).toContain("predecessor.id = $4");
      expect(sql).toContain("predecessor.deleted_at IS NULL");
      expect(sql).toContain("successor.supersedes_source_id = predecessor.id");
    }
  });
});
