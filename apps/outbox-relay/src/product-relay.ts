import {
  serializeDomainNotificationEnvelope,
  type DomainNotificationEnvelope
} from "@throughline/core-types";
import {
  ProductRelayAuthorizationError,
  ProductRelayClaimRejectedError,
  type ProductDeepReadonly,
  type ProductOutboxClaimHandle,
  type ProductOutboxRepository,
  type ProductPublicationFailureKind,
  type ProductPublicationPublisher,
  type ProductRelayClaimOptions,
  type ProductRelayClaimScope
} from "@throughline/db";
import { withPropagatedSpan } from "@throughline/observability";

export const PRODUCT_NOTIFICATION_RETENTION_SECONDS = 86_400 as const;
export const PRODUCT_NOTIFICATION_DELIVERY = Object.freeze({
  ordering: "potentially_unordered" as const,
  delivery: "at_least_once" as const,
  queueType: "standard" as const,
  consumer: "none" as const
});

export interface ProductSendMessageInput {
  QueueUrl: string;
  MessageBody: string;
  MessageAttributes: { event_id: { DataType: "String"; StringValue: string } };
}

export interface ProductGetQueueAttributesInput {
  QueueUrl: string;
  AttributeNames: readonly ["MessageRetentionPeriod", "RedrivePolicy", "FifoQueue"];
}

export interface ProductSqsClient {
  send(
    command: unknown,
    options?: { readonly abortSignal?: AbortSignal }
  ): Promise<{
    readonly MessageId?: string;
    readonly Attributes?: Record<string, string | undefined>;
  }>;
}

export interface ProductSqsCommandFactory {
  sendMessage(input: ProductSendMessageInput): unknown;
  getQueueAttributes(input: ProductGetQueueAttributesInput): unknown;
}

export type ProductRelayPublishResult =
  | { status: "idle" }
  | { status: "published"; eventId: string; messageId: string };

export class ProductOutboxRelay {
  private readonly publisher: ProductSqsPublisher;

  constructor(
    private readonly repository: ProductOutboxRepository,
    sqs: ProductSqsClient,
    queueUrl: string,
    commands: ProductSqsCommandFactory,
    sendTimeoutMs = 10_000
  ) {
    this.publisher = new ProductSqsPublisher(sqs, queueUrl, commands, sendTimeoutMs);
  }

  verifyQueueContract(): Promise<void> {
    return this.publisher.verifyQueueContract();
  }

  async publishNext(
    scope: ProductRelayClaimScope,
    options: ProductRelayClaimOptions
  ): Promise<ProductRelayPublishResult> {
    const handle = await this.repository.claimNext(scope, options);
    if (!handle) return { status: "idle" };
    return this.publishClaimed(handle);
  }

  async publishClaimed(
    handle: ProductOutboxClaimHandle
  ): Promise<Exclude<ProductRelayPublishResult, { status: "idle" }>> {
    try {
      const result = await this.repository.publishClaimed(handle, this.publisher);
      if (result.status === "unresolved") {
        await this.repository.recordFailure(handle, {
          kind: "ambiguous",
          code: "accepted_marker_unresolved"
        });
        throw new ProductPublicationUnresolvedError();
      }
      return result;
    } catch (error) {
      if (
        error instanceof ProductPublicationUnresolvedError ||
        error instanceof ProductRelayClaimRejectedError ||
        error instanceof ProductRelayAuthorizationError
      ) {
        throw error;
      }
      const failure = classifyProductSqsError(error);
      await this.repository.recordFailure(handle, failure);
      throw new ProductPublicationFailedError(failure);
    }
  }
}

export class ProductSqsPublisher implements ProductPublicationPublisher {
  constructor(
    private readonly sqs: ProductSqsClient,
    private readonly queueUrl: string,
    private readonly commands: ProductSqsCommandFactory,
    private readonly sendTimeoutMs: number
  ) {
    if (!queueUrl) throw new Error("Product notification queue configuration is invalid");
    if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 60_000) {
      throw new Error("Product notification send deadline is invalid");
    }
  }

  async verifyQueueContract(): Promise<void> {
    const response = await this.sqs.send(
      this.commands.getQueueAttributes({
        QueueUrl: this.queueUrl,
        AttributeNames: ["MessageRetentionPeriod", "RedrivePolicy", "FifoQueue"]
      })
    );
    const attributes = response.Attributes;
    if (
      !attributes ||
      attributes.MessageRetentionPeriod !== String(PRODUCT_NOTIFICATION_RETENTION_SECONDS) ||
      attributes.RedrivePolicy !== undefined ||
      (attributes.FifoQueue !== undefined && attributes.FifoQueue !== "false")
    ) {
      throw new Error(
        "Product notification queue does not satisfy the Standard no-redrive contract"
      );
    }
  }

  publish(
    envelope: ProductDeepReadonly<DomainNotificationEnvelope>
  ): Promise<{ readonly messageId: string }> {
    return withPropagatedSpan(
      {
        name: "product_outbox.relay.publish",
        parentCarrier: {
          traceparent: envelope.traceparent,
          ...(envelope.tracestate === undefined ? {} : { tracestate: envelope.tracestate })
        },
        attributes: {
          "throughline.request.id": envelope.requestId,
          "throughline.tenant.id": envelope.tenantId,
          "throughline.workspace.id": envelope.workspaceId,
          "throughline.space.id": envelope.spaceId
        }
      },
      () => this.sendAndSettle(envelope)
    );
  }

  private async sendAndSettle(
    envelope: ProductDeepReadonly<DomainNotificationEnvelope>
  ): Promise<{ readonly messageId: string }> {
    const input = createProductSendMessageInput(this.queueUrl, envelope);
    const abortController = new AbortController();
    const sendPromise = this.sqs.send(this.commands.sendMessage(input), {
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
        throw Object.assign(new Error("Product SQS send outcome is ambiguous"), {
          name: "TimeoutError"
        });
      }
      const messageId = outcome.acknowledgment.MessageId;
      if (
        typeof messageId !== "string" ||
        messageId.length < 1 ||
        messageId.length > 200 ||
        hasControlCharacters(messageId)
      ) {
        throw Object.assign(new Error("Product SQS acknowledgment is ambiguous"), {
          name: "MissingMessageId"
        });
      }
      return { messageId };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });
}

export function createProductSendMessageInput(
  queueUrl: string,
  envelope: ProductDeepReadonly<DomainNotificationEnvelope>
): ProductSendMessageInput {
  const canonicalEnvelope = serializeDomainNotificationEnvelope(envelope);
  return {
    QueueUrl: queueUrl,
    MessageBody: canonicalEnvelope,
    MessageAttributes: {
      event_id: { DataType: "String", StringValue: envelope.eventId }
    }
  };
}

export function classifyProductSqsError(error: unknown): {
  kind: ProductPublicationFailureKind;
  code: string;
} {
  const name = readErrorName(error);
  const kind: ProductPublicationFailureKind = DETERMINISTIC_SQS_REJECTIONS.has(name)
    ? "deterministic"
    : "ambiguous";
  return { kind, code: normalizeErrorCode(name) };
}

export class ProductPublicationFailedError extends Error {
  readonly kind: ProductPublicationFailureKind;
  readonly code: string;

  constructor(failure: { kind: ProductPublicationFailureKind; code: string }) {
    super("Product notification publication failed");
    this.name = "ProductPublicationFailedError";
    this.kind = failure.kind;
    this.code = failure.code;
  }
}

const DETERMINISTIC_SQS_REJECTIONS = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "AWS.SimpleQueueService.NonExistentQueue",
  "InvalidAddress",
  "InvalidMessageContents",
  "QueueDoesNotExist"
]);

class ProductPublicationUnresolvedError extends Error {
  constructor() {
    super("Product notification publication outcome is unresolved");
    this.name = "ProductPublicationUnresolvedError";
  }
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
      .slice(0, 100) || "sqs_ambiguous_failure"
  );
}
