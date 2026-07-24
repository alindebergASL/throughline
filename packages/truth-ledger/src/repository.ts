import {
  canonicalJsonStringify,
  type AccessClass,
  type ClaimSourceSpanCandidate,
  type Confidence
} from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import { createHash } from "node:crypto";
import type { AcceptedFactConfidenceResult } from "./confidence.js";
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
}

export interface PersistedClaimForAcceptance {
  claim: Omit<Claim, "sourceSpan">;
  evidence: ClaimSourceSpanCandidate;
  evidenceSpanId: string;
  sourceArtifactId: string;
  claimVersion: number;
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
  value_json: string;
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
  constructor(private readonly tx: TenantDbTransaction) {}

  async transactionTimestamp(): Promise<string> {
    const result = await this.tx.query<{ now: Date }>(
      "SELECT date_trunc('milliseconds', clock_timestamp()) AS now"
    );
    const now = result.rows[0]?.now;
    if (!now) throw new TruthLedgerInvariantError();
    return now.toISOString();
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
       FOR SHARE OF source, activity_source, activity, space`,
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
       ORDER BY chunk_index
       FOR SHARE`,
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
    commandId: string;
    actorUserId: string;
    actorMembershipId: string;
    assertedById: string;
    predicate: "activity.outcome" | "initiative.primary_objective";
    valueJson: string;
    normalizedText: string;
    confidence: Confidence;
    validFrom?: string;
    validTo?: string;
    observedAt?: string;
    evidence: VerifiedClaimSourceSpan;
  }): Promise<void> {
    const valueHash = sha256Canonical(input.valueJson);
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
         predicate_catalog_version, predicate, value_json, value_hash, normalized_text,
         verified_evidence_span_id, asserted_by_type, asserted_by_id, confidence,
         valid_from, valid_to, observed_at, status, access_class,
         created_by_user_id, created_by_membership_id, causation_command_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'truth-predicate-catalog.v1',$7,$8::jsonb,$9,$10,
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
        canonicalJsonStringify(input.valueJson),
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
  }

  async lockClaimSupportHeaders(
    tenantId: string,
    workspaceId: string,
    claimIds: readonly string[]
  ): Promise<ClaimSupportHeader[]> {
    const result = await this.tx.query<{
      claim_id: string;
      evidence_span_id: string;
      source_artifact_id: string;
      space_id: string;
    }>(
      `SELECT claim.id AS claim_id, span.id AS evidence_span_id,
              span.source_artifact_id, claim.space_id
       FROM truth.claims claim
       JOIN truth.verified_evidence_spans span
         ON span.tenant_id = claim.tenant_id
        AND span.workspace_id = claim.workspace_id
        AND span.space_id = claim.space_id
        AND span.id = claim.verified_evidence_span_id
       WHERE claim.tenant_id = $1 AND claim.workspace_id = $2
         AND claim.id = ANY($3::uuid[])
       ORDER BY claim.id
       FOR SHARE OF claim, span`,
      [tenantId, workspaceId, [...claimIds].sort()]
    );
    if (result.rows.length !== claimIds.length) throw new TruthLedgerInvariantError();
    return result.rows.map((row) => ({
      claimId: row.claim_id,
      evidenceSpanId: row.evidence_span_id,
      sourceArtifactId: row.source_artifact_id,
      spaceId: row.space_id
    }));
  }

  async loadClaimsForAcceptance(
    tenantId: string,
    workspaceId: string,
    claimIds: readonly string[]
  ): Promise<PersistedClaimForAcceptance[]> {
    const result = await this.tx.query<AcceptanceRow>(
      `SELECT claim.id, claim.space_id, claim.subject_type, claim.subject_id,
              claim.predicate, claim.value_json #>> '{}' AS value_json,
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
       ORDER BY claim.id
       FOR UPDATE OF claim
       FOR SHARE OF span, source, chunk`,
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
        valueJson: row.value_json,
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

  async lockFirstAcceptanceSlot(input: {
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
    const prior = await this.tx.query<{ id: string }>(
      `SELECT id
       FROM truth.accepted_facts
       WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
         AND subject_type = $4 AND subject_id = $5 AND predicate = $6
       LIMIT 1
       FOR UPDATE`,
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

  async insertAcceptedFact(input: {
    fact: NewlyAcceptedFact;
    commandId: string;
    confidenceDecision: AcceptedFactConfidenceResult;
  }): Promise<void> {
    if (!isAcceptedFact(input.fact)) throw new TruthLedgerInvariantError();
    const fact = input.fact;
    const valueHash = sha256Canonical(fact.valueJson);
    await this.tx.query(
      `INSERT INTO truth.accepted_facts (
         id, tenant_id, workspace_id, space_id, subject_type, subject_id,
         predicate_catalog_version, predicate, value_json, value_hash, normalized_text,
         confidence, confidence_rule, strongest_supporting_confidence, human_lowered,
         confidence_lowering_reason_code, confidence_lowering_rationale,
         valid_from, valid_to, recorded_at, status, access_class,
         accepted_by_user_id, accepted_by_membership_id, acceptance_scope, authority_basis,
         acceptance_policy_version, last_causation_command_id, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'truth-predicate-catalog.v1',$7,$8::jsonb,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,'current',$20,$21,$22,$23,$24,$25,$26,$27,$27
       )`,
      [
        fact.id,
        fact.tenantId,
        fact.workspaceId,
        fact.spaceId,
        fact.subjectType,
        fact.subjectId,
        fact.predicate,
        canonicalJsonStringify(fact.valueJson),
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
        fact.createdAt
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
       SET status = 'accepted', version = version + 1, updated_at = $4::timestamptz
       WHERE tenant_id = $1 AND workspace_id = $2
         AND id = ANY($3::uuid[]) AND status = 'proposed'
       RETURNING id`,
      [fact.tenantId, fact.workspaceId, [...fact.supportingClaimIds], fact.createdAt]
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

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex");
}
