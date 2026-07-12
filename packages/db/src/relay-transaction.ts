import type {
  AuthorizationDecision,
  FoundationQueueEnvelope,
  ResourceRef,
  SecurityContext
} from "@throughline/core-types";
import { buildScopedQueueKey, parseSecurityContext } from "@throughline/tenancy";
import { randomBytes } from "node:crypto";
import type { PgPool } from "./client.js";
import { withTenantTransaction, type TenantDbTransaction } from "./transaction.js";

const RELAY_ROLE = "throughline_relay";
const ROLE_ERROR = "Dedicated relay database role is required";
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const FOUNDATION_OUTBOX_EVENT_TYPE = "foundation.proof.created.v1" as const;
export const FOUNDATION_OUTBOX_AGGREGATE_TYPE = "foundation_test_aggregate" as const;

declare const claimTokenBrand: unique symbol;
export type RelayClaimToken = string & { readonly [claimTokenBrand]: true };

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
  readonly eventId: string;
  readonly claimedBy: string;
  readonly publicationAttempt: number;
  readonly claimToken: RelayClaimToken;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export interface RelayPublicationRequest {
  readonly eventType: typeof FOUNDATION_OUTBOX_EVENT_TYPE;
  readonly aggregateType: typeof FOUNDATION_OUTBOX_AGGREGATE_TYPE;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly causationId: string;
  readonly contextReferenceId: string;
  readonly routingKey: string;
  readonly envelope: FoundationQueueEnvelope;
}

export interface RelayPublicationPublisher {
  publish(request: DeepReadonly<RelayPublicationRequest>): Promise<{ readonly messageId: string }>;
}

export type PublishClaimedResult =
  | { readonly status: "published"; readonly eventId: string; readonly messageId: string }
  | { readonly status: "unresolved"; readonly eventId: string; readonly messageId: string };

interface LockedOutboxRow {
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
}

export class RelayOutboxRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly authorization: RelayAuthorizationService
  ) {}

  async claimNext(
    inputContext: SecurityContext,
    options: RelayClaimOptions
  ): Promise<RelayClaimIdentity | undefined> {
    const context = validateRelayContext(inputContext);
    validateClaimOptions(options);
    const spaceId = context.requestedSpaceIds[0]!;
    const claimToken = generateClaimToken();

    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertRelayRole(tx);
      const claimed = await tx.query<{
        event_id: string;
        claimed_by: string;
        publication_attempt: number;
        claim_token: string;
      }>(
        `WITH eligible AS (
           SELECT id
           FROM ops.outbox_events
           WHERE tenant_id = $1
             AND workspace_id = $2
             AND space_id = $3
             AND relay_service_principal_id = $4
             AND event_type = $8
             AND aggregate_type = $9
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
             claim_token = $6,
             claim_expires_at = clock_timestamp() + ($7 * interval '1 second'),
             last_retry_code = NULL
         FROM eligible
         WHERE event.id = eligible.id
           AND event.tenant_id = $1
           AND event.workspace_id = $2
           AND event.space_id = $3
           AND event.relay_service_principal_id = $4
           AND event.event_type = $8
           AND event.aggregate_type = $9
           AND event.published_at IS NULL
           AND event.terminal_failed_at IS NULL
         RETURNING event.id AS event_id, event.claimed_by,
           event.publication_attempts AS publication_attempt, event.claim_token`,
        [
          context.tenantId,
          context.workspaceId,
          spaceId,
          context.servicePrincipalId,
          options.claimedBy,
          claimToken,
          options.leaseSeconds,
          FOUNDATION_OUTBOX_EVENT_TYPE,
          FOUNDATION_OUTBOX_AGGREGATE_TYPE
        ]
      );
      const row = claimed.rows[0];
      if (!row) return undefined;
      return mapClaimIdentity(row);
    });
  }

  async publishClaimed(
    inputContext: SecurityContext,
    inputClaim: RelayClaimIdentity,
    publisher: RelayPublicationPublisher
  ): Promise<PublishClaimedResult> {
    const context = validateRelayContext(inputContext);
    const claim = validateClaimIdentity(inputClaim);
    validatePublisher(publisher);
    const spaceId = context.requestedSpaceIds[0]!;
    let acknowledgedMessageId: string | undefined;

    try {
      return await withTenantTransaction({ pool: this.pool, context }, async (tx) => {
        await assertRelayRole(tx);
        const locked = await tx.query<LockedOutboxRow>(
          `SELECT id AS event_id, event_type, tenant_id, workspace_id, space_id,
                  aggregate_type, aggregate_id, aggregate_version, causation_id, request_id,
                  traceparent, tracestate, job_id, context_reference_id, signed_context_reference
           FROM ops.outbox_events
           WHERE id = $1
             AND tenant_id = $2
             AND workspace_id = $3
             AND space_id = $4
             AND relay_service_principal_id = $5
             AND event_type = $6
             AND aggregate_type = $7
             AND claimed_by = $8
             AND publication_attempts = $9
             AND claim_token = $10
             AND claim_expires_at > clock_timestamp()
             AND published_at IS NULL
             AND terminal_failed_at IS NULL
           LIMIT 1
           FOR UPDATE`,
          claimValues(context, spaceId, claim)
        );
        const row = locked.rows[0];
        if (!row || locked.rows.length !== 1) throw staleClaimError();

        const decision = await this.authorization.canInTransaction(
          context,
          "foundation.relay.publish",
          { type: "space", id: spaceId },
          tx
        );
        if (!decision.allowed) throw new Error("Relay publication is not authorized");

        const request = deepFreeze(createPublicationRequest(row));
        const acknowledgment = await publisher.publish(request);
        validateResultValue("SQS message ID", acknowledgment.messageId);
        acknowledgedMessageId = acknowledgment.messageId;

        const marked = await tx.query<{ id: string }>(
          `UPDATE ops.outbox_events
           SET published_at = clock_timestamp(), published_message_id = $11
           WHERE id = $1
             AND tenant_id = $2
             AND workspace_id = $3
             AND space_id = $4
             AND relay_service_principal_id = $5
             AND event_type = $6
             AND aggregate_type = $7
             AND claimed_by = $8
             AND publication_attempts = $9
             AND claim_token = $10
             AND claim_expires_at > clock_timestamp()
             AND published_at IS NULL
             AND terminal_failed_at IS NULL
           RETURNING id`,
          [...claimValues(context, spaceId, claim), acknowledgment.messageId]
        );
        assertOneUpdatedRow(marked.rows);
        return {
          status: "published" as const,
          eventId: claim.eventId,
          messageId: acknowledgment.messageId
        };
      });
    } catch (error) {
      if (!acknowledgedMessageId) throw error;
      const published = await this.isExactClaimPublished(context, claim, acknowledgedMessageId);
      if (published) {
        return { status: "published", eventId: claim.eventId, messageId: acknowledgedMessageId };
      }
      return { status: "unresolved", eventId: claim.eventId, messageId: acknowledgedMessageId };
    }
  }

  async recordRetry(
    inputContext: SecurityContext,
    inputClaim: RelayClaimIdentity,
    failure: { readonly code: string; readonly delaySeconds: number }
  ): Promise<void> {
    validateResultValue("retry code", failure.code);
    if (
      !Number.isInteger(failure.delaySeconds) ||
      failure.delaySeconds < 0 ||
      failure.delaySeconds > 3600
    ) {
      throw new Error("Retry delay must be an integer from 0 through 3600 seconds");
    }
    await this.recordFailure(inputContext, inputClaim, failure.code, failure.delaySeconds, false);
  }

  async recordTerminal(
    inputContext: SecurityContext,
    inputClaim: RelayClaimIdentity,
    code: string
  ): Promise<void> {
    validateResultValue("terminal failure code", code);
    await this.recordFailure(inputContext, inputClaim, code, 0, true);
  }

  private async recordFailure(
    inputContext: SecurityContext,
    inputClaim: RelayClaimIdentity,
    code: string,
    delaySeconds: number,
    terminal: boolean
  ): Promise<void> {
    const context = validateRelayContext(inputContext);
    const claim = validateClaimIdentity(inputClaim);
    const spaceId = context.requestedSpaceIds[0]!;
    await withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertRelayRole(tx);
      const result = await tx.query<{ id: string }>(
        terminal
          ? `UPDATE ops.outbox_events
             SET terminal_failed_at = clock_timestamp(), terminal_failure_code = $11,
                 claimed_at = NULL, claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
             WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
               AND relay_service_principal_id = $5 AND event_type = $6 AND aggregate_type = $7
               AND claimed_by = $8 AND publication_attempts = $9 AND claim_token = $10
               AND claim_expires_at > clock_timestamp() AND published_at IS NULL
               AND terminal_failed_at IS NULL RETURNING id`
          : `UPDATE ops.outbox_events
             SET last_retry_code = $11, next_attempt_at = clock_timestamp() + ($12 * interval '1 second'),
                 claimed_at = NULL, claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
             WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
               AND relay_service_principal_id = $5 AND event_type = $6 AND aggregate_type = $7
               AND claimed_by = $8 AND publication_attempts = $9 AND claim_token = $10
               AND claim_expires_at > clock_timestamp() AND published_at IS NULL
               AND terminal_failed_at IS NULL RETURNING id`,
        terminal
          ? [...claimValues(context, spaceId, claim), code]
          : [...claimValues(context, spaceId, claim), code, delaySeconds]
      );
      assertOneUpdatedRow(result.rows);
    });
  }

  private async isExactClaimPublished(
    context: SecurityContext,
    claim: RelayClaimIdentity,
    messageId: string
  ): Promise<boolean> {
    const spaceId = context.requestedSpaceIds[0]!;
    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertRelayRole(tx);
      const result = await tx.query<{ id: string }>(
        `SELECT id
         FROM ops.outbox_events
         WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
           AND relay_service_principal_id = $5 AND event_type = $6 AND aggregate_type = $7
           AND claimed_by = $8 AND publication_attempts = $9 AND claim_token = $10
           AND published_message_id = $11 AND published_at IS NOT NULL
         LIMIT 1`,
        [...claimValues(context, spaceId, claim), messageId]
      );
      return result.rows.length === 1;
    });
  }
}

function claimValues(
  context: SecurityContext,
  spaceId: string,
  claim: RelayClaimIdentity
): unknown[] {
  return [
    claim.eventId,
    context.tenantId,
    context.workspaceId,
    spaceId,
    context.servicePrincipalId,
    FOUNDATION_OUTBOX_EVENT_TYPE,
    FOUNDATION_OUTBOX_AGGREGATE_TYPE,
    claim.claimedBy,
    claim.publicationAttempt,
    claim.claimToken
  ];
}

async function assertRelayRole(tx: TenantDbTransaction): Promise<void> {
  let result: { rows: Array<{ current_user: string }> };
  try {
    result = await tx.query<{ current_user: string }>("SELECT current_user AS current_user");
  } catch {
    throw new Error(ROLE_ERROR);
  }
  if (result.rows.length !== 1 || result.rows[0]?.current_user !== RELAY_ROLE)
    throw new Error(ROLE_ERROR);
}

function createPublicationRequest(row: LockedOutboxRow): RelayPublicationRequest {
  assertFoundationEventType(row.event_type, row.aggregate_type);
  if (
    !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(row.traceparent) ||
    !/^tlctx\.v1\.hs256\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      row.signed_context_reference
    ) ||
    row.request_id.length < 1 ||
    row.request_id.length > 200
  ) {
    throw new Error("Locked outbox row does not form a valid Foundation publication request");
  }
  const envelope: FoundationQueueEnvelope = {
    version: "v1",
    eventId: row.event_id,
    jobId: row.job_id,
    scope: { tenantId: row.tenant_id, workspaceId: row.workspace_id, spaceId: row.space_id },
    contextReference: row.signed_context_reference,
    requestId: row.request_id,
    traceparent: row.traceparent,
    ...(row.tracestate === null ? {} : { tracestate: row.tracestate })
  };
  return {
    eventType: FOUNDATION_OUTBOX_EVENT_TYPE,
    aggregateType: FOUNDATION_OUTBOX_AGGREGATE_TYPE,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    causationId: row.causation_id,
    contextReferenceId: row.context_reference_id,
    routingKey: buildScopedQueueKey(envelope.scope),
    envelope
  };
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function generateClaimToken(): RelayClaimToken {
  return randomBytes(32).toString("base64url") as RelayClaimToken;
}

function mapClaimIdentity(row: {
  event_id: string;
  claimed_by: string;
  publication_attempt: number;
  claim_token: string;
}): RelayClaimIdentity {
  return validateClaimIdentity({
    eventId: row.event_id,
    claimedBy: row.claimed_by,
    publicationAttempt: row.publication_attempt,
    claimToken: row.claim_token as RelayClaimToken
  });
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

function validateClaimIdentity(claim: RelayClaimIdentity): RelayClaimIdentity {
  validateResultValue("event ID", claim.eventId);
  validateResultValue("claim owner", claim.claimedBy);
  if (!Number.isInteger(claim.publicationAttempt) || claim.publicationAttempt < 1) {
    throw new Error("Publication attempt must be a positive integer");
  }
  if (!CLAIM_TOKEN_PATTERN.test(claim.claimToken)) throw staleClaimError();
  return Object.freeze({ ...claim });
}

function validatePublisher(publisher: RelayPublicationPublisher): void {
  if (!publisher || typeof publisher.publish !== "function")
    throw new Error("Typed relay publisher is required");
}

function validateResultValue(name: string, value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 200)
    throw new Error(`${name} is invalid`);
}

function assertOneUpdatedRow(rows: readonly { id: string }[]): void {
  if (rows.length !== 1) throw staleClaimError();
}

function staleClaimError(): Error {
  return new Error("Relay claim is stale or outside the exact scope");
}

function assertFoundationEventType(eventType: string, aggregateType: string): void {
  if (
    eventType !== FOUNDATION_OUTBOX_EVENT_TYPE ||
    aggregateType !== FOUNDATION_OUTBOX_AGGREGATE_TYPE
  ) {
    throw new Error("Claimed outbox event is outside the exact Foundation relay type");
  }
}
