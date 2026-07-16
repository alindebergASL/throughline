import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import type { PgPool, PgPoolClient } from "@throughline/db";
import {
  createAsyncContextReferenceCodec,
  createDevSecurityContext,
  devFixtures
} from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import {
  defaultFoundationProofRuntimeOptions,
  FoundationProofService
} from "./foundation-proof.service.js";

const now = new Date();
const context = createDevSecurityContext("tenant-a-owner", { now });

function buildService(roleRows: unknown[], roleFailure?: Error) {
  const order: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("AS settings_cleared")) {
      return { rows: [{ settings_cleared: true }], rowCount: 1 };
    }
    if (sql === 'SELECT current_user AS "currentUser"') {
      order.push("role");
      if (roleFailure) throw roleFailure;
      return { rows: roleRows, rowCount: roleRows.length };
    }
    if (sql.includes("INSERT INTO ops.security_context_references")) order.push("reference");
    if (sql.includes("INSERT INTO ops.foundation_test_aggregates")) {
      order.push("aggregate");
      return {
        rows: [{ id: "70000000-0000-7000-8000-000000000081", aggregateVersion: 1 }],
        rowCount: 1
      };
    }
    if (sql.includes("INSERT INTO ops.outbox_events")) order.push("outbox");
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() } as unknown as PgPoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client)
  } as unknown as PgPool;
  const authorization = {
    can: vi.fn(),
    canInTransaction: vi.fn(async () => {
      order.push("authorization");
      return { allowed: true, reasonCode: "allowed", policyVersion: context.policyVersion };
    })
  } as unknown as TransactionAwareAuthorizationService;
  const codec = createAsyncContextReferenceCodec({
    verificationKeys: new Map([["task5-unit", new Uint8Array(32).fill(7)]]),
    activeKeyId: "task5-unit",
    clock: () => now
  });
  let nextId = 81;
  const service = new FoundationProofService(
    pool,
    authorization,
    codec,
    defaultFoundationProofRuntimeOptions({
      relayServicePrincipalId: devFixtures.relayServicePrincipalA,
      workerServicePrincipalId: devFixtures.servicePrincipalA,
      uuidV7: () => `70000000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`
    })
  );
  return { authorization, client, order, query, service };
}

describe("FoundationProofService database role boundary", () => {
  it("asserts the exact app role before authorization and every proof write", async () => {
    const { authorization, client, order, query, service } = buildService([
      { currentUser: "throughline_app" }
    ]);

    await expect(
      service.create({ context, spaceId: devFixtures.restrictedSpaceA, proofKey: "unit-success" })
    ).resolves.toMatchObject({ aggregateVersion: 1 });

    expect(order).toEqual(["role", "authorization", "reference", "aggregate", "outbox"]);
    const roleCall = query.mock.calls.find(
      ([sql]) => sql === 'SELECT current_user AS "currentUser"'
    ) as unknown as [string, unknown];
    expect(roleCall).toEqual(['SELECT current_user AS "currentUser"', undefined]);
    expect(authorization.canInTransaction).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["owner role", [{ currentUser: "postgres" }]],
    ["missing row", []],
    ["duplicate rows", [{ currentUser: "throughline_app" }, { currentUser: "throughline_app" }]],
    ["missing field", [{}]],
    ["non-string field", [{ currentUser: null }]]
  ])("rolls back a %s before authorization or writes with a safe error", async (_case, rows) => {
    const { authorization, client, order, query, service } = buildService(rows);

    let error: unknown;
    try {
      await service.create({
        context: { ...context, requestId: "secret-context-marker" },
        spaceId: devFixtures.restrictedSpaceA,
        proofKey: "secret-proof-key"
      });
    } catch (caught) {
      error = caught;
    }

    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    expect(rendered).toContain("Foundation proof database role validation failed");
    expect(rendered).not.toContain("postgres://owner:password@database/throughline");
    expect(rendered).not.toContain("secret-context-marker");
    expect(rendered).not.toContain("secret-proof-key");
    expect(order).toEqual(["role"]);
    expect(authorization.canInTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("redacts driver details when the fixed role query fails", async () => {
    const leak = "postgres://owner:password@database/throughline secret-token secret-key";
    const { authorization, query, service } = buildService([], new Error(leak));

    await expect(
      service.create({ context, spaceId: devFixtures.restrictedSpaceA, proofKey: "query-failure" })
    ).rejects.toMatchObject({ message: "Foundation proof database role validation failed" });
    await expect(
      service.create({
        context,
        spaceId: devFixtures.restrictedSpaceA,
        proofKey: "query-failure-2"
      })
    ).rejects.not.toThrow(leak);
    expect(authorization.canInTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(2);
  });
});
