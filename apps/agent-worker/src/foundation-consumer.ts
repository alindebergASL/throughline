export interface FoundationSqsMessage {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  MessageAttributes?: Record<string, unknown>;
}

export interface FoundationReceiveMessageInput {
  QueueUrl: string;
  MaxNumberOfMessages: 1;
  VisibilityTimeout: 30;
  AttributeNames: ["All"];
  MessageAttributeNames: ["All"];
  WaitTimeSeconds: 1;
}

export interface FoundationChangeVisibilityInput {
  QueueUrl: string;
  ReceiptHandle: string;
  VisibilityTimeout: 30;
}

export interface FoundationDeleteMessageInput {
  QueueUrl: string;
  ReceiptHandle: string;
}

export interface FoundationSqsPort {
  receiveMessage(
    input: FoundationReceiveMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<{ Messages?: FoundationSqsMessage[] }>;
  changeMessageVisibility(
    input: FoundationChangeVisibilityInput,
    options: { signal: AbortSignal; remainingDeadlineMs: number }
  ): Promise<void>;
  deleteMessage(
    input: FoundationDeleteMessageInput,
    options: { signal: AbortSignal; remainingDeadlineMs: number }
  ): Promise<void>;
}

export interface FoundationConsumerScheduler {
  now: () => number;
  setTimeout: (callback: () => void | Promise<void>, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export type FoundationConsumeResult = {
  status: "applied" | "confirmed_duplicate";
  aggregateVersion: number;
};

export type FoundationConsumerResult =
  | { status: "idle" }
  | { status: "deleted"; outcome: "applied" | "confirmed_duplicate" }
  | { status: "undeleted"; reasonCode: FoundationConsumerReasonCode };

export type FoundationConsumerReasonCode =
  | "malformed"
  | "context_reference_denied"
  | "terminal_denial"
  | "forged"
  | "expired"
  | "revoked"
  | "cross_scope"
  | "out_of_order"
  | "visibility_extension_failed"
  | "deadline_exceeded"
  | "delete_failed"
  | "transient_failure";

interface ConsumerLogger {
  debug: (...values: unknown[]) => void;
  info: (...values: unknown[]) => void;
  warn: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
}

export interface FoundationSqsConsumerOptions<Job> {
  queueUrl: string;
  sqs: FoundationSqsPort;
  scheduler: FoundationConsumerScheduler;
  rehydrate: (
    input: { body: string; messageAttributes: Record<string, unknown> },
    options: { signal: AbortSignal }
  ) => Promise<Job>;
  consume: (
    job: Job,
    options: {
      signal: AbortSignal;
      deadline: { absoluteDeadlineMs: number; now(): number };
    }
  ) => Promise<FoundationConsumeResult>;
  logger: ConsumerLogger;
}

const EXTENSION_AT_MS = 15_000;
const DEADLINE_MS = 20_000;

export class FoundationSqsConsumer<Job> {
  constructor(private readonly options: FoundationSqsConsumerOptions<Job>) {}

  async receiveOne(): Promise<FoundationConsumerResult> {
    let response: { Messages?: FoundationSqsMessage[] };
    try {
      response = await this.options.sqs.receiveMessage({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 30,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
        WaitTimeSeconds: 1
      });
    } catch {
      return this.undeleted("transient_failure");
    }
    const message = response.Messages?.[0];
    if (!message) return { status: "idle" };

    const receiptHandle = message.ReceiptHandle;
    const body = message.Body;
    if (typeof receiptHandle !== "string" || typeof body !== "string") {
      return this.undeleted("malformed");
    }

    const startedAt = this.options.scheduler.now();
    const deadline = {
      absoluteDeadlineMs: startedAt + DEADLINE_MS,
      now: this.options.scheduler.now
    };
    const abortController = new AbortController();
    let terminalReason: FoundationConsumerReasonCode | undefined;
    let active = true;
    let extensionPromise: Promise<void> | undefined;

    const extensionHandle = this.options.scheduler.setTimeout(() => {
      if (!active || terminalReason) return;
      const remainingDeadlineMs = deadline.absoluteDeadlineMs - this.options.scheduler.now();
      if (remainingDeadlineMs <= 0) {
        terminalReason = "deadline_exceeded";
        abortController.abort();
        return;
      }
      extensionPromise = this.options.sqs
        .changeMessageVisibility(
          {
            QueueUrl: this.options.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 30
          },
          { signal: abortController.signal, remainingDeadlineMs }
        )
        .catch(() => {
          if (!terminalReason) terminalReason = "visibility_extension_failed";
          abortController.abort();
        });
      return extensionPromise;
    }, EXTENSION_AT_MS);
    const deadlineHandle = this.options.scheduler.setTimeout(() => {
      if (!terminalReason) terminalReason = "deadline_exceeded";
      abortController.abort();
    }, DEADLINE_MS);

    try {
      let outcome: FoundationConsumeResult;
      try {
        JSON.parse(body);
        const job = await this.options.rehydrate(
          { body, messageAttributes: message.MessageAttributes ?? {} },
          { signal: abortController.signal }
        );
        if (terminalReason) return this.undeleted(terminalReason);
        outcome = await this.options.consume(job, { signal: abortController.signal, deadline });
      } catch (error) {
        await extensionPromise;
        return this.undeleted(terminalReason ?? sanitizeReason(error));
      }

      await extensionPromise;
      if (terminalReason) return this.undeleted(terminalReason);
      const remainingDeadlineMs = this.remaining(startedAt);
      if (remainingDeadlineMs <= 0) {
        terminalReason = "deadline_exceeded";
        abortController.abort();
        return this.undeleted(terminalReason);
      }
      try {
        await this.options.sqs.deleteMessage(
          { QueueUrl: this.options.queueUrl, ReceiptHandle: receiptHandle },
          { signal: abortController.signal, remainingDeadlineMs }
        );
      } catch {
        return this.undeleted(terminalReason ?? "delete_failed");
      }
      if (terminalReason || abortController.signal.aborted) {
        return this.undeleted(terminalReason ?? "deadline_exceeded");
      }
      return { status: "deleted", outcome: outcome.status };
    } finally {
      active = false;
      this.options.scheduler.clearTimeout(extensionHandle);
      this.options.scheduler.clearTimeout(deadlineHandle);
    }
  }

  private remaining(startedAt: number): number {
    return Math.max(0, DEADLINE_MS - (this.options.scheduler.now() - startedAt));
  }

  private undeleted(reasonCode: FoundationConsumerReasonCode): FoundationConsumerResult {
    this.options.logger.warn(reasonCode);
    return { status: "undeleted", reasonCode };
  }
}

const SAFE_EXTERNAL_CODES = new Set<FoundationConsumerReasonCode>([
  "malformed",
  "context_reference_denied",
  "terminal_denial",
  "forged",
  "expired",
  "revoked",
  "cross_scope",
  "out_of_order"
]);

function sanitizeReason(error: unknown): FoundationConsumerReasonCode {
  if (!error || typeof error !== "object" || !("code" in error)) return "transient_failure";
  const code = error.code;
  if (code === "WORKER_NOT_AUTHORIZED" || code === "WORKER_INPUT_INVALID") {
    return "terminal_denial";
  }
  if (code === "WORKER_AGGREGATE_CARDINALITY" || code === "WORKER_AGGREGATE_STATE") {
    return "out_of_order";
  }
  return typeof code === "string" && SAFE_EXTERNAL_CODES.has(code as FoundationConsumerReasonCode)
    ? (code as FoundationConsumerReasonCode)
    : "transient_failure";
}
