import type { AccessClass, ManualSourceType } from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import {
  canReadAccessClass,
  maxAccessClass,
  type DeterministicSourceChunk,
  type NormalizedSourceText
} from "./source-text.js";

export type HashRetentionPolicy = "retain" | "erase_on_tombstone";

export interface SourceArtifactProjection {
  id: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  sourceType: ManualSourceType;
  trustClass: "untrusted_user_content";
  title?: string;
  immutableText?: string;
  contentHash?: string;
  normalizedContentHash?: string;
  hashRetentionPolicy: HashRetentionPolicy;
  supersedesSourceId?: string;
  accessClass: AccessClass;
  deletedAt?: string;
  deletionReason?: string;
  deletionPolicyRef?: string;
  hashDisposition?: "retained" | "erased";
  version: number;
  chunks: SourceChunkProjection[];
}

export interface SourceChunkProjection extends DeterministicSourceChunk {
  id: string;
  accessClass: AccessClass;
}

interface SourceArtifactRow {
  id: string;
  space_id: string;
  source_type: ManualSourceType;
  title: string | null;
  immutable_text: string | null;
  content_hash: string | null;
  normalized_content_hash: string | null;
  hash_retention_policy: HashRetentionPolicy;
  supersedes_source_id: string | null;
  access_class: AccessClass;
  deleted_at: Date | null;
  deletion_reason: string | null;
  deletion_policy_ref: string | null;
  hash_disposition: "retained" | "erased" | null;
  version: number;
}

export interface PersistSourceInput {
  sourceArtifactId: string;
  chunkIds: readonly string[];
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  sourceType: ManualSourceType;
  title?: string;
  source: NormalizedSourceText;
  chunks: readonly DeterministicSourceChunk[];
  capturedByUserId: string;
  capturedByMembershipId: string;
  accessClass: AccessClass;
  hashRetentionPolicy: HashRetentionPolicy;
  retentionPolicyId?: string;
  originContentItemId?: string;
  originContentRevision?: number;
  supersedesSourceId?: string;
  occurredAt?: string;
  activityId?: string;
}

export class ContentInvariantError extends Error {
  constructor(message = "Content transaction invariant failed") {
    super(message);
    this.name = "ContentInvariantError";
  }
}

export class ContentRepository {
  constructor(private readonly tx: TenantDbTransaction) {}

  async getContentItemScope(
    tenantId: string,
    workspaceId: string,
    contentItemId: string,
    lock = false
  ): Promise<{
    spaceId: string;
    title: string;
    accessClass: AccessClass;
    currentRevision: number;
    version: number;
  }> {
    const result = await this.tx.query<{
      space_id: string;
      title: string;
      access_class: AccessClass;
      current_revision: number;
      version: number;
    }>(
      `SELECT space_id, title, access_class, current_revision, version
       FROM content.content_items
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
       LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [tenantId, workspaceId, contentItemId]
    );
    const row = result.rows[0];
    if (!row) throw new ContentInvariantError("Content is unavailable");
    return {
      spaceId: row.space_id,
      title: row.title,
      accessClass: row.access_class,
      currentRevision: row.current_revision,
      version: row.version
    };
  }

  async createContent(input: {
    contentItemId: string;
    revisionId: string;
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    type: "page" | "note";
    title: string;
    body: string;
    ownerPersonId: string;
    accessClass: AccessClass;
    metadata: Record<string, unknown>;
    actorUserId: string;
    actorMembershipId: string;
  }): Promise<void> {
    await this.tx.query(
      `INSERT INTO content.content_items (
         id, tenant_id, workspace_id, space_id, type, title, owner_person_id,
         access_class, metadata, current_revision, version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,1,1)`,
      [
        input.contentItemId,
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.type,
        input.title,
        input.ownerPersonId,
        input.accessClass,
        JSON.stringify(input.metadata)
      ]
    );
    await this.insertContentRevision({
      ...input,
      revisionNumber: 1
    });
  }

  async reviseContent(input: {
    revisionId: string;
    tenantId: string;
    workspaceId: string;
    contentItemId: string;
    expectedRevision: number;
    title?: string;
    body: string;
    metadata?: Record<string, unknown>;
    actorUserId: string;
    actorMembershipId: string;
  }): Promise<{ spaceId: string; revisionNumber: number; version: number }> {
    const item = await this.tx.query<{
      space_id: string;
      title: string;
      owner_person_id: string;
      access_class: AccessClass;
      metadata: Record<string, unknown>;
      version: number;
    }>(
      `SELECT space_id, title, owner_person_id, access_class, metadata, version
       FROM content.content_items
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND current_revision = $4
       LIMIT 1 FOR UPDATE`,
      [input.tenantId, input.workspaceId, input.contentItemId, input.expectedRevision]
    );
    const current = item.rows[0];
    if (!current) throw new ContentInvariantError("Content revision precondition failed");
    const revisionNumber = input.expectedRevision + 1;
    const title = input.title ?? current.title;
    const metadata = input.metadata ?? current.metadata;
    const updated = await this.tx.query<{ version: number }>(
      `UPDATE content.content_items SET title = $5, metadata = $6::jsonb,
         current_revision = $4 + 1, version = version + 1, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND current_revision = $4
       RETURNING version`,
      [
        input.tenantId,
        input.workspaceId,
        input.contentItemId,
        input.expectedRevision,
        title,
        JSON.stringify(metadata)
      ]
    );
    const version = updated.rows[0]?.version;
    if (!version) throw new ContentInvariantError("Content revision precondition failed");
    await this.insertContentRevision({
      revisionId: input.revisionId,
      contentItemId: input.contentItemId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      spaceId: current.space_id,
      title,
      body: input.body,
      metadata,
      accessClass: current.access_class,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      revisionNumber
    });
    return { spaceId: current.space_id, revisionNumber, version };
  }

  async persistSource(input: PersistSourceInput): Promise<void> {
    if (input.chunkIds.length !== input.chunks.length || input.chunks.length < 1) {
      throw new ContentInvariantError();
    }
    await this.tx.query(
      `INSERT INTO content.source_artifacts (
         id, tenant_id, workspace_id, space_id, source_type, trust_class, title,
         immutable_text, object_key, content_hash, normalization_version, chunking_version,
         normalized_content_hash, hash_retention_policy,
         origin_content_item_id, origin_content_revision, supersedes_source_id,
         captured_by_user_id, captured_by_membership_id, occurred_at, access_class,
         source_snapshot_policy, retention_policy_id, version
       ) VALUES ($1,$2,$3,$4,$5,'untrusted_user_content',$6,$7,NULL,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,'full_snapshot',$20,1)`,
      [
        input.sourceArtifactId,
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.sourceType,
        input.title ?? null,
        input.source.capturedText,
        input.source.contentHash,
        input.source.normalizationVersion,
        input.chunks[0]!.chunkingVersion,
        input.source.normalizedContentHash,
        input.hashRetentionPolicy,
        input.originContentItemId ?? null,
        input.originContentRevision ?? null,
        input.supersedesSourceId ?? null,
        input.capturedByUserId,
        input.capturedByMembershipId,
        input.occurredAt ?? null,
        input.accessClass,
        input.retentionPolicyId ?? null
      ]
    );
    for (const [index, chunk] of input.chunks.entries()) {
      await this.insertOrVerifyChunk(input, input.chunkIds[index]!, chunk);
    }
    if (input.activityId) {
      await this.tx.query(
        `INSERT INTO work.activity_sources
         (tenant_id, workspace_id, space_id, activity_id, source_artifact_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, input.workspaceId, input.spaceId, input.activityId, input.sourceArtifactId]
      );
    }
  }

  async lockSource(
    tenantId: string,
    workspaceId: string,
    sourceArtifactId: string
  ): Promise<SourceArtifactProjection> {
    await this.tx.query(
      `SELECT id FROM content.source_artifacts
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 LIMIT 1 FOR UPDATE`,
      [tenantId, workspaceId, sourceArtifactId]
    );
    return this.getSource(tenantId, workspaceId, sourceArtifactId, true);
  }

  async resolveSourceActivityLinkForCorrection(
    tenantId: string,
    workspaceId: string,
    sourceArtifactId: string
  ): Promise<{ spaceId: string; activityId: string }> {
    const result = await this.tx.query<{ space_id: string; activity_id: string }>(
      `SELECT space_id, activity_id FROM work.activity_sources
       WHERE tenant_id = $1 AND workspace_id = $2 AND source_artifact_id = $3
       ORDER BY activity_id LIMIT 2`,
      [tenantId, workspaceId, sourceArtifactId]
    );
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) {
      throw new ContentInvariantError("Source Activity link is unavailable");
    }
    return { spaceId: row.space_id, activityId: row.activity_id };
  }

  async lockCurrentSourceForCorrection(
    tenantId: string,
    workspaceId: string,
    governingSpaceId: string,
    sourceArtifactId: string
  ): Promise<SourceArtifactProjection> {
    const locked = await this.tx.query<{ id: string }>(
      `SELECT predecessor.id FROM content.source_artifacts predecessor
       WHERE predecessor.tenant_id = $1 AND predecessor.workspace_id = $2
         AND predecessor.space_id = $3 AND predecessor.id = $4
         AND predecessor.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM content.source_artifacts successor
           WHERE successor.tenant_id = predecessor.tenant_id
             AND successor.workspace_id = predecessor.workspace_id
             AND successor.supersedes_source_id = predecessor.id
         )
       LIMIT 1 FOR UPDATE OF predecessor`,
      [tenantId, workspaceId, governingSpaceId, sourceArtifactId]
    );
    if (!locked.rows[0]) {
      throw new ContentInvariantError("Source correction predecessor is unavailable");
    }
    const current = await this.tx.query<SourceArtifactRow>(
      `SELECT predecessor.id, predecessor.space_id, predecessor.source_type,
              predecessor.title, predecessor.immutable_text, predecessor.content_hash,
              predecessor.normalized_content_hash, predecessor.hash_retention_policy,
              predecessor.supersedes_source_id, predecessor.access_class,
              predecessor.deleted_at, predecessor.deletion_reason,
              predecessor.deletion_policy_ref, predecessor.hash_disposition,
              predecessor.version
       FROM content.source_artifacts predecessor
       WHERE predecessor.tenant_id = $1 AND predecessor.workspace_id = $2
         AND predecessor.space_id = $3 AND predecessor.id = $4
         AND predecessor.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM content.source_artifacts successor
           WHERE successor.tenant_id = predecessor.tenant_id
             AND successor.workspace_id = predecessor.workspace_id
             AND successor.supersedes_source_id = predecessor.id
         )
       LIMIT 1`,
      [tenantId, workspaceId, governingSpaceId, sourceArtifactId]
    );
    const row = current.rows[0];
    if (!row) {
      throw new ContentInvariantError("Source correction predecessor is unavailable");
    }
    return this.projectSource(tenantId, workspaceId, row, false, []);
  }

  async revalidateSourceActivityLinkForCorrection(input: {
    tenantId: string;
    workspaceId: string;
    governingSpaceId: string;
    activityId: string;
    sourceArtifactId: string;
  }): Promise<void> {
    const result = await this.tx.query<{ activity_id: string }>(
      `SELECT activity_id FROM work.activity_sources
       WHERE tenant_id = $1 AND workspace_id = $2 AND space_id = $3
         AND activity_id = $4 AND source_artifact_id = $5
       LIMIT 1`,
      [
        input.tenantId,
        input.workspaceId,
        input.governingSpaceId,
        input.activityId,
        input.sourceArtifactId
      ]
    );
    if (result.rows.length !== 1) {
      throw new ContentInvariantError("Source Activity link is unavailable");
    }
  }

  async getSource(
    tenantId: string,
    workspaceId: string,
    sourceArtifactId: string,
    includeText: boolean
  ): Promise<SourceArtifactProjection> {
    const artifact = await this.tx.query<SourceArtifactRow>(
      `SELECT id, space_id, source_type, title, immutable_text, content_hash,
              normalized_content_hash, hash_retention_policy, supersedes_source_id,
              access_class, deleted_at, deletion_reason, deletion_policy_ref,
              hash_disposition, version
       FROM content.source_artifacts
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 LIMIT 1`,
      [tenantId, workspaceId, sourceArtifactId]
    );
    const row = artifact.rows[0];
    if (!row) throw new ContentInvariantError("Source is unavailable");
    const chunks =
      row.deleted_at || !includeText
        ? []
        : await this.getChunks(tenantId, workspaceId, sourceArtifactId);
    return this.projectSource(tenantId, workspaceId, row, includeText, chunks);
  }

  private projectSource(
    tenantId: string,
    workspaceId: string,
    row: SourceArtifactRow,
    includeText: boolean,
    chunks: SourceChunkProjection[]
  ): SourceArtifactProjection {
    return {
      id: row.id,
      tenantId,
      workspaceId,
      spaceId: row.space_id,
      sourceType: row.source_type,
      trustClass: "untrusted_user_content",
      ...(row.title === null ? {} : { title: row.title }),
      ...(includeText && row.immutable_text !== null ? { immutableText: row.immutable_text } : {}),
      ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
      ...(row.normalized_content_hash === null
        ? {}
        : { normalizedContentHash: row.normalized_content_hash }),
      hashRetentionPolicy: row.hash_retention_policy,
      ...(row.supersedes_source_id === null
        ? {}
        : { supersedesSourceId: row.supersedes_source_id }),
      accessClass: row.access_class,
      ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at.toISOString() }),
      ...(row.deletion_reason === null ? {} : { deletionReason: row.deletion_reason }),
      ...(row.deletion_policy_ref === null ? {} : { deletionPolicyRef: row.deletion_policy_ref }),
      ...(row.hash_disposition === null ? {} : { hashDisposition: row.hash_disposition }),
      version: row.version,
      chunks
    };
  }

  async listActivitySources(input: {
    tenantId: string;
    workspaceId: string;
    activityId: string;
    activitySpaceId: string;
    permittedSourceSpaceIds: readonly string[];
    dataClassCeiling: AccessClass;
  }): Promise<SourceArtifactProjection[]> {
    if (input.permittedSourceSpaceIds.length === 0) return [];
    const ids = await this.tx.query<{ id: string }>(
      `SELECT source.id
       FROM work.activity_sources link
       JOIN content.source_artifacts source
         ON source.tenant_id = link.tenant_id AND source.workspace_id = link.workspace_id
        AND source.id = link.source_artifact_id
       JOIN access.spaces source_space
         ON source_space.tenant_id = source.tenant_id
        AND source_space.workspace_id = source.workspace_id AND source_space.id = source.space_id
       WHERE link.tenant_id = $1 AND link.workspace_id = $2 AND link.activity_id = $3
         AND link.space_id = $4 AND source.space_id = ANY($5::uuid[])
         AND GREATEST(
           CASE source.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1
             WHEN 'restricted' THEN 2 ELSE 3 END,
           CASE source_space.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1
             WHEN 'restricted' THEN 2 ELSE 3 END
         ) <= $6
       ORDER BY link.created_at, source.id`,
      [
        input.tenantId,
        input.workspaceId,
        input.activityId,
        input.activitySpaceId,
        input.permittedSourceSpaceIds,
        accessRank(input.dataClassCeiling)
      ]
    );
    return Promise.all(
      ids.rows.map(({ id }) => this.getSource(input.tenantId, input.workspaceId, id, true))
    );
  }

  async resolveCurrentSource(
    tenantId: string,
    workspaceId: string,
    sourceArtifactId: string
  ): Promise<SourceArtifactProjection> {
    const result = await this.tx.query<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, 0 AS depth FROM content.source_artifacts
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         UNION ALL
         SELECT successor.id, chain.depth + 1
         FROM chain JOIN content.source_artifacts successor
           ON successor.tenant_id = $1 AND successor.workspace_id = $2
          AND successor.supersedes_source_id = chain.id
       )
       SELECT chain.id FROM chain
       WHERE NOT EXISTS (SELECT 1 FROM content.source_artifacts successor
         WHERE successor.tenant_id = $1 AND successor.workspace_id = $2
           AND successor.supersedes_source_id = chain.id)
       ORDER BY chain.depth DESC LIMIT 1`,
      [tenantId, workspaceId, sourceArtifactId]
    );
    const leaf = result.rows[0];
    if (!leaf) throw new ContentInvariantError("Source is unavailable");
    return this.getSource(tenantId, workspaceId, leaf.id, true);
  }

  async tombstoneSource(input: {
    tenantId: string;
    workspaceId: string;
    sourceArtifactId: string;
    expectedVersion: number;
    deletionReasonCategory: string;
    deletionPolicyRef: string;
  }): Promise<{ spaceId: string; version: number; hashDisposition: "retained" | "erased" }> {
    const locked = await this.tx.query<{
      space_id: string;
      hash_retention_policy: HashRetentionPolicy;
    }>(
      `SELECT space_id, hash_retention_policy FROM content.source_artifacts
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         AND version = $4 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [input.tenantId, input.workspaceId, input.sourceArtifactId, input.expectedVersion]
    );
    const row = locked.rows[0];
    if (!row) throw new ContentInvariantError("Source tombstone precondition failed");
    const hashDisposition = row.hash_retention_policy === "retain" ? "retained" : "erased";
    const updated = await this.tx.query<{ version: number }>(
      `UPDATE content.source_artifacts
       SET immutable_text = NULL, object_key = NULL,
           content_hash = CASE WHEN hash_retention_policy = 'retain' THEN content_hash ELSE NULL END,
           normalized_content_hash = CASE WHEN hash_retention_policy = 'retain'
             THEN normalized_content_hash ELSE NULL END,
           deleted_at = clock_timestamp(), deletion_reason = $5, deletion_policy_ref = $6,
           hash_disposition = $7, version = version + 1, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         AND version = $4 AND deleted_at IS NULL RETURNING version`,
      [
        input.tenantId,
        input.workspaceId,
        input.sourceArtifactId,
        input.expectedVersion,
        input.deletionReasonCategory,
        input.deletionPolicyRef,
        hashDisposition
      ]
    );
    if (!updated.rows[0]) throw new ContentInvariantError("Source tombstone precondition failed");
    await this.tx.query(
      `DELETE FROM content.source_chunks
       WHERE tenant_id = $1 AND workspace_id = $2 AND source_artifact_id = $3`,
      [input.tenantId, input.workspaceId, input.sourceArtifactId]
    );
    return { spaceId: row.space_id, version: updated.rows[0].version, hashDisposition };
  }

  static deriveHashRetentionPolicy(retentionPolicyId: string | undefined): HashRetentionPolicy {
    return retentionPolicyId === "erase_on_tombstone" ||
      retentionPolicyId?.startsWith("erase_on_tombstone:")
      ? "erase_on_tombstone"
      : "retain";
  }

  static deriveSourceAccessClass(
    spaceClass: AccessClass,
    requested: AccessClass | undefined,
    predecessor?: AccessClass
  ): AccessClass {
    return maxAccessClass(spaceClass, requested ?? spaceClass, predecessor ?? spaceClass);
  }

  static canProjectSource(ceiling: AccessClass, effectiveClass: AccessClass): boolean {
    return canReadAccessClass(ceiling, effectiveClass);
  }

  private async insertContentRevision(input: {
    revisionId: string;
    contentItemId: string;
    tenantId: string;
    workspaceId: string;
    spaceId: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
    accessClass: AccessClass;
    actorUserId: string;
    actorMembershipId: string;
    revisionNumber: number;
  }): Promise<void> {
    await this.tx.query(
      `INSERT INTO content.content_revisions (
         id, tenant_id, workspace_id, space_id, content_item_id, revision_number,
         title, body, metadata, access_class, created_by_user_id, created_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
      [
        input.revisionId,
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.contentItemId,
        input.revisionNumber,
        input.title,
        input.body,
        JSON.stringify(input.metadata),
        input.accessClass,
        input.actorUserId,
        input.actorMembershipId
      ]
    );
  }

  private async insertOrVerifyChunk(
    source: PersistSourceInput,
    chunkId: string,
    chunk: DeterministicSourceChunk
  ): Promise<void> {
    const inserted = await this.tx.query<{ id: string }>(
      `INSERT INTO content.source_chunks (
         id, tenant_id, workspace_id, space_id, source_artifact_id,
         normalization_version, chunking_version, chunk_index,
         start_offset, end_offset, normalized_text, content_hash, access_class
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (
         tenant_id, workspace_id, source_artifact_id,
         normalization_version, chunking_version, chunk_index
       ) DO NOTHING RETURNING id`,
      [
        chunkId,
        source.tenantId,
        source.workspaceId,
        source.spaceId,
        source.sourceArtifactId,
        chunk.normalizationVersion,
        chunk.chunkingVersion,
        chunk.chunkIndex,
        chunk.startOffset,
        chunk.endOffset,
        chunk.normalizedText,
        chunk.contentHash,
        source.accessClass
      ]
    );
    if (inserted.rows[0]) return;
    const existing = await this.tx.query<{
      id: string;
      space_id: string;
      start_offset: number;
      end_offset: number;
      normalized_text: string;
      content_hash: string;
      access_class: AccessClass;
    }>(
      `SELECT id, space_id, start_offset, end_offset, normalized_text, content_hash, access_class
       FROM content.source_chunks
       WHERE tenant_id = $1 AND workspace_id = $2 AND source_artifact_id = $3
         AND normalization_version = $4 AND chunking_version = $5 AND chunk_index = $6
       LIMIT 1 FOR UPDATE`,
      [
        source.tenantId,
        source.workspaceId,
        source.sourceArtifactId,
        chunk.normalizationVersion,
        chunk.chunkingVersion,
        chunk.chunkIndex
      ]
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.id !== chunkId ||
      row.space_id !== source.spaceId ||
      row.start_offset !== chunk.startOffset ||
      row.end_offset !== chunk.endOffset ||
      row.normalized_text !== chunk.normalizedText ||
      row.content_hash !== chunk.contentHash ||
      row.access_class !== source.accessClass
    ) {
      throw new ContentInvariantError("Source chunk logical-key payload mismatch");
    }
  }

  private async getChunks(
    tenantId: string,
    workspaceId: string,
    sourceArtifactId: string
  ): Promise<SourceChunkProjection[]> {
    const result = await this.tx.query<{
      id: string;
      chunk_index: number;
      start_offset: number;
      end_offset: number;
      normalized_text: string;
      content_hash: string;
      normalization_version: "source-normalization.v1";
      chunking_version: "source-chunking.v1";
      access_class: AccessClass;
    }>(
      `SELECT id, chunk_index, start_offset, end_offset, normalized_text, content_hash,
              normalization_version, chunking_version, access_class
       FROM content.source_chunks
       WHERE tenant_id = $1 AND workspace_id = $2 AND source_artifact_id = $3
       ORDER BY chunk_index`,
      [tenantId, workspaceId, sourceArtifactId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      normalizedText: row.normalized_text,
      contentHash: row.content_hash,
      normalizationVersion: row.normalization_version,
      chunkingVersion: row.chunking_version,
      accessClass: row.access_class
    }));
  }
}

function accessRank(value: AccessClass): number {
  return { public: 0, workspace: 1, restricted: 2, confidential: 3 }[value];
}
