import {
  AsyncContextReferenceError,
  type AsyncContextReferenceBindings,
  type AsyncContextReferenceClaims,
  type AsyncContextReferenceCodec
} from "@throughline/tenancy";
import { parseSecurityContext } from "@throughline/tenancy";
import type { PgPool, PgPoolClient } from "./client.js";
import {
  findWorkerBootstrapContextReference,
  type WorkerBootstrapContextReference,
  type WorkerBootstrapContextReferenceRow
} from "./async-context-repository.js";

type BootstrapExpectedBindings = Omit<AsyncContextReferenceBindings, "referenceId">;

export interface WorkerContextReferenceBootstrapOptions {
  pool: PgPool;
  token: string;
  codec: AsyncContextReferenceCodec;
  expected: BootstrapExpectedBindings;
}

export class WorkerContextBootstrapError extends Error {
  constructor() {
    super("Worker context bootstrap failed");
    this.name = "WorkerContextBootstrapError";
  }
}

/**
 * Verifies the opaque token, binds one dedicated worker transaction, and performs
 * the sole bootstrap lookup. It intentionally exposes no transaction/query callback.
 */
export async function bootstrapWorkerContextReference(
  options: WorkerContextReferenceBootstrapOptions
): Promise<WorkerBootstrapContextReference | null> {
  if (!hasCompleteExpectedBindings(options.expected)) return null;

  let claims: AsyncContextReferenceClaims;
  try {
    claims = options.codec.verify(options.token, options.expected);
  } catch (error) {
    if (error instanceof AsyncContextReferenceError) return null;
    throw new WorkerContextBootstrapError();
  }

  const client = await options.pool.connect();
  try {
    await client.query("BEGIN");
    await assertDedicatedWorkerRole(client);
    await setVerifiedBootstrapBindings(client, claims);
    const row = await findWorkerBootstrapContextReference(client, claims);
    const usable = toUsableReference(row, claims);
    await client.query("COMMIT");
    return usable;
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The safe bootstrap error below deliberately excludes driver detail.
    }
    throw new WorkerContextBootstrapError();
  } finally {
    client.release();
  }
}

async function assertDedicatedWorkerRole(client: PgPoolClient): Promise<void> {
  const result = await client.query<{ currentUser: string }>(
    'SELECT current_user AS "currentUser"'
  );
  if (result.rows.length !== 1 || result.rows[0]?.currentUser !== "throughline_worker") {
    throw new WorkerContextBootstrapError();
  }
}

async function setVerifiedBootstrapBindings(
  client: PgPoolClient,
  claims: AsyncContextReferenceClaims
): Promise<void> {
  const settings: ReadonlyArray<readonly [string, string]> = [
    ["app.tenant_id", claims.tenantId],
    ["app.workspace_id", claims.workspaceId],
    ["app.space_id", claims.spaceId],
    ["app.job_id", claims.jobId],
    ["app.context_reference_id", claims.referenceId],
    ["app.worker_principal_id", claims.workerServicePrincipalId],
    ["app.policy_version", claims.policyVersionId]
  ];
  for (const [name, value] of settings) {
    await client.query("SELECT set_config($1, $2, true)", [name, value]);
  }
}

function toUsableReference(
  row: WorkerBootstrapContextReferenceRow | null,
  claims: AsyncContextReferenceClaims
): WorkerBootstrapContextReference | null {
  if (!row || row.status !== "active" || row.signingKeyId !== claims.signingKeyId) return null;
  if (
    row.id !== claims.referenceId ||
    row.jobId !== claims.jobId ||
    row.tenantId !== claims.tenantId ||
    row.workspaceId !== claims.workspaceId ||
    row.spaceId !== claims.spaceId ||
    row.workerServicePrincipalId !== claims.workerServicePrincipalId ||
    row.policyVersionId !== claims.policyVersionId ||
    toMilliseconds(row.expiresAt) < claims.expiresAt * 1_000
  ) {
    return null;
  }

  try {
    const contextSnapshot = parseSecurityContext(row.contextSnapshot);
    if (
      contextSnapshot.tenantId !== claims.tenantId ||
      contextSnapshot.workspaceId !== claims.workspaceId ||
      contextSnapshot.policyVersion !== claims.policyVersionId ||
      !contextSnapshot.requestedSpaceIds.includes(claims.spaceId) ||
      Date.parse(contextSnapshot.expiresAt) < claims.expiresAt * 1_000
    ) {
      return null;
    }
    return { ...row, status: "active", contextSnapshot };
  } catch {
    return null;
  }
}

function hasCompleteExpectedBindings(
  value: BootstrapExpectedBindings
): value is BootstrapExpectedBindings {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.jobId === "string" &&
    typeof value.tenantId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.spaceId === "string" &&
    typeof value.workerServicePrincipalId === "string" &&
    typeof value.policyVersionId === "string"
  );
}

function toMilliseconds(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
