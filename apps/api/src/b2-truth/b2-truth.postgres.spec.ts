import "reflect-metadata";
import { createHash } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  AccountOperationsDomainCommandBus,
  B1CommandInvariantError
} from "@throughline/account-operations";
import {
  applyMigrations,
  createPgPool,
  provisionTestAppRole,
  provisionWorkspaceProductRelayPrincipal,
  seedWaveA2DeterministicData,
  withTenantTransaction,
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

  it("rejects correction and retained-hash tombstone generically and rolls back every row", async () => {
    const bus = new AccountOperationsDomainCommandBus(appPool);
    const context = createDevSecurityContext("tenant-a-owner");
    const keys = ["b2-dependent-correction", "b2-dependent-retained-tombstone"];
    const before = await lifecycleSnapshot(ownerPool, sourceArtifactId, keys);

    const correctionError = await captureError(
      bus.execute(
        {
          kind: "source.correct",
          idempotencyKey: keys[0]!,
          payload: {
            predecessorSourceArtifactId: sourceArtifactId,
            sourceType: "transcript",
            text: "A correction cannot outrun dependent truth."
          }
        },
        context
      )
    );
    const tombstoneError = await captureError(
      bus.execute(
        {
          kind: "source.tombstone",
          idempotencyKey: keys[1]!,
          payload: {
            sourceArtifactId,
            expectedVersion: 1,
            deletionReasonCategory: "retention",
            deletionPolicyRef: "policy:b2-retained"
          }
        },
        context
      )
    );

    for (const error of [correctionError, tombstoneError]) {
      expect(error).toBeInstanceOf(B1CommandInvariantError);
      expect({ name: error.name, message: error.message }).toEqual({
        name: "B1CommandInvariantError",
        message: "B1 command transaction invariant failed"
      });
      expect(error.message).not.toContain(sourceArtifactId);
      expect(error.message).not.toMatch(/claim|fact|evidence/i);
    }

    const hiddenTruthContext = {
      ...context,
      requestId: "b2-hidden-truth-lifecycle",
      requestedSpaceIds: [String(before.source?.space_id)],
      dataClassCeiling: "public" as const
    };
    const hiddenError = await captureError(
      withTenantTransaction({ pool: appPool, context: hiddenTruthContext }, async (tx) => {
        const hidden = await tx.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM truth.verified_evidence_spans
            WHERE source_artifact_id = $1`,
          [sourceArtifactId]
        );
        expect(hidden.rows[0]?.count).toBe("0");
        await tx.query(
          `UPDATE content.source_artifacts
              SET immutable_text = NULL,
                  content_hash = content_hash,
                  normalized_content_hash = normalized_content_hash,
                  deleted_at = clock_timestamp(),
                  deletion_reason = 'retention',
                  deletion_policy_ref = 'policy:b2-hidden',
                  hash_disposition = 'retained',
                  version = version + 1,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
          [context.tenantId, context.workspaceId, sourceArtifactId]
        );
      })
    );
    expect(hiddenError.message).toBe("Source lifecycle transition is unavailable");
    expect((hiddenError as Error & { code?: string }).code).toBe("TLB21");
    expect(hiddenError.message).not.toMatch(/claim|fact|evidence/i);
    expect(await lifecycleSnapshot(ownerPool, sourceArtifactId, keys)).toEqual(before);

    const appVisible = await withTenantTransaction({ pool: appPool, context }, async (tx) => {
      const result = await tx.query<{
        source_version: number;
        deleted_at: Date | null;
        chunks: string;
        current_facts: string;
      }>(
        `SELECT source.version AS source_version, source.deleted_at,
                  (SELECT count(*)::text FROM content.source_chunks chunk
                    WHERE chunk.tenant_id = source.tenant_id
                      AND chunk.workspace_id = source.workspace_id
                      AND chunk.source_artifact_id = source.id) AS chunks,
                  (SELECT count(*)::text
                     FROM truth.verified_evidence_spans evidence
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
                    WHERE evidence.source_artifact_id = source.id
                      AND fact.status = 'current') AS current_facts
             FROM content.source_artifacts source
            WHERE source.tenant_id = $1 AND source.workspace_id = $2 AND source.id = $3`,
        [context.tenantId, context.workspaceId, sourceArtifactId]
      );
      return result.rows[0];
    });
    expect(appVisible).toEqual({
      source_version: 1,
      deleted_at: null,
      chunks: "1",
      current_facts: "1"
    });
  }, 60_000);

  it("rejects erased-hash tombstone without pretending erasure completed", async () => {
    await ownerPool.query(
      `UPDATE identity.workspaces
          SET retention_policy_id = 'erase_on_tombstone:b2'
        WHERE tenant_id = $1 AND id = $2`,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    try {
      const dependent = await createProposedClaimSource(
        "b2-erased",
        "Erasure must remain atomic while trusted memory depends on this source."
      );
      const accepted = await post("/internal/v1/facts", "b2-erased-fact", dependent.factPayload);
      expect(accepted.statusCode, accepted.body).toBe(201);
      const keys = ["b2-dependent-erased-tombstone"];
      const before = await lifecycleSnapshot(ownerPool, dependent.sourceArtifactId, keys);

      const error = await captureError(
        new AccountOperationsDomainCommandBus(appPool).execute(
          {
            kind: "source.tombstone",
            idempotencyKey: keys[0]!,
            payload: {
              sourceArtifactId: dependent.sourceArtifactId,
              expectedVersion: 1,
              deletionReasonCategory: "lawful_erasure",
              deletionPolicyRef: "policy:b2-erased"
            }
          },
          createDevSecurityContext("tenant-a-owner")
        )
      );
      expect(error).toBeInstanceOf(B1CommandInvariantError);
      expect(await lifecycleSnapshot(ownerPool, dependent.sourceArtifactId, keys)).toEqual(before);
      expect(before.source).toMatchObject({
        version: 1,
        deleted_at: null,
        hash_retention_policy: "erase_on_tombstone",
        hash_disposition: null,
        immutable_text: expect.any(String),
        content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        normalized_content_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    } finally {
      await ownerPool.query(
        `UPDATE identity.workspaces
            SET retention_policy_id = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [devFixtures.tenantA, devFixtures.workspaceA]
      );
    }
  }, 60_000);

  it("rejects direct app-role truth and lifecycle writes at REPEATABLE READ without residue", async () => {
    const context = createDevSecurityContext("tenant-a-owner");
    const before = await lifecycleSnapshot(ownerPool, sourceArtifactId, []);
    const client = await appPool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await setRawAppContext(client, context, String(before.source?.space_id));
      const truthError = await captureError(
        client.query(
          `INSERT INTO truth.verified_evidence_spans
           SELECT '0190a000-0000-7000-8000-000000000451', tenant_id, workspace_id,
                  space_id, source_artifact_id, source_chunk_id, source_version,
                  chunk_version, normalization_version, chunking_version,
                  source_start_offset, source_end_offset, source_excerpt,
                  source_content_hash, source_normalized_content_hash, chunk_content_hash,
                  excerpt_hash, access_class, created_by_user_id,
                  created_by_membership_id, causation_command_id,
                  clock_timestamp(), clock_timestamp(), 1
             FROM truth.verified_evidence_spans
            WHERE source_artifact_id = $1
            LIMIT 1`,
          [sourceArtifactId]
        )
      );
      expect({
        code: (truthError as Error & { code?: string }).code,
        message: truthError.message
      }).toEqual({
        code: "TLB22",
        message: "Truth mutation transaction is unavailable"
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await setRawAppContext(client, context, String(before.source?.space_id));
      const lifecycleError = await captureError(
        client.query(
          `UPDATE content.source_artifacts
              SET immutable_text = NULL, deleted_at = clock_timestamp(),
                  deletion_reason = 'retention', deletion_policy_ref = 'policy:b2-rr',
                  hash_disposition = 'retained', version = 2,
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [sourceArtifactId]
        )
      );
      expect({
        code: (lifecycleError as Error & { code?: string }).code,
        message: lifecycleError.message
      }).toEqual({
        code: "TLB22",
        message: "Truth mutation transaction is unavailable"
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await lifecycleSnapshot(ownerPool, sourceArtifactId, [])).toEqual(before);
  }, 60_000);

  it("blocks app-role chunk deletion when a tombstoned fixture has dependent evidence", async () => {
    const dependent = await createProposedClaimSource(
      "b2-chunk-delete-interlock",
      "Dependent evidence must survive every chunk deletion ordering."
    );
    await ownerTransaction(ownerPool, async (tx) => {
      await tx.query(
        `ALTER TABLE content.source_artifacts
           DISABLE TRIGGER source_artifacts_z_b2_tombstone_interlock,
           DISABLE TRIGGER source_artifacts_chunks_deferred`
      );
      await tx.query(
        `UPDATE content.source_artifacts
            SET immutable_text = NULL, deleted_at = clock_timestamp(),
                deletion_reason = 'retention', deletion_policy_ref = 'policy:b2-fixture',
                hash_disposition = 'retained', version = 2,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [dependent.sourceArtifactId]
      );
      await tx.query(
        `ALTER TABLE content.source_artifacts
           ENABLE TRIGGER source_artifacts_chunks_deferred,
           ENABLE TRIGGER source_artifacts_z_b2_tombstone_interlock`
      );
    });
    const triggerState = await ownerPool.query<{ name: string; enabled: string }>(
      `SELECT tgname AS name, tgenabled::text AS enabled
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY($1::text[])
        ORDER BY tgname`,
      [
        [
          "source_artifacts_chunks_deferred",
          "source_artifacts_z_b2_tombstone_interlock",
          "source_chunks_z_b2_delete_interlock"
        ]
      ]
    );
    expect(triggerState.rows).toEqual([
      { name: "source_artifacts_chunks_deferred", enabled: "O" },
      { name: "source_artifacts_z_b2_tombstone_interlock", enabled: "O" },
      { name: "source_chunks_z_b2_delete_interlock", enabled: "O" }
    ]);
    const source = await ownerPool.query<{ space_id: string }>(
      "SELECT space_id FROM content.source_artifacts WHERE id = $1",
      [dependent.sourceArtifactId]
    );
    const context = {
      ...createDevSecurityContext("tenant-a-owner"),
      requestedSpaceIds: [source.rows[0]!.space_id]
    };
    const before = await lifecycleSnapshot(ownerPool, dependent.sourceArtifactId, []);
    const error = await captureError(
      withTenantTransaction({ pool: appPool, context }, async (tx) => {
        const visible = await tx.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM truth.verified_evidence_spans
            WHERE source_artifact_id = $1`,
          [dependent.sourceArtifactId]
        );
        expect(visible.rows[0]?.count).toBe("1");
        await tx.query("DELETE FROM content.source_chunks WHERE source_artifact_id = $1", [
          dependent.sourceArtifactId
        ]);
      })
    );
    expect({ code: (error as Error & { code?: string }).code, message: error.message }).toEqual({
      code: "TLB21",
      message: "Source lifecycle transition is unavailable"
    });
    expect(await lifecycleSnapshot(ownerPool, dependent.sourceArtifactId, [])).toEqual(before);
  }, 60_000);

  it.each(["claim_first", "delete_first"] as const)(
    "serializes app-role chunk DELETE versus Claim admission with deterministic %s order",
    async (lockOrder) => {
      const key = `b2-chunk-claim-race-${lockOrder}`;
      const pending = await createClaimCandidateSource(
        key,
        "The B2 source/chunk interlock must independently prevent stale evidence admission."
      );
      const claimKey = `${key}-claim`;
      const context = createDevSecurityContext("tenant-a-owner");
      const sourceScope = await ownerPool.query<{ space_id: string }>(
        "SELECT space_id FROM content.source_artifacts WHERE id = $1",
        [pending.sourceArtifactId]
      );
      const spaceId = sourceScope.rows[0]!.space_id;
      const chunkFixture = await ownerPool.query<{
        id: string;
        tenant_id: string;
        workspace_id: string;
        space_id: string;
        source_artifact_id: string;
        normalization_version: string;
        chunking_version: string;
        chunk_index: number;
        start_offset: number;
        end_offset: number;
        normalized_text: string;
        content_hash: string;
        access_class: string;
        created_at: Date;
      }>("SELECT * FROM content.source_chunks WHERE id = $1", [
        pending.claimPayload.evidence.sourceChunkId
      ]);
      const chunk = chunkFixture.rows[0]!;
      const initialTriggers = await sourceChunkTriggerState(ownerPool);
      expect(initialTriggers.every(({ enabled }) => enabled === "O")).toBe(true);
      const b1Guards = new Set([
        "source_chunks_governed_delete",
        "source_chunks_reconstruction_deferred"
      ]);
      const disabledTriggers = initialTriggers.map((trigger) =>
        b1Guards.has(trigger.name) ? { ...trigger, enabled: "D" } : trigger
      );
      let guardsDisabled = false;

      try {
        await ownerPool.query(
          `ALTER TABLE content.source_chunks
             DISABLE TRIGGER source_chunks_governed_delete,
             DISABLE TRIGGER source_chunks_reconstruction_deferred`
        );
        guardsDisabled = true;
        expect(await sourceChunkTriggerState(ownerPool)).toEqual(disabledTriggers);
        expect(
          disabledTriggers.find(({ name }) => name === "source_chunks_z_b2_delete_interlock")
        ).toEqual({
          name: "source_chunks_z_b2_delete_interlock",
          enabled: "O"
        });

        const before = await lifecycleSnapshot(ownerPool, pending.sourceArtifactId, [claimKey]);
        expect(before.chunks).toHaveLength(1);
        expect(before.evidenceSpans).toEqual([]);
        expect(before.claims).toEqual([]);
        expect(before.commands).toEqual([]);
        expect(before.audits).toEqual([]);
        expect(before.outbox).toEqual([]);

        if (lockOrder === "claim_first") {
          const barrier = await ownerPool.connect();
          const deleteClient = await appPool.connect();
          let barrierOpen = false;
          let deleteTransactionOpen = false;
          const inFlight: Promise<unknown>[] = [];
          try {
            await barrier.query("BEGIN");
            barrierOpen = true;
            const barrierPid = (
              await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            ).rows[0]!.pid;
            await barrier.query("LOCK TABLE truth.claims IN ACCESS EXCLUSIVE MODE");

            const claimPromise = post("/internal/v1/claims", claimKey, pending.claimPayload);
            inFlight.push(claimPromise);
            const claimPid = await waitForBackendBlockedBy(ownerPool, barrierPid, 10_000);
            expect(await observeStillPending(claimPromise, 50)).toBe(true);

            await deleteClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            deleteTransactionOpen = true;
            await setRawAppContext(deleteClient, context, spaceId);
            const deletePid = (
              await deleteClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            ).rows[0]!.pid;
            const deleteOutcomePromise = deleteClient
              .query(
                `DELETE FROM content.source_chunks
                  WHERE id = $1 AND source_artifact_id = $2
                  RETURNING id`,
                [chunk.id, pending.sourceArtifactId]
              )
              .then(
                (result) => ({ status: "fulfilled" as const, rowCount: result.rowCount }),
                (error: unknown) => ({
                  status: "rejected" as const,
                  error:
                    error instanceof Error
                      ? {
                          name: error.name,
                          message: error.message,
                          code: (error as Error & { code?: string }).code
                        }
                      : { message: String(error) }
                })
              );
            inFlight.push(deleteOutcomePromise);
            expect(await waitForBackendBlockedBy(ownerPool, claimPid, 10_000)).toBe(deletePid);
            expect(await observeStillPending(deleteOutcomePromise, 50)).toBe(true);

            await barrier.query("COMMIT");
            barrierOpen = false;
            const [claimResponse, deleteOutcome] = await withDeadline(
              Promise.all([claimPromise, deleteOutcomePromise]),
              15_000
            );
            expect(claimResponse.statusCode, claimResponse.body).toBe(201);
            expect(deleteOutcome).toMatchObject({
              status: "rejected",
              error: {
                message: "Source lifecycle transition is unavailable",
                code: "TLB21"
              }
            });
            await deleteClient.query("ROLLBACK");
            deleteTransactionOpen = false;

            const state = await lifecycleSnapshot(ownerPool, pending.sourceArtifactId, [claimKey]);
            expect(state.source).toEqual(before.source);
            expect(state.chunks).toEqual(before.chunks);
            expect(state.successors).toEqual([]);
            expect(state.evidenceSpans).toHaveLength(1);
            expect(state.claims).toHaveLength(1);
            expect(state.facts).toEqual([]);
            expect(state.commands).toEqual([
              expect.objectContaining({ idempotency_key: claimKey, state: "completed" })
            ]);
            expect(state.audits).toHaveLength(1);
            expect(state.outbox).toHaveLength(1);
          } finally {
            if (barrierOpen) await barrier.query("ROLLBACK");
            barrier.release();
            await withDeadline(Promise.allSettled(inFlight), 15_000);
            if (deleteTransactionOpen) await deleteClient.query("ROLLBACK");
            deleteClient.release();
          }
        } else {
          const deleteClient = await appPool.connect();
          let deleteTransactionOpen = false;
          const inFlight: Promise<unknown>[] = [];
          try {
            await deleteClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            deleteTransactionOpen = true;
            await setRawAppContext(deleteClient, context, spaceId);
            const deletePid = (
              await deleteClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            ).rows[0]!.pid;
            const deleted = await deleteClient.query(
              `DELETE FROM content.source_chunks
                WHERE id = $1 AND source_artifact_id = $2
                RETURNING id`,
              [chunk.id, pending.sourceArtifactId]
            );
            expect(deleted.rowCount).toBe(1);

            const claimPromise = post("/internal/v1/claims", claimKey, pending.claimPayload);
            inFlight.push(claimPromise);
            const claimPid = await waitForBackendBlockedBy(ownerPool, deletePid, 10_000);
            expect(claimPid).not.toBe(deletePid);
            expect(await observeStillPending(claimPromise, 50)).toBe(true);

            await deleteClient.query("COMMIT");
            deleteTransactionOpen = false;
            const claimResponse = await withDeadline(claimPromise, 15_000);
            expect(claimResponse.statusCode).toBe(500);
            expect(claimResponse.json()).toEqual({
              message: "Request could not be completed",
              error: "Internal Server Error",
              statusCode: 500
            });

            const state = await lifecycleSnapshot(ownerPool, pending.sourceArtifactId, [claimKey]);
            expect(state.source).toEqual(before.source);
            expect(state.chunks).toEqual([]);
            expect(state.successors).toEqual([]);
            expect(state.evidenceSpans).toEqual([]);
            expect(state.claims).toEqual([]);
            expect(state.facts).toEqual([]);
            expect(state.commands).toEqual([]);
            expect(state.audits).toEqual([]);
            expect(state.outbox).toEqual([]);
          } finally {
            if (deleteTransactionOpen) await deleteClient.query("ROLLBACK");
            await withDeadline(Promise.allSettled(inFlight), 15_000);
            deleteClient.release();
          }
        }

        expect(await sourceChunkTriggerState(ownerPool)).toEqual(disabledTriggers);
      } finally {
        if (guardsDisabled) {
          const beforeRestore = await sourceChunkTriggerState(ownerPool);
          const b2InterlockWasEnabled =
            beforeRestore.find(({ name }) => name === "source_chunks_z_b2_delete_interlock")
              ?.enabled === "O";
          try {
            const present = await ownerPool.query<{ present: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM content.source_chunks WHERE id = $1) AS present",
              [chunk.id]
            );
            if (!present.rows[0]!.present) {
              await ownerPool.query(
                `INSERT INTO content.source_chunks (
                   id, tenant_id, workspace_id, space_id, source_artifact_id,
                   normalization_version, chunking_version, chunk_index,
                   start_offset, end_offset, normalized_text, content_hash,
                   access_class, created_at
                 ) VALUES (
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
                 )`,
                [
                  chunk.id,
                  chunk.tenant_id,
                  chunk.workspace_id,
                  chunk.space_id,
                  chunk.source_artifact_id,
                  chunk.normalization_version,
                  chunk.chunking_version,
                  chunk.chunk_index,
                  chunk.start_offset,
                  chunk.end_offset,
                  chunk.normalized_text,
                  chunk.content_hash,
                  chunk.access_class,
                  chunk.created_at
                ]
              );
            }
          } finally {
            await ownerPool.query(
              `ALTER TABLE content.source_chunks
                 ENABLE TRIGGER source_chunks_governed_delete,
                 ENABLE TRIGGER source_chunks_reconstruction_deferred`
            );
          }
          expect(b2InterlockWasEnabled).toBe(true);
          expect(await sourceChunkTriggerState(ownerPool)).toEqual(initialTriggers);
        }
      }
    },
    90_000
  );

  it.each([
    ["correction", "claim_first"],
    ["correction", "lifecycle_first"],
    ["tombstone", "claim_first"],
    ["tombstone", "lifecycle_first"]
  ] as const)(
    "serializes Claim admission versus source %s with deterministic %s lock order",
    async (lifecycleKind, lockOrder) => {
      const key = `b2-race-${lifecycleKind}-${lockOrder}`;
      const pending = await createClaimCandidateSource(
        key,
        "The source-row lock must select exactly one legal lifecycle or Claim winner."
      );
      const context = createDevSecurityContext("tenant-a-owner");
      const claimKey = `${key}-claim`;
      const lifecycleKey = `${key}-lifecycle`;
      const barrier = await ownerPool.connect();
      let barrierOpen = true;
      const inFlight: Promise<unknown>[] = [];
      try {
        await barrier.query("BEGIN");
        const barrierPid = (await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        await barrier.query("LOCK TABLE truth.verified_evidence_spans IN ACCESS EXCLUSIVE MODE");

        const runClaim = () => post("/internal/v1/claims", claimKey, pending.claimPayload);
        const runLifecycle = () =>
          lifecycleKind === "correction"
            ? new AccountOperationsDomainCommandBus(appPool).execute(
                {
                  kind: "source.correct",
                  idempotencyKey: lifecycleKey,
                  payload: {
                    predecessorSourceArtifactId: pending.sourceArtifactId,
                    sourceType: "note",
                    text: "Deterministic concurrent correction."
                  }
                },
                context
              )
            : new AccountOperationsDomainCommandBus(appPool).execute(
                {
                  kind: "source.tombstone",
                  idempotencyKey: lifecycleKey,
                  payload: {
                    sourceArtifactId: pending.sourceArtifactId,
                    expectedVersion: 1,
                    deletionReasonCategory: "retention",
                    deletionPolicyRef: "policy:b2-deterministic-race"
                  }
                },
                context
              );

        const first = lockOrder === "claim_first" ? runClaim() : runLifecycle();
        inFlight.push(first);
        const firstPid = await waitForBackendBlockedBy(ownerPool, barrierPid, 10_000);
        expect(await observeStillPending(first, 50)).toBe(true);

        const second = lockOrder === "claim_first" ? runLifecycle() : runClaim();
        inFlight.push(second);
        const secondPid = await waitForBackendBlockedBy(ownerPool, firstPid, 10_000);
        expect(secondPid).not.toBe(firstPid);
        expect(await observeStillPending(second, 50)).toBe(true);

        await barrier.query("COMMIT");
        barrierOpen = false;
        const [firstOutcome, secondOutcome] = await withDeadline(
          Promise.all([settle(first), settle(second)]),
          15_000
        );
        const claimOutcome = lockOrder === "claim_first" ? firstOutcome : secondOutcome;
        const lifecycleOutcome = lockOrder === "claim_first" ? secondOutcome : firstOutcome;
        const state = await lifecycleSnapshot(ownerPool, pending.sourceArtifactId, [
          claimKey,
          lifecycleKey
        ]);

        expect(
          state.successors.length > 0 && (state.evidenceSpans.length > 0 || state.claims.length > 0)
        ).toBe(false);
        expect(state.facts).toEqual([]);

        if (lockOrder === "claim_first") {
          expect(claimOutcome).toMatchObject({
            status: "fulfilled",
            value: { statusCode: 201 }
          });
          expect(lifecycleOutcome).toMatchObject({
            status: "rejected",
            error: {
              name: "B1CommandInvariantError",
              message: "B1 command transaction invariant failed"
            }
          });
          expect(state.source).toMatchObject({ version: 1, deleted_at: null });
          expect(state.successors).toEqual([]);
          expect(state.evidenceSpans).toHaveLength(1);
          expect(state.claims).toHaveLength(1);
          expect(state.commands).toEqual([
            expect.objectContaining({ idempotency_key: claimKey, state: "completed" })
          ]);
          expect(state.audits).toHaveLength(1);
          expect(state.outbox).toHaveLength(1);
        } else {
          expect(lifecycleOutcome.status).toBe("fulfilled");
          expect(claimOutcome).toMatchObject({
            status: "fulfilled",
            value: { statusCode: 404 }
          });
          expect(state.evidenceSpans).toEqual([]);
          expect(state.claims).toEqual([]);
          expect(state.commands).toEqual([
            expect.objectContaining({ idempotency_key: lifecycleKey, state: "completed" })
          ]);
          expect(state.audits).toHaveLength(1);
          expect(state.outbox).toHaveLength(1);
          if (lifecycleKind === "correction") {
            expect(state.source).toMatchObject({ version: 1, deleted_at: null });
            expect(state.successors).toHaveLength(1);
          } else {
            expect(state.source).toMatchObject({ version: 2, deleted_at: expect.any(String) });
            expect(state.chunks).toEqual([]);
            expect(state.successors).toEqual([]);
          }
        }
      } finally {
        if (barrierOpen) await barrier.query("ROLLBACK");
        barrier.release();
        await withDeadline(Promise.allSettled(inFlight), 15_000);
      }
    },
    90_000
  );

  it("preserves B1 correction and tombstone behavior for a source with no dependent truth", async () => {
    const source = await post(`/v1/activities/${activityId}/sources`, "b2-no-truth-source", {
      sourceType: "note",
      text: "This source has no B2 truth."
    });
    expect(source.statusCode, source.body).toBe(201);
    const originalId = source.json<{ sourceArtifactId: string }>().sourceArtifactId;
    const bus = new AccountOperationsDomainCommandBus(appPool);
    const context = createDevSecurityContext("tenant-a-owner");
    const corrected = await bus.execute(
      {
        kind: "source.correct",
        idempotencyKey: "b2-no-truth-correction",
        payload: {
          predecessorSourceArtifactId: originalId,
          sourceType: "note",
          text: "This corrected source still has no B2 truth."
        }
      },
      context
    );
    expect(corrected).toMatchObject({
      previousSourceArtifactId: originalId,
      version: 1
    });
    await expect(
      bus.execute(
        {
          kind: "source.tombstone",
          idempotencyKey: "b2-no-truth-tombstone",
          payload: {
            sourceArtifactId: corrected.sourceArtifactId,
            expectedVersion: 1,
            deletionReasonCategory: "retention",
            deletionPolicyRef: "policy:b2-no-truth"
          }
        },
        context
      )
    ).resolves.toMatchObject({
      sourceArtifactId: corrected.sourceArtifactId,
      version: 2,
      hashDisposition: "retained"
    });
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
      expect(response.json()).toEqual({
        message: `Cannot GET ${url}`,
        error: "Not Found",
        statusCode: 404
      });
      expect(response.body).not.toContain(claimId);
      for (const persistedTruth of [
        '"factId":',
        '"claimId":',
        '"acceptedClaimIds":',
        '"canonicalValue":',
        '"predicate":',
        '"confidence":',
        '"status":"current"',
        "Outcome agreed with the customer"
      ]) {
        expect(response.body).not.toContain(persistedTruth);
      }
    }
  });

  async function createProposedClaimSource(key: string, text: string) {
    const candidate = await createClaimCandidateSource(key, text);
    const claim = await post("/internal/v1/claims", `${key}-claim`, candidate.claimPayload);
    expect(claim.statusCode, claim.body).toBe(201);
    const createdClaimId = claim.json<{ claimId: string }>().claimId;
    return {
      sourceArtifactId: candidate.sourceArtifactId,
      factPayload: {
        subject: { type: "activity", id: candidate.activityId, expectedVersion: 1 },
        claims: [{ claimId: createdClaimId, expectedVersion: 1 }],
        expectedCurrentFactId: null,
        acceptanceScope: "engagement"
      }
    };
  }

  async function createClaimCandidateSource(key: string, text: string) {
    const activity = await post("/v1/activities", `${key}-activity`, {
      title: `Truth lifecycle ${key}`,
      profileTemplateKey: "ai_workshop",
      status: "captured",
      governingInitiativeId: initiativeId,
      organizationIds: [organizationId],
      initiativeIds: [initiativeId],
      attendeePersonIds: [devFixtures.externalPersonA]
    });
    expect(activity.statusCode, activity.body).toBe(201);
    const createdActivityId = activity.json<{ activityId: string }>().activityId;
    const source = await post(`/v1/activities/${createdActivityId}/sources`, `${key}-source`, {
      sourceType: "note",
      title: `Evidence ${key}`,
      text
    });
    expect(source.statusCode, source.body).toBe(201);
    const createdSourceId = source.json<{ sourceArtifactId: string }>().sourceArtifactId;
    const sourceRead = await get(`/v1/sources/${createdSourceId}`);
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
    const excerpt = Array.from(chunk.normalizedText)
      .slice(0, Math.min(40, Array.from(text).length))
      .join("");
    return {
      activityId: createdActivityId,
      sourceArtifactId: createdSourceId,
      claimPayload: {
        subject: { type: "activity", id: createdActivityId, expectedVersion: 1 },
        predicate: "activity.outcome",
        valueJson: `Canonical lifecycle value ${key}`,
        normalizedText: `Canonical lifecycle value ${key}`,
        confidence: "strong",
        evidence: {
          sourceArtifactId: createdSourceId,
          sourceChunkId: chunk.id,
          expectedSourceVersion: 1,
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
      }
    };
  }

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

interface LifecycleSnapshot {
  source: Record<string, unknown> | null;
  chunks: Array<Record<string, unknown>>;
  successors: Array<Record<string, unknown>>;
  evidenceSpans: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  outbox: Array<Record<string, unknown>>;
}

async function lifecycleSnapshot(
  pool: PgPool,
  sourceArtifactId: string,
  idempotencyKeys: readonly string[]
): Promise<LifecycleSnapshot> {
  const result = await pool.query<LifecycleSnapshot>(
    `SELECT
       (SELECT to_jsonb(source)
          FROM content.source_artifacts source
         WHERE source.id = $1) AS source,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(chunk) ORDER BY chunk.chunk_index, chunk.id)
           FROM content.source_chunks chunk
          WHERE chunk.source_artifact_id = $1
       ), '[]'::jsonb) AS chunks,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(successor) ORDER BY successor.id)
           FROM content.source_artifacts successor
          WHERE successor.supersedes_source_id = $1
       ), '[]'::jsonb) AS successors,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence.id)
           FROM truth.verified_evidence_spans evidence
          WHERE evidence.source_artifact_id = $1
       ), '[]'::jsonb) AS "evidenceSpans",
       COALESCE((
         SELECT jsonb_agg(to_jsonb(claim) ORDER BY claim.id)
           FROM truth.claims claim
           JOIN truth.verified_evidence_spans evidence
             ON evidence.tenant_id = claim.tenant_id
            AND evidence.workspace_id = claim.workspace_id
            AND evidence.id = claim.verified_evidence_span_id
          WHERE evidence.source_artifact_id = $1
       ), '[]'::jsonb) AS claims,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(fact) ORDER BY fact.id)
           FROM truth.accepted_facts fact
          WHERE EXISTS (
            SELECT 1
              FROM truth.fact_claims support
              JOIN truth.claims claim
                ON claim.tenant_id = support.tenant_id
               AND claim.workspace_id = support.workspace_id
               AND claim.id = support.claim_id
              JOIN truth.verified_evidence_spans evidence
                ON evidence.tenant_id = claim.tenant_id
               AND evidence.workspace_id = claim.workspace_id
               AND evidence.id = claim.verified_evidence_span_id
             WHERE support.tenant_id = fact.tenant_id
               AND support.workspace_id = fact.workspace_id
               AND support.fact_id = fact.id
               AND evidence.source_artifact_id = $1
          )
       ), '[]'::jsonb) AS facts,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(command) ORDER BY command.id)
           FROM ops.domain_command_records command
          WHERE command.idempotency_key = ANY($2::text[])
       ), '[]'::jsonb) AS commands,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)
           FROM ops.audit_events audit
          WHERE audit.causation_command_id IN (
            SELECT command.id
              FROM ops.domain_command_records command
             WHERE command.idempotency_key = ANY($2::text[])
          )
       ), '[]'::jsonb) AS audits,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
           FROM ops.product_outbox_events event
          WHERE event.causation_command_id IN (
            SELECT command.id
              FROM ops.domain_command_records command
             WHERE command.idempotency_key = ANY($2::text[])
          )
       ), '[]'::jsonb) AS outbox`,
    [sourceArtifactId, [...idempotencyKeys]]
  );
  const snapshot = result.rows[0];
  if (!snapshot) throw new Error("Lifecycle snapshot is unavailable");
  return snapshot;
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection");
  }
  throw new Error("Expected lifecycle transition to fail");
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

async function setRawAppContext(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  context: ReturnType<typeof createDevSecurityContext>,
  spaceId: string
): Promise<void> {
  const settings = [
    ["app.request_id", "b2-repeatable-read-adversary"],
    ["app.trace_id", context.traceId],
    ["app.tenant_id", context.tenantId],
    ["app.workspace_id", context.workspaceId],
    ["app.space_id", spaceId],
    ["app.user_id", context.actorUserId],
    ["app.membership_id", context.actorMembershipId],
    ["app.service_principal_id", ""],
    ["app.agent_principal_id", ""],
    ["app.policy_version", context.policyVersion],
    ["app.data_class_ceiling", context.dataClassCeiling]
  ] as const;
  for (const [name, value] of settings) {
    await client.query("SELECT set_config($1, $2, true)", [name, value ?? ""]);
  }
}

async function sourceChunkTriggerState(
  pool: PgPool
): Promise<Array<{ name: string; enabled: string }>> {
  const state = await pool.query<{ name: string; enabled: string }>(
    `SELECT trigger_record.tgname AS name,
            trigger_record.tgenabled::text AS enabled
       FROM pg_trigger trigger_record
      WHERE trigger_record.tgrelid = 'content.source_chunks'::regclass
        AND NOT trigger_record.tgisinternal
      ORDER BY trigger_record.tgname`
  );
  return state.rows;
}

async function waitForBackendBlockedBy(
  pool: PgPool,
  blockerPid: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid
         FROM pg_stat_activity activity
        WHERE activity.datname = current_database()
          AND activity.pid <> pg_backend_pid()
          AND $1 = ANY(pg_blocking_pids(activity.pid))
        ORDER BY activity.pid`,
      [blockerPid]
    );
    if (result.rows.length === 1) return result.rows[0]!.pid;
    if (result.rows.length > 1) {
      throw new Error(`Expected one backend blocked by PID ${blockerPid}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for a backend blocked by PID ${blockerPid}`);
}

async function observeStillPending(
  promise: Promise<unknown>,
  observationMs: number
): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => false,
      () => false
    ),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), observationMs))
  ]);
}

async function settle(
  promise: Promise<unknown>
): Promise<
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; error: { name?: string; message?: string } }
> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({
      status: "rejected" as const,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: String(error) }
    })
  );
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Concurrent B2 proof exceeded its deadline")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
