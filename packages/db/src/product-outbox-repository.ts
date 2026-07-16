import {
  parseDomainNotificationEnvelope,
  serializeDomainNotificationEnvelope,
  type AuthorizationDecision,
  type DomainNotificationEnvelope,
  type ResourceRef,
  type SecurityContext
} from "@throughline/core-types";
import { randomBytes } from "node:crypto";
import type { PgPool } from "./client.js";
import { withTenantTransaction, type TenantDbTransaction } from "./transaction.js";

const PRODUCT_RELAY_ROLE = "throughline_product_relay";
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9_]{0,99}$/;
const RETRY_DELAYS_SECONDS = [1, 5, 30, 120, 600] as const;

export interface ProductRelayAuthorizationService {
  canInTransaction(
    context: SecurityContext,
    action: "product_outbox.relay.publish",
    resource: ResourceRef,
    tx: TenantDbTransaction
  ): Promise<AuthorizationDecision>;
}

export interface ProductRelayClaimScope {
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  relayServicePrincipalId: string;
  policyVersionId: string;
}

export interface ProductRelayClaimOptions {
  claimedBy: string;
  leaseSeconds: number;
}

declare const productClaimHandleBrand: unique symbol;
export interface ProductOutboxClaimHandle {
  readonly [productClaimHandleBrand]: true;
  readonly eventId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly spaceId: string;
  readonly relayServicePrincipalId: string;
  readonly policyVersionId: string;
  readonly eventType: DomainNotificationEnvelope["eventType"];
  readonly aggregateType: DomainNotificationEnvelope["aggregateType"];
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly causationCommandId: string;
  readonly envelope: DomainNotificationEnvelope;
  readonly canonicalEnvelope: string;
  readonly publicationAttempt: number;
  readonly claimedBy: string;
  readonly claimToken: string;
  readonly claimedAt: string;
  readonly claimExpiresAt: string;
}

export interface ProductPublicationPublisher {
  publish(
    envelope: ProductDeepReadonly<DomainNotificationEnvelope>
  ): Promise<{ readonly messageId: string }>;
}

export type ProductPublishClaimedResult =
  | { status: "published"; eventId: string; messageId: string }
  | { status: "unresolved"; eventId: string; messageId: string };

export type ProductPublicationFailureKind = "deterministic" | "ambiguous";

export class ProductRelayClaimRejectedError extends Error {
  constructor() {
    super("Product outbox claim is stale or does not match its exact server-owned binding");
    this.name = "ProductRelayClaimRejectedError";
  }
}

export class ProductRelayAuthorizationError extends Error {
  constructor() {
    super("Product notification publication is not currently authorized");
    this.name = "ProductRelayAuthorizationError";
  }
}

interface ProductOutboxRow {
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
  publication_attempt: number;
  claimed_by: string;
  claim_token: string;
  claimed_at: Date;
  claim_expires_at: Date;
}

export class ProductOutboxRepository {
  private readonly serverOwnedHandles = new WeakSet<object>();

  constructor(
    private readonly pool: PgPool,
    private readonly authorization: ProductRelayAuthorizationService
  ) {}

  async claimNext(
    inputScope: ProductRelayClaimScope,
    options: ProductRelayClaimOptions
  ): Promise<ProductOutboxClaimHandle | undefined> {
    const scope = validateScope(inputScope);
    validateClaimOptions(options);
    const token = randomBytes(32).toString("base64url");
    const context = contextForScope(scope, options.leaseSeconds + 30);

    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertProductRelayRole(tx);
      await tx.query(
        `UPDATE ops.product_outbox_events
         SET publication_state = 'terminal_unconfirmed',
             claimed_at = NULL, claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL,
             last_outcome_code = 'relay_interrupted', terminal_at = clock_timestamp()
         WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
           AND relay_service_principal_id = $4 AND policy_version_id = $5
           AND publication_state = 'claimed' AND publication_attempt = 6
           AND claim_expires_at <= clock_timestamp()`,
        scopeValues(scope)
      );
      const claimed = await tx.query<ProductOutboxRow>(
        `WITH claim_clock AS MATERIALIZED (
           SELECT date_trunc('milliseconds', clock_timestamp()) AS claimed_at
         ),
         eligible AS (
           SELECT event.id, claim_clock.claimed_at
           FROM ops.product_outbox_events AS event
           CROSS JOIN claim_clock
           WHERE event.tenant_id = $1 AND event.workspace_id = $2 AND event.space_id = $3
             AND event.relay_service_principal_id = $4 AND event.policy_version_id = $5
             AND event.publication_attempt < 6
             AND (
               (event.publication_state IN ('pending', 'retry_wait')
                 AND event.next_attempt_at <= claim_clock.claimed_at)
               OR (event.publication_state = 'claimed'
                 AND event.claim_expires_at <= claim_clock.claimed_at)
             )
           ORDER BY event.next_attempt_at, event.created_at, event.id
           LIMIT 1
           FOR UPDATE OF event SKIP LOCKED
         )
         UPDATE ops.product_outbox_events event
         SET publication_state = 'claimed',
             publication_attempt = event.publication_attempt + 1,
             claimed_at = eligible.claimed_at,
             claimed_by = $6,
             claim_token = $7,
             claim_expires_at = eligible.claimed_at + ($8 * interval '1 second'),
             last_outcome_code = NULL
         FROM eligible
         WHERE event.id = eligible.id
           AND event.tenant_id = $1 AND event.workspace_id = $2 AND event.space_id = $3
           AND event.relay_service_principal_id = $4 AND event.policy_version_id = $5
         RETURNING event.id, event.tenant_id, event.workspace_id, event.space_id,
           event.relay_service_principal_id, event.policy_version_id,
           event.event_type, event.event_schema_version, event.payload_schema_version,
           event.aggregate_type, event.aggregate_id, event.aggregate_version,
           event.causation_command_id, event.payload, event.request_id,
           event.traceparent, event.tracestate, event.publication_attempt,
           event.claimed_by, event.claim_token, event.claimed_at, event.claim_expires_at`,
        [...scopeValues(scope), options.claimedBy, token, options.leaseSeconds]
      );
      const row = claimed.rows[0];
      return row ? createClaimHandle(row, this.serverOwnedHandles) : undefined;
    });
  }

  async publishClaimed(
    inputHandle: ProductOutboxClaimHandle,
    publisher: ProductPublicationPublisher
  ): Promise<ProductPublishClaimedResult> {
    const handle = validateHandle(inputHandle, true, this.serverOwnedHandles);
    if (!publisher || typeof publisher.publish !== "function")
      throw new ProductRelayClaimRejectedError();
    const context = contextForHandle(handle, true);
    let acknowledgedMessageId: string | undefined;

    try {
      return await withTenantTransaction({ pool: this.pool, context }, async (tx) => {
        await assertProductRelayRole(tx);
        const locked = await tx.query<ProductOutboxRow>(
          `SELECT id, tenant_id, workspace_id, space_id, relay_service_principal_id,
                  policy_version_id, event_type, event_schema_version, payload_schema_version,
                  aggregate_type, aggregate_id, aggregate_version, causation_command_id,
                  payload, request_id, traceparent, tracestate, publication_attempt,
                  claimed_by, claim_token, claimed_at, claim_expires_at
           FROM ops.product_outbox_events
           WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
             AND relay_service_principal_id = $5 AND policy_version_id = $6
             AND publication_state = 'claimed' AND publication_attempt = $7
             AND claimed_by = $8 AND claim_token = $9
             AND claim_expires_at = $10::timestamptz
             AND claim_expires_at > clock_timestamp()
           LIMIT 1
           FOR UPDATE`,
          handleValues(handle)
        );
        const row = locked.rows[0];
        if (!row || !rowMatchesHandle(row, handle)) throw new ProductRelayClaimRejectedError();

        const decision = await this.authorization.canInTransaction(
          context,
          "product_outbox.relay.publish",
          { type: "space", id: handle.spaceId },
          tx
        );
        if (!decision.allowed) throw new ProductRelayAuthorizationError();

        const acknowledgment = await publisher.publish(deepFreeze(handle.envelope));
        acknowledgedMessageId = validateMessageId(acknowledgment.messageId);
        const marked = await tx.query<{ id: string }>(
          `UPDATE ops.product_outbox_events
           SET publication_state = 'published',
               claimed_at = NULL, claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL,
               last_outcome_code = NULL,
               published_at = clock_timestamp(), published_message_id = $11
           WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
             AND relay_service_principal_id = $5 AND policy_version_id = $6
             AND publication_state = 'claimed' AND publication_attempt = $7
             AND claimed_by = $8 AND claim_token = $9
             AND claim_expires_at = $10::timestamptz
             AND claim_expires_at > clock_timestamp()
           RETURNING id`,
          [...handleValues(handle), acknowledgedMessageId]
        );
        if (marked.rows.length !== 1) throw new ProductRelayClaimRejectedError();
        return {
          status: "published" as const,
          eventId: handle.eventId,
          messageId: acknowledgedMessageId
        };
      });
    } catch (error) {
      if (!acknowledgedMessageId) throw error;
      if (await this.isPublished(handle, acknowledgedMessageId)) {
        return { status: "published", eventId: handle.eventId, messageId: acknowledgedMessageId };
      }
      return { status: "unresolved", eventId: handle.eventId, messageId: acknowledgedMessageId };
    }
  }

  async recordFailure(
    inputHandle: ProductOutboxClaimHandle,
    failure: { kind: ProductPublicationFailureKind; code: string }
  ): Promise<"retry_wait" | "terminal_failed" | "terminal_unconfirmed" | "already_settled"> {
    const handle = validateHandle(inputHandle, false, this.serverOwnedHandles);
    if (!SAFE_CODE_PATTERN.test(failure.code)) throw new ProductRelayClaimRejectedError();
    const context = contextForHandle(handle, false);
    const terminalState =
      failure.kind === "deterministic" ? "terminal_failed" : "terminal_unconfirmed";

    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertProductRelayRole(tx);
      const result =
        handle.publicationAttempt < 6
          ? await tx.query<{ publication_state: "retry_wait" }>(
              `UPDATE ops.product_outbox_events
               SET publication_state = 'retry_wait',
                   claimed_at = NULL, claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL,
                   last_outcome_code = $11,
                   next_attempt_at = clock_timestamp() + ($12 * interval '1 second')
               WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
                 AND relay_service_principal_id = $5 AND policy_version_id = $6
                 AND publication_state = 'claimed' AND publication_attempt = $7
                 AND claimed_by = $8 AND claim_token = $9 AND claim_expires_at = $10::timestamptz
               RETURNING publication_state`,
              [...handleValues(handle), failure.code, retryDelaySeconds(handle.publicationAttempt)]
            )
          : await tx.query<{ publication_state: "terminal_failed" | "terminal_unconfirmed" }>(
              `UPDATE ops.product_outbox_events
               SET publication_state = $11,
                   claimed_at = NULL, claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL,
                   last_outcome_code = $12, terminal_at = clock_timestamp()
               WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
                 AND relay_service_principal_id = $5 AND policy_version_id = $6
                 AND publication_state = 'claimed' AND publication_attempt = $7
                 AND claimed_by = $8 AND claim_token = $9 AND claim_expires_at = $10::timestamptz
               RETURNING publication_state`,
              [...handleValues(handle), terminalState, failure.code]
            );
      return result.rows[0]?.publication_state ?? "already_settled";
    });
  }

  private async isPublished(handle: ProductOutboxClaimHandle, messageId: string): Promise<boolean> {
    const context = contextForHandle(handle, false);
    try {
      return await withTenantTransaction({ pool: this.pool, context }, async (tx) => {
        await assertProductRelayRole(tx);
        const result = await tx.query<{ id: string }>(
          `SELECT id FROM ops.product_outbox_events
           WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND space_id = $4
             AND relay_service_principal_id = $5 AND policy_version_id = $6
             AND publication_attempt = $7 AND publication_state = 'published'
             AND published_message_id = $8
           LIMIT 1`,
          [
            handle.eventId,
            handle.tenantId,
            handle.workspaceId,
            handle.spaceId,
            handle.relayServicePrincipalId,
            handle.policyVersionId,
            handle.publicationAttempt,
            messageId
          ]
        );
        return result.rows.length === 1;
      });
    } catch {
      return false;
    }
  }
}

export type ProductDeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly ProductDeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: ProductDeepReadonly<T[K]> }
      : T;

function createClaimHandle(
  row: ProductOutboxRow,
  serverOwnedHandles: WeakSet<object>
): ProductOutboxClaimHandle {
  const envelope = envelopeFromRow(row);
  const handle = deepFreeze({
    eventId: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id,
    relayServicePrincipalId: row.relay_service_principal_id,
    policyVersionId: row.policy_version_id,
    eventType: envelope.eventType,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    aggregateVersion: envelope.aggregateVersion,
    causationCommandId: envelope.causationCommandId,
    envelope,
    canonicalEnvelope: serializeDomainNotificationEnvelope(envelope),
    publicationAttempt: row.publication_attempt,
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at.toISOString(),
    claimExpiresAt: row.claim_expires_at.toISOString()
  }) as ProductOutboxClaimHandle;
  serverOwnedHandles.add(handle);
  return handle;
}

function envelopeFromRow(row: ProductOutboxRow): DomainNotificationEnvelope {
  return parseDomainNotificationEnvelope({
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
  });
}

function rowMatchesHandle(row: ProductOutboxRow, handle: ProductOutboxClaimHandle): boolean {
  return (
    row.id === handle.eventId &&
    row.tenant_id === handle.tenantId &&
    row.workspace_id === handle.workspaceId &&
    row.space_id === handle.spaceId &&
    row.relay_service_principal_id === handle.relayServicePrincipalId &&
    row.policy_version_id === handle.policyVersionId &&
    row.publication_attempt === handle.publicationAttempt &&
    row.claimed_by === handle.claimedBy &&
    row.claim_token === handle.claimToken &&
    row.claimed_at.toISOString() === handle.claimedAt &&
    row.claim_expires_at.toISOString() === handle.claimExpiresAt &&
    serializeDomainNotificationEnvelope(envelopeFromRow(row)) === handle.canonicalEnvelope
  );
}

function validateHandle(
  input: ProductOutboxClaimHandle,
  requireLiveLease: boolean,
  serverOwnedHandles: WeakSet<object>
): ProductOutboxClaimHandle {
  if (!input || typeof input !== "object" || !serverOwnedHandles.has(input)) {
    throw new ProductRelayClaimRejectedError();
  }
  if (
    !CLAIM_TOKEN_PATTERN.test(input.claimToken) ||
    !SAFE_OWNER_PATTERN.test(input.claimedBy) ||
    !Number.isInteger(input.publicationAttempt) ||
    input.publicationAttempt < 1 ||
    input.publicationAttempt > 6 ||
    serializeDomainNotificationEnvelope(input.envelope) !== input.canonicalEnvelope ||
    input.eventId !== input.envelope.eventId ||
    input.tenantId !== input.envelope.tenantId ||
    input.workspaceId !== input.envelope.workspaceId ||
    input.spaceId !== input.envelope.spaceId ||
    input.eventType !== input.envelope.eventType ||
    input.aggregateType !== input.envelope.aggregateType ||
    input.aggregateId !== input.envelope.aggregateId ||
    input.aggregateVersion !== input.envelope.aggregateVersion ||
    input.causationCommandId !== input.envelope.causationCommandId ||
    !Number.isFinite(Date.parse(input.claimedAt)) ||
    !Number.isFinite(Date.parse(input.claimExpiresAt)) ||
    Date.parse(input.claimExpiresAt) <= Date.parse(input.claimedAt) ||
    (requireLiveLease && Date.parse(input.claimExpiresAt) <= Date.now())
  ) {
    throw new ProductRelayClaimRejectedError();
  }
  return input;
}

function validateScope(scope: ProductRelayClaimScope): ProductRelayClaimScope {
  for (const value of [
    scope.tenantId,
    scope.workspaceId,
    scope.spaceId,
    scope.relayServicePrincipalId
  ]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new ProductRelayClaimRejectedError();
    }
  }
  if (!scope.policyVersionId || scope.policyVersionId.length > 200) {
    throw new ProductRelayClaimRejectedError();
  }
  return Object.freeze({ ...scope });
}

function validateClaimOptions(options: ProductRelayClaimOptions): void {
  if (!SAFE_OWNER_PATTERN.test(options.claimedBy)) throw new ProductRelayClaimRejectedError();
  if (
    !Number.isInteger(options.leaseSeconds) ||
    options.leaseSeconds < 5 ||
    options.leaseSeconds > 300
  ) {
    throw new ProductRelayClaimRejectedError();
  }
}

function contextForScope(scope: ProductRelayClaimScope, lifetimeSeconds: number): SecurityContext {
  const now = new Date();
  return {
    requestId: "product-relay-claim",
    traceId: "product-relay-claim",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    servicePrincipalId: scope.relayServicePrincipalId,
    requestedSpaceIds: [scope.spaceId],
    membershipIds: [],
    roleHints: [],
    dataClassCeiling: "confidential",
    policyVersion: scope.policyVersionId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + lifetimeSeconds * 1000).toISOString()
  };
}

function contextForHandle(
  handle: ProductOutboxClaimHandle,
  requireLiveLease: boolean
): SecurityContext {
  if (requireLiveLease && Date.parse(handle.claimExpiresAt) <= Date.now()) {
    throw new ProductRelayClaimRejectedError();
  }
  const now = new Date();
  const expiresAt = requireLiveLease
    ? handle.claimExpiresAt
    : new Date(now.getTime() + 30_000).toISOString();
  return {
    requestId: handle.envelope.requestId,
    traceId: handle.envelope.traceparent,
    tenantId: handle.tenantId,
    workspaceId: handle.workspaceId,
    servicePrincipalId: handle.relayServicePrincipalId,
    requestedSpaceIds: [handle.spaceId],
    membershipIds: [],
    roleHints: [],
    dataClassCeiling: "confidential",
    policyVersion: handle.policyVersionId,
    issuedAt: now.toISOString(),
    expiresAt
  };
}

function scopeValues(scope: ProductRelayClaimScope): readonly string[] {
  return [
    scope.tenantId,
    scope.workspaceId,
    scope.spaceId,
    scope.relayServicePrincipalId,
    scope.policyVersionId
  ];
}

function handleValues(handle: ProductOutboxClaimHandle): readonly unknown[] {
  return [
    handle.eventId,
    handle.tenantId,
    handle.workspaceId,
    handle.spaceId,
    handle.relayServicePrincipalId,
    handle.policyVersionId,
    handle.publicationAttempt,
    handle.claimedBy,
    handle.claimToken,
    handle.claimExpiresAt
  ];
}

async function assertProductRelayRole(tx: TenantDbTransaction): Promise<void> {
  const result = await tx.query<{ current_user: string }>("SELECT current_user AS current_user");
  if (result.rows.length !== 1 || result.rows[0]?.current_user !== PRODUCT_RELAY_ROLE) {
    throw new Error("Dedicated product relay database role is required");
  }
}

function validateMessageId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    hasControlCharacters(value)
  ) {
    throw Object.assign(new Error("SQS acknowledgment did not contain a valid MessageId"), {
      name: "MissingMessageId"
    });
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });
}

function retryDelaySeconds(publicationAttempt: number): number {
  const delay = RETRY_DELAYS_SECONDS[publicationAttempt - 1];
  if (delay === undefined) throw new ProductRelayClaimRejectedError();
  return delay;
}

function deepFreeze<T>(value: T): ProductDeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as ProductDeepReadonly<T>;
}
