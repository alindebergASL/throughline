import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  AccountOperationsDomainCommandBus,
  B1CommandInvariantError
} from "@throughline/account-operations";
import type { ClaimSourceSpanCandidate } from "@throughline/core-types";
import {
  applyMigrations,
  createPgPool,
  DomainCommandRepository,
  provisionTestAppRole,
  provisionWorkspaceProductRelayPrincipal,
  seedWaveA2DeterministicData,
  withTenantTransaction,
  type PgPool,
  type TenantDbTransaction
} from "@throughline/db";
import { createDevSecurityContext, devFixtures, generateUuidV7 } from "@throughline/tenancy";
import { TruthLedgerDomainCommandBus } from "@throughline/truth-ledger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module.js";
import { TrustedObjectiveGuard, type TrustedObjectiveRequest } from "./trusted-objective.guard.js";
import { TrustedObjectiveRuntime } from "./trusted-objective.runtime.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const authoritative = process.env.B2_AUTHORITATIVE_GATE === "1";
const suite =
  ownerUrl && appUrl ? describe.sequential : authoritative ? describe.sequential : describe.skip;

const note = `Northstar County Services discovery
Maya: The primary objective is to reduce average resident-service response time from twelve business days to five while preserving human review.
Erin: Human review remains mandatory before any response is sent to a resident.
Luis: The source systems are ServiceNow, SharePoint, and the legacy case database.`;
const excerpt =
  "The primary objective is to reduce average resident-service response time from twelve business days to five while preserving human review.";
const objective =
  "Reduce average resident-service response time from twelve business days to five while preserving human review.";

suite("B2 Slice 2 trusted-objective browser API and PostgreSQL walking slice", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let ownerApp: NestFastifyApplication;
  let unavailableApp: NestFastifyApplication;
  let sameTenantViewerApp: NestFastifyApplication;
  let accountBus: AccountOperationsDomainCommandBus;
  let initiativeId: string;
  let activityId: string;
  let sourceArtifactId: string;
  let priorDatabaseUrl: string | undefined;
  let priorAdapter: string | undefined;
  let priorPersona: string | undefined;

  beforeAll(async () => {
    if (!ownerUrl || !appUrl)
      throw new Error("Trusted objective PostgreSQL gate requires owner and app DSNs");
    ownerPool = createPgPool(ownerUrl);
    await applyMigrations(ownerPool, { reset: true });
    await seedWaveA2DeterministicData(ownerPool);
    await provisionTestAppRole(ownerPool, appUrl);
    await withTenantTransaction(
      { pool: ownerPool, context: createDevSecurityContext("tenant-a-owner") },
      (tx) =>
        provisionWorkspaceProductRelayPrincipal(tx, {
          tenantId: devFixtures.tenantA,
          workspaceId: devFixtures.workspaceA
        })
    );

    appPool = createPgPool(appUrl);
    accountBus = new AccountOperationsDomainCommandBus(appPool);
    const organization = await accountBus.execute(
      {
        kind: "organization.create",
        idempotencyKey: "trusted-objective-prerequisite-organization",
        payload: { name: "Northstar County Services", domains: ["northstar.example"] }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    const initiative = await accountBus.execute(
      {
        kind: "initiative.create",
        idempotencyKey: "trusted-objective-prerequisite-initiative",
        payload: {
          primaryOrganizationId: organization.organizationId,
          title: "Resident Service Response",
          typeKey: "application",
          stageKey: "workshop"
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    initiativeId = initiative.initiativeId;
    const activity = await accountBus.execute(
      {
        kind: "activity.create",
        idempotencyKey: "trusted-objective-prerequisite-activity",
        payload: {
          title: "Resident services discovery",
          profileTemplateKey: "discovery",
          status: "completed",
          governingInitiativeId: initiativeId,
          organizationIds: [organization.organizationId],
          initiativeIds: [initiativeId]
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    activityId = activity.activityId;

    priorDatabaseUrl = process.env.DATABASE_URL;
    priorAdapter = process.env.AUTH_ADAPTER;
    priorPersona = process.env.TRUSTED_OBJECTIVE_DEMO_PERSONA;
    process.env.DATABASE_URL = appUrl;
    process.env.AUTH_ADAPTER = "dev";
    ownerApp = await createApiForPersona("owner");
    unavailableApp = await createApiForPersona("unavailable");
    sameTenantViewerApp = await createApiWithContext(createDevSecurityContext("tenant-a-viewer"));
  }, 60_000);

  afterAll(async () => {
    await ownerApp?.close();
    await unavailableApp?.close();
    await sameTenantViewerApp?.close();
    await appPool?.end();
    await ownerPool?.end();
    restore("DATABASE_URL", priorDatabaseUrl);
    restore("AUTH_ADAPTER", priorAdapter);
    restore("TRUSTED_OBJECTIVE_DEMO_PERSONA", priorPersona);
  });

  it("runs capture → proposed Claim → accepted Fact through durable canonical buses and converges double submits", async () => {
    const empty = await getAs("tenant-a-owner", initiativeId);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      state: "empty",
      source: null,
      proposal: null,
      acceptedMemory: null
    });

    const captureResponses = await Promise.all([
      postAs("tenant-a-owner", initiativeId, "source", { note }),
      postAs("tenant-a-owner", initiativeId, "source", {
        note: `\uFEFF${note.replaceAll("\n", "\r\n")}`
      })
    ]);
    for (const response of captureResponses) {
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ state: "captured", source: { note } });
    }

    const source = await ownerPool.query<{ id: string }>(
      `SELECT source.id FROM content.source_artifacts source
       JOIN work.activity_sources link ON link.source_artifact_id = source.id
       WHERE link.activity_id = $1`,
      [activityId]
    );
    expect(source.rows).toHaveLength(1);
    sourceArtifactId = source.rows[0]!.id;

    const proposalResponses = await Promise.all([
      postAs("tenant-a-owner", initiativeId, "proposal", {
        objective,
        exactExcerpt: excerpt,
        supportConfirmed: true
      }),
      postAs("tenant-a-owner", initiativeId, "proposal", {
        objective,
        exactExcerpt: excerpt,
        supportConfirmed: true
      })
    ]);
    for (const response of proposalResponses) {
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        state: "proposed",
        proposal: { objective, exactExcerpt: excerpt, status: "Proposed, not accepted." },
        acceptedMemory: null
      });
    }

    const acceptanceResponses = await Promise.all([
      postAs("tenant-a-owner", initiativeId, "accept", {}),
      postAs("tenant-a-owner", initiativeId, "accept", {})
    ]);
    for (const response of acceptanceResponses) {
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        state: "accepted",
        proposal: null,
        acceptedMemory: {
          objective,
          status: "Accepted",
          exactExcerpt: excerpt,
          sourceTitle: "Engagement note",
          transition: "Proposed → Accepted",
          acceptedBy: "Owner A",
          effectiveVisibility: "Workspace"
        }
      });
    }

    const durable = await ownerPool.query<{
      sources: string;
      claims: string;
      facts: string;
      spans: string;
      attestations: string;
      truth_audits: string;
      truth_outbox: string;
      truth_commands: string;
      parallel_store: string | null;
    }>(
      `SELECT
        (SELECT count(*)::text FROM content.source_artifacts) AS sources,
        (SELECT count(*)::text FROM truth.claims) AS claims,
        (SELECT count(*)::text FROM truth.accepted_facts) AS facts,
        (SELECT count(*)::text FROM truth.verified_evidence_spans) AS spans,
        (SELECT count(*)::text
           FROM truth.initiative_objective_support_attestations) AS attestations,
        (SELECT count(*)::text FROM ops.audit_events
          WHERE action IN ('claim.create','fact.accept')) AS truth_audits,
        (SELECT count(*)::text FROM ops.product_outbox_events
          WHERE event_type IN ('claim.proposed','fact.accepted')) AS truth_outbox,
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE command_kind IN ('claim.create.v1','fact.accept.v1')) AS truth_commands,
        to_regclass('work.trusted_objectives')::text AS parallel_store`
    );
    expect(durable.rows[0]).toEqual({
      sources: "1",
      claims: "1",
      facts: "1",
      spans: "1",
      attestations: "1",
      truth_audits: "2",
      truth_outbox: "2",
      truth_commands: "2",
      parallel_store: null
    });
  }, 30_000);

  it("serializes different concurrent primary-objective proposals at the canonical truth boundary", async () => {
    const workflow = await createWorkflow("concurrent-proposals");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const competingObjective = `${objective} Confirmed by the service owner.`;

    const responses = await Promise.all([
      postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
        objective,
        exactExcerpt: excerpt,
        supportConfirmed: true
      }),
      postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
        objective: competingObjective,
        exactExcerpt: excerpt,
        supportConfirmed: true
      })
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 1, accepted: 0 });
  });

  it("projects owner and proposer capabilities from the normal unscoped dev-owner context", async () => {
    const workflow = await createWorkflow("unscoped-owner-capabilities");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(proposed.statusCode, proposed.body).toBe(201);

    const unscopedOwnerContext = createDevSecurityContext("tenant-a-owner");
    expect(unscopedOwnerContext.requestedSpaceIds).toEqual([]);
    const unscopedOwnerApp = await createApiWithContext(unscopedOwnerContext);
    try {
      const projected = await unscopedOwnerApp.inject({
        method: "GET",
        url: `/v1/demo/initiatives/${workflow.initiativeId}/trusted-objective`
      });

      expect(projected.statusCode, projected.body).toBe(200);
      expect(projected.json()).toMatchObject({
        state: "proposed",
        initiative: { canAccept: true },
        proposal: {
          objective,
          canRework: true,
          canWithdraw: true,
          canReject: true
        }
      });
    } finally {
      await unscopedOwnerApp.close();
    }
  });

  it("fails a mismatched exact-Space rediscovery closed with the generic response", async () => {
    const workflow = await createWorkflow("projection-scope-mismatch");
    const unscopedOwnerContext = createDevSecurityContext("tenant-a-owner");
    const unscopedOwnerApp = await createApiWithContext(unscopedOwnerContext);
    const missing = await unscopedOwnerApp.inject({
      method: "GET",
      url: "/v1/demo/initiatives/70000000-0000-7000-8000-000000000996/trusted-objective"
    });
    const runtime = unscopedOwnerApp.get(TrustedObjectiveRuntime);
    const scopeReader = runtime as unknown as {
      readScope(
        tx: TenantDbTransaction,
        context: ReturnType<typeof createDevSecurityContext>,
        id: string
      ): Promise<{ initiativeId: string; initiativeSpaceId: string; [key: string]: unknown }>;
    };
    const originalReadScope = scopeReader.readScope.bind(runtime);
    let readCount = 0;
    const readScopeSpy = vi.spyOn(scopeReader, "readScope").mockImplementation(async (...args) => {
      const scope = await originalReadScope(...args);
      readCount += 1;
      return readCount === 2 ? { ...scope, initiativeSpaceId: devFixtures.rootSpaceA } : scope;
    });
    try {
      const mismatched = await unscopedOwnerApp.inject({
        method: "GET",
        url: `/v1/demo/initiatives/${workflow.initiativeId}/trusted-objective`
      });

      expect(readCount).toBe(2);
      expect(mismatched.statusCode).toBe(404);
      expect(mismatched.body).toBe(missing.body);
      expect(mismatched.body).not.toContain(workflow.initiativeId);
    } finally {
      readScopeSpy.mockRestore();
      await unscopedOwnerApp.close();
    }
  });

  it("serializes different concurrent notes into one durable workflow capture slot", async () => {
    const workflow = await createWorkflow("concurrent-captures");
    const competingNote = `${note}\nNora: The target must also cover phone requests.`;

    const responses = await Promise.all([
      postAs("tenant-a-owner", workflow.initiativeId, "source", { note }),
      postAs("tenant-a-owner", workflow.initiativeId, "source", { note: competingNote })
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    const winner = responses.find(({ statusCode }) => statusCode === 201)!;
    const winningNote = winner.json().source.note as string;
    expect([note, competingNote]).toContain(winningNote);

    const durable = await ownerPool.query<{
      sources: string;
      links: string;
      commands: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM content.source_artifacts source
         JOIN work.activity_sources link ON link.tenant_id = source.tenant_id
           AND link.workspace_id = source.workspace_id
           AND link.space_id = source.space_id
           AND link.source_artifact_id = source.id
         WHERE link.activity_id = $1 AND source.deleted_at IS NULL) AS sources,
        (SELECT count(*)::text FROM work.activity_sources
         WHERE activity_id = $1) AS links,
        (SELECT count(*)::text FROM ops.domain_command_records command
         WHERE command.command_kind = 'source.capture.v1'
           AND command.result_resource_type = 'source_artifact'
           AND command.result_resource_id IN (
             SELECT source_artifact_id FROM work.activity_sources WHERE activity_id = $1
           )) AS commands`,
      [workflow.activityId]
    );
    expect(durable.rows[0]).toEqual({ sources: "1", links: "1", commands: "1" });

    const current = await getAs("tenant-a-owner", workflow.initiativeId);
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({
      state: "captured",
      source: { note: winningNote },
      proposal: null,
      acceptedMemory: null
    });
  });

  it("serializes proposal-versus-acceptance interleavings on the same truth coordinate", async () => {
    const workflow = await createWorkflow("proposal-acceptance-race");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(proposed.statusCode, proposed.body).toBe(201);

    const responses = await Promise.all([
      postAs("tenant-a-owner", workflow.initiativeId, "accept", {}),
      postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
        objective: `${objective} Competing revision.`,
        exactExcerpt: excerpt,
        supportConfirmed: true
      })
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 0, accepted: 1 });
  });

  it("atomically reworks and commits many identical withdrawals without duplicate residue", async () => {
    const workflow = await createWorkflow("proposal-recovery");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const initial = proposed.json();
    const predecessorId = initial.proposal.claimId as string;
    const revisedObjective = objective.replace("average ", "");

    const reworked = await postAs("tenant-a-owner", workflow.initiativeId, "proposal/rework", {
      claimId: predecessorId,
      expectedClaimVersion: 1,
      expectedInitiativeVersion: initial.initiative.version,
      objective: revisedObjective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(reworked.statusCode, reworked.body).toBe(201);
    const successor = reworked.json();
    const successorId = successor.proposal.claimId as string;
    expect(successorId).not.toBe(predecessorId);
    expect(successor).toMatchObject({
      state: "proposed",
      proposal: { objective: revisedObjective, supportConfirmed: true },
      reworkLineage: [
        {
          predecessorClaimId: predecessorId,
          successorClaimId: successorId,
          disposition: "reworked",
          reasonCode: "reworked"
        }
      ]
    });
    expect((await getAs("tenant-a-owner", workflow.initiativeId)).json()).toMatchObject({
      state: "proposed",
      reworkLineage: [{ predecessorClaimId: predecessorId, successorClaimId: successorId }]
    });

    const afterRework = await ownerPool.query<{
      predecessor_status: string;
      predecessor_value: string;
      successor_status: string;
      successor_value: string;
      recoveries: string;
      spans: string;
      attestations: string;
      audits: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT status FROM truth.claims WHERE id = $1) AS predecessor_status,
        (SELECT canonical_value_text FROM truth.claims WHERE id = $1) AS predecessor_value,
        (SELECT status FROM truth.claims WHERE id = $2) AS successor_status,
        (SELECT canonical_value_text FROM truth.claims WHERE id = $2) AS successor_value,
        (SELECT count(*)::text FROM truth.initiative_objective_proposal_recoveries
          WHERE predecessor_claim_id = $1 AND successor_claim_id = $2
            AND disposition = 'reworked') AS recoveries,
        (SELECT count(*)::text FROM truth.verified_evidence_spans span
          JOIN truth.claims claim ON claim.verified_evidence_span_id = span.id
          WHERE claim.id IN ($1,$2)) AS spans,
        (SELECT count(*)::text FROM truth.initiative_objective_support_attestations
          WHERE claim_id IN ($1,$2)) AS attestations,
        (SELECT count(*)::text FROM ops.audit_events
          WHERE action = 'initiative.primary_objective.rework'
            AND safe_detail ->> 'predecessorClaimId' = $1::text
            AND safe_detail ->> 'successorClaimId' = $2::text) AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events
          WHERE event_type = 'initiative.primary_objective.proposal_reworked'
            AND payload ->> 'predecessorClaimId' = $1::text
            AND payload ->> 'successorClaimId' = $2::text) AS outbox`,
      [predecessorId, successorId]
    );
    expect(afterRework.rows[0]).toEqual({
      predecessor_status: "superseded",
      predecessor_value: objective,
      successor_status: "proposed",
      successor_value: revisedObjective,
      recoveries: "1",
      spans: "2",
      attestations: "2",
      audits: "1",
      outbox: "1"
    });

    const withdrawal = {
      claimId: successorId,
      expectedClaimVersion: 1,
      expectedInitiativeVersion: successor.initiative.version,
      disposition: "withdrawn",
      reasonCode: "needs_rework"
    };
    const withdrawn = await Promise.all(
      Array.from({ length: 20 }, () =>
        postAs("tenant-a-owner", workflow.initiativeId, "proposal/withdraw", withdrawal)
      )
    );
    for (const response of withdrawn) {
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ state: "captured", proposal: null });
    }
    const reload = await getAs("tenant-a-owner", workflow.initiativeId);
    expect(reload.json()).toMatchObject({ state: "captured", proposal: null });
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 0, accepted: 0 });
    const withdrawalEffects = await ownerPool.query<{
      recoveries: string;
      commands: string;
      audits: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM truth.initiative_objective_proposal_recoveries
          WHERE predecessor_claim_id = $1 AND disposition = 'withdrawn') AS recoveries,
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE command_kind = 'initiative.primary_objective.withdraw.v1'
            AND result_resource_id = $1) AS commands,
        (SELECT count(*)::text FROM ops.audit_events
          WHERE action = 'initiative.primary_objective.withdraw'
            AND resource_id = $1) AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events
          WHERE event_type = 'initiative.primary_objective.proposal_withdrawn'
            AND aggregate_id = $1) AS outbox`,
      [successorId]
    );
    expect(withdrawalEffects.rows[0]).toEqual({
      recoveries: "1",
      commands: "1",
      audits: "1",
      outbox: "1"
    });

    const fresh = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect(fresh.json()).toMatchObject({ state: "proposed", proposal: { supportConfirmed: true } });
  });

  it("rolls back a rework command whose causation carries an extra evidence effect", async () => {
    const workflow = await createWorkflow("adversarial-extra-rework-evidence");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const initial = proposed.json();
    const predecessorId = initial.proposal.claimId as string;
    const originalComplete = DomainCommandRepository.prototype.complete;
    const completeSpy = vi
      .spyOn(DomainCommandRepository.prototype, "complete")
      .mockImplementation(async function (this: DomainCommandRepository, input) {
        if (input.commandKind === "initiative.primary_objective.rework.v1") {
          const tx = (this as unknown as { tx: TenantDbTransaction }).tx;
          await tx.query(
            `INSERT INTO truth.verified_evidence_spans (
               id, tenant_id, workspace_id, space_id, source_artifact_id, source_chunk_id,
               source_version, chunk_version, normalization_version, chunking_version,
               source_start_offset, source_end_offset, source_excerpt,
               source_content_hash, source_normalized_content_hash, chunk_content_hash,
               excerpt_hash, access_class, created_by_user_id, created_by_membership_id,
               causation_command_id
             ) SELECT
               $1, tenant_id, workspace_id, space_id, source_artifact_id, source_chunk_id,
               source_version, chunk_version, normalization_version, chunking_version,
               source_start_offset, source_end_offset, source_excerpt,
               source_content_hash, source_normalized_content_hash, chunk_content_hash,
               excerpt_hash, access_class, created_by_user_id, created_by_membership_id,
               causation_command_id
             FROM truth.verified_evidence_spans
             WHERE tenant_id = $2 AND workspace_id = $3 AND causation_command_id = $4
             LIMIT 1`,
            [generateUuidV7(), input.tenantId, input.workspaceId, input.commandId]
          );
        }
        return originalComplete.call(this, input);
      });
    try {
      const rejected = await postAs("tenant-a-owner", workflow.initiativeId, "proposal/rework", {
        claimId: predecessorId,
        expectedClaimVersion: 1,
        expectedInitiativeVersion: initial.initiative.version,
        objective: objective.replace("average ", ""),
        exactExcerpt: excerpt,
        supportConfirmed: true
      });
      expect(rejected.statusCode, rejected.body).toBe(500);
    } finally {
      completeSpy.mockRestore();
    }
    const effects = await ownerPool.query<{
      status: string;
      version: number;
      claims: string;
      recoveries: string;
      commands: string;
    }>(
      `SELECT
         (SELECT status FROM truth.claims WHERE id = $1) AS status,
         (SELECT version FROM truth.claims WHERE id = $1) AS version,
         (SELECT count(*)::text FROM truth.claims
           WHERE subject_type = 'initiative' AND subject_id = $2
             AND predicate = 'initiative.primary_objective') AS claims,
         (SELECT count(*)::text FROM truth.initiative_objective_proposal_recoveries
           WHERE predecessor_claim_id = $1) AS recoveries,
         (SELECT count(*)::text FROM ops.domain_command_records
           WHERE command_kind = 'initiative.primary_objective.rework.v1'
             AND safe_request ->> 'predecessorClaimId' = $1::text) AS commands`,
      [predecessorId, workflow.initiativeId]
    );
    expect(effects.rows[0]).toEqual({
      status: "proposed",
      version: 1,
      claims: "1",
      recoveries: "0",
      commands: "0"
    });
  });

  it("rolls back a completed withdrawal response that disagrees with durable reason data", async () => {
    const workflow = await createWorkflow("adversarial-replay-binding");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const initial = proposed.json();
    const claimId = initial.proposal.claimId as string;
    const originalComplete = DomainCommandRepository.prototype.complete;
    const completeSpy = vi
      .spyOn(DomainCommandRepository.prototype, "complete")
      .mockImplementation(async function (this: DomainCommandRepository, input) {
        if (input.commandKind === "initiative.primary_objective.withdraw.v1") {
          return originalComplete.call(this, {
            ...input,
            safeResponse: {
              ...(input.safeResponse as Record<string, unknown>),
              reasonCode: "unsupported"
            }
          });
        }
        return originalComplete.call(this, input);
      });
    try {
      const rejected = await postAs("tenant-a-owner", workflow.initiativeId, "proposal/withdraw", {
        claimId,
        expectedClaimVersion: 1,
        expectedInitiativeVersion: initial.initiative.version,
        disposition: "withdrawn",
        reasonCode: "needs_rework"
      });
      expect(rejected.statusCode, rejected.body).toBe(500);
    } finally {
      completeSpy.mockRestore();
    }
    const effects = await ownerPool.query<{
      status: string;
      recoveries: string;
      commands: string;
    }>(
      `SELECT
         (SELECT status FROM truth.claims WHERE id = $1) AS status,
         (SELECT count(*)::text FROM truth.initiative_objective_proposal_recoveries
           WHERE predecessor_claim_id = $1) AS recoveries,
         (SELECT count(*)::text FROM ops.domain_command_records
           WHERE command_kind = 'initiative.primary_objective.withdraw.v1'
             AND safe_request ->> 'predecessorClaimId' = $1::text) AS commands`,
      [claimId]
    );
    expect(effects.rows[0]).toEqual({ status: "proposed", recoveries: "0", commands: "0" });
  });

  it("rejects app-role mutation when the reserved recovery target differs from the Claim", async () => {
    const workflow = await createWorkflow("adversarial-recovery-target");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const initial = proposed.json();
    const claimId = initial.proposal.claimId as string;
    const context = {
      ...createDevSecurityContext("tenant-a-owner", {
        requestId: "adversarial-recovery-target",
        traceId: "adversarial-recovery-target"
      }),
      requestedSpaceIds: [workflow.initiativeSpaceId]
    };
    const commandId = generateUuidV7();
    await expect(
      withTenantTransaction({ pool: appPool, context }, async (tx) => {
        const commands = new DomainCommandRepository(tx);
        await commands.reserve({
          id: commandId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          reservationSpaceId: workflow.initiativeSpaceId,
          commandKind: "initiative.primary_objective.withdraw.v1",
          commandSchemaVersion: 1,
          idempotencyKey: "adversarial-recovery-target",
          canonicalRequestHash: "a".repeat(64),
          safeRequest: {
            subjectType: "initiative",
            subjectId: workflow.initiativeId,
            expectedSubjectVersion: initial.initiative.version,
            predecessorClaimId: generateUuidV7(),
            expectedPredecessorVersion: 1,
            disposition: "withdrawn",
            reasonCode: "needs_rework"
          },
          actorUserId: context.actorUserId!,
          actorMembershipId: context.actorMembershipId!,
          policyVersionId: context.policyVersion,
          requestId: context.requestId,
          traceparent: "00-00000000000000000000000000000003-0000000000000003-01"
        });
        await tx.query(
          `UPDATE truth.claims
              SET status = 'rejected', version = 2, updated_at = clock_timestamp()
            WHERE id = $1`,
          [claimId]
        );
      })
    ).rejects.toThrow(/reserved command/);
    const effects = await ownerPool.query<{ status: string; commands: string }>(
      `SELECT
         (SELECT status FROM truth.claims WHERE id = $1) AS status,
         (SELECT count(*)::text FROM ops.domain_command_records WHERE id = $2) AS commands`,
      [claimId, commandId]
    );
    expect(effects.rows[0]).toEqual({ status: "proposed", commands: "0" });
  });

  it("fails legacy unconfirmed proposal acceptance closed but permits fresh supported rework", async () => {
    const workflow = await createWorkflow("legacy-unconfirmed-recovery");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    const state = proposed.json();
    const claimId = state.proposal.claimId as string;
    await ownerPool.query(
      "ALTER TABLE truth.initiative_objective_support_attestations DISABLE TRIGGER objective_support_immutable"
    );
    try {
      await ownerPool.query(
        "DELETE FROM truth.initiative_objective_support_attestations WHERE claim_id = $1",
        [claimId]
      );
    } finally {
      await ownerPool.query(
        "ALTER TABLE truth.initiative_objective_support_attestations ENABLE TRIGGER objective_support_immutable"
      );
    }

    const before = await durableWriteCount();
    const refused = await postAs("tenant-a-owner", workflow.initiativeId, "accept", {});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await durableWriteCount()).toBe(before);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 1, accepted: 0 });
    const reload = await getAs("tenant-a-owner", workflow.initiativeId);
    expect(reload.json()).toMatchObject({
      state: "proposed",
      proposal: { claimId, supportConfirmed: false }
    });

    const reworked = await postAs("tenant-a-owner", workflow.initiativeId, "proposal/rework", {
      claimId,
      expectedClaimVersion: 1,
      expectedInitiativeVersion: state.initiative.version,
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(reworked.statusCode, reworked.body).toBe(201);
    expect(reworked.json()).toMatchObject({
      state: "proposed",
      proposal: { supportConfirmed: true }
    });
  });

  it("rejects a stale pre-terminal proposal retry but accepts a freshly observed generation", async () => {
    const workflow = await createWorkflow("stale-proposal-generation");
    const captured = await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const initialAnchor = captured.json().proposalGenerationAnchor as string;
    const request = {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true,
      proposalGenerationAnchor: initialAnchor
    };
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", request);
    const proposal = proposed.json();
    await postAs("tenant-a-owner", workflow.initiativeId, "proposal/withdraw", {
      claimId: proposal.proposal.claimId,
      expectedClaimVersion: 1,
      expectedInitiativeVersion: proposal.initiative.version,
      disposition: "withdrawn",
      reasonCode: "needs_rework"
    });
    const before = await durableWriteCount();
    const stale = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", request);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await durableWriteCount()).toBe(before);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 0, accepted: 0 });

    const refreshed = await getAs("tenant-a-owner", workflow.initiativeId);
    const freshAnchor = refreshed.json().proposalGenerationAnchor as string;
    expect(freshAnchor).not.toBe(initialAnchor);
    const fresh = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      ...request,
      proposalGenerationAnchor: freshAnchor
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 1, accepted: 0 });
  });

  it("atomically rejects a generation prepared before an intervening proposal withdrawal", async () => {
    const workflow = await createWorkflow("atomic-stale-proposal-generation");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const initial = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    await postAs("tenant-a-owner", workflow.initiativeId, "proposal/withdraw", {
      claimId: initial.json().proposal.claimId,
      expectedClaimVersion: 1,
      expectedInitiativeVersion: initial.json().initiative.version,
      disposition: "withdrawn",
      reasonCode: "needs_rework"
    });
    const preparedState = (await getAs("tenant-a-owner", workflow.initiativeId)).json();
    const preparedClaim = await ownerPool.query<{
      id: string;
      version: number;
      status: "rejected";
    }>(
      `SELECT id, version, status FROM truth.claims
       WHERE tenant_id = $1 AND workspace_id = $2 AND subject_id = $3
         AND subject_type = 'initiative' AND predicate = 'initiative.primary_objective'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [devFixtures.tenantA, devFixtures.workspaceA, workflow.initiativeId]
    );
    const evidence = await loadClaimEvidence(initial.json().proposal.claimId);

    const intervening = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true,
      proposalGenerationAnchor: preparedState.proposalGenerationAnchor,
      sourceRevisionAnchor: preparedState.sourceRevisionAnchor
    });
    expect(intervening.statusCode, intervening.body).toBe(201);
    await postAs("tenant-a-owner", workflow.initiativeId, "proposal/withdraw", {
      claimId: intervening.json().proposal.claimId,
      expectedClaimVersion: 1,
      expectedInitiativeVersion: intervening.json().initiative.version,
      disposition: "withdrawn",
      reasonCode: "needs_rework"
    });

    const beforeStale = await objectiveEffectCount();
    const preparedCoordinate = preparedClaim.rows[0]!;
    await expect(
      new TruthLedgerDomainCommandBus(appPool).execute(
        {
          kind: "claim.create",
          idempotencyKey: "atomic-stale-proposal-generation-command",
          predicateCatalogVersion: "truth-predicate-catalog.v1",
          payload: {
            subject: {
              type: "initiative",
              id: workflow.initiativeId,
              expectedVersion: preparedState.initiative.version
            },
            predicate: "initiative.primary_objective",
            valueJson: objective,
            normalizedText: objective,
            confidence: "strong",
            evidence,
            supportConfirmation: { confirmed: true },
            expectedPrimaryObjectiveGeneration: {
              kind: "claim",
              claimId: preparedCoordinate.id,
              expectedVersion: preparedCoordinate.version,
              expectedStatus: preparedCoordinate.status
            }
          }
        },
        createDevSecurityContext("tenant-a-owner")
      )
    ).rejects.toThrow();
    expect(await objectiveEffectCount()).toBe(beforeStale);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 0, accepted: 0 });

    const freshState = (await getAs("tenant-a-owner", workflow.initiativeId)).json();
    const fresh = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true,
      proposalGenerationAnchor: freshState.proposalGenerationAnchor,
      sourceRevisionAnchor: freshState.sourceRevisionAnchor
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
  });

  it("rejects a sequential stale acceptance after rework and accepts only the rendered successor", async () => {
    const workflow = await createWorkflow("sequential-stale-accept");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const rendered = proposed.json();
    const staleAccept = {
      claimId: rendered.proposal.claimId,
      expectedClaimVersion: rendered.proposal.version,
      expectedInitiativeVersion: rendered.initiative.version
    };

    const reworked = await postAs("tenant-a-owner", workflow.initiativeId, "proposal/rework", {
      claimId: rendered.proposal.claimId,
      expectedClaimVersion: rendered.proposal.version,
      expectedInitiativeVersion: rendered.initiative.version,
      objective: objective.replace("average ", ""),
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    expect(reworked.statusCode, reworked.body).toBe(201);
    const successor = reworked.json();
    expect(successor.proposal.claimId).not.toBe(staleAccept.claimId);

    const beforeStale = await durableWriteCount();
    const stale = await postAs("tenant-a-owner", workflow.initiativeId, "accept", staleAccept);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await durableWriteCount()).toBe(beforeStale);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 1, accepted: 0 });

    const accepted = await postAs("tenant-a-owner", workflow.initiativeId, "accept", {
      claimId: successor.proposal.claimId,
      expectedClaimVersion: successor.proposal.version,
      expectedInitiativeVersion: successor.initiative.version
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({
      state: "accepted",
      reworkLineage: [
        {
          predecessorClaimId: staleAccept.claimId,
          successorClaimId: successor.proposal.claimId,
          disposition: "reworked",
          reasonCode: "reworked"
        }
      ]
    });
    expect((await getAs("tenant-a-owner", workflow.initiativeId)).json()).toMatchObject({
      state: "accepted",
      reworkLineage: [
        { predecessorClaimId: staleAccept.claimId, successorClaimId: successor.proposal.claimId }
      ]
    });
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 0, accepted: 1 });
  });

  it("rejects proposal confirmation from a stale source revision and accepts a freshly observed anchor", async () => {
    const workflow = await createWorkflow("stale-proposal-source-revision");
    const captured = await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const rendered = captured.json();
    const source = await ownerPool.query<{ id: string }>(
      `SELECT source_artifact_id AS id FROM work.activity_sources
       WHERE activity_id = $1 ORDER BY created_at, source_artifact_id LIMIT 1`,
      [workflow.activityId]
    );
    await accountBus.execute(
      {
        kind: "source.correct",
        idempotencyKey: "stale-proposal-source-revision-correction",
        payload: {
          predecessorSourceArtifactId: source.rows[0]!.id,
          activityId: workflow.activityId,
          sourceType: "note",
          title: "Corrected engagement note",
          text: `${note}\nUpdated context recorded after the browser rendered this source.`
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );

    const request = {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true,
      proposalGenerationAnchor: rendered.proposalGenerationAnchor,
      sourceRevisionAnchor: rendered.sourceRevisionAnchor
    };
    const beforeStale = await durableWriteCount();
    const stale = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", request);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await durableWriteCount()).toBe(beforeStale);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 0, accepted: 0 });

    const refreshed = await getAs("tenant-a-owner", workflow.initiativeId);
    expect(refreshed.json().sourceRevisionAnchor).not.toBe(rendered.sourceRevisionAnchor);
    const fresh = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      ...request,
      sourceRevisionAnchor: refreshed.json().sourceRevisionAnchor
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
  });

  it("rejects rework confirmation from a stale source revision and accepts the fresh anchor", async () => {
    const workflow = await createWorkflow("stale-rework-source-revision");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    const rendered = proposed.json();
    const source = await ownerPool.query<{ id: string }>(
      `SELECT source_artifact_id AS id FROM work.activity_sources
       WHERE activity_id = $1 ORDER BY created_at, source_artifact_id LIMIT 1`,
      [workflow.activityId]
    );
    await ownerPool.query(
      "ALTER TABLE content.source_artifacts DISABLE TRIGGER source_artifacts_z_b2_correction_interlock"
    );
    try {
      await accountBus.execute(
        {
          kind: "source.correct",
          idempotencyKey: "stale-rework-source-revision-correction",
          payload: {
            predecessorSourceArtifactId: source.rows[0]!.id,
            activityId: workflow.activityId,
            sourceType: "note",
            title: "Corrected engagement note",
            text: `${note}\nUpdated context recorded after rework preparation.`
          }
        },
        createDevSecurityContext("tenant-a-owner")
      );
    } finally {
      await ownerPool.query(
        "ALTER TABLE content.source_artifacts ENABLE TRIGGER source_artifacts_z_b2_correction_interlock"
      );
    }

    const request = {
      claimId: rendered.proposal.claimId,
      expectedClaimVersion: rendered.proposal.version,
      expectedInitiativeVersion: rendered.initiative.version,
      objective: objective.replace("average ", ""),
      exactExcerpt: excerpt,
      supportConfirmed: true,
      sourceRevisionAnchor: rendered.sourceRevisionAnchor
    };
    const beforeStale = await durableWriteCount();
    const stale = await postAs("tenant-a-owner", workflow.initiativeId, "proposal/rework", request);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await durableWriteCount()).toBe(beforeStale);
    const predecessor = await ownerPool.query<{ status: string; version: number }>(
      "SELECT status, version FROM truth.claims WHERE id = $1",
      [rendered.proposal.claimId]
    );
    expect(predecessor.rows[0]).toEqual({ status: "proposed", version: 1 });

    const refreshed = await getAs("tenant-a-owner", workflow.initiativeId);
    const fresh = await postAs("tenant-a-owner", workflow.initiativeId, "proposal/rework", {
      ...request,
      sourceRevisionAnchor: refreshed.json().sourceRevisionAnchor
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect(fresh.json().proposal.claimId).not.toBe(rendered.proposal.claimId);
  });

  it("repeatedly gives rework-versus-accept one winner with no partial residue", async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const workflow = await createWorkflow(`rework-accept-race-${iteration}`);
      await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
      const proposed = await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
        objective,
        exactExcerpt: excerpt,
        supportConfirmed: true
      });
      const state = proposed.json();
      const claimId = state.proposal.claimId as string;
      const responses = await Promise.all([
        postAs("tenant-a-owner", workflow.initiativeId, "accept", {}),
        postAs("tenant-a-owner", workflow.initiativeId, "proposal/rework", {
          claimId,
          expectedClaimVersion: 1,
          expectedInitiativeVersion: state.initiative.version,
          objective: objective.replace("average ", ""),
          exactExcerpt: excerpt,
          supportConfirmed: true
        })
      ]);
      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);

      const durable = await ownerPool.query<{
        proposed: number;
        accepted_claims: number;
        superseded: number;
        facts: number;
        recoveries: number;
        commands: number;
        audits: number;
        outbox: number;
      }>(
        `SELECT
          count(*) FILTER (WHERE status = 'proposed')::integer AS proposed,
          count(*) FILTER (WHERE status = 'accepted')::integer AS accepted_claims,
          count(*) FILTER (WHERE status = 'superseded')::integer AS superseded,
          (SELECT count(*)::integer FROM truth.accepted_facts
            WHERE subject_type = 'initiative' AND subject_id = $1
              AND predicate = 'initiative.primary_objective') AS facts,
          (SELECT count(*)::integer FROM truth.initiative_objective_proposal_recoveries
            WHERE initiative_id = $1) AS recoveries,
          (SELECT count(*)::integer FROM ops.domain_command_records
            WHERE (command_kind = 'initiative.primary_objective.rework.v1'
                AND safe_response ->> 'predecessorClaimId' = $2)
               OR (command_kind = 'fact.accept.v1'
                AND safe_response -> 'acceptedClaimIds' ? $2)) AS commands,
          (SELECT count(*)::integer FROM ops.audit_events audit
            WHERE (audit.action = 'initiative.primary_objective.rework'
                AND audit.safe_detail ->> 'predecessorClaimId' = $2)
               OR (audit.action = 'fact.accept' AND EXISTS (
                 SELECT 1 FROM truth.accepted_facts fact
                  WHERE fact.id = audit.resource_id AND fact.subject_id = $1
                    AND fact.predicate = 'initiative.primary_objective'))) AS audits,
          (SELECT count(*)::integer FROM ops.product_outbox_events event
            WHERE (event.event_type = 'initiative.primary_objective.proposal_reworked'
                AND event.payload ->> 'predecessorClaimId' = $2)
               OR (event.event_type = 'fact.accepted' AND EXISTS (
                 SELECT 1 FROM truth.accepted_facts fact
                  WHERE fact.id = event.aggregate_id AND fact.subject_id = $1
                    AND fact.predicate = 'initiative.primary_objective'))) AS outbox
         FROM truth.claims WHERE subject_type = 'initiative' AND subject_id = $1
           AND predicate = 'initiative.primary_objective'`,
        [workflow.initiativeId, claimId]
      );
      expect([
        {
          proposed: 0,
          accepted_claims: 1,
          superseded: 0,
          facts: 1,
          recoveries: 0,
          commands: 1,
          audits: 1,
          outbox: 1
        },
        {
          proposed: 1,
          accepted_claims: 0,
          superseded: 1,
          facts: 0,
          recoveries: 1,
          commands: 1,
          audits: 1,
          outbox: 1
        }
      ]).toContainEqual(durable.rows[0]);
    }
  }, 15_000);

  it("makes cross-tenant, unauthorized, and missing reads identical without protected leakage", async () => {
    const unavailable = await getAs("tenant-b-viewer", initiativeId);
    const missing = await getAs("tenant-a-owner", "70000000-0000-7000-8000-000000000999");
    expect(unavailable.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(unavailable.body).toBe(missing.body);
    for (const protectedValue of [objective, excerpt, "Owner A", sourceArtifactId, initiativeId]) {
      expect(unavailable.body).not.toContain(protectedValue);
    }
  });

  it("lets a same-Space viewer read but denies acceptance generically without durable writes", async () => {
    const workflow = await createWorkflow("same-space-viewer-denied-accept");
    await postAs("tenant-a-owner", workflow.initiativeId, "source", { note });
    await postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true
    });
    const access = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES
         ($1,$2,'membership',$3,'viewer','space',$4,'direct'),
         ($1,$2,'membership',$3,'viewer','space',$5,'direct'),
         ($1,$2,'membership',$3,'viewer','space',$6,'direct')
       RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        workflow.organizationSpaceId,
        workflow.initiativeSpaceId,
        workflow.activitySpaceId
      ]
    );
    try {
      const readable = await sameTenantViewerApp.inject({
        method: "GET",
        url: `/v1/demo/initiatives/${workflow.initiativeId}/trusted-objective`
      });
      expect(readable.statusCode, readable.body).toBe(200);
      expect(readable.json()).toMatchObject({ state: "proposed", proposal: { objective } });
      const visibleProposal = readable.json();

      const before = await durableWriteCount();
      const denied = await sameTenantViewerApp.inject({
        method: "POST",
        url: `/v1/demo/initiatives/${workflow.initiativeId}/trusted-objective/accept`,
        payload: {
          claimId: visibleProposal.proposal.claimId,
          expectedClaimVersion: visibleProposal.proposal.version,
          expectedInitiativeVersion: visibleProposal.initiative.version
        }
      });
      const deniedRecovery = await sameTenantViewerApp.inject({
        method: "POST",
        url: `/v1/demo/initiatives/${workflow.initiativeId}/trusted-objective/proposal/withdraw`,
        payload: {
          claimId: visibleProposal.proposal.claimId,
          expectedClaimVersion: 1,
          expectedInitiativeVersion: visibleProposal.initiative.version,
          disposition: "withdrawn",
          reasonCode: "needs_rework"
        }
      });
      const missing = await ownerApp.inject({
        method: "POST",
        url: "/v1/demo/initiatives/70000000-0000-7000-8000-000000000997/trusted-objective/accept",
        payload: {
          claimId: "70000000-0000-7000-8000-000000000998",
          expectedClaimVersion: 1,
          expectedInitiativeVersion: 1
        }
      });

      expect(denied.statusCode).toBe(404);
      expect(deniedRecovery.statusCode).toBe(404);
      expect(denied.body).toBe(missing.body);
      expect(deniedRecovery.body).toBe(missing.body);
      expect(await durableWriteCount()).toBe(before);
      await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 1, accepted: 0 });
    } finally {
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = ANY($1::uuid[])", [
        access.rows.map(({ id }) => id)
      ]);
    }
  });

  it.each([
    ["x-throughline-dev-identity", "tenant-a-owner"],
    ["x-throughline-dev-identity", "tenant-b-viewer"],
    ["x-throughline-tenant-id", devFixtures.tenantA],
    ["role", "owner"]
  ])(
    "rejects request authority injection through %s without a durable write",
    async (header, value) => {
      const before = await durableWriteCount();
      const response = await unavailableApp.inject({
        method: "POST",
        url: `/v1/demo/initiatives/${initiativeId}/trusted-objective/accept`,
        headers: { [header]: value },
        payload: {}
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        statusCode: 401,
        message: "Authentication is unavailable",
        error: "Unauthorized"
      });
      expect(await durableWriteCount()).toBe(before);
    }
  );

  it("rejects client evidence/authority fields and drafts deterministically without a write or send", async () => {
    const tampered = await postAs("tenant-a-owner", initiativeId, "proposal", {
      objective,
      exactExcerpt: excerpt,
      supportConfirmed: true,
      sourceContentHash: "0".repeat(64),
      accessClass: "public",
      acceptedByUserId: devFixtures.userA
    });
    expect(tampered.statusCode).toBe(400);

    const before = await durableWriteCount();
    const [first, second] = await Promise.all([
      postAs("tenant-a-owner", initiativeId, "draft-confirmation", {}),
      postAs("tenant-a-owner", initiativeId, "draft-confirmation", {})
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(first.json()).toEqual({
      question: `Can you confirm that our primary objective is: “${objective}”?`,
      sent: false,
      status: "Not sent"
    });
    expect(await durableWriteCount()).toBe(before);
  });

  it("blocks correction and deletion of accepted evidence while preserving trusted memory", async () => {
    await expect(
      accountBus.execute(
        {
          kind: "source.correct",
          idempotencyKey: "trusted-objective-correction",
          payload: {
            predecessorSourceArtifactId: sourceArtifactId,
            activityId,
            sourceType: "note",
            title: "Corrected engagement note",
            text: "Corrected note: the objective requires a new review."
          }
        },
        createDevSecurityContext("tenant-a-owner")
      )
    ).rejects.toBeInstanceOf(B1CommandInvariantError);

    const afterCorrectionAttempt = await getAs("tenant-a-owner", initiativeId);
    expect(afterCorrectionAttempt.statusCode).toBe(200);
    expect(afterCorrectionAttempt.json()).toMatchObject({
      state: "accepted",
      proposal: null,
      acceptedMemory: {
        objective,
        exactExcerpt: excerpt,
        status: "Accepted"
      }
    });

    await expect(
      accountBus.execute(
        {
          kind: "source.tombstone",
          idempotencyKey: "trusted-objective-tombstone",
          payload: {
            sourceArtifactId,
            expectedVersion: 1,
            deletionReasonCategory: "demo_reset",
            deletionPolicyRef: "demo-policy-v1"
          }
        },
        createDevSecurityContext("tenant-a-owner")
      )
    ).rejects.toBeInstanceOf(B1CommandInvariantError);

    const afterDeletionAttempt = await getAs("tenant-a-owner", initiativeId);
    expect(afterDeletionAttempt.statusCode).toBe(200);
    expect(afterDeletionAttempt.json()).toMatchObject({
      state: "accepted",
      proposal: null,
      acceptedMemory: {
        objective,
        exactExcerpt: excerpt,
        status: "Accepted"
      }
    });
  });

  it("fails accepted-memory projection closed with the generic unavailable response", async () => {
    const fact = await ownerPool.query<{ id: string; access_class: string }>(
      `SELECT id, access_class FROM truth.accepted_facts
       WHERE subject_type = 'initiative' AND subject_id = $1
         AND predicate = 'initiative.primary_objective' AND status = 'current'`,
      [initiativeId]
    );
    expect(fact.rows).toHaveLength(1);
    const acceptedFact = fact.rows[0]!;

    const corruptAccessClass =
      acceptedFact.access_class === "confidential" ? "public" : "confidential";
    await ownerPool.query(
      "ALTER TABLE truth.accepted_facts DISABLE TRIGGER accepted_facts_immutable"
    );
    try {
      await ownerPool.query(`UPDATE truth.accepted_facts SET access_class = $2 WHERE id = $1`, [
        acceptedFact.id,
        corruptAccessClass
      ]);
    } finally {
      await ownerPool.query(
        "ALTER TABLE truth.accepted_facts ENABLE TRIGGER accepted_facts_immutable"
      );
    }
    const unprojectable = await getAs("tenant-a-owner", initiativeId);
    const missing = await getAs("tenant-a-owner", "70000000-0000-7000-8000-000000000998");

    expect(unprojectable.statusCode).toBe(404);
    expect(unprojectable.body).toBe(missing.body);
    for (const protectedValue of [objective, excerpt, "Owner A", acceptedFact.id]) {
      expect(unprojectable.body).not.toContain(protectedValue);
    }
  });

  function getAs(identity: "tenant-a-owner" | "tenant-b-viewer", id: string) {
    return appFor(identity).inject({
      method: "GET",
      url: `/v1/demo/initiatives/${id}/trusted-objective`
    });
  }

  async function postAs(
    identity: "tenant-a-owner" | "tenant-b-viewer",
    id: string,
    action: string,
    payload: Record<string, unknown>
  ) {
    let exactPayload = payload;
    const needsObservedState =
      (action === "proposal" &&
        (payload.proposalGenerationAnchor === undefined ||
          payload.sourceRevisionAnchor === undefined)) ||
      (action === "proposal/rework" && payload.sourceRevisionAnchor === undefined) ||
      (action === "accept" &&
        (payload.claimId === undefined ||
          payload.expectedClaimVersion === undefined ||
          payload.expectedInitiativeVersion === undefined));
    if (needsObservedState) {
      const observed = await getAs(identity, id);
      if (observed.statusCode === 200) {
        const state = observed.json();
        exactPayload =
          action === "accept"
            ? {
                ...payload,
                claimId: state.proposal?.claimId,
                expectedClaimVersion: state.proposal?.version,
                expectedInitiativeVersion: state.initiative?.version
              }
            : {
                ...payload,
                ...(action === "proposal" && payload.proposalGenerationAnchor === undefined
                  ? { proposalGenerationAnchor: state.proposalGenerationAnchor }
                  : {}),
                ...(payload.sourceRevisionAnchor === undefined
                  ? { sourceRevisionAnchor: state.sourceRevisionAnchor }
                  : {})
              };
      }
    }
    return appFor(identity).inject({
      method: "POST",
      url: `/v1/demo/initiatives/${id}/trusted-objective/${action}`,
      payload: exactPayload
    });
  }

  function appFor(identity: "tenant-a-owner" | "tenant-b-viewer") {
    return identity === "tenant-a-owner" ? ownerApp : unavailableApp;
  }

  async function createApiForPersona(
    persona: "owner" | "unavailable"
  ): Promise<NestFastifyApplication> {
    process.env.TRUSTED_OBJECTIVE_DEMO_PERSONA = persona;
    const configuredApp = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false })
    );
    await configuredApp.init();
    return configuredApp;
  }

  async function createApiWithContext(
    context: ReturnType<typeof createDevSecurityContext>
  ): Promise<NestFastifyApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(TrustedObjectiveGuard)
      .useValue({
        canActivate(executionContext: {
          switchToHttp(): { getRequest(): TrustedObjectiveRequest };
        }): boolean {
          executionContext.switchToHttp().getRequest().trustedObjectiveContext = context;
          return true;
        }
      })
      .compile();
    const configuredApp = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false })
    );
    await configuredApp.init();
    return configuredApp;
  }

  async function durableWriteCount(): Promise<string> {
    const result = await ownerPool.query<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM ops.domain_command_records) +
         (SELECT count(*) FROM ops.audit_events) +
         (SELECT count(*) FROM ops.product_outbox_events)
       )::text AS count`
    );
    return result.rows[0]!.count;
  }

  async function objectiveEffectCount(): Promise<string> {
    const result = await ownerPool.query<{ counts: string }>(
      `SELECT jsonb_build_array(
         (SELECT count(*) FROM truth.claims),
         (SELECT count(*) FROM truth.verified_evidence_spans),
         (SELECT count(*) FROM truth.initiative_objective_support_attestations),
         (SELECT count(*) FROM truth.initiative_objective_proposal_recoveries),
         (SELECT count(*) FROM ops.domain_command_records),
         (SELECT count(*) FROM ops.audit_events),
         (SELECT count(*) FROM ops.product_outbox_events)
       )::text AS counts`
    );
    return result.rows[0]!.counts;
  }

  async function loadClaimEvidence(claimId: string): Promise<ClaimSourceSpanCandidate> {
    const result = await ownerPool.query<{
      source_artifact_id: string;
      source_chunk_id: string;
      source_version: number;
      chunk_version: 1;
      normalization_version: "source-normalization.v1";
      chunking_version: "source-chunking.v1";
      source_start_offset: number;
      source_end_offset: number;
      source_excerpt: string;
      source_content_hash: string;
      source_normalized_content_hash: string;
      chunk_content_hash: string;
      excerpt_hash: string;
    }>(
      `SELECT span.source_artifact_id, span.source_chunk_id, span.source_version,
              span.chunk_version, span.normalization_version, span.chunking_version,
              span.source_start_offset, span.source_end_offset, span.source_excerpt,
              span.source_content_hash, span.source_normalized_content_hash,
              span.chunk_content_hash, span.excerpt_hash
       FROM truth.claims claim
       JOIN truth.verified_evidence_spans span ON span.id = claim.verified_evidence_span_id
        AND span.tenant_id = claim.tenant_id AND span.workspace_id = claim.workspace_id
       WHERE claim.id = $1`,
      [claimId]
    );
    const row = result.rows[0]!;
    return {
      sourceArtifactId: row.source_artifact_id,
      sourceChunkId: row.source_chunk_id,
      expectedSourceVersion: row.source_version,
      expectedChunkVersion: row.chunk_version,
      normalizationVersion: row.normalization_version,
      chunkingVersion: row.chunking_version,
      startOffset: row.source_start_offset,
      endOffset: row.source_end_offset,
      excerpt: row.source_excerpt,
      sourceContentHash: row.source_content_hash,
      sourceNormalizedContentHash: row.source_normalized_content_hash,
      chunkContentHash: row.chunk_content_hash,
      excerptHash: row.excerpt_hash
    };
  }

  async function createWorkflow(key: string): Promise<{
    organizationSpaceId: string;
    initiativeId: string;
    initiativeSpaceId: string;
    activityId: string;
    activitySpaceId: string;
  }> {
    const organization = await accountBus.execute(
      {
        kind: "organization.create",
        idempotencyKey: `${key}-organization`,
        payload: { name: `Northstar ${key}`, domains: [`${key}.example`] }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    const initiative = await accountBus.execute(
      {
        kind: "initiative.create",
        idempotencyKey: `${key}-initiative`,
        payload: {
          primaryOrganizationId: organization.organizationId,
          title: `Resident Service Response ${key}`,
          typeKey: "application",
          stageKey: "workshop"
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    const activity = await accountBus.execute(
      {
        kind: "activity.create",
        idempotencyKey: `${key}-activity`,
        payload: {
          title: `Resident services discovery ${key}`,
          profileTemplateKey: "discovery",
          status: "completed",
          governingInitiativeId: initiative.initiativeId,
          organizationIds: [organization.organizationId],
          initiativeIds: [initiative.initiativeId]
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    const persistedOrganization = await ownerPool.query<{ space_id: string }>(
      `SELECT space_id FROM work.organizations
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [devFixtures.tenantA, devFixtures.workspaceA, organization.organizationId]
    );
    const persistedInitiative = await ownerPool.query<{ space_id: string }>(
      `SELECT space_id FROM work.initiatives
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [devFixtures.tenantA, devFixtures.workspaceA, initiative.initiativeId]
    );
    const persistedActivity = await ownerPool.query<{ space_id: string }>(
      `SELECT space_id FROM work.activities
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [devFixtures.tenantA, devFixtures.workspaceA, activity.activityId]
    );
    return {
      organizationSpaceId: persistedOrganization.rows[0]!.space_id,
      initiativeId: initiative.initiativeId,
      initiativeSpaceId: persistedInitiative.rows[0]!.space_id,
      activityId: activity.activityId,
      activitySpaceId: persistedActivity.rows[0]!.space_id
    };
  }

  async function expectPrimaryObjectiveCounts(
    subjectId: string,
    expected: { proposed: number; accepted: number }
  ): Promise<void> {
    const result = await ownerPool.query<{ proposed: number; accepted: number }>(
      `SELECT
         (SELECT count(*)::integer FROM truth.claims
          WHERE subject_type = 'initiative' AND subject_id = $1
            AND predicate = 'initiative.primary_objective' AND status = 'proposed') AS proposed,
         (SELECT count(*)::integer FROM truth.accepted_facts
          WHERE subject_type = 'initiative' AND subject_id = $1
            AND predicate = 'initiative.primary_objective' AND status IN ('current', 'contested'))
           AS accepted`,
      [subjectId]
    );
    expect(result.rows[0]).toEqual(expected);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
