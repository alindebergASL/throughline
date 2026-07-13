import type { SecurityContext } from "@throughline/core-types";
import type { AsyncContextReferenceClaims } from "@throughline/tenancy";
import type { PgPoolClient } from "./client.js";

export interface WorkerBootstrapContextReference {
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
  issuedAt: Date | string;
  expiresAt: Date | string;
  status: "active";
  signingKeyId: string;
}

export type WorkerBootstrapContextReferenceRow = Omit<
  WorkerBootstrapContextReference,
  "contextSnapshot" | "status"
> & {
  contextSnapshot: unknown;
  status: string;
};

/** One fixed lookup. RLS supplies every scope predicate from verified transaction settings. */
export async function findWorkerBootstrapContextReference(
  client: PgPoolClient,
  claims: AsyncContextReferenceClaims
): Promise<WorkerBootstrapContextReferenceRow | null> {
  const result = await client.query<WorkerBootstrapContextReferenceRow>(
    `SELECT
       id,
       job_id AS "jobId",
       tenant_id AS "tenantId",
       workspace_id AS "workspaceId",
       space_id AS "spaceId",
       worker_service_principal_id AS "workerServicePrincipalId",
       delegating_user_id AS "delegatingUserId",
       delegating_membership_id AS "delegatingMembershipId",
       policy_version_id AS "policyVersionId",
       context_snapshot AS "contextSnapshot",
       issued_at AS "issuedAt",
       expires_at AS "expiresAt",
       status,
       signing_key_id AS "signingKeyId"
     FROM ops.security_context_references
     WHERE status = 'active'
       AND revoked_at IS NULL
       AND expires_at > clock_timestamp()
       AND expires_at >= to_timestamp($1)
       AND signing_key_id = $2`,
    [claims.expiresAt, claims.signingKeyId]
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}
