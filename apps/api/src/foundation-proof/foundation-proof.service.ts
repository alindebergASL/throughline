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
import { withPropagatedSpan } from "@throughline/observability";
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
    const delegatingUserId = context.actorUserId;
    const delegatingMembershipId = context.actorMembershipId;
    const attributes = {
      "throughline.request.id": context.requestId,
      "throughline.job.id": issued.claims.jobId,
      "throughline.tenant.id": context.tenantId,
      "throughline.workspace.id": context.workspaceId,
      "throughline.space.id": input.spaceId
    } as const;

    return withPropagatedSpan(
      {
        name: "foundation.api.request",
        parentCarrier: {
          ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
          ...(input.tracestate === undefined ? {} : { tracestate: input.tracestate })
        },
        attributes
      },
      ({ carrier: requestCarrier }) =>
        withPropagatedSpan(
          {
            name: "foundation.api.database-outbox-commit",
            parentCarrier: requestCarrier,
            attributes
          },
          ({ carrier: commitCarrier }) =>
            withTenantTransaction({ pool: this.pool, context }, async (tx) => {
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

              const delegatedContext = {
                ...context,
                requestedSpaceIds: [input.spaceId],
                issuedAt: new Date(issued.claims.issuedAt * 1_000).toISOString(),
                expiresAt: referenceExpiry.toISOString()
              };
              await insertFoundationContextReference(tx, {
                id: issued.claims.referenceId,
                jobId: issued.claims.jobId,
                tenantId: context.tenantId,
                workspaceId: context.workspaceId,
                spaceId: input.spaceId,
                workerServicePrincipalId: this.options.workerServicePrincipalId,
                delegatingUserId,
                delegatingMembershipId,
                policyVersionId: context.policyVersion,
                contextSnapshot: delegatedContext,
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
                traceparent: commitCarrier.traceparent,
                ...(commitCarrier.tracestate === undefined
                  ? {}
                  : { tracestate: commitCarrier.tracestate }),
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
            })
        )
    );
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
