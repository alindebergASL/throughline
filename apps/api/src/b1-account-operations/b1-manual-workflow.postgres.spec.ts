import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AccountOperationsDomainCommandBus } from "@throughline/account-operations";
import {
  PostgresAuthorizationService,
  type TransactionAwareAuthorizationService
} from "@throughline/authorization";
import {
  ContentInvariantError,
  ContentRepository,
  normalizeAndChunkSource
} from "@throughline/content";
import {
  AuditEventRepository,
  DomainCommandRepository,
  ProductDomainTransactionRepositories,
  applyMigrations,
  createPgPool,
  hashCanonicalCommandRequest,
  provisionTestAppRole,
  provisionWorkspaceProductRelayPrincipal,
  seedWaveA2DeterministicData,
  withTenantTransaction,
  type PgPool,
  type PgPoolClient,
  type TenantDbTransaction
} from "@throughline/db";
import { createDevSecurityContext, devFixtures } from "@throughline/tenancy";
import { WorkGraphRepository } from "@throughline/work-graph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";
import { listAuthorizedActivitySources } from "./b1-account-operations.runtime.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const authoritative = process.env.B1_AUTHORITATIVE_GATE === "1";
const configured = Boolean(ownerUrl && appUrl);
const suite = configured || authoritative ? describe.sequential : describe.skip;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

interface WorkflowState {
  organizationId: string;
  initiativeId: string;
  activityId: string;
  sourceArtifactId: string;
  sourceSpaceId: string;
}

suite("Wave B1 manual no-integration API and PostgreSQL gate", () => {
  let ownerPool: PgPool;
  let appPool: PgPool;
  let app: NestFastifyApplication;
  let priorDatabaseUrl: string | undefined;
  let priorAdapter: string | undefined;
  let state: WorkflowState;

  beforeAll(async () => {
    if (!ownerUrl || !appUrl) throw new Error("B1 PostgreSQL gate requires owner and app DSNs");
    ownerPool = createPgPool(ownerUrl);
    appPool = createPgPool(appUrl);
    await applyMigrations(ownerPool, { reset: true });
    await seedWaveA2DeterministicData(ownerPool);
    await ownerPool.query(
      `UPDATE identity.workspaces SET default_access_class = 'restricted'
       WHERE tenant_id = $1 AND id = $2`,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    await ownerPool.query(
      `UPDATE access.spaces SET access_class = 'restricted'
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.rootSpaceA]
    );
    await provisionTestAppRole(ownerPool, appUrl);
    await ownerTransaction(ownerPool, async (tx) => {
      await provisionWorkspaceProductRelayPrincipal(tx, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA
      });
    });

    priorDatabaseUrl = process.env.DATABASE_URL;
    priorAdapter = process.env.AUTH_ADAPTER;
    process.env.DATABASE_URL = appUrl;
    process.env.AUTH_ADAPTER = "dev";
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false })
    );
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    restoreEnvironment("DATABASE_URL", priorDatabaseUrl);
    restoreEnvironment("AUTH_ADAPTER", priorAdapter);
  });

  it("installs the additive B1 catalog with forced RLS and disjoint role privileges", async () => {
    const catalog = await ownerPool.query<{
      b1_tables: string;
      unsecured: string;
      migration_count: string;
      duplicate_ledger: string | null;
    }>(
      `SELECT
        (SELECT count(*)::text FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('work','content') AND relation.relkind = 'r') AS b1_tables,
        (SELECT count(*)::text FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('work','content') AND relation.relkind = 'r'
            AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)) AS unsecured,
        (SELECT count(*)::text FROM throughline_migrations.journal) AS migration_count,
        to_regclass('ops.domain_events')::text AS duplicate_ledger`
    );
    expect(catalog.rows[0]).toEqual({
      b1_tables: "15",
      unsecured: "0",
      migration_count: "6",
      duplicate_ledger: null
    });
    const privileges = await ownerPool.query<{
      app_source_delete: boolean;
      app_revision_update: boolean;
      product_source_read: boolean;
      foundation_source_read: boolean;
      worker_source_read: boolean;
      app_chunk_delete: boolean;
      all_roles_no_bypass: boolean;
    }>(
      `SELECT
        has_table_privilege('throughline_app','content.source_artifacts','DELETE') AS app_source_delete,
        has_table_privilege('throughline_app','content.content_revisions','UPDATE') AS app_revision_update,
        has_table_privilege('throughline_product_relay','content.source_artifacts','SELECT') AS product_source_read,
        has_table_privilege('throughline_relay','content.source_artifacts','SELECT') AS foundation_source_read,
        has_table_privilege('throughline_worker','content.source_artifacts','SELECT') AS worker_source_read,
        has_table_privilege('throughline_app','content.source_chunks','DELETE') AS app_chunk_delete,
        NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN (
          'throughline_app','throughline_product_relay','throughline_relay',
          'throughline_worker','throughline_b1_0_integrity'
        ) AND rolbypassrls) AS all_roles_no_bypass`
    );
    expect(privileges.rows[0]).toEqual({
      app_source_delete: false,
      app_revision_update: false,
      product_source_read: false,
      foundation_source_read: false,
      worker_source_read: false,
      app_chunk_delete: true,
      all_roles_no_bypass: true
    });
    const activitySecurity = await ownerPool.query<{
      table_update: boolean;
      id_update: boolean;
      update_columns: string[];
      direct_update_columns: string[];
      grant_option_columns: string[];
      public_update_paths: string;
      inherited_update_roles: string[];
      app_bypass_rls: boolean;
      app_owns_activity: boolean;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      `WITH RECURSIVE inherited_roles(role_id) AS (
         SELECT membership.roleid FROM pg_auth_members membership
         WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname = 'throughline_app')
         UNION
         SELECT membership.roleid FROM pg_auth_members membership
         JOIN inherited_roles inherited ON membership.member = inherited.role_id
       )
       SELECT
         has_table_privilege('throughline_app','work.activities','UPDATE') AS table_update,
         has_column_privilege('throughline_app','work.activities','id','UPDATE') AS id_update,
         ARRAY(
           SELECT column_record.column_name::text
           FROM information_schema.columns column_record
           WHERE column_record.table_schema = 'work' AND column_record.table_name = 'activities'
             AND has_column_privilege(
               'throughline_app', 'work.activities', column_record.column_name, 'UPDATE'
             )
           ORDER BY column_record.ordinal_position
         ) AS update_columns,
         ARRAY(
           SELECT privilege.column_name::text
           FROM information_schema.column_privileges privilege
           WHERE privilege.table_schema = 'work' AND privilege.table_name = 'activities'
             AND privilege.grantee = 'throughline_app' AND privilege.privilege_type = 'UPDATE'
           ORDER BY privilege.column_name
         ) AS direct_update_columns,
         ARRAY(
           SELECT privilege.column_name::text
           FROM information_schema.column_privileges privilege
           WHERE privilege.table_schema = 'work' AND privilege.table_name = 'activities'
             AND privilege.grantee = 'throughline_app' AND privilege.privilege_type = 'UPDATE'
             AND privilege.is_grantable = 'YES'
           ORDER BY privilege.column_name
         ) AS grant_option_columns,
         (
           SELECT count(*)::text FROM (
             SELECT table_privilege.privilege_type
             FROM information_schema.table_privileges table_privilege
             WHERE table_privilege.table_schema = 'work'
               AND table_privilege.table_name = 'activities'
               AND table_privilege.grantee = 'PUBLIC'
               AND table_privilege.privilege_type = 'UPDATE'
             UNION ALL
             SELECT column_privilege.privilege_type
             FROM information_schema.column_privileges column_privilege
             WHERE column_privilege.table_schema = 'work'
               AND column_privilege.table_name = 'activities'
               AND column_privilege.grantee = 'PUBLIC'
               AND column_privilege.privilege_type = 'UPDATE'
           ) public_update
         ) AS public_update_paths,
         ARRAY(
           SELECT role_record.rolname::text FROM inherited_roles inherited
           JOIN pg_roles role_record ON role_record.oid = inherited.role_id
           WHERE has_table_privilege(role_record.oid, 'work.activities', 'UPDATE')
             OR EXISTS (
               SELECT 1 FROM information_schema.columns column_record
               WHERE column_record.table_schema = 'work'
                 AND column_record.table_name = 'activities'
                 AND has_column_privilege(
                   role_record.oid, 'work.activities', column_record.column_name, 'UPDATE'
                 )
             )
           ORDER BY role_record.rolname
         ) AS inherited_update_roles,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'throughline_app') AS app_bypass_rls,
         activity.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'throughline_app')
           AS app_owns_activity,
         activity.relrowsecurity AS rls_enabled,
         activity.relforcerowsecurity AS rls_forced
       FROM pg_class activity
       WHERE activity.oid = 'work.activities'::regclass`
    );
    expect(activitySecurity.rows[0]).toEqual({
      table_update: false,
      id_update: true,
      update_columns: ["id"],
      direct_update_columns: ["id"],
      grant_option_columns: [],
      public_update_paths: "0",
      inherited_update_roles: [],
      app_bypass_rls: false,
      app_owns_activity: false,
      rls_enabled: true,
      rls_forced: true
    });
    const activityUpdatePolicies = await ownerPool.query<{
      policy_name: string;
      permissive: boolean;
      command: string;
      role_names: string[];
      using_expression: string;
      check_expression: string;
    }>(
      `SELECT policy.polname AS policy_name, policy.polpermissive AS permissive,
              policy.polcmd AS command,
              ARRAY(
                SELECT role_record.rolname::text
                FROM unnest(policy.polroles) AS policy_role(role_id)
                JOIN pg_roles role_record ON role_record.oid = policy_role.role_id
                ORDER BY role_record.rolname
              ) AS role_names,
              pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
              pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
       FROM pg_policy policy
       WHERE policy.polrelid = 'work.activities'::regclass AND policy.polcmd = 'w'
         AND (SELECT oid FROM pg_roles WHERE rolname = 'throughline_app') = ANY(policy.polroles)
       ORDER BY policy.polname`
    );
    expect(activityUpdatePolicies.rows).toHaveLength(2);
    expect(activityUpdatePolicies.rows).toEqual([
      expect.objectContaining({
        policy_name: "activities_app_permanent_no_write",
        permissive: false,
        command: "w",
        role_names: ["throughline_app"],
        using_expression: "true",
        check_expression: "false"
      }),
      expect.objectContaining({
        policy_name: "activities_app_source_capture_lock",
        permissive: true,
        command: "w",
        role_names: ["throughline_app"],
        check_expression: "false"
      })
    ]);
    const scopedPolicy = activityUpdatePolicies.rows[1]!.using_expression;
    for (const predicate of [
      "tenant_id = ops.current_tenant_id()",
      "workspace_id = ops.current_workspace_id()",
      "space_id = ops.current_space_id()",
      "archived_at IS NULL"
    ]) {
      expect(scopedPolicy).toContain(predicate);
    }
    for (const eligibleStatus of [
      "'planned'::text",
      "'in_progress'::text",
      "'captured'::text",
      "'review_pending'::text",
      "'completed'::text"
    ]) {
      expect(scopedPolicy).toContain(eligibleStatus);
    }
    const activityPolicyCommands = await ownerPool.query<{ command: string; count: string }>(
      `SELECT policy.polcmd AS command, count(*)::text AS count
       FROM pg_policy policy
       WHERE policy.polrelid = 'work.activities'::regclass
         AND (SELECT oid FROM pg_roles WHERE rolname = 'throughline_app') = ANY(policy.polroles)
       GROUP BY policy.polcmd ORDER BY policy.polcmd`
    );
    expect(activityPolicyCommands.rows).toEqual([
      { command: "a", count: "1" },
      { command: "r", count: "1" },
      { command: "w", count: "2" }
    ]);
    const noContext = await appPool.query<{ organizations: string; sources: string }>(
      `SELECT
        (SELECT count(*)::text FROM work.organizations) AS organizations,
        (SELECT count(*)::text FROM content.source_artifacts) AS sources`
    );
    expect(noContext.rows[0]).toEqual({ organizations: "0", sources: "0" });
  });

  it("accepts only the closed ten production B1 v1 command shapes", async () => {
    const resultId = "70000000-0000-7000-8000-000000000001";
    const validations = await ownerPool.query<{
      fixture: boolean;
      source_v2: boolean;
      typo: boolean;
      unknown: boolean;
      create_one: boolean;
      create_later_revision: boolean;
      create_later_version: boolean;
      revise_later: boolean;
    }>(
      `SELECT
        ops.b1_command_record_valid(
          'b1_0.fixture.v1', 1, 'completed', 'fixture', $1, '{}'::jsonb
        ) AS fixture,
        ops.b1_command_record_valid(
          'source.capture.v2', 2, 'reserved', NULL, NULL, NULL
        ) AS source_v2,
        ops.b1_command_record_valid(
          'source.captuer.v1', 1, 'reserved', NULL, NULL, NULL
        ) AS typo,
        ops.b1_command_record_valid(
          'unknown.command.v1', 1, 'reserved', NULL, NULL, NULL
        ) AS unknown,
        ops.b1_command_record_valid(
          'content.create.v1', 1, 'completed', 'content_item', $1,
          jsonb_build_object('contentItemId',$1::text,'revisionNumber',1,'version',1)
        ) AS create_one,
        ops.b1_command_record_valid(
          'content.create.v1', 1, 'completed', 'content_item', $1,
          jsonb_build_object('contentItemId',$1::text,'revisionNumber',2,'version',1)
        ) AS create_later_revision,
        ops.b1_command_record_valid(
          'content.create.v1', 1, 'completed', 'content_item', $1,
          jsonb_build_object('contentItemId',$1::text,'revisionNumber',1,'version',2)
        ) AS create_later_version,
        ops.b1_command_record_valid(
          'content.revise.v1', 1, 'completed', 'content_item', $1,
          jsonb_build_object('contentItemId',$1::text,'revisionNumber',2,'version',2)
        ) AS revise_later`,
      [resultId]
    );
    expect(validations.rows[0]).toEqual({
      fixture: false,
      source_v2: false,
      typo: false,
      unknown: false,
      create_one: true,
      create_later_revision: false,
      create_later_version: false,
      revise_later: true
    });

    const catalog = await ownerPool.query<{ definitions: string }>(
      `SELECT concat_ws(E'\n',
         pg_get_functiondef('ops.b1_command_record_valid(text,integer,text,text,uuid,jsonb)'::regprocedure),
         pg_get_functiondef('ops.require_b1_command_atomicity()'::regprocedure),
         (SELECT string_agg(pg_get_constraintdef(constraint_record.oid), E'\n')
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid = 'ops.domain_command_records'::regclass),
         (SELECT string_agg(pg_get_triggerdef(trigger_record.oid), E'\n')
          FROM pg_trigger trigger_record
          WHERE trigger_record.tgrelid = 'ops.domain_command_records'::regclass
            AND NOT trigger_record.tgisinternal)
       ) AS definitions`
    );
    expect(catalog.rows[0]!.definitions).not.toMatch(
      /b1_0\.fixture\.v1|test[_ .-]*(?:command|bypass)/i
    );
  });

  it("rejects unknown commands, arbitrary results, and completion without exact companions with zero residue", async () => {
    const context = {
      ...createDevSecurityContext("tenant-a-owner"),
      requestedSpaceIds: [devFixtures.restrictedSpaceA]
    };
    const rejectedKeys = [
      "unknown-command-reservation",
      "test-command-reservation",
      "unknown-command-completion",
      "arbitrary-command-result",
      "missing-command-companions"
    ];
    const baseReservation = {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      reservationSpaceId: devFixtures.restrictedSpaceA,
      commandSchemaVersion: 1,
      canonicalRequestHash: hashCanonicalCommandRequest({ proof: "closed-command-catalog" }),
      actorUserId: context.actorUserId!,
      actorMembershipId: context.actorMembershipId!,
      policyVersionId: context.policyVersion,
      requestId: context.requestId,
      traceparent
    };

    for (const [index, commandKind] of ["unknown.command.v1", "b1_0.fixture.v1"].entries()) {
      await expect(
        withTenantTransaction({ pool: appPool, context }, (tx) =>
          new DomainCommandRepository(tx).reserve({
            ...baseReservation,
            id: `78000000-0000-7000-8000-00000000000${index + 1}`,
            commandKind,
            idempotencyKey: rejectedKeys[index]!
          })
        )
      ).rejects.toMatchObject({ code: "23514" });
    }

    await expect(
      withTenantTransaction({ pool: appPool, context }, async (tx) => {
        const commands = new DomainCommandRepository(tx);
        await commands.reserve({
          ...baseReservation,
          id: "78000000-0000-7000-8000-000000000003",
          commandKind: "relationship.create.v1",
          idempotencyKey: rejectedKeys[2]!
        });
        await commands.complete({
          commandId: "78000000-0000-7000-8000-000000000003",
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          reservationSpaceId: devFixtures.restrictedSpaceA,
          commandKind: "b1_0.fixture.v1",
          idempotencyKey: rejectedKeys[2]!,
          canonicalRequestHash: baseReservation.canonicalRequestHash,
          resultResourceType: "relationship",
          resultResourceId: "78000000-0000-7000-8000-000000000013",
          safeResponse: {
            relationshipId: "78000000-0000-7000-8000-000000000013",
            spaceId: devFixtures.restrictedSpaceA,
            version: 1
          }
        });
      })
    ).rejects.toThrow();

    await expect(
      withTenantTransaction({ pool: appPool, context }, async (tx) => {
        const commands = new DomainCommandRepository(tx);
        await commands.reserve({
          ...baseReservation,
          id: "78000000-0000-7000-8000-000000000004",
          commandKind: "relationship.create.v1",
          idempotencyKey: rejectedKeys[3]!
        });
        await tx.query(
          `UPDATE ops.domain_command_records
           SET state = 'completed', result_resource_type = 'relationship',
               result_resource_id = $2, safe_response = $3::jsonb,
               completed_at = clock_timestamp()
           WHERE id = $1`,
          [
            "78000000-0000-7000-8000-000000000004",
            "78000000-0000-7000-8000-000000000014",
            JSON.stringify({ arbitrary: "must-not-persist" })
          ]
        );
      })
    ).rejects.toMatchObject({ code: "23514" });

    const companionlessRelationshipId = "78000000-0000-7000-8000-000000000015";
    await expect(
      withTenantTransaction({ pool: appPool, context }, async (tx) => {
        const commands = new DomainCommandRepository(tx);
        await commands.reserve({
          ...baseReservation,
          id: "78000000-0000-7000-8000-000000000005",
          commandKind: "relationship.create.v1",
          idempotencyKey: rejectedKeys[4]!
        });
        await new WorkGraphRepository(tx).createRelationship({
          id: companionlessRelationshipId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: devFixtures.restrictedSpaceA,
          subject: { type: "person", id: devFixtures.personA },
          predicate: "contributor_to",
          object: { type: "space", id: devFixtures.restrictedSpaceA },
          version: 1
        });
        await commands.complete({
          commandId: "78000000-0000-7000-8000-000000000005",
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          reservationSpaceId: devFixtures.restrictedSpaceA,
          commandKind: "relationship.create.v1",
          idempotencyKey: rejectedKeys[4]!,
          canonicalRequestHash: baseReservation.canonicalRequestHash,
          resultResourceType: "relationship",
          resultResourceId: companionlessRelationshipId,
          safeResponse: {
            relationshipId: companionlessRelationshipId,
            spaceId: devFixtures.restrictedSpaceA,
            version: 1
          }
        });
      })
    ).rejects.toThrow(/exactly one matching audit and product notification/);

    const residue = await ownerPool.query<{ commands: string; relationships: string }>(
      `SELECT
         (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key = ANY($1::text[])) AS commands,
         (SELECT count(*)::text FROM work.relationships WHERE id = $2) AS relationships`,
      [rejectedKeys, companionlessRelationshipId]
    );
    expect(residue.rows[0]).toEqual({ commands: "0", relationships: "0" });
  });

  it("rejects forged non-integer-one content-create counters at the PostgreSQL boundary", async () => {
    const resultId = "70000000-0000-7000-8000-000000000001";
    const valid = await ownerPool.query<{ valid: boolean }>(
      `SELECT ops.b1_command_record_valid(
         'content.create.v1', 1, 'completed', 'content_item', $1::uuid,
         jsonb_build_object('contentItemId',$1::uuid::text,'revisionNumber',1,'version',1)
       ) AS valid`,
      [resultId]
    );
    expect(valid.rows[0]).toEqual({ valid: true });

    const forged = await ownerPool.query<{
      field_name: string;
      case_name: string;
      valid: boolean;
    }>(
      `WITH adversarial(field_name, case_name, candidate) AS (
         VALUES
           ('revisionNumber','zero','0'::jsonb),
           ('revisionNumber','two','2'::jsonb),
           ('revisionNumber','negative','-1'::jsonb),
           ('revisionNumber','fractional_1_1','1.1'::jsonb),
           ('revisionNumber','fractional_1_5','1.5'::jsonb),
           ('revisionNumber','fractional_1_9','1.9'::jsonb),
           ('revisionNumber','string',to_jsonb('1'::text)),
           ('revisionNumber','null','null'::jsonb),
           ('revisionNumber','outside_integer_range','2147483648'::jsonb),
           ('version','zero','0'::jsonb),
           ('version','two','2'::jsonb),
           ('version','negative','-1'::jsonb),
           ('version','fractional_1_1','1.1'::jsonb),
           ('version','fractional_1_5','1.5'::jsonb),
           ('version','fractional_1_9','1.9'::jsonb),
           ('version','string',to_jsonb('1'::text)),
           ('version','null','null'::jsonb),
           ('version','outside_integer_range','2147483648'::jsonb)
       )
       SELECT field_name, case_name,
         ops.b1_command_record_valid(
           'content.create.v1', 1, 'completed', 'content_item', $1::uuid,
           jsonb_set(
             jsonb_build_object('contentItemId',$1::uuid::text,'revisionNumber',1,'version',1),
             ARRAY[field_name], candidate
           )
         ) AS valid
       FROM adversarial
       ORDER BY field_name, case_name`,
      [resultId]
    );
    expect(forged.rows).toHaveLength(18);
    expect(forged.rows.every(({ valid: accepted }) => accepted === false)).toBe(true);
  });

  it("walks Organization -> Initiative -> Engagement -> opaque UTF-8 Source with no integration", async () => {
    const organization = await post("/v1/organizations", "workflow-org", {
      name: "Harbor Transit",
      domains: ["harbor.example"]
    });
    expect(organization.statusCode).toBe(201);
    const organizationBody = organization.json<{ organizationId: string; spaceId: string }>();

    const initiative = await post("/v1/initiatives", "workflow-initiative", {
      primaryOrganizationId: organizationBody.organizationId,
      organizationIds: [organizationBody.organizationId],
      title: "AI governance readiness",
      typeKey: "governance",
      stageKey: "exploring"
    });
    expect(initiative.statusCode).toBe(201);
    const initiativeBody = initiative.json<{ initiativeId: string; spaceId: string }>();

    const activity = await post("/v1/activities", "workflow-activity", {
      title: "AI discovery workshop",
      profileTemplateKey: "ai_workshop",
      status: "captured",
      governingInitiativeId: initiativeBody.initiativeId,
      organizationIds: [organizationBody.organizationId],
      initiativeIds: [initiativeBody.initiativeId],
      attendeePersonIds: [devFixtures.externalPersonA]
    });
    expect(activity.statusCode).toBe(201);
    const activityBody = activity.json<{ activityId: string; spaceId: string }>();

    const opaqueTranscript = await readFile(
      new URL("../../../../tests/fixtures/transcripts/adversarial_injection.txt", import.meta.url),
      "utf8"
    );
    const source = await post(
      `/v1/activities/${activityBody.activityId}/sources`,
      "workflow-source",
      { sourceType: "transcript", title: "Workshop transcript", text: opaqueTranscript }
    );
    expect(source.statusCode).toBe(201);
    const sourceBody = source.json<{ sourceArtifactId: string; chunkCount: number }>();
    expect(sourceBody.chunkCount).toBeGreaterThan(0);
    const identicalRetry = await post(
      `/v1/activities/${activityBody.activityId}/sources`,
      "workflow-source",
      { sourceType: "transcript", title: "Workshop transcript", text: opaqueTranscript }
    );
    expect(identicalRetry.statusCode).toBe(201);
    expect(identicalRetry.json()).toEqual(sourceBody);
    const mismatchedRetry = await post(
      `/v1/activities/${activityBody.activityId}/sources`,
      "workflow-source",
      {
        sourceType: "transcript",
        title: "Workshop transcript",
        text: `${opaqueTranscript}\nchanged`
      }
    );
    expect(mismatchedRetry.statusCode).toBe(409);

    const [organizationRead, initiativeRead, activityRead, sourceList, sourceRead] =
      await Promise.all([
        get(`/v1/organizations/${organizationBody.organizationId}`),
        get(`/v1/initiatives/${initiativeBody.initiativeId}`),
        get(`/v1/activities/${activityBody.activityId}`),
        get(`/v1/activities/${activityBody.activityId}/sources`),
        get(`/v1/sources/${sourceBody.sourceArtifactId}`)
      ]);
    expect(organizationRead.statusCode).toBe(200);
    expect(initiativeRead.statusCode, initiativeRead.body).toBe(200);
    expect(initiativeRead.json<{ profileVersion: string }>().profileVersion).toBe("1.0.0");
    expect(activityRead.json<{ subtype: string; people: object[] }>()).toMatchObject({
      subtype: "ai_workshop",
      people: expect.arrayContaining([
        { id: devFixtures.personA, displayName: "Owner A", isInternal: true },
        { id: devFixtures.externalPersonA, displayName: "External Contact A", isInternal: false }
      ])
    });
    expect(sourceList.json<object[]>()).toHaveLength(1);
    const projectedSource = sourceRead.json<{
      immutableText: string;
      trustClass: string;
      chunks: Array<{ normalizedText: string }>;
      spaceId: string;
    }>();
    expect(projectedSource.trustClass).toBe("untrusted_user_content");
    expect(projectedSource.immutableText).toBe(opaqueTranscript);
    expect(projectedSource.chunks.map(({ normalizedText }) => normalizedText).join("")).toContain(
      "Ignore all previous security policies"
    );

    state = {
      organizationId: organizationBody.organizationId,
      initiativeId: initiativeBody.initiativeId,
      activityId: activityBody.activityId,
      sourceArtifactId: sourceBody.sourceArtifactId,
      sourceSpaceId: projectedSource.spaceId
    };

    const atomicCounts = await ownerPool.query<{
      commands: string;
      completed_commands: string;
      audits: string;
      outbox: string;
      canonical_outbox: string;
      source: string;
      chunks: string;
      links: string;
    }>(
      `SELECT
        (SELECT count(*) FROM ops.domain_command_records WHERE idempotency_key = 'workflow-source')::text AS commands,
        (SELECT count(*) FROM ops.domain_command_records
          WHERE idempotency_key = 'workflow-source' AND state = 'completed'
            AND command_kind = 'source.capture.v1')::text AS completed_commands,
        (SELECT count(*) FROM ops.audit_events audit JOIN ops.domain_command_records command
          ON command.tenant_id = audit.tenant_id AND command.workspace_id = audit.workspace_id
          AND command.id = audit.causation_command_id WHERE command.idempotency_key = 'workflow-source')::text AS audits,
        (SELECT count(*) FROM ops.product_outbox_events event JOIN ops.domain_command_records command
          ON command.tenant_id = event.tenant_id AND command.workspace_id = event.workspace_id
          AND command.id = event.causation_command_id WHERE command.idempotency_key = 'workflow-source')::text AS outbox,
        (SELECT count(*) FROM ops.product_outbox_events event
          JOIN ops.domain_command_records command ON command.tenant_id = event.tenant_id
           AND command.workspace_id = event.workspace_id AND command.id = event.causation_command_id
          WHERE command.idempotency_key = 'workflow-source'
            AND event.event_type = 'source_artifact.captured'
            AND event.aggregate_type = 'source_artifact')::text AS canonical_outbox,
        (SELECT count(*) FROM content.source_artifacts WHERE id = $1)::text AS source,
        (SELECT count(*) FROM content.source_chunks WHERE source_artifact_id = $1)::text AS chunks,
        (SELECT count(*) FROM work.activity_sources WHERE source_artifact_id = $1)::text AS links`,
      [sourceBody.sourceArtifactId]
    );
    expect(atomicCounts.rows[0]).toEqual({
      commands: "1",
      completed_commands: "1",
      audits: "1",
      outbox: "1",
      canonical_outbox: "1",
      source: "1",
      chunks: String(sourceBody.chunkCount),
      links: "1"
    });
    const unscoped = await appPool.query<{ organizations: string; sources: string }>(
      `SELECT
        (SELECT count(*)::text FROM work.organizations) AS organizations,
        (SELECT count(*)::text FROM content.source_artifacts) AS sources`
    );
    expect(unscoped.rows[0]).toEqual({ organizations: "0", sources: "0" });
    await expect(
      ownerPool.query(
        `UPDATE content.source_chunks SET normalized_text = 'tampered'
         WHERE source_artifact_id = $1`,
        [sourceBody.sourceArtifactId]
      )
    ).rejects.toThrow();
    await expect(
      ownerPool.query(`DELETE FROM content.source_artifacts WHERE id = $1`, [
        sourceBody.sourceArtifactId
      ])
    ).rejects.toThrow();
  }, 30_000);

  it("gives missing and unauthorized Source commands the same denial with rollback and zero residue", async () => {
    const before = await sourcePipelineCounts(ownerPool);
    const missingSourceId = "70000000-0000-7000-8000-000000009991";
    const bus = new AccountOperationsDomainCommandBus(appPool);
    const cases = [
      {
        name: "correction",
        missingKey: "oracle-missing-correction",
        deniedKey: "oracle-denied-correction",
        missing: {
          kind: "source.correct" as const,
          idempotencyKey: "oracle-missing-correction",
          payload: {
            predecessorSourceArtifactId: missingSourceId,
            sourceType: "human" as const,
            text: "Missing correction."
          }
        },
        denied: {
          kind: "source.correct" as const,
          idempotencyKey: "oracle-denied-correction",
          payload: {
            predecessorSourceArtifactId: state.sourceArtifactId,
            sourceType: "human" as const,
            text: "Denied correction."
          }
        }
      },
      {
        name: "tombstone",
        missingKey: "oracle-missing-tombstone",
        deniedKey: "oracle-denied-tombstone",
        missing: {
          kind: "source.tombstone" as const,
          idempotencyKey: "oracle-missing-tombstone",
          payload: {
            sourceArtifactId: missingSourceId,
            expectedVersion: 1,
            deletionReasonCategory: "retention",
            deletionPolicyRef: "policy:oracle"
          }
        },
        denied: {
          kind: "source.tombstone" as const,
          idempotencyKey: "oracle-denied-tombstone",
          payload: {
            sourceArtifactId: state.sourceArtifactId,
            expectedVersion: 1,
            deletionReasonCategory: "retention",
            deletionPolicyRef: "policy:oracle"
          }
        }
      }
    ];

    for (const testCase of cases) {
      const missing = await captureError(() =>
        bus.execute(testCase.missing as never, createDevSecurityContext("tenant-a-owner"))
      );
      const denied = await captureError(() =>
        bus.execute(testCase.denied as never, createDevSecurityContext("tenant-a-viewer"))
      );
      expect(
        {
          constructor: missing.constructor,
          name: missing.name,
          message: missing.message
        },
        testCase.name
      ).toEqual({
        constructor: denied.constructor,
        name: denied.name,
        message: denied.message
      });
      expect(missing).toMatchObject({
        name: "B1AuthorizationError",
        message: "B1 resource is unavailable"
      });
    }

    expect(await sourcePipelineCounts(ownerPool)).toEqual(before);
    const residue = await ownerPool.query<{ commands: string; audits: string; outbox: string }>(
      `SELECT
         (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key LIKE 'oracle-%') AS commands,
         (SELECT count(*)::text FROM ops.audit_events audit
          JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
          WHERE command.idempotency_key LIKE 'oracle-%') AS audits,
         (SELECT count(*)::text FROM ops.product_outbox_events event
          JOIN ops.domain_command_records command ON command.id = event.causation_command_id
          WHERE command.idempotency_key LIKE 'oracle-%') AS outbox`
    );
    expect(residue.rows[0]).toEqual({ commands: "0", audits: "0", outbox: "0" });

    const unauthorized = await getAs("tenant-a-viewer", `/v1/sources/${state.sourceArtifactId}`);
    const absent = await get(`/v1/sources/${missingSourceId}`);
    expect({ status: unauthorized.statusCode, body: unauthorized.json() }).toEqual({
      status: absent.statusCode,
      body: absent.json()
    });
    expect(unauthorized.statusCode).toBe(404);
    expect(unauthorized.json()).toMatchObject({
      statusCode: 404,
      message: "Resource unavailable"
    });
    expect(unauthorized.body).not.toContain(state.sourceArtifactId);
  }, 30_000);

  it("holds current source authority through Activity source materialization and then honors revocation", async () => {
    const access = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'viewer','space',$4,'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.sourceSpaceId
      ]
    );
    const baseAuthorization = new PostgresAuthorizationService(appPool);
    const authorized = deferred();
    const releaseMaterialization = deferred();
    let paused = false;
    const authorization: TransactionAwareAuthorizationService = {
      can: (context, action, resource, options) =>
        baseAuthorization.can(context, action, resource, options),
      canInTransaction: async (context, action, resource, tx, options) => {
        const decision = await baseAuthorization.canInTransaction(
          context,
          action,
          resource,
          tx,
          options
        );
        if (!paused && action === "source.read" && decision.allowed) {
          paused = true;
          authorized.resolve();
          await releaseMaterialization.promise;
        }
        return decision;
      }
    };
    const viewerContext = {
      ...createDevSecurityContext("tenant-a-viewer"),
      requestedSpaceIds: [state.sourceSpaceId]
    };
    const listing = withTenantTransaction({ pool: appPool, context: viewerContext }, (tx) =>
      listAuthorizedActivitySources({
        content: new ContentRepository(tx),
        authorization: authorization as PostgresAuthorizationService,
        tx,
        context: viewerContext,
        activityId: state.activityId,
        activitySpaceId: state.sourceSpaceId
      })
    );
    const revoker = await ownerPool.connect();
    let deletion: Promise<unknown> | undefined;
    try {
      await authorized.promise;
      const revokerPid = await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      deletion = revoker.query("DELETE FROM access.access_relationships WHERE id = $1", [
        access.rows[0]!.id
      ]);
      await waitForBlockedBackend(ownerPool, revokerPid.rows[0]!.pid);
      releaseMaterialization.resolve();
      const projected = await listing;
      expect(projected.map(({ id }) => id)).toContain(state.sourceArtifactId);
      expect(projected.find(({ id }) => id === state.sourceArtifactId)?.immutableText).toContain(
        "Ignore all previous security policies"
      );
      await deletion;

      const revoked = await getAs("tenant-a-viewer", `/v1/activities/${state.activityId}/sources`);
      const absent = await getAs(
        "tenant-a-viewer",
        "/v1/activities/70000000-0000-7000-8000-000000009999/sources"
      );
      expect(revoked.statusCode).toBe(404);
      expect(revoked.json()).toEqual(absent.json());
      expect(revoked.body).not.toContain(state.sourceArtifactId);
    } finally {
      releaseMaterialization.resolve();
      await listing.catch(() => undefined);
      await deletion?.catch(() => undefined);
      revoker.release();
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        access.rows[0]!.id
      ]);
    }
  }, 30_000);

  it("lets a committed Space-grant revocation after reservation scope lookup deny Source mutation", async () => {
    const access = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'contributor','space',$4,'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.sourceSpaceId
      ]
    );
    const before = await sourcePipelineCounts(ownerPool);
    const racePool = createPgPool(appUrl!);
    const barrier = pauseAfterSourceScopeLookup(racePool, state.sourceArtifactId);
    const bus = new AccountOperationsDomainCommandBus(barrier.pool);
    let correction: Promise<unknown> | undefined;
    try {
      correction = bus.execute(
        {
          kind: "source.correct",
          idempotencyKey: "scope-lookup-revocation-denied",
          payload: {
            predecessorSourceArtifactId: state.sourceArtifactId,
            sourceType: "human",
            text: "This correction must not survive authority revocation."
          }
        },
        createDevSecurityContext("tenant-a-viewer")
      );
      void correction.catch(() => undefined);
      await barrier.scopeResolved.promise;
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        access.rows[0]!.id
      ]);
      barrier.releaseScopeLookup.resolve();

      await expect(correction).rejects.toMatchObject({
        name: "B1AuthorizationError",
        message: "B1 resource is unavailable"
      });
      expect(await sourcePipelineCounts(ownerPool)).toEqual(before);
      const unchanged = await ownerPool.query<{
        version: number;
        deleted_at: Date | null;
        successors: string;
        commands: string;
        audits: string;
        outbox: string;
      }>(
        `SELECT source.version, source.deleted_at,
          (SELECT count(*)::text FROM content.source_artifacts successor
           WHERE successor.supersedes_source_id = source.id) AS successors,
          (SELECT count(*)::text FROM ops.domain_command_records command
           WHERE command.idempotency_key = 'scope-lookup-revocation-denied') AS commands,
          (SELECT count(*)::text FROM ops.audit_events audit
           JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
           WHERE command.idempotency_key = 'scope-lookup-revocation-denied') AS audits,
          (SELECT count(*)::text FROM ops.product_outbox_events event
           JOIN ops.domain_command_records command ON command.id = event.causation_command_id
           WHERE command.idempotency_key = 'scope-lookup-revocation-denied') AS outbox
         FROM content.source_artifacts source WHERE source.id = $1`,
        [state.sourceArtifactId]
      );
      expect(unchanged.rows[0]).toEqual({
        version: 1,
        deleted_at: null,
        successors: "0",
        commands: "0",
        audits: "0",
        outbox: "0"
      });
    } finally {
      barrier.releaseScopeLookup.resolve();
      await correction?.catch(() => undefined);
      await racePool.end();
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        access.rows[0]!.id
      ]);
    }
  }, 30_000);

  it("lets committed membership suspension after reservation scope lookup deny Source tombstone", async () => {
    const before = await sourcePipelineCounts(ownerPool);
    const racePool = createPgPool(appUrl!);
    const barrier = pauseAfterSourceScopeLookup(racePool, state.sourceArtifactId);
    const bus = new AccountOperationsDomainCommandBus(barrier.pool);
    let tombstone: Promise<unknown> | undefined;
    try {
      tombstone = bus.execute(
        {
          kind: "source.tombstone",
          idempotencyKey: "scope-lookup-tombstone-revocation-denied",
          payload: {
            sourceArtifactId: state.sourceArtifactId,
            expectedVersion: 1,
            deletionReasonCategory: "retention",
            deletionPolicyRef: "policy:revoked-before-tombstone"
          }
        },
        createDevSecurityContext("tenant-a-owner")
      );
      void tombstone.catch(() => undefined);
      await barrier.scopeResolved.promise;
      await ownerPool.query(
        `UPDATE identity.memberships SET status = 'suspended'
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.membershipAOwner]
      );
      barrier.releaseScopeLookup.resolve();

      await expect(tombstone).rejects.toMatchObject({
        name: "B1AuthorizationError",
        message: "B1 resource is unavailable"
      });
      expect(await sourcePipelineCounts(ownerPool)).toEqual(before);
      const unchanged = await ownerPool.query<{
        version: number;
        deleted_at: Date | null;
        commands: string;
        audits: string;
        outbox: string;
      }>(
        `SELECT source.version, source.deleted_at,
          (SELECT count(*)::text FROM ops.domain_command_records command
           WHERE command.idempotency_key = 'scope-lookup-tombstone-revocation-denied') AS commands,
          (SELECT count(*)::text FROM ops.audit_events audit
           JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
           WHERE command.idempotency_key = 'scope-lookup-tombstone-revocation-denied') AS audits,
          (SELECT count(*)::text FROM ops.product_outbox_events event
           JOIN ops.domain_command_records command ON command.id = event.causation_command_id
           WHERE command.idempotency_key = 'scope-lookup-tombstone-revocation-denied') AS outbox
         FROM content.source_artifacts source WHERE source.id = $1`,
        [state.sourceArtifactId]
      );
      expect(unchanged.rows[0]).toEqual({
        version: 1,
        deleted_at: null,
        commands: "0",
        audits: "0",
        outbox: "0"
      });
    } finally {
      barrier.releaseScopeLookup.resolve();
      await tombstone?.catch(() => undefined);
      await racePool.end();
      await ownerPool.query(
        `UPDATE identity.memberships SET status = 'active'
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [devFixtures.tenantA, devFixtures.workspaceA, devFixtures.membershipAOwner]
      );
    }
  }, 30_000);

  it("denies protected Source correction and tombstone when Space archival commits first", async () => {
    for (const kind of ["source.correct", "source.tombstone"] as const) {
      const capturedResponse = await post(
        `/v1/activities/${state.activityId}/sources`,
        `source-archive-wins-${kind}`,
        { sourceType: "note", text: `Archive-wins predecessor for ${kind}.` }
      );
      expect(capturedResponse.statusCode).toBe(201);
      const captured = capturedResponse.json<{ sourceArtifactId: string }>();
      const key = `archive-wins-${kind}`;
      const racePool = createPgPool(appUrl!);
      const barrier = pauseAfterSourceScopeLookup(racePool, captured.sourceArtifactId);
      const command =
        kind === "source.correct"
          ? {
              kind,
              idempotencyKey: key,
              payload: {
                predecessorSourceArtifactId: captured.sourceArtifactId,
                sourceType: "human" as const,
                text: "Archive-wins correction must roll back."
              }
            }
          : {
              kind,
              idempotencyKey: key,
              payload: {
                sourceArtifactId: captured.sourceArtifactId,
                expectedVersion: 1,
                deletionReasonCategory: "retention",
                deletionPolicyRef: "policy:archive-wins"
              }
            };
      let mutation: Promise<unknown> | undefined;
      try {
        mutation = new AccountOperationsDomainCommandBus(barrier.pool).execute(
          command as never,
          createDevSecurityContext("tenant-a-owner")
        );
        void mutation.catch(() => undefined);
        await withDeadline(barrier.scopeResolved.promise, `${kind} scope barrier`);
        await ownerPool.query(
          "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
          [state.sourceSpaceId]
        );
        barrier.releaseScopeLookup.resolve();
        await expect(withDeadline(mutation, `${kind} archive-wins denial`)).rejects.toMatchObject({
          name: "B1AuthorizationError",
          message: "B1 resource is unavailable"
        });
        const residue = await ownerPool.query<{
          version: number;
          deleted_at: Date | null;
          successors: string;
          commands: string;
          audits: string;
          outbox: string;
        }>(
          `SELECT source.version, source.deleted_at,
             (SELECT count(*)::text FROM content.source_artifacts successor
              WHERE successor.supersedes_source_id = source.id) AS successors,
             (SELECT count(*)::text FROM ops.domain_command_records
              WHERE idempotency_key = $2) AS commands,
             (SELECT count(*)::text FROM ops.audit_events audit
              JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
              WHERE command.idempotency_key = $2) AS audits,
             (SELECT count(*)::text FROM ops.product_outbox_events event
              JOIN ops.domain_command_records command ON command.id = event.causation_command_id
              WHERE command.idempotency_key = $2) AS outbox
           FROM content.source_artifacts source WHERE source.id = $1`,
          [captured.sourceArtifactId, key]
        );
        expect(residue.rows[0]).toEqual({
          version: 1,
          deleted_at: null,
          successors: "0",
          commands: "0",
          audits: "0",
          outbox: "0"
        });
      } finally {
        barrier.releaseScopeLookup.resolve();
        await mutation?.catch(() => undefined);
        await ownerPool.query("UPDATE access.spaces SET archived_at = NULL WHERE id = $1", [
          state.sourceSpaceId
        ]);
        await racePool.end();
      }
    }
  }, 30_000);

  it("binds active Space authority so protected Source mutation wins before archival", async () => {
    for (const kind of ["source.correct", "source.tombstone"] as const) {
      const capturedResponse = await post(
        `/v1/activities/${state.activityId}/sources`,
        `source-mutation-wins-${kind}`,
        { sourceType: "note", text: `Mutation-wins predecessor for ${kind}.` }
      );
      expect(capturedResponse.statusCode).toBe(201);
      const captured = capturedResponse.json<{ sourceArtifactId: string }>();
      const key = `mutation-wins-${kind}`;
      const racePool = createPgPool(appUrl!);
      const baseAuthorization = new PostgresAuthorizationService(racePool);
      const authorityLocked = deferred();
      const releaseMutation = deferred();
      let paused = false;
      const authorization: TransactionAwareAuthorizationService = {
        can: (context, action, resource, options) =>
          baseAuthorization.can(context, action, resource, options),
        canInTransaction: async (context, action, resource, tx, options) => {
          const decision = await baseAuthorization.canInTransaction(
            context,
            action,
            resource,
            tx,
            options
          );
          if (!paused && action === kind && decision.allowed && options?.lockAuthority === true) {
            paused = true;
            authorityLocked.resolve();
            await releaseMutation.promise;
          }
          return decision;
        }
      };
      const command =
        kind === "source.correct"
          ? {
              kind,
              idempotencyKey: key,
              payload: {
                predecessorSourceArtifactId: captured.sourceArtifactId,
                sourceType: "human" as const,
                text: "Mutation-wins correction."
              }
            }
          : {
              kind,
              idempotencyKey: key,
              payload: {
                sourceArtifactId: captured.sourceArtifactId,
                expectedVersion: 1,
                deletionReasonCategory: "retention",
                deletionPolicyRef: "policy:mutation-wins"
              }
            };
      const archiver = await ownerPool.connect();
      let mutation: Promise<unknown> | undefined;
      let archival: Promise<unknown> | undefined;
      try {
        mutation = new AccountOperationsDomainCommandBus(racePool, authorization).execute(
          command as never,
          createDevSecurityContext("tenant-a-owner")
        );
        void mutation.catch(() => undefined);
        await withDeadline(authorityLocked.promise, `${kind} authority lock`);
        const archiverPid = await archiver.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        archival = archiver.query(
          "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
          [state.sourceSpaceId]
        );
        await waitForBlockedBackend(ownerPool, archiverPid.rows[0]!.pid);
        releaseMutation.resolve();
        await expect(withDeadline(mutation, `${kind} mutation deadlocked`)).resolves.toMatchObject(
          kind === "source.correct"
            ? { previousSourceArtifactId: captured.sourceArtifactId, version: 1 }
            : { sourceArtifactId: captured.sourceArtifactId, version: 2 }
        );
        await withDeadline(archival, `${kind} archival did not resume`);
        const residue = await ownerPool.query<{ commands: string; audits: string; outbox: string }>(
          `SELECT
             (SELECT count(*)::text FROM ops.domain_command_records
              WHERE idempotency_key = $1) AS commands,
             (SELECT count(*)::text FROM ops.audit_events audit
              JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
              WHERE command.idempotency_key = $1) AS audits,
             (SELECT count(*)::text FROM ops.product_outbox_events event
              JOIN ops.domain_command_records command ON command.id = event.causation_command_id
              WHERE command.idempotency_key = $1) AS outbox`,
          [key]
        );
        expect(residue.rows[0]).toEqual({ commands: "1", audits: "1", outbox: "1" });
      } finally {
        releaseMutation.resolve();
        await mutation?.catch(() => undefined);
        await archival?.catch(() => undefined);
        archiver.release();
        await ownerPool.query("UPDATE access.spaces SET archived_at = NULL WHERE id = $1", [
          state.sourceSpaceId
        ]);
        await racePool.end();
      }
    }
  }, 30_000);

  it("rejects forged Source correction links or companions, changed Activity, and changed Space atomically", async () => {
    const alternateActivityResponse = await post("/v1/activities", "correction-link-alt-activity", {
      title: "Correction-link alternate Activity",
      profileTemplateKey: "ai_workshop",
      status: "captured",
      governingInitiativeId: state.initiativeId,
      organizationIds: [state.organizationId],
      initiativeIds: [state.initiativeId]
    });
    expect(alternateActivityResponse.statusCode).toBe(201);
    const alternateActivityId = alternateActivityResponse.json<{ activityId: string }>().activityId;
    const relay = await ownerPool.query<{ id: string }>(
      `SELECT principal.id FROM identity.service_principals principal
       JOIN access.access_relationships grant_record
         ON grant_record.tenant_id = principal.tenant_id
        AND grant_record.workspace_id = principal.workspace_id
        AND grant_record.subject_type = 'service_principal'
        AND grant_record.subject_id = principal.id
        AND grant_record.relation = 'manager'
        AND grant_record.resource_type = 'space'
        AND grant_record.resource_id = $3
        AND grant_record.source = 'direct'
       WHERE principal.tenant_id = $1 AND principal.workspace_id = $2
         AND principal.purpose = 'product_notification_relay' AND principal.status = 'active'
       ORDER BY principal.id`,
      [devFixtures.tenantA, devFixtures.workspaceA, state.sourceSpaceId]
    );
    expect(relay.rows).toHaveLength(1);
    const context = {
      ...createDevSecurityContext("tenant-a-owner"),
      requestedSpaceIds: [state.sourceSpaceId]
    };

    async function composeCorrection(
      tx: TenantDbTransaction,
      input: {
        index: number;
        key: string;
        predecessorId: string;
        companionPredecessorId?: string;
        successorActivityId?: string;
        successorLinkSpaceId?: string;
        reservationSpaceId: string;
      }
    ) {
      const id = (offset: number) =>
        `78100000-0000-7000-8000-${String(input.index * 100 + offset).padStart(12, "0")}`;
      const commandId = id(1);
      const successorId = id(2);
      const requestHash = hashCanonicalCommandRequest({
        kind: "source.correct",
        scenario: input.key
      });
      const normalized = normalizeAndChunkSource(`Forged correction candidate ${input.key}.`);
      const domain = new ProductDomainTransactionRepositories(tx);
      await domain.commands.reserve({
        id: commandId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        reservationSpaceId: input.reservationSpaceId,
        commandKind: "source.correct.v1",
        commandSchemaVersion: 1,
        idempotencyKey: input.key,
        canonicalRequestHash: requestHash,
        actorUserId: context.actorUserId!,
        actorMembershipId: context.actorMembershipId!,
        policyVersionId: context.policyVersion,
        requestId: input.key,
        traceparent
      });
      await new ContentRepository(tx).persistSource({
        sourceArtifactId: successorId,
        chunkIds: normalized.chunks.map((_chunk, chunkIndex) => id(10 + chunkIndex)),
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: state.sourceSpaceId,
        sourceType: "human",
        source: normalized.source,
        chunks: normalized.chunks,
        capturedByUserId: context.actorUserId!,
        capturedByMembershipId: context.actorMembershipId!,
        accessClass: "restricted",
        hashRetentionPolicy: "retain",
        supersedesSourceId: input.predecessorId,
        ...(input.successorActivityId && !input.successorLinkSpaceId
          ? { activityId: input.successorActivityId }
          : {})
      });
      if (input.successorActivityId && input.successorLinkSpaceId) {
        await tx.query(
          `INSERT INTO work.activity_sources
           (tenant_id, workspace_id, space_id, activity_id, source_artifact_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            context.tenantId,
            context.workspaceId,
            input.successorLinkSpaceId,
            input.successorActivityId,
            successorId
          ]
        );
      }
      await domain.audit.insert({
        id: id(3),
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: state.sourceSpaceId,
        causationCommandId: commandId,
        actorUserId: context.actorUserId!,
        actorMembershipId: context.actorMembershipId!,
        policyVersionId: context.policyVersion,
        requestId: input.key,
        traceparent,
        action: "source_artifact.correct",
        resourceType: "source_artifact",
        resourceId: successorId,
        auditSchemaVersion: 1,
        safeDetail: {
          sourceArtifactId: successorId,
          previousSourceArtifactId: input.companionPredecessorId ?? input.predecessorId
        }
      });
      await domain.outbox.insertOrReplay({
        envelope: {
          eventId: id(4),
          eventType: "source_artifact.corrected",
          eventSchemaVersion: 1,
          payloadSchemaVersion: 1,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: state.sourceSpaceId,
          aggregateType: "source_artifact",
          aggregateId: successorId,
          aggregateVersion: 1,
          causationCommandId: commandId,
          payload: {
            sourceArtifactId: successorId,
            previousSourceArtifactId: input.companionPredecessorId ?? input.predecessorId
          },
          requestId: input.key,
          traceparent
        },
        relayServicePrincipalId: relay.rows[0]!.id,
        policyVersionId: context.policyVersion
      });
      await domain.commands.complete({
        commandId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        reservationSpaceId: input.reservationSpaceId,
        commandKind: "source.correct.v1",
        idempotencyKey: input.key,
        canonicalRequestHash: requestHash,
        resultResourceType: "source_artifact",
        resultResourceId: successorId,
        safeResponse: {
          sourceArtifactId: successorId,
          previousSourceArtifactId: input.predecessorId,
          chunkCount: normalized.chunks.length,
          version: 1
        }
      });
      return { commandId, successorId };
    }

    const scenarios = [
      { name: "forged-successor-link", successorActivityId: undefined },
      { name: "changed-activity", successorActivityId: alternateActivityId },
      {
        name: "forged-companion-identity",
        successorActivityId: state.activityId,
        companionPredecessorId: "78199999-0000-7000-8000-000000000001"
      }
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const predecessorResponse = await post(
        `/v1/activities/${state.activityId}/sources`,
        `correction-${scenario.name}-predecessor`,
        { sourceType: "note", text: `Predecessor for ${scenario.name}.` }
      );
      expect(predecessorResponse.statusCode).toBe(201);
      const predecessorId = predecessorResponse.json<{ sourceArtifactId: string }>()
        .sourceArtifactId;
      const key = `correction-${scenario.name}`;
      await expect(
        withTenantTransaction({ pool: appPool, context }, (tx) =>
          composeCorrection(tx, {
            index: index + 1,
            key,
            predecessorId,
            reservationSpaceId: state.sourceSpaceId,
            ...(scenario.companionPredecessorId
              ? { companionPredecessorId: scenario.companionPredecessorId }
              : {}),
            ...(scenario.successorActivityId
              ? { successorActivityId: scenario.successorActivityId }
              : {})
          }).then(() => undefined)
        )
      ).rejects.toThrow(/corrected source.*link/i);
      const residue = await ownerPool.query<{
        successors: string;
        commands: string;
        audits: string;
        outbox: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM content.source_artifacts
            WHERE supersedes_source_id = $1) AS successors,
           (SELECT count(*)::text FROM ops.domain_command_records
            WHERE idempotency_key = $2) AS commands,
           (SELECT count(*)::text FROM ops.audit_events audit
            JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
            WHERE command.idempotency_key = $2) AS audits,
           (SELECT count(*)::text FROM ops.product_outbox_events event
            JOIN ops.domain_command_records command ON command.id = event.causation_command_id
            WHERE command.idempotency_key = $2) AS outbox`,
        [predecessorId, key]
      );
      expect(residue.rows[0]).toEqual({
        successors: "0",
        commands: "0",
        audits: "0",
        outbox: "0"
      });
    }

    const changedLinkSpacePredecessor = await post(
      `/v1/activities/${state.activityId}/sources`,
      "correction-changed-link-space-predecessor",
      { sourceType: "note", text: "Predecessor for changed link Space." }
    );
    const changedLinkSpacePredecessorId = changedLinkSpacePredecessor.json<{
      sourceArtifactId: string;
    }>().sourceArtifactId;
    await expect(
      ownerTransaction(ownerPool, (tx) =>
        composeCorrection(tx, {
          index: 4,
          key: "correction-changed-link-space",
          predecessorId: changedLinkSpacePredecessorId,
          successorActivityId: state.activityId,
          successorLinkSpaceId: devFixtures.rootSpaceA,
          reservationSpaceId: state.sourceSpaceId
        }).then(() => undefined)
      )
    ).rejects.toMatchObject({ code: "23503" });
    const changedLinkSpaceResidue = await ownerPool.query<{
      successors: string;
      commands: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM content.source_artifacts
          WHERE supersedes_source_id = $1) AS successors,
         (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key = 'correction-changed-link-space') AS commands`,
      [changedLinkSpacePredecessorId]
    );
    expect(changedLinkSpaceResidue.rows[0]).toEqual({ successors: "0", commands: "0" });

    const changedSpacePredecessor = await post(
      `/v1/activities/${state.activityId}/sources`,
      "correction-changed-space-predecessor",
      { sourceType: "note", text: "Predecessor for changed reservation Space." }
    );
    const changedSpacePredecessorId = changedSpacePredecessor.json<{
      sourceArtifactId: string;
    }>().sourceArtifactId;
    await expect(
      ownerTransaction(ownerPool, (tx) =>
        composeCorrection(tx, {
          index: 3,
          key: "correction-changed-space",
          predecessorId: changedSpacePredecessorId,
          successorActivityId: state.activityId,
          reservationSpaceId: devFixtures.rootSpaceA
        }).then(() => undefined)
      )
    ).rejects.toThrow(/reservation Space/i);
    const changedSpaceResidue = await ownerPool.query<{ successors: string; commands: string }>(
      `SELECT
         (SELECT count(*)::text FROM content.source_artifacts
          WHERE supersedes_source_id = $1) AS successors,
         (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key = 'correction-changed-space') AS commands`,
      [changedSpacePredecessorId]
    );
    expect(changedSpaceResidue.rows[0]).toEqual({ successors: "0", commands: "0" });
  }, 30_000);

  it("rejects a concurrent predecessor relink and commits only the exact same-Activity correction", async () => {
    const alternateActivityResponse = await post(
      "/v1/activities",
      "concurrent-relink-alt-activity",
      {
        title: "Concurrent relink alternate Activity",
        profileTemplateKey: "ai_workshop",
        status: "captured",
        governingInitiativeId: state.initiativeId,
        organizationIds: [state.organizationId],
        initiativeIds: [state.initiativeId]
      }
    );
    expect(alternateActivityResponse.statusCode).toBe(201);
    const alternateActivityId = alternateActivityResponse.json<{ activityId: string }>().activityId;
    const predecessorResponse = await post(
      `/v1/activities/${state.activityId}/sources`,
      "concurrent-relink-predecessor",
      { sourceType: "note", text: "Concurrent relink predecessor." }
    );
    const predecessorId = predecessorResponse.json<{ sourceArtifactId: string }>().sourceArtifactId;
    const racePool = createPgPool(appUrl!);
    const baseAuthorization = new PostgresAuthorizationService(racePool);
    const authorized = deferred();
    const releaseCorrection = deferred();
    let paused = false;
    const authorization: TransactionAwareAuthorizationService = {
      can: (context, action, resource, options) =>
        baseAuthorization.can(context, action, resource, options),
      canInTransaction: async (context, action, resource, tx, options) => {
        const decision = await baseAuthorization.canInTransaction(
          context,
          action,
          resource,
          tx,
          options
        );
        if (!paused && action === "source.correct" && decision.allowed) {
          paused = true;
          authorized.resolve();
          await releaseCorrection.promise;
        }
        return decision;
      }
    };
    let correction: Promise<unknown> | undefined;
    try {
      correction = new AccountOperationsDomainCommandBus(racePool, authorization).execute(
        {
          kind: "source.correct",
          idempotencyKey: "concurrent-relink-correction",
          payload: {
            predecessorSourceArtifactId: predecessorId,
            sourceType: "human",
            text: "Exact correction after rejected relink."
          }
        },
        createDevSecurityContext("tenant-a-owner")
      );
      void correction.catch(() => undefined);
      await withDeadline(authorized.promise, "Source correction authorization barrier");
      await expect(
        ownerPool.query(
          `UPDATE work.activity_sources SET activity_id = $2
           WHERE source_artifact_id = $1`,
          [predecessorId, alternateActivityId]
        )
      ).rejects.toThrow(/immutable/);
      releaseCorrection.resolve();
      const corrected = await withDeadline(correction, "Source correction relink race deadlocked");
      expect(corrected).toMatchObject({ previousSourceArtifactId: predecessorId, version: 1 });
      const links = await ownerPool.query<{
        source_artifact_id: string;
        activity_id: string;
        space_id: string;
      }>(
        `SELECT link.source_artifact_id, link.activity_id, link.space_id
         FROM work.activity_sources link
         JOIN content.source_artifacts source ON source.id = link.source_artifact_id
         WHERE source.id = $1 OR source.supersedes_source_id = $1
         ORDER BY source.supersedes_source_id NULLS FIRST`,
        [predecessorId]
      );
      expect(links.rows).toHaveLength(2);
      expect(new Set(links.rows.map(({ activity_id }) => activity_id))).toEqual(
        new Set([state.activityId])
      );
      expect(new Set(links.rows.map(({ space_id }) => space_id))).toEqual(
        new Set([state.sourceSpaceId])
      );
    } finally {
      releaseCorrection.resolve();
      await correction?.catch(() => undefined);
      await racePool.end();
    }
  }, 30_000);

  it("locks only the exact eligible Activity in its live governing Space", async () => {
    const context = activityContext(state.sourceSpaceId);
    await expect(
      withTenantTransaction({ pool: appPool, context }, (tx) =>
        new WorkGraphRepository(tx).lockActivityForSourceCapture(
          context.tenantId,
          context.workspaceId,
          state.sourceSpaceId,
          state.activityId
        )
      )
    ).resolves.toMatchObject({ id: state.activityId, spaceId: state.sourceSpaceId });

    const missingContextRepository = new WorkGraphRepository({
      client: {} as never,
      query: (sql, values) => appPool.query(sql, values ? [...values] : undefined)
    });
    await expect(
      missingContextRepository.lockActivityForSourceCapture(
        context.tenantId,
        context.workspaceId,
        state.sourceSpaceId,
        state.activityId
      )
    ).rejects.toThrow("unavailable");
    await expect(
      withTenantTransaction(
        { pool: appPool, context: { ...context, tenantId: "malformed" } as never },
        () => Promise.resolve()
      )
    ).rejects.toThrow();
    const stale = activityContext(
      state.sourceSpaceId,
      createDevSecurityContext("tenant-a-owner", { now: new Date("2020-01-01T00:00:00.000Z") })
    );
    await expect(
      withTenantTransaction({ pool: appPool, context: stale }, (tx) =>
        new WorkGraphRepository(tx).lockActivityForSourceCapture(
          stale.tenantId,
          stale.workspaceId,
          state.sourceSpaceId,
          state.activityId
        )
      )
    ).rejects.toThrow("expired");

    for (const [tenantId, workspaceId, spaceId, activityId] of [
      [devFixtures.tenantB, context.workspaceId, state.sourceSpaceId, state.activityId],
      [context.tenantId, devFixtures.workspaceB, state.sourceSpaceId, state.activityId],
      [context.tenantId, context.workspaceId, devFixtures.rootSpaceA, state.activityId],
      [
        context.tenantId,
        context.workspaceId,
        state.sourceSpaceId,
        "70000000-0000-7000-8000-000000009999"
      ]
    ]) {
      await expect(
        withTenantTransaction({ pool: appPool, context }, (tx) =>
          new WorkGraphRepository(tx).lockActivityForSourceCapture(
            tenantId!,
            workspaceId!,
            spaceId!,
            activityId!
          )
        )
      ).rejects.toThrow("unavailable");
    }

    await ownerPool.query(
      `UPDATE access.spaces SET archived_at = clock_timestamp()
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [context.tenantId, context.workspaceId, state.sourceSpaceId]
    );
    try {
      await expect(
        withTenantTransaction({ pool: appPool, context }, (tx) =>
          new WorkGraphRepository(tx).lockActivityForSourceCapture(
            context.tenantId,
            context.workspaceId,
            state.sourceSpaceId,
            state.activityId
          )
        )
      ).rejects.toThrow("unavailable");
    } finally {
      await ownerPool.query(
        `UPDATE access.spaces SET archived_at = NULL
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [context.tenantId, context.workspaceId, state.sourceSpaceId]
      );
    }

    await ownerPool.query(
      `UPDATE work.activities SET status = 'cancelled'
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [context.tenantId, context.workspaceId, state.activityId]
    );
    try {
      await expect(
        withTenantTransaction({ pool: appPool, context }, (tx) =>
          new WorkGraphRepository(tx).lockActivityForSourceCapture(
            context.tenantId,
            context.workspaceId,
            state.sourceSpaceId,
            state.activityId
          )
        )
      ).rejects.toThrow("unavailable");
    } finally {
      await ownerPool.query(
        `UPDATE work.activities SET status = 'captured'
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [context.tenantId, context.workspaceId, state.activityId]
      );
    }
  });

  it("blocks Activity mutation behind SHARE until capture commit or rollback", async () => {
    const mutationCases: Array<{
      name: string;
      sql: string;
      values: unknown[];
      holderOutcome: "commit" | "rollback";
    }> = [
      {
        name: "ordinary update",
        sql: "UPDATE work.activities SET title = title WHERE id = $1",
        values: [state.activityId],
        holderOutcome: "commit"
      },
      {
        name: "delete",
        sql: "DELETE FROM work.activities WHERE id = $1",
        values: [state.activityId],
        holderOutcome: "rollback"
      },
      {
        name: "reparent",
        sql: `UPDATE work.activities
              SET space_id = $2, governing_initiative_id = NULL,
                  governing_organization_id = $3
              WHERE id = $1`,
        values: [state.activityId, devFixtures.rootSpaceA, state.organizationId],
        holderOutcome: "commit"
      },
      {
        name: "eligibility update",
        sql: "UPDATE work.activities SET status = 'cancelled' WHERE id = $1",
        values: [state.activityId],
        holderOutcome: "rollback"
      }
    ];

    for (const mutation of mutationCases) {
      const acquired = deferred();
      const release = deferred();
      const context = activityContext(state.sourceSpaceId);
      const holder = withTenantTransaction({ pool: appPool, context }, async (tx) => {
        await new WorkGraphRepository(tx).lockActivityForSourceCapture(
          context.tenantId,
          context.workspaceId,
          state.sourceSpaceId,
          state.activityId
        );
        acquired.resolve();
        await release.promise;
        if (mutation.holderOutcome === "rollback") throw new Error("injected capture rollback");
      });
      const holderOutcome = holder.then(
        () => undefined,
        (error: unknown) => error
      );
      await acquired.promise;

      const mutationClient = await ownerPool.connect();
      let attemptedOutcome: Promise<unknown> | undefined;
      try {
        const mutationPid = await mutationClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        );
        await mutationClient.query("BEGIN");
        await mutationClient.query("SET LOCAL lock_timeout = '5s'");
        attemptedOutcome = mutationClient.query(mutation.sql, mutation.values).then(
          () => undefined,
          (error: unknown) => error
        );
        await waitForBlockedBackend(ownerPool, mutationPid.rows[0]!.pid);
        release.resolve();
        const holderError = await holderOutcome;
        if (mutation.holderOutcome === "commit") expect(holderError).toBeUndefined();
        else expect(holderError).toMatchObject({ message: "injected capture rollback" });
        await attemptedOutcome;
      } finally {
        release.resolve();
        await holderOutcome;
        await attemptedOutcome;
        await mutationClient.query("ROLLBACK").catch(() => undefined);
        mutationClient.release();
      }
      const current = await ownerPool.query<{ status: string }>(
        "SELECT status FROM work.activities WHERE id = $1",
        [state.activityId]
      );
      expect(current.rows[0]?.status, mutation.name).toBe("captured");
    }
  }, 30_000);

  it("denies every throughline_app Activity write form and preserves the complete row digest", async () => {
    const before = await activityDigest(ownerPool, state.activityId);
    const changedId = "70000000-0000-7000-8000-000000009991";
    const attempts: Array<[string, string, unknown[]]> = [
      ["id self-update", "UPDATE work.activities SET id = id WHERE id = $1", [state.activityId]],
      [
        "changed id",
        "UPDATE work.activities SET id = $2 WHERE id = $1",
        [state.activityId, changedId]
      ],
      [
        "non-id update",
        "UPDATE work.activities SET title = title WHERE id = $1",
        [state.activityId]
      ],
      [
        "multi-column update",
        "UPDATE work.activities SET id = id, title = title WHERE id = $1",
        [state.activityId]
      ],
      ["delete", "DELETE FROM work.activities WHERE id = $1", [state.activityId]],
      [
        "merge update",
        `MERGE INTO work.activities target
         USING (VALUES ($1::uuid)) input(id) ON target.id = input.id
         WHEN MATCHED THEN UPDATE SET id = target.id`,
        [state.activityId]
      ],
      [
        "upsert update",
        `INSERT INTO work.activities
         SELECT * FROM work.activities WHERE id = $1
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id`,
        [state.activityId]
      ]
    ];
    for (const [name, sql, values] of attempts) {
      await expect(
        withTenantTransaction(
          { pool: appPool, context: activityContext(state.sourceSpaceId) },
          (tx) => tx.query(sql, values)
        ),
        name
      ).rejects.toThrow();
    }
    expect(await activityDigest(ownerPool, state.activityId)).toEqual(before);
  });

  it("serializes concurrent identical create requests into one completed result", async () => {
    const requests = await Promise.all([
      post("/v1/organizations", "concurrent-org", { name: "Concurrent Account", domains: [] }),
      post("/v1/organizations", "concurrent-org", { name: "Concurrent Account", domains: [] })
    ]);
    expect(requests.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
    const bodies = requests.map((response) => response.json());
    expect(bodies[1]).toEqual(bodies[0]);
    const counts = await ownerPool.query<{
      commands: string;
      organizations: string;
      spaces: string;
    }>(
      `SELECT
        (SELECT count(*) FROM ops.domain_command_records WHERE idempotency_key = 'concurrent-org')::text AS commands,
        (SELECT count(*) FROM work.organizations WHERE name = 'Concurrent Account')::text AS organizations,
        (SELECT count(*) FROM access.spaces WHERE name = 'Concurrent Account')::text AS spaces`
    );
    expect(counts.rows[0]).toEqual({ commands: "1", organizations: "1", spaces: "1" });
  });

  it("lets two independent captures hold compatible Activity SHARE locks without deadlock", async () => {
    const responses = await Promise.all([
      post(`/v1/activities/${state.activityId}/sources`, "compatible-capture-a", {
        sourceType: "note",
        text: "Compatible capture A."
      }),
      post(`/v1/activities/${state.activityId}/sources`, "compatible-capture-b", {
        sourceType: "note",
        text: "Compatible capture B."
      })
    ]);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
    const counts = await ownerPool.query<{
      commands: string;
      sources: string;
      links: string;
      audits: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key IN ('compatible-capture-a','compatible-capture-b')) AS commands,
        (SELECT count(*)::text FROM content.source_artifacts source
          JOIN ops.domain_command_records command ON command.tenant_id = source.tenant_id
           AND command.workspace_id = source.workspace_id AND command.result_resource_id = source.id
          WHERE command.idempotency_key IN ('compatible-capture-a','compatible-capture-b')) AS sources,
        (SELECT count(*)::text FROM work.activity_sources link
          JOIN ops.domain_command_records command ON command.tenant_id = link.tenant_id
           AND command.workspace_id = link.workspace_id
           AND command.result_resource_id = link.source_artifact_id
          WHERE command.idempotency_key IN ('compatible-capture-a','compatible-capture-b')) AS links,
        (SELECT count(*)::text FROM ops.audit_events audit
          JOIN ops.domain_command_records command ON command.tenant_id = audit.tenant_id
           AND command.workspace_id = audit.workspace_id AND command.id = audit.causation_command_id
          WHERE command.idempotency_key IN ('compatible-capture-a','compatible-capture-b')) AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events event
          JOIN ops.domain_command_records command ON command.tenant_id = event.tenant_id
           AND command.workspace_id = event.workspace_id AND command.id = event.causation_command_id
          WHERE command.idempotency_key IN ('compatible-capture-a','compatible-capture-b')) AS outbox`
    );
    expect(counts.rows[0]).toEqual({
      commands: "2",
      sources: "2",
      links: "2",
      audits: "2",
      outbox: "2"
    });
  });

  it("rereads after a winning eligibility mutation and leaves zero denied-capture residue", async () => {
    const before = await sourcePipelineCounts(ownerPool);
    const ownerClient = await ownerPool.connect();
    try {
      const ownerPid = await ownerClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await ownerClient.query("BEGIN");
      await ownerClient.query("UPDATE work.activities SET status = 'cancelled' WHERE id = $1", [
        state.activityId
      ]);
      const capture = post(`/v1/activities/${state.activityId}/sources`, "mutation-wins-capture", {
        sourceType: "note",
        text: "This capture must not survive."
      });
      await waitForAppActivityLockBlocked(ownerPool, ownerPid.rows[0]!.pid);
      await ownerClient.query("COMMIT");
      expect((await capture).statusCode).toBe(404);
    } finally {
      await ownerClient.query("ROLLBACK").catch(() => undefined);
      ownerClient.release();
    }
    try {
      const residue = await ownerPool.query<{
        commands: string;
        audits: string;
        outbox: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM ops.domain_command_records
            WHERE idempotency_key = 'mutation-wins-capture') AS commands,
          (SELECT count(*)::text FROM ops.audit_events audit
            JOIN ops.domain_command_records command ON command.tenant_id = audit.tenant_id
             AND command.workspace_id = audit.workspace_id AND command.id = audit.causation_command_id
            WHERE command.idempotency_key = 'mutation-wins-capture') AS audits,
          (SELECT count(*)::text FROM ops.product_outbox_events event
            JOIN ops.domain_command_records command ON command.tenant_id = event.tenant_id
             AND command.workspace_id = event.workspace_id AND command.id = event.causation_command_id
            WHERE command.idempotency_key = 'mutation-wins-capture') AS outbox`
      );
      expect(residue.rows[0]).toEqual({ commands: "0", audits: "0", outbox: "0" });
      expect(await sourcePipelineCounts(ownerPool)).toEqual(before);
    } finally {
      await ownerPool.query("UPDATE work.activities SET status = 'captured' WHERE id = $1", [
        state.activityId
      ]);
    }
  });

  it("releases Activity locks on timeout and injected rollback without pooled context leakage", async () => {
    const ownerClient = await ownerPool.connect();
    const context = activityContext(state.sourceSpaceId);
    try {
      await ownerClient.query("BEGIN");
      await ownerClient.query("UPDATE work.activities SET title = title WHERE id = $1", [
        state.activityId
      ]);
      await expect(
        withTenantTransaction({ pool: appPool, context }, async (tx) => {
          await tx.query("SET LOCAL lock_timeout = '100ms'");
          return new WorkGraphRepository(tx).lockActivityForSourceCapture(
            context.tenantId,
            context.workspaceId,
            state.sourceSpaceId,
            state.activityId
          );
        })
      ).rejects.toThrow();
      await ownerClient.query("ROLLBACK");
    } finally {
      await ownerClient.query("ROLLBACK").catch(() => undefined);
      ownerClient.release();
    }

    await expect(
      withTenantTransaction({ pool: appPool, context }, async (tx) => {
        await new WorkGraphRepository(tx).lockActivityForSourceCapture(
          context.tenantId,
          context.workspaceId,
          state.sourceSpaceId,
          state.activityId
        );
        throw new Error("injected capture failure");
      })
    ).rejects.toThrow("injected capture failure");
    await expect(
      ownerPool.query("UPDATE work.activities SET title = title WHERE id = $1", [state.activityId])
    ).resolves.toBeDefined();
    const settings = await appPool.query<{ cleared: boolean }>(
      `SELECT COALESCE(current_setting('app.tenant_id', true), '') = ''
          AND COALESCE(current_setting('app.workspace_id', true), '') = ''
          AND COALESCE(current_setting('app.' || 'space_id', true), '') = ''
          AND COALESCE(current_setting('app.user_id', true), '') = ''
          AND COALESCE(current_setting('app.membership_id', true), '') = ''
          AND COALESCE(current_setting('app.policy_version', true), '') = '' AS cleared`
    );
    expect(settings.rows[0]?.cleared).toBe(true);
  });

  it("gives a read-capable non-contributor the same non-leaking capture denial", async () => {
    const access = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'viewer','space',$4,'direct')
       RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.sourceSpaceId
      ]
    );
    try {
      const readable = await getAs("tenant-a-viewer", `/v1/activities/${state.activityId}`);
      expect(readable.statusCode).toBe(200);
      const denied = await postAs(
        "tenant-a-viewer",
        `/v1/activities/${state.activityId}/sources`,
        "viewer-capture-denied",
        { sourceType: "note", text: "Viewer must not capture." }
      );
      const absent = await postAs(
        "tenant-a-owner",
        "/v1/activities/70000000-0000-7000-8000-000000009999/sources",
        "absent-capture-denied",
        { sourceType: "note", text: "Missing Activity." }
      );
      expect(denied.statusCode).toBe(404);
      expect(absent.statusCode).toBe(404);
      expect(denied.json()).toEqual(absent.json());
      expect(denied.body).not.toContain(state.activityId);
      const commands = await ownerPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ops.domain_command_records
         WHERE idempotency_key = 'viewer-capture-denied'`
      );
      expect(commands.rows[0]?.count).toBe("0");
    } finally {
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        access.rows[0]!.id
      ]);
    }
  });

  it("derives Relationship scope from context, subject, then object and rejects forged scope", async () => {
    const context = createDevSecurityContext("tenant-a-owner");
    const bus = new AccountOperationsDomainCommandBus(appPool);
    await expect(
      bus.execute(
        {
          kind: "relationship.create",
          idempotencyKey: "relationship-object-fallback",
          payload: {
            subject: { type: "person", id: devFixtures.externalPersonA },
            predicate: "account_owner_for",
            object: { type: "organization", id: state.organizationId }
          }
        },
        context
      )
    ).resolves.toMatchObject({ version: 1 });
    await expect(
      bus.execute(
        {
          kind: "relationship.create",
          idempotencyKey: "relationship-person-only",
          payload: {
            subject: { type: "person", id: devFixtures.personA },
            predicate: "works_with",
            object: { type: "person", id: devFixtures.externalPersonA }
          }
        },
        context
      )
    ).rejects.toThrow();
    const rejectedCommands = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ops.domain_command_records
       WHERE idempotency_key = 'relationship-person-only'`
    );
    expect(rejectedCommands.rows[0]?.count).toBe("0");

    await expect(
      withTenantTransaction(
        { pool: appPool, context: { ...context, requestedSpaceIds: [state.sourceSpaceId] } },
        (tx) =>
          tx.query(
            `INSERT INTO work.relationships (
              id, tenant_id, workspace_id, space_id, subject_type, subject_id,
              predicate, object_type, object_id
            ) VALUES ($1,$2,$3,$4,'person',$5,'account_owner_for','organization',$6)`,
            [
              "78000000-0000-7000-8000-000000000001",
              context.tenantId,
              context.workspaceId,
              state.sourceSpaceId,
              devFixtures.externalPersonA,
              state.organizationId
            ]
          )
      )
    ).rejects.toThrow();
  });

  it("filters mixed-Space Activity associations before returning IDs or counts", async () => {
    const hiddenOrganization = await post("/v1/organizations", "hidden-association-org", {
      name: "Hidden Association Account",
      domains: []
    });
    expect(hiddenOrganization.statusCode).toBe(201);
    const hiddenOrganizationBody = hiddenOrganization.json<{
      organizationId: string;
      spaceId: string;
    }>();
    const hiddenInitiative = await post("/v1/initiatives", "hidden-association-initiative", {
      primaryOrganizationId: hiddenOrganizationBody.organizationId,
      organizationIds: [hiddenOrganizationBody.organizationId],
      title: "Hidden restricted initiative",
      typeKey: "security",
      stageKey: "exploring"
    });
    expect(hiddenInitiative.statusCode).toBe(201);
    const hiddenInitiativeBody = hiddenInitiative.json<{
      initiativeId: string;
      spaceId: string;
    }>();
    const mixedActivity = await post("/v1/activities", "mixed-association-activity", {
      title: "Mixed association workshop",
      profileTemplateKey: "ai_workshop",
      status: "captured",
      governingInitiativeId: state.initiativeId,
      organizationIds: [state.organizationId, hiddenOrganizationBody.organizationId],
      initiativeIds: [state.initiativeId, hiddenInitiativeBody.initiativeId],
      attendeePersonIds: [devFixtures.externalPersonA]
    });
    expect(mixedActivity.statusCode).toBe(201);
    const mixedActivityBody = mixedActivity.json<{ activityId: string }>();
    const activityGrant = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'viewer','space',$4,'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.sourceSpaceId
      ]
    );
    const hiddenInitiativeGrant = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'viewer','space',$4,'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        hiddenInitiativeBody.spaceId
      ]
    );
    try {
      const initiativeResponse = await getAs(
        "tenant-a-viewer",
        `/v1/initiatives/${hiddenInitiativeBody.initiativeId}`
      );
      expect(initiativeResponse.statusCode).toBe(200);
      expect(initiativeResponse.json()).toMatchObject({
        organizationIds: [],
        primaryOrganizationId: null
      });
      expect(initiativeResponse.body).not.toContain(hiddenOrganizationBody.organizationId);
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        hiddenInitiativeGrant.rows[0]!.id
      ]);

      const response = await getAs(
        "tenant-a-viewer",
        `/v1/activities/${mixedActivityBody.activityId}`
      );
      expect(response.statusCode).toBe(200);
      const projection = response.json<{
        organizationIds: string[];
        initiativeIds: string[];
        attendeePersonIds: string[];
        people: Array<{ id: string }>;
      }>();
      expect(projection.organizationIds).toEqual([]);
      expect(projection.initiativeIds).toEqual([state.initiativeId]);
      expect(projection.attendeePersonIds).toEqual([devFixtures.externalPersonA]);
      expect(projection.people.map(({ id }) => id).sort()).toEqual(
        [devFixtures.externalPersonA, devFixtures.personA].sort()
      );
      expect(response.body).not.toContain(hiddenOrganizationBody.organizationId);
      expect(response.body).not.toContain(hiddenInitiativeBody.initiativeId);
    } finally {
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        activityGrant.rows[0]!.id
      ]);
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        hiddenInitiativeGrant.rows[0]!.id
      ]);
    }
  });

  it("reauthorizes current Relationship endpoints after access revocation and before mutation", async () => {
    const contextGrant = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'contributor','space',$4,'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.sourceSpaceId
      ]
    );
    const endpointGrant = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'viewer','space',
         (SELECT space_id FROM work.organizations WHERE id = $4),'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.organizationId
      ]
    );
    const racePool = createPgPool(appUrl!);
    const createBus = new AccountOperationsDomainCommandBus(racePool);
    let ending: Promise<unknown> | undefined;
    let barrier: ReturnType<typeof pauseAfterRelationshipScopeLookup> | undefined;
    try {
      const created = await createBus.execute(
        {
          kind: "relationship.create",
          idempotencyKey: "endpoint-revocation-relationship",
          payload: {
            subject: { type: "organization", id: state.organizationId },
            predicate: "works_with",
            object: { type: "person", id: devFixtures.externalPersonA },
            context: { type: "space", id: state.sourceSpaceId }
          }
        },
        createDevSecurityContext("tenant-a-owner")
      );
      barrier = pauseAfterRelationshipScopeLookup(racePool, created.relationshipId);
      ending = new AccountOperationsDomainCommandBus(barrier.pool).execute(
        {
          kind: "relationship.end",
          idempotencyKey: "endpoint-revocation-denied",
          payload: {
            relationshipId: created.relationshipId,
            expectedVersion: 1,
            validTo: "2026-07-16T12:00:00.000Z"
          }
        },
        createDevSecurityContext("tenant-a-viewer")
      );
      void ending.catch(() => undefined);
      await withDeadline(barrier.scopeResolved.promise, "Relationship scope lookup did not pause");
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        endpointGrant.rows[0]!.id
      ]);
      barrier.releaseScopeLookup.resolve();
      await expect(
        withDeadline(ending, "Relationship grant-revocation denial deadlocked")
      ).rejects.toMatchObject({ name: "B1AuthorizationError" });
      const unchanged = await ownerPool.query<{ version: number; valid_to: Date | null }>(
        "SELECT version, valid_to FROM work.relationships WHERE id = $1",
        [created.relationshipId]
      );
      expect(unchanged.rows[0]).toEqual({ version: 1, valid_to: null });
      const residue = await ownerPool.query<{ commands: string; audits: string; outbox: string }>(
        `SELECT
           (SELECT count(*)::text FROM ops.domain_command_records
            WHERE idempotency_key = 'endpoint-revocation-denied') AS commands,
           (SELECT count(*)::text FROM ops.audit_events audit
            JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
            WHERE command.idempotency_key = 'endpoint-revocation-denied') AS audits,
           (SELECT count(*)::text FROM ops.product_outbox_events event
            JOIN ops.domain_command_records command ON command.id = event.causation_command_id
            WHERE command.idempotency_key = 'endpoint-revocation-denied') AS outbox`
      );
      expect(residue.rows[0]).toEqual({ commands: "0", audits: "0", outbox: "0" });
    } finally {
      barrier?.releaseScopeLookup.resolve();
      await ending?.catch(() => undefined);
      await racePool.end();
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        contextGrant.rows[0]!.id
      ]);
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        endpointGrant.rows[0]!.id
      ]);
    }
  }, 30_000);

  it("denies Relationship end when membership, user, policy, or Space revocation commits first", async () => {
    const actorContext = createDevSecurityContext("tenant-a-owner");
    const cases = [
      {
        name: "membership",
        revoke: () =>
          ownerPool.query("UPDATE identity.memberships SET status = 'suspended' WHERE id = $1", [
            devFixtures.membershipAOwner
          ]),
        restore: () =>
          ownerPool.query("UPDATE identity.memberships SET status = 'active' WHERE id = $1", [
            devFixtures.membershipAOwner
          ])
      },
      {
        name: "user",
        revoke: () =>
          ownerPool.query("UPDATE identity.users SET status = 'disabled' WHERE id = $1", [
            devFixtures.userA
          ]),
        restore: () =>
          ownerPool.query("UPDATE identity.users SET status = 'active' WHERE id = $1", [
            devFixtures.userA
          ])
      },
      {
        name: "policy",
        revoke: () =>
          ownerPool.query(
            `UPDATE identity.policy_versions SET status = 'retired'
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
            [devFixtures.tenantA, devFixtures.workspaceA, actorContext.policyVersion]
          ),
        restore: () =>
          ownerPool.query(
            `UPDATE identity.policy_versions SET status = 'active'
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
            [devFixtures.tenantA, devFixtures.workspaceA, actorContext.policyVersion]
          )
      },
      {
        name: "space",
        revoke: () =>
          ownerPool.query(
            "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
            [state.sourceSpaceId]
          ),
        restore: () =>
          ownerPool.query("UPDATE access.spaces SET archived_at = NULL WHERE id = $1", [
            state.sourceSpaceId
          ])
      }
    ];

    for (const [index, authorityCase] of cases.entries()) {
      const key = `relationship-${authorityCase.name}-revocation-wins`;
      const created = await new AccountOperationsDomainCommandBus(appPool).execute(
        {
          kind: "relationship.create",
          idempotencyKey: `${key}-fixture`,
          payload: {
            subject: { type: "person", id: devFixtures.externalPersonA },
            predicate: `authority.${authorityCase.name}`,
            object: { type: "space", id: state.sourceSpaceId }
          }
        },
        actorContext
      );
      const racePool = createPgPool(appUrl!);
      const barrier = pauseAfterRelationshipScopeLookup(racePool, created.relationshipId);
      let ending: Promise<unknown> | undefined;
      try {
        ending = new AccountOperationsDomainCommandBus(barrier.pool).execute(
          {
            kind: "relationship.end",
            idempotencyKey: key,
            payload: {
              relationshipId: created.relationshipId,
              expectedVersion: 1,
              validTo: `2026-07-16T1${index}:30:00.000Z`
            }
          },
          actorContext
        );
        void ending.catch(() => undefined);
        await withDeadline(barrier.scopeResolved.promise, `${authorityCase.name} scope barrier`);
        await authorityCase.revoke();
        barrier.releaseScopeLookup.resolve();
        await expect(
          withDeadline(ending, `${authorityCase.name} revocation denial`)
        ).rejects.toMatchObject({
          name: "B1AuthorizationError",
          message: "B1 resource is unavailable"
        });
        const result = await ownerPool.query<{
          version: number;
          valid_to: Date | null;
          commands: string;
          audits: string;
          outbox: string;
        }>(
          `SELECT relationship.version, relationship.valid_to,
             (SELECT count(*)::text FROM ops.domain_command_records
              WHERE idempotency_key = $2) AS commands,
             (SELECT count(*)::text FROM ops.audit_events audit
              JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
              WHERE command.idempotency_key = $2) AS audits,
             (SELECT count(*)::text FROM ops.product_outbox_events event
              JOIN ops.domain_command_records command ON command.id = event.causation_command_id
              WHERE command.idempotency_key = $2) AS outbox
           FROM work.relationships relationship WHERE relationship.id = $1`,
          [created.relationshipId, key]
        );
        expect(result.rows[0]).toEqual({
          version: 1,
          valid_to: null,
          commands: "0",
          audits: "0",
          outbox: "0"
        });
      } finally {
        barrier.releaseScopeLookup.resolve();
        await ending?.catch(() => undefined);
        await authorityCase.restore();
        await racePool.end();
      }
    }
  }, 30_000);

  it("binds actor, policy, and governing Space rows so Relationship mutation wins before revocation", async () => {
    const actorContext = createDevSecurityContext("tenant-a-owner");
    const cases = [
      {
        name: "membership",
        revoke: (client: PgPoolClient) =>
          client.query(
            `UPDATE identity.memberships SET status = 'suspended'
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active'`,
            [actorContext.tenantId, actorContext.workspaceId, actorContext.actorMembershipId]
          ),
        restore: () =>
          ownerPool.query(
            `UPDATE identity.memberships SET status = 'active'
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
            [actorContext.tenantId, actorContext.workspaceId, actorContext.actorMembershipId]
          )
      },
      {
        name: "user",
        revoke: (client: PgPoolClient) =>
          client.query(
            "UPDATE identity.users SET status = 'disabled' WHERE id = $1 AND status = 'active'",
            [actorContext.actorUserId]
          ),
        restore: () =>
          ownerPool.query("UPDATE identity.users SET status = 'active' WHERE id = $1", [
            actorContext.actorUserId
          ])
      },
      {
        name: "policy",
        revoke: (client: PgPoolClient) =>
          client.query(
            `UPDATE identity.policy_versions SET status = 'retired'
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active'`,
            [actorContext.tenantId, actorContext.workspaceId, actorContext.policyVersion]
          ),
        restore: () =>
          ownerPool.query(
            `UPDATE identity.policy_versions SET status = 'active'
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
            [actorContext.tenantId, actorContext.workspaceId, actorContext.policyVersion]
          )
      },
      {
        name: "space",
        revoke: (client: PgPoolClient) =>
          client.query(
            `UPDATE access.spaces SET archived_at = clock_timestamp()
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL`,
            [actorContext.tenantId, actorContext.workspaceId, state.sourceSpaceId]
          ),
        restore: () =>
          ownerPool.query(
            `UPDATE access.spaces SET archived_at = NULL
             WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
            [actorContext.tenantId, actorContext.workspaceId, state.sourceSpaceId]
          )
      }
    ];

    for (const [index, authorityCase] of cases.entries()) {
      const key = `relationship-${authorityCase.name}-mutation-wins`;
      const validTo = `2026-07-16T2${index}:30:00.000Z`;
      const created = await new AccountOperationsDomainCommandBus(appPool).execute(
        {
          kind: "relationship.create",
          idempotencyKey: `${key}-fixture`,
          payload: {
            subject: { type: "person", id: devFixtures.externalPersonA },
            predicate: `authority.${authorityCase.name}.mutation_wins`,
            object: { type: "space", id: state.sourceSpaceId }
          }
        },
        actorContext
      );
      expect(created.spaceId).toBe(state.sourceSpaceId);

      const racePool = createPgPool(appUrl!);
      const baseAuthorization = new PostgresAuthorizationService(racePool);
      const baseBatch = baseAuthorization as unknown as RelationshipAuthorityBatchTestService;
      const completeAuthorityBatchLocked = deferred();
      const releaseRelationshipEnd = deferred();
      let paused = false;
      let relationshipBackendPid = -1;
      const authorization: TransactionAwareAuthorizationService &
        RelationshipAuthorityBatchTestService = {
        can: (context, action, resource, options) =>
          baseAuthorization.can(context, action, resource, options),
        canInTransaction: (context, action, resource, tx, options) =>
          baseAuthorization.canInTransaction(context, action, resource, tx, options),
        preauthorizeRelationshipEndInTransaction: (context, resource, tx) =>
          baseBatch.preauthorizeRelationshipEndInTransaction(context, resource, tx),
        lockAndReauthorizeRelationshipAuthorityInTransaction: async (context, requests, tx) => {
          const decision = await baseBatch.lockAndReauthorizeRelationshipAuthorityInTransaction(
            context,
            requests,
            tx
          );
          if (!paused && decision.allowed) {
            paused = true;
            const backend = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            relationshipBackendPid = backend.rows[0]!.pid;
            completeAuthorityBatchLocked.resolve();
            await releaseRelationshipEnd.promise;
          }
          return decision;
        }
      };
      const authorityMutator = await ownerPool.connect();
      let ending: Promise<unknown> | undefined;
      let opposingMutation: Promise<{ rowCount: number | null }> | undefined;
      try {
        ending = new AccountOperationsDomainCommandBus(racePool, authorization).execute(
          {
            kind: "relationship.end",
            idempotencyKey: key,
            payload: {
              relationshipId: created.relationshipId,
              expectedVersion: 1,
              validTo
            }
          },
          actorContext
        );
        void ending.catch(() => undefined);
        await withDeadline(
          completeAuthorityBatchLocked.promise,
          `${authorityCase.name} complete Relationship authority batch lock`
        );
        expect(relationshipBackendPid).toBeGreaterThan(0);

        const mutatorPid = await authorityMutator.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        );
        opposingMutation = authorityCase.revoke(authorityMutator);
        void opposingMutation.catch(() => undefined);
        await waitForBlockedBackend(ownerPool, mutatorPid.rows[0]!.pid);
        const blockers = await ownerPool.query<{ blockers: number[] }>(
          "SELECT pg_blocking_pids($1)::integer[] AS blockers",
          [mutatorPid.rows[0]!.pid]
        );
        expect(blockers.rows[0]!.blockers).toContain(relationshipBackendPid);

        releaseRelationshipEnd.resolve();
        await expect(
          withDeadline(ending, `${authorityCase.name} mutation-first Relationship end deadlocked`)
        ).resolves.toMatchObject({
          relationshipId: created.relationshipId,
          version: 2
        });
        const opposingResult = await withDeadline(
          opposingMutation,
          `${authorityCase.name} revocation did not resume after Relationship end`
        );
        expect(opposingResult.rowCount).toBe(1);
        expect(await relationshipRaceOutcome(ownerPool, created.relationshipId, key)).toEqual({
          version: 2,
          valid_to: new Date(validTo),
          commands: "1",
          audits: "1",
          outbox: "1"
        });
      } finally {
        releaseRelationshipEnd.resolve();
        try {
          await ending?.catch(() => undefined);
          await opposingMutation?.catch(() => undefined);
          await authorityCase.restore();
        } finally {
          authorityMutator.release();
          await racePool.end();
        }
      }
    }
  }, 60_000);

  it("binds endpoint grants so Relationship mutation wins and revocation blocks without deadlock", async () => {
    const contextGrant = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'contributor','space',$4,'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.sourceSpaceId
      ]
    );
    const endpointGrant = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships (
         tenant_id, workspace_id, subject_type, subject_id, relation,
         resource_type, resource_id, source
       ) VALUES ($1,$2,'membership',$3,'viewer','space',
         (SELECT space_id FROM work.organizations WHERE id = $4),'direct') RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.organizationId
      ]
    );
    const racePool = createPgPool(appUrl!);
    const baseAuthorization = new PostgresAuthorizationService(racePool);
    const baseBatch = baseAuthorization as unknown as RelationshipAuthorityBatchTestService;
    const relationshipAuthorityLocked = deferred();
    const releaseMutation = deferred();
    let ending: Promise<unknown> | undefined;
    const authorization: TransactionAwareAuthorizationService &
      RelationshipAuthorityBatchTestService = {
      can: (context, action, resource, options) =>
        baseAuthorization.can(context, action, resource, options),
      canInTransaction: (context, action, resource, tx, options) =>
        baseAuthorization.canInTransaction(context, action, resource, tx, options),
      preauthorizeRelationshipEndInTransaction: (context, resource, tx) =>
        baseBatch.preauthorizeRelationshipEndInTransaction(context, resource, tx),
      lockAndReauthorizeRelationshipAuthorityInTransaction: async (context, requests, tx) => {
        const decision = await baseBatch.lockAndReauthorizeRelationshipAuthorityInTransaction(
          context,
          requests,
          tx
        );
        if (decision.allowed) {
          relationshipAuthorityLocked.resolve();
          await releaseMutation.promise;
        }
        return decision;
      }
    };
    const bus = new AccountOperationsDomainCommandBus(racePool, authorization);
    const revoker = await ownerPool.connect();
    let deletion: Promise<unknown> | undefined;
    try {
      const created = await bus.execute(
        {
          kind: "relationship.create",
          idempotencyKey: "post-auth-revocation-relationship",
          payload: {
            subject: { type: "organization", id: state.organizationId },
            predicate: "works_with",
            object: { type: "person", id: devFixtures.externalPersonA },
            context: { type: "space", id: state.sourceSpaceId }
          }
        },
        createDevSecurityContext("tenant-a-owner")
      );
      ending = bus.execute(
        {
          kind: "relationship.end",
          idempotencyKey: "post-auth-mutation-wins",
          payload: {
            relationshipId: created.relationshipId,
            expectedVersion: 1,
            validTo: "2026-07-16T13:00:00.000Z"
          }
        },
        createDevSecurityContext("tenant-a-viewer")
      );
      void ending.catch(() => undefined);
      await withDeadline(
        relationshipAuthorityLocked.promise,
        "Relationship endpoint locks were not acquired"
      );
      const revokerPid = await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      deletion = revoker.query("DELETE FROM access.access_relationships WHERE id = $1", [
        endpointGrant.rows[0]!.id
      ]);
      await waitForBlockedBackend(ownerPool, revokerPid.rows[0]!.pid);
      releaseMutation.resolve();
      await expect(withDeadline(ending, "Relationship end deadlocked")).resolves.toMatchObject({
        relationshipId: created.relationshipId,
        version: 2
      });
      await withDeadline(deletion, "Endpoint grant revocation did not finish after mutation");

      const committed = await ownerPool.query<{
        version: number;
        valid_to: Date | null;
        commands: string;
        audits: string;
        outbox: string;
      }>(
        `SELECT relationship.version, relationship.valid_to,
          (SELECT count(*)::text FROM ops.domain_command_records
           WHERE idempotency_key = 'post-auth-mutation-wins') AS commands,
          (SELECT count(*)::text FROM ops.audit_events audit
           JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
           WHERE command.idempotency_key = 'post-auth-mutation-wins') AS audits,
          (SELECT count(*)::text FROM ops.product_outbox_events event
           JOIN ops.domain_command_records command ON command.id = event.causation_command_id
           WHERE command.idempotency_key = 'post-auth-mutation-wins') AS outbox
         FROM work.relationships relationship WHERE relationship.id = $1`,
        [created.relationshipId]
      );
      expect(committed.rows[0]).toEqual({
        version: 2,
        valid_to: new Date("2026-07-16T13:00:00.000Z"),
        commands: "1",
        audits: "1",
        outbox: "1"
      });
    } finally {
      releaseMutation.resolve();
      await ending?.catch(() => undefined);
      await deletion?.catch(() => undefined);
      revoker.release();
      await racePool.end();
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        contextGrant.rows[0]!.id
      ]);
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = $1", [
        endpointGrant.rows[0]!.id
      ]);
    }
  });

  it("binds inherited endpoint Space paths across restriction, archival, and reparent races", async () => {
    const ancestorSpaceId = "79000000-0000-7000-8000-000000000100";
    const intermediateSpaceId = "79000000-0000-7000-8000-000000000101";
    const targetSpaceId = "79000000-0000-7000-8000-000000000102";
    const alternateParentSpaceId = "79000000-0000-7000-8000-000000000103";
    await ownerPool.query(
      `INSERT INTO access.spaces
       (id, tenant_id, workspace_id, parent_space_id, kind, name, slug, access_class, inheritance_mode)
       VALUES
       ($1,$5,$6,$7,'knowledge','Inherited authority ancestor','b1-inherited-authority-ancestor','restricted','inherit'),
       ($2,$5,$6,$1,'knowledge','Inherited authority intermediate','b1-inherited-authority-intermediate','restricted','inherit'),
       ($3,$5,$6,$2,'knowledge','Inherited authority target','b1-inherited-authority-target','restricted','inherit'),
       ($4,$5,$6,$7,'knowledge','Inherited authority alternate','b1-inherited-authority-alternate','restricted','inherit')`,
      [
        ancestorSpaceId,
        intermediateSpaceId,
        targetSpaceId,
        alternateParentSpaceId,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.rootSpaceA
      ]
    );
    const grants = await ownerPool.query<{ id: string; relation: string }>(
      `INSERT INTO access.access_relationships
       (tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
       VALUES
       ($1,$2,'membership',$3,'contributor','space',$4,'direct'),
       ($1,$2,'membership',$3,'viewer','space',$5,'direct')
       RETURNING id, relation`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        state.sourceSpaceId,
        ancestorSpaceId
      ]
    );
    expect(grants.rows).toHaveLength(2);
    const ownerContext = createDevSecurityContext("tenant-a-owner");
    const viewerContext = createDevSecurityContext("tenant-a-viewer");

    const raceCases = [
      {
        name: "intermediate-restriction",
        revokeSql: "UPDATE access.spaces SET inheritance_mode = 'restricted' WHERE id = $1",
        revokeValues: [intermediateSpaceId],
        restoreSql: "UPDATE access.spaces SET inheritance_mode = 'inherit' WHERE id = $1",
        restoreValues: [intermediateSpaceId]
      },
      {
        name: "ancestor-archival",
        revokeSql: "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
        revokeValues: [ancestorSpaceId],
        restoreSql: "UPDATE access.spaces SET archived_at = NULL WHERE id = $1",
        restoreValues: [ancestorSpaceId]
      },
      {
        name: "intermediate-reparent",
        revokeSql: "UPDATE access.spaces SET parent_space_id = $2 WHERE id = $1",
        revokeValues: [intermediateSpaceId, alternateParentSpaceId],
        restoreSql: "UPDATE access.spaces SET parent_space_id = $2 WHERE id = $1",
        restoreValues: [intermediateSpaceId, ancestorSpaceId]
      }
    ];

    async function createRaceRelationship(key: string) {
      return new AccountOperationsDomainCommandBus(appPool).execute(
        {
          kind: "relationship.create",
          idempotencyKey: `${key}-fixture`,
          payload: {
            subject: { type: "person", id: devFixtures.externalPersonA },
            predicate: `inherited_path.${key.replace(/-/g, "_")}`,
            object: { type: "space", id: targetSpaceId },
            context: { type: "space", id: state.sourceSpaceId }
          }
        },
        ownerContext
      );
    }

    try {
      for (const [index, raceCase] of raceCases.entries()) {
        const key = `inherited-${raceCase.name}-revocation-wins`;
        const created = await createRaceRelationship(key);
        const racePool = createPgPool(appUrl!);
        const barrier = pauseAfterRelationshipScopeLookup(racePool, created.relationshipId);
        let ending: Promise<unknown> | undefined;
        try {
          ending = new AccountOperationsDomainCommandBus(barrier.pool).execute(
            {
              kind: "relationship.end",
              idempotencyKey: key,
              payload: {
                relationshipId: created.relationshipId,
                expectedVersion: 1,
                validTo: `2026-07-16T0${index + 1}:00:00.000Z`
              }
            },
            viewerContext
          );
          void ending.catch(() => undefined);
          await withDeadline(barrier.scopeResolved.promise, `${raceCase.name} scope barrier`);
          await ownerPool.query(raceCase.revokeSql, raceCase.revokeValues);
          barrier.releaseScopeLookup.resolve();
          await expect(
            withDeadline(ending, `${raceCase.name} revocation-wins denial`)
          ).rejects.toMatchObject({
            name: "B1AuthorizationError",
            message: "B1 resource is unavailable"
          });
          const denied = await ownerPool.query<{
            version: number;
            valid_to: Date | null;
            commands: string;
            audits: string;
            outbox: string;
          }>(
            `SELECT relationship.version, relationship.valid_to,
               (SELECT count(*)::text FROM ops.domain_command_records
                WHERE idempotency_key = $2) AS commands,
               (SELECT count(*)::text FROM ops.audit_events audit
                JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
                WHERE command.idempotency_key = $2) AS audits,
               (SELECT count(*)::text FROM ops.product_outbox_events event
                JOIN ops.domain_command_records command ON command.id = event.causation_command_id
                WHERE command.idempotency_key = $2) AS outbox
             FROM work.relationships relationship WHERE relationship.id = $1`,
            [created.relationshipId, key]
          );
          expect(denied.rows[0]).toEqual({
            version: 1,
            valid_to: null,
            commands: "0",
            audits: "0",
            outbox: "0"
          });
        } finally {
          barrier.releaseScopeLookup.resolve();
          await ending?.catch(() => undefined);
          await ownerPool.query(raceCase.restoreSql, raceCase.restoreValues);
          await racePool.end();
        }
      }

      for (const [index, raceCase] of raceCases.entries()) {
        const key = `inherited-${raceCase.name}-mutation-wins`;
        const created = await createRaceRelationship(key);
        const racePool = createPgPool(appUrl!);
        const baseAuthorization = new PostgresAuthorizationService(racePool);
        const baseBatch = baseAuthorization as unknown as RelationshipAuthorityBatchTestService;
        const inheritedPathLocked = deferred();
        const releaseMutation = deferred();
        let paused = false;
        const authorization: TransactionAwareAuthorizationService &
          RelationshipAuthorityBatchTestService = {
          can: (context, action, resource, options) =>
            baseAuthorization.can(context, action, resource, options),
          canInTransaction: (context, action, resource, tx, options) =>
            baseAuthorization.canInTransaction(context, action, resource, tx, options),
          preauthorizeRelationshipEndInTransaction: (context, resource, tx) =>
            baseBatch.preauthorizeRelationshipEndInTransaction(context, resource, tx),
          lockAndReauthorizeRelationshipAuthorityInTransaction: async (context, requests, tx) => {
            const decision = await baseBatch.lockAndReauthorizeRelationshipAuthorityInTransaction(
              context,
              requests,
              tx
            );
            if (!paused && decision.allowed) {
              paused = true;
              inheritedPathLocked.resolve();
              await releaseMutation.promise;
            }
            return decision;
          }
        };
        const revoker = await ownerPool.connect();
        let ending: Promise<unknown> | undefined;
        let revocation: Promise<unknown> | undefined;
        try {
          ending = new AccountOperationsDomainCommandBus(racePool, authorization).execute(
            {
              kind: "relationship.end",
              idempotencyKey: key,
              payload: {
                relationshipId: created.relationshipId,
                expectedVersion: 1,
                validTo: `2026-07-16T1${index + 1}:00:00.000Z`
              }
            },
            viewerContext
          );
          void ending.catch(() => undefined);
          await withDeadline(inheritedPathLocked.promise, `${raceCase.name} inherited path lock`);
          const revokerPid = await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          revocation = revoker.query(raceCase.revokeSql, raceCase.revokeValues);
          await waitForBlockedBackend(ownerPool, revokerPid.rows[0]!.pid);
          releaseMutation.resolve();
          await expect(
            withDeadline(ending, `${raceCase.name} mutation deadlocked`)
          ).resolves.toMatchObject({
            relationshipId: created.relationshipId,
            version: 2
          });
          await withDeadline(revocation, `${raceCase.name} revocation did not resume`);
          const committed = await ownerPool.query<{
            version: number;
            commands: string;
            audits: string;
            outbox: string;
          }>(
            `SELECT relationship.version,
               (SELECT count(*)::text FROM ops.domain_command_records
                WHERE idempotency_key = $2) AS commands,
               (SELECT count(*)::text FROM ops.audit_events audit
                JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
                WHERE command.idempotency_key = $2) AS audits,
               (SELECT count(*)::text FROM ops.product_outbox_events event
                JOIN ops.domain_command_records command ON command.id = event.causation_command_id
                WHERE command.idempotency_key = $2) AS outbox
             FROM work.relationships relationship WHERE relationship.id = $1`,
            [created.relationshipId, key]
          );
          expect(committed.rows[0]).toEqual({
            version: 2,
            commands: "1",
            audits: "1",
            outbox: "1"
          });
        } finally {
          releaseMutation.resolve();
          await ending?.catch(() => undefined);
          await revocation?.catch(() => undefined);
          await ownerPool.query(raceCase.restoreSql, raceCase.restoreValues);
          revoker.release();
          await racePool.end();
        }
      }
    } finally {
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = ANY($1::uuid[])", [
        grants.rows.map(({ id }) => id)
      ]);
    }
  }, 60_000);

  it("globally orders Relationship authority against an opposing ancestor-first multi-row mutation", async () => {
    const ancestorSpaceId = "78000000-0000-7000-8000-000000000100";
    const intermediateSpaceId = "78000000-0000-7000-8000-000000000200";
    const targetSpaceId = "78000000-0000-7000-8000-000000000300";
    const alternateParentSpaceId = "78000000-0000-7000-8000-000000000400";
    const governingSpaceId = "78000000-0000-7000-8000-000000000900";
    await ownerPool.query(
      `INSERT INTO access.spaces
       (id, tenant_id, workspace_id, parent_space_id, kind, name, slug, access_class, inheritance_mode)
       VALUES
       ($1,$6,$7,$8,'knowledge','Lock order ancestor','b1-lock-order-ancestor','restricted','inherit'),
       ($2,$6,$7,$1,'knowledge','Lock order intermediate','b1-lock-order-intermediate','restricted','inherit'),
       ($3,$6,$7,$2,'knowledge','Lock order target','b1-lock-order-target','restricted','inherit'),
       ($4,$6,$7,$8,'knowledge','Lock order alternate','b1-lock-order-alternate','restricted','inherit'),
       ($5,$6,$7,$8,'knowledge','Lock order governing','b1-lock-order-governing','restricted','restricted')`,
      [
        ancestorSpaceId,
        intermediateSpaceId,
        targetSpaceId,
        alternateParentSpaceId,
        governingSpaceId,
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.rootSpaceA
      ]
    );
    const relay = await ownerPool.query<{ id: string }>(
      `SELECT principal.id FROM identity.service_principals principal
       JOIN access.access_relationships grant_record
         ON grant_record.tenant_id = principal.tenant_id
        AND grant_record.workspace_id = principal.workspace_id
        AND grant_record.subject_type = 'service_principal'
        AND grant_record.subject_id = principal.id
        AND grant_record.relation = 'manager'
        AND grant_record.resource_type = 'space'
        AND grant_record.resource_id = $3
        AND grant_record.source = 'direct'
       WHERE principal.tenant_id = $1 AND principal.workspace_id = $2
         AND principal.purpose = 'product_notification_relay' AND principal.status = 'active'
       ORDER BY principal.id`,
      [devFixtures.tenantA, devFixtures.workspaceA, state.sourceSpaceId]
    );
    expect(relay.rows).toHaveLength(1);
    const grants = await ownerPool.query<{ id: string }>(
      `INSERT INTO access.access_relationships
       (tenant_id, workspace_id, subject_type, subject_id, relation, resource_type, resource_id, source)
       VALUES
       ($1,$2,'membership',$3,'contributor','space',$4,'direct'),
       ($1,$2,'membership',$3,'viewer','space',$5,'direct'),
       ($1,$2,'service_principal',$6,'manager','space',$4,'direct')
       RETURNING id`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        devFixtures.membershipAViewer,
        governingSpaceId,
        ancestorSpaceId,
        relay.rows[0]!.id
      ]
    );
    const ownerContext = createDevSecurityContext("tenant-a-owner");
    const viewerContext = createDevSecurityContext("tenant-a-viewer");
    const createRelationship = (key: string) =>
      new AccountOperationsDomainCommandBus(appPool).execute(
        {
          kind: "relationship.create",
          idempotencyKey: `${key}-fixture`,
          payload: {
            subject: { type: "person", id: devFixtures.externalPersonA },
            predicate: `lock_order.${key.replace(/-/g, "_")}`,
            object: { type: "space", id: targetSpaceId },
            context: { type: "space", id: governingSpaceId }
          }
        },
        ownerContext
      );

    try {
      const authorityWinsKey = "global-lock-order-authority-wins";
      const authorityWinsRelationship = await createRelationship(authorityWinsKey);
      const authorityClient = await ownerPool.connect();
      const authorityRacePool = createPgPool(appUrl!);
      let authorityEnding: Promise<unknown> | undefined;
      try {
        await authorityClient.query("BEGIN");
        await authorityClient.query("SELECT id FROM access.spaces WHERE id = $1 FOR UPDATE", [
          ancestorSpaceId
        ]);
        const authorityPid = await authorityClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        );
        authorityEnding = new AccountOperationsDomainCommandBus(authorityRacePool).execute(
          {
            kind: "relationship.end",
            idempotencyKey: authorityWinsKey,
            payload: {
              relationshipId: authorityWinsRelationship.relationshipId,
              expectedVersion: 1,
              validTo: "2026-07-16T16:00:00.000Z"
            }
          },
          viewerContext
        );
        void authorityEnding.catch(() => undefined);
        await waitForAppSpaceAuthorityLockBlocked(
          ownerPool,
          authorityPid.rows[0]!.pid,
          "authority-wins Relationship lock"
        );
        await withDeadline(
          authorityClient.query("SELECT id FROM access.spaces WHERE id = $1 FOR UPDATE", [
            governingSpaceId
          ]),
          "Ancestor-first authority transaction deadlocked on governing Space"
        );
        await authorityClient.query("UPDATE access.spaces SET parent_space_id = $2 WHERE id = $1", [
          intermediateSpaceId,
          alternateParentSpaceId
        ]);
        await authorityClient.query("COMMIT");
        await expect(
          withDeadline(authorityEnding, "Authority-wins Relationship denial deadlocked")
        ).rejects.toMatchObject({
          name: "B1AuthorizationError",
          message: "B1 resource is unavailable"
        });
        const denied = await relationshipRaceOutcome(
          ownerPool,
          authorityWinsRelationship.relationshipId,
          authorityWinsKey
        );
        expect(denied).toEqual({
          version: 1,
          valid_to: null,
          commands: "0",
          audits: "0",
          outbox: "0"
        });
      } finally {
        await authorityClient.query("ROLLBACK").catch(() => undefined);
        await authorityEnding?.catch(() => undefined);
        authorityClient.release();
        await authorityRacePool.end();
        await ownerPool.query("UPDATE access.spaces SET parent_space_id = $2 WHERE id = $1", [
          intermediateSpaceId,
          ancestorSpaceId
        ]);
      }

      const mutationWinsKey = "global-lock-order-mutation-wins";
      const mutationWinsRelationship = await createRelationship(mutationWinsKey);
      const mutationRacePool = createPgPool(appUrl!);
      const baseAuthorization = new PostgresAuthorizationService(mutationRacePool);
      const baseBatch = baseAuthorization as unknown as RelationshipAuthorityBatchTestService;
      const authorityLocked = deferred();
      const releaseRelationship = deferred();
      const authorization: TransactionAwareAuthorizationService &
        RelationshipAuthorityBatchTestService = {
        can: (context, action, resource, options) =>
          baseAuthorization.can(context, action, resource, options),
        canInTransaction: (context, action, resource, tx, options) =>
          baseAuthorization.canInTransaction(context, action, resource, tx, options),
        preauthorizeRelationshipEndInTransaction: (context, resource, tx) =>
          baseBatch.preauthorizeRelationshipEndInTransaction(context, resource, tx),
        lockAndReauthorizeRelationshipAuthorityInTransaction: async (context, requests, tx) => {
          const decision = await baseBatch.lockAndReauthorizeRelationshipAuthorityInTransaction(
            context,
            requests,
            tx
          );
          if (decision.allowed) {
            authorityLocked.resolve();
            await releaseRelationship.promise;
          }
          return decision;
        }
      };
      const mutationClient = await ownerPool.connect();
      let mutationEnding: Promise<unknown> | undefined;
      let opposingLock: Promise<unknown> | undefined;
      try {
        mutationEnding = new AccountOperationsDomainCommandBus(
          mutationRacePool,
          authorization
        ).execute(
          {
            kind: "relationship.end",
            idempotencyKey: mutationWinsKey,
            payload: {
              relationshipId: mutationWinsRelationship.relationshipId,
              expectedVersion: 1,
              validTo: "2026-07-16T17:00:00.000Z"
            }
          },
          viewerContext
        );
        void mutationEnding.catch(() => undefined);
        await withDeadline(authorityLocked.promise, "Global Relationship authority lock barrier");
        await mutationClient.query("BEGIN");
        const mutationPid = await mutationClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        );
        opposingLock = mutationClient.query(
          `SELECT id FROM access.spaces
           WHERE id = ANY($1::uuid[])
           ORDER BY id FOR UPDATE`,
          [[ancestorSpaceId, intermediateSpaceId, governingSpaceId]]
        );
        void opposingLock.catch(() => undefined);
        await waitForBlockedBackend(ownerPool, mutationPid.rows[0]!.pid);
        releaseRelationship.resolve();
        await expect(
          withDeadline(mutationEnding, "Mutation-wins Relationship end deadlocked")
        ).resolves.toMatchObject({
          relationshipId: mutationWinsRelationship.relationshipId,
          version: 2
        });
        await withDeadline(opposingLock, "Opposing multi-row Space lock did not resume");
        await mutationClient.query("UPDATE access.spaces SET parent_space_id = $2 WHERE id = $1", [
          intermediateSpaceId,
          alternateParentSpaceId
        ]);
        await mutationClient.query("COMMIT");
        const committed = await relationshipRaceOutcome(
          ownerPool,
          mutationWinsRelationship.relationshipId,
          mutationWinsKey
        );
        expect(committed).toEqual({
          version: 2,
          valid_to: new Date("2026-07-16T17:00:00.000Z"),
          commands: "1",
          audits: "1",
          outbox: "1"
        });
      } finally {
        releaseRelationship.resolve();
        await mutationClient.query("ROLLBACK").catch(() => undefined);
        await mutationEnding?.catch(() => undefined);
        await opposingLock?.catch(() => undefined);
        mutationClient.release();
        await mutationRacePool.end();
        await ownerPool.query("UPDATE access.spaces SET parent_space_id = $2 WHERE id = $1", [
          intermediateSpaceId,
          ancestorSpaceId
        ]);
      }
    } finally {
      await ownerPool.query("DELETE FROM access.access_relationships WHERE id = ANY($1::uuid[])", [
        grants.rows.map(({ id }) => id)
      ]);
    }
  }, 60_000);

  it("binds source provenance to the exact immutable Content revision bytes", async () => {
    const bus = new AccountOperationsDomainCommandBus(appPool);
    const unicodeBody = "Résumé 👩🏽‍💻\r\nΔοκιμή";
    const created = await bus.execute(
      {
        kind: "content.create",
        idempotencyKey: "origin-content-create",
        payload: {
          spaceId: state.sourceSpaceId,
          type: "note",
          title: "Exact source origin",
          body: unicodeBody
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    const exact = await bus.execute(
      {
        kind: "source.capture",
        idempotencyKey: "origin-source-exact",
        payload: {
          activityId: state.activityId,
          sourceType: "note",
          text: unicodeBody,
          originContentItemId: created.contentItemId,
          originContentRevision: 1
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    const stored = await ownerPool.query<{
      immutable_text: string;
      origin_content_item_id: string;
      origin_content_revision: number;
    }>(
      `SELECT immutable_text, origin_content_item_id, origin_content_revision
       FROM content.source_artifacts WHERE id = $1`,
      [exact.sourceArtifactId]
    );
    expect(stored.rows[0]).toEqual({
      immutable_text: unicodeBody,
      origin_content_item_id: created.contentItemId,
      origin_content_revision: 1
    });

    const revised = await bus.execute(
      {
        kind: "content.revise",
        idempotencyKey: "origin-content-revise",
        payload: {
          contentItemId: created.contentItemId,
          expectedRevision: 1,
          body: "Second immutable revision."
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    expect(revised).toMatchObject({ revisionNumber: 2, version: 2 });
    const invalidCreateContext = activityContext(state.sourceSpaceId);
    await expect(
      withTenantTransaction(
        {
          pool: appPool,
          context: invalidCreateContext
        },
        async (tx) => {
          const commands = new DomainCommandRepository(tx);
          const commandId = "76000000-0000-7000-8000-000000000099";
          const requestHash = hashCanonicalCommandRequest({ proof: "create-cannot-bind-later" });
          await commands.reserve({
            id: commandId,
            tenantId: devFixtures.tenantA,
            workspaceId: devFixtures.workspaceA,
            reservationSpaceId: state.sourceSpaceId,
            commandKind: "content.create.v1",
            commandSchemaVersion: 1,
            idempotencyKey: "create-cannot-bind-later",
            canonicalRequestHash: requestHash,
            actorUserId: invalidCreateContext.actorUserId!,
            actorMembershipId: invalidCreateContext.actorMembershipId!,
            policyVersionId: invalidCreateContext.policyVersion,
            requestId: "create-cannot-bind-later",
            traceparent
          });
          await commands.complete({
            commandId,
            tenantId: devFixtures.tenantA,
            workspaceId: devFixtures.workspaceA,
            reservationSpaceId: state.sourceSpaceId,
            commandKind: "content.create.v1",
            idempotencyKey: "create-cannot-bind-later",
            canonicalRequestHash: requestHash,
            resultResourceType: "content_item",
            resultResourceId: created.contentItemId,
            safeResponse: {
              contentItemId: created.contentItemId,
              revisionNumber: 2,
              version: 2
            }
          });
        }
      )
    ).rejects.toThrow();
    const invalidCreateResidue = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ops.domain_command_records
       WHERE idempotency_key = 'create-cannot-bind-later'`
    );
    expect(invalidCreateResidue.rows[0]?.count).toBe("0");

    for (const [idempotencyKey, originContentItemId, originContentRevision, text] of [
      ["origin-source-unicode-mismatch", created.contentItemId, 1, "Resume\u0301 👩🏽‍💻\r\nΔοκιμή"],
      ["origin-source-missing", "70000000-0000-7000-8000-000000009991", 1, unicodeBody],
      ["origin-source-revision-missing", created.contentItemId, 99, unicodeBody]
    ] as const) {
      await expect(
        bus.execute(
          {
            kind: "source.capture",
            idempotencyKey,
            payload: {
              activityId: state.activityId,
              sourceType: "note",
              text,
              originContentItemId,
              originContentRevision
            }
          },
          createDevSecurityContext("tenant-a-owner")
        )
      ).rejects.toThrow();
    }

    const inaccessibleItemId = "75000000-0000-7000-8000-000000000091";
    const inaccessibleRevisionId = "75000000-0000-7000-8000-000000000092";
    const fixtureClient = await ownerPool.connect();
    try {
      await fixtureClient.query("BEGIN");
      await fixtureClient.query(
        `INSERT INTO content.content_items (
           id, tenant_id, workspace_id, space_id, type, title, owner_person_id,
           access_class, metadata, current_revision, version
         ) VALUES ($1,$2,$3,$4,'note','Confidential exact origin',$5,
           'confidential','{}'::jsonb,1,1)`,
        [
          inaccessibleItemId,
          devFixtures.tenantA,
          devFixtures.workspaceA,
          state.sourceSpaceId,
          devFixtures.personA
        ]
      );
      await fixtureClient.query(
        `INSERT INTO content.content_revisions (
           id, tenant_id, workspace_id, space_id, content_item_id, revision_number,
           title, body, metadata, access_class, created_by_user_id, created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,1,'Confidential exact origin',$6,
           '{}'::jsonb,'confidential',$7,$8)`,
        [
          inaccessibleRevisionId,
          devFixtures.tenantA,
          devFixtures.workspaceA,
          state.sourceSpaceId,
          inaccessibleItemId,
          unicodeBody,
          devFixtures.userA,
          devFixtures.membershipAOwner
        ]
      );
      await fixtureClient.query("COMMIT");
    } catch (error) {
      await fixtureClient.query("ROLLBACK");
      throw error;
    } finally {
      fixtureClient.release();
    }
    const lowerCeilingContext = createDevSecurityContext("tenant-a-owner");
    await expect(
      new PostgresAuthorizationService(appPool).can(lowerCeilingContext, "content.read", {
        type: "content_item",
        id: inaccessibleItemId
      })
    ).resolves.toMatchObject({ allowed: false, reasonCode: "b1_resource_not_available" });

    await expect(
      bus.execute(
        {
          kind: "content.revise",
          idempotencyKey: "confidential-content-revise-denied",
          payload: {
            contentItemId: inaccessibleItemId,
            expectedRevision: 1,
            body: "A lower-ceiling actor must not revise this."
          }
        },
        lowerCeilingContext
      )
    ).rejects.toMatchObject({ name: "B1AuthorizationError" });

    await expect(
      bus.execute(
        {
          kind: "relationship.create",
          idempotencyKey: "confidential-content-reference-denied",
          payload: {
            subject: { type: "content", id: inaccessibleItemId },
            predicate: "supports",
            object: { type: "person", id: devFixtures.externalPersonA },
            context: { type: "space", id: state.sourceSpaceId }
          }
        },
        lowerCeilingContext
      )
    ).rejects.toMatchObject({ name: "B1AuthorizationError" });

    const inaccessibleCaptures = await Promise.allSettled(
      [
        ["origin-source-inaccessible-match", unicodeBody],
        ["origin-source-inaccessible-mismatch", "caller-guessed different bytes"]
      ].map(([idempotencyKey, text]) =>
        bus.execute(
          {
            kind: "source.capture",
            idempotencyKey: idempotencyKey!,
            payload: {
              activityId: state.activityId,
              sourceType: "note",
              text: text!,
              originContentItemId: inaccessibleItemId,
              originContentRevision: 1
            }
          },
          lowerCeilingContext
        )
      )
    );
    expect(inaccessibleCaptures).toHaveLength(2);
    for (const outcome of inaccessibleCaptures) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({
          name: "B1AuthorizationError",
          message: "B1 resource is unavailable"
        });
      }
    }

    const lowerCeilingResidue = await ownerPool.query<{
      commands: string;
      sources: string;
      relationships: string;
      audits: string;
      outbox: string;
      revisions: string;
      revision: number;
      version: number;
    }>(
      `SELECT
        (SELECT count(*)::text FROM ops.domain_command_records
         WHERE idempotency_key IN (
           'confidential-content-revise-denied',
           'confidential-content-reference-denied',
           'origin-source-inaccessible-match',
           'origin-source-inaccessible-mismatch'
         )) AS commands,
        (SELECT count(*)::text FROM content.source_artifacts
         WHERE origin_content_item_id = $1) AS sources,
        (SELECT count(*)::text FROM work.relationships
         WHERE subject_type = 'content' AND subject_id = $1) AS relationships,
        (SELECT count(*)::text FROM ops.audit_events audit
         JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
         WHERE command.idempotency_key LIKE 'confidential-content-%'
            OR command.idempotency_key LIKE 'origin-source-inaccessible-%') AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events event
         JOIN ops.domain_command_records command ON command.id = event.causation_command_id
         WHERE command.idempotency_key LIKE 'confidential-content-%'
            OR command.idempotency_key LIKE 'origin-source-inaccessible-%') AS outbox,
        (SELECT count(*)::text FROM content.content_revisions revision
         WHERE revision.content_item_id = $1) AS revisions,
        item.current_revision AS revision, item.version
       FROM content.content_items item WHERE item.id = $1`,
      [inaccessibleItemId]
    );
    expect(lowerCeilingResidue.rows[0]).toEqual({
      commands: "0",
      sources: "0",
      relationships: "0",
      audits: "0",
      outbox: "0",
      revisions: "1",
      revision: 1,
      version: 1
    });

    const crossScopeSpace = await ownerPool.query<{ space_id: string }>(
      "SELECT space_id FROM work.organizations WHERE id = $1",
      [state.organizationId]
    );
    expect(crossScopeSpace.rows).toHaveLength(1);
    const crossScope = await bus.execute(
      {
        kind: "content.create",
        idempotencyKey: "origin-content-cross-scope",
        payload: {
          spaceId: crossScopeSpace.rows[0]!.space_id,
          type: "note",
          title: "Cross-scope source origin",
          body: unicodeBody
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    await expect(
      bus.execute(
        {
          kind: "source.capture",
          idempotencyKey: "origin-source-cross-scope",
          payload: {
            activityId: state.activityId,
            sourceType: "note",
            text: unicodeBody,
            originContentItemId: crossScope.contentItemId,
            originContentRevision: 1
          }
        },
        createDevSecurityContext("tenant-a-owner")
      )
    ).rejects.toMatchObject({ name: "B1AuthorizationError" });

    const rejected = await ownerPool.query<{ commands: string; sources: string }>(
      `SELECT
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key LIKE 'origin-source-%'
            AND idempotency_key <> 'origin-source-exact') AS commands,
        (SELECT count(*)::text FROM content.source_artifacts
          WHERE origin_content_item_id = $1 AND id <> $2) AS sources`,
      [created.contentItemId, exact.sourceArtifactId]
    );
    expect(rejected.rows[0]).toEqual({ commands: "0", sources: "0" });
  });

  it("rolls back a tombstone, chunks, audit, and command when the canonical outbox is omitted", async () => {
    const context = {
      ...createDevSecurityContext("tenant-a-owner"),
      requestedSpaceIds: [state.sourceSpaceId],
      requestId: "rollback-without-outbox",
      traceId: traceparent.slice(3, 35)
    };
    const commandId = "76000000-0000-7000-8000-000000000001";
    const requestHash = hashCanonicalCommandRequest({
      kind: "source.tombstone",
      fault: "omit-outbox"
    });
    await expect(
      withTenantTransaction({ pool: appPool, context }, async (tx) => {
        const commands = new DomainCommandRepository(tx);
        await commands.reserve({
          id: commandId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          reservationSpaceId: state.sourceSpaceId,
          commandKind: "source.tombstone.v1",
          commandSchemaVersion: 1,
          idempotencyKey: "rollback-without-outbox",
          canonicalRequestHash: requestHash,
          actorUserId: context.actorUserId!,
          actorMembershipId: context.actorMembershipId!,
          policyVersionId: context.policyVersion,
          requestId: context.requestId,
          traceparent
        });
        const updated = await new ContentRepository(tx).tombstoneSource({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          sourceArtifactId: state.sourceArtifactId,
          expectedVersion: 1,
          deletionReasonCategory: "retention-test",
          deletionPolicyRef: "policy:test"
        });
        await new AuditEventRepository(tx).insert({
          id: "77000000-0000-7000-8000-000000000001",
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: state.sourceSpaceId,
          causationCommandId: commandId,
          actorUserId: context.actorUserId!,
          actorMembershipId: context.actorMembershipId!,
          policyVersionId: context.policyVersion,
          requestId: context.requestId,
          traceparent,
          action: "source_artifact.tombstone",
          resourceType: "source_artifact",
          resourceId: state.sourceArtifactId,
          auditSchemaVersion: 1,
          safeDetail: {
            sourceArtifactId: state.sourceArtifactId,
            deletionReasonCategory: "retention-test",
            deletionPolicyRef: "policy:test",
            hashDisposition: updated.hashDisposition
          }
        });
        await commands.complete({
          commandId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          reservationSpaceId: state.sourceSpaceId,
          commandKind: "source.tombstone.v1",
          idempotencyKey: "rollback-without-outbox",
          canonicalRequestHash: requestHash,
          resultResourceType: "source_artifact",
          resultResourceId: state.sourceArtifactId,
          safeResponse: {
            sourceArtifactId: state.sourceArtifactId,
            version: updated.version,
            hashDisposition: updated.hashDisposition
          }
        });
      })
    ).rejects.toThrow();
    const residue = await ownerPool.query<{
      live: boolean;
      chunks: string;
      commands: string;
      audits: string;
    }>(
      `SELECT
        (SELECT deleted_at IS NULL FROM content.source_artifacts WHERE id = $1) AS live,
        (SELECT count(*) FROM content.source_chunks WHERE source_artifact_id = $1)::text AS chunks,
        (SELECT count(*) FROM ops.domain_command_records WHERE id = $2)::text AS commands,
        (SELECT count(*) FROM ops.audit_events WHERE causation_command_id = $2)::text AS audits`,
      [state.sourceArtifactId, commandId]
    );
    expect(residue.rows[0]).toMatchObject({ live: true, commands: "0", audits: "0" });
    expect(Number(residue.rows[0]!.chunks)).toBeGreaterThan(0);
  });

  it("creates one correction leaf and tombstones it without falling back to stale evidence", async () => {
    const context = createDevSecurityContext("tenant-a-owner");
    const bus = new AccountOperationsDomainCommandBus(appPool);
    const corrected = await bus.execute(
      {
        kind: "source.correct",
        idempotencyKey: "workflow-source-correction",
        payload: {
          predecessorSourceArtifactId: state.sourceArtifactId,
          sourceType: "human",
          text: "Corrected human-authored account note."
        }
      },
      context
    );
    const tombstoned = await bus.execute(
      {
        kind: "source.tombstone",
        idempotencyKey: "workflow-source-tombstone",
        payload: {
          sourceArtifactId: corrected.sourceArtifactId,
          expectedVersion: 1,
          deletionReasonCategory: "retention",
          deletionPolicyRef: "policy:workspace"
        }
      },
      context
    );
    expect(tombstoned).toMatchObject({ version: 2, hashDisposition: "retained" });
    await expect(
      bus.execute(
        {
          kind: "source.correct",
          idempotencyKey: "workflow-source-correction",
          payload: {
            predecessorSourceArtifactId: state.sourceArtifactId,
            sourceType: "human",
            text: "Corrected human-authored account note."
          }
        },
        context
      )
    ).resolves.toEqual(corrected);
    await expect(
      bus.execute(
        {
          kind: "source.tombstone",
          idempotencyKey: "workflow-source-tombstone",
          payload: {
            sourceArtifactId: corrected.sourceArtifactId,
            expectedVersion: 1,
            deletionReasonCategory: "retention",
            deletionPolicyRef: "policy:workspace"
          }
        },
        context
      )
    ).resolves.toEqual(tombstoned);

    const current = await get(`/v1/sources/${state.sourceArtifactId}`);
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      id: corrected.sourceArtifactId,
      supersedesSourceId: state.sourceArtifactId,
      version: 2,
      chunks: []
    });
    expect(current.json()).not.toHaveProperty("immutableText");
  });

  it("serializes concurrent correction attempts into one successor with no losing residue", async () => {
    const capturedResponse = await post(
      `/v1/activities/${state.activityId}/sources`,
      "correction-race-source",
      { sourceType: "note", text: "Correction race predecessor." }
    );
    expect(capturedResponse.statusCode).toBe(201);
    const predecessor = capturedResponse.json<{ sourceArtifactId: string }>();
    const bus = new AccountOperationsDomainCommandBus(appPool);
    const attempts = await Promise.allSettled(
      ["a", "b"].map((suffix) =>
        bus.execute(
          {
            kind: "source.correct",
            idempotencyKey: `correction-race-${suffix}`,
            payload: {
              predecessorSourceArtifactId: predecessor.sourceArtifactId,
              sourceType: "human",
              text: `Correction candidate ${suffix}.`
            }
          },
          createDevSecurityContext("tenant-a-owner")
        )
      )
    );
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const losingAttempt = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"
    );
    expect(losingAttempt?.reason).toBeInstanceOf(ContentInvariantError);
    expect(losingAttempt?.reason).toMatchObject({
      message: "Source correction predecessor is unavailable"
    });
    const counts = await ownerPool.query<{
      successors: string;
      successor_chunks: string;
      successor_links: string;
      commands: string;
      audits: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM content.source_artifacts
          WHERE supersedes_source_id = $1) AS successors,
        (SELECT count(*)::text FROM content.source_chunks chunk
          JOIN content.source_artifacts successor
            ON successor.tenant_id = chunk.tenant_id
           AND successor.workspace_id = chunk.workspace_id
           AND successor.id = chunk.source_artifact_id
          WHERE successor.supersedes_source_id = $1) AS successor_chunks,
        (SELECT count(*)::text FROM work.activity_sources link
          JOIN content.source_artifacts successor
            ON successor.tenant_id = link.tenant_id
           AND successor.workspace_id = link.workspace_id
           AND successor.id = link.source_artifact_id
          WHERE successor.supersedes_source_id = $1) AS successor_links,
        (SELECT count(*)::text FROM ops.domain_command_records
          WHERE idempotency_key IN ('correction-race-a', 'correction-race-b')) AS commands,
        (SELECT count(*)::text FROM ops.audit_events audit JOIN ops.domain_command_records command
          ON command.tenant_id = audit.tenant_id AND command.workspace_id = audit.workspace_id
          AND command.id = audit.causation_command_id
          WHERE command.idempotency_key IN ('correction-race-a', 'correction-race-b')) AS audits,
        (SELECT count(*)::text FROM ops.product_outbox_events event JOIN ops.domain_command_records command
          ON command.tenant_id = event.tenant_id AND command.workspace_id = event.workspace_id
          AND command.id = event.causation_command_id
          WHERE command.idempotency_key IN ('correction-race-a', 'correction-race-b')) AS outbox`,
      [predecessor.sourceArtifactId]
    );
    expect(counts.rows[0]).toEqual({
      successors: "1",
      successor_chunks: "1",
      successor_links: "1",
      commands: "1",
      audits: "1",
      outbox: "1"
    });
  });

  it("erases governed hashes and never copies them into append-only correction metadata", async () => {
    await ownerPool.query(
      `UPDATE identity.workspaces SET retention_policy_id = 'erase_on_tombstone:test'
       WHERE tenant_id = $1 AND id = $2`,
      [devFixtures.tenantA, devFixtures.workspaceA]
    );
    const capturedResponse = await post(
      `/v1/activities/${state.activityId}/sources`,
      "erase-policy-source",
      { sourceType: "note", text: "Sensitive source governed by erasure policy." }
    );
    expect(capturedResponse.statusCode).toBe(201);
    const captured = capturedResponse.json<{ sourceArtifactId: string }>();
    const bus = new AccountOperationsDomainCommandBus(appPool);
    const corrected = await bus.execute(
      {
        kind: "source.correct",
        idempotencyKey: "erase-policy-correction",
        payload: {
          predecessorSourceArtifactId: captured.sourceArtifactId,
          sourceType: "human",
          text: "Corrected sensitive source governed by erasure policy."
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    const before = await ownerPool.query<{
      id: string;
      content_hash: string;
      normalized_content_hash: string;
      hash_retention_policy: string;
    }>(
      `SELECT id, content_hash, normalized_content_hash, hash_retention_policy
       FROM content.source_artifacts WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[captured.sourceArtifactId, corrected.sourceArtifactId]]
    );
    expect(before.rows).toHaveLength(2);
    expect(
      before.rows.every(
        ({ hash_retention_policy }) => hash_retention_policy === "erase_on_tombstone"
      )
    ).toBe(true);

    const tombstoned = await bus.execute(
      {
        kind: "source.tombstone",
        idempotencyKey: "erase-policy-tombstone",
        payload: {
          sourceArtifactId: corrected.sourceArtifactId,
          expectedVersion: 1,
          deletionReasonCategory: "lawful-erasure",
          deletionPolicyRef: "policy:erase-test"
        }
      },
      createDevSecurityContext("tenant-a-owner")
    );
    expect(tombstoned).toMatchObject({ version: 2, hashDisposition: "erased" });
    const after = await ownerPool.query<{
      content_hash: string | null;
      normalized_content_hash: string | null;
      hash_disposition: string;
      chunks: string;
    }>(
      `SELECT source.content_hash, source.normalized_content_hash, source.hash_disposition,
        (SELECT count(*)::text FROM content.source_chunks chunk
          WHERE chunk.source_artifact_id = source.id) AS chunks
       FROM content.source_artifacts source WHERE source.id = $1`,
      [corrected.sourceArtifactId]
    );
    expect(after.rows[0]).toEqual({
      content_hash: null,
      normalized_content_hash: null,
      hash_disposition: "erased",
      chunks: "0"
    });
    const appendOnlyMetadata = await ownerPool.query<{ metadata: string }>(
      `SELECT concat_ws('|',
        (SELECT string_agg(audit.safe_detail::text, '|' ORDER BY audit.id)
         FROM ops.audit_events audit JOIN ops.domain_command_records command
           ON command.tenant_id = audit.tenant_id AND command.workspace_id = audit.workspace_id
          AND command.id = audit.causation_command_id
         WHERE command.idempotency_key = ANY($1::text[])),
        (SELECT string_agg(event.payload::text, '|' ORDER BY event.id)
         FROM ops.product_outbox_events event JOIN ops.domain_command_records command
           ON command.tenant_id = event.tenant_id AND command.workspace_id = event.workspace_id
          AND command.id = event.causation_command_id
         WHERE command.idempotency_key = ANY($1::text[]))) AS metadata`,
      [["erase-policy-source", "erase-policy-correction", "erase-policy-tombstone"]]
    );
    for (const source of before.rows) {
      expect(appendOnlyMetadata.rows[0]!.metadata).not.toContain(source.content_hash);
      expect(appendOnlyMetadata.rows[0]!.metadata).not.toContain(source.normalized_content_hash);
    }
  });

  it("returns the same non-leaking shape for an inaccessible restricted Activity and an absent ID", async () => {
    const inaccessible = await app.inject({
      method: "GET",
      url: `/v1/activities/${state.activityId}`,
      headers: {
        "x-throughline-dev-identity": "tenant-a-viewer",
        "x-request-id": "denied-activity"
      }
    });
    const absent = await app.inject({
      method: "GET",
      url: "/v1/activities/70000000-0000-7000-8000-000000009999",
      headers: { "x-throughline-dev-identity": "tenant-a-owner", "x-request-id": "absent-activity" }
    });
    expect(inaccessible.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(inaccessible.json()).toEqual(absent.json());
    for (const secret of ["AI discovery workshop", state.sourceArtifactId, "Ignore all previous"]) {
      expect(inaccessible.body).not.toContain(secret);
    }
  });

  async function post(url: string, idempotencyKey: string, payload: object) {
    return postAs("tenant-a-owner", url, idempotencyKey, payload);
  }

  async function postAs(
    identity: "tenant-a-owner" | "tenant-a-viewer",
    url: string,
    idempotencyKey: string,
    payload: object
  ) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        "x-throughline-dev-identity": identity,
        "x-request-id": idempotencyKey,
        "idempotency-key": idempotencyKey
      },
      payload
    });
  }

  async function get(url: string) {
    return getAs("tenant-a-owner", url);
  }

  async function getAs(identity: "tenant-a-owner" | "tenant-a-viewer", url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: {
        "x-throughline-dev-identity": identity,
        "x-request-id": `get-${url}`.slice(0, 190)
      }
    });
  }
});

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

function activityContext(spaceId: string, context = createDevSecurityContext("tenant-a-owner")) {
  return { ...context, requestedSpaceIds: [spaceId] };
}

async function activityDigest(pool: PgPool, activityId: string) {
  const result = await pool.query<{ row_value: string; digest: string }>(
    `SELECT row_to_json(activity)::text AS row_value,
            encode(public.digest(
              pg_catalog.convert_to(row_to_json(activity)::text, 'UTF8'), 'sha256'
            ), 'hex') AS digest
     FROM work.activities activity WHERE activity.id = $1`,
    [activityId]
  );
  if (result.rows.length !== 1) throw new Error("Activity digest row is unavailable");
  return result.rows[0]!;
}

async function sourcePipelineCounts(pool: PgPool) {
  const result = await pool.query<{
    organizations: string;
    initiatives: string;
    activities: string;
    relationships: string;
    contentItems: string;
    sources: string;
    chunks: string;
    links: string;
    commands: string;
    audits: string;
    outbox: string;
  }>(
    `SELECT
      (SELECT count(*)::text FROM work.organizations) AS organizations,
      (SELECT count(*)::text FROM work.initiatives) AS initiatives,
      (SELECT count(*)::text FROM work.activities) AS activities,
      (SELECT count(*)::text FROM work.relationships) AS relationships,
      (SELECT count(*)::text FROM content.content_items) AS "contentItems",
      (SELECT count(*)::text FROM content.source_artifacts) AS sources,
      (SELECT count(*)::text FROM content.source_chunks) AS chunks,
      (SELECT count(*)::text FROM work.activity_sources) AS links,
      (SELECT count(*)::text FROM ops.domain_command_records) AS commands,
      (SELECT count(*)::text FROM ops.audit_events) AS audits,
      (SELECT count(*)::text FROM ops.product_outbox_events) AS outbox`
  );
  return result.rows[0]!;
}

function pauseAfterSourceScopeLookup(
  realPool: PgPool,
  sourceArtifactId: string
): {
  pool: PgPool;
  scopeResolved: ReturnType<typeof deferred>;
  releaseScopeLookup: ReturnType<typeof deferred>;
} {
  const scopeResolved = deferred();
  const releaseScopeLookup = deferred();
  let paused = false;
  const pool = {
    connect: async () => {
      const client = await realPool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (text: unknown, ...args: unknown[]) => {
              const query = target.query as unknown as (
                text: unknown,
                ...args: unknown[]
              ) => Promise<unknown>;
              const result = await query.call(target, text, ...args);
              const values = args[0];
              if (
                !paused &&
                typeof text === "string" &&
                /SELECT\s+id,\s*space_id\s+FROM\s+content\.source_artifacts/i.test(text) &&
                Array.isArray(values) &&
                values[2] === sourceArtifactId
              ) {
                paused = true;
                scopeResolved.resolve();
                await releaseScopeLookup.promise;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as PgPoolClient;
    }
  } as unknown as PgPool;
  return { pool, scopeResolved, releaseScopeLookup };
}

function pauseAfterRelationshipScopeLookup(
  realPool: PgPool,
  relationshipId: string
): {
  pool: PgPool;
  scopeResolved: ReturnType<typeof deferred>;
  releaseScopeLookup: ReturnType<typeof deferred>;
} {
  const scopeResolved = deferred();
  const releaseScopeLookup = deferred();
  let paused = false;
  const pool = {
    connect: async () => {
      const client = await realPool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (text: unknown, ...args: unknown[]) => {
              const query = target.query as unknown as (
                text: unknown,
                ...args: unknown[]
              ) => Promise<unknown>;
              const result = await query.call(target, text, ...args);
              const values = args[0];
              if (
                !paused &&
                typeof text === "string" &&
                /SELECT\s+id,\s*space_id\s+FROM\s+work\.relationships/i.test(text) &&
                Array.isArray(values) &&
                values[2] === relationshipId
              ) {
                paused = true;
                scopeResolved.resolve();
                await releaseScopeLookup.promise;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as PgPoolClient;
    }
  } as unknown as PgPool;
  return { pool, scopeResolved, releaseScopeLookup };
}

type RelationshipAuthorityBatchTestService = {
  preauthorizeRelationshipEndInTransaction(
    context: Parameters<TransactionAwareAuthorizationService["canInTransaction"]>[0],
    resource: Parameters<TransactionAwareAuthorizationService["canInTransaction"]>[2],
    tx: TenantDbTransaction
  ): Promise<Awaited<ReturnType<TransactionAwareAuthorizationService["canInTransaction"]>>>;

  lockAndReauthorizeRelationshipAuthorityInTransaction(
    context: Parameters<TransactionAwareAuthorizationService["canInTransaction"]>[0],
    requests: readonly unknown[],
    tx: TenantDbTransaction
  ): Promise<Awaited<ReturnType<TransactionAwareAuthorizationService["canInTransaction"]>>>;
};

async function relationshipRaceOutcome(pool: PgPool, relationshipId: string, key: string) {
  const result = await pool.query<{
    version: number;
    valid_to: Date | null;
    commands: string;
    audits: string;
    outbox: string;
  }>(
    `SELECT relationship.version, relationship.valid_to,
       (SELECT count(*)::text FROM ops.domain_command_records
        WHERE idempotency_key = $2) AS commands,
       (SELECT count(*)::text FROM ops.audit_events audit
        JOIN ops.domain_command_records command ON command.id = audit.causation_command_id
        WHERE command.idempotency_key = $2) AS audits,
       (SELECT count(*)::text FROM ops.product_outbox_events event
        JOIN ops.domain_command_records command ON command.id = event.causation_command_id
        WHERE command.idempotency_key = $2) AS outbox
     FROM work.relationships relationship WHERE relationship.id = $1`,
    [relationshipId, key]
  );
  return result.rows[0];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function captureError(callback: () => Promise<unknown>): Promise<Error> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected operation to fail");
}

async function withDeadline<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 5_000
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForBlockedBackend(pool: PgPool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blockers: number[] }>(
      "SELECT pg_blocking_pids($1)::integer[] AS blockers",
      [pid]
    );
    if ((result.rows[0]?.blockers.length ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not reach the Activity lock barrier`);
}

async function waitForAppSpaceAuthorityLockBlocked(
  pool: PgPool,
  blockerPid: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid FROM pg_stat_activity activity
       WHERE activity.usename = 'throughline_app'
         AND $1 = ANY(pg_blocking_pids(activity.pid))
         AND activity.query LIKE '%access.spaces%'
         AND activity.query LIKE '%FOR SHARE%'
       ORDER BY activity.pid LIMIT 1`,
      [blockerPid]
    );
    if (result.rows.length === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not reach the Space authority lock barrier`);
}

async function waitForAppActivityLockBlocked(pool: PgPool, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid FROM pg_stat_activity activity
       WHERE activity.usename = 'throughline_app'
         AND $1 = ANY(pg_blocking_pids(activity.pid))
         AND activity.query LIKE '%FROM work.activities activity%'
         AND activity.query LIKE '%FOR SHARE OF activity%'
       ORDER BY activity.pid LIMIT 1`,
      [blockerPid]
    );
    if (result.rows.length === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Source capture did not reach the Activity SHARE lock barrier");
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
