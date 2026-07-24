import type {
  B2AuthorizedDomainCommand,
  B2CommandPayloadMap,
  B2CommandResultMap,
  DomainNotificationEnvelope,
  ResourceRef,
  SecurityContext
} from "@throughline/core-types";
import {
  PostgresAuthorizationService,
  type AuthorizationAction,
  type TransactionAwareAuthorizationService
} from "@throughline/authorization";
import {
  ProductDomainInvariantError,
  ProductDomainTransactionRepositories,
  type DomainCommandRepository,
  type PgPool,
  type TenantDbTransaction,
  withTenantTransaction
} from "@throughline/db";
import { createHash } from "node:crypto";
import {
  B2CommandInvariantError,
  B2CommandValidationError,
  hashB2CommandIdentity,
  parseB2Command,
  parseB2CommandResult
} from "./command-schemas.js";
import { TruthLedgerConflictError, TruthLedgerRepository } from "./repository.js";
import { VerifiedClaimSourceSpanAdmission } from "./source-span.js";
import { constructAcceptedFactAtTrustedBoundary, type Claim } from "./types.js";
import { generateUuidV7 } from "./uuid.js";

const APP_ROLE = "throughline_app";
const COMMAND_SCHEMA_VERSION = 1;

export type DurableTruthCommandKind = "claim.create" | "fact.accept";
type DurableTruthCommand = B2AuthorizedDomainCommand<DurableTruthCommandKind>;
type DurableTruthResult = B2CommandResultMap[DurableTruthCommandKind];

export class B2AuthorizationError extends Error {
  constructor() {
    super("Truth resource is unavailable");
    this.name = "B2AuthorizationError";
  }
}

export class B2IdempotencyConflictError extends Error {
  constructor() {
    super("Truth command precondition failed");
    this.name = "B2IdempotencyConflictError";
  }
}

export class TruthLedgerDomainCommandBus {
  private readonly authorization: TransactionAwareAuthorizationService;

  constructor(
    private readonly pool: PgPool,
    authorization?: TransactionAwareAuthorizationService
  ) {
    this.authorization = authorization ?? new PostgresAuthorizationService(pool);
  }

  async execute<K extends DurableTruthCommandKind>(
    input: B2AuthorizedDomainCommand<K>,
    context: SecurityContext
  ): Promise<B2CommandResultMap[K]> {
    const parsed = parseB2Command(input);
    if (parsed.kind !== "claim.create" && parsed.kind !== "fact.accept") {
      throw new B2CommandValidationError();
    }
    const command = parsed as DurableTruthCommand;
    requireHumanActor(context);
    const reservationSpaceId = await this.resolveReservationSpace(command, context);
    const mutationContext = { ...context, requestedSpaceIds: [reservationSpaceId] };
    const result = await withTenantTransaction(
      { pool: this.pool, context: mutationContext },
      async (tx) => {
        await assertApplicationRole(tx);
        return this.executeInTransaction(tx, command, mutationContext, reservationSpaceId);
      }
    );
    return parseB2CommandResult(command.kind, result) as B2CommandResultMap[K];
  }

  private async resolveReservationSpace(
    command: DurableTruthCommand,
    context: SecurityContext
  ): Promise<string> {
    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertApplicationRole(tx);
      const table =
        command.payload.subject.type === "activity" ? "work.activities" : "work.initiatives";
      const result = await tx.query<{ space_id: string }>(
        `SELECT space_id
         FROM ${table}
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         LIMIT 1`,
        [context.tenantId, context.workspaceId, command.payload.subject.id]
      );
      const spaceId = result.rows[0]?.space_id;
      if (!spaceId) throw new B2AuthorizationError();
      return spaceId;
    });
  }

  private async executeInTransaction(
    tx: TenantDbTransaction,
    command: DurableTruthCommand,
    context: SecurityContext,
    reservationSpaceId: string
  ): Promise<DurableTruthResult> {
    const actor = requireHumanActor(context);
    const ledger = new TruthLedgerRepository(tx);
    const domain = new ProductDomainTransactionRepositories(tx);
    const traceparent = traceparentFor(context);
    const requestHash = hashB2CommandIdentity(command);
    const subject = await ledger
      .getSubjectScope(
        context.tenantId,
        context.workspaceId,
        command.payload.subject.type,
        command.payload.subject.id,
        true
      )
      .catch(() => {
        throw new B2AuthorizationError();
      });
    if (
      subject.spaceId !== reservationSpaceId ||
      subject.version !== command.payload.subject.expectedVersion
    ) {
      throw new TruthLedgerConflictError();
    }

    if (command.kind === "claim.create") {
      await this.authorize(
        tx,
        context,
        "claim.create",
        { type: command.payload.subject.type, id: command.payload.subject.id },
        true
      );
      await this.authorize(
        tx,
        context,
        "source.read",
        { type: "source", id: command.payload.evidence.sourceArtifactId },
        true
      );
      const verified = await new VerifiedClaimSourceSpanAdmission(ledger, {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId
      }).admit({
        subject: command.payload.subject,
        evidence: command.payload.evidence
      });
      if (verified.spaceId !== subject.spaceId) throw new B2AuthorizationError();

      const reservation = await reserveCommand(
        domain.commands,
        command,
        context,
        requestHash,
        traceparent,
        reservationSpaceId
      );
      if (reservation.replay) return reservation.result;

      const claimId = generateUuidV7();
      const evidenceSpanId = generateUuidV7();
      await ledger.insertEvidenceAndClaim({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        claimId,
        evidenceSpanId,
        commandId: reservation.commandId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        assertedById: actor.displayPersonId,
        predicate: command.payload.predicate,
        valueJson: command.payload.valueJson,
        normalizedText: command.payload.normalizedText,
        confidence: command.payload.confidence,
        ...(command.payload.validFrom === undefined
          ? {}
          : { validFrom: command.payload.validFrom }),
        ...(command.payload.validTo === undefined ? {} : { validTo: command.payload.validTo }),
        ...(command.payload.observedAt === undefined
          ? {}
          : { observedAt: command.payload.observedAt }),
        evidence: verified
      });
      await writeAuditAndOutbox({
        tx,
        ledger,
        context,
        commandId: reservation.commandId,
        traceparent,
        spaceId: subject.spaceId,
        action: "claim.create",
        resourceType: "claim",
        resourceId: claimId,
        eventType: "claim.proposed",
        aggregateType: "claim",
        aggregateVersion: 1,
        payload: { claimId, evidenceSpanId },
        auditDetail: { claimId, evidenceSpanId }
      });
      const result = { claimId, version: 1 as const, status: "proposed" as const };
      await completeCommand(
        domain.commands,
        command,
        context,
        requestHash,
        reservationSpaceId,
        reservation.commandId,
        "claim",
        claimId,
        result
      );
      return result;
    }

    await this.authorize(
      tx,
      context,
      "fact.accept",
      { type: command.payload.subject.type, id: command.payload.subject.id },
      true
    );
    const claimIds = command.payload.claims.map(({ claimId }) => claimId);
    const headers = await ledger
      .lockClaimSupportHeaders(context.tenantId, context.workspaceId, claimIds)
      .catch(() => {
        throw new B2AuthorizationError();
      });
    for (const header of headers) {
      await this.authorize(tx, context, "claim.read", { type: "claim", id: header.claimId }, true);
      await this.authorize(
        tx,
        context,
        "source.read",
        { type: "source", id: header.sourceArtifactId },
        true
      );
    }

    const persistedClaims = await ledger.loadClaimsForAcceptance(
      context.tenantId,
      context.workspaceId,
      claimIds
    );
    if (
      persistedClaims.some(
        ({ claim }) =>
          claim.subjectType !== subject.subjectType ||
          claim.subjectId !== subject.subjectId ||
          claim.spaceId !== subject.spaceId
      )
    ) {
      throw new TruthLedgerConflictError();
    }

    const admittedClaims: Claim[] = [];
    for (const persisted of persistedClaims) {
      const sourceSpan = await new VerifiedClaimSourceSpanAdmission(ledger, {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId
      }).admit({
        subject: command.payload.subject,
        evidence: persisted.evidence
      });
      admittedClaims.push(Object.freeze({ ...persisted.claim, sourceSpan }));
    }

    const reservation = await reserveCommand(
      domain.commands,
      command,
      context,
      requestHash,
      traceparent,
      reservationSpaceId
    );
    if (reservation.replay) return reservation.result;

    const expectedVersions = new Map(
      command.payload.claims.map(({ claimId, expectedVersion }) => [claimId, expectedVersion])
    );
    if (
      persistedClaims.some(
        ({ claim, claimVersion }) =>
          claim.status !== "proposed" || expectedVersions.get(claim.id) !== claimVersion
      )
    ) {
      throw new TruthLedgerConflictError();
    }

    const timestamp = await ledger.transactionTimestamp();
    const fact = constructAcceptedFactAtTrustedBoundary({
      id: generateUuidV7(),
      claims: admittedClaims,
      subjectAccessClass: subject.accessClass,
      explicitPolicyAccessClass: subject.accessClass,
      acceptedByUserId: actor.userId,
      acceptedByMembershipId: actor.membershipId,
      acceptanceScope: command.payload.acceptanceScope,
      authorityBasis: subject.subjectType === "activity" ? "activity_owner" : "initiative_owner",
      policyVersion: context.policyVersion,
      recordedAt: timestamp,
      createdAt: timestamp,
      ...(command.payload.confidenceLowering === undefined
        ? {}
        : { confidenceLowering: command.payload.confidenceLowering })
    });
    await ledger.lockFirstAcceptanceSlot({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      spaceId: fact.spaceId,
      subjectType: fact.subjectType,
      subjectId: fact.subjectId,
      predicate: fact.predicate
    });
    await ledger.insertAcceptedFact({
      fact,
      commandId: reservation.commandId,
      confidenceDecision: fact.confidenceDecision
    });
    await writeAuditAndOutbox({
      tx,
      ledger,
      context,
      commandId: reservation.commandId,
      traceparent,
      spaceId: fact.spaceId,
      action: "fact.accept",
      resourceType: "accepted_fact",
      resourceId: fact.id,
      eventType: "fact.accepted",
      aggregateType: "accepted_fact",
      aggregateVersion: 1,
      payload: { factId: fact.id },
      auditDetail: { factId: fact.id }
    });
    const result = {
      factId: fact.id,
      version: 1 as const,
      status: "current" as const,
      acceptedClaimIds: [...fact.supportingClaimIds]
    };
    await completeCommand(
      domain.commands,
      command,
      context,
      requestHash,
      reservationSpaceId,
      reservation.commandId,
      "accepted_fact",
      fact.id,
      result
    );
    return result;
  }

  private async authorize(
    tx: TenantDbTransaction,
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    lockAuthority: boolean
  ): Promise<void> {
    const decision = await this.authorization.canInTransaction(context, action, resource, tx, {
      lockAuthority
    });
    if (!decision.allowed) throw new B2AuthorizationError();
  }
}

async function reserveCommand(
  repository: DomainCommandRepository,
  command: DurableTruthCommand,
  context: SecurityContext,
  requestHash: string,
  traceparent: string,
  reservationSpaceId: string
): Promise<{ replay: false; commandId: string } | { replay: true; result: DurableTruthResult }> {
  const commandId = generateUuidV7();
  try {
    const reservation = await repository.reserve({
      id: commandId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      reservationSpaceId,
      commandKind: `${command.kind}.v1`,
      commandSchemaVersion: COMMAND_SCHEMA_VERSION,
      idempotencyKey: command.idempotencyKey,
      canonicalRequestHash: requestHash,
      actorUserId: context.actorUserId!,
      actorMembershipId: context.actorMembershipId!,
      ...(context.delegatedByUserId === undefined
        ? {}
        : { delegatingUserId: context.delegatedByUserId }),
      ...(context.delegatedByMembershipId === undefined
        ? {}
        : { delegatingMembershipId: context.delegatedByMembershipId }),
      policyVersionId: context.policyVersion,
      requestId: context.requestId,
      traceparent
    });
    if (reservation.status === "replay") {
      return {
        replay: true,
        result: parseB2CommandResult(command.kind, reservation.command.safeResponse)
      };
    }
    if (reservation.commandId !== commandId) throw new B2CommandInvariantError();
    return { replay: false, commandId };
  } catch (error) {
    if (error instanceof ProductDomainInvariantError) {
      throw new B2IdempotencyConflictError();
    }
    throw error;
  }
}

async function completeCommand(
  repository: DomainCommandRepository,
  command: DurableTruthCommand,
  context: SecurityContext,
  requestHash: string,
  reservationSpaceId: string,
  commandId: string,
  resourceType: "claim" | "accepted_fact",
  resourceId: string,
  result: DurableTruthResult
): Promise<void> {
  await repository.complete({
    commandId,
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    reservationSpaceId,
    commandKind: `${command.kind}.v1`,
    idempotencyKey: command.idempotencyKey,
    canonicalRequestHash: requestHash,
    resultResourceType: resourceType,
    resultResourceId: resourceId,
    safeResponse: result
  });
}

async function writeAuditAndOutbox(input: {
  tx: TenantDbTransaction;
  ledger: TruthLedgerRepository;
  context: SecurityContext;
  commandId: string;
  traceparent: string;
  spaceId: string;
  action: "claim.create" | "fact.accept";
  resourceType: "claim" | "accepted_fact";
  resourceId: string;
  eventType: "claim.proposed" | "fact.accepted";
  aggregateType: "claim" | "accepted_fact";
  aggregateVersion: 1;
  payload: Record<string, unknown>;
  auditDetail: Record<string, unknown>;
}): Promise<void> {
  const domain = new ProductDomainTransactionRepositories(input.tx);
  await domain.audit.insert({
    id: generateUuidV7(),
    tenantId: input.context.tenantId,
    workspaceId: input.context.workspaceId,
    spaceId: input.spaceId,
    causationCommandId: input.commandId,
    actorUserId: input.context.actorUserId!,
    actorMembershipId: input.context.actorMembershipId!,
    ...(input.context.delegatedByUserId === undefined
      ? {}
      : { delegatingUserId: input.context.delegatedByUserId }),
    ...(input.context.delegatedByMembershipId === undefined
      ? {}
      : { delegatingMembershipId: input.context.delegatedByMembershipId }),
    policyVersionId: input.context.policyVersion,
    requestId: input.context.requestId,
    traceparent: input.traceparent,
    auditSchemaVersion: 1,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    safeDetail: input.auditDetail
  } as Parameters<ProductDomainTransactionRepositories["audit"]["insert"]>[0]);
  const relayServicePrincipalId = await input.ledger.relayPrincipalForSpace(
    input.context.tenantId,
    input.context.workspaceId,
    input.spaceId
  );
  await domain.outbox.insertOrReplay({
    envelope: {
      eventId: generateUuidV7(),
      eventType: input.eventType,
      eventSchemaVersion: 1,
      payloadSchemaVersion: 1,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      spaceId: input.spaceId,
      aggregateType: input.aggregateType,
      aggregateId: input.resourceId,
      aggregateVersion: input.aggregateVersion,
      causationCommandId: input.commandId,
      payload: input.payload,
      requestId: input.context.requestId,
      traceparent: input.traceparent
    } as DomainNotificationEnvelope,
    relayServicePrincipalId,
    policyVersionId: input.context.policyVersion
  });
}

async function assertApplicationRole(tx: TenantDbTransaction): Promise<void> {
  const result = await tx.query<{ current_user: string }>("SELECT current_user AS current_user");
  if (result.rows.length !== 1 || result.rows[0]?.current_user !== APP_ROLE) {
    throw new B2AuthorizationError();
  }
}

function requireHumanActor(context: SecurityContext): {
  userId: string;
  membershipId: string;
  displayPersonId: string;
} {
  if (
    !context.actorUserId ||
    !context.actorMembershipId ||
    !context.actorDisplayPersonId ||
    context.servicePrincipalId ||
    context.agentPrincipalId
  ) {
    throw new B2AuthorizationError();
  }
  return {
    userId: context.actorUserId,
    membershipId: context.actorMembershipId,
    displayPersonId: context.actorDisplayPersonId
  };
}

function traceparentFor(context: SecurityContext): string {
  const traceId =
    /^[0-9a-f]{32}$/i.test(context.traceId) && context.traceId !== "0".repeat(32)
      ? context.traceId.toLowerCase()
      : createHash("sha256").update(context.traceId).digest("hex").slice(0, 32);
  const spanId = createHash("sha256")
    .update(`${context.requestId}:${context.traceId}:truth-write`)
    .digest("hex")
    .slice(0, 16);
  return `00-${traceId}-${spanId === "0".repeat(16) ? "1".padStart(16, "0") : spanId}-01`;
}

export type ClaimCreatePayload = B2CommandPayloadMap["claim.create"];
export type FactAcceptPayload = B2CommandPayloadMap["fact.accept"];
