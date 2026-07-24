import "reflect-metadata";
import { createHash } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AccountOperationsDomainCommandBus } from "@throughline/account-operations";
import { PostgresAuthorizationService } from "@throughline/authorization";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  provisionWorkspaceProductRelayPrincipal,
  seedWaveA2DeterministicData,
  type PgPool,
  type TenantDbTransaction
} from "@throughline/db";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
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
      lifecycle: string;
      audits: string;
      outbox: string;
      truthCommands: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM truth.claims WHERE id = $1) AS claims,
        (SELECT count(*)::text FROM truth.accepted_facts WHERE id = $2) AS facts,
        (SELECT count(*)::text FROM truth.fact_lifecycle_events WHERE fact_id = $2) AS lifecycle,
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
      lifecycle: "1",
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
      lifecycle_event_type: string;
      lifecycle_confidence: string;
      lifecycle_strongest_confidence: string;
      lifecycle_human_lowered: boolean;
      audits: string;
      outbox: string;
    }>(
      `SELECT fact.id AS fact_id, fact.status AS fact_status, fact.version AS fact_version,
         fact.confidence AS fact_confidence, fact.access_class AS fact_access_class,
         claim.id AS claim_id, claim.status AS claim_status, claim.version AS claim_version,
         claim.confidence AS claim_confidence, claim.access_class AS claim_access_class,
         evidence.source_artifact_id, evidence.source_excerpt,
         evidence.access_class AS evidence_access_class,
         lifecycle.event_type AS lifecycle_event_type,
         lifecycle.confidence AS lifecycle_confidence,
         lifecycle.strongest_supporting_confidence AS lifecycle_strongest_confidence,
         lifecycle.human_lowered AS lifecycle_human_lowered,
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
       JOIN truth.fact_lifecycle_events lifecycle
         ON lifecycle.tenant_id = fact.tenant_id
        AND lifecycle.workspace_id = fact.workspace_id
        AND lifecycle.fact_id = fact.id
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
        lifecycle_event_type: "fact.accepted",
        lifecycle_confidence: "strong",
        lifecycle_strongest_confidence: "strong",
        lifecycle_human_lowered: false,
        audits: "1",
        outbox: "1"
      }
    ]);
  }, 60_000);

  it("redacts retained source content through the canonical tombstone transaction", async () => {
    const result = await new AccountOperationsDomainCommandBus(
      appPool,
      new PostgresAuthorizationService(appPool)
    ).execute(
      {
        kind: "source.tombstone",
        idempotencyKey: "b2-retain-tombstone",
        payload: {
          sourceArtifactId,
          expectedVersion: 1,
          deletionReasonCategory: "retention",
          deletionPolicyRef: "policy:b2-retain-test"
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    expect(result).toMatchObject({ version: 2, hashDisposition: "retained" });

    const redacted = await ownerPool.query<{
      source_text: string | null;
      source_hash: string | null;
      chunks: string;
      evidence_excerpt: string | null;
      evidence_hash: string | null;
      evidence_disposition: string;
      claim_value: string | null;
      claim_hash: string | null;
      claim_status: string;
      claim_version: number;
      fact_value: string | null;
      fact_hash: string | null;
      fact_status: string;
      fact_version: number;
    }>(
      `SELECT source.immutable_text AS source_text, source.content_hash AS source_hash,
         (SELECT count(*)::text FROM content.source_chunks chunk
           WHERE chunk.source_artifact_id = source.id) AS chunks,
         evidence.source_excerpt AS evidence_excerpt,
         evidence.excerpt_hash AS evidence_hash,
         evidence.hash_disposition AS evidence_disposition,
         claim.normalized_text AS claim_value, claim.value_hash AS claim_hash,
         claim.status AS claim_status, claim.version AS claim_version,
         fact.normalized_text AS fact_value, fact.value_hash AS fact_hash,
         fact.status AS fact_status, fact.version AS fact_version
       FROM content.source_artifacts source
       JOIN truth.verified_evidence_spans evidence
         ON evidence.tenant_id = source.tenant_id
        AND evidence.workspace_id = source.workspace_id
        AND evidence.source_artifact_id = source.id
       JOIN truth.claims claim
         ON claim.tenant_id = evidence.tenant_id
        AND claim.workspace_id = evidence.workspace_id
        AND claim.verified_evidence_span_id = evidence.id
       JOIN truth.fact_claims support
         ON support.tenant_id = claim.tenant_id
        AND support.workspace_id = claim.workspace_id
        AND support.claim_id = claim.id
       JOIN truth.accepted_facts fact
         ON fact.tenant_id = support.tenant_id
        AND fact.workspace_id = support.workspace_id
        AND fact.id = support.fact_id
       WHERE source.id = $1 AND claim.id = $2 AND fact.id = $3`,
      [sourceArtifactId, claimId, factId]
    );
    expect(redacted.rows).toEqual([
      {
        source_text: null,
        source_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        chunks: "0",
        evidence_excerpt: null,
        evidence_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        evidence_disposition: "retained",
        claim_value: null,
        claim_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        claim_status: "rejected",
        claim_version: 3,
        fact_value: null,
        fact_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        fact_status: "revoked",
        fact_version: 2
      }
    ]);
    const protectedMetadata = await ownerPool.query<{ disclosures: string }>(
      `SELECT (
         (SELECT count(*) FROM ops.audit_events
           WHERE safe_detail::text LIKE '%Outcome agreed with the customer%')
         +
         (SELECT count(*) FROM ops.product_outbox_events
           WHERE payload::text LIKE '%Outcome agreed with the customer%')
       )::text AS disclosures`
    );
    expect(protectedMetadata.rows[0]).toEqual({ disclosures: "0" });
  }, 60_000);

  it("cryptographically erases source, evidence, Claim, and Fact hashes", async () => {
    await ownerPool.query(
      `UPDATE identity.workspaces SET retention_policy_id = 'erase_on_tombstone:b2-test'
       WHERE tenant_id = $1 AND id = $2`,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    const activity = await post("/v1/activities", "b2-erase-activity", {
      title: "Erasure proof",
      profileTemplateKey: "ai_workshop",
      status: "captured",
      governingInitiativeId: initiativeId,
      organizationIds: [organizationId],
      initiativeIds: [initiativeId],
      attendeePersonIds: [devFixtures.externalPersonA]
    });
    expect(activity.statusCode, activity.body).toBe(201);
    const eraseActivityId = activity.json<{ activityId: string }>().activityId;
    const erasedText = "Erase me exactly after acceptance.";
    const source = await post(`/v1/activities/${eraseActivityId}/sources`, "b2-erase-source", {
      sourceType: "note",
      title: "Erasure evidence",
      text: erasedText
    });
    expect(source.statusCode, source.body).toBe(201);
    const eraseSourceId = source.json<{ sourceArtifactId: string }>().sourceArtifactId;
    const sourceRead = await get(`/v1/sources/${eraseSourceId}`);
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
    const excerpt = "Erase me exactly";
    const claim = await post("/internal/v1/claims", "b2-erase-claim", {
      subject: { type: "activity", id: eraseActivityId, expectedVersion: 1 },
      predicate: "activity.outcome",
      valueJson: "Erase accepted truth",
      normalizedText: "Erase accepted truth",
      confidence: "strong",
      evidence: {
        sourceArtifactId: eraseSourceId,
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
    const eraseClaimId = claim.json<{ claimId: string }>().claimId;
    const fact = await post("/internal/v1/facts", "b2-erase-fact", {
      subject: { type: "activity", id: eraseActivityId, expectedVersion: 1 },
      claims: [{ claimId: eraseClaimId, expectedVersion: 1 }],
      expectedCurrentFactId: null,
      acceptanceScope: "engagement",
      confidenceLowering: {
        confidence: "weak",
        reason: {
          code: "residual_uncertainty",
          rationale: erasedText
        }
      }
    });
    expect(fact.statusCode, fact.body).toBe(201);
    const eraseFactId = fact.json<{ factId: string }>().factId;
    await ownerPool.query(
      `UPDATE identity.workspaces SET retention_policy_id = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    const erased = await new AccountOperationsDomainCommandBus(
      appPool,
      new PostgresAuthorizationService(appPool)
    ).execute(
      {
        kind: "source.tombstone",
        idempotencyKey: "b2-erase-tombstone",
        payload: {
          sourceArtifactId: eraseSourceId,
          expectedVersion: 1,
          deletionReasonCategory: "lawful-erasure",
          deletionPolicyRef: "policy:b2-erasure-test"
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    expect(erased).toMatchObject({ version: 2, hashDisposition: "erased" });

    const state = await ownerPool.query<{
      source_text: string | null;
      source_hash: string | null;
      chunks: string;
      evidence_excerpt: string | null;
      evidence_hash: string | null;
      claim_value: string | null;
      claim_hash: string | null;
      claim_status: string;
      fact_value: string | null;
      fact_hash: string | null;
      fact_status: string;
      lifecycle_rationale: string | null;
      lifecycle_redacted_at: Date | null;
      disclosures: string;
    }>(
      `SELECT source.immutable_text AS source_text, source.content_hash AS source_hash,
         (SELECT count(*)::text FROM content.source_chunks chunk
           WHERE chunk.source_artifact_id = source.id) AS chunks,
         evidence.source_excerpt AS evidence_excerpt,
         evidence.excerpt_hash AS evidence_hash,
         claim.normalized_text AS claim_value, claim.value_hash AS claim_hash,
         claim.status AS claim_status,
         fact.normalized_text AS fact_value, fact.value_hash AS fact_hash,
         fact.status AS fact_status,
         lifecycle.confidence_lowering_rationale AS lifecycle_rationale,
         lifecycle.redacted_at AS lifecycle_redacted_at,
         (
           (SELECT count(*) FROM ops.audit_events
             WHERE safe_detail::text LIKE '%' || $4 || '%')
           +
           (SELECT count(*) FROM ops.product_outbox_events
             WHERE payload::text LIKE '%' || $4 || '%')
         )::text AS disclosures
       FROM content.source_artifacts source
       JOIN truth.verified_evidence_spans evidence
         ON evidence.tenant_id = source.tenant_id
        AND evidence.workspace_id = source.workspace_id
        AND evidence.source_artifact_id = source.id
       JOIN truth.claims claim
         ON claim.tenant_id = evidence.tenant_id
        AND claim.workspace_id = evidence.workspace_id
        AND claim.verified_evidence_span_id = evidence.id
       JOIN truth.fact_claims support
         ON support.tenant_id = claim.tenant_id
        AND support.workspace_id = claim.workspace_id
        AND support.claim_id = claim.id
       JOIN truth.accepted_facts fact
         ON fact.tenant_id = support.tenant_id
        AND fact.workspace_id = support.workspace_id
        AND fact.id = support.fact_id
       JOIN truth.fact_lifecycle_events lifecycle
         ON lifecycle.tenant_id = fact.tenant_id
        AND lifecycle.workspace_id = fact.workspace_id
        AND lifecycle.fact_id = fact.id
       WHERE source.id = $1 AND claim.id = $2 AND fact.id = $3`,
      [eraseSourceId, eraseClaimId, eraseFactId, erasedText]
    );
    expect(state.rows).toEqual([
      {
        source_text: null,
        source_hash: null,
        chunks: "0",
        evidence_excerpt: null,
        evidence_hash: null,
        claim_value: null,
        claim_hash: null,
        claim_status: "rejected",
        fact_value: null,
        fact_hash: null,
        fact_status: "revoked",
        lifecycle_rationale: null,
        lifecycle_redacted_at: expect.any(Date),
        disclosures: "0"
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
