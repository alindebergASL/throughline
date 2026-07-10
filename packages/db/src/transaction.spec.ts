import type { SecurityContext } from "@throughline/core-types";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import type { PgPool, PgPoolClient } from "./client.js";
import { withTenantTransaction } from "./transaction.js";

describe("withTenantTransaction", () => {
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
});
