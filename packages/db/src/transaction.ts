import type { SecurityContext } from "@throughline/core-types";
import type { DomainNotificationEnvelope } from "@throughline/core-types";
import { isSecurityContextExpired, parseSecurityContext } from "@throughline/tenancy";
import { randomBytes } from "node:crypto";
import type { PgPool, PgPoolClient, PgQueryResult } from "./client.js";
import {
  AuditEventRepository,
  ProductDomainOutboxWriter,
  type AuditEventInsert
} from "./product-domain-repositories.js";

export const SECURITY_CONTEXT_EXPIRED_MESSAGE = "SecurityContext has expired";

export interface TenantQueryExecutor {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<PgQueryResult<T>>;
}

export type TenantDbTransaction = TenantQueryExecutor & {
  client: PgPoolClient;
};

export interface TenantTransactionOptions {
  pool: PgPool;
  context: SecurityContext;
}

export interface ChildOrganizationInsert {
  name: string;
  normalizedName: string;
  domains: readonly string[];
}

export interface ChildInitiativeInsert {
  title: string;
  typeKey: string;
  stageKey: string;
  health: "active" | "stalled" | "paused" | "blocked" | "closed";
  ownerPersonId: string;
  profileId: string;
  profileVersion: string;
  primaryOrganizationId: string;
  supportingOrganizationIds: readonly string[];
  contributorPersonIds: readonly string[];
}

export interface ChildCreationDbTransaction {
  readonly childSpaceId: string;
  readonly relayServicePrincipalId: string;
  createOrganization(input: ChildOrganizationInsert): Promise<{ organizationId: string }>;
  createInitiative(input: ChildInitiativeInsert): Promise<{ initiativeId: string }>;
  insertAudit(input: AuditEventInsert): Promise<void>;
  insertOutbox(input: {
    envelope: DomainNotificationEnvelope;
    policyVersionId: string;
  }): Promise<{ eventId: string }>;
}

export interface CreatedChildSpaceInput {
  tenantId: string;
  workspaceId: string;
  expectedParentSpaceId: string;
  kind: "organization" | "initiative";
  name: string;
  accessClass: "public" | "workspace" | "restricted" | "confidential";
  inheritanceMode: "inherit" | "restricted";
}

export async function withTenantTransaction<T>(
  options: TenantTransactionOptions,
  fn: (tx: TenantDbTransaction) => Promise<T>
): Promise<T> {
  const context = parseSecurityContext(options.context);

  if (isSecurityContextExpired(context)) {
    throw new Error(SECURITY_CONTEXT_EXPIRED_MESSAGE);
  }

  const client = await options.pool.connect();
  let transactionClosed = false;
  let destroyConnection = false;

  try {
    await client.query("BEGIN");
    await setTransactionContext(client, context);

    const tx: TenantDbTransaction = {
      client,
      query: <T extends object = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[]
      ): Promise<PgQueryResult<T>> => client.query<T>(text, values ? [...values] : undefined)
    };
    const result = await fn(tx);

    await client.query("COMMIT");
    transactionClosed = true;
    await assertTransactionContextCleared(client);
    return result;
  } catch (error) {
    if (transactionClosed) destroyConnection = true;
    if (!transactionClosed) {
      destroyConnection = true;
      await client.query("ROLLBACK");
      transactionClosed = true;
      destroyConnection = false;
    }
    try {
      await assertTransactionContextCleared(client);
    } catch {
      destroyConnection = true;
    }
    throw error;
  } finally {
    client.release(destroyConnection);
  }
}

async function assertTransactionContextCleared(client: PgPoolClient): Promise<void> {
  const result = await client.query<{ settings_cleared: boolean }>(
    `SELECT COALESCE(current_setting('app.request_id', true), '') = ''
        AND COALESCE(current_setting('app.trace_id', true), '') = ''
        AND COALESCE(current_setting('app.tenant_id', true), '') = ''
        AND COALESCE(current_setting('app.workspace_id', true), '') = ''
        AND COALESCE(current_setting('app.space_id', true), '') = ''
        AND COALESCE(current_setting('app.user_id', true), '') = ''
        AND COALESCE(current_setting('app.membership_id', true), '') = ''
        AND COALESCE(current_setting('app.service_principal_id', true), '') = ''
        AND COALESCE(current_setting('app.agent_principal_id', true), '') = ''
        AND COALESCE(current_setting('app.policy_version', true), '') = ''
        AND COALESCE(current_setting('throughline.b1_child_scope_active', true), '') = ''
          AS settings_cleared`
  );
  if (result.rows.length !== 1 || result.rows[0]?.settings_cleared !== true) {
    throw new Error("Transaction-local security context was not cleared");
  }
}

async function setTransactionContext(
  client: PgPoolClient,
  context: SecurityContext
): Promise<void> {
  const settings: Array<[string, string | undefined]> = [
    ["app.request_id", context.requestId],
    ["app.trace_id", context.traceId],
    ["app.tenant_id", context.tenantId],
    ["app.workspace_id", context.workspaceId],
    [
      "app.space_id",
      context.requestedSpaceIds.length === 1 ? context.requestedSpaceIds[0] : undefined
    ],
    ["app.user_id", context.actorUserId],
    ["app.membership_id", context.actorMembershipId],
    ["app.service_principal_id", context.servicePrincipalId],
    ["app.agent_principal_id", context.agentPrincipalId],
    ["app.policy_version", context.policyVersion]
  ];

  for (const [key, value] of settings) {
    await client.query("SELECT set_config($1, $2, true)", [key, value ?? ""]);
  }
}

export async function withCreatedChildSpaceScope<T>(
  tx: TenantDbTransaction,
  input: CreatedChildSpaceInput,
  callback: (child: ChildCreationDbTransaction) => Promise<T>
): Promise<T> {
  const current = await tx.query<{ space_id: string | null; child_scope_active: string | null }>(
    `SELECT NULLIF(current_setting('app.space_id', true), '') AS space_id,
            NULLIF(current_setting('throughline.b1_child_scope_active', true), '')
              AS child_scope_active`
  );
  if (
    current.rows[0]?.space_id !== input.expectedParentSpaceId ||
    current.rows[0]?.child_scope_active
  )
    throw childScopeError();
  const parent = await tx.query<{ id: string }>(
    `SELECT id FROM access.spaces
     WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL
     LIMIT 1 FOR UPDATE`,
    [input.tenantId, input.workspaceId, input.expectedParentSpaceId]
  );
  if (parent.rows.length !== 1) throw childScopeError();

  const childSpaceId = generateUuidV7();
  const slug = `${slugify(input.name)}-${childSpaceId.slice(-12)}`;
  const insertedSpace = await tx.query<{ id: string }>(
    `INSERT INTO access.spaces (
       id, tenant_id, workspace_id, parent_space_id, kind, name, slug, access_class, inheritance_mode
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      childSpaceId,
      input.tenantId,
      input.workspaceId,
      input.expectedParentSpaceId,
      input.kind,
      input.name,
      slug,
      input.accessClass,
      input.inheritanceMode
    ]
  );
  if (insertedSpace.rows[0]?.id !== childSpaceId) throw childScopeError();

  const relay = await tx.query<{ id: string }>(
    `SELECT id FROM identity.service_principals
     WHERE tenant_id = $1 AND workspace_id = $2
       AND purpose = 'product_notification_relay' AND status = 'active'
     LIMIT 2 FOR UPDATE`,
    [input.tenantId, input.workspaceId]
  );
  if (relay.rows.length !== 1) throw childScopeError();
  const relayServicePrincipalId = relay.rows[0]!.id;
  const accessId = generateUuidV7();
  const access = await tx.query<{ id: string }>(
    `INSERT INTO access.access_relationships (
       id, tenant_id, workspace_id, subject_type, subject_id,
       relation, resource_type, resource_id, source
     ) VALUES ($1, $2, $3, 'service_principal', $4, 'manager', 'space', $5, 'direct')
     RETURNING id`,
    [accessId, input.tenantId, input.workspaceId, relayServicePrincipalId, childSpaceId]
  );
  if (access.rows[0]?.id !== accessId) throw childScopeError();

  let restored = false;
  await tx.client.query("SELECT set_config('throughline.b1_child_scope_active', '1', true)");
  try {
    await tx.client.query("SELECT set_config('app.space_id', $1, true)", [childSpaceId]);
    const audit = new AuditEventRepository(tx);
    const outbox = new ProductDomainOutboxWriter(tx);
    let aggregateCreated = false;
    let auditInserted = false;
    let outboxInserted = false;
    const capability: ChildCreationDbTransaction = Object.freeze({
      childSpaceId,
      relayServicePrincipalId,
      createOrganization: async (organization: ChildOrganizationInsert) => {
        if (input.kind !== "organization" || aggregateCreated) throw childScopeError();
        aggregateCreated = true;
        const organizationId = generateUuidV7();
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO work.organizations (
             id, tenant_id, workspace_id, space_id, name, normalized_name, status
           ) VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
          [
            organizationId,
            input.tenantId,
            input.workspaceId,
            childSpaceId,
            organization.name,
            organization.normalizedName
          ]
        );
        if (inserted.rows[0]?.id !== organizationId) throw childScopeError();
        for (const domain of organization.domains) {
          await tx.query(
            `INSERT INTO work.organization_domains (
               tenant_id, workspace_id, space_id, organization_id, domain
             ) VALUES ($1, $2, $3, $4, $5)`,
            [input.tenantId, input.workspaceId, childSpaceId, organizationId, domain]
          );
        }
        return { organizationId };
      },
      createInitiative: async (initiative: ChildInitiativeInsert) => {
        if (input.kind !== "initiative" || aggregateCreated) throw childScopeError();
        aggregateCreated = true;
        const initiativeId = generateUuidV7();
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO work.initiatives (
             id, tenant_id, workspace_id, space_id, title, type_key, stage_key, health,
             owner_person_id, profile_id, profile_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            initiativeId,
            input.tenantId,
            input.workspaceId,
            childSpaceId,
            initiative.title,
            initiative.typeKey,
            initiative.stageKey,
            initiative.health,
            initiative.ownerPersonId,
            initiative.profileId,
            initiative.profileVersion
          ]
        );
        if (inserted.rows[0]?.id !== initiativeId) throw childScopeError();
        await tx.query(
          `INSERT INTO work.initiative_organizations (
             tenant_id, workspace_id, space_id, initiative_id, organization_id, association_role
           ) VALUES ($1,$2,$3,$4,$5,'primary')`,
          [
            input.tenantId,
            input.workspaceId,
            childSpaceId,
            initiativeId,
            initiative.primaryOrganizationId
          ]
        );
        for (const organizationId of initiative.supportingOrganizationIds) {
          await tx.query(
            `INSERT INTO work.initiative_organizations (
               tenant_id, workspace_id, space_id, initiative_id, organization_id, association_role
             ) VALUES ($1,$2,$3,$4,$5,'supporting')`,
            [input.tenantId, input.workspaceId, childSpaceId, initiativeId, organizationId]
          );
        }
        for (const personId of initiative.contributorPersonIds) {
          await tx.query(
            `INSERT INTO work.initiative_people (
               tenant_id, workspace_id, space_id, initiative_id, person_id, role
             ) VALUES ($1,$2,$3,$4,$5,'contributor')`,
            [input.tenantId, input.workspaceId, childSpaceId, initiativeId, personId]
          );
        }
        return { initiativeId };
      },
      insertAudit: async (auditInput: AuditEventInsert) => {
        if (
          auditInserted ||
          auditInput.tenantId !== input.tenantId ||
          auditInput.workspaceId !== input.workspaceId ||
          auditInput.spaceId !== childSpaceId
        ) {
          throw childScopeError();
        }
        await audit.insert(auditInput);
        auditInserted = true;
      },
      insertOutbox: async (outboxInput: {
        envelope: DomainNotificationEnvelope;
        policyVersionId: string;
      }) => {
        if (
          outboxInserted ||
          outboxInput.envelope.tenantId !== input.tenantId ||
          outboxInput.envelope.workspaceId !== input.workspaceId ||
          outboxInput.envelope.spaceId !== childSpaceId
        ) {
          throw childScopeError();
        }
        const result = await outbox.insertOrReplay({
          ...outboxInput,
          relayServicePrincipalId
        });
        outboxInserted = true;
        return { eventId: result.eventId };
      }
    });
    const result = await callback(capability);
    if (!aggregateCreated || !auditInserted || !outboxInserted) throw childScopeError();
    return result;
  } finally {
    await tx.client.query("SELECT set_config('app.space_id', $1, true)", [
      input.expectedParentSpaceId
    ]);
    await tx.client.query("SELECT set_config('throughline.b1_child_scope_active', '', true)");
    const verification = await tx.query<{
      space_id: string | null;
      child_scope_active: string | null;
    }>(
      `SELECT NULLIF(current_setting('app.space_id', true), '') AS space_id,
              NULLIF(current_setting('throughline.b1_child_scope_active', true), '')
                AS child_scope_active`
    );
    restored =
      verification.rows[0]?.space_id === input.expectedParentSpaceId &&
      !verification.rows[0]?.child_scope_active;
    assertChildScopeRestored(restored);
  }
}

function assertChildScopeRestored(restored: boolean): asserts restored {
  if (!restored) throw childScopeError();
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || "space";
}

function generateUuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function childScopeError(): Error {
  return new Error("Created child Space transaction invariant failed");
}
