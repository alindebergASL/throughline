import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { DynamicModule, Type } from "@nestjs/common";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  seedWaveA2DeterministicData,
  withTenantTransaction,
  type PgPool
} from "@throughline/db";
import {
  createDevSecurityContext,
  createAsyncContextReferenceCodec,
  devFixtures,
  generateUuidV7
} from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module.js";
import { FoundationProofModule } from "./foundation-proof.module.js";
import { FoundationProofService } from "./foundation-proof.service.js";

const proofUrl = "/__test/foundation-proof";
type EnvironmentSnapshot = Readonly<{
  authAdapter: string | undefined;
  nodeEnv: string | undefined;
}>;

function captureEnvironment(): EnvironmentSnapshot {
  return {
    authAdapter: process.env.AUTH_ADAPTER,
    nodeEnv: process.env.NODE_ENV
  };
}

function enableFoundationTestEnvironment(): void {
  process.env.AUTH_ADAPTER = "dev";
  process.env.NODE_ENV = "test";
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  if (snapshot.authAdapter === undefined) delete process.env.AUTH_ADAPTER;
  else process.env.AUTH_ADAPTER = snapshot.authAdapter;
  if (snapshot.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = snapshot.nodeEnv;
}

const fileEnvironment = captureEnvironment();
interface ProofBody {
  spaceId: string;
  proofKey: string;
}

const validBody: ProofBody = {
  spaceId: devFixtures.restrictedSpaceA,
  proofKey: "request-proof"
};
const forbiddenAuthorityHeaders = [
  "x-throughline-tenant-id",
  "x-throughline-workspace-id",
  "x-throughline-user-id",
  "x-throughline-membership-id",
  "x-throughline-role",
  "x-throughline-permissions",
  "tenantid",
  "workspaceid",
  "userid",
  "role",
  "permissions"
] as const;
const forbiddenAuthorityFields = [
  "securityContext",
  "tenantId",
  "workspaceId",
  "userId",
  "membershipId",
  "actorUserId",
  "actorMembershipId",
  "servicePrincipalId",
  "agentPrincipalId",
  "role",
  "permissions",
  "policyVersion",
  "requestedSpaceIds",
  "membershipIds",
  "roleHints",
  "dataClassCeiling"
] as const;

async function createApp(importedModule: Type<unknown> | DynamicModule) {
  const moduleRef = await Test.createTestingModule({ imports: [importedModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe("test-only foundation proof request boundary", () => {
  let previousEnvironment: EnvironmentSnapshot;

  beforeAll(() => {
    previousEnvironment = captureEnvironment();
    enableFoundationTestEnvironment();
  });

  afterAll(() => {
    try {
      // This suite owns no external resources.
    } finally {
      restoreEnvironment(previousEnvironment);
    }
  });

  it("resolves a valid deterministic dev identity and passes only server-built authority", async () => {
    const create = vi.fn().mockResolvedValue({ jobId: "job", aggregateVersion: 1 });
    const module = FoundationProofModule.register({
      pool: {} as PgPool,
      authorization: {} as never,
      contextReferenceCodec: {} as never,
      relayServicePrincipalId: devFixtures.relayServicePrincipalA,
      workerServicePrincipalId: devFixtures.servicePrincipalA
    });
    const moduleRef = await Test.createTestingModule({ imports: [module] })
      .overrideProvider(FoundationProofService)
      .useValue({ create })
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: proofUrl,
          headers: {
            "x-throughline-dev-identity": "tenant-a-owner",
            "x-request-id": "request-boundary",
            "x-trace-id": "trace-boundary"
          },
          payload: validBody
        });

      expect(create).toHaveBeenCalledOnce();
      expect(response.statusCode, response.body).toBe(201);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        context: {
          requestId: "request-boundary",
          traceId: "trace-boundary",
          tenantId: devFixtures.tenantA,
          workspaceId: devFixtures.workspaceA,
          actorUserId: devFixtures.userA,
          actorMembershipId: devFixtures.membershipAOwner
        },
        spaceId: devFixtures.restrictedSpaceA,
        proofKey: "request-proof"
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["missing identity", undefined],
    ["unknown alias", "unknown-alias"]
  ])("rejects %s", async (_label, identity) => {
    const app = await createApp(
      FoundationProofModule.register({
        pool: {} as PgPool,
        authorization: {} as never,
        contextReferenceCodec: {} as never,
        relayServicePrincipalId: devFixtures.relayServicePrincipalA,
        workerServicePrincipalId: devFixtures.servicePrincipalA
      })
    );

    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: proofUrl,
          headers: identity ? { "x-throughline-dev-identity": identity } : {},
          payload: validBody
        });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it.each(forbiddenAuthorityHeaders)("rejects forbidden authority header %s", async (header) => {
    const app = await createApp(
      FoundationProofModule.register({
        pool: {} as PgPool,
        authorization: {} as never,
        contextReferenceCodec: {} as never,
        relayServicePrincipalId: devFixtures.relayServicePrincipalA,
        workerServicePrincipalId: devFixtures.servicePrincipalA
      })
    );

    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: proofUrl,
          headers: {
            "x-throughline-dev-identity": "tenant-a-owner",
            [header]: "forged"
          },
          payload: validBody
        });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it.each(forbiddenAuthorityFields)("rejects caller authority field %s", async (field) => {
    const app = await createApp(
      FoundationProofModule.register({
        pool: {} as PgPool,
        authorization: {} as never,
        contextReferenceCodec: {} as never,
        relayServicePrincipalId: devFixtures.relayServicePrincipalA,
        workerServicePrincipalId: devFixtures.servicePrincipalA
      })
    );

    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: proofUrl,
          headers: { "x-throughline-dev-identity": "tenant-a-owner" },
          payload: { ...validBody, [field]: "forged" }
        });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("does not expose the proof route from the normal AppModule", async () => {
    const app = await createApp(AppModule);
    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: proofUrl,
          headers: { "x-throughline-dev-identity": "tenant-a-owner" },
          payload: validBody
        });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const maybeDescribeDatabase = ownerUrl && appUrl ? describe : describe.skip;

maybeDescribeDatabase("foundation proof PostgreSQL transaction", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let app: NestFastifyApplication;
  let previousEnvironment: EnvironmentSnapshot;

  beforeAll(async () => {
    if (!ownerUrl || !appUrl) throw new Error("Foundation proof database DSNs are required");
    previousEnvironment = captureEnvironment();
    enableFoundationTestEnvironment();
    try {
      ownerPool = createPgPool(ownerUrl);
      await applyMigrations(ownerPool, { reset: true });
      await provisionTestAppRole(ownerPool, appUrl);
      await seedWaveA2DeterministicData(ownerPool);
      appPool = createPgPool(appUrl);
      const codec = createAsyncContextReferenceCodec({
        verificationKeys: new Map([["task5", new Uint8Array(32).fill(7)]]),
        activeKeyId: "task5",
        clock: () => new Date()
      });
      app = await createApp(
        FoundationProofModule.register({
          pool: appPool,
          contextReferenceCodec: codec,
          relayServicePrincipalId: devFixtures.relayServicePrincipalA,
          workerServicePrincipalId: devFixtures.servicePrincipalA
        })
      );
    } catch (error) {
      restoreEnvironment(previousEnvironment);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
      await appPool?.end();
      if (ownerPool) await applyMigrations(ownerPool, { reset: true });
      await ownerPool?.end();
    } finally {
      restoreEnvironment(previousEnvironment);
    }
  });

  async function request(identity: string, requestId: string, body = validBody) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "POST",
        url: proofUrl,
        headers: {
          "x-throughline-dev-identity": identity,
          "x-request-id": requestId,
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01"
        },
        payload: body
      });
  }

  async function expectNoRows(requestId: string, proofKey: string) {
    const result = await ownerPool.query<{
      references: number;
      aggregates: number;
      outbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM ops.security_context_references
          WHERE context_snapshot ->> 'requestId' = $1) AS references,
         (SELECT count(*)::int FROM ops.foundation_test_aggregates
          WHERE proof_key = $2) AS aggregates,
         (SELECT count(*)::int FROM ops.outbox_events WHERE request_id = $1) AS outbox`,
      [requestId, proofKey]
    );
    expect(result.rows[0]).toEqual({ references: 0, aggregates: 0, outbox: 0 });
  }

  it("locks only the exact scoped app actor user for Foundation authorization", async () => {
    const context = createDevSecurityContext("tenant-a-owner");
    const lockedUsers = await withTenantTransaction({ pool: appPool, context }, async (tx) => {
      const self = await tx.query<{ id: string }>(
        "SELECT id FROM identity.users WHERE id = $1 FOR SHARE",
        [devFixtures.userA]
      );
      const other = await tx.query<{ id: string }>(
        "SELECT id FROM identity.users WHERE id = $1 FOR SHARE",
        [devFixtures.userB]
      );

      return { self: self.rows, other: other.rows };
    });

    expect(lockedUsers).toEqual({
      self: [{ id: devFixtures.userA }],
      other: []
    });
  });

  it.each([
    ["status", "UPDATE identity.users SET status = 'disabled' WHERE id = $1"],
    ["user data", "UPDATE identity.users SET primary_email = 'changed@example.com' WHERE id = $1"]
  ])("cannot update its own user %s despite lock visibility", async (_field, sql) => {
    const context = createDevSecurityContext("tenant-a-owner");

    await expect(
      withTenantTransaction({ pool: appPool, context }, (tx) => tx.query(sql, [devFixtures.userA]))
    ).rejects.toMatchObject({ code: "42501" });

    const persisted = await ownerPool.query<{ primary_email: string; status: string }>(
      "SELECT primary_email, status FROM identity.users WHERE id = $1",
      [devFixtures.userA]
    );
    expect(persisted.rows).toEqual([{ primary_email: "owner-a@example.com", status: "active" }]);
  });

  it("atomically writes the signed reference, aggregate, and exactly bound outbox event", async () => {
    const proofKey = `valid-${generateUuidV7()}`;
    const response = await request("tenant-a-owner", "task5-valid", {
      spaceId: devFixtures.restrictedSpaceA,
      proofKey
    });
    expect(response.statusCode, response.body).toBe(201);

    const result = await ownerPool.query<{
      reference_id: string;
      reference_job_id: string;
      outbox_reference_id: string;
      outbox_job_id: string;
      aggregate_pending_job_id: string;
      signed_context_reference: string;
    }>(
      `SELECT r.id AS reference_id, r.job_id AS reference_job_id,
              o.context_reference_id AS outbox_reference_id, o.job_id AS outbox_job_id,
              a.pending_job_id AS aggregate_pending_job_id, o.signed_context_reference
       FROM ops.security_context_references r
       JOIN ops.outbox_events o
         ON (o.context_reference_id, o.job_id, o.tenant_id, o.workspace_id, o.space_id) =
            (r.id, r.job_id, r.tenant_id, r.workspace_id, r.space_id)
       JOIN ops.foundation_test_aggregates a
         ON (a.tenant_id, a.workspace_id, a.space_id, a.id) =
            (o.tenant_id, o.workspace_id, o.space_id, o.aggregate_id)
       WHERE o.request_id = $1 AND a.proof_key = $2`,
      ["task5-valid", proofKey]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      outbox_reference_id: result.rows[0]?.reference_id,
      outbox_job_id: result.rows[0]?.reference_job_id,
      aggregate_pending_job_id: result.rows[0]?.reference_job_id
    });
    expect(result.rows[0]?.signed_context_reference).toMatch(/^tlctx\.v1\.hs256\.task5\./);
  });

  it("refuses an owner pool at the request/service boundary and leaves all writes absent", async () => {
    const ownerApp = await createApp(
      FoundationProofModule.register({
        pool: ownerPool,
        contextReferenceCodec: createAsyncContextReferenceCodec({
          verificationKeys: new Map([["task5-owner", new Uint8Array(32).fill(9)]]),
          activeKeyId: "task5-owner",
          clock: () => new Date()
        }),
        relayServicePrincipalId: devFixtures.relayServicePrincipalA,
        workerServicePrincipalId: devFixtures.servicePrincipalA
      })
    );
    const requestId = "task5-owner-pool-denied";
    const proofKey = `owner-pool-${generateUuidV7()}`;
    try {
      const response = await ownerApp
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: proofUrl,
          headers: {
            "x-throughline-dev-identity": "tenant-a-owner",
            "x-request-id": requestId
          },
          payload: { spaceId: devFixtures.restrictedSpaceA, proofKey }
        });

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(ownerUrl);
      expect(response.body).not.toContain(proofKey);
      await expectNoRows(requestId, proofKey);
    } finally {
      await ownerApp.close();
    }
  });

  it.each([
    ["wrong Space", "tenant-a-owner", generateUuidV7()],
    ["cross-workspace Space", "tenant-a-owner", devFixtures.rootSpaceB],
    ["cross-tenant Space", "tenant-b-viewer", devFixtures.restrictedSpaceA],
    ["service caller", "tenant-a-service", devFixtures.restrictedSpaceA],
    ["agent caller", "tenant-a-agent", devFixtures.restrictedSpaceA],
    ["lower-role caller", "tenant-a-viewer", devFixtures.restrictedSpaceA]
  ])("denies %s and leaves all three writes absent", async (label, identity, spaceId) => {
    const requestId = `task5-denied-${label.replaceAll(" ", "-")}`;
    const proofKey = `denied-${generateUuidV7()}`;
    const response = await request(identity, requestId, { spaceId, proofKey });
    expect(response.statusCode).toBe(403);
    await expectNoRows(requestId, proofKey);
  });

  it("denies an archived exact Space and leaves all three writes absent", async () => {
    const requestId = "task5-denied-archived-space";
    const proofKey = `denied-archived-${generateUuidV7()}`;
    await ownerPool.query(
      "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
      [devFixtures.restrictedChildSpaceA]
    );
    try {
      const response = await request("tenant-a-owner", requestId, {
        spaceId: devFixtures.restrictedChildSpaceA,
        proofKey
      });
      expect(response.statusCode).toBe(403);
      await expectNoRows(requestId, proofKey);
    } finally {
      await ownerPool.query("UPDATE access.spaces SET archived_at = NULL WHERE id = $1", [
        devFixtures.restrictedChildSpaceA
      ]);
    }
  });

  it("rolls back aggregate and outbox when reference insertion fails", async () => {
    await ownerPool.query(`
      CREATE OR REPLACE FUNCTION ops.task5_fail_reference() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced reference failure'; END $$;
      CREATE TRIGGER task5_fail_reference BEFORE INSERT ON ops.security_context_references
      FOR EACH ROW EXECUTE FUNCTION ops.task5_fail_reference();
    `);
    const proofKey = `reference-failure-${generateUuidV7()}`;
    try {
      const response = await request("tenant-a-owner", "task5-reference-failure", {
        spaceId: devFixtures.restrictedSpaceA,
        proofKey
      });
      expect(response.statusCode).toBe(500);
      await expectNoRows("task5-reference-failure", proofKey);
    } finally {
      await ownerPool.query("DROP TRIGGER task5_fail_reference ON ops.security_context_references");
      await ownerPool.query("DROP FUNCTION ops.task5_fail_reference() ");
    }
  });

  it("rolls back reference and aggregate when outbox insertion fails", async () => {
    await ownerPool.query(`
      CREATE OR REPLACE FUNCTION ops.task5_fail_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$;
      CREATE TRIGGER task5_fail_outbox BEFORE INSERT ON ops.outbox_events
      FOR EACH ROW EXECUTE FUNCTION ops.task5_fail_outbox();
    `);
    const proofKey = `outbox-failure-${generateUuidV7()}`;
    try {
      const response = await request("tenant-a-owner", "task5-outbox-failure", {
        spaceId: devFixtures.restrictedSpaceA,
        proofKey
      });
      expect(response.statusCode).toBe(500);
      await expectNoRows("task5-outbox-failure", proofKey);
    } finally {
      await ownerPool.query("DROP TRIGGER task5_fail_outbox ON ops.outbox_events");
      await ownerPool.query("DROP FUNCTION ops.task5_fail_outbox() ");
    }
  });
});

describe("foundation proof environment restoration", () => {
  it("restores the caller's sentinel values after every environment-owning suite", () => {
    expect(captureEnvironment()).toEqual(fileEnvironment);
  });
});
