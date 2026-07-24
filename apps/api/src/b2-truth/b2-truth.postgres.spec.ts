import "reflect-metadata";
import { createHash } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  provisionWorkspaceProductRelayPrincipal,
  seedWaveA2DeterministicData,
  type PgPool,
  type TenantDbTransaction
} from "@throughline/db";
import { devFixtures } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const authoritative = process.env.B2_AUTHORITATIVE_GATE === "1";
const suite = ownerUrl && appUrl ? describe.sequential : authoritative ? describe : describe.skip;

suite("B2 Slice 1 PostgreSQL API golden path", () => {
  if (!ownerUrl || !appUrl) {
    it("requires owner and app PostgreSQL DSNs in the authoritative gate", () => {
      throw new Error("TEST_DATABASE_URL and TEST_APP_DATABASE_URL are required");
    });
    return;
  }

  let ownerPool: PgPool;
  let appPool: PgPool;
  let app: NestFastifyApplication;
  let priorDatabaseUrl: string | undefined;
  let priorAuthAdapter: string | undefined;
  let organizationId: string;
  let initiativeId: string;
  let activityId: string;
  let sourceArtifactId: string;
  let claimId: string;
  let factId: string;

  beforeAll(async () => {
    ownerPool = createPgPool(ownerUrl);
    appPool = createPgPool(appUrl);
    await applyMigrations(ownerPool, { reset: true });
    await seedWaveA2DeterministicData(ownerPool);
    await provisionTestAppRole(ownerPool, appUrl);
    await ownerTransaction(ownerPool, async (tx) => {
      await provisionWorkspaceProductRelayPrincipal(tx, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA
      });
    });
    priorDatabaseUrl = process.env.DATABASE_URL;
    priorAuthAdapter = process.env.AUTH_ADAPTER;
    process.env.DATABASE_URL = appUrl;
    process.env.AUTH_ADAPTER = "dev";
    app = await createApi();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    restoreEnvironment("DATABASE_URL", priorDatabaseUrl);
    restoreEnvironment("AUTH_ADAPTER", priorAuthAdapter);
  });

  it("persists Source → Claim → Fact exactly once through authenticated APIs", async () => {
    const organization = await post("/v1/organizations", "b2-org", {
      name: "Unicode Harbor",
      domains: ["unicode-harbor.example"]
    });
    expect(organization.statusCode, organization.body).toBe(201);
    organizationId = organization.json<{ organizationId: string }>().organizationId;

    const initiative = await post("/v1/initiatives", "b2-initiative", {
      primaryOrganizationId: organizationId,
      organizationIds: [organizationId],
      title: "Trusted memory pilot",
      typeKey: "governance",
      stageKey: "exploring"
    });
    expect(initiative.statusCode, initiative.body).toBe(201);
    initiativeId = initiative.json<{ initiativeId: string }>().initiativeId;

    const activity = await post("/v1/activities", "b2-activity", {
      title: "Outcome review",
      profileTemplateKey: "ai_workshop",
      status: "captured",
      governingInitiativeId: initiativeId,
      organizationIds: [organizationId],
      initiativeIds: [initiativeId],
      attendeePersonIds: [devFixtures.externalPersonA]
    });
    expect(activity.statusCode, activity.body).toBe(201);
    activityId = activity.json<{ activityId: string }>().activityId;

    const sourceText = "Context before. Outcome 😀 agreed with the customer. Context after.";
    const source = await post(`/v1/activities/${activityId}/sources`, "b2-source", {
      sourceType: "transcript",
      title: "Outcome review transcript",
      text: sourceText
    });
    expect(source.statusCode, source.body).toBe(201);
    sourceArtifactId = source.json<{ sourceArtifactId: string }>().sourceArtifactId;
    const sourceRead = await get(`/v1/sources/${sourceArtifactId}`);
    expect(sourceRead.statusCode, sourceRead.body).toBe(200);
    const sourceSnapshot = sourceRead.json<{
      id: string;
      version: number;
      contentHash: string;
      normalizedContentHash: string;
      chunks: Array<{
        id: string;
        normalizedText: string;
        contentHash: string;
        normalizationVersion: "source-normalization.v1";
        chunkingVersion: "source-chunking.v1";
      }>;
    }>();
    const chunk = sourceSnapshot.chunks[0]!;
    const chunkScalars = Array.from(chunk.normalizedText);
    const excerptScalars = Array.from("😀 agreed");
    const startOffset = chunkScalars.indexOf("😀");
    expect(startOffset).toBeGreaterThan(0);
    const excerpt = chunkScalars.slice(startOffset, startOffset + excerptScalars.length).join("");
    expect(excerpt).toBe("😀 agreed");

    const sourceOnly = await ownerPool.query<{ claims: string; facts: string }>(
      `SELECT
         (SELECT count(*)::text FROM truth.claims) AS claims,
         (SELECT count(*)::text FROM truth.accepted_facts) AS facts`
    );
    expect(sourceOnly.rows[0]).toEqual({ claims: "0", facts: "0" });

    const claimPayload = {
      subject: { type: "activity", id: activityId, expectedVersion: 1 },
      predicate: "activity.outcome",
      valueJson: "Outcome agreed with the customer",
      normalizedText: "Outcome agreed with the customer",
      confidence: "strong",
      evidence: {
        sourceArtifactId,
        sourceChunkId: chunk.id,
        expectedSourceVersion: sourceSnapshot.version,
        expectedChunkVersion: 1,
        normalizationVersion: chunk.normalizationVersion,
        chunkingVersion: chunk.chunkingVersion,
        startOffset,
        endOffset: startOffset + excerptScalars.length,
        excerpt,
        sourceContentHash: sourceSnapshot.contentHash,
        sourceNormalizedContentHash: sourceSnapshot.normalizedContentHash,
        chunkContentHash: chunk.contentHash,
        excerptHash: sha256(excerpt)
      }
    };
    const unauthorizedClaim = await postAs(
      "tenant-a-viewer",
      "/internal/v1/claims",
      "b2-unauthorized-claim",
      claimPayload
    );
    const crossTenantClaim = await postAs(
      "tenant-b-viewer",
      "/internal/v1/claims",
      "b2-cross-tenant-claim",
      claimPayload
    );
    expect(unauthorizedClaim.statusCode).toBe(404);
    expect(crossTenantClaim.statusCode).toBe(404);
    const fabricated = await post("/internal/v1/claims", "b2-fabricated-evidence", {
      ...claimPayload,
      evidence: {
        ...claimPayload.evidence,
        excerpt: "😀 forged",
        excerptHash: sha256("😀 forged")
      }
    });
    expect(fabricated.statusCode).toBe(404);

    const staleSource = await post("/internal/v1/claims", "b2-stale-source", {
      ...claimPayload,
      evidence: {
        ...claimPayload.evidence,
        expectedSourceVersion: sourceSnapshot.version + 1
      }
    });
    expect(staleSource.statusCode).toBe(404);

    await ownerPool.query(
      `UPDATE identity.policy_versions
       SET status = 'retired'
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = 'default-v1'`,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    const stalePolicy = await post("/internal/v1/claims", "b2-stale-policy", claimPayload);
    await ownerPool.query(
      `UPDATE identity.policy_versions
       SET status = 'active'
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = 'default-v1'`,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    expect(stalePolicy.statusCode).toBe(404);

    await ownerPool.query(
      `UPDATE identity.memberships
       SET status = 'suspended'
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.membershipAOwner]
    );
    const staleMembership = await post("/internal/v1/claims", "b2-stale-membership", claimPayload);
    await ownerPool.query(
      `UPDATE identity.memberships
       SET status = 'active'
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.membershipAOwner]
    );
    expect(staleMembership.statusCode).toBe(404);

    const afterFabrication = await ownerPool.query<{ claims: string; commands: string }>(
      `SELECT
        (SELECT count(*)::text FROM truth.claims) AS claims,
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE command_kind = 'claim.create.v1') AS commands`
    );
    expect(afterFabrication.rows[0]).toEqual({ claims: "0", commands: "0" });

    const [claim, claimReplay] = await Promise.all([
      post("/internal/v1/claims", "b2-claim", claimPayload),
      post("/internal/v1/claims", "b2-claim", claimPayload)
    ]);
    expect(claim.statusCode, claim.body).toBe(201);
    expect(claimReplay.statusCode, claimReplay.body).toBe(201);
    expect(claimReplay.body).toBe(claim.body);
    expect(claim.json()).toMatchObject({ version: 1, status: "proposed" });
    claimId = claim.json<{ claimId: string }>().claimId;
    const claimMismatch = await post("/internal/v1/claims", "b2-claim", {
      ...claimPayload,
      confidence: "weak"
    });
    expect(claimMismatch.statusCode).toBe(409);

    const factPayload = {
      subject: { type: "activity", id: activityId, expectedVersion: 1 },
      claims: [{ claimId, expectedVersion: 1 }],
      expectedCurrentFactId: null,
      acceptanceScope: "engagement"
    };

    const unauthorizedFact = await postAs(
      "tenant-a-viewer",
      "/internal/v1/facts",
      "b2-unauthorized-fact",
      factPayload
    );
    const crossTenantFact = await postAs(
      "tenant-b-viewer",
      "/internal/v1/facts",
      "b2-cross-tenant-fact",
      factPayload
    );
    expect(unauthorizedFact.statusCode).toBe(404);
    expect(crossTenantFact.statusCode).toBe(404);

    await ownerPool.query(
      `UPDATE work.activities
       SET owner_person_id = $1
       WHERE tenant_id = $2 AND workspace_id = $3 AND id = $4`,
      [devFixtures.personBInTenantA, devFixtures.tenantA, devFixtures.workspaceA, activityId]
    );
    const staleAuthority = await post("/internal/v1/facts", "b2-stale-authority", factPayload);
    await ownerPool.query(
      `UPDATE work.activities
       SET owner_person_id = $1
       WHERE tenant_id = $2 AND workspace_id = $3 AND id = $4`,
      [devFixtures.personA, devFixtures.tenantA, devFixtures.workspaceA, activityId]
    );
    expect(staleAuthority.statusCode).toBe(404);
    const afterAuthorityDenial = await ownerPool.query<{
      facts: string;
      commands: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM truth.accepted_facts) AS facts,
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE command_kind = 'fact.accept.v1') AS commands`
    );
    expect(afterAuthorityDenial.rows[0]).toEqual({ facts: "0", commands: "0" });

    const [fact, factReplay] = await Promise.all([
      post("/internal/v1/facts", "b2-fact", factPayload),
      post("/internal/v1/facts", "b2-fact", factPayload)
    ]);
    expect(fact.statusCode, fact.body).toBe(201);
    expect(factReplay.statusCode, factReplay.body).toBe(201);
    expect(factReplay.body).toBe(fact.body);
    expect(fact.json()).toMatchObject({
      version: 1,
      status: "current",
      acceptedClaimIds: [claimId]
    });
    factId = fact.json<{ factId: string }>().factId;
    const staleFactAttempt = await post("/internal/v1/facts", "b2-stale-fact", factPayload);
    expect(staleFactAttempt.statusCode).toBe(409);

    const conflictingClaim = await post("/internal/v1/claims", "b2-conflicting-claim", {
      ...claimPayload,
      valueJson: "Outcome remains undecided",
      normalizedText: "Outcome remains undecided"
    });
    expect(conflictingClaim.statusCode, conflictingClaim.body).toBe(201);
    const conflictingClaimId = conflictingClaim.json<{ claimId: string }>().claimId;
    const deferredAcceptance = await post("/internal/v1/facts", "b2-deferred-acceptance", {
      ...factPayload,
      claims: [{ claimId: conflictingClaimId, expectedVersion: 1 }]
    });
    expect(deferredAcceptance.statusCode).toBe(409);
    const deferredResidue = await ownerPool.query<{
      claim_status: string;
      facts: string;
      commands: string;
      audits: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT status FROM truth.claims WHERE id = $1) AS claim_status,
        (SELECT count(*)::text FROM truth.accepted_facts
          WHERE subject_type = 'activity' AND subject_id = $2
            AND predicate = 'activity.outcome') AS facts,
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key = 'b2-deferred-acceptance') AS commands,
        (SELECT count(*)::text FROM ops.audit_events
          WHERE causation_command_id IN (
            SELECT id FROM ops.domain_command_records
            WHERE idempotency_key = 'b2-deferred-acceptance'
          )) AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events
          WHERE causation_command_id IN (
            SELECT id FROM ops.domain_command_records
            WHERE idempotency_key = 'b2-deferred-acceptance'
          )) AS outbox`,
      [conflictingClaimId, activityId]
    );
    expect(deferredResidue.rows[0]).toEqual({
      claim_status: "proposed",
      facts: "1",
      commands: "0",
      audits: "0",
      outbox: "0"
    });

    const counts = await ownerPool.query<{
      claims: string;
      facts: string;
      audits: string;
      outbox: string;
      truthCommands: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM truth.claims WHERE id = $1) AS claims,
        (SELECT count(*)::text FROM truth.accepted_facts WHERE id = $2) AS facts,
        (SELECT count(*)::text FROM ops.audit_events
          WHERE action IN ('claim.create','fact.accept')
            AND resource_id IN ($1,$2)) AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events
          WHERE event_type IN ('claim.proposed','fact.accepted')
            AND aggregate_id IN ($1,$2)) AS outbox,
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE command_kind IN ('claim.create.v1','fact.accept.v1')) AS "truthCommands"`,
      [claimId, factId]
    );
    expect(counts.rows[0]).toEqual({
      claims: "1",
      facts: "1",
      audits: "2",
      outbox: "2",
      truthCommands: "3"
    });
    const safeAppendOnlyMetadata = await ownerPool.query<{
      audit_detail: object;
      outbox_payload: object;
    }>(
      `SELECT audit.safe_detail AS audit_detail, outbox.payload AS outbox_payload
       FROM ops.audit_events audit
       JOIN ops.product_outbox_events outbox
         ON outbox.tenant_id = audit.tenant_id
        AND outbox.workspace_id = audit.workspace_id
        AND outbox.causation_command_id = audit.causation_command_id
       WHERE audit.resource_id = ANY($1::uuid[])
       ORDER BY audit.action`,
      [[claimId, factId]]
    );
    expect(safeAppendOnlyMetadata.rows).toEqual([
      {
        audit_detail: { claimId, evidenceSpanId: expect.any(String) },
        outbox_payload: { claimId, evidenceSpanId: expect.any(String) }
      },
      {
        audit_detail: { factId },
        outbox_payload: { factId }
      }
    ]);
  }, 60_000);

  it("retains inspectable durable lineage after a new Nest instance", async () => {
    await app.close();
    app = await createApi();

    const lineage = await ownerPool.query<{
      fact_id: string;
      fact_status: string;
      fact_version: number;
      fact_confidence: string;
      fact_access_class: string;
      claim_id: string;
      claim_status: string;
      claim_version: number;
      claim_confidence: string;
      claim_access_class: string;
      source_artifact_id: string;
      source_excerpt: string;
      evidence_access_class: string;
      fact_confidence_rule: string;
      fact_strongest_confidence: string;
      fact_human_lowered: boolean;
      fact_lowering_reason: string | null;
      fact_lowering_rationale: string | null;
      audits: string;
      outbox: string;
    }>(
      `SELECT fact.id AS fact_id, fact.status AS fact_status, fact.version AS fact_version,
         fact.confidence AS fact_confidence, fact.access_class AS fact_access_class,
         claim.id AS claim_id, claim.status AS claim_status, claim.version AS claim_version,
         claim.confidence AS claim_confidence, claim.access_class AS claim_access_class,
         evidence.source_artifact_id, evidence.source_excerpt,
         evidence.access_class AS evidence_access_class,
         fact.confidence_rule AS fact_confidence_rule,
         fact.strongest_supporting_confidence AS fact_strongest_confidence,
         fact.human_lowered AS fact_human_lowered,
         fact.confidence_lowering_reason_code AS fact_lowering_reason,
         fact.confidence_lowering_rationale AS fact_lowering_rationale,
         (SELECT count(*)::text FROM ops.audit_events audit
           WHERE audit.action = 'fact.accept' AND audit.resource_id = fact.id) AS audits,
         (SELECT count(*)::text FROM ops.product_outbox_events event
           WHERE event.event_type = 'fact.accepted'
             AND event.aggregate_id = fact.id) AS outbox
       FROM truth.accepted_facts fact
       JOIN truth.fact_claims support
         ON support.tenant_id = fact.tenant_id
        AND support.workspace_id = fact.workspace_id
        AND support.fact_id = fact.id
       JOIN truth.claims claim
         ON claim.tenant_id = support.tenant_id
        AND claim.workspace_id = support.workspace_id
        AND claim.id = support.claim_id
       JOIN truth.verified_evidence_spans evidence
         ON evidence.tenant_id = claim.tenant_id
        AND evidence.workspace_id = claim.workspace_id
        AND evidence.id = claim.verified_evidence_span_id
       WHERE fact.id = $1 AND claim.id = $2`,
      [factId, claimId]
    );
    expect(lineage.rows).toEqual([
      {
        fact_id: factId,
        fact_status: "current",
        fact_version: 1,
        fact_confidence: "strong",
        fact_access_class: "workspace",
        claim_id: claimId,
        claim_status: "accepted",
        claim_version: 2,
        claim_confidence: "strong",
        claim_access_class: "workspace",
        source_artifact_id: sourceArtifactId,
        source_excerpt: "😀 agreed",
        evidence_access_class: "workspace",
        fact_confidence_rule: "strongest-selected-valid-claim.v1",
        fact_strongest_confidence: "strong",
        fact_human_lowered: false,
        fact_lowering_reason: null,
        fact_lowering_rationale: null,
        audits: "1",
        outbox: "1"
      }
    ]);
  }, 60_000);

  it("persists human confidence lowering on the AcceptedFact", async () => {
    const activity = await post("/v1/activities", "b2-lowered-activity", {
      title: "Confidence review",
      profileTemplateKey: "ai_workshop",
      status: "captured",
      governingInitiativeId: initiativeId,
      organizationIds: [organizationId],
      initiativeIds: [initiativeId],
      attendeePersonIds: [devFixtures.externalPersonA]
    });
    expect(activity.statusCode, activity.body).toBe(201);
    const loweredActivityId = activity.json<{ activityId: string }>().activityId;
    const sourceText = "Confidence should be lowered despite strong source support.";
    const source = await post(`/v1/activities/${loweredActivityId}/sources`, "b2-lowered-source", {
      sourceType: "note",
      title: "Confidence evidence",
      text: sourceText
    });
    expect(source.statusCode, source.body).toBe(201);
    const loweredSourceId = source.json<{ sourceArtifactId: string }>().sourceArtifactId;
    const sourceRead = await get(`/v1/sources/${loweredSourceId}`);
    expect(sourceRead.statusCode, sourceRead.body).toBe(200);
    const snapshot = sourceRead.json<{
      version: number;
      contentHash: string;
      normalizedContentHash: string;
      chunks: Array<{
        id: string;
        normalizedText: string;
        contentHash: string;
        normalizationVersion: "source-normalization.v1";
        chunkingVersion: "source-chunking.v1";
      }>;
    }>();
    const chunk = snapshot.chunks[0]!;
    const excerpt = "Confidence should be lowered";
    const claim = await post("/internal/v1/claims", "b2-lowered-claim", {
      subject: { type: "activity", id: loweredActivityId, expectedVersion: 1 },
      predicate: "activity.outcome",
      valueJson: "Confidence reviewed",
      normalizedText: "Confidence reviewed",
      confidence: "strong",
      evidence: {
        sourceArtifactId: loweredSourceId,
        sourceChunkId: chunk.id,
        expectedSourceVersion: snapshot.version,
        expectedChunkVersion: 1,
        normalizationVersion: chunk.normalizationVersion,
        chunkingVersion: chunk.chunkingVersion,
        startOffset: 0,
        endOffset: Array.from(excerpt).length,
        excerpt,
        sourceContentHash: snapshot.contentHash,
        sourceNormalizedContentHash: snapshot.normalizedContentHash,
        chunkContentHash: chunk.contentHash,
        excerptHash: sha256(excerpt)
      }
    });
    expect(claim.statusCode, claim.body).toBe(201);
    const loweredClaimId = claim.json<{ claimId: string }>().claimId;
    const loweringRationale = "Residual uncertainty remains after review.";
    const fact = await post("/internal/v1/facts", "b2-lowered-fact", {
      subject: { type: "activity", id: loweredActivityId, expectedVersion: 1 },
      claims: [{ claimId: loweredClaimId, expectedVersion: 1 }],
      expectedCurrentFactId: null,
      acceptanceScope: "engagement",
      confidenceLowering: {
        confidence: "weak",
        reason: {
          code: "residual_uncertainty",
          rationale: loweringRationale
        }
      }
    });
    expect(fact.statusCode, fact.body).toBe(201);
    const loweredFactId = fact.json<{ factId: string }>().factId;
    const persisted = await ownerPool.query<{
      confidence: string;
      confidence_rule: string;
      strongest_supporting_confidence: string;
      human_lowered: boolean;
      confidence_lowering_reason_code: string;
      confidence_lowering_rationale: string;
    }>(
      `SELECT confidence, confidence_rule, strongest_supporting_confidence,
              human_lowered, confidence_lowering_reason_code,
              confidence_lowering_rationale
         FROM truth.accepted_facts
        WHERE id = $1`,
      [loweredFactId]
    );
    expect(persisted.rows).toEqual([
      {
        confidence: "weak",
        confidence_rule: "strongest-selected-valid-claim.v1",
        strongest_supporting_confidence: "strong",
        human_lowered: true,
        confidence_lowering_reason_code: "residual_uncertainty",
        confidence_lowering_rationale: loweringRationale
      }
    ]);
  }, 60_000);

  it("exposes no Fact read or current-truth route", async () => {
    for (const url of [
      `/v1/facts/${factId}`,
      `/internal/v1/facts/${factId}`,
      `/v1/current-truth/${activityId}`
    ]) {
      const response = await get(url);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(factId);
      expect(response.body).not.toContain(claimId);
    }
  });

  async function postAs(
    identity: "tenant-a-owner" | "tenant-a-viewer" | "tenant-b-viewer",
    url: string,
    idempotencyKey: string,
    payload: object
  ) {
    return app.inject({
      method: "POST",
      url,
      headers: requestHeaders(identity, idempotencyKey, idempotencyKey),
      payload
    });
  }

  async function post(url: string, idempotencyKey: string, payload: object) {
    return postAs("tenant-a-owner", url, idempotencyKey, payload);
  }

  async function get(url: string) {
    return getAs("tenant-a-owner", url);
  }

  async function getAs(identity: "tenant-a-owner" | "tenant-b-viewer", url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: requestHeaders(identity, `get-${url}`.slice(0, 190))
    });
  }
});

async function createApi(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false })
  );
  await app.init();
  return app;
}

function requestHeaders(identity: string, requestId: string, idempotencyKey?: string) {
  return {
    "content-type": "application/json",
    "x-throughline-dev-identity": identity,
    "x-request-id": requestId,
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey })
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function ownerTransaction(
  pool: PgPool,
  callback: (tx: TenantDbTransaction) => Promise<void>
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await callback({
      client,
      query: (sql, values) => client.query(sql, values ? [...values] : undefined)
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
