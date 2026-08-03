import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
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
  type PgPool
} from "@throughline/db";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";
import { TrustedObjectiveGuard, type TrustedObjectiveRequest } from "./trusted-objective.guard.js";

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
      postAs("tenant-a-owner", initiativeId, "proposal", { objective, exactExcerpt: excerpt }),
      postAs("tenant-a-owner", initiativeId, "proposal", { objective, exactExcerpt: excerpt })
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
        exactExcerpt: excerpt
      }),
      postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
        objective: competingObjective,
        exactExcerpt: excerpt
      })
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 1, accepted: 0 });
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
      exactExcerpt: excerpt
    });
    expect(proposed.statusCode, proposed.body).toBe(201);

    const responses = await Promise.all([
      postAs("tenant-a-owner", workflow.initiativeId, "accept", {}),
      postAs("tenant-a-owner", workflow.initiativeId, "proposal", {
        objective: `${objective} Competing revision.`,
        exactExcerpt: excerpt
      })
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    await expectPrimaryObjectiveCounts(workflow.initiativeId, { proposed: 0, accepted: 1 });
  });

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
      exactExcerpt: excerpt
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

      const before = await durableWriteCount();
      const denied = await sameTenantViewerApp.inject({
        method: "POST",
        url: `/v1/demo/initiatives/${workflow.initiativeId}/trusted-objective/accept`,
        payload: {}
      });
      const missing = await ownerApp.inject({
        method: "POST",
        url: "/v1/demo/initiatives/70000000-0000-7000-8000-000000000997/trusted-objective/accept",
        payload: {}
      });

      expect(denied.statusCode).toBe(404);
      expect(denied.body).toBe(missing.body);
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

  function postAs(
    identity: "tenant-a-owner" | "tenant-b-viewer",
    id: string,
    action: string,
    payload: Record<string, unknown>
  ) {
    return appFor(identity).inject({
      method: "POST",
      url: `/v1/demo/initiatives/${id}/trusted-objective/${action}`,
      payload
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
