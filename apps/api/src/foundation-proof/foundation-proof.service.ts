import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { SecurityContext } from "@throughline/core-types";
import {
  insertFoundationContextReference,
  insertFoundationOutboxEvent,
  type PgPool,
  type TenantDbTransaction,
  upsertFoundationTestAggregate,
  withTenantTransaction
} from "@throughline/db";
import type { AsyncContextReferenceCodec } from "@throughline/tenancy";
import { generateUuidV7, parseSecurityContext } from "@throughline/tenancy";
import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import {
  FOUNDATION_PROOF_AUTHORIZATION,
  FOUNDATION_PROOF_CODEC,
  FOUNDATION_PROOF_OPTIONS,
  FOUNDATION_PROOF_POOL,
  type FoundationProofRuntimeOptions
} from "./foundation-proof.tokens.js";

export interface CreateFoundationProofInput {
  context: SecurityContext;
  spaceId: string;
  proofKey: string;
  traceparent?: string;
  tracestate?: string;
}

@Injectable()
export class FoundationProofService {
  constructor(
    @Inject(FOUNDATION_PROOF_POOL) private readonly pool: PgPool,
    @Inject(FOUNDATION_PROOF_AUTHORIZATION)
    private readonly authorization: TransactionAwareAuthorizationService,
    @Inject(FOUNDATION_PROOF_CODEC) private readonly codec: AsyncContextReferenceCodec,
    @Inject(FOUNDATION_PROOF_OPTIONS) private readonly options: FoundationProofRuntimeOptions
  ) {}

  async create(input: CreateFoundationProofInput) {
    const context = parseSecurityContext({
      ...input.context,
      requestedSpaceIds: [input.spaceId]
    });

    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertFoundationProofAppRole(tx);

      const decision = await this.authorization.canInTransaction(
        context,
        "foundation.proof.create",
        { type: "space", id: input.spaceId },
        tx
      );
      if (!decision.allowed) {
        throw new ForbiddenException({
          statusCode: 403,
          error: "Forbidden",
          message: "Foundation proof authorization denied",
          reasonCode: decision.reasonCode
        });
      }

      const issued = this.codec.issue({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: input.spaceId,
        workerServicePrincipalId: this.options.workerServicePrincipalId,
        policyVersionId: context.policyVersion,
        ttlSeconds: 600
      });
      const referenceExpiry = new Date(issued.claims.expiresAt * 1_000);
      if (referenceExpiry.getTime() > Date.parse(context.expiresAt)) {
        throw new Error("Signed context reference exceeds the SecurityContext expiry");
      }
      if (!context.actorUserId || !context.actorMembershipId) {
        throw new ForbiddenException("Foundation proof requires a human actor");
      }

      await insertFoundationContextReference(tx, {
        id: issued.claims.referenceId,
        jobId: issued.claims.jobId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: input.spaceId,
        workerServicePrincipalId: this.options.workerServicePrincipalId,
        delegatingUserId: context.actorUserId,
        delegatingMembershipId: context.actorMembershipId,
        policyVersionId: context.policyVersion,
        contextSnapshot: context,
        issuedAt: new Date(issued.claims.issuedAt * 1_000),
        expiresAt: referenceExpiry,
        signingKeyId: issued.claims.signingKeyId
      });

      const aggregate = await upsertFoundationTestAggregate(tx, {
        id: this.options.uuidV7(),
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: input.spaceId,
        proofKey: input.proofKey,
        jobId: issued.claims.jobId
      });

      await insertFoundationOutboxEvent(tx, {
        id: this.options.uuidV7(),
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        spaceId: input.spaceId,
        aggregateId: aggregate.id,
        aggregateVersion: aggregate.aggregateVersion,
        causationId: this.options.uuidV7(),
        requestId: context.requestId,
        traceparent: validTraceparent(input.traceparent),
        ...(validTracestate(input.tracestate) ? { tracestate: input.tracestate } : {}),
        jobId: issued.claims.jobId,
        relayServicePrincipalId: this.options.relayServicePrincipalId,
        contextReferenceId: issued.claims.referenceId,
        signedContextReference: issued.token
      });

      return {
        jobId: issued.claims.jobId,
        aggregateId: aggregate.id,
        aggregateVersion: aggregate.aggregateVersion
      };
    });
  }
}

class FoundationProofDatabaseRoleError extends Error {
  constructor() {
    super("Foundation proof database role validation failed");
    this.name = "FoundationProofDatabaseRoleError";
  }
}

async function assertFoundationProofAppRole(tx: TenantDbTransaction): Promise<void> {
  try {
    const result = await tx.query<{ currentUser: string }>('SELECT current_user AS "currentUser"');
    if (result.rows.length !== 1 || result.rows[0]?.currentUser !== "throughline_app") {
      throw new FoundationProofDatabaseRoleError();
    }
  } catch {
    throw new FoundationProofDatabaseRoleError();
  }
}

export function defaultFoundationProofRuntimeOptions(
  options: Omit<FoundationProofRuntimeOptions, "uuidV7"> & { uuidV7?: () => string }
): FoundationProofRuntimeOptions {
  return { ...options, uuidV7: options.uuidV7 ?? (() => generateUuidV7()) };
}

function validTraceparent(value: string | undefined): string {
  return value && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
    ? value
    : "00-00000000000000000000000000000001-0000000000000001-01";
}

function validTracestate(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && value.length <= 512 && !/[\r\n]/.test(value);
}
