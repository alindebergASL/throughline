import type { SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import type { PgPool, PgPoolClient } from "./client.js";
import { withTenantTransaction } from "./transaction.js";

describe("withTenantTransaction", () => {
  it.each([
    [
      "the sole requested Space",
      ["11111111-1111-4111-8111-111111111114"],
      "11111111-1111-4111-8111-111111111114"
    ],
    ["no requested Space", [], ""],
    [
      "multiple requested Spaces",
      ["11111111-1111-4111-8111-111111111114", "11111111-1111-4111-8111-111111111120"],
      ""
    ]
  ])("sets transaction-local app.space_id for %s", async (_label, requestedSpaceIds, expected) => {
    const context: SecurityContext = {
      ...createDevSecurityContext("tenant-a-owner"),
      requestedSpaceIds
    };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      void values;
      return {
        command: "",
        rowCount: sql.includes("AS settings_cleared") ? 1 : 0,
        oid: 0,
        fields: [],
        rows: sql.includes("AS settings_cleared") ? [{ settings_cleared: true }] : []
      };
    });
    const client = {
      query,
      release: vi.fn()
    } as unknown as PgPoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;

    await withTenantTransaction({ pool, context }, async () => undefined);

    const spaceSettingCalls = query.mock.calls.filter(
      ([sql, values]) => sql === "SELECT set_config($1, $2, true)" && values?.[0] === "app.space_id"
    );
    expect(spaceSettingCalls).toEqual([
      ["SELECT set_config($1, $2, true)", ["app.space_id", expected]]
    ]);
    expect(query).toHaveBeenCalledWith("SELECT set_config($1, $2, true)", [
      "app.data_class_ceiling",
      context.dataClassCeiling
    ]);

    if (requestedSpaceIds.length > 1) {
      expect(spaceSettingCalls[0]?.[1]?.[1]).not.toBe(requestedSpaceIds[0]);
      expect(spaceSettingCalls[0]?.[1]?.[1]).not.toBe(requestedSpaceIds[1]);
    }
  });

  it("rejects an elapsed SecurityContext before acquiring a database connection", async () => {
    const context: SecurityContext = createDevSecurityContext("tenant-a-owner", {
      now: new Date("2000-01-01T00:00:00.000Z")
    });
    const query = vi.fn().mockResolvedValue({
      command: "",
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: []
    });
    const client = {
      query,
      release: vi.fn()
    } as unknown as PgPoolClient;
    const connect = vi.fn().mockResolvedValue(client);
    const pool = { connect } as unknown as PgPool;
    const callback = vi.fn().mockResolvedValue(undefined);

    const outcome = await withTenantTransaction({ pool, context }, callback).then(
      () => ({ status: "resolved" as const, error: undefined }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );

    expect.soft(outcome).toMatchObject({
      status: "rejected",
      error: { message: "SecurityContext has expired" }
    });
    expect.soft(connect).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("destroys a pooled connection when transaction-local context cleanup cannot be proved", async () => {
    const context = createDevSecurityContext("tenant-a-owner");
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("AS settings_cleared") ? [{ settings_cleared: false }] : []
      })),
      release
    } as unknown as PgPoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as PgPool;

    await expect(withTenantTransaction({ pool, context }, async () => undefined)).rejects.toThrow(
      "Transaction-local security context was not cleared"
    );
    expect(release).toHaveBeenCalledWith(true);
  });
});
