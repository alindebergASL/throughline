import type { FoundationQueueEnvelope, SecurityContext } from "@throughline/core-types";
import {
  toFoundationQueueEnvelope,
  type ClaimedOutboxEvent,
  type RelayClaimIdentity,
  type RelayClaimOptions,
  type RelayOutboxRepository
} from "@throughline/db";
import { withPropagatedSpan, type TraceCarrier } from "@throughline/observability";
import { buildScopedQueueKey } from "@throughline/tenancy";

export interface SqsSendMessageInput {
  QueueUrl: string;
  MessageBody: string;
  MessageAttributes: Record<string, { DataType: "String"; StringValue: string }>;
}

export interface SqsSendMessageCommand {
  readonly input: SqsSendMessageInput;
}

export interface SqsPublisherClient {
  send(command: SqsSendMessageCommand): Promise<{ MessageId?: string }>;
}

export interface SqsCommandFactory {
  create(input: SqsSendMessageInput): SqsSendMessageCommand;
}

export type RelayPublishResult =
  | { status: "idle" }
  | { status: "published"; eventId: string; messageId: string };

export class FoundationOutboxRelay {
  constructor(
    private readonly repository: RelayOutboxRepository,
    private readonly sqs: SqsPublisherClient,
    private readonly queueUrl: string,
    private readonly commands: SqsCommandFactory = { create: (input) => ({ input }) }
  ) {
    if (!queueUrl) throw new Error("Foundation source queue URL is required");
  }

  async publishNext(
    context: SecurityContext,
    claimOptions: RelayClaimOptions
  ): Promise<RelayPublishResult> {
    const event = await this.repository.claimNext(context, claimOptions);
    if (!event) return { status: "idle" };

    return withPropagatedSpan(
      {
        name: "foundation.relay.publish",
        parentCarrier: {
          traceparent: event.traceparent,
          ...(event.tracestate === undefined ? {} : { tracestate: event.tracestate })
        },
        attributes: {
          "throughline.request.id": event.requestId,
          "throughline.job.id": event.jobId,
          "throughline.tenant.id": event.tenantId,
          "throughline.workspace.id": event.workspaceId,
          "throughline.space.id": event.spaceId
        }
      },
      async ({ carrier }) => {
        const input = createSendMessageInput(this.queueUrl, event, carrier);
        let acknowledgment: { MessageId?: string };
        try {
          acknowledgment = await this.sqs.send(this.commands.create(input));
        } catch (error) {
          await this.recordFailure(context, event, classifySqsPublicationError(error));
          throw error;
        }

        if (!acknowledgment.MessageId) {
          await this.repository.markRetry(context, event, {
            code: "missing_message_id",
            delaySeconds: retryDelaySeconds(event.publicationAttempt)
          });
          throw new Error("SQS SendMessage acknowledgment did not include a MessageId");
        }

        await this.repository.markPublished(context, event, acknowledgment.MessageId);
        return {
          status: "published" as const,
          eventId: event.eventId,
          messageId: acknowledgment.MessageId
        };
      }
    );
  }

  private async recordFailure(
    context: SecurityContext,
    claim: RelayClaimIdentity,
    failure: ClassifiedPublicationError
  ): Promise<void> {
    if (failure.kind === "terminal") {
      await this.repository.markTerminal(context, claim, failure.code);
      return;
    }
    await this.repository.markRetry(context, claim, {
      code: failure.code,
      delaySeconds: retryDelaySeconds(claim.publicationAttempt)
    });
  }
}

export interface ClassifiedPublicationError {
  kind: "retryable" | "terminal";
  code: string;
}

const TERMINAL_SQS_ERRORS = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "AWS.SimpleQueueService.NonExistentQueue",
  "InvalidAddress",
  "InvalidMessageContents",
  "QueueDoesNotExist"
]);

export function classifySqsPublicationError(error: unknown): ClassifiedPublicationError {
  const name = readErrorName(error);
  return TERMINAL_SQS_ERRORS.has(name)
    ? { kind: "terminal", code: normalizeErrorCode(name) }
    : { kind: "retryable", code: normalizeErrorCode(name) };
}

export function createSendMessageInput(
  queueUrl: string,
  event: ClaimedOutboxEvent,
  propagationCarrier: TraceCarrier = event
): SqsSendMessageInput {
  const envelope = toFoundationQueueEnvelope(event);
  envelope.traceparent = propagationCarrier.traceparent;
  delete envelope.tracestate;
  if (propagationCarrier.tracestate !== undefined) {
    envelope.tracestate = propagationCarrier.tracestate;
  }
  validateFoundationQueueEnvelope(envelope);
  const attributes: SqsSendMessageInput["MessageAttributes"] = {
    routingKey: stringAttribute(buildScopedQueueKey(envelope.scope)),
    tenantId: stringAttribute(envelope.scope.tenantId),
    workspaceId: stringAttribute(envelope.scope.workspaceId),
    spaceId: stringAttribute(envelope.scope.spaceId),
    eventId: stringAttribute(envelope.eventId),
    eventType: stringAttribute(event.eventType),
    jobId: stringAttribute(envelope.jobId),
    traceparent: stringAttribute(envelope.traceparent)
  };
  if (envelope.tracestate !== undefined) {
    attributes.tracestate = stringAttribute(envelope.tracestate);
  }
  return {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(envelope),
    MessageAttributes: attributes
  };
}

function validateFoundationQueueEnvelope(envelope: FoundationQueueEnvelope): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    envelope.version !== "v1" ||
    !uuid.test(envelope.eventId) ||
    !uuid.test(envelope.jobId) ||
    !envelope.requestId ||
    !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(envelope.traceparent) ||
    !/^tlctx\.v1\.hs256\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      envelope.contextReference
    )
  ) {
    throw new Error("Claimed outbox row does not form a valid Foundation queue envelope");
  }
  buildScopedQueueKey(envelope.scope);
}

function stringAttribute(value: string) {
  return { DataType: "String" as const, StringValue: value };
}

function readErrorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "sqs_ambiguous_failure";
}

function normalizeErrorCode(name: string): string {
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()
      .slice(0, 200) || "sqs_ambiguous_failure"
  );
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(Math.max(attempt - 1, 0), 8));
}
