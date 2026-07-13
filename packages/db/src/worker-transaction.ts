import { createHash } from "node:crypto";
import type { AuthorizationDecision, ResourceRef, SecurityContext } from "@throughline/core-types";
import { isSecurityContextExpired, parseSecurityContext } from "@throughline/tenancy";
import type { PgPool, PgPoolClient } from "./client.js";

const WORKER_ROLE = "throughline_worker";
const HANDLER_KEY = "foundation.worker.consume.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FoundationWorkerBinding {
  referenceId: string;
  jobId: string;
  workerServicePrincipalId: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  policyVersionId: string;
  delegatingUserId: string;
  delegatingMembershipId: string;
}

export interface FoundationWorkerAuthorization {
  canInTransaction(
    context: SecurityContext,
    action: "foundation.worker.consume",
    resource: ResourceRef,
    tx: { query: PgPoolClient["query"] },
    options: { workerBinding: FoundationWorkerBinding }
  ): Promise<AuthorizationDecision>;
}

export interface FoundationWorkerJobInput {
  context: SecurityContext;
  jobId: string;
  contextReferenceId: string;
  idempotencyRecordId?: string;
}

export interface WorkerTransactionDeadline {
  absoluteDeadlineMs: number;
  now(): number;
}

export interface ConsumeFoundationWorkerJobOptions {
  pool: PgPool;
  authorization: FoundationWorkerAuthorization;
  input: FoundationWorkerJobInput;
  signal?: AbortSignal;
  deadline: WorkerTransactionDeadline;
}

export type FoundationWorkerJobResult = {
  status: "applied" | "confirmed_duplicate";
  aggregateId: string;
  aggregateVersion: number;
  effectCount: number;
};

export class FoundationWorkerTransactionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FoundationWorkerTransactionError";
    this.code = code;
  }
}

interface AggregateRow {
  id: string;
  pendingJobId: string | null;
  lastEffectJobId: string | null;
  effectCount: number;
  aggregateVersion: number;
}

interface IdempotencyRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
  jobId: string;
  contextReferenceId: string;
  handlerKey: string;
  aggregateId: string;
  aggregateVersion: number;
  effectHash: string;
}

type TransactionState = "active" | "aborting" | "committed" | "rolled_back" | "quarantined";
type QueryClient = Pick<PgPoolClient, "query">;

const IDENTITY_QUERY =
  'SELECT current_user AS "currentUser", pg_backend_pid()::integer AS "backendPid"';
const CANCEL_QUERY = "SELECT pg_catalog.pg_cancel_backend($1)";
const SET_CONFIG_QUERY = "SELECT pg_catalog.set_config($1, $2, true)";
const ROLLBACK_RESERVE_MS = 1_000;
const LOCK_DELTA_MS = 250;
const MAX_TIMEOUT_MS = 2_147_483_647;
const CLEANUP_GRACE_MS = 1_500;

/** Executes the one fixed Foundation worker effect without exposing a query callback. */
export async function consumeFoundationWorkerJob(
  options: ConsumeFoundationWorkerJobOptions
): Promise<FoundationWorkerJobResult> {
  const context = validateInput(options.input);
  const spaceId = context.requestedSpaceIds[0]!;
  const binding: FoundationWorkerBinding = {
    referenceId: options.input.contextReferenceId,
    jobId: options.input.jobId,
    workerServicePrincipalId: context.servicePrincipalId!,
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    spaceId,
    policyVersionId: context.policyVersion,
    delegatingUserId: context.delegatedByUserId!,
    delegatingMembershipId: context.delegatedByMembershipId!
  };

  assertDeadline(options.deadline);
  assertNotAborted(options.signal);
  let client: PgPoolClient | undefined;
  let cancellationClient: PgPoolClient | undefined;
  try {
    client = await options.pool.connect();
  } catch {
    throw workerError("WORKER_CONNECTION_FAILED", "Dedicated worker database connection failed");
  }

  const latch: { state: TransactionState } = { state: "active" };
  let backendPid: number | undefined;
  let transactionOpen = false;
  let mainQuarantine = false;
  let cancellationQuarantine = false;
  let cancellationIdentitySafe = false;
  let cancellationPromise: Promise<void> | undefined;
  let settledInFlight: Promise<void> | undefined;
  let mainReleased = false;
  let resolveAbortObserved!: () => void;
  const abortObserved = new Promise<void>((resolve) => {
    resolveAbortObserved = resolve;
  });

  const quarantineMain = () => {
    mainQuarantine = true;
    latch.state = "quarantined";
    if (mainReleased) return;
    mainReleased = true;
    client.release(
      workerError("WORKER_CONNECTION_UNCERTAIN", "Foundation worker connection state is uncertain")
    );
  };

  const startCancellation = (): Promise<void> | undefined => {
    if (cancellationPromise || !cancellationClient || backendPid === undefined) {
      return cancellationPromise;
    }
    const targetPid = backendPid;
    cancellationPromise = (async () => {
      try {
        const result = await withCleanupGrace(
          cancellationClient!.query<{
            pg_cancel_backend?: boolean;
            cancelled?: boolean;
          }>(CANCEL_QUERY, [targetPid])
        );
        const row = result.rows[0];
        if (
          result.rows.length !== 1 ||
          !row ||
          (row.pg_cancel_backend !== true && row.cancelled !== true)
        ) {
          throw new Error("cancellation was not confirmed");
        }
      } catch {
        cancellationQuarantine = true;
        mainQuarantine = true;
        throw workerError(
          "WORKER_CANCELLATION_FAILED",
          "Foundation worker transaction cancellation failed"
        );
      }
    })();
    return cancellationPromise;
  };

  const markAborting = () => {
    if (latch.state !== "active") return;
    latch.state = "aborting";
    resolveAbortObserved();
    void startCancellation()?.catch(() => undefined);
  };

  const onAbort = () => markAborting();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) markAborting();

  const ensureActive = () => {
    if (options.signal?.aborted) markAborting();
    if (latch.state !== "active") {
      throw workerError("WORKER_ABORTED", "Foundation worker transaction was aborted");
    }
  };

  const trackedRawQuery = async <Row extends object = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ) => {
    const queryPromise = client!.query<Row>(sql, values);
    const settlement = queryPromise.then(
      () => undefined,
      () => undefined
    );
    settledInFlight = settlement;
    try {
      return await queryPromise;
    } finally {
      await settlement;
      if (settledInFlight === settlement) settledInFlight = undefined;
    }
  };

  const configureBackstops = async () => {
    ensureActive();
    const remaining = options.deadline.absoluteDeadlineMs - options.deadline.now();
    const statementMs = Math.min(MAX_TIMEOUT_MS, Math.floor(remaining - ROLLBACK_RESERVE_MS));
    const lockMs = statementMs - LOCK_DELTA_MS;
    if (!Number.isFinite(remaining) || statementMs <= LOCK_DELTA_MS || lockMs <= 0) {
      markAborting();
      throw workerError("WORKER_ABORTED", "Foundation worker transaction was aborted");
    }
    await trackedRawQuery(SET_CONFIG_QUERY, ["statement_timeout", `${statementMs}ms`]);
    ensureActive();
    await trackedRawQuery(SET_CONFIG_QUERY, ["lock_timeout", `${lockMs}ms`]);
    ensureActive();
  };

  const ordinaryQuery = async <Row extends object = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ) => {
    ensureActive();
    await configureBackstops();
    ensureActive();
    try {
      const queryPromise = trackedRawQuery<Row>(sql, values);
      const result = await Promise.race([
        queryPromise,
        abortObserved.then(async () => {
          const cancellation = startCancellation();
          if (!cancellation) {
            quarantineMain();
            throw workerError(
              "WORKER_CANCELLATION_FAILED",
              "Foundation worker transaction cancellation failed"
            );
          }
          try {
            await withCleanupGrace(cancellation);
            const settlement = await withCleanupGrace(
              queryPromise.then(
                () => ({ fulfilled: true as const }),
                (error: unknown) => ({ fulfilled: false as const, error })
              )
            );
            if (!settlement.fulfilled && !isCancellationSqlState(settlement.error)) {
              quarantineMain();
              throw workerError(
                "WORKER_CONNECTION_UNCERTAIN",
                "Foundation worker connection state is uncertain"
              );
            }
          } catch (error) {
            quarantineMain();
            throw error;
          }
          throw workerError("WORKER_ABORTED", "Foundation worker transaction was aborted");
        })
      ]);
      ensureActive();
      return result;
    } catch (error) {
      if (isCancellationSqlState(error)) markAborting();
      if (
        latch.state === "aborting" &&
        !isCancellationSqlState(error) &&
        !isWorkerAbortError(error)
      ) {
        mainQuarantine = true;
      }
      throw error;
    }
  };

  const tx: QueryClient = {
    query: ((sql: string, values?: unknown[]) =>
      ordinaryQuery(sql, values)) as PgPoolClient["query"]
  };

  const commitTransaction = async () => {
    ensureActive();
    await configureBackstops();
    ensureActive();
    try {
      await trackedRawQuery("COMMIT");
      ensureActive();
      transactionOpen = false;
      latch.state = "committed";
      assertIdleTransactionStatus(client!);
    } catch (error) {
      if (isCancellationSqlState(error)) markAborting();
      if (
        latch.state === "aborting" &&
        !isCancellationSqlState(error) &&
        !isWorkerAbortError(error)
      ) {
        mainQuarantine = true;
      }
      throw error;
    }
  };

  try {
    ensureActive();
    await trackedRawQuery("BEGIN");
    transactionOpen = true;
    const mainIdentity = await queryWorkerIdentity(client);
    backendPid = mainIdentity.backendPid;
    if (latch.state === "aborting") void startCancellation()?.catch(() => undefined);

    try {
      cancellationClient = await options.pool.connect();
    } catch {
      throw workerError("WORKER_CONNECTION_FAILED", "Dedicated worker database connection failed");
    }
    let cancellationIdentity: WorkerIdentity;
    try {
      cancellationIdentity = await queryWorkerIdentity(cancellationClient);
      if (cancellationIdentity.backendPid === backendPid) {
        throw workerError(
          "WORKER_ROLE_ASSERTION_FAILED",
          "Dedicated worker database role is required"
        );
      }
      cancellationIdentitySafe = true;
    } catch (error) {
      cancellationQuarantine = true;
      throw error;
    }
    if (latch.state === "aborting") void startCancellation()?.catch(() => undefined);
    ensureActive();

    await setBindings(tx, [
      ["app.tenant_id", binding.tenantId],
      ["app.workspace_id", binding.workspaceId],
      ["app.space_id", binding.spaceId],
      ["app.job_id", binding.jobId],
      ["app.context_reference_id", binding.referenceId],
      ["app.worker_principal_id", binding.workerServicePrincipalId],
      ["app.policy_version", binding.policyVersionId],
      ["app.user_id", binding.delegatingUserId],
      ["app.membership_id", binding.delegatingMembershipId]
    ]);

    const decision = await options.authorization.canInTransaction(
      context,
      "foundation.worker.consume",
      { type: "space", id: binding.spaceId },
      tx,
      { workerBinding: binding }
    );
    if (!decision.allowed) {
      throw workerError("WORKER_NOT_AUTHORIZED", "Foundation worker job is not authorized");
    }

    let aggregate = await discoverAggregate(tx, binding);
    if (isDuplicateAggregate(aggregate, binding.jobId)) {
      const result = await confirmDuplicate(tx, binding, aggregate);
      ensureActive();
      await commitTransaction();
      return result;
    }
    assertPendingAggregate(aggregate, binding.jobId);

    const locked = await lockPendingAggregate(tx, binding, aggregate);
    if (!locked) {
      aggregate = await discoverAggregate(tx, binding);
      if (isDuplicateAggregate(aggregate, binding.jobId)) {
        const result = await confirmDuplicate(tx, binding, aggregate);
        ensureActive();
        await commitTransaction();
        return result;
      }
      throw workerError(
        "WORKER_PENDING_LOCK_FAILED",
        "Foundation worker aggregate could not be locked"
      );
    }
    aggregate = locked;

    const committedVersion = aggregate.aggregateVersion + 1;
    const effectHash = effectHashFor(binding, aggregate.id, committedVersion);
    await setDerivedBindings(tx, aggregate.id, committedVersion, effectHash);

    const idempotencyId = options.input.idempotencyRecordId ?? deterministicIdempotencyId(binding);
    const inserted = await ordinaryQuery<{ id: string }>(
      `INSERT INTO ops.idempotency_records
         (id, tenant_id, workspace_id, space_id, job_id, handler_key,
          context_reference_id, aggregate_id, aggregate_version, effect_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        idempotencyId,
        binding.tenantId,
        binding.workspaceId,
        binding.spaceId,
        binding.jobId,
        HANDLER_KEY,
        binding.referenceId,
        aggregate.id,
        committedVersion,
        effectHash
      ]
    );
    if (inserted.rows.length !== 1) {
      throw workerError(
        "WORKER_IDEMPOTENCY_CONFLICT",
        "Foundation worker idempotency state is inconsistent"
      );
    }

    const updated = await ordinaryQuery<{ aggregateVersion: number; effectCount: number }>(
      `UPDATE ops.foundation_test_aggregates
       SET pending_job_id = NULL,
           last_effect_job_id = $1,
           effect_count = effect_count + 1,
           aggregate_version = aggregate_version + 1,
           updated_at = clock_timestamp()
       WHERE tenant_id = $2
         AND workspace_id = $3
         AND space_id = $4
         AND id = $5
         AND pending_job_id = $1
         AND aggregate_version = $6
         AND EXISTS (
           SELECT 1
           FROM ops.security_context_references reference
           WHERE reference.id = $7
             AND reference.job_id = $1
             AND reference.tenant_id = $2
             AND reference.workspace_id = $3
             AND reference.space_id = $4
             AND reference.worker_service_principal_id = $8
             AND reference.policy_version_id = $9
             AND reference.delegating_user_id = $10
             AND reference.delegating_membership_id = $11
             AND reference.status = 'active'
             AND reference.revoked_at IS NULL
             AND reference.expires_at > clock_timestamp()
         )
       RETURNING aggregate_version AS "aggregateVersion", effect_count AS "effectCount"`,
      [
        binding.jobId,
        binding.tenantId,
        binding.workspaceId,
        binding.spaceId,
        aggregate.id,
        aggregate.aggregateVersion,
        binding.referenceId,
        binding.workerServicePrincipalId,
        binding.policyVersionId,
        binding.delegatingUserId,
        binding.delegatingMembershipId
      ]
    );
    const effect = updated.rows[0];
    if (
      updated.rows.length !== 1 ||
      effect?.aggregateVersion !== committedVersion ||
      effect.effectCount !== aggregate.effectCount + 1
    ) {
      throw workerError("WORKER_FINAL_UPDATE_FAILED", "Foundation worker effect was not committed");
    }

    ensureActive();
    await commitTransaction();
    return {
      status: "applied",
      aggregateId: aggregate.id,
      aggregateVersion: effect.aggregateVersion,
      effectCount: effect.effectCount
    };
  } catch (error) {
    if (options.signal?.aborted || isCancellationSqlState(error)) markAborting();
    if (isUncertainConnectionError(error) || isWorkerConnectionUncertainError(error)) {
      mainQuarantine = true;
    }
    if (transactionOpen) {
      try {
        await settledInFlight;
        if (latch.state === "aborting") {
          const cancellation = startCancellation();
          if (!cancellation) {
            mainQuarantine = true;
            throw workerError(
              "WORKER_CANCELLATION_FAILED",
              "Foundation worker transaction cancellation failed"
            );
          }
          await cancellation;
        }
      } catch {
        mainQuarantine = true;
      }
      try {
        if (mainReleased) throw new Error("main client is quarantined");
        await withCleanupGrace(client.query("ROLLBACK"));
        transactionOpen = false;
        latch.state = mainQuarantine ? "quarantined" : "rolled_back";
        assertIdleTransactionStatus(client);
      } catch {
        quarantineMain();
      }
    }
    throw sanitizeError(error, options.signal, latch.state);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (mainQuarantine && !mainReleased) {
      latch.state = "quarantined";
      mainReleased = true;
      client.release(
        workerError(
          "WORKER_CONNECTION_UNCERTAIN",
          "Foundation worker connection state is uncertain"
        )
      );
    } else if (!mainReleased) {
      mainReleased = true;
      client.release();
    }
    if (cancellationClient) {
      if (cancellationQuarantine || !cancellationIdentitySafe) {
        cancellationClient.release(
          workerError(
            "WORKER_CONNECTION_UNCERTAIN",
            "Foundation worker connection state is uncertain"
          )
        );
      } else {
        cancellationClient.release();
      }
    }
  }
}

function validateInput(input: FoundationWorkerJobInput): SecurityContext {
  let context: SecurityContext;
  try {
    context = parseSecurityContext(input.context);
  } catch {
    throw workerError("WORKER_INPUT_INVALID", "Foundation worker input is invalid");
  }
  if (
    isSecurityContextExpired(context) ||
    !context.servicePrincipalId ||
    context.actorUserId ||
    context.actorMembershipId ||
    context.agentPrincipalId ||
    !context.delegatedByUserId ||
    !context.delegatedByMembershipId ||
    context.requestedSpaceIds.length !== 1
  ) {
    throw workerError("WORKER_INPUT_INVALID", "Foundation worker input is invalid");
  }
  const ids = [
    context.tenantId,
    context.workspaceId,
    context.requestedSpaceIds[0],
    context.servicePrincipalId,
    context.delegatedByUserId,
    context.delegatedByMembershipId,
    input.jobId,
    input.contextReferenceId,
    input.idempotencyRecordId
  ];
  if (ids.some((id) => id !== undefined && !UUID_PATTERN.test(id))) {
    throw workerError("WORKER_INPUT_INVALID", "Foundation worker input is invalid");
  }
  return context;
}

interface WorkerIdentity {
  currentUser: typeof WORKER_ROLE;
  backendPid: number;
}

async function queryWorkerIdentity(client: PgPoolClient): Promise<WorkerIdentity> {
  let rows: Array<{ currentUser?: string; backendPid?: number }>;
  try {
    const result = await client.query<{ currentUser?: string; backendPid?: number }>(
      IDENTITY_QUERY,
      undefined
    );
    rows = result.rows;
  } catch {
    throw workerError("WORKER_ROLE_ASSERTION_FAILED", "Dedicated worker database role is required");
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.currentUser !== WORKER_ROLE ||
    !Number.isSafeInteger(row.backendPid) ||
    row.backendPid! <= 0
  ) {
    throw workerError("WORKER_ROLE_ASSERTION_FAILED", "Dedicated worker database role is required");
  }
  return { currentUser: WORKER_ROLE, backendPid: row.backendPid! };
}

async function setBindings(
  client: QueryClient,
  bindings: ReadonlyArray<readonly [string, string]>
): Promise<void> {
  for (const [name, value] of bindings) {
    await client.query("SELECT set_config($1, $2, true)", [name, value]);
  }
}

function setDerivedBindings(
  client: QueryClient,
  aggregateId: string,
  committedVersion: number,
  effectHash: string
): Promise<void> {
  return setBindings(client, [
    ["app.handler_key", HANDLER_KEY],
    ["app.aggregate_id", aggregateId],
    ["app.aggregate_version", String(committedVersion)],
    ["app.effect_hash", effectHash]
  ]);
}

async function discoverAggregate(
  client: QueryClient,
  binding: FoundationWorkerBinding
): Promise<AggregateRow> {
  const result = await client.query<AggregateRow>(
    `SELECT
       id,
       pending_job_id AS "pendingJobId",
       last_effect_job_id AS "lastEffectJobId",
       effect_count AS "effectCount",
       aggregate_version AS "aggregateVersion"
     FROM ops.foundation_test_aggregates
     WHERE tenant_id = $1
       AND workspace_id = $2
       AND space_id = $3
       AND (pending_job_id = $4 OR last_effect_job_id = $4)`,
    [binding.tenantId, binding.workspaceId, binding.spaceId, binding.jobId]
  );
  if (result.rows.length !== 1) {
    throw workerError(
      "WORKER_AGGREGATE_CARDINALITY",
      "Foundation worker aggregate lookup must return exactly one row"
    );
  }
  return result.rows[0]!;
}

async function lockPendingAggregate(
  client: QueryClient,
  binding: FoundationWorkerBinding,
  aggregate: AggregateRow
): Promise<AggregateRow | undefined> {
  const result = await client.query<AggregateRow>(
    `SELECT
       id,
       pending_job_id AS "pendingJobId",
       last_effect_job_id AS "lastEffectJobId",
       effect_count AS "effectCount",
       aggregate_version AS "aggregateVersion"
     FROM ops.foundation_test_aggregates
     WHERE tenant_id = $1
       AND workspace_id = $2
       AND space_id = $3
       AND id = $4
       AND pending_job_id = $5
       AND aggregate_version = $6
     FOR UPDATE`,
    [
      binding.tenantId,
      binding.workspaceId,
      binding.spaceId,
      aggregate.id,
      binding.jobId,
      aggregate.aggregateVersion
    ]
  );
  if (result.rows.length > 1) {
    throw workerError(
      "WORKER_PENDING_LOCK_FAILED",
      "Foundation worker aggregate could not be locked"
    );
  }
  return result.rows[0];
}

async function confirmDuplicate(
  client: QueryClient,
  binding: FoundationWorkerBinding,
  aggregate: AggregateRow
): Promise<FoundationWorkerJobResult> {
  const effectHash = effectHashFor(binding, aggregate.id, aggregate.aggregateVersion);
  await setDerivedBindings(client, aggregate.id, aggregate.aggregateVersion, effectHash);
  const result = await client.query<IdempotencyRow>(
    `SELECT
       id,
       tenant_id AS "tenantId",
       workspace_id AS "workspaceId",
       space_id AS "spaceId",
       job_id AS "jobId",
       context_reference_id AS "contextReferenceId",
       handler_key AS "handlerKey",
       aggregate_id AS "aggregateId",
       aggregate_version AS "aggregateVersion",
       effect_hash AS "effectHash"
     FROM ops.idempotency_records
     WHERE tenant_id = $1
       AND workspace_id = $2
       AND space_id = $3
       AND job_id = $4
       AND context_reference_id = $5
       AND handler_key = $6
       AND aggregate_id = $7
       AND aggregate_version = $8
       AND effect_hash = $9`,
    [
      binding.tenantId,
      binding.workspaceId,
      binding.spaceId,
      binding.jobId,
      binding.referenceId,
      HANDLER_KEY,
      aggregate.id,
      aggregate.aggregateVersion,
      effectHash
    ]
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.tenantId !== binding.tenantId ||
    row.workspaceId !== binding.workspaceId ||
    row.spaceId !== binding.spaceId ||
    row.jobId !== binding.jobId ||
    row.contextReferenceId !== binding.referenceId ||
    row.handlerKey !== HANDLER_KEY ||
    row.aggregateId !== aggregate.id ||
    row.aggregateVersion !== aggregate.aggregateVersion ||
    row.effectHash !== effectHash ||
    aggregate.lastEffectJobId !== binding.jobId ||
    aggregate.pendingJobId !== null
  ) {
    throw workerError(
      "WORKER_DUPLICATE_MISMATCH",
      "Foundation worker duplicate state does not match the committed effect"
    );
  }
  return {
    status: "confirmed_duplicate",
    aggregateId: aggregate.id,
    aggregateVersion: aggregate.aggregateVersion,
    effectCount: aggregate.effectCount
  };
}

function isDuplicateAggregate(aggregate: AggregateRow, jobId: string): boolean {
  return aggregate.pendingJobId === null && aggregate.lastEffectJobId === jobId;
}

function assertPendingAggregate(aggregate: AggregateRow, jobId: string): void {
  if (aggregate.pendingJobId !== jobId) {
    throw workerError("WORKER_AGGREGATE_STATE", "Foundation worker aggregate state is invalid");
  }
}

function effectHashFor(
  binding: FoundationWorkerBinding,
  aggregateId: string,
  committedVersion: number
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        handlerKey: HANDLER_KEY,
        tenantId: binding.tenantId,
        workspaceId: binding.workspaceId,
        spaceId: binding.spaceId,
        jobId: binding.jobId,
        contextReferenceId: binding.referenceId,
        aggregateId,
        loadedAggregateVersion: committedVersion - 1,
        committedAggregateVersion: committedVersion
      })
    )
    .digest("hex");
}

function deterministicIdempotencyId(binding: FoundationWorkerBinding): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(
        `${HANDLER_KEY}:${binding.tenantId}:${binding.workspaceId}:${binding.spaceId}:${binding.jobId}:${binding.referenceId}`
      )
      .digest()
      .subarray(0, 16)
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw workerError("WORKER_ABORTED", "Foundation worker transaction was aborted");
  }
}

async function withCleanupGrace<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          workerError(
            "WORKER_CONNECTION_UNCERTAIN",
            "Foundation worker connection state is uncertain"
          )
        ),
      CLEANUP_GRACE_MS
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertDeadline(deadline: WorkerTransactionDeadline): void {
  if (
    !deadline ||
    !Number.isFinite(deadline.absoluteDeadlineMs) ||
    typeof deadline.now !== "function"
  ) {
    throw workerError("WORKER_INPUT_INVALID", "Foundation worker input is invalid");
  }
}

function isCancellationSqlState(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "57014" || error.code === "55P03";
}

function isWorkerAbortError(error: unknown): boolean {
  return error instanceof FoundationWorkerTransactionError && error.code === "WORKER_ABORTED";
}

function isWorkerConnectionUncertainError(error: unknown): boolean {
  return (
    error instanceof FoundationWorkerTransactionError &&
    error.code === "WORKER_CONNECTION_UNCERTAIN"
  );
}

function assertIdleTransactionStatus(client: PgPoolClient): void {
  const statusClient = client as unknown as {
    getTransactionStatus?: () => unknown;
  };
  if (typeof statusClient.getTransactionStatus !== "function") return;
  const status = statusClient.getTransactionStatus();
  if (status !== "idle" && status !== "I") {
    throw workerError(
      "WORKER_CONNECTION_UNCERTAIN",
      "Foundation worker connection state is uncertain"
    );
  }
}

function isUncertainConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String(error.code);
  return code.startsWith("08") || ["57P01", "57P02", "57P03"].includes(code);
}

function sanitizeError(
  error: unknown,
  signal?: AbortSignal,
  state?: TransactionState
): FoundationWorkerTransactionError {
  if (signal?.aborted || state === "aborting" || isCancellationSqlState(error)) {
    return workerError("WORKER_ABORTED", "Foundation worker transaction was aborted");
  }
  if (error instanceof FoundationWorkerTransactionError) return error;
  if (isUncertainConnectionError(error)) {
    return workerError(
      "WORKER_CONNECTION_UNCERTAIN",
      "Foundation worker connection state is uncertain"
    );
  }
  return workerError("WORKER_TRANSACTION_FAILED", "Foundation worker transaction failed");
}

function workerError(code: string, message: string): FoundationWorkerTransactionError {
  return new FoundationWorkerTransactionError(code, message);
}
