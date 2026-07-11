import type { SecurityContext } from "@throughline/core-types";
import { createAsyncContextReferenceCodec } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import type { PgPool, PgPoolClient } from "./client.js";
import { bootstrapWorkerContextReference } from "./worker-bootstrap.js";

const now = new Date("2026-07-10T20:00:00.000Z");
const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const bindings = {
  referenceId: "70000000-0000-7000-8000-000000000031",
  jobId: "70000000-0000-7000-8000-000000000021",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "11111111-1111-4111-8111-111111111112",
  spaceId: "11111111-1111-4111-8111-111111111113",
  workerServicePrincipalId: "70000000-0000-7000-8000-000000000051",
  policyVersionId: "default-v1"
} as const;

const context: SecurityContext = {
  requestId: "request-safe",
  traceId: "trace-safe",
  tenantId: bindings.tenantId,
  workspaceId: bindings.workspaceId,
  actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  actorMembershipId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
  requestedSpaceIds: [bindings.spaceId],
  membershipIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"],
  roleHints: ["owner"],
  dataClassCeiling: "workspace",
  policyVersion: bindings.policyVersionId,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString()
};

function codec() {
  return createAsyncContextReferenceCodec({
    verificationKeys: new Map([["test-key", key]]),
    activeKeyId: "test-key",
    clock: () => now
  });
}

function expected() {
  return {
    jobId: bindings.jobId,
    tenantId: bindings.tenantId,
    workspaceId: bindings.workspaceId,
    spaceId: bindings.spaceId,
    workerServicePrincipalId: bindings.workerServicePrincipalId,
    policyVersionId: bindings.policyVersionId
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: bindings.referenceId,
    jobId: bindings.jobId,
    tenantId: bindings.tenantId,
    workspaceId: bindings.workspaceId,
    spaceId: bindings.spaceId,
    workerServicePrincipalId: bindings.workerServicePrincipalId,
    delegatingUserId: context.actorUserId,
    delegatingMembershipId: context.actorMembershipId,
    policyVersionId: bindings.policyVersionId,
    contextSnapshot: context,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    status: "active",
    signingKeyId: "test-key",
    ...overrides
  };
}

function mockPool(rows = [row()], roleRows: unknown[] = [{ currentUser: "throughline_worker" }]) {
  const query = vi.fn(async (sql: string) => {
    if (sql === 'SELECT current_user AS "currentUser"') {
      return { rows: roleRows, rowCount: roleRows.length };
    }
    if (sql.includes("FROM ops.security_context_references")) {
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() } as unknown as PgPoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;
  return { pool, client, query };
}

describe("fixed worker context-reference bootstrap", () => {
  it("sets only the seven verified transaction-local bindings and executes one fixed lookup", async () => {
    const signer = codec();
    const token = signer.issue({ ...bindings, ttlSeconds: 600 }).token;
    const { pool, client, query } = mockPool();

    await expect(
      bootstrapWorkerContextReference({ pool, token, codec: signer, expected: expected() })
    ).resolves.toMatchObject({ contextSnapshot: context, id: bindings.referenceId });

    const calls = query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>;
    expect(calls[0]?.[0]).toBe("BEGIN");
    expect(calls[1]?.[0]).toBe('SELECT current_user AS "currentUser"');
    expect(calls[1]?.[1]).toBeUndefined();
    expect(calls.slice(2, 9).map(([, values]) => values?.[0])).toEqual([
      "app.tenant_id",
      "app.workspace_id",
      "app.space_id",
      "app.job_id",
      "app.context_reference_id",
      "app.worker_principal_id",
      "app.policy_version"
    ]);
    expect(calls[9]?.[0]).toContain("FROM ops.security_context_references");
    expect(calls[9]?.[0]).toContain("status = 'active'");
    expect(calls[9]?.[0]).toContain("clock_timestamp()");
    expect(calls[9]?.[1]).toEqual([Math.floor((now.getTime() + 600_000) / 1_000), "test-key"]);
    expect(calls[10]?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();

    const allSql = calls.map(([sql]) => sql).join("\n");
    expect(allSql).not.toContain("app.user_id");
    expect(allSql).not.toContain("app.membership_id");
    expect(allSql).not.toContain("app.service_principal_id");
    expect(allSql).not.toContain("app.agent_principal_id");
  });

  it.each([
    ["owner role", [{ currentUser: "postgres" }]],
    ["app role", [{ currentUser: "throughline_app" }]],
    ["missing row", []],
    [
      "duplicate rows",
      [{ currentUser: "throughline_worker" }, { currentUser: "throughline_worker" }]
    ],
    ["missing field", [{}]],
    ["non-string field", [{ currentUser: null }]]
  ])(
    "refuses a %s before setting bindings or looking up the reference",
    async (_case, roleRows) => {
      const signer = codec();
      const token = signer.issue({ ...bindings, ttlSeconds: 600 }).token;
      const { pool, client, query } = mockPool([row()], roleRows);

      await expect(
        bootstrapWorkerContextReference({ pool, token, codec: signer, expected: expected() })
      ).rejects.toMatchObject({
        name: "WorkerContextBootstrapError",
        message: "Worker context bootstrap failed"
      });

      expect(query.mock.calls).toEqual([
        ["BEGIN"],
        ['SELECT current_user AS "currentUser"'],
        ["ROLLBACK"]
      ]);
      expect(client.release).toHaveBeenCalledOnce();
    }
  );

  it("has no caller SQL or transaction/query callback surface", () => {
    expect(bootstrapWorkerContextReference).toHaveLength(1);
    const source = bootstrapWorkerContextReference.toString();
    expect(source).not.toMatch(/callback|callerSql|statement/);
  });

  it("returns no usable row for forged tokens or signed binding mismatches before connecting", async () => {
    const signer = codec();
    const token = signer.issue({ ...bindings, ttlSeconds: 600 }).token;
    const { pool } = mockPool();
    const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expect(
      bootstrapWorkerContextReference({ pool, token: forged, codec: signer, expected: expected() })
    ).resolves.toBeNull();
    await expect(
      bootstrapWorkerContextReference({
        pool,
        token,
        codec: signer,
        expected: { ...expected(), jobId: "70000000-0000-7000-8000-000000000022" }
      })
    ).resolves.toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("returns no usable row for unknown, revoked, expired, key-mismatched, or unsafe snapshots", async () => {
    const signer = codec();
    const token = signer.issue({ ...bindings, ttlSeconds: 600 }).token;
    for (const rows of [
      [],
      [row({ status: "revoked" })],
      [row({ expiresAt: now.toISOString() })],
      [row({ signingKeyId: "other-key" })],
      [
        row({
          contextSnapshot: {
            ...context,
            roleHints: ["secret-body-marker"],
            expiresAt: now.toISOString()
          }
        })
      ]
    ]) {
      const { pool } = mockPool(rows);
      await expect(
        bootstrapWorkerContextReference({ pool, token, codec: signer, expected: expected() })
      ).resolves.toBeNull();
    }
  });

  it("destroys a blocked bootstrap connection on abort and never releases it reusable", async () => {
    const signer = codec();
    const token = signer.issue({ ...bindings, ttlSeconds: 600 }).token;
    const controller = new AbortController();
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT current_user AS "currentUser"') {
        return { rows: [{ currentUser: "throughline_worker" }], rowCount: 1 };
      }
      if (sql.includes("FROM ops.security_context_references")) {
        return new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("query aborted")), {
            once: true
          });
        });
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release } as unknown as PgPoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;

    const pending = bootstrapWorkerContextReference({
      pool,
      token,
      codec: signer,
      expected: expected(),
      signal: controller.signal
    });
    await vi.waitFor(() => {
      expect(
        query.mock.calls.some(([sql]) =>
          String(sql).includes("FROM ops.security_context_references")
        )
      ).toBe(true);
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "WorkerContextBootstrapError" });
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it("rolls back with a safe error that contains no token, key, or SecurityContext body", async () => {
    const signer = codec();
    const token = signer.issue({ ...bindings, ttlSeconds: 600 }).token;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM ops.security_context_references")) {
        throw new Error("driver detail must be hidden");
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() } as unknown as PgPoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;

    let error: unknown;
    try {
      await bootstrapWorkerContextReference({ pool, token, codec: signer, expected: expected() });
    } catch (caught) {
      error = caught;
    }
    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    expect(rendered).toContain("Worker context bootstrap failed");
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(key.toString("utf8"));
    expect(rendered).not.toContain("roleHints");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
