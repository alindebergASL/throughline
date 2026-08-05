import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { AccountOperationsDomainCommandBus } from "@throughline/account-operations";
import { PostgresAuthorizationService } from "@throughline/authorization";
import {
  ContentRepository,
  normalizeAndChunkSource,
  normalizeSourceText,
  sliceByScalarOffsets
} from "@throughline/content";
import {
  B2_TRUTH_PREDICATE_CATALOG_VERSION,
  maxAccessClass,
  normalizeStoredSourceText,
  type AccessClass,
  type SecurityContext
} from "@throughline/core-types";
import {
  createPgPool,
  type PgPool,
  type TenantDbTransaction,
  withTenantTransaction
} from "@throughline/db";
import { createDefaultProfileRegistry } from "@throughline/domain-profiles";
import { TruthLedgerDomainCommandBus } from "@throughline/truth-ledger";
import { createHash } from "node:crypto";
import {
  TrustedObjectiveConflictError,
  TrustedObjectiveUnavailableError,
  type TrustedObjectiveDraft,
  type TrustedObjectiveState
} from "./trusted-objective.contract.js";

const SOURCE_TITLE = "Engagement note";
const PREDICATE = "initiative.primary_objective" as const;

interface WorkflowScope {
  initiativeId: string;
  initiativeVersion: number;
  initiativeTitle: string;
  initiativeSpaceId: string;
  initiativeAccessClass: AccessClass;
  organizationId: string;
  organizationName: string;
  activityId: string;
  activityTitle: string;
}

interface CurrentSource {
  projection: Awaited<ReturnType<ContentRepository["getSource"]>>;
  createdAt: string;
}

interface ClaimEvidenceRow {
  claim_id: string;
  claim_version: number;
  claim_status: "proposed" | "accepted";
  canonical_value_text: string;
  normalized_text: string;
  predicate: string;
  claim_access_class: AccessClass;
  source_artifact_id: string;
  source_chunk_id: string;
  source_version: number;
  chunk_version: number;
  normalization_version: string;
  chunking_version: string;
  source_start_offset: number;
  source_end_offset: number;
  source_excerpt: string;
  source_content_hash: string;
  source_normalized_content_hash: string;
  chunk_content_hash: string;
  excerpt_hash: string;
  span_access_class: AccessClass;
  created_by_user_id: string;
  created_by_membership_id: string;
  support_attestation_id: string | null;
  attested_value_hash: string | null;
  attested_excerpt_hash: string | null;
}

interface ValidClaim {
  id: string;
  version: number;
  status: "proposed" | "accepted";
  objective: string;
  exactExcerpt: string;
  sourceTitle: string;
  accessClass: AccessClass;
  createdByUserId: string;
  createdByMembershipId: string;
  supportConfirmed: boolean;
}

interface PrimaryObjectiveClaimAnchor {
  id: string;
  version: number;
  status: "proposed" | "accepted" | "rejected" | "superseded";
}

type ProposalRecoveryOutcome = NonNullable<TrustedObjectiveState["lastProposalRecovery"]>;
type ReworkLineage = TrustedObjectiveState["reworkLineage"];
type AcceptedMemoryProjection = NonNullable<TrustedObjectiveState["acceptedMemory"]> & {
  supportingClaimId: string;
};

@Injectable()
export class TrustedObjectiveRuntime implements OnModuleDestroy {
  private pool?: PgPool;
  private authorization?: PostgresAuthorizationService;
  private accountBus?: AccountOperationsDomainCommandBus;
  private truthBus?: TruthLedgerDomainCommandBus;

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async getState(context: SecurityContext, initiativeId: string): Promise<TrustedObjectiveState> {
    return this.read(context, async (tx) => {
      const scope = await this.readScope(tx, context, initiativeId);
      const latestObjectiveClaim = await this.readLatestPrimaryObjectiveClaim(tx, context, scope);
      const proposalGenerationAnchor = primaryObjectiveGenerationAnchor(latestObjectiveClaim);
      const canAccept = await this.isAllowed(
        tx,
        context,
        "fact.accept",
        "initiative",
        initiativeId
      );
      const source = await this.readCurrentSource(tx, context, scope);
      if (!source)
        return stateFor(scope, null, null, null, canAccept, proposalGenerationAnchor, null);

      const accepted = await this.readAcceptedMemory(tx, context, scope, source);
      if (accepted) {
        const reworkLineage = await this.readReworkLineage(
          tx,
          context,
          scope,
          accepted.supportingClaimId
        );
        return stateFor(
          scope,
          source,
          null,
          accepted,
          canAccept,
          proposalGenerationAnchor,
          null,
          false,
          false,
          false,
          reworkLineage
        );
      }
      if (await this.readOnlyValidClaim(tx, context, scope, source, "accepted")) {
        throw new TrustedObjectiveUnavailableError();
      }

      const proposal = await this.readOnlyValidClaim(tx, context, scope, source, "proposed");
      let canRework = false;
      let canWithdraw = false;
      let canReject = false;
      if (proposal) {
        canRework = await this.isAllowed(
          tx,
          context,
          "initiative.primary_objective.proposal.rework",
          "claim",
          proposal.id
        );
        canWithdraw = await this.isAllowed(
          tx,
          context,
          "initiative.primary_objective.proposal.withdraw",
          "claim",
          proposal.id
        );
        canReject = await this.isAllowed(
          tx,
          context,
          "initiative.primary_objective.proposal.reject",
          "claim",
          proposal.id
        );
      }
      const lastProposalRecovery = proposal
        ? null
        : await this.readLatestProposalRecovery(tx, context, scope);
      const reworkLineage = proposal
        ? await this.readReworkLineage(tx, context, scope, proposal.id)
        : [];
      return stateFor(
        scope,
        source,
        proposal,
        null,
        canAccept,
        proposalGenerationAnchor,
        lastProposalRecovery,
        canRework,
        canWithdraw,
        canReject,
        reworkLineage
      );
    });
  }

  async capture(
    context: SecurityContext,
    initiativeId: string,
    note: string
  ): Promise<TrustedObjectiveState> {
    const scope = await this.read(context, (tx) => this.readScope(tx, context, initiativeId));
    const normalized = normalizeSourceText(note).normalizedText;
    const existing = await this.read(context, (tx) => this.readCurrentSource(tx, context, scope));
    if (
      existing &&
      normalizeSourceText(existing.projection.immutableText!).normalizedText !== normalized
    ) {
      throw new TrustedObjectiveConflictError();
    }
    await this.accountCommandBus().execute(
      {
        kind: "source.capture",
        idempotencyKey: stableKey(
          "capture",
          context.tenantId,
          context.workspaceId,
          scope.initiativeId,
          scope.activityId
        ),
        payload: {
          activityId: scope.activityId,
          sourceType: "note",
          title: SOURCE_TITLE,
          text: normalized
        }
      },
      context
    );
    return this.getState(context, initiativeId);
  }

  async propose(
    context: SecurityContext,
    initiativeId: string,
    input: {
      objective: string;
      exactExcerpt: string;
      supportConfirmed: true;
      proposalGenerationAnchor: string;
      sourceRevisionAnchor: string;
    }
  ): Promise<TrustedObjectiveState> {
    const objective = input.objective.normalize("NFC").trim();
    const exactExcerpt = normalizeStoredSourceText(input.exactExcerpt);
    const prepared = await this.read(context, async (tx) => {
      const scope = await this.readScope(tx, context, initiativeId);
      const source = await this.requireCurrentSource(tx, context, scope);
      if (input.sourceRevisionAnchor !== primaryObjectiveSourceRevisionAnchor(source.projection)) {
        throw new TrustedObjectiveConflictError();
      }
      const accepted = await this.readAcceptedMemory(tx, context, scope, source);
      if (accepted) {
        if (accepted.objective === objective && accepted.exactExcerpt === exactExcerpt) return null;
        throw new TrustedObjectiveConflictError();
      }
      if (await this.readOnlyValidClaim(tx, context, scope, source, "accepted")) {
        throw new TrustedObjectiveUnavailableError();
      }
      const latestObjectiveClaim = await this.readLatestPrimaryObjectiveClaim(tx, context, scope);
      const existing = await this.readOnlyValidClaim(tx, context, scope, source, "proposed");
      if (existing) {
        const priorClaim = await this.readPrimaryObjectiveClaimBefore(
          tx,
          context,
          scope,
          existing.id
        );
        if (
          existing.objective === objective &&
          existing.exactExcerpt === exactExcerpt &&
          input.proposalGenerationAnchor === primaryObjectiveGenerationAnchor(priorClaim)
        ) {
          return null;
        }
        throw new TrustedObjectiveConflictError();
      }
      if (
        input.proposalGenerationAnchor !== primaryObjectiveGenerationAnchor(latestObjectiveClaim)
      ) {
        throw new TrustedObjectiveConflictError();
      }
      const evidence = deriveEvidenceCandidate(source.projection, exactExcerpt);
      return {
        scope,
        evidence,
        expectedPrimaryObjectiveGeneration:
          primaryObjectiveGenerationCoordinate(latestObjectiveClaim)
      };
    });
    if (prepared) {
      await this.truthCommandBus().execute(
        {
          kind: "claim.create",
          idempotencyKey: primaryObjectiveProposalKey(
            initiativeId,
            objective,
            prepared.evidence,
            input.proposalGenerationAnchor,
            input.sourceRevisionAnchor
          ),
          predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
          payload: {
            subject: {
              type: "initiative",
              id: initiativeId,
              expectedVersion: prepared.scope.initiativeVersion
            },
            predicate: PREDICATE,
            valueJson: objective,
            normalizedText: objective,
            confidence: "strong",
            evidence: prepared.evidence,
            supportConfirmation: { confirmed: input.supportConfirmed },
            expectedPrimaryObjectiveGeneration: prepared.expectedPrimaryObjectiveGeneration
          }
        },
        context
      );
    }
    return this.getState(context, initiativeId);
  }

  async withdraw(
    context: SecurityContext,
    initiativeId: string,
    input: {
      claimId: string;
      expectedClaimVersion: 1;
      expectedInitiativeVersion: number;
      disposition: "withdrawn" | "rejected";
      reasonCode:
        | "needs_rework"
        | "unsupported"
        | "incorrect"
        | "duplicate"
        | "not_useful"
        | "sensitive"
        | "other";
    }
  ): Promise<TrustedObjectiveState> {
    await this.truthCommandBus().execute(
      {
        kind: "initiative.primary_objective.withdraw",
        idempotencyKey: stableKey(
          "withdraw",
          initiativeId,
          input.claimId,
          String(input.expectedClaimVersion),
          String(input.expectedInitiativeVersion),
          input.disposition,
          input.reasonCode
        ),
        predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
        payload: {
          subject: {
            type: "initiative",
            id: initiativeId,
            expectedVersion: input.expectedInitiativeVersion
          },
          proposal: {
            claimId: input.claimId,
            expectedVersion: input.expectedClaimVersion
          },
          disposition: input.disposition,
          reasonCode: input.reasonCode
        }
      },
      context
    );
    return this.getState(context, initiativeId);
  }

  async rework(
    context: SecurityContext,
    initiativeId: string,
    input: {
      claimId: string;
      expectedClaimVersion: number;
      expectedInitiativeVersion: number;
      objective: string;
      exactExcerpt: string;
      supportConfirmed: true;
      sourceRevisionAnchor: string;
    }
  ): Promise<TrustedObjectiveState> {
    const objective = input.objective.normalize("NFC").trim();
    const exactExcerpt = normalizeStoredSourceText(input.exactExcerpt);
    const source = await this.read(context, async (tx) => {
      const scope = await this.readScope(tx, context, initiativeId);
      if (scope.initiativeVersion !== input.expectedInitiativeVersion) {
        throw new TrustedObjectiveConflictError();
      }
      const currentSource = await this.requireCurrentSource(tx, context, scope);
      if (
        input.sourceRevisionAnchor !==
        primaryObjectiveSourceRevisionAnchor(currentSource.projection)
      ) {
        throw new TrustedObjectiveConflictError();
      }
      return currentSource;
    });
    const evidence = deriveEvidenceCandidate(source.projection, exactExcerpt);
    await this.truthCommandBus().execute(
      {
        kind: "initiative.primary_objective.rework",
        idempotencyKey: stableKey(
          "rework",
          initiativeId,
          input.claimId,
          String(input.expectedClaimVersion),
          String(input.expectedInitiativeVersion),
          input.sourceRevisionAnchor,
          objective,
          evidence.sourceArtifactId,
          evidence.sourceChunkId,
          String(evidence.startOffset),
          String(evidence.endOffset)
        ),
        predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
        payload: {
          subject: {
            type: "initiative",
            id: initiativeId,
            expectedVersion: input.expectedInitiativeVersion
          },
          predecessor: {
            claimId: input.claimId,
            expectedVersion: input.expectedClaimVersion
          },
          valueJson: objective,
          normalizedText: objective,
          confidence: "strong",
          evidence,
          supportConfirmation: { confirmed: input.supportConfirmed }
        }
      },
      context
    );
    return this.getState(context, initiativeId);
  }

  async accept(
    context: SecurityContext,
    initiativeId: string,
    input: {
      claimId: string;
      expectedClaimVersion: 1;
      expectedInitiativeVersion: number;
    }
  ): Promise<TrustedObjectiveState> {
    const prepared = await this.read(context, async (tx) => {
      const scope = await this.readScope(tx, context, initiativeId);
      if (scope.initiativeVersion !== input.expectedInitiativeVersion) {
        throw new TrustedObjectiveConflictError();
      }
      const source = await this.requireCurrentSource(tx, context, scope);
      if (await this.readAcceptedMemory(tx, context, scope, source)) {
        const acceptedClaim = await this.readOnlyValidClaim(tx, context, scope, source, "accepted");
        if (
          acceptedClaim?.id === input.claimId &&
          acceptedClaim.version === input.expectedClaimVersion + 1
        ) {
          return null;
        }
        throw new TrustedObjectiveConflictError();
      }
      if (await this.readOnlyValidClaim(tx, context, scope, source, "accepted")) {
        throw new TrustedObjectiveUnavailableError();
      }
      const claim = await this.readOnlyValidClaim(tx, context, scope, source, "proposed");
      if (!claim || claim.id !== input.claimId || claim.version !== input.expectedClaimVersion) {
        throw new TrustedObjectiveConflictError();
      }
      return { scope, claim };
    });
    if (prepared) {
      await this.truthCommandBus().execute(
        {
          kind: "fact.accept",
          idempotencyKey: stableKey(
            "accept",
            initiativeId,
            input.claimId,
            String(input.expectedClaimVersion),
            String(input.expectedInitiativeVersion)
          ),
          predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
          payload: {
            subject: {
              type: "initiative",
              id: initiativeId,
              expectedVersion: input.expectedInitiativeVersion
            },
            claims: [{ claimId: input.claimId, expectedVersion: input.expectedClaimVersion }],
            expectedCurrentFactId: null,
            acceptanceScope: "initiative"
          }
        },
        context
      );
    }
    return this.getState(context, initiativeId);
  }

  async draftConfirmation(
    context: SecurityContext,
    initiativeId: string
  ): Promise<TrustedObjectiveDraft> {
    const state = await this.getState(context, initiativeId);
    if (!state.acceptedMemory) throw new TrustedObjectiveConflictError();
    return {
      question: `Can you confirm that our primary objective is: “${state.acceptedMemory.objective}”?`,
      sent: false,
      status: "Not sent"
    };
  }

  private async readScope(
    tx: TenantDbTransaction,
    context: SecurityContext,
    initiativeId: string
  ): Promise<WorkflowScope> {
    await this.requireAllowed(tx, context, "initiative.read", "initiative", initiativeId);
    const initiative = await tx.query<{
      id: string;
      title: string;
      space_id: string;
      version: number;
      access_class: AccessClass;
    }>(
      `SELECT initiative.id, initiative.title, initiative.space_id, initiative.version,
              space.access_class
       FROM work.initiatives initiative
       JOIN access.spaces space ON space.tenant_id = initiative.tenant_id
         AND space.workspace_id = initiative.workspace_id AND space.id = initiative.space_id
       WHERE initiative.tenant_id = $1 AND initiative.workspace_id = $2
         AND initiative.id = $3 AND space.archived_at IS NULL LIMIT 1`,
      [context.tenantId, context.workspaceId, initiativeId]
    );
    const initiativeRow = initiative.rows[0];
    if (!initiativeRow) throw new TrustedObjectiveUnavailableError();

    const activities = await tx.query<{ id: string; title: string }>(
      `SELECT id, title FROM work.activities
       WHERE tenant_id = $1 AND workspace_id = $2 AND governing_initiative_id = $3
         AND status <> 'cancelled' ORDER BY created_at, id LIMIT 2`,
      [context.tenantId, context.workspaceId, initiativeId]
    );
    if (activities.rows.length !== 1) throw new TrustedObjectiveUnavailableError();
    const activityRow = activities.rows[0]!;
    await this.requireAllowed(tx, context, "activity.read", "activity", activityRow.id);

    const organizations = await tx.query<{ id: string }>(
      `SELECT organization_id AS id FROM work.initiative_organizations
       WHERE tenant_id = $1 AND workspace_id = $2 AND initiative_id = $3
         AND association_role = 'primary' AND ended_at IS NULL LIMIT 2`,
      [context.tenantId, context.workspaceId, initiativeId]
    );
    if (organizations.rows.length !== 1) throw new TrustedObjectiveUnavailableError();
    const organizationId = organizations.rows[0]!.id;
    await this.requireAllowed(tx, context, "organization.read", "organization", organizationId);
    const organization = await tx.query<{ name: string }>(
      `SELECT name FROM work.organizations
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active' LIMIT 1`,
      [context.tenantId, context.workspaceId, organizationId]
    );
    if (!organization.rows[0]) throw new TrustedObjectiveUnavailableError();
    return {
      initiativeId,
      initiativeVersion: initiativeRow.version,
      initiativeTitle: initiativeRow.title,
      initiativeSpaceId: initiativeRow.space_id,
      initiativeAccessClass: initiativeRow.access_class,
      organizationId,
      organizationName: organization.rows[0].name,
      activityId: activityRow.id,
      activityTitle: activityRow.title
    };
  }

  private async readCurrentSource(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope
  ): Promise<CurrentSource | null> {
    const candidates = await tx.query<{ id: string; created_at: Date }>(
      `SELECT source.id, source.created_at
       FROM work.activity_sources link
       JOIN content.source_artifacts source ON source.tenant_id = link.tenant_id
         AND source.workspace_id = link.workspace_id AND source.space_id = link.space_id
         AND source.id = link.source_artifact_id
       WHERE link.tenant_id = $1 AND link.workspace_id = $2 AND link.activity_id = $3
         AND source.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM content.source_artifacts successor
           WHERE successor.tenant_id = source.tenant_id
             AND successor.workspace_id = source.workspace_id
             AND successor.supersedes_source_id = source.id)
       ORDER BY source.created_at, source.id LIMIT 2`,
      [context.tenantId, context.workspaceId, scope.activityId]
    );
    if (candidates.rows.length === 0) return null;
    if (candidates.rows.length !== 1) throw new TrustedObjectiveConflictError();
    const candidate = candidates.rows[0]!;
    await this.requireAllowed(tx, context, "source.read", "source", candidate.id);
    const projection = await new ContentRepository(tx).getSource(
      context.tenantId,
      context.workspaceId,
      candidate.id,
      true
    );
    if (
      !projection.immutableText ||
      projection.deletedAt ||
      projection.spaceId !== scope.initiativeSpaceId
    ) {
      throw new TrustedObjectiveUnavailableError();
    }
    return { projection, createdAt: candidate.created_at.toISOString() };
  }

  private async requireCurrentSource(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope
  ): Promise<CurrentSource> {
    const source = await this.readCurrentSource(tx, context, scope);
    if (!source) throw new TrustedObjectiveConflictError();
    return source;
  }

  private async readOnlyValidClaim(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope,
    source: CurrentSource,
    status: "proposed" | "accepted"
  ): Promise<ValidClaim | null> {
    const candidates = await tx.query<{ id: string }>(
      `SELECT id FROM truth.claims
       WHERE tenant_id = $1 AND workspace_id = $2 AND subject_type = 'initiative'
         AND subject_id = $3 AND predicate = $4 AND status = $5
       ORDER BY created_at, id LIMIT 2`,
      [context.tenantId, context.workspaceId, scope.initiativeId, PREDICATE, status]
    );
    if (candidates.rows.length === 0) return null;
    if (candidates.rows.length !== 1) throw new TrustedObjectiveConflictError();
    return this.readValidClaim(tx, context, scope, source, candidates.rows[0]!.id, status);
  }

  private async readLatestPrimaryObjectiveClaim(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope
  ): Promise<PrimaryObjectiveClaimAnchor | null> {
    const result = await tx.query<{
      id: string;
      version: number;
      status: PrimaryObjectiveClaimAnchor["status"];
    }>(
      `SELECT id, version, status
       FROM truth.claims
       WHERE tenant_id = $1 AND workspace_id = $2 AND subject_type = 'initiative'
         AND subject_id = $3 AND predicate = $4
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [context.tenantId, context.workspaceId, scope.initiativeId, PREDICATE]
    );
    return result.rows[0] ?? null;
  }

  private async readPrimaryObjectiveClaimBefore(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope,
    claimId: string
  ): Promise<PrimaryObjectiveClaimAnchor | null> {
    const result = await tx.query<{
      id: string;
      version: number;
      status: PrimaryObjectiveClaimAnchor["status"];
    }>(
      `SELECT prior.id, prior.version, prior.status
       FROM truth.claims current_claim
       JOIN LATERAL (
         SELECT claim.id, claim.version, claim.status
         FROM truth.claims claim
         WHERE claim.tenant_id = current_claim.tenant_id
           AND claim.workspace_id = current_claim.workspace_id
           AND claim.subject_type = current_claim.subject_type
           AND claim.subject_id = current_claim.subject_id
           AND claim.predicate = current_claim.predicate
           AND (claim.created_at, claim.id) < (current_claim.created_at, current_claim.id)
         ORDER BY claim.created_at DESC, claim.id DESC LIMIT 1
       ) prior ON true
       WHERE current_claim.tenant_id = $1 AND current_claim.workspace_id = $2
         AND current_claim.id = $3 AND current_claim.subject_type = 'initiative'
         AND current_claim.subject_id = $4 AND current_claim.predicate = $5`,
      [context.tenantId, context.workspaceId, claimId, scope.initiativeId, PREDICATE]
    );
    return result.rows[0] ?? null;
  }

  private async readLatestProposalRecovery(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope
  ): Promise<ProposalRecoveryOutcome | null> {
    const result = await tx.query<{
      claim_id: string;
      recovery_id: string;
      disposition: "withdrawn" | "rejected";
      reason_code: ProposalRecoveryOutcome["reasonCode"];
    }>(
      `SELECT recovery.predecessor_claim_id AS claim_id, recovery.id AS recovery_id,
              recovery.disposition, recovery.reason_code
       FROM truth.initiative_objective_proposal_recoveries recovery
       WHERE recovery.tenant_id = $1 AND recovery.workspace_id = $2
         AND recovery.initiative_id = $3
         AND recovery.disposition IN ('withdrawn','rejected')
       ORDER BY recovery.created_at DESC, recovery.id DESC LIMIT 1`,
      [context.tenantId, context.workspaceId, scope.initiativeId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const decision = await this.authorizationService().canInTransaction(
      context,
      "claim.read",
      { type: "claim", id: row.claim_id },
      tx,
      { lockAuthority: true }
    );
    if (!decision.allowed) return null;
    return {
      claimId: row.claim_id,
      recoveryId: row.recovery_id,
      disposition: row.disposition,
      reasonCode: row.reason_code
    };
  }

  private async readReworkLineage(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope,
    currentClaimId: string
  ): Promise<ReworkLineage> {
    const result = await tx.query<{
      predecessor_claim_id: string;
      successor_claim_id: string;
      disposition: "reworked";
      reason_code: "reworked";
      reworked_at: Date;
    }>(
      `WITH RECURSIVE objective_lineage AS (
         SELECT recovery.predecessor_claim_id, recovery.successor_claim_id,
                recovery.disposition, recovery.reason_code,
                recovery.created_at AS reworked_at, recovery.id, 1 AS depth
         FROM truth.initiative_objective_proposal_recoveries recovery
         WHERE recovery.tenant_id = $1 AND recovery.workspace_id = $2
           AND recovery.initiative_id = $3 AND recovery.disposition = 'reworked'
           AND recovery.successor_claim_id = $4
         UNION ALL
         SELECT recovery.predecessor_claim_id, recovery.successor_claim_id,
                recovery.disposition, recovery.reason_code,
                recovery.created_at AS reworked_at, recovery.id, lineage.depth + 1
         FROM truth.initiative_objective_proposal_recoveries recovery
         JOIN objective_lineage lineage
           ON lineage.predecessor_claim_id = recovery.successor_claim_id
         WHERE recovery.tenant_id = $1 AND recovery.workspace_id = $2
           AND recovery.initiative_id = $3 AND recovery.disposition = 'reworked'
           AND lineage.depth < 20
       )
       SELECT predecessor_claim_id, successor_claim_id, disposition, reason_code, reworked_at
       FROM objective_lineage ORDER BY reworked_at, id LIMIT 20`,
      [context.tenantId, context.workspaceId, scope.initiativeId, currentClaimId]
    );
    const claimIds = [
      ...new Set(
        result.rows.flatMap(({ predecessor_claim_id, successor_claim_id }) => [
          predecessor_claim_id,
          successor_claim_id
        ])
      )
    ];
    for (const claimId of claimIds) {
      const decision = await this.authorizationService().canInTransaction(
        context,
        "claim.read",
        { type: "claim", id: claimId },
        tx,
        { lockAuthority: true }
      );
      if (!decision.allowed) throw new TrustedObjectiveUnavailableError();
    }
    return result.rows.map((row) => ({
      predecessorClaimId: row.predecessor_claim_id,
      successorClaimId: row.successor_claim_id,
      disposition: row.disposition,
      reasonCode: row.reason_code,
      reworkedAt: row.reworked_at.toISOString()
    }));
  }

  private async readValidClaim(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope,
    source: CurrentSource,
    claimId: string,
    status: "proposed" | "accepted"
  ): Promise<ValidClaim | null> {
    const decision = await this.authorizationService().canInTransaction(
      context,
      "claim.read",
      { type: "claim", id: claimId },
      tx,
      { lockAuthority: true }
    );
    if (!decision.allowed) return null;
    const result = await tx.query<ClaimEvidenceRow>(
      `SELECT claim.id AS claim_id, claim.version AS claim_version,
              claim.status AS claim_status, claim.canonical_value_text,
              claim.normalized_text, claim.predicate,
              claim.access_class AS claim_access_class,
              span.source_artifact_id, span.source_chunk_id, span.source_version,
              span.chunk_version, span.normalization_version, span.chunking_version,
              span.source_start_offset, span.source_end_offset, span.source_excerpt,
              span.source_content_hash, span.source_normalized_content_hash,
              span.chunk_content_hash, span.excerpt_hash,
              span.access_class AS span_access_class,
              claim.created_by_user_id, claim.created_by_membership_id,
              attestation.id AS support_attestation_id,
              attestation.objective_value_hash AS attested_value_hash,
              attestation.excerpt_hash AS attested_excerpt_hash
       FROM truth.claims claim
       JOIN truth.verified_evidence_spans span ON span.tenant_id = claim.tenant_id
         AND span.workspace_id = claim.workspace_id AND span.space_id = claim.space_id
         AND span.id = claim.verified_evidence_span_id
       LEFT JOIN truth.initiative_objective_support_attestations attestation
         ON attestation.tenant_id = claim.tenant_id
        AND attestation.workspace_id = claim.workspace_id
        AND attestation.space_id = claim.space_id
        AND attestation.claim_id = claim.id
       WHERE claim.tenant_id = $1 AND claim.workspace_id = $2 AND claim.id = $3 LIMIT 1`,
      [context.tenantId, context.workspaceId, claimId]
    );
    const row = result.rows[0];
    if (!row || row.claim_status !== status || !validEvidenceRow(row, source, scope)) return null;
    return {
      id: row.claim_id,
      version: row.claim_version,
      status: row.claim_status,
      objective: row.canonical_value_text,
      exactExcerpt: row.source_excerpt,
      sourceTitle: source.projection.title ?? SOURCE_TITLE,
      accessClass: row.claim_access_class,
      createdByUserId: row.created_by_user_id,
      createdByMembershipId: row.created_by_membership_id,
      supportConfirmed:
        row.support_attestation_id !== null &&
        row.attested_value_hash === sha256(row.canonical_value_text) &&
        row.attested_excerpt_hash === row.excerpt_hash
    };
  }

  private async readAcceptedMemory(
    tx: TenantDbTransaction,
    context: SecurityContext,
    scope: WorkflowScope,
    source: CurrentSource
  ): Promise<AcceptedMemoryProjection | null> {
    const candidates = await tx.query<{ id: string }>(
      `SELECT id FROM truth.accepted_facts
       WHERE tenant_id = $1 AND workspace_id = $2 AND subject_type = 'initiative'
         AND subject_id = $3 AND predicate = $4 AND status = 'current' LIMIT 2`,
      [context.tenantId, context.workspaceId, scope.initiativeId, PREDICATE]
    );
    if (candidates.rows.length === 0) return null;
    if (candidates.rows.length !== 1) throw new TrustedObjectiveUnavailableError();
    const factId = candidates.rows[0]!.id;
    const factDecision = await this.authorizationService().canInTransaction(
      context,
      "fact.read",
      { type: "fact", id: factId },
      tx,
      { lockAuthority: true }
    );
    if (!factDecision.allowed) throw new TrustedObjectiveUnavailableError();
    const fact = await tx.query<{
      canonical_value_text: string;
      normalized_text: string;
      access_class: AccessClass;
      accepted_by_membership_id: string;
      accepted_at: Date;
    }>(
      `SELECT canonical_value_text, normalized_text, access_class,
              accepted_by_membership_id, recorded_at AS accepted_at
       FROM truth.accepted_facts
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'current' LIMIT 1`,
      [context.tenantId, context.workspaceId, factId]
    );
    const factRow = fact.rows[0];
    if (!factRow || factRow.canonical_value_text !== factRow.normalized_text) {
      throw new TrustedObjectiveUnavailableError();
    }
    const supports = await tx.query<{ claim_id: string }>(
      `SELECT claim_id FROM truth.fact_claims
       WHERE tenant_id = $1 AND workspace_id = $2 AND fact_id = $3 ORDER BY claim_id`,
      [context.tenantId, context.workspaceId, factId]
    );
    if (supports.rows.length !== 1) throw new TrustedObjectiveUnavailableError();
    const claim = await this.readValidClaim(
      tx,
      context,
      scope,
      source,
      supports.rows[0]!.claim_id,
      "accepted"
    );
    if (
      !claim ||
      claim.objective !== factRow.canonical_value_text ||
      factRow.access_class !== maxAccessClass(claim.accessClass, scope.initiativeAccessClass)
    ) {
      throw new TrustedObjectiveUnavailableError();
    }
    const actor = await tx.query<{ person_id: string; display_name: string }>(
      `SELECT membership.person_id, person.display_name
       FROM identity.memberships membership
       JOIN identity.people person ON person.tenant_id = membership.tenant_id
         AND person.workspace_id = membership.workspace_id AND person.id = membership.person_id
       WHERE membership.tenant_id = $1 AND membership.workspace_id = $2
         AND membership.id = $3 AND membership.status = 'active' LIMIT 1`,
      [context.tenantId, context.workspaceId, factRow.accepted_by_membership_id]
    );
    const actorRow = actor.rows[0];
    if (!actorRow) throw new TrustedObjectiveUnavailableError();
    const actorDecision = await this.authorizationService().canInTransaction(
      context,
      "person.read",
      { type: "person", id: actorRow.person_id },
      tx,
      { personUseSite: { type: "initiative", id: scope.initiativeId }, lockAuthority: true }
    );
    if (!actorDecision.allowed) throw new TrustedObjectiveUnavailableError();
    return {
      supportingClaimId: claim.id,
      objective: factRow.canonical_value_text,
      status: "Accepted",
      exactExcerpt: claim.exactExcerpt,
      sourceTitle: claim.sourceTitle,
      whyBelieved:
        "Accepted because the selected engagement excerpt directly supports this objective.",
      transition: "Proposed → Accepted",
      acceptedBy: actorRow.display_name,
      acceptedAt: factRow.accepted_at.toISOString(),
      effectiveVisibility: visibilityLabel(factRow.access_class)
    };
  }

  private async requireAllowed(
    tx: TenantDbTransaction,
    context: SecurityContext,
    action: "initiative.read" | "activity.read" | "organization.read" | "source.read",
    type: "initiative" | "activity" | "organization" | "source",
    id: string
  ): Promise<void> {
    const decision = await this.authorizationService().canInTransaction(
      context,
      action,
      { type, id },
      tx,
      { lockAuthority: true }
    );
    if (!decision.allowed) throw new TrustedObjectiveUnavailableError();
  }

  private async isAllowed(
    tx: TenantDbTransaction,
    context: SecurityContext,
    action:
      | "fact.accept"
      | "initiative.primary_objective.proposal.withdraw"
      | "initiative.primary_objective.proposal.reject"
      | "initiative.primary_objective.proposal.rework",
    type: "initiative" | "claim",
    id: string
  ): Promise<boolean> {
    const decision = await this.authorizationService().canInTransaction(
      context,
      action,
      { type, id },
      tx,
      { lockAuthority: true }
    );
    return decision.allowed;
  }

  private read<T>(
    context: SecurityContext,
    callback: (tx: TenantDbTransaction) => Promise<T>
  ): Promise<T> {
    return withTenantTransaction({ pool: this.databasePool(), context }, async (tx) => {
      const role = await tx.query<{ current_user: string }>("SELECT current_user AS current_user");
      if (role.rows[0]?.current_user !== "throughline_app") {
        throw new TrustedObjectiveUnavailableError();
      }
      return callback(tx);
    });
  }

  private databasePool(): PgPool {
    this.pool ??= createPgPool();
    return this.pool;
  }

  private authorizationService(): PostgresAuthorizationService {
    this.authorization ??= new PostgresAuthorizationService(this.databasePool());
    return this.authorization;
  }

  private accountCommandBus(): AccountOperationsDomainCommandBus {
    this.accountBus ??= new AccountOperationsDomainCommandBus(
      this.databasePool(),
      this.authorizationService(),
      createDefaultProfileRegistry()
    );
    return this.accountBus;
  }

  private truthCommandBus(): TruthLedgerDomainCommandBus {
    this.truthBus ??= new TruthLedgerDomainCommandBus(
      this.databasePool(),
      this.authorizationService()
    );
    return this.truthBus;
  }
}

export function stableKey(kind: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([kind, ...parts]), "utf8")
    .digest("hex");
  return `trusted-objective:${kind}:${digest}`;
}

export function primaryObjectiveProposalKey(
  initiativeId: string,
  objective: string,
  evidence: {
    sourceArtifactId: string;
    sourceChunkId: string;
    startOffset: number;
    endOffset: number;
  },
  proposalGenerationAnchor: string,
  sourceRevisionAnchor: string
): string {
  return stableKey(
    "propose",
    initiativeId,
    proposalGenerationAnchor,
    sourceRevisionAnchor,
    objective,
    evidence.sourceArtifactId,
    evidence.sourceChunkId,
    String(evidence.startOffset),
    String(evidence.endOffset)
  );
}

export function primaryObjectiveSourceRevisionAnchor(
  source: Awaited<ReturnType<ContentRepository["getSource"]>>
): string {
  if (
    !source.immutableText ||
    !source.contentHash ||
    !source.normalizedContentHash ||
    source.deletedAt ||
    source.chunks.length === 0
  ) {
    throw new TrustedObjectiveConflictError();
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        source.id,
        source.spaceId,
        source.version,
        source.accessClass,
        source.contentHash,
        source.normalizedContentHash,
        "source-normalization.v1",
        "source-chunking.v1",
        source.chunks.map((chunk) => [
          chunk.id,
          1,
          chunk.chunkIndex,
          chunk.startOffset,
          chunk.endOffset,
          chunk.contentHash,
          chunk.accessClass
        ])
      ]),
      "utf8"
    )
    .digest("hex");
  return `trusted-objective:source-revision:${digest}`;
}

export function primaryObjectiveGenerationAnchor(
  latestObjectiveClaim: PrimaryObjectiveClaimAnchor | null
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        latestObjectiveClaim
          ? [latestObjectiveClaim.id, latestObjectiveClaim.version, latestObjectiveClaim.status]
          : ["empty"]
      ),
      "utf8"
    )
    .digest("hex");
  return `trusted-objective:proposal-generation:${digest}`;
}

function primaryObjectiveGenerationCoordinate(
  latestObjectiveClaim: PrimaryObjectiveClaimAnchor | null
):
  | { kind: "empty" }
  | {
      kind: "claim";
      claimId: string;
      expectedVersion: number;
      expectedStatus: PrimaryObjectiveClaimAnchor["status"];
    } {
  return latestObjectiveClaim
    ? {
        kind: "claim",
        claimId: latestObjectiveClaim.id,
        expectedVersion: latestObjectiveClaim.version,
        expectedStatus: latestObjectiveClaim.status
      }
    : { kind: "empty" };
}

export function deriveEvidenceCandidate(
  source: Awaited<ReturnType<ContentRepository["getSource"]>>,
  exactExcerpt: string
) {
  if (
    !source.immutableText ||
    !source.contentHash ||
    !source.normalizedContentHash ||
    source.deletedAt
  ) {
    throw new TrustedObjectiveConflictError();
  }
  const matches: Array<{ chunk: (typeof source.chunks)[number]; start: number; end: number }> = [];
  const excerptScalars = Array.from(exactExcerpt);
  for (const chunk of source.chunks) {
    const chunkScalars = Array.from(chunk.normalizedText);
    for (let index = 0; index <= chunkScalars.length - excerptScalars.length; index += 1) {
      if (excerptScalars.every((scalar, offset) => chunkScalars[index + offset] === scalar)) {
        matches.push({ chunk, start: index, end: index + excerptScalars.length });
      }
    }
  }
  if (matches.length !== 1) throw new TrustedObjectiveConflictError();
  const match = matches[0]!;
  return {
    sourceArtifactId: source.id,
    sourceChunkId: match.chunk.id,
    expectedSourceVersion: source.version,
    expectedChunkVersion: 1 as const,
    normalizationVersion: "source-normalization.v1" as const,
    chunkingVersion: "source-chunking.v1" as const,
    startOffset: match.start,
    endOffset: match.end,
    excerpt: exactExcerpt,
    sourceContentHash: source.contentHash,
    sourceNormalizedContentHash: source.normalizedContentHash,
    chunkContentHash: match.chunk.contentHash,
    excerptHash: sha256(exactExcerpt)
  };
}

function validEvidenceRow(
  row: ClaimEvidenceRow,
  source: CurrentSource,
  scope: WorkflowScope
): boolean {
  try {
    const projection = source.projection;
    if (
      !projection.immutableText ||
      !projection.contentHash ||
      !projection.normalizedContentHash ||
      projection.id !== row.source_artifact_id ||
      projection.version !== row.source_version ||
      row.chunk_version !== 1 ||
      row.normalization_version !== "source-normalization.v1" ||
      row.chunking_version !== "source-chunking.v1" ||
      row.predicate !== PREDICATE ||
      row.canonical_value_text !== row.normalized_text ||
      row.claim_access_class !==
        maxAccessClass(projection.accessClass, scope.initiativeAccessClass) ||
      row.span_access_class !== row.claim_access_class
    ) {
      return false;
    }
    const normalized = normalizeAndChunkSource(projection.immutableText);
    if (
      normalized.source.contentHash !== projection.contentHash ||
      normalized.source.normalizedContentHash !== projection.normalizedContentHash ||
      normalized.chunks.length !== projection.chunks.length
    ) {
      return false;
    }
    for (const [index, expected] of normalized.chunks.entries()) {
      const stored = projection.chunks[index];
      if (
        !stored ||
        stored.chunkIndex !== expected.chunkIndex ||
        stored.startOffset !== expected.startOffset ||
        stored.endOffset !== expected.endOffset ||
        stored.normalizedText !== expected.normalizedText ||
        stored.contentHash !== expected.contentHash
      ) {
        return false;
      }
    }
    const chunk = projection.chunks.find(({ id }) => id === row.source_chunk_id);
    if (!chunk || chunk.contentHash !== row.chunk_content_hash) return false;
    const excerpt = sliceByScalarOffsets(
      chunk.normalizedText,
      row.source_start_offset,
      row.source_end_offset
    );
    return (
      excerpt === row.source_excerpt &&
      sha256(excerpt) === row.excerpt_hash &&
      row.source_content_hash === projection.contentHash &&
      row.source_normalized_content_hash === projection.normalizedContentHash
    );
  } catch {
    return false;
  }
}

function stateFor(
  scope: WorkflowScope,
  source: CurrentSource | null,
  proposal: ValidClaim | null,
  acceptedMemory: AcceptedMemoryProjection | null,
  canAccept: boolean,
  proposalGenerationAnchor: string,
  lastProposalRecovery: ProposalRecoveryOutcome | null,
  canRework = false,
  canWithdraw = false,
  canReject = false,
  reworkLineage: ReworkLineage = []
): TrustedObjectiveState {
  const acceptedProjection = acceptedMemory
    ? {
        objective: acceptedMemory.objective,
        status: acceptedMemory.status,
        exactExcerpt: acceptedMemory.exactExcerpt,
        sourceTitle: acceptedMemory.sourceTitle,
        whyBelieved: acceptedMemory.whyBelieved,
        transition: acceptedMemory.transition,
        acceptedBy: acceptedMemory.acceptedBy,
        acceptedAt: acceptedMemory.acceptedAt,
        effectiveVisibility: acceptedMemory.effectiveVisibility
      }
    : null;
  return {
    state: acceptedMemory ? "accepted" : proposal ? "proposed" : source ? "captured" : "empty",
    proposalGenerationAnchor,
    sourceRevisionAnchor: source ? primaryObjectiveSourceRevisionAnchor(source.projection) : null,
    initiative: {
      title: scope.initiativeTitle,
      organizationName: scope.organizationName,
      engagementTitle: scope.activityTitle,
      version: scope.initiativeVersion,
      effectiveVisibility: visibilityLabel(scope.initiativeAccessClass),
      requiredAcceptanceAuthority: "Initiative owner",
      canAccept
    },
    source: source
      ? {
          title: source.projection.title ?? SOURCE_TITLE,
          note: source.projection.immutableText!,
          capturedAt: source.createdAt
        }
      : null,
    proposal: proposal
      ? {
          objective: proposal.objective,
          exactExcerpt: proposal.exactExcerpt,
          sourceTitle: proposal.sourceTitle,
          status: "Proposed, not accepted.",
          claimId: proposal.id,
          version: proposal.version,
          supportConfirmed: proposal.supportConfirmed,
          canRework,
          canWithdraw,
          canReject
        }
      : null,
    lastProposalRecovery,
    reworkLineage,
    acceptedMemory: acceptedProjection
  };
}

function visibilityLabel(
  value: AccessClass
): "Public" | "Workspace" | "Restricted" | "Confidential" {
  return (
    {
      public: "Public",
      workspace: "Workspace",
      restricted: "Restricted",
      confidential: "Confidential"
    } as const
  )[value];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
