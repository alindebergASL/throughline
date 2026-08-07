import {
  maxAccessClass,
  type AccessClass,
  type B2ClaimVersionRef,
  type ClaimSourceSpanCandidate,
  type Confidence,
  type RevokeReason,
  type SupersedeReason
} from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import { createHash } from "node:crypto";
import type { AcceptedFactConfidenceResult } from "./confidence.js";
import { parseTruthLifecycleReason } from "./reasons.js";
import { isAcceptedFact, type Claim, type NewlyAcceptedFact } from "./types.js";
import type {
  AuthorizedClaimEvidenceSnapshot,
  AuthorizedClaimEvidenceSnapshotLookup,
  VerifiedClaimSourceSpan
} from "./source-span.js";

export class TruthLedgerInvariantError extends Error {
  constructor() {
    super("Truth ledger transaction invariant failed");
    this.name = "TruthLedgerInvariantError";
  }
}

export class TruthLedgerConflictError extends Error {
  constructor() {
    super("Truth command precondition failed");
    this.name = "TruthLedgerConflictError";
  }
}

export interface TruthSubjectScope {
  subjectType: "activity" | "initiative";
  subjectId: string;
  spaceId: string;
  accessClass: AccessClass;
  version: number;
}

export interface ClaimSupportHeader {
  claimId: string;
  evidenceSpanId: string;
  sourceArtifactId: string;
  spaceId: string;
  subjectType: "activity" | "initiative";
  subjectId: string;
  predicate: "activity.outcome" | "initiative.primary_objective";
}

export interface PersistedClaimForAcceptance {
  claim: Omit<Claim, "sourceSpan">;
  evidence: ClaimSourceSpanCandidate;
  evidenceSpanId: string;
  sourceArtifactId: string;
  claimVersion: number;
}

const prelockedCurrentFactBrand: unique symbol = Symbol("PrelockedCurrentFact");
const postAuthorizationCurrentFactBrand: unique symbol = Symbol("PostAuthorizationCurrentFact");

export type PrelockedCurrentFact = Readonly<{
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  factId: string;
  version: 1;
  status: "current";
  subjectType: "activity" | "initiative";
  subjectId: string;
  predicate: "activity.outcome" | "initiative.primary_objective";
  subjectVersion: number;
  factAccessClass: AccessClass;
  subjectAccessClass: AccessClass;
  acceptanceScope: "engagement" | "initiative";
  authorityBasis: "activity_owner" | "initiative_owner";
  readonly [prelockedCurrentFactBrand]: true;
}>;

export type PostAuthorizationCurrentFact = Readonly<{
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  factId: string;
  version: 1;
  status: "current";
  subjectType: "activity" | "initiative";
  subjectId: string;
  predicate: "activity.outcome" | "initiative.primary_objective";
  subjectVersion: number;
  factAccessClass: AccessClass;
  subjectAccessClass: AccessClass;
  acceptanceScope: "engagement" | "initiative";
  authorityBasis: "activity_owner" | "initiative_owner";
  readonly [postAuthorizationCurrentFactBrand]: true;
}>;

export interface SupersededFactResult {
  factId: string;
  version: 2;
  status: "superseded";
  replacementFactId: string;
  replacementFactVersion: 1;
  replacementFactStatus: "current";
}

export interface RevokedFactResult {
  factId: string;
  version: 2;
  status: "revoked";
}

interface FactLifecycleHeaderRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  space_id: string;
  subject_type: "activity" | "initiative";
  subject_id: string;
  predicate: "activity.outcome" | "initiative.primary_objective";
}

interface LockedCurrentFactRow extends FactLifecycleHeaderRow {
  version: 1;
  status: "current";
  access_class: AccessClass;
  space_access_class: AccessClass;
  subject_version: number;
  acceptance_scope: "engagement" | "initiative";
  authority_basis: "activity_owner" | "initiative_owner";
  context_actor_user_id: string;
  context_actor_membership_id: string;
  context_policy_version: string;
}

interface RefreshedCurrentFactRow extends LockedCurrentFactRow {
  space_archived_at: string | null;
}

interface PrelockedCurrentFactState {
  replacementClaimIds?: readonly string[];
  postAuthorizationTarget?: PostAuthorizationCurrentFact;
  actorUserId: string;
  actorMembershipId: string;
  policyVersion: string;
}

interface PostAuthorizationCurrentFactState {
  prelockedTarget: PrelockedCurrentFact;
  prelockedState: PrelockedCurrentFactState;
}

interface SourceRow {
  id: string;
  space_id: string;
  access_class: AccessClass;
  version: number;
  deleted_at: Date | null;
  immutable_text: string | null;
  content_hash: string | null;
  normalized_content_hash: string | null;
  normalization_version: "source-normalization.v1";
  chunking_version: "source-chunking.v1";
  space_access_class: AccessClass;
  activity_id: string;
  governing_initiative_id: string | null;
}

interface ChunkRow {
  id: string;
  source_artifact_id: string;
  space_id: string;
  normalization_version: "source-normalization.v1";
  chunking_version: "source-chunking.v1";
  chunk_index: number;
  start_offset: number;
  end_offset: number;
  normalized_text: string;
  content_hash: string;
  access_class: AccessClass;
}

interface AcceptanceRow {
  id: string;
  space_id: string;
  subject_type: "activity" | "initiative";
  subject_id: string;
  predicate: "activity.outcome" | "initiative.primary_objective";
  canonical_value_text: string;
  normalized_text: string;
  asserted_by_id: string;
  confidence: Confidence;
  valid_from: Date | null;
  valid_to: Date | null;
  observed_at: Date | null;
  status: "proposed" | "accepted";
  access_class: AccessClass;
  created_at: Date;
  claim_version: number;
  evidence_span_id: string;
  source_artifact_id: string;
  source_chunk_id: string;
  source_version: number;
  chunk_version: 1;
  evidence_normalization_version: "source-normalization.v1";
  evidence_chunking_version: "source-chunking.v1";
  source_start_offset: number;
  source_end_offset: number;
  source_excerpt: string;
  source_content_hash: string;
  source_normalized_content_hash: string;
  chunk_content_hash: string;
  excerpt_hash: string;
}

export class TruthLedgerRepository implements AuthorizedClaimEvidenceSnapshotLookup {
  readonly transaction: TenantDbTransaction;
  private readonly prelockedCurrentFacts = new WeakMap<
    PrelockedCurrentFact,
    PrelockedCurrentFactState
  >();
  private readonly postAuthorizationCurrentFacts = new WeakMap<
    PostAuthorizationCurrentFact,
    PostAuthorizationCurrentFactState
  >();

  constructor(private readonly tx: TenantDbTransaction) {
    this.transaction = tx;
  }

  async transactionTimestamp(): Promise<string> {
    const result = await this.tx.query<{ now: Date }>(
      "SELECT date_trunc('milliseconds', clock_timestamp()) AS now"
    );
    const now = result.rows[0]?.now;
    if (!now) throw new TruthLedgerInvariantError();
    return now.toISOString();
  }

  async readFactLifecycleReservation(input: {
    tenantId: string;
    workspaceId: string;
    factId: string;
    expectedVersion: number;
  }): Promise<{ spaceId: string }> {
    if (
      input.expectedVersion !== 1 ||
      !isCanonicalUuidReference(input.tenantId) ||
      !isCanonicalUuidReference(input.workspaceId) ||
      !isUuidV7(input.factId)
    ) {
      throw new TruthLedgerConflictError();
    }
    const result = await this.guardLifecycleDatabaseOperation(() =>
      this.tx.query<{ id: string; space_id: string }>(
        `SELECT fact.id, fact.space_id
         FROM truth.accepted_facts fact
         WHERE fact.tenant_id = $1 AND fact.workspace_id = $2 AND fact.id = $3
         LIMIT 1`,
        [input.tenantId, input.workspaceId, input.factId]
      )
    );
    const row = result.rows[0];
    if (!row || row.id !== input.factId) throw new TruthLedgerConflictError();
    return { spaceId: row.space_id };
  }

  async getSubjectScope(
    tenantId: string,
    workspaceId: string,
    subjectType: "activity" | "initiative",
    subjectId: string,
    lock = false
  ): Promise<TruthSubjectScope> {
    const table = subjectType === "activity" ? "work.activities" : "work.initiatives";
    const result = await this.tx.query<{
      space_id: string;
      access_class: AccessClass;
      version: number;
    }>(
      `SELECT subject.space_id, space.access_class, subject.version
       FROM ${table} subject
       JOIN access.spaces space
         ON space.tenant_id = subject.tenant_id
        AND space.workspace_id = subject.workspace_id
        AND space.id = subject.space_id
       WHERE subject.tenant_id = $1 AND subject.workspace_id = $2
         AND subject.id = $3 AND space.archived_at IS NULL
       LIMIT 1 ${lock ? "FOR SHARE OF subject, space" : ""}`,
      [tenantId, workspaceId, subjectId]
    );
    const row = result.rows[0];
    if (!row) throw new TruthLedgerInvariantError();
    return {
      subjectType,
      subjectId,
      spaceId: row.space_id,
      accessClass: row.access_class,
      version: row.version
    };
  }

  async getAuthorizedClaimEvidenceSnapshot(input: {
    tenantId: string;
    workspaceId: string;
    subjectType: "activity" | "initiative";
    subjectId: string;
    sourceArtifactId: string;
    sourceChunkId: string;
  }): Promise<AuthorizedClaimEvidenceSnapshot | null> {
    const subject = await this.getSubjectScope(
      input.tenantId,
      input.workspaceId,
      input.subjectType,
      input.subjectId,
      true
    );
    const source = await this.tx.query<SourceRow>(
      `SELECT source.id, source.space_id, source.access_class, source.version,
              source.deleted_at, source.immutable_text, source.content_hash,
              source.normalized_content_hash, source.normalization_version,
              source.chunking_version, activity_source.activity_id,
              activity.governing_initiative_id, space.access_class AS space_access_class
       FROM content.source_artifacts source
       JOIN work.activity_sources activity_source
         ON activity_source.tenant_id = source.tenant_id
        AND activity_source.workspace_id = source.workspace_id
        AND activity_source.space_id = source.space_id
        AND activity_source.source_artifact_id = source.id
       JOIN work.activities activity
         ON activity.tenant_id = activity_source.tenant_id
        AND activity.workspace_id = activity_source.workspace_id
        AND activity.space_id = activity_source.space_id
        AND activity.id = activity_source.activity_id
       JOIN access.spaces space
         ON space.tenant_id = source.tenant_id
        AND space.workspace_id = source.workspace_id
        AND space.id = source.space_id
       WHERE source.tenant_id = $1 AND source.workspace_id = $2
         AND source.id = $3 AND space.archived_at IS NULL
       LIMIT 1
       FOR SHARE OF source, activity, space`,
      [input.tenantId, input.workspaceId, input.sourceArtifactId]
    );
    const sourceRow = source.rows[0];
    if (!sourceRow || subject.spaceId !== sourceRow.space_id) return null;

    const successor = await this.tx.query<{ id: string }>(
      `SELECT id
       FROM content.source_artifacts
       WHERE tenant_id = $1 AND workspace_id = $2
         AND supersedes_source_id = $3
       LIMIT 1
       FOR SHARE`,
      [input.tenantId, input.workspaceId, input.sourceArtifactId]
    );

    const chunks = await this.tx.query<ChunkRow>(
      `SELECT id, source_artifact_id, space_id, normalization_version,
              chunking_version, chunk_index, start_offset, end_offset,
              normalized_text, content_hash, access_class
       FROM content.source_chunks
       WHERE tenant_id = $1 AND workspace_id = $2 AND source_artifact_id = $3
       ORDER BY chunk_index`,
      [input.tenantId, input.workspaceId, input.sourceArtifactId]
    );
    if (!chunks.rows.some(({ id }) => id === input.sourceChunkId)) return null;

    return Object.freeze({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      spaceId: sourceRow.space_id,
      subject: Object.freeze({
        type: input.subjectType,
        id: input.subjectId,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        spaceId: subject.spaceId,
        version: subject.version,
        accessClass: subject.accessClass
      }),
      sourceActivityLink: Object.freeze({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        spaceId: sourceRow.space_id,
        sourceArtifactId: sourceRow.id,
        activityId: sourceRow.activity_id,
        governingInitiativeId: sourceRow.governing_initiative_id
      }),
      source: Object.freeze({
        id: sourceRow.id,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        spaceId: sourceRow.space_id,
        version: sourceRow.version,
        immutableText: sourceRow.immutable_text,
        contentHash: sourceRow.content_hash,
        normalizedContentHash: sourceRow.normalized_content_hash,
        normalizationVersion: sourceRow.normalization_version,
        chunkingVersion: sourceRow.chunking_version,
        accessClass: sourceRow.access_class,
        deletedAt: sourceRow.deleted_at?.toISOString() ?? null,
        successorSourceArtifactId: successor.rows[0]?.id ?? null
      }),
      chunks: Object.freeze(
        chunks.rows.map((chunk) =>
          Object.freeze({
            id: chunk.id,
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            spaceId: chunk.space_id,
            sourceArtifactId: chunk.source_artifact_id,
            version: 1 as const,
            normalizationVersion: chunk.normalization_version,
            chunkingVersion: chunk.chunking_version,
            chunkIndex: chunk.chunk_index,
            startOffset: chunk.start_offset,
            endOffset: chunk.end_offset,
            normalizedText: chunk.normalized_text,
            contentHash: chunk.content_hash,
            accessClass: chunk.access_class
          })
        )
      ),
      explicitPolicyAccessClass: sourceRow.space_access_class
    });
  }

  async insertEvidenceAndClaim(input: {
    tenantId: string;
    workspaceId: string;
    claimId: string;
    evidenceSpanId: string;
    supportAttestationId?: string;
    commandId: string;
    actorUserId: string;
    actorMembershipId: string;
    assertedById: string;
    predicate: "activity.outcome" | "initiative.primary_objective";
    canonicalValue: string;
    normalizedText: string;
    confidence: Confidence;
    validFrom?: string;
    validTo?: string;
    observedAt?: string;
    evidence: VerifiedClaimSourceSpan;
  }): Promise<void> {
    const valueHash = sha256CanonicalText(input.canonicalValue);
    const evidence = input.evidence;
    await this.tx.query(
      `INSERT INTO truth.verified_evidence_spans (
         id, tenant_id, workspace_id, space_id, source_artifact_id, source_chunk_id,
         source_version, chunk_version, normalization_version, chunking_version,
         source_start_offset, source_end_offset, source_excerpt,
         source_content_hash, source_normalized_content_hash, chunk_content_hash, excerpt_hash,
         access_class, created_by_user_id, created_by_membership_id, causation_command_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
       )`,
      [
        input.evidenceSpanId,
        input.tenantId,
        input.workspaceId,
        evidence.spaceId,
        evidence.sourceArtifactId,
        evidence.sourceChunkId,
        evidence.sourceVersion,
        evidence.chunkVersion,
        evidence.normalizationVersion,
        evidence.chunkingVersion,
        evidence.startOffset,
        evidence.endOffset,
        evidence.excerpt,
        evidence.sourceContentHash,
        evidence.sourceNormalizedContentHash,
        evidence.chunkContentHash,
        evidence.excerptHash,
        evidence.effectiveAccessClass,
        input.actorUserId,
        input.actorMembershipId,
        input.commandId
      ]
    );
    await this.tx.query(
      `INSERT INTO truth.claims (
         id, tenant_id, workspace_id, space_id, subject_type, subject_id,
         predicate_catalog_version, predicate, canonical_value_text, value_hash, normalized_text,
         verified_evidence_span_id, asserted_by_type, asserted_by_id, confidence,
         valid_from, valid_to, observed_at, status, access_class,
         created_by_user_id, created_by_membership_id, causation_command_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'truth-predicate-catalog.v1',$7,$8,$9,$10,
         $11,'person',$12,$13,$14,$15,$16,'proposed',$17,$18,$19,$20
       )`,
      [
        input.claimId,
        input.tenantId,
        input.workspaceId,
        evidence.spaceId,
        evidence.subject.type,
        evidence.subject.id,
        input.predicate,
        input.canonicalValue,
        valueHash,
        input.normalizedText,
        input.evidenceSpanId,
        input.assertedById,
        input.confidence,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.observedAt ?? null,
        evidence.effectiveAccessClass,
        input.actorUserId,
        input.actorMembershipId,
        input.commandId
      ]
    );
    if (input.predicate === "initiative.primary_objective") {
      if (!input.supportAttestationId) throw new TruthLedgerInvariantError();
      await this.tx.query(
        `INSERT INTO truth.initiative_objective_support_attestations (
           id, tenant_id, workspace_id, space_id, initiative_id, claim_id,
           verified_evidence_span_id, objective_value_hash, excerpt_hash,
           confirmed_by_user_id, confirmed_by_membership_id, causation_command_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          input.supportAttestationId,
          input.tenantId,
          input.workspaceId,
          evidence.spaceId,
          evidence.subject.id,
          input.claimId,
          input.evidenceSpanId,
          valueHash,
          evidence.excerptHash,
          input.actorUserId,
          input.actorMembershipId,
          input.commandId
        ]
      );
    } else if (input.supportAttestationId) {
      throw new TruthLedgerInvariantError();
    }
  }

  async lockPrimaryObjectiveProposal(input: {
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    initiativeId: string;
    claimId: string;
    expectedVersion: number;
  }): Promise<{
    claimId: string;
    createdByUserId: string;
    createdByMembershipId: string;
  }> {
    await this.lockTruthCoordinate({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      subjectType: "initiative",
      subjectId: input.initiativeId,
      predicate: "initiative.primary_objective"
    });
    const result = await this.tx.query<{
      id: string;
      created_by_user_id: string;
      created_by_membership_id: string;
    }>(
      `SELECT id, created_by_user_id, created_by_membership_id
         FROM truth.claims
        WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
          AND id = $4 AND subject_type = 'initiative' AND subject_id = $5
          AND predicate = 'initiative.primary_objective'
          AND status = 'proposed' AND version = $6
          AND NOT EXISTS (
            SELECT 1 FROM truth.accepted_facts fact
             WHERE fact.tenant_id = $1 AND fact.workspace_id = $2 AND fact.space_id = $3
               AND fact.subject_type = 'initiative' AND fact.subject_id = $5
               AND fact.predicate = 'initiative.primary_objective'
          )
        LIMIT 1 FOR UPDATE`,
      [
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.claimId,
        input.initiativeId,
        input.expectedVersion
      ]
    );
    const row = result.rows[0];
    if (!row) throw new TruthLedgerConflictError();
    return {
      claimId: row.id,
      createdByUserId: row.created_by_user_id,
      createdByMembershipId: row.created_by_membership_id
    };
  }

  async terminalizePrimaryObjectiveProposal(input: {
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    initiativeId: string;
    predecessorClaimId: string;
    successorClaimId?: string;
    recoveryId: string;
    disposition: "withdrawn" | "rejected" | "reworked";
    reasonCode: string;
    actorUserId: string;
    actorMembershipId: string;
    commandId: string;
    timestamp: string;
  }): Promise<void> {
    const status = input.disposition === "reworked" ? "superseded" : "rejected";
    const changed = await this.tx.query<{ id: string }>(
      `UPDATE truth.claims
          SET status = $6, version = 2, updated_at = $7
        WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3 AND id = $4
          AND subject_type = 'initiative' AND subject_id = $5
          AND predicate = 'initiative.primary_objective'
          AND status = 'proposed' AND version = 1
        RETURNING id`,
      [
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.predecessorClaimId,
        input.initiativeId,
        status,
        input.timestamp
      ]
    );
    if (changed.rows.length !== 1) throw new TruthLedgerConflictError();
    await this.tx.query(
      `INSERT INTO truth.initiative_objective_proposal_recoveries (
         id, tenant_id, workspace_id, space_id, initiative_id,
         predecessor_claim_id, successor_claim_id, disposition, reason_code,
         acted_by_user_id, acted_by_membership_id, causation_command_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.recoveryId,
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.initiativeId,
        input.predecessorClaimId,
        input.successorClaimId ?? null,
        input.disposition,
        input.reasonCode,
        input.actorUserId,
        input.actorMembershipId,
        input.commandId,
        input.timestamp
      ]
    );
  }

  async requirePrimaryObjectiveSupportConfirmations(
    tenantId: string,
    workspaceId: string,
    claimIds: readonly string[]
  ): Promise<void> {
    const result = await this.tx.query<{ claim_id: string }>(
      `SELECT claim.id AS claim_id
         FROM truth.claims claim
         JOIN truth.initiative_objective_support_attestations attestation
           ON attestation.tenant_id = claim.tenant_id
          AND attestation.workspace_id = claim.workspace_id
          AND attestation.space_id = claim.space_id
          AND attestation.claim_id = claim.id
          AND attestation.initiative_id = claim.subject_id
          AND attestation.verified_evidence_span_id = claim.verified_evidence_span_id
          AND attestation.objective_value_hash = claim.value_hash
          AND attestation.confirmed_by_user_id = claim.created_by_user_id
          AND attestation.confirmed_by_membership_id = claim.created_by_membership_id
          AND attestation.causation_command_id = claim.causation_command_id
         JOIN truth.verified_evidence_spans span
           ON span.tenant_id = attestation.tenant_id
          AND span.workspace_id = attestation.workspace_id
          AND span.space_id = attestation.space_id
          AND span.id = attestation.verified_evidence_span_id
          AND span.excerpt_hash = attestation.excerpt_hash
        WHERE claim.tenant_id = $1 AND claim.workspace_id = $2
          AND claim.id = ANY($3::uuid[])
          AND claim.subject_type = 'initiative'
          AND claim.predicate = 'initiative.primary_objective'
        ORDER BY claim.id`,
      [tenantId, workspaceId, [...claimIds].sort()]
    );
    if (result.rows.length !== claimIds.length) throw new TruthLedgerConflictError();
  }

  async readClaimSupportHeaders(
    tenantId: string,
    workspaceId: string,
    claimIds: readonly string[]
  ): Promise<ClaimSupportHeader[]> {
    const result = await this.tx.query<{
      claim_id: string;
      evidence_span_id: string;
      source_artifact_id: string;
      space_id: string;
      subject_type: ClaimSupportHeader["subjectType"];
      subject_id: string;
      predicate: ClaimSupportHeader["predicate"];
    }>(
      `SELECT claim.id AS claim_id, span.id AS evidence_span_id,
              span.source_artifact_id, claim.space_id,
              claim.subject_type, claim.subject_id, claim.predicate
       FROM truth.claims claim
       JOIN truth.verified_evidence_spans span
         ON span.tenant_id = claim.tenant_id
        AND span.workspace_id = claim.workspace_id
        AND span.space_id = claim.space_id
        AND span.id = claim.verified_evidence_span_id
       WHERE claim.tenant_id = $1 AND claim.workspace_id = $2
         AND claim.id = ANY($3::uuid[])
       ORDER BY claim.id`,
      [tenantId, workspaceId, [...claimIds].sort()]
    );
    if (result.rows.length !== claimIds.length) throw new TruthLedgerInvariantError();
    return result.rows.map((row) => ({
      claimId: row.claim_id,
      evidenceSpanId: row.evidence_span_id,
      sourceArtifactId: row.source_artifact_id,
      spaceId: row.space_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      predicate: row.predicate
    }));
  }

  async loadClaimsForAcceptance(
    tenantId: string,
    workspaceId: string,
    claimIds: readonly string[],
    excludeClaimsSupportingActiveFact = false
  ): Promise<PersistedClaimForAcceptance[]> {
    const result = await this.tx.query<AcceptanceRow>(
      `SELECT claim.id, claim.space_id, claim.subject_type, claim.subject_id,
              claim.predicate, claim.canonical_value_text,
              claim.normalized_text, claim.asserted_by_id, claim.confidence,
              claim.valid_from, claim.valid_to, claim.observed_at, claim.status,
              claim.access_class, claim.created_at, claim.version AS claim_version,
              span.id AS evidence_span_id, span.source_artifact_id, span.source_chunk_id,
              span.source_version, span.chunk_version,
              span.normalization_version AS evidence_normalization_version,
              span.chunking_version AS evidence_chunking_version,
              span.source_start_offset, span.source_end_offset, span.source_excerpt,
              span.source_content_hash, span.source_normalized_content_hash,
              span.chunk_content_hash, span.excerpt_hash
       FROM truth.claims claim
       JOIN truth.verified_evidence_spans span
         ON span.tenant_id = claim.tenant_id
        AND span.workspace_id = claim.workspace_id
        AND span.space_id = claim.space_id
        AND span.id = claim.verified_evidence_span_id
       JOIN content.source_artifacts source
         ON source.tenant_id = span.tenant_id
        AND source.workspace_id = span.workspace_id
        AND source.space_id = span.space_id
        AND source.id = span.source_artifact_id
       JOIN content.source_chunks chunk
         ON chunk.tenant_id = span.tenant_id
        AND chunk.workspace_id = span.workspace_id
        AND chunk.space_id = span.space_id
        AND chunk.source_artifact_id = span.source_artifact_id
        AND chunk.id = span.source_chunk_id
       WHERE claim.tenant_id = $1 AND claim.workspace_id = $2
         AND claim.id = ANY($3::uuid[])
         AND source.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM content.source_artifacts successor
           WHERE successor.tenant_id = source.tenant_id
             AND successor.workspace_id = source.workspace_id
             AND successor.supersedes_source_id = source.id
         )
       ${
         excludeClaimsSupportingActiveFact
           ? `AND NOT EXISTS (
           SELECT 1
           FROM truth.fact_claims active_support
           JOIN truth.accepted_facts active_fact
             ON active_fact.tenant_id = active_support.tenant_id
            AND active_fact.workspace_id = active_support.workspace_id
            AND active_fact.space_id = active_support.space_id
            AND active_fact.id = active_support.fact_id
           WHERE active_support.tenant_id = claim.tenant_id
             AND active_support.workspace_id = claim.workspace_id
             AND active_support.space_id = claim.space_id
             AND active_support.claim_id = claim.id
             AND active_fact.status = 'current'
         )`
           : ""
       }
       ORDER BY claim.id
       FOR UPDATE OF claim
       FOR SHARE OF source`,
      [tenantId, workspaceId, [...claimIds].sort()]
    );
    if (result.rows.length !== claimIds.length) throw new TruthLedgerConflictError();
    return result.rows.map((row) => ({
      claim: {
        id: row.id,
        version: row.claim_version,
        tenantId,
        workspaceId,
        spaceId: row.space_id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        predicate: row.predicate,
        canonicalValue: row.canonical_value_text,
        normalizedText: row.normalized_text,
        assertedByType: "person",
        assertedById: row.asserted_by_id,
        confidence: row.confidence,
        ...(row.valid_from ? { validFrom: row.valid_from.toISOString() } : {}),
        ...(row.valid_to ? { validTo: row.valid_to.toISOString() } : {}),
        ...(row.observed_at ? { observedAt: row.observed_at.toISOString() } : {}),
        status: row.status,
        accessClass: row.access_class,
        createdAt: row.created_at.toISOString()
      },
      evidence: {
        sourceArtifactId: row.source_artifact_id,
        sourceChunkId: row.source_chunk_id,
        expectedSourceVersion: row.source_version,
        expectedChunkVersion: row.chunk_version,
        normalizationVersion: row.evidence_normalization_version,
        chunkingVersion: row.evidence_chunking_version,
        startOffset: row.source_start_offset,
        endOffset: row.source_end_offset,
        excerpt: row.source_excerpt,
        sourceContentHash: row.source_content_hash,
        sourceNormalizedContentHash: row.source_normalized_content_hash,
        chunkContentHash: row.chunk_content_hash,
        excerptHash: row.excerpt_hash
      },
      evidenceSpanId: row.evidence_span_id,
      sourceArtifactId: row.source_artifact_id,
      claimVersion: row.claim_version
    }));
  }

  async prelockCurrentFact(input: {
    tenantId: string;
    workspaceId: string;
    factId: string;
    expectedVersion: number;
  }): Promise<PrelockedCurrentFact> {
    if (
      input.expectedVersion !== 1 ||
      !isCanonicalUuidReference(input.tenantId) ||
      !isCanonicalUuidReference(input.workspaceId) ||
      !isUuidV7(input.factId)
    ) {
      throw new TruthLedgerConflictError();
    }
    const headerResult = await this.guardLifecycleDatabaseOperation(() =>
      this.tx.query<FactLifecycleHeaderRow>(
        `SELECT fact.id, fact.tenant_id, fact.workspace_id, fact.space_id,
                fact.subject_type, fact.subject_id, fact.predicate
         FROM truth.accepted_facts fact
         WHERE fact.tenant_id = $1 AND fact.workspace_id = $2 AND fact.id = $3
         LIMIT 1`,
        [input.tenantId, input.workspaceId, input.factId]
      )
    );
    const header = headerResult.rows[0];
    if (
      !header ||
      header.id !== input.factId ||
      header.tenant_id !== input.tenantId ||
      header.workspace_id !== input.workspaceId ||
      !isCanonicalTruthCoordinate(header)
    ) {
      throw new TruthLedgerConflictError();
    }

    await this.guardLifecycleDatabaseOperation(() =>
      this.lockTruthCoordinate({
        tenantId: header.tenant_id,
        workspaceId: header.workspace_id,
        spaceId: header.space_id,
        subjectType: header.subject_type,
        subjectId: header.subject_id,
        predicate: header.predicate
      })
    );

    const subjectTable =
      header.subject_type === "activity" ? "work.activities" : "work.initiatives";
    const lockedResult = await this.guardLifecycleDatabaseOperation(() =>
      this.tx.query<LockedCurrentFactRow>(
        `SELECT fact.id, fact.tenant_id, fact.workspace_id, fact.space_id,
                fact.subject_type, fact.subject_id, fact.predicate,
                fact.version, fact.status, fact.access_class,
                space.access_class AS space_access_class,
                subject.version AS subject_version,
                fact.acceptance_scope, fact.authority_basis,
                ops.current_user_id() AS context_actor_user_id,
                ops.current_membership_id() AS context_actor_membership_id,
                ops.current_policy_version() AS context_policy_version
         FROM truth.accepted_facts fact
         JOIN access.spaces space
           ON space.tenant_id = fact.tenant_id
          AND space.workspace_id = fact.workspace_id
          AND space.id = fact.space_id
         JOIN ${subjectTable} subject
           ON subject.tenant_id = fact.tenant_id
          AND subject.workspace_id = fact.workspace_id
          AND subject.space_id = fact.space_id
          AND subject.id = fact.subject_id
         WHERE fact.tenant_id = $1 AND fact.workspace_id = $2 AND fact.id = $3
           AND fact.space_id = $4 AND fact.subject_type = $5
           AND fact.subject_id = $6 AND fact.predicate = $7
           AND fact.version = $8 AND fact.status = 'current'
           AND space.archived_at IS NULL
         LIMIT 1
         FOR UPDATE OF fact`,
        [
          input.tenantId,
          input.workspaceId,
          input.factId,
          header.space_id,
          header.subject_type,
          header.subject_id,
          header.predicate,
          input.expectedVersion
        ]
      )
    );
    const row = lockedResult.rows[0];
    if (
      !row ||
      row.id !== header.id ||
      row.tenant_id !== header.tenant_id ||
      row.workspace_id !== header.workspace_id ||
      row.space_id !== header.space_id ||
      row.subject_type !== header.subject_type ||
      row.subject_id !== header.subject_id ||
      row.predicate !== header.predicate ||
      row.version !== input.expectedVersion ||
      row.status !== "current" ||
      !Number.isSafeInteger(row.subject_version) ||
      row.subject_version < 1 ||
      !isCanonicalUuidReference(row.context_actor_user_id) ||
      !isCanonicalUuidReference(row.context_actor_membership_id) ||
      !isSafeReference(row.context_policy_version) ||
      !lifecycleAuthorityMatchesCoordinate(row)
    ) {
      throw new TruthLedgerConflictError();
    }

    const target = Object.freeze({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      spaceId: row.space_id,
      factId: row.id,
      version: row.version,
      status: row.status,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      predicate: row.predicate,
      subjectVersion: row.subject_version,
      factAccessClass: row.access_class,
      subjectAccessClass: row.space_access_class,
      acceptanceScope: row.acceptance_scope,
      authorityBasis: row.authority_basis,
      [prelockedCurrentFactBrand]: true as const
    });
    this.prelockedCurrentFacts.set(target, {
      actorUserId: row.context_actor_user_id,
      actorMembershipId: row.context_actor_membership_id,
      policyVersion: row.context_policy_version
    });
    return target;
  }

  async refreshCurrentFactAfterAuthorization(input: {
    target: PrelockedCurrentFact;
  }): Promise<PostAuthorizationCurrentFact> {
    const state = this.requirePrelockedCurrentFact(input.target);
    if (state.postAuthorizationTarget !== undefined) {
      throw new TruthLedgerConflictError();
    }
    const subjectTable =
      input.target.subjectType === "activity" ? "work.activities" : "work.initiatives";
    const refreshedResult = await this.guardLifecycleDatabaseOperation(() =>
      this.tx.query<RefreshedCurrentFactRow>(
        `SELECT fact.id, fact.tenant_id, fact.workspace_id, fact.space_id,
                fact.subject_type, fact.subject_id, fact.predicate,
                fact.version, fact.status, fact.access_class,
                space.access_class AS space_access_class,
                space.archived_at AS space_archived_at,
                subject.version AS subject_version,
                fact.acceptance_scope, fact.authority_basis,
                ops.current_user_id() AS context_actor_user_id,
                ops.current_membership_id() AS context_actor_membership_id,
                ops.current_policy_version() AS context_policy_version
           FROM truth.accepted_facts fact
           JOIN access.spaces space
             ON space.tenant_id = fact.tenant_id
            AND space.workspace_id = fact.workspace_id
            AND space.id = fact.space_id
           JOIN ${subjectTable} subject
             ON subject.tenant_id = fact.tenant_id
            AND subject.workspace_id = fact.workspace_id
            AND subject.space_id = fact.space_id
            AND subject.id = fact.subject_id
          WHERE fact.tenant_id = $1 AND fact.workspace_id = $2 AND fact.id = $3
            AND fact.space_id = $4 AND fact.subject_type = $5
            AND fact.subject_id = $6 AND fact.predicate = $7
            AND fact.version = 1 AND fact.status = 'current'
          LIMIT 1`,
        [
          input.target.tenantId,
          input.target.workspaceId,
          input.target.factId,
          input.target.spaceId,
          input.target.subjectType,
          input.target.subjectId,
          input.target.predicate
        ]
      )
    );
    const row = refreshedResult.rows[0];
    if (
      !row ||
      row.id !== input.target.factId ||
      row.tenant_id !== input.target.tenantId ||
      row.workspace_id !== input.target.workspaceId ||
      row.space_id !== input.target.spaceId ||
      row.subject_type !== input.target.subjectType ||
      row.subject_id !== input.target.subjectId ||
      row.predicate !== input.target.predicate ||
      row.version !== input.target.version ||
      row.status !== input.target.status ||
      row.access_class !== input.target.factAccessClass ||
      row.subject_version !== input.target.subjectVersion ||
      row.acceptance_scope !== input.target.acceptanceScope ||
      row.authority_basis !== input.target.authorityBasis ||
      row.space_archived_at !== null ||
      !isAccessClass(row.space_access_class) ||
      row.context_actor_user_id !== state.actorUserId ||
      row.context_actor_membership_id !== state.actorMembershipId ||
      row.context_policy_version !== state.policyVersion ||
      !lifecycleAuthorityMatchesCoordinate(row)
    ) {
      throw new TruthLedgerConflictError();
    }

    const target = Object.freeze({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      spaceId: row.space_id,
      factId: row.id,
      version: row.version,
      status: row.status,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      predicate: row.predicate,
      subjectVersion: row.subject_version,
      factAccessClass: row.access_class,
      subjectAccessClass: row.space_access_class,
      acceptanceScope: row.acceptance_scope,
      authorityBasis: row.authority_basis,
      [postAuthorizationCurrentFactBrand]: true as const
    });
    state.postAuthorizationTarget = target;
    this.postAuthorizationCurrentFacts.set(target, {
      prelockedTarget: input.target,
      prelockedState: state
    });
    return target;
  }

  async lockReplacementClaimsForSupersession(input: {
    target: PostAuthorizationCurrentFact;
    replacementClaims: readonly B2ClaimVersionRef[];
  }): Promise<readonly PersistedClaimForAcceptance[]> {
    const { prelockedState: state } = this.requirePostAuthorizationCurrentFact(input.target);
    if (
      !Array.isArray(input.replacementClaims) ||
      input.replacementClaims.length === 0 ||
      input.replacementClaims.length > 100 ||
      state.replacementClaimIds !== undefined
    ) {
      throw new TruthLedgerConflictError();
    }
    const expectedVersions = new Map<string, number>();
    for (const reference of input.replacementClaims) {
      if (
        !reference ||
        !isUuidV7(reference.claimId) ||
        !Number.isSafeInteger(reference.expectedVersion) ||
        reference.expectedVersion < 1 ||
        expectedVersions.has(reference.claimId)
      ) {
        throw new TruthLedgerConflictError();
      }
      expectedVersions.set(reference.claimId, reference.expectedVersion);
    }
    const claimIds = [...expectedVersions.keys()].sort();
    const persistedClaims = await this.guardLifecycleDatabaseOperation(() =>
      this.loadClaimsForAcceptance(input.target.tenantId, input.target.workspaceId, claimIds, true)
    );
    if (
      persistedClaims.length !== claimIds.length ||
      persistedClaims.some(
        ({ claim, claimVersion }) =>
          claim.status !== "proposed" ||
          expectedVersions.get(claim.id) !== claimVersion ||
          claim.tenantId !== input.target.tenantId ||
          claim.workspaceId !== input.target.workspaceId ||
          claim.spaceId !== input.target.spaceId ||
          claim.subjectType !== input.target.subjectType ||
          claim.subjectId !== input.target.subjectId ||
          claim.predicate !== input.target.predicate
      )
    ) {
      throw new TruthLedgerConflictError();
    }
    if (
      input.target.subjectType === "initiative" &&
      input.target.predicate === "initiative.primary_objective"
    ) {
      await this.guardLifecycleDatabaseOperation(() =>
        this.requirePrimaryObjectiveSupportConfirmations(
          input.target.tenantId,
          input.target.workspaceId,
          claimIds
        )
      );
    }
    state.replacementClaimIds = Object.freeze(claimIds);
    return Object.freeze(persistedClaims);
  }

  async supersedePrelockedFact(input: {
    target: PostAuthorizationCurrentFact;
    replacementFact: NewlyAcceptedFact;
    lifecycleEventId: string;
    commandId: string;
    reason: SupersedeReason;
    actorUserId: string;
    actorMembershipId: string;
    policyVersion: string;
  }): Promise<SupersededFactResult> {
    const { prelockedTarget, prelockedState: state } = this.requirePostAuthorizationCurrentFact(
      input.target
    );
    const reason = parseLifecycleReason("supersede", input.reason);
    const fact = input.replacementFact;
    if (
      state.replacementClaimIds === undefined ||
      !isAcceptedFact(fact) ||
      fact.id === input.target.factId ||
      fact.supersedesFactId !== input.target.factId ||
      fact.tenantId !== input.target.tenantId ||
      fact.workspaceId !== input.target.workspaceId ||
      fact.spaceId !== input.target.spaceId ||
      fact.subjectType !== input.target.subjectType ||
      fact.subjectId !== input.target.subjectId ||
      fact.predicate !== input.target.predicate ||
      fact.acceptanceScope !== input.target.acceptanceScope ||
      fact.authorityBasis !== input.target.authorityBasis ||
      fact.acceptedByUserId !== input.actorUserId ||
      fact.acceptedByMembershipId !== input.actorMembershipId ||
      fact.policyVersion !== input.policyVersion ||
      input.actorUserId !== state.actorUserId ||
      input.actorMembershipId !== state.actorMembershipId ||
      input.policyVersion !== state.policyVersion ||
      !isUuidV7(input.lifecycleEventId) ||
      !isUuidV7(input.commandId) ||
      maxAccessClass(fact.accessClass, input.target.subjectAccessClass) !== fact.accessClass ||
      !sameSortedIds(fact.supportingClaimIds, state.replacementClaimIds)
    ) {
      throw new TruthLedgerConflictError();
    }

    await this.terminalizePrelockedFact(input.target, "superseded", input.commandId);
    await this.guardLifecycleDatabaseOperation(() =>
      this.insertAcceptedFact({
        fact,
        commandId: input.commandId,
        confidenceDecision: fact.confidenceDecision,
        useTransactionTimestamp: true
      })
    );
    await this.insertFactLifecycleEvent({
      target: input.target,
      lifecycleEventId: input.lifecycleEventId,
      successorFactId: fact.id,
      transitionKind: "supersede",
      toStatus: "superseded",
      reason,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      policyVersion: input.policyVersion,
      commandId: input.commandId
    });
    this.postAuthorizationCurrentFacts.delete(input.target);
    this.prelockedCurrentFacts.delete(prelockedTarget);
    return {
      factId: input.target.factId,
      version: 2,
      status: "superseded",
      replacementFactId: fact.id,
      replacementFactVersion: 1,
      replacementFactStatus: "current"
    };
  }

  async revokePrelockedFact(input: {
    target: PostAuthorizationCurrentFact;
    lifecycleEventId: string;
    commandId: string;
    reason: RevokeReason;
    actorUserId: string;
    actorMembershipId: string;
    policyVersion: string;
  }): Promise<RevokedFactResult> {
    const { prelockedTarget, prelockedState: state } = this.requirePostAuthorizationCurrentFact(
      input.target
    );
    const reason = parseLifecycleReason("revoke", input.reason);
    if (
      input.actorUserId !== state.actorUserId ||
      input.actorMembershipId !== state.actorMembershipId ||
      input.policyVersion !== state.policyVersion ||
      !isUuidV7(input.lifecycleEventId) ||
      !isUuidV7(input.commandId)
    ) {
      throw new TruthLedgerConflictError();
    }
    await this.terminalizePrelockedFact(input.target, "revoked", input.commandId);
    await this.insertFactLifecycleEvent({
      target: input.target,
      lifecycleEventId: input.lifecycleEventId,
      transitionKind: "revoke",
      toStatus: "revoked",
      reason,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      policyVersion: input.policyVersion,
      commandId: input.commandId
    });
    this.postAuthorizationCurrentFacts.delete(input.target);
    this.prelockedCurrentFacts.delete(prelockedTarget);
    return { factId: input.target.factId, version: 2, status: "revoked" };
  }

  async lockFirstAcceptanceSlot(input: {
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    subjectType: "activity" | "initiative";
    subjectId: string;
    predicate: string;
  }): Promise<void> {
    await this.lockTruthCoordinate(input);
    const prior = await this.tx.query<{ id: string }>(
      `SELECT id
       FROM truth.accepted_facts
       WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
         AND subject_type = $4 AND subject_id = $5 AND predicate = $6
       LIMIT 1`,
      [
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.subjectType,
        input.subjectId,
        input.predicate
      ]
    );
    if (prior.rows.length !== 0) throw new TruthLedgerConflictError();
  }

  async lockPrimaryObjectiveProposalSlot(input: {
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    subjectId: string;
    expectedLatestClaim:
      | { kind: "empty" }
      | {
          kind: "claim";
          claimId: string;
          expectedVersion: number;
          expectedStatus: "proposed" | "accepted" | "rejected" | "superseded";
        };
  }): Promise<void> {
    const coordinate = {
      ...input,
      subjectType: "initiative" as const,
      predicate: "initiative.primary_objective"
    };
    await this.lockTruthCoordinate(coordinate);
    const latest = await this.tx.query<{ id: string; version: number; status: string }>(
      `SELECT id, version, status
       FROM truth.claims
       WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
         AND subject_type = 'initiative' AND subject_id = $4 AND predicate = $5
       ORDER BY created_at DESC, id DESC LIMIT 1
       FOR SHARE`,
      [input.tenantId, input.workspaceId, input.spaceId, input.subjectId, coordinate.predicate]
    );
    const latestClaim = latest.rows[0];
    if (
      (input.expectedLatestClaim.kind === "empty" && latestClaim !== undefined) ||
      (input.expectedLatestClaim.kind === "claim" &&
        (!latestClaim ||
          latestClaim.id !== input.expectedLatestClaim.claimId ||
          latestClaim.version !== input.expectedLatestClaim.expectedVersion ||
          latestClaim.status !== input.expectedLatestClaim.expectedStatus))
    ) {
      throw new TruthLedgerConflictError();
    }
    const occupied = await this.tx.query<{ occupied: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM truth.accepted_facts
         WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
           AND subject_type = 'initiative' AND subject_id = $4 AND predicate = $5
           AND status IN ('current', 'contested')
       ) OR EXISTS (
         SELECT 1 FROM truth.claims
         WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
           AND subject_type = 'initiative' AND subject_id = $4 AND predicate = $5
           AND status = 'proposed'
       ) AS occupied`,
      [input.tenantId, input.workspaceId, input.spaceId, input.subjectId, coordinate.predicate]
    );
    if (occupied.rows[0]?.occupied !== false) throw new TruthLedgerConflictError();
  }

  private requirePrelockedCurrentFact(target: PrelockedCurrentFact): PrelockedCurrentFactState {
    const state = this.prelockedCurrentFacts.get(target);
    if (!state || target[prelockedCurrentFactBrand] !== true) {
      throw new TruthLedgerConflictError();
    }
    return state;
  }

  private requirePostAuthorizationCurrentFact(
    target: PostAuthorizationCurrentFact
  ): PostAuthorizationCurrentFactState {
    const state = this.postAuthorizationCurrentFacts.get(target);
    if (
      !state ||
      target[postAuthorizationCurrentFactBrand] !== true ||
      state.prelockedState.postAuthorizationTarget !== target ||
      this.prelockedCurrentFacts.get(state.prelockedTarget) !== state.prelockedState
    ) {
      throw new TruthLedgerConflictError();
    }
    return state;
  }

  private async guardLifecycleDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TruthLedgerConflictError || error instanceof TruthLedgerInvariantError) {
        throw error;
      }
      throw new TruthLedgerInvariantError();
    }
  }

  private async terminalizePrelockedFact(
    target: PostAuthorizationCurrentFact,
    status: "superseded" | "revoked",
    commandId: string
  ): Promise<void> {
    const result = await this.guardLifecycleDatabaseOperation(() =>
      this.tx.query<{ id: string }>(
        `UPDATE truth.accepted_facts
         SET status = $5, version = version + 1,
             last_causation_command_id = $6, updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND version = $4
           AND status = 'current' AND space_id = $7 AND subject_type = $8
           AND subject_id = $9 AND predicate = $10
         RETURNING id`,
        [
          target.tenantId,
          target.workspaceId,
          target.factId,
          target.version,
          status,
          commandId,
          target.spaceId,
          target.subjectType,
          target.subjectId,
          target.predicate
        ]
      )
    );
    if (result.rows.length !== 1 || result.rows[0]?.id !== target.factId) {
      throw new TruthLedgerConflictError();
    }
  }

  private async insertFactLifecycleEvent(input: {
    target: PostAuthorizationCurrentFact;
    lifecycleEventId: string;
    successorFactId?: string;
    transitionKind: "supersede" | "revoke";
    toStatus: "superseded" | "revoked";
    reason: SupersedeReason | RevokeReason;
    actorUserId: string;
    actorMembershipId: string;
    policyVersion: string;
    commandId: string;
  }): Promise<void> {
    await this.guardLifecycleDatabaseOperation(() =>
      this.tx.query(
        `INSERT INTO truth.fact_lifecycle_events (
           id, tenant_id, workspace_id, space_id,
           predecessor_fact_id, successor_fact_id,
           transition_kind, from_status, to_status,
           reason_code, reason_rationale, authority_basis, policy_version,
           acted_by_user_id, acted_by_membership_id, causation_command_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,'current',$8,$9,$10,$11,$12,$13,$14,$15
         )`,
        [
          input.lifecycleEventId,
          input.target.tenantId,
          input.target.workspaceId,
          input.target.spaceId,
          input.target.factId,
          input.successorFactId ?? null,
          input.transitionKind,
          input.toStatus,
          input.reason.code,
          input.reason.rationale,
          input.target.authorityBasis,
          input.policyVersion,
          input.actorUserId,
          input.actorMembershipId,
          input.commandId
        ]
      )
    );
  }

  private async lockTruthCoordinate(input: {
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    subjectType: "activity" | "initiative";
    subjectId: string;
    predicate: string;
  }): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.tenantId}/${input.workspaceId}/${input.spaceId}/${input.subjectType}/${input.subjectId}/${input.predicate}`
    ]);
  }

  async insertAcceptedFact(input: {
    fact: NewlyAcceptedFact;
    commandId: string;
    confidenceDecision: AcceptedFactConfidenceResult;
    useTransactionTimestamp?: boolean;
  }): Promise<void> {
    if (!isAcceptedFact(input.fact)) throw new TruthLedgerInvariantError();
    const fact = input.fact;
    const valueHash = sha256CanonicalText(fact.canonicalValue);
    await this.tx.query(
      `INSERT INTO truth.accepted_facts (
         id, tenant_id, workspace_id, space_id, subject_type, subject_id,
         predicate_catalog_version, predicate, canonical_value_text, value_hash, normalized_text,
         confidence, confidence_rule, strongest_supporting_confidence, human_lowered,
         confidence_lowering_reason_code, confidence_lowering_rationale,
         valid_from, valid_to, recorded_at, status, access_class,
         accepted_by_user_id, accepted_by_membership_id, acceptance_scope, authority_basis,
         acceptance_policy_version, last_causation_command_id, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'truth-predicate-catalog.v1',$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,
         CASE WHEN $28::boolean THEN transaction_timestamp() ELSE $19::timestamptz END,
         'current',$20,$21,$22,$23,$24,$25,$26,
         CASE WHEN $28::boolean THEN transaction_timestamp() ELSE $27::timestamptz END,
         CASE WHEN $28::boolean THEN transaction_timestamp() ELSE $27::timestamptz END
       )`,
      [
        fact.id,
        fact.tenantId,
        fact.workspaceId,
        fact.spaceId,
        fact.subjectType,
        fact.subjectId,
        fact.predicate,
        fact.canonicalValue,
        valueHash,
        fact.normalizedText,
        fact.confidence,
        input.confidenceDecision.rule,
        input.confidenceDecision.strongestSupportingConfidence,
        input.confidenceDecision.humanLowered,
        input.confidenceDecision.lowering?.reason.code ?? null,
        input.confidenceDecision.lowering?.reason.rationale ?? null,
        fact.validFrom ?? null,
        fact.validTo ?? null,
        fact.recordedAt,
        fact.accessClass,
        fact.acceptedByUserId,
        fact.acceptedByMembershipId,
        fact.acceptanceScope,
        fact.authorityBasis,
        fact.policyVersion,
        input.commandId,
        fact.createdAt,
        input.useTransactionTimestamp === true
      ]
    );
    for (const claimId of fact.supportingClaimIds) {
      await this.tx.query(
        `INSERT INTO truth.fact_claims (
           tenant_id, workspace_id, space_id, fact_id, claim_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [fact.tenantId, fact.workspaceId, fact.spaceId, fact.id, claimId]
      );
    }
    const changed = await this.tx.query<{ id: string }>(
      `UPDATE truth.claims
       SET status = 'accepted', version = version + 1,
           updated_at = CASE WHEN $5::boolean
             THEN transaction_timestamp() ELSE $4::timestamptz END
       WHERE tenant_id = $1 AND workspace_id = $2
         AND id = ANY($3::uuid[]) AND status = 'proposed'
       RETURNING id`,
      [
        fact.tenantId,
        fact.workspaceId,
        [...fact.supportingClaimIds],
        fact.createdAt,
        input.useTransactionTimestamp === true
      ]
    );
    if (changed.rows.length !== fact.supportingClaimIds.length) {
      throw new TruthLedgerConflictError();
    }
  }

  async relayPrincipalForSpace(
    tenantId: string,
    workspaceId: string,
    spaceId: string
  ): Promise<string> {
    const result = await this.tx.query<{ id: string }>(
      `SELECT principal.id
       FROM identity.service_principals principal
       JOIN access.access_relationships grant_record
         ON grant_record.tenant_id = principal.tenant_id
        AND grant_record.workspace_id = principal.workspace_id
        AND grant_record.subject_type = 'service_principal'
        AND grant_record.subject_id = principal.id
        AND grant_record.relation = 'manager'
        AND grant_record.resource_type = 'space'
        AND grant_record.resource_id = $3
       WHERE principal.tenant_id = $1 AND principal.workspace_id = $2
         AND principal.purpose = 'product_notification_relay'
         AND principal.status = 'active'
       LIMIT 2
       FOR SHARE OF principal, grant_record`,
      [tenantId, workspaceId, spaceId]
    );
    if (result.rows.length !== 1) throw new TruthLedgerInvariantError();
    return result.rows[0]!.id;
  }
}

export function sha256CanonicalText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isCanonicalTruthCoordinate(row: FactLifecycleHeaderRow): boolean {
  return (
    typeof row.space_id === "string" &&
    typeof row.subject_id === "string" &&
    ((row.subject_type === "activity" && row.predicate === "activity.outcome") ||
      (row.subject_type === "initiative" && row.predicate === "initiative.primary_objective"))
  );
}

function lifecycleAuthorityMatchesCoordinate(row: LockedCurrentFactRow): boolean {
  return (
    (row.subject_type === "activity" &&
      row.predicate === "activity.outcome" &&
      row.acceptance_scope === "engagement" &&
      row.authority_basis === "activity_owner") ||
    (row.subject_type === "initiative" &&
      row.predicate === "initiative.primary_objective" &&
      row.acceptance_scope === "initiative" &&
      row.authority_basis === "initiative_owner")
  );
}

function isUuidV7(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isCanonicalUuidReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isAccessClass(value: unknown): value is AccessClass {
  return ["public", "workspace", "restricted", "confidential"].includes(value as string);
}

function isSafeReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
}

function sameSortedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function parseLifecycleReason(kind: "supersede", input: unknown): SupersedeReason;
function parseLifecycleReason(kind: "revoke", input: unknown): RevokeReason;
function parseLifecycleReason(
  kind: "supersede" | "revoke",
  input: unknown
): SupersedeReason | RevokeReason {
  try {
    return kind === "supersede"
      ? parseTruthLifecycleReason("supersede", input)
      : parseTruthLifecycleReason("revoke", input);
  } catch {
    throw new TruthLedgerConflictError();
  }
}
