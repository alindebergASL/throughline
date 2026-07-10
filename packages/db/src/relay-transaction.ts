import type {
  AuthorizationDecision,
  FoundationQueueEnvelope,
  ResourceRef,
  SecurityContext
} from "@throughline/core-types";
import { parseSecurityContext } from "@throughline/tenancy";
import type { PgPool } from "./client.js";
import { withTenantTransaction, type TenantDbTransaction } from "./transaction.js";

const RELAY_ROLE = "throughline_relay";
const ROLE_ERROR = "Dedicated relay database role is required";

export const FOUNDATION_OUTBOX_EVENT_TYPE = "foundation.proof.created.v1" as const;
export const FOUNDATION_OUTBOX_AGGREGATE_TYPE = "foundation_test_aggregate" as const;

export interface RelayAuthorizationService {
  canInTransaction(
    context: SecurityContext,
    action: "foundation.relay.publish",
    resource: ResourceRef,
    tx: TenantDbTransaction
  ): Promise<AuthorizationDecision>;
}

export interface RelayClaimOptions {
  claimedBy: string;
  leaseSeconds: number;
}

export interface RelayClaimIdentity {
  eventId: string;
  claimedBy: string;
  publicationAttempt: number;
}

export interface ClaimedOutboxEvent extends RelayClaimIdentity {
  eventType: typeof FOUNDATION_OUTBOX_EVENT_TYPE;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  aggregateType: typeof FOUNDATION_OUTBOX_AGGREGATE_TYPE;
  aggregateId: string;
  aggregateVersion: number;
  causationId: string;
  requestId: string;
  traceparent: string;
  tracestate?: string;
  jobId: string;
  contextReferenceId: string;
  signedContextReference: string;
}

interface ClaimedOutboxRow {
  event_id: string;
  event_type: string;
  tenant_id: string;
  workspace_id: string;
  space_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  causation_id: string;
  request_id: string;
  traceparent: string;
  tracestate: string | null;
  job_id: string;
  context_reference_id: string;
  signed_context_reference: string;
  claimed_by: string;
  publication_attempt: number;
}

export class RelayOutboxRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly authorization: RelayAuthorizationService
  ) {}

  async claimNext(
    inputContext: SecurityContext,
    options: RelayClaimOptions
  ): Promise<ClaimedOutboxEvent | undefined> {
    const context = validateRelayContext(inputContext);
    validateClaimOptions(options);
    const spaceId = context.requestedSpaceIds[0]!;

    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertRelayRole(tx);
      const decision = await this.authorization.canInTransaction(
        context,
        "foundation.relay.publish",
        { type: "space", id: spaceId },
        tx
      );
      if (!decision.allowed) {
        throw new Error("Relay publication is not authorized");
      }

      const claimed = await tx.query<ClaimedOutboxRow>(
        `WITH eligible AS (
           SELECT id
           FROM ops.outbox_events
           WHERE tenant_id = $1
             AND workspace_id = $2
             AND space_id = $3
             AND relay_service_principal_id = $4
             AND event_type = $7
             AND aggregate_type = $8
             AND published_at IS NULL
             AND terminal_failed_at IS NULL
             AND next_attempt_at <= clock_timestamp()
             AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
           ORDER BY created_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE ops.outbox_events event
         SET publication_attempts = event.publication_attempts + 1,
             claimed_at = clock_timestamp(),
             claimed_by = $5,
             claim_expires_at = clock_timestamp() + ($6 * interval '1 second'),
             last_retry_code = NULL
         FROM eligible
         WHERE event.id = eligible.id
           AND event.tenant_id = $1
           AND event.workspace_id = $2
           AND event.space_id = $3
           AND event.relay_service_principal_id = $4
           AND event.event_type = $7
           AND event.aggregate_type = $8
           AND event.published_at IS NULL
           AND event.terminal_failed_at IS NULL
         RETURNING
           event.id AS event_id, event.event_type, event.tenant_id, event.workspace_id,
           event.space_id, event.aggregate_type, event.aggregate_id, event.aggregate_version,
           event.causation_id, event.request_id, event.traceparent, event.tracestate,
           event.job_id, event.context_reference_id, event.signed_context_reference,
           event.claimed_by, event.publication_attempts AS publication_attempt`,
        [
          context.tenantId,
          context.workspaceId,
          spaceId,
          context.servicePrincipalId,
          options.claimedBy,
          options.leaseSeconds,
          FOUNDATION_OUTBOX_EVENT_TYPE,
          FOUNDATION_OUTBOX_AGGREGATE_TYPE
        ]
      );
      return claimed.rows[0] ? mapClaimedRow(claimed.rows[0]) : undefined;
    });
  }

  async markPublished(
    inputContext: SecurityContext,
    claim: RelayClaimIdentity,
    messageId: string
  ): Promise<void> {
    validateResultValue("SQS message ID", messageId);
    const context = validateRelayContext(inputContext);
    validateClaimIdentity(claim);
    const spaceId = context.requestedSpaceIds[0]!;
    await withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await this.authorizeResultTransaction(tx, context, spaceId);
      const result = await tx.query<{ id: string }>(
        `UPDATE ops.outbox_events
         SET published_at = clock_timestamp(), published_message_id = $4,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
         WHERE id = $1
           AND claimed_by = $2
           AND publication_attempts = $3
           AND claim_expires_at > clock_timestamp()
           AND tenant_id = $5
           AND workspace_id = $6
           AND space_id = $7
           AND relay_service_principal_id = $8
           AND event_type = $9
           AND aggregate_type = $10
           AND published_at IS NULL
           AND terminal_failed_at IS NULL
         RETURNING id`,
        [
          claim.eventId,
          claim.claimedBy,
          claim.publicationAttempt,
          messageId,
          context.tenantId,
          context.workspaceId,
          spaceId,
          context.servicePrincipalId,
          FOUNDATION_OUTBOX_EVENT_TYPE,
          FOUNDATION_OUTBOX_AGGREGATE_TYPE
        ]
      );
      assertOneUpdatedRow(result.rows);
    });
  }

  async markRetry(
    inputContext: SecurityContext,
    claim: RelayClaimIdentity,
    failure: { code: string; delaySeconds: number }
  ): Promise<void> {
    validateResultValue("retry code", failure.code);
    if (
      !Number.isInteger(failure.delaySeconds) ||
      failure.delaySeconds < 0 ||
      failure.delaySeconds > 3600
    ) {
      throw new Error("Retry delay must be an integer from 0 through 3600 seconds");
    }
    const context = validateRelayContext(inputContext);
    validateClaimIdentity(claim);
    const spaceId = context.requestedSpaceIds[0]!;
    await withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await this.authorizeResultTransaction(tx, context, spaceId);
      const result = await tx.query<{ id: string }>(
        `UPDATE ops.outbox_events
         SET last_retry_code = $4,
             next_attempt_at = clock_timestamp() + ($5 * interval '1 second'),
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
         WHERE id = $1
           AND claimed_by = $2
           AND publication_attempts = $3
           AND claim_expires_at > clock_timestamp()
           AND tenant_id = $6
           AND workspace_id = $7
           AND space_id = $8
           AND relay_service_principal_id = $9
           AND event_type = $10
           AND aggregate_type = $11
           AND published_at IS NULL
           AND terminal_failed_at IS NULL
         RETURNING id`,
        [
          claim.eventId,
          claim.claimedBy,
          claim.publicationAttempt,
          failure.code,
          failure.delaySeconds,
          context.tenantId,
          context.workspaceId,
          spaceId,
          context.servicePrincipalId,
          FOUNDATION_OUTBOX_EVENT_TYPE,
          FOUNDATION_OUTBOX_AGGREGATE_TYPE
        ]
      );
      assertOneUpdatedRow(result.rows);
    });
  }

  async markTerminal(
    inputContext: SecurityContext,
    claim: RelayClaimIdentity,
    code: string
  ): Promise<void> {
    validateResultValue("terminal failure code", code);
    const context = validateRelayContext(inputContext);
    validateClaimIdentity(claim);
    const spaceId = context.requestedSpaceIds[0]!;
    await withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await this.authorizeResultTransaction(tx, context, spaceId);
      const result = await tx.query<{ id: string }>(
        `UPDATE ops.outbox_events
         SET terminal_failed_at = clock_timestamp(), terminal_failure_code = $4,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
         WHERE id = $1
           AND claimed_by = $2
           AND publication_attempts = $3
           AND claim_expires_at > clock_timestamp()
           AND tenant_id = $5
           AND workspace_id = $6
           AND space_id = $7
           AND relay_service_principal_id = $8
           AND event_type = $9
           AND aggregate_type = $10
           AND published_at IS NULL
           AND terminal_failed_at IS NULL
         RETURNING id`,
        [
          claim.eventId,
          claim.claimedBy,
          claim.publicationAttempt,
          code,
          context.tenantId,
          context.workspaceId,
          spaceId,
          context.servicePrincipalId,
          FOUNDATION_OUTBOX_EVENT_TYPE,
          FOUNDATION_OUTBOX_AGGREGATE_TYPE
        ]
      );
      assertOneUpdatedRow(result.rows);
    });
  }

  private async authorizeResultTransaction(
    tx: TenantDbTransaction,
    context: SecurityContext,
    spaceId: string
  ): Promise<void> {
    await assertRelayRole(tx);
    const decision = await this.authorization.canInTransaction(
      context,
      "foundation.relay.publish",
      { type: "space", id: spaceId },
      tx
    );
    if (!decision.allowed) throw new Error("Relay publication is not authorized");
  }
}

async function assertRelayRole(tx: TenantDbTransaction): Promise<void> {
  let result: { rows: Array<{ current_user: string }> };
  try {
    result = await tx.query<{ current_user: string }>("SELECT current_user AS current_user");
  } catch {
    throw new Error(ROLE_ERROR);
  }
  if (
    result.rows.length !== 1 ||
    typeof result.rows[0]?.current_user !== "string" ||
    result.rows[0].current_user !== RELAY_ROLE
  ) {
    throw new Error(ROLE_ERROR);
  }
}

function assertOneUpdatedRow(rows: readonly { id: string }[]): void {
  if (rows.length !== 1) throw new Error("Relay claim is stale or outside the exact scope");
}

function validateRelayContext(input: SecurityContext): SecurityContext {
  const context = parseSecurityContext(input);
  if (
    !context.servicePrincipalId ||
    context.actorUserId ||
    context.actorMembershipId ||
    context.agentPrincipalId ||
    context.requestedSpaceIds.length !== 1
  ) {
    throw new Error("Relay requires one service principal and one exact requested Space");
  }
  return context;
}

function validateClaimOptions(options: RelayClaimOptions): void {
  validateResultValue("claim owner", options.claimedBy);
  if (
    !Number.isInteger(options.leaseSeconds) ||
    options.leaseSeconds < 1 ||
    options.leaseSeconds > 300
  ) {
    throw new Error("Claim lease must be an integer from 1 through 300 seconds");
  }
}

function validateClaimIdentity(claim: RelayClaimIdentity): void {
  validateResultValue("event ID", claim.eventId);
  validateResultValue("claim owner", claim.claimedBy);
  if (!Number.isInteger(claim.publicationAttempt) || claim.publicationAttempt < 1) {
    throw new Error("Publication attempt must be a positive integer");
  }
}

function validateResultValue(name: string, value: string): void {
  if (value.length < 1 || value.length > 200) throw new Error(`${name} is invalid`);
}

function mapClaimedRow(row: ClaimedOutboxRow): ClaimedOutboxEvent {
  assertFoundationEventType(row.event_type, row.aggregate_type);
  return {
    eventId: row.event_id,
    eventType: FOUNDATION_OUTBOX_EVENT_TYPE,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id,
    aggregateType: FOUNDATION_OUTBOX_AGGREGATE_TYPE,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    causationId: row.causation_id,
    requestId: row.request_id,
    traceparent: row.traceparent,
    ...(row.tracestate === null ? {} : { tracestate: row.tracestate }),
    jobId: row.job_id,
    contextReferenceId: row.context_reference_id,
    signedContextReference: row.signed_context_reference,
    claimedBy: row.claimed_by,
    publicationAttempt: row.publication_attempt
  };
}

export function toFoundationQueueEnvelope(event: ClaimedOutboxEvent): FoundationQueueEnvelope {
  assertFoundationEventType(event.eventType, event.aggregateType);
  return {
    version: "v1",
    eventId: event.eventId,
    jobId: event.jobId,
    scope: {
      tenantId: event.tenantId,
      workspaceId: event.workspaceId,
      spaceId: event.spaceId
    },
    contextReference: event.signedContextReference,
    requestId: event.requestId,
    traceparent: event.traceparent,
    ...(event.tracestate === undefined ? {} : { tracestate: event.tracestate })
  };
}

function assertFoundationEventType(eventType: string, aggregateType: string): void {
  if (
    eventType !== FOUNDATION_OUTBOX_EVENT_TYPE ||
    aggregateType !== FOUNDATION_OUTBOX_AGGREGATE_TYPE
  ) {
    throw new Error("Claimed outbox event is outside the exact Foundation relay type");
  }
}
