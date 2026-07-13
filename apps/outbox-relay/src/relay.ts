import type { SecurityContext } from "@throughline/core-types";
import type {
  DeepReadonly,
  RelayClaimIdentity,
  RelayClaimOptions,
  RelayOutboxRepository,
  RelayPublicationPublisher,
  RelayPublicationRequest
} from "@throughline/db";
import { withPropagatedSpan, type TraceCarrier } from "@throughline/observability";

export interface SqsSendMessageInput {
  QueueUrl: string;
  MessageBody: string;
  MessageAttributes: Record<string, { DataType: "String"; StringValue: string }>;
}

export interface SqsSendMessageCommand {
  readonly input: SqsSendMessageInput;
}

export interface SqsPublisherClient {
  send(
    command: SqsSendMessageCommand,
    options?: { readonly abortSignal?: AbortSignal }
  ): Promise<{ readonly MessageId?: string }>;
}

export interface SqsCommandFactory {
  create(input: SqsSendMessageInput): SqsSendMessageCommand;
}

export type RelayPublishResult =
  | { status: "idle" }
  | { status: "published"; eventId: string; messageId: string };

export class FoundationOutboxRelay {
  private readonly publisher: RelayPublicationPublisher;

  constructor(
    private readonly repository: RelayOutboxRepository,
    sqs: SqsPublisherClient,
    queueUrl: string,
    commands: SqsCommandFactory = { create: (input) => ({ input }) },
    sendTimeoutMs = 10_000
  ) {
    this.publisher = new FoundationSqsPublisher(sqs, queueUrl, commands, sendTimeoutMs);
  }

  async publishNext(
    context: SecurityContext,
    claimOptions: RelayClaimOptions
  ): Promise<RelayPublishResult> {
    const claim = await this.repository.claimNext(context, claimOptions);
    if (!claim) return { status: "idle" };
    return this.publishClaimed(context, claim);
  }

  async publishClaimed(
    context: SecurityContext,
    claim: RelayClaimIdentity
  ): Promise<Exclude<RelayPublishResult, { status: "idle" }>> {
    try {
      const result = await this.repository.publishClaimed(context, claim, this.publisher);
      if (result.status === "unresolved") {
        await this.repository.recordRetry(context, claim, {
          code: "publication_outcome_unresolved",
          delaySeconds: retryDelaySeconds(claim.publicationAttempt)
        });
        throw new RelayPublicationUnresolvedError();
      }
      return result;
    } catch (error) {
      if (error instanceof RelayPublicationUnresolvedError) throw error;
      await this.recordFailure(context, claim, classifySqsPublicationError(error));
      throw error;
    }
  }

  private async recordFailure(
    context: SecurityContext,
    claim: RelayClaimIdentity,
    failure: ClassifiedPublicationError
  ): Promise<void> {
    if (failure.kind === "terminal") {
      await this.repository.recordTerminal(context, claim, failure.code);
      return;
    }
    await this.repository.recordRetry(context, claim, {
      code: failure.code,
      delaySeconds: retryDelaySeconds(claim.publicationAttempt)
    });
  }
}

export class FoundationSqsPublisher implements RelayPublicationPublisher {
  constructor(
    private readonly sqs: SqsPublisherClient,
    private readonly queueUrl: string,
    private readonly commands: SqsCommandFactory,
    private readonly sendTimeoutMs: number
  ) {
    if (!queueUrl) throw new Error("Foundation source queue URL is required");
    if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 60_000) {
      throw new Error("Foundation SQS send timeout is invalid");
    }
  }

  publish(request: DeepReadonly<RelayPublicationRequest>): Promise<{ readonly messageId: string }> {
    return withPropagatedSpan(
      {
        name: "foundation.relay.publish",
        parentCarrier: {
          traceparent: request.envelope.traceparent,
          ...(request.envelope.tracestate === undefined
            ? {}
            : { tracestate: request.envelope.tracestate })
        },
        attributes: {
          "throughline.request.id": request.envelope.requestId,
          "throughline.job.id": request.envelope.jobId,
          "throughline.tenant.id": request.envelope.scope.tenantId,
          "throughline.workspace.id": request.envelope.scope.workspaceId,
          "throughline.space.id": request.envelope.scope.spaceId
        }
      },
      ({ carrier }) => this.sendAndSettle(request, carrier)
    );
  }

  private async sendAndSettle(
    request: DeepReadonly<RelayPublicationRequest>,
    carrier: TraceCarrier
  ): Promise<{ readonly messageId: string }> {
    const abortController = new AbortController();
    const input = createSendMessageInput(this.queueUrl, request, carrier);
    const sendPromise = this.sqs.send(this.commands.create(input), {
      abortSignal: abortController.signal
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        resolve("timeout");
      }, this.sendTimeoutMs);
    });
    try {
      const outcome = await Promise.race([
        sendPromise.then((acknowledgment) => ({ kind: "settled" as const, acknowledgment })),
        timeout.then(() => ({ kind: "timeout" as const }))
      ]);
      if (outcome.kind === "timeout") {
        await sendPromise.catch(() => undefined);
        throw Object.assign(new Error("SQS SendMessage did not settle before its deadline"), {
          name: "TimeoutError"
        });
      }
      const messageId = outcome.acknowledgment.MessageId;
      if (typeof messageId !== "string" || messageId.length < 1 || messageId.length > 200) {
        throw Object.assign(
          new Error("SQS SendMessage acknowledgment did not include a valid MessageId"),
          { name: "MissingMessageId" }
        );
      }
      return { messageId };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}

class RelayPublicationUnresolvedError extends Error {
  constructor() {
    super("SQS publication outcome remains unresolved and is retryable");
    this.name = "RelayPublicationUnresolvedError";
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
  request: DeepReadonly<RelayPublicationRequest>,
  propagationCarrier: TraceCarrier = request.envelope
): SqsSendMessageInput {
  const envelope = {
    ...request.envelope,
    scope: { ...request.envelope.scope },
    traceparent: propagationCarrier.traceparent,
    ...(propagationCarrier.tracestate === undefined
      ? {}
      : { tracestate: propagationCarrier.tracestate })
  };
  const attributes: SqsSendMessageInput["MessageAttributes"] = {
    routingKey: stringAttribute(request.routingKey),
    tenantId: stringAttribute(envelope.scope.tenantId),
    workspaceId: stringAttribute(envelope.scope.workspaceId),
    spaceId: stringAttribute(envelope.scope.spaceId),
    eventId: stringAttribute(envelope.eventId),
    jobId: stringAttribute(envelope.jobId),
    requestId: stringAttribute(envelope.requestId),
    traceparent: stringAttribute(envelope.traceparent)
  };
  if (envelope.tracestate !== undefined)
    attributes.tracestate = stringAttribute(envelope.tracestate);
  return {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(envelope),
    MessageAttributes: attributes
  };
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
