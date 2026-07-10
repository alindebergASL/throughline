import type { SecurityContext } from "@throughline/core-types";
import { isSecurityContextExpired, parseSecurityContext } from "@throughline/tenancy";
import type { PgPool, PgPoolClient, PgQueryResult } from "./client.js";

export const SECURITY_CONTEXT_EXPIRED_MESSAGE = "SecurityContext has expired";

export interface TenantQueryExecutor {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<PgQueryResult<T>>;
}

export type TenantDbTransaction = TenantQueryExecutor & {
  client: PgPoolClient;
};

export interface TenantTransactionOptions {
  pool: PgPool;
  context: SecurityContext;
}

export async function withTenantTransaction<T>(
  options: TenantTransactionOptions,
  fn: (tx: TenantDbTransaction) => Promise<T>
): Promise<T> {
  const context = parseSecurityContext(options.context);

  if (isSecurityContextExpired(context)) {
    throw new Error(SECURITY_CONTEXT_EXPIRED_MESSAGE);
  }

  const client = await options.pool.connect();

  try {
    await client.query("BEGIN");
    await setTransactionContext(client, context);

    const tx: TenantDbTransaction = {
      client,
      query: <T extends object = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[]
      ): Promise<PgQueryResult<T>> => client.query<T>(text, values ? [...values] : undefined)
    };
    const result = await fn(tx);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setTransactionContext(
  client: PgPoolClient,
  context: SecurityContext
): Promise<void> {
  const settings: Array<[string, string | undefined]> = [
    ["app.request_id", context.requestId],
    ["app.trace_id", context.traceId],
    ["app.tenant_id", context.tenantId],
    ["app.workspace_id", context.workspaceId],
    ["app.user_id", context.actorUserId],
    ["app.membership_id", context.actorMembershipId],
    ["app.service_principal_id", context.servicePrincipalId],
    ["app.agent_principal_id", context.agentPrincipalId],
    ["app.policy_version", context.policyVersion]
  ];

  for (const [key, value] of settings) {
    await client.query("SELECT set_config($1, $2, true)", [key, value ?? ""]);
  }
}
