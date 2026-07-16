import {
  canonicalJsonStringify,
  parseDomainNotificationEnvelope,
  serializeDomainNotificationEnvelope,
  type DomainNotificationEnvelope
} from "@throughline/core-types";
import { createHash } from "node:crypto";
import {
  parseProductAuditSafeDetail,
  type ProductAuditSafeDetailInput
} from "./audit-safe-detail.js";
import type { TenantDbTransaction } from "./transaction.js";

export class ProductDomainInvariantError extends Error {
  constructor() {
    super("Product domain transaction invariant mismatch");
    this.name = "ProductDomainInvariantError";
  }
}

export interface DomainCommandReservationInput {
  id: string;
  tenantId: string;
  workspaceId: string;
  reservationSpaceId: string;
  commandKind: string;
  commandSchemaVersion: number;
  idempotencyKey: string;
  canonicalRequestHash: string;
  actorUserId: string;
  actorMembershipId: string;
  delegatingUserId?: string;
  delegatingMembershipId?: string;
  agentPrincipalId?: string;
  policyVersionId: string;
  requestId: string;
  traceparent: string;
  tracestate?: string;
}

export interface CompletedDomainCommand {
  id: string;
  resultResourceType?: string;
  resultResourceId?: string;
  safeResponse?: unknown;
  completedAt: Date;
}

export type DomainCommandReservationResult =
  | { status: "reserved"; commandId: string }
  | { status: "replay"; command: CompletedDomainCommand };

interface DomainCommandRow {
  id: string;
  command_schema_version: number;
  canonical_request_hash: string;
  state: "reserved" | "completed";
  actor_user_id: string;
  actor_membership_id: string;
  delegating_user_id: string | null;
  delegating_membership_id: string | null;
  agent_principal_id: string | null;
  policy_version_id: string;
  result_resource_type: string | null;
  result_resource_id: string | null;
  safe_response: unknown | null;
  completed_at: Date | null;
}

export interface CompleteDomainCommandInput {
  commandId: string;
  tenantId: string;
  workspaceId: string;
  reservationSpaceId: string;
  commandKind: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  resultResourceType?: string;
  resultResourceId?: string;
  safeResponse?: unknown;
}

export class DomainCommandRepository {
  constructor(private readonly tx: TenantDbTransaction) {}

  async reserve(input: DomainCommandReservationInput): Promise<DomainCommandReservationResult> {
    validateReservationInput(input);
    const inserted = await this.tx.query<{ id: string }>(
      `INSERT INTO ops.domain_command_records (
         id, tenant_id, workspace_id, reservation_space_id, command_kind,
         command_schema_version, idempotency_key, canonical_request_hash,
         actor_user_id, actor_membership_id, delegating_user_id, delegating_membership_id,
         agent_principal_id, policy_version_id, request_id, traceparent, tracestate
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16, $17
       )
       ON CONFLICT (
         tenant_id, workspace_id, reservation_space_id, command_kind, idempotency_key
       ) DO NOTHING
       RETURNING id`,
      [
        input.id,
        input.tenantId,
        input.workspaceId,
        input.reservationSpaceId,
        input.commandKind,
        input.commandSchemaVersion,
        input.idempotencyKey,
        input.canonicalRequestHash,
        input.actorUserId,
        input.actorMembershipId,
        input.delegatingUserId ?? null,
        input.delegatingMembershipId ?? null,
        input.agentPrincipalId ?? null,
        input.policyVersionId,
        input.requestId,
        input.traceparent,
        input.tracestate ?? null
      ]
    );

    if (inserted.rows.length === 1) {
      return { status: "reserved", commandId: inserted.rows[0]!.id };
    }

    const existing = await this.tx.query<DomainCommandRow>(
      `SELECT id, command_schema_version, canonical_request_hash, state,
              actor_user_id, actor_membership_id, delegating_user_id,
              delegating_membership_id, agent_principal_id, policy_version_id,
              result_resource_type, result_resource_id, safe_response, completed_at
       FROM ops.domain_command_records
       WHERE tenant_id = $1 AND workspace_id = $2 AND reservation_space_id = $3
         AND command_kind = $4 AND idempotency_key = $5
       LIMIT 1
       FOR UPDATE`,
      [
        input.tenantId,
        input.workspaceId,
        input.reservationSpaceId,
        input.commandKind,
        input.idempotencyKey
      ]
    );
    const row = existing.rows[0];
    if (!row || !commandIdentityMatches(row, input)) throw new ProductDomainInvariantError();
    if (row.state === "reserved") return { status: "reserved", commandId: row.id };
    if (!row.completed_at) throw new ProductDomainInvariantError();
    return {
      status: "replay",
      command: {
        id: row.id,
        ...(row.result_resource_type === null
          ? {}
          : { resultResourceType: row.result_resource_type }),
        ...(row.result_resource_id === null ? {} : { resultResourceId: row.result_resource_id }),
        ...(row.safe_response === null ? {} : { safeResponse: row.safe_response }),
        completedAt: row.completed_at
      }
    };
  }

  async complete(input: CompleteDomainCommandInput): Promise<CompletedDomainCommand> {
    if ((input.resultResourceType === undefined) !== (input.resultResourceId === undefined)) {
      throw new ProductDomainInvariantError();
    }
    const safeResponse =
      input.safeResponse === undefined
        ? null
        : JSON.parse(canonicalJsonStringify(input.safeResponse));
    const result = await this.tx.query<{
      id: string;
      result_resource_type: string | null;
      result_resource_id: string | null;
      safe_response: unknown | null;
      completed_at: Date;
    }>(
      `UPDATE ops.domain_command_records
       SET state = 'completed',
           result_resource_type = $8,
           result_resource_id = $9,
           safe_response = $10::jsonb,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
         AND reservation_space_id = $4 AND command_kind = $5
         AND idempotency_key = $6 AND canonical_request_hash = $7
         AND state = 'reserved'
       RETURNING id, result_resource_type, result_resource_id, safe_response, completed_at`,
      [
        input.commandId,
        input.tenantId,
        input.workspaceId,
        input.reservationSpaceId,
        input.commandKind,
        input.idempotencyKey,
        input.canonicalRequestHash,
        input.resultResourceType ?? null,
        input.resultResourceId ?? null,
        safeResponse === null ? null : JSON.stringify(safeResponse)
      ]
    );
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) throw new ProductDomainInvariantError();
    return {
      id: row.id,
      ...(row.result_resource_type === null
        ? {}
        : { resultResourceType: row.result_resource_type }),
      ...(row.result_resource_id === null ? {} : { resultResourceId: row.result_resource_id }),
      ...(row.safe_response === null ? {} : { safeResponse: row.safe_response }),
      completedAt: row.completed_at
    };
  }
}

interface AuditEventMetadata {
  id: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  causationCommandId: string;
  actorUserId: string;
  actorMembershipId: string;
  delegatingUserId?: string;
  delegatingMembershipId?: string;
  agentPrincipalId?: string;
  policyVersionId: string;
  requestId: string;
  traceparent: string;
  tracestate?: string;
}

export type AuditEventInsert = AuditEventMetadata & ProductAuditSafeDetailInput;

export class AuditEventRepository {
  constructor(private readonly tx: TenantDbTransaction) {}

  async insert(input: AuditEventInsert): Promise<void> {
    const safeDetail = canonicalJsonStringify(
      parseProductAuditSafeDetail(
        input.action,
        input.resourceType,
        input.resourceId,
        input.auditSchemaVersion,
        input.safeDetail
      )
    );
    const result = await this.tx.query<{ id: string }>(
      `INSERT INTO ops.audit_events (
         id, tenant_id, workspace_id, space_id, causation_command_id,
         action, resource_type, resource_id,
         actor_user_id, actor_membership_id, delegating_user_id, delegating_membership_id,
         agent_principal_id, policy_version_id, request_id, traceparent, tracestate,
         audit_schema_version, safe_detail
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19::jsonb
       ) RETURNING id`,
      [
        input.id,
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.causationCommandId,
        input.action,
        input.resourceType,
        input.resourceId,
        input.actorUserId,
        input.actorMembershipId,
        input.delegatingUserId ?? null,
        input.delegatingMembershipId ?? null,
        input.agentPrincipalId ?? null,
        input.policyVersionId,
        input.requestId,
        input.traceparent,
        input.tracestate ?? null,
        input.auditSchemaVersion,
        safeDetail
      ]
    );
    if (result.rows.length !== 1) throw new ProductDomainInvariantError();
  }
}

export interface ProductOutboxInsert {
  envelope: DomainNotificationEnvelope;
  relayServicePrincipalId: string;
  policyVersionId: string;
}

interface ProductOutboxEnvelopeRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  space_id: string;
  relay_service_principal_id: string;
  policy_version_id: string;
  event_type: string;
  event_schema_version: number;
  payload_schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  causation_command_id: string;
  payload: unknown;
  request_id: string;
  traceparent: string;
  tracestate: string | null;
}

export class ProductDomainOutboxWriter {
  constructor(private readonly tx: TenantDbTransaction) {}

  async insertOrReplay(input: ProductOutboxInsert): Promise<{ eventId: string; replay: boolean }> {
    const envelope = parseDomainNotificationEnvelope(input.envelope);
    const canonicalEnvelope = serializeDomainNotificationEnvelope(envelope);
    let inserted: { rows: Array<{ id: string }> };
    try {
      inserted = await this.tx.query<{ id: string }>(
        `INSERT INTO ops.product_outbox_events (
           id, tenant_id, workspace_id, space_id, relay_service_principal_id, policy_version_id,
           event_type, event_schema_version, payload_schema_version,
           aggregate_type, aggregate_id, aggregate_version, causation_command_id,
           payload, request_id, traceparent, tracestate
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12, $13,
           $14::jsonb, $15, $16, $17
         )
         ON CONFLICT (
           tenant_id, workspace_id, space_id, causation_command_id, event_type,
           aggregate_type, aggregate_id, aggregate_version
         ) DO NOTHING
         RETURNING id`,
        [
          envelope.eventId,
          envelope.tenantId,
          envelope.workspaceId,
          envelope.spaceId,
          input.relayServicePrincipalId,
          input.policyVersionId,
          envelope.eventType,
          envelope.eventSchemaVersion,
          envelope.payloadSchemaVersion,
          envelope.aggregateType,
          envelope.aggregateId,
          envelope.aggregateVersion,
          envelope.causationCommandId,
          canonicalJsonStringify(envelope.payload),
          envelope.requestId,
          envelope.traceparent,
          envelope.tracestate ?? null
        ]
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProductDomainInvariantError();
      throw error;
    }
    if (inserted.rows.length === 1) return { eventId: inserted.rows[0]!.id, replay: false };

    const existing = await this.tx.query<ProductOutboxEnvelopeRow>(
      `SELECT id, tenant_id, workspace_id, space_id, relay_service_principal_id,
              policy_version_id, event_type, event_schema_version, payload_schema_version,
              aggregate_type, aggregate_id, aggregate_version, causation_command_id,
              payload, request_id, traceparent, tracestate
       FROM ops.product_outbox_events
       WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
         AND causation_command_id = $4 AND event_type = $5
         AND aggregate_type = $6 AND aggregate_id = $7 AND aggregate_version = $8
       LIMIT 1`,
      [
        envelope.tenantId,
        envelope.workspaceId,
        envelope.spaceId,
        envelope.causationCommandId,
        envelope.eventType,
        envelope.aggregateType,
        envelope.aggregateId,
        envelope.aggregateVersion
      ]
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.relay_service_principal_id !== input.relayServicePrincipalId ||
      row.policy_version_id !== input.policyVersionId ||
      canonicalEnvelope !== serializeDomainNotificationEnvelope(envelopeFromRow(row))
    ) {
      throw new ProductDomainInvariantError();
    }
    return { eventId: row.id, replay: true };
  }
}

export class ProductDomainTransactionRepositories {
  readonly commands: DomainCommandRepository;
  readonly audit: AuditEventRepository;
  readonly outbox: ProductDomainOutboxWriter;

  constructor(tx: TenantDbTransaction) {
    this.commands = new DomainCommandRepository(tx);
    this.audit = new AuditEventRepository(tx);
    this.outbox = new ProductDomainOutboxWriter(tx);
  }
}

export function hashCanonicalCommandRequest(trustedRequest: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(trustedRequest), "utf8").digest("hex");
}

function commandIdentityMatches(
  row: DomainCommandRow,
  input: DomainCommandReservationInput
): boolean {
  return (
    row.command_schema_version === input.commandSchemaVersion &&
    row.canonical_request_hash === input.canonicalRequestHash &&
    row.actor_user_id === input.actorUserId &&
    row.actor_membership_id === input.actorMembershipId &&
    row.delegating_user_id === (input.delegatingUserId ?? null) &&
    row.delegating_membership_id === (input.delegatingMembershipId ?? null) &&
    row.agent_principal_id === (input.agentPrincipalId ?? null) &&
    row.policy_version_id === input.policyVersionId
  );
}

function validateReservationInput(input: DomainCommandReservationInput): void {
  if (!/^[a-f0-9]{64}$/.test(input.canonicalRequestHash)) {
    throw new ProductDomainInvariantError();
  }
  if ((input.delegatingUserId === undefined) !== (input.delegatingMembershipId === undefined)) {
    throw new ProductDomainInvariantError();
  }
}

function envelopeFromRow(row: ProductOutboxEnvelopeRow): unknown {
  return {
    eventId: row.id,
    eventType: row.event_type,
    eventSchemaVersion: row.event_schema_version,
    payloadSchemaVersion: row.payload_schema_version,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    causationCommandId: row.causation_command_id,
    payload: row.payload,
    requestId: row.request_id,
    traceparent: row.traceparent,
    ...(row.tracestate === null ? {} : { tracestate: row.tracestate })
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
