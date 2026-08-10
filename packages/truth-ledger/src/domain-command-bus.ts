import { maxAccessClass } from "@throughline/core-types";
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
import { resolvePredicateDefinition } from "./predicate-registry.js";
import {
  VerifiedClaimSourceSpanAdmission,
  bindClaimEvidenceSnapshotLookupToTransaction
} from "./source-span.js";
import { constructAcceptedFactAtTrustedBoundary, type Claim } from "./types.js";
import { generateUuidV7 } from "./uuid.js";

const APP_ROLE = "throughline_app";
const COMMAND_SCHEMA_VERSION = 1;

export type DurableTruthCommandKind =
  | "claim.create"
  | "initiative.primary_objective.withdraw"
  | "initiative.primary_objective.rework"
  | "fact.accept"
  | "fact.supersede"
  | "fact.revoke";
type InternalCreateClaimCommand = Omit<B2AuthorizedDomainCommand<"claim.create">, "payload"> & {
  payload: Omit<B2CommandPayloadMap["claim.create"], "valueJson"> & {
    canonicalValue: string;
  };
};
type InternalReworkPrimaryObjectiveCommand = Omit<
  B2AuthorizedDomainCommand<"initiative.primary_objective.rework">,
  "payload"
> & {
  payload: Omit<B2CommandPayloadMap["initiative.primary_objective.rework"], "valueJson"> & {
    canonicalValue: string;
  };
};
type FactLifecycleCommandKind = "fact.supersede" | "fact.revoke";
type FactLifecycleCommand = B2AuthorizedDomainCommand<FactLifecycleCommandKind>;
type DurableTruthCommand =
  | InternalCreateClaimCommand
  | InternalReworkPrimaryObjectiveCommand
  | B2AuthorizedDomainCommand<"initiative.primary_objective.withdraw">
  | B2AuthorizedDomainCommand<"fact.accept">
  | FactLifecycleCommand;
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
    if (
      parsed.kind !== "claim.create" &&
      parsed.kind !== "initiative.primary_objective.withdraw" &&
      parsed.kind !== "initiative.primary_objective.rework" &&
      parsed.kind !== "fact.accept" &&
      parsed.kind !== "fact.supersede" &&
      parsed.kind !== "fact.revoke"
    ) {
      throw new B2CommandValidationError();
    }
    if (parsed.kind === "fact.supersede" && parsed.payload.conflict !== undefined) {
      throw new B2CommandValidationError();
    }
    const requestHash = hashB2CommandIdentity(parsed);
    const command = toDurableTruthCommand(parsed);
    if (command.kind === "fact.supersede" || command.kind === "fact.revoke") {
      return (await this.executeFactLifecycle(
        command,
        requestHash,
        context
      )) as B2CommandResultMap[K];
    }
    requireHumanActor(context);
    const reservationSpaceId = await this.resolveReservationSpace(command, context);
    const mutationContext = { ...context, requestedSpaceIds: [reservationSpaceId] };
    const result = await withTenantTransaction(
      { pool: this.pool, context: mutationContext },
      async (tx) => {
        await assertApplicationRole(tx);
        return this.executeInTransaction(
          tx,
          command,
          requestHash,
          mutationContext,
          reservationSpaceId
        );
      }
    );
    return parseB2CommandResult(command.kind, result) as B2CommandResultMap[K];
  }

  private async executeFactLifecycle(
    command: FactLifecycleCommand,
    requestHash: string,
    context: SecurityContext
  ): Promise<DurableTruthResult> {
    try {
      requireHumanActor(context);
      const reservationSpaceId = await this.resolveReservationSpace(command, context);
      const mutationContext = { ...context, requestedSpaceIds: [reservationSpaceId] };
      const result = await withTenantTransaction(
        { pool: this.pool, context: mutationContext },
        async (tx) => {
          await assertApplicationRole(tx);
          return this.executeInTransaction(
            tx,
            command,
            requestHash,
            mutationContext,
            reservationSpaceId
          );
        }
      );
      return parseB2CommandResult(command.kind, result);
    } catch {
      throw new TruthLedgerConflictError();
    }
  }

  private async resolveReservationSpace(
    command: DurableTruthCommand,
    context: SecurityContext
  ): Promise<string> {
    if (command.kind === "fact.supersede" || command.kind === "fact.revoke") {
      const factId = command.payload.factId;
      const expectedVersion = command.payload.expectedFactVersion;
      return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
        await assertApplicationRole(tx);
        const reservation = await new TruthLedgerRepository(tx).readFactLifecycleReservation({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          factId,
          expectedVersion
        });
        return reservation.spaceId;
      });
    }
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
    requestHash: string,
    context: SecurityContext,
    reservationSpaceId: string
  ): Promise<DurableTruthResult> {
    const actor = requireHumanActor(context);
    const ledger = new TruthLedgerRepository(tx);
    const domain = new ProductDomainTransactionRepositories(tx);
    const traceparent = traceparentFor(context);
    if (command.kind === "fact.supersede" || command.kind === "fact.revoke") {
      return this.executeFactLifecycleInTransaction({
        tx,
        ledger,
        domain,
        command,
        requestHash,
        context,
        reservationSpaceId,
        traceparent,
        actor
      });
    }
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
      const verified = await new VerifiedClaimSourceSpanAdmission(
        tx,
        bindClaimEvidenceSnapshotLookupToTransaction(tx, ledger),
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        }
      ).admit({
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

      const predicateDefinition = resolvePredicateDefinition(
        command.payload.predicate,
        command.payload.subject.type
      );
      if (predicateDefinition.proposalSlotPolicy === "single_open") {
        if (!command.payload.expectedPrimaryObjectiveGeneration) {
          throw new B2CommandInvariantError();
        }
        await ledger.lockPrimaryObjectiveProposalSlot({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          expectedLatestClaim: command.payload.expectedPrimaryObjectiveGeneration
        });
      }

      const claimId = generateUuidV7();
      const evidenceSpanId = generateUuidV7();
      const supportAttestationId = command.payload.supportConfirmation
        ? generateUuidV7()
        : undefined;
      await ledger.insertEvidenceAndClaim({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        claimId,
        evidenceSpanId,
        ...(supportAttestationId === undefined ? {} : { supportAttestationId }),
        commandId: reservation.commandId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        assertedById: actor.displayPersonId,
        predicate: command.payload.predicate,
        canonicalValue: command.payload.canonicalValue,
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
        payload: {
          claimId,
          evidenceSpanId,
          ...(supportAttestationId === undefined ? {} : { supportAttestationId })
        },
        auditDetail: {
          claimId,
          evidenceSpanId,
          ...(supportAttestationId === undefined ? {} : { supportAttestationId })
        }
      });
      const result = {
        claimId,
        version: 1 as const,
        status: "proposed" as const,
        evidenceSpanId,
        ...(supportAttestationId === undefined ? {} : { supportAttestationId })
      };
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

    if (
      command.kind === "initiative.primary_objective.withdraw" ||
      command.kind === "initiative.primary_objective.rework"
    ) {
      const predecessor =
        command.kind === "initiative.primary_objective.withdraw"
          ? command.payload.proposal
          : command.payload.predecessor;
      const action: AuthorizationAction =
        command.kind === "initiative.primary_objective.rework"
          ? "initiative.primary_objective.proposal.rework"
          : command.payload.disposition === "rejected"
            ? "initiative.primary_objective.proposal.reject"
            : "initiative.primary_objective.proposal.withdraw";
      await domain.commands.lockReservationIdentity({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        reservationSpaceId,
        commandKind: `${command.kind}.v1`,
        idempotencyKey: command.idempotencyKey
      });
      await this.authorize(tx, context, action, { type: "claim", id: predecessor.claimId }, false);
      const reservation = await reserveCommand(
        domain.commands,
        command,
        context,
        requestHash,
        traceparent,
        reservationSpaceId
      );
      if (reservation.replay) {
        await this.authorize(tx, context, action, { type: "claim", id: predecessor.claimId }, true);
        return reservation.result;
      }

      await ledger.lockPrimaryObjectiveProposal({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: subject.spaceId,
        initiativeId: subject.subjectId,
        claimId: predecessor.claimId,
        expectedVersion: predecessor.expectedVersion
      });
      await this.authorize(tx, context, action, { type: "claim", id: predecessor.claimId }, true);
      const timestamp = await ledger.transactionTimestamp();
      const recoveryId = generateUuidV7();

      if (command.kind === "initiative.primary_objective.withdraw") {
        await ledger.terminalizePrimaryObjectiveProposal({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: subject.spaceId,
          initiativeId: subject.subjectId,
          predecessorClaimId: predecessor.claimId,
          recoveryId,
          disposition: command.payload.disposition,
          reasonCode: command.payload.reasonCode,
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId,
          commandId: reservation.commandId,
          timestamp
        });
        const result = {
          claimId: predecessor.claimId,
          version: 2 as const,
          status: "rejected" as const,
          recoveryId,
          disposition: command.payload.disposition,
          reasonCode: command.payload.reasonCode
        };
        const rejected = command.payload.disposition === "rejected";
        await writeAuditAndOutbox({
          tx,
          ledger,
          context,
          commandId: reservation.commandId,
          traceparent,
          spaceId: subject.spaceId,
          action: rejected
            ? "initiative.primary_objective.reject"
            : "initiative.primary_objective.withdraw",
          resourceType: "claim",
          resourceId: predecessor.claimId,
          eventType: rejected
            ? "initiative.primary_objective.proposal_rejected"
            : "initiative.primary_objective.proposal_withdrawn",
          aggregateType: "claim",
          aggregateVersion: 2,
          payload: {
            claimId: predecessor.claimId,
            claimVersion: 2,
            recoveryId,
            disposition: command.payload.disposition,
            reasonCode: command.payload.reasonCode
          },
          auditDetail: {
            claimId: predecessor.claimId,
            claimVersion: 2,
            recoveryId,
            disposition: command.payload.disposition,
            reasonCode: command.payload.reasonCode
          }
        });
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "claim",
          predecessor.claimId,
          result
        );
        return result;
      }

      await this.authorize(
        tx,
        context,
        "source.read",
        { type: "source", id: command.payload.evidence.sourceArtifactId },
        true
      );
      const verified = await new VerifiedClaimSourceSpanAdmission(
        tx,
        bindClaimEvidenceSnapshotLookupToTransaction(tx, ledger),
        { tenantId: context.tenantId, workspaceId: context.workspaceId }
      ).admit({ subject: command.payload.subject, evidence: command.payload.evidence });
      if (verified.spaceId !== subject.spaceId) throw new B2AuthorizationError();

      const successorClaimId = generateUuidV7();
      const evidenceSpanId = generateUuidV7();
      const supportAttestationId = generateUuidV7();
      await ledger.terminalizePrimaryObjectiveProposal({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: subject.spaceId,
        initiativeId: subject.subjectId,
        predecessorClaimId: predecessor.claimId,
        successorClaimId,
        recoveryId,
        disposition: "reworked",
        reasonCode: "reworked",
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        commandId: reservation.commandId,
        timestamp
      });
      await ledger.insertEvidenceAndClaim({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        claimId: successorClaimId,
        evidenceSpanId,
        supportAttestationId,
        commandId: reservation.commandId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        assertedById: actor.displayPersonId,
        predicate: "initiative.primary_objective",
        canonicalValue: command.payload.canonicalValue,
        normalizedText: command.payload.normalizedText,
        confidence: command.payload.confidence,
        evidence: verified
      });
      const result = {
        predecessorClaimId: predecessor.claimId,
        predecessorVersion: 2 as const,
        predecessorStatus: "superseded" as const,
        successorClaimId,
        successorVersion: 1 as const,
        successorStatus: "proposed" as const,
        evidenceSpanId,
        supportAttestationId,
        recoveryId,
        disposition: "reworked" as const,
        reasonCode: "reworked" as const
      };
      const safeDetail = {
        predecessorClaimId: predecessor.claimId,
        predecessorVersion: 2,
        successorClaimId,
        successorVersion: 1,
        evidenceSpanId,
        supportAttestationId,
        recoveryId,
        disposition: "reworked",
        reasonCode: "reworked"
      };
      await writeAuditAndOutbox({
        tx,
        ledger,
        context,
        commandId: reservation.commandId,
        traceparent,
        spaceId: subject.spaceId,
        action: "initiative.primary_objective.rework",
        resourceType: "claim",
        resourceId: successorClaimId,
        eventType: "initiative.primary_objective.proposal_reworked",
        aggregateType: "claim",
        aggregateVersion: 1,
        payload: safeDetail,
        auditDetail: safeDetail
      });
      await completeCommand(
        domain.commands,
        command,
        context,
        requestHash,
        reservationSpaceId,
        reservation.commandId,
        "claim",
        successorClaimId,
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
    const reservation = await reserveCommand(
      domain.commands,
      command,
      context,
      requestHash,
      traceparent,
      reservationSpaceId
    );
    if (reservation.replay) return reservation.result;

    const claimIds = command.payload.claims.map(({ claimId }) => claimId);
    const headers = await ledger
      .readClaimSupportHeaders(context.tenantId, context.workspaceId, claimIds)
      .catch(() => {
        throw new B2AuthorizationError();
      });
    const discoveredCoordinate = headers[0];
    if (
      !discoveredCoordinate ||
      discoveredCoordinate.spaceId !== subject.spaceId ||
      discoveredCoordinate.subjectType !== subject.subjectType ||
      discoveredCoordinate.subjectId !== subject.subjectId ||
      headers.some(
        (header) =>
          header.spaceId !== discoveredCoordinate.spaceId ||
          header.subjectType !== discoveredCoordinate.subjectType ||
          header.subjectId !== discoveredCoordinate.subjectId ||
          header.predicate !== discoveredCoordinate.predicate
      )
    ) {
      throw new TruthLedgerConflictError();
    }
    await ledger.lockFirstAcceptanceSlot({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      spaceId: discoveredCoordinate.spaceId,
      subjectType: discoveredCoordinate.subjectType,
      subjectId: discoveredCoordinate.subjectId,
      predicate: discoveredCoordinate.predicate
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
    const expectedVersions = new Map(
      command.payload.claims.map(({ claimId, expectedVersion }) => [claimId, expectedVersion])
    );
    const headersByClaimId = new Map(headers.map((header) => [header.claimId, header]));
    if (
      persistedClaims.some(({ claim, claimVersion, evidenceSpanId, sourceArtifactId }) => {
        const header = headersByClaimId.get(claim.id);
        return (
          !header ||
          claim.status !== "proposed" ||
          expectedVersions.get(claim.id) !== claimVersion ||
          claim.spaceId !== discoveredCoordinate.spaceId ||
          claim.subjectType !== discoveredCoordinate.subjectType ||
          claim.subjectId !== discoveredCoordinate.subjectId ||
          claim.predicate !== discoveredCoordinate.predicate ||
          evidenceSpanId !== header.evidenceSpanId ||
          sourceArtifactId !== header.sourceArtifactId
        );
      })
    ) {
      throw new TruthLedgerConflictError();
    }
    if (
      discoveredCoordinate.subjectType === "initiative" &&
      discoveredCoordinate.predicate === "initiative.primary_objective"
    ) {
      await ledger.requirePrimaryObjectiveSupportConfirmations(
        context.tenantId,
        context.workspaceId,
        claimIds
      );
    }

    const admittedClaims: Claim[] = [];
    for (const persisted of persistedClaims) {
      const sourceSpan = await new VerifiedClaimSourceSpanAdmission(
        tx,
        bindClaimEvidenceSnapshotLookupToTransaction(tx, ledger),
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        }
      ).admit({
        subject: command.payload.subject,
        evidence: persisted.evidence
      });
      admittedClaims.push(Object.freeze({ ...persisted.claim, sourceSpan }));
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

  private async executeFactLifecycleInTransaction(input: {
    tx: TenantDbTransaction;
    ledger: TruthLedgerRepository;
    domain: ProductDomainTransactionRepositories;
    command: FactLifecycleCommand;
    requestHash: string;
    context: SecurityContext;
    reservationSpaceId: string;
    traceparent: string;
    actor: { userId: string; membershipId: string; displayPersonId: string };
  }): Promise<DurableTruthResult> {
    const { tx, ledger, domain, command, context, reservationSpaceId, traceparent, actor } = input;
    const reservationTarget = await ledger.readFactLifecycleReservation({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      factId: command.payload.factId,
      expectedVersion: command.payload.expectedFactVersion
    });
    if (reservationTarget.spaceId !== reservationSpaceId) throw new TruthLedgerConflictError();
    const reservation = await reserveCommand(
      domain.commands,
      command,
      context,
      input.requestHash,
      traceparent,
      reservationSpaceId
    );
    if (reservation.replay) {
      await this.authorize(
        tx,
        context,
        command.kind,
        { type: "fact", id: command.payload.factId },
        true,
        { factLifecycleReplay: true }
      );
      return reservation.result;
    }

    const prelockedTarget = await ledger.prelockCurrentFact({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      factId: command.payload.factId,
      expectedVersion: command.payload.expectedFactVersion
    });
    await this.authorize(
      tx,
      context,
      command.kind,
      { type: "fact", id: prelockedTarget.factId },
      true
    );
    const target = await ledger.refreshCurrentFactAfterAuthorization({ target: prelockedTarget });

    let result: B2CommandResultMap[FactLifecycleCommandKind];
    let safeDetail: Record<string, unknown>;
    if (command.kind === "fact.supersede") {
      if (
        command.payload.subject.type !== target.subjectType ||
        command.payload.subject.id !== target.subjectId ||
        command.payload.subject.expectedVersion !== target.subjectVersion
      ) {
        throw new TruthLedgerConflictError();
      }
      const persistedClaims = await ledger.lockReplacementClaimsForSupersession({
        target,
        replacementClaims: command.payload.replacementClaims
      });
      const admittedClaims: Claim[] = [];
      for (const replacement of persistedClaims) {
        await this.authorize(
          tx,
          context,
          "claim.read",
          { type: "claim", id: replacement.claim.id },
          true
        );
        await this.authorize(
          tx,
          context,
          "source.read",
          { type: "source", id: replacement.sourceArtifactId },
          true
        );
        const sourceSpan = await new VerifiedClaimSourceSpanAdmission(
          tx,
          bindClaimEvidenceSnapshotLookupToTransaction(tx, ledger),
          { tenantId: context.tenantId, workspaceId: context.workspaceId }
        ).admit({
          subject: {
            type: target.subjectType,
            id: target.subjectId,
            expectedVersion: target.subjectVersion
          },
          evidence: replacement.evidence
        });
        if (
          maxAccessClass(sourceSpan.effectiveAccessClass, target.subjectAccessClass) !==
          sourceSpan.effectiveAccessClass
        ) {
          throw new TruthLedgerConflictError();
        }
        admittedClaims.push(Object.freeze({ ...replacement.claim, sourceSpan }));
      }
      const timestamp = await ledger.transactionTimestamp();
      const successor = constructAcceptedFactAtTrustedBoundary({
        id: generateUuidV7(),
        claims: admittedClaims,
        subjectAccessClass: target.subjectAccessClass,
        explicitPolicyAccessClass: target.subjectAccessClass,
        acceptedByUserId: actor.userId,
        acceptedByMembershipId: actor.membershipId,
        acceptanceScope: target.acceptanceScope,
        authorityBasis: target.authorityBasis,
        policyVersion: context.policyVersion,
        recordedAt: timestamp,
        createdAt: timestamp,
        supersedesFactId: target.factId,
        ...(command.payload.confidenceLowering === undefined
          ? {}
          : { confidenceLowering: command.payload.confidenceLowering })
      });
      if (maxAccessClass(successor.accessClass, target.factAccessClass) !== successor.accessClass) {
        throw new TruthLedgerConflictError();
      }
      result = await ledger.supersedePrelockedFact({
        target,
        replacementFact: successor,
        lifecycleEventId: generateUuidV7(),
        commandId: reservation.commandId,
        reason: command.payload.reason,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        policyVersion: context.policyVersion
      });
      safeDetail = {
        factId: result.factId,
        factVersion: 2,
        reasonCode: command.payload.reason.code,
        replacementFactId: result.replacementFactId,
        replacementFactVersion: 1,
        status: "superseded"
      };
    } else {
      result = await ledger.revokePrelockedFact({
        target,
        lifecycleEventId: generateUuidV7(),
        commandId: reservation.commandId,
        reason: command.payload.reason,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        policyVersion: context.policyVersion
      });
      safeDetail = {
        factId: result.factId,
        factVersion: 2,
        reasonCode: command.payload.reason.code,
        status: "revoked"
      };
    }
    await writeAuditAndOutbox({
      tx,
      ledger,
      context,
      commandId: reservation.commandId,
      traceparent,
      spaceId: target.spaceId,
      action: command.kind,
      resourceType: "accepted_fact",
      resourceId: result.factId,
      eventType: command.kind === "fact.supersede" ? "fact.superseded" : "fact.revoked",
      aggregateType: "accepted_fact",
      aggregateVersion: 2,
      payload: safeDetail,
      auditDetail: safeDetail
    });
    await completeCommand(
      domain.commands,
      command,
      context,
      input.requestHash,
      reservationSpaceId,
      reservation.commandId,
      "accepted_fact",
      result.factId,
      result
    );
    return result;
  }

  private async authorize(
    tx: TenantDbTransaction,
    context: SecurityContext,
    action: AuthorizationAction,
    resource: ResourceRef,
    lockAuthority: boolean,
    options: { factLifecycleReplay?: boolean } = {}
  ): Promise<void> {
    const decision = await this.authorization.canInTransaction(context, action, resource, tx, {
      lockAuthority,
      ...options
    });
    if (!decision.allowed) throw new B2AuthorizationError();
  }
}

function toDurableTruthCommand(
  command: B2AuthorizedDomainCommand<DurableTruthCommandKind>
): DurableTruthCommand {
  if (
    command.kind === "fact.accept" ||
    command.kind === "initiative.primary_objective.withdraw" ||
    command.kind === "fact.supersede" ||
    command.kind === "fact.revoke"
  ) {
    return command;
  }
  const { valueJson, ...payload } = command.payload;
  return { ...command, payload: { ...payload, canonicalValue: valueJson } } as DurableTruthCommand;
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
      ...(safeRequestForCommand(command) === undefined
        ? {}
        : { safeRequest: safeRequestForCommand(command)! }),
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

function safeRequestForCommand(
  command: DurableTruthCommand
): Readonly<Record<string, unknown>> | undefined {
  if (command.kind === "fact.accept") return undefined;
  if (command.kind === "fact.revoke") {
    return {
      factId: command.payload.factId,
      expectedFactVersion: command.payload.expectedFactVersion,
      reason: command.payload.reason
    };
  }
  if (command.kind === "fact.supersede") {
    return {
      factId: command.payload.factId,
      expectedFactVersion: command.payload.expectedFactVersion,
      subject: command.payload.subject,
      replacementClaims: command.payload.replacementClaims,
      reason: command.payload.reason,
      ...(command.payload.confidenceLowering === undefined
        ? {}
        : { confidenceLowering: command.payload.confidenceLowering })
    };
  }
  const subject = {
    subjectType: command.payload.subject.type,
    subjectId: command.payload.subject.id,
    expectedSubjectVersion: command.payload.subject.expectedVersion
  };
  if (command.kind === "initiative.primary_objective.withdraw") {
    return {
      ...subject,
      predecessorClaimId: command.payload.proposal.claimId,
      expectedPredecessorVersion: command.payload.proposal.expectedVersion,
      disposition: command.payload.disposition,
      reasonCode: command.payload.reasonCode
    };
  }
  const evidence = command.payload.evidence;
  return {
    ...subject,
    ...(command.kind === "claim.create" && command.payload.expectedPrimaryObjectiveGeneration
      ? command.payload.expectedPrimaryObjectiveGeneration.kind === "empty"
        ? {
            expectedLatestClaimId: null,
            expectedLatestClaimStatus: null,
            expectedLatestClaimVersion: null
          }
        : {
            expectedLatestClaimId: command.payload.expectedPrimaryObjectiveGeneration.claimId,
            expectedLatestClaimStatus:
              command.payload.expectedPrimaryObjectiveGeneration.expectedStatus,
            expectedLatestClaimVersion:
              command.payload.expectedPrimaryObjectiveGeneration.expectedVersion
          }
      : {}),
    ...(command.kind === "initiative.primary_objective.rework"
      ? {
          predecessorClaimId: command.payload.predecessor.claimId,
          expectedPredecessorVersion: command.payload.predecessor.expectedVersion
        }
      : {}),
    predicate:
      command.kind === "claim.create" ? command.payload.predicate : "initiative.primary_objective",
    valueHash: createHash("sha256").update(command.payload.canonicalValue, "utf8").digest("hex"),
    sourceArtifactId: evidence.sourceArtifactId,
    sourceChunkId: evidence.sourceChunkId,
    expectedSourceVersion: evidence.expectedSourceVersion,
    expectedChunkVersion: evidence.expectedChunkVersion,
    normalizationVersion: evidence.normalizationVersion,
    chunkingVersion: evidence.chunkingVersion,
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
    sourceContentHash: evidence.sourceContentHash,
    sourceNormalizedContentHash: evidence.sourceNormalizedContentHash,
    chunkContentHash: evidence.chunkContentHash,
    excerptHash: evidence.excerptHash,
    supportConfirmed: command.payload.supportConfirmation?.confirmed === true
  };
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
  action:
    | "claim.create"
    | "initiative.primary_objective.withdraw"
    | "initiative.primary_objective.reject"
    | "initiative.primary_objective.rework"
    | "fact.accept"
    | "fact.supersede"
    | "fact.revoke";
  resourceType: "claim" | "accepted_fact";
  resourceId: string;
  eventType:
    | "claim.proposed"
    | "initiative.primary_objective.proposal_withdrawn"
    | "initiative.primary_objective.proposal_rejected"
    | "initiative.primary_objective.proposal_reworked"
    | "fact.accepted"
    | "fact.superseded"
    | "fact.revoked";
  aggregateType: "claim" | "accepted_fact";
  aggregateVersion: number;
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
