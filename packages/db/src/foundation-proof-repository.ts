import type { SecurityContext } from "@throughline/core-types";
import type { TenantDbTransaction } from "./transaction.js";

export interface FoundationContextReferenceInsert {
  id: string;
  jobId: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  workerServicePrincipalId: string;
  delegatingUserId: string;
  delegatingMembershipId: string;
  policyVersionId: string;
  contextSnapshot: SecurityContext;
  issuedAt: Date;
  expiresAt: Date;
  signingKeyId: string;
}

export interface FoundationAggregateUpsert {
  id: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  proofKey: string;
  jobId: string;
}

export interface FoundationAggregateRecord {
  id: string;
  aggregateVersion: number;
}

export interface FoundationOutboxInsert {
  id: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  aggregateId: string;
  aggregateVersion: number;
  causationId: string;
  requestId: string;
  traceparent: string;
  tracestate?: string;
  jobId: string;
  relayServicePrincipalId: string;
  contextReferenceId: string;
  signedContextReference: string;
}

export async function insertFoundationContextReference(
  tx: TenantDbTransaction,
  input: FoundationContextReferenceInsert
): Promise<void> {
  await tx.query(
    `INSERT INTO ops.security_context_references (
       id, job_id, tenant_id, workspace_id, space_id, worker_service_principal_id,
       delegating_user_id, delegating_membership_id, policy_version_id, context_snapshot,
       issued_at, expires_at, status, signing_key_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, 'active', $13
     )`,
    [
      input.id,
      input.jobId,
      input.tenantId,
      input.workspaceId,
      input.spaceId,
      input.workerServicePrincipalId,
      input.delegatingUserId,
      input.delegatingMembershipId,
      input.policyVersionId,
      JSON.stringify(input.contextSnapshot),
      input.issuedAt,
      input.expiresAt,
      input.signingKeyId
    ]
  );
}

export async function upsertFoundationTestAggregate(
  tx: TenantDbTransaction,
  input: FoundationAggregateUpsert
): Promise<FoundationAggregateRecord> {
  const result = await tx.query<FoundationAggregateRecord>(
    `INSERT INTO ops.foundation_test_aggregates (
       id, tenant_id, workspace_id, space_id, proof_key, pending_job_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, workspace_id, space_id, proof_key)
     DO UPDATE SET
       pending_job_id = EXCLUDED.pending_job_id,
       aggregate_version = ops.foundation_test_aggregates.aggregate_version + 1,
       updated_at = clock_timestamp()
     RETURNING id, aggregate_version AS "aggregateVersion"`,
    [input.id, input.tenantId, input.workspaceId, input.spaceId, input.proofKey, input.jobId]
  );
  const aggregate = result.rows[0];
  if (!aggregate) throw new Error("Foundation aggregate write returned no row");
  return aggregate;
}

export async function insertFoundationOutboxEvent(
  tx: TenantDbTransaction,
  input: FoundationOutboxInsert
): Promise<void> {
  await tx.query(
    `INSERT INTO ops.outbox_events (
       id, event_type, tenant_id, workspace_id, space_id,
       aggregate_type, aggregate_id, aggregate_version,
       causation_id, request_id, traceparent, tracestate,
       job_id, relay_service_principal_id, context_reference_id, signed_context_reference
     ) VALUES (
       $1, 'foundation.proof.created.v1', $2, $3, $4,
       'foundation_test_aggregate', $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13, $14
     )`,
    [
      input.id,
      input.tenantId,
      input.workspaceId,
      input.spaceId,
      input.aggregateId,
      input.aggregateVersion,
      input.causationId,
      input.requestId,
      input.traceparent,
      input.tracestate ?? null,
      input.jobId,
      input.relayServicePrincipalId,
      input.contextReferenceId,
      input.signedContextReference
    ]
  );
}
