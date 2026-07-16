import type { DomainNotificationEnvelope } from "@throughline/core-types";
import type { ProductOutboxClaimHandle } from "@throughline/db";
import { describe, expect, it, vi } from "vitest";
import { parseProductRelayRuntimeEnvironment } from "./product-main.js";
import {
  PRODUCT_NOTIFICATION_DELIVERY,
  PRODUCT_NOTIFICATION_RETENTION_SECONDS,
  ProductOutboxRelay,
  ProductPublicationFailedError,
  ProductQueueContractError,
  ProductSqsPublisher,
  classifyProductSqsError,
  createProductSendMessageInput,
  type ProductSqsCommandFactory
} from "./product-relay.js";

const envelope: DomainNotificationEnvelope = {
  eventId: "70000000-0000-7000-8000-000000000001",
  eventType: "organization.created",
  eventSchemaVersion: 1,
  payloadSchemaVersion: 1,
  tenantId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  spaceId: "10000000-0000-4000-8000-000000000003",
  aggregateType: "organization",
  aggregateId: "70000000-0000-7000-8000-000000000002",
  aggregateVersion: 1,
  causationCommandId: "70000000-0000-7000-8000-000000000003",
  payload: { organizationId: "70000000-0000-7000-8000-000000000002" },
  requestId: "request-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
};

const handle = {
  eventId: envelope.eventId,
  envelope,
  publicationAttempt: 1
} as ProductOutboxClaimHandle;

const commands: ProductSqsCommandFactory = {
  sendMessage: (input) => ({ kind: "send", input }),
  getQueueAttributes: (input) => ({ kind: "attributes", input })
};

describe("dedicated Standard product-notification SQS contract", () => {
  it("serializes one stable envelope and only the event_id String attribute", () => {
    const first = createProductSendMessageInput("http://localhost:4566/000/test-product", envelope);
    const second = createProductSendMessageInput(
      "http://localhost:4566/000/test-product",
      envelope
    );
    expect(first).toEqual(second);
    expect(first.MessageAttributes).toEqual({
      event_id: { DataType: "String", StringValue: envelope.eventId }
    });
    expect(first).not.toHaveProperty("MessageGroupId");
    expect(first).not.toHaveProperty("MessageDeduplicationId");
    expect(first.MessageBody).not.toMatch(/jobId|contextReference|worker|consumer/i);
  });

  it("verifies the exact Standard queue before returning a publish-capable object", async () => {
    const send = vi.fn(async (command: unknown) =>
      (command as { kind?: string }).kind === "attributes"
        ? { Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "false" } }
        : { MessageId: "verified-publish" }
    );
    const publisher = await ProductSqsPublisher.createVerified(
      { send, destroy: vi.fn() },
      "http://localhost:4566/000/test-product",
      commands,
      100
    );
    await expect(publisher.publish(envelope)).resolves.toBeDefined();
    expect(PRODUCT_NOTIFICATION_RETENTION_SECONDS).toBe(86_400);
    expect(PRODUCT_NOTIFICATION_DELIVERY).toEqual({
      ordering: "potentially_unordered",
      delivery: "at_least_once",
      queueType: "standard",
      consumer: "none"
    });
    const calls = send.mock.calls as unknown as Array<[unknown]>;
    expect(calls[0]?.[0]).toMatchObject({
      kind: "attributes",
      input: {
        AttributeNames: ["MessageRetentionPeriod", "RedrivePolicy", "FifoQueue"]
      }
    });

    for (const Attributes of [
      { MessageRetentionPeriod: "345600", FifoQueue: "false" },
      { MessageRetentionPeriod: "86400", RedrivePolicy: "{}", FifoQueue: "false" },
      { MessageRetentionPeriod: "86400", RedrivePolicy: undefined, FifoQueue: "false" },
      { MessageRetentionPeriod: "86400", FifoQueue: "true" },
      { MessageRetentionPeriod: "86400", FifoQueue: "unexpected" },
      { MessageRetentionPeriod: "86400", FifoQueue: "false", VisibilityTimeout: "30" },
      {},
      undefined
    ]) {
      await expect(
        ProductSqsPublisher.createVerified(
          {
            send: vi.fn(async () =>
              Attributes === undefined
                ? {}
                : { Attributes: Attributes as Record<string, string | undefined> }
            ),
            destroy: vi.fn()
          },
          "http://localhost:4566/000/test-product",
          commands,
          100
        )
      ).rejects.toBeInstanceOf(ProductQueueContractError);
    }
    await expect(
      ProductSqsPublisher.createVerified(
        {
          send: vi.fn(async () => {
            throw new Error("provider credential=must-not-leak");
          }),
          destroy: vi.fn()
        },
        "http://localhost:4566/000/test-product",
        commands,
        100
      )
    ).rejects.toMatchObject({ message: "Product notification queue contract verification failed" });
  });

  it("abandons a never-settling SQS request at the fixed deadline", async () => {
    const send = vi.fn((command: unknown) => {
      if ((command as { kind?: string }).kind === "attributes") {
        return Promise.resolve({
          Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "false" }
        });
      }
      return new Promise<never>(() => undefined);
    });
    const publisher = await ProductSqsPublisher.createVerified(
      { send, destroy: vi.fn() },
      "http://localhost:4566/000/test-product",
      commands,
      25,
      100
    );
    const startedAt = Date.now();
    await expect(withDeadline(publisher.publish(envelope), 250)).rejects.toMatchObject({
      name: "TimeoutError"
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("sinks a detached transport rejection after the deadline", async () => {
    let rejectTransport!: (error: Error) => void;
    const send = vi.fn((command: unknown) => {
      if ((command as { kind?: string }).kind === "attributes") {
        return Promise.resolve({
          Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "false" }
        });
      }
      return new Promise<never>((_resolve, reject) => {
        rejectTransport = reject;
      });
    });
    const publisher = await ProductSqsPublisher.createVerified(
      { send, destroy: vi.fn() },
      "http://localhost:4566/000/test-product",
      commands,
      20,
      100
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(publisher.publish(envelope)).rejects.toMatchObject({ name: "TimeoutError" });
      rejectTransport(new Error("late provider body and credential"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps a late transport success ambiguous and unable to mark publication", async () => {
    let resolveTransport!: (result: { MessageId: string }) => void;
    const publisher = await ProductSqsPublisher.createVerified(
      {
        send: vi.fn((command: unknown) =>
          (command as { kind?: string }).kind === "attributes"
            ? Promise.resolve({
                Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "false" }
              })
            : new Promise<{ MessageId: string }>((resolve) => {
                resolveTransport = resolve;
              })
        ),
        destroy: vi.fn()
      },
      "http://localhost:4566/000/test-product",
      commands,
      20,
      100
    );
    const marked = vi.fn();
    const repository = {
      claimNext: vi.fn(async () => handle),
      publishClaimed: vi.fn(
        async (_handle: ProductOutboxClaimHandle, transport: ProductSqsPublisher) => {
          const acknowledgment = await transport.publish(envelope);
          marked(acknowledgment);
          return {
            status: "published" as const,
            eventId: envelope.eventId,
            messageId: acknowledgment.messageId
          };
        }
      ),
      recordFailure: vi.fn(async () => "retry_wait" as const)
    };
    const relay = new ProductOutboxRelay(repository as never, publisher);

    await expect(withDeadline(relay.publishClaimed(handle), 250)).rejects.toMatchObject({
      kind: "ambiguous",
      code: "timeout_error"
    });
    resolveTransport({ MessageId: "late-accepted-message" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(marked).not.toHaveBeenCalled();
    expect(repository.recordFailure).toHaveBeenCalledTimes(1);
    expect(repository.recordFailure).toHaveBeenCalledWith(handle, {
      kind: "ambiguous",
      code: "timeout_error"
    });
  });

  it("classifies only definite broker rejections as deterministic and sanitizes codes", () => {
    expect(classifyProductSqsError({ name: "InvalidMessageContents" })).toEqual({
      kind: "deterministic",
      code: "invalid_message_contents"
    });
    expect(classifyProductSqsError({ name: "TimeoutError", message: "credential=secret" })).toEqual(
      {
        kind: "ambiguous",
        code: "timeout_error"
      }
    );
    expect(JSON.stringify(classifyProductSqsError(new Error("payload body")))).not.toContain(
      "payload body"
    );
  });

  it("records unresolved acknowledgments as ambiguous without a consumer or DLQ path", async () => {
    const repository = {
      claimNext: vi.fn(async () => handle),
      publishClaimed: vi.fn(async () => ({
        status: "unresolved" as const,
        eventId: envelope.eventId,
        messageId: "broker-message-1"
      })),
      recordFailure: vi.fn(async () => "retry_wait" as const)
    };
    const relay = new ProductOutboxRelay(repository as never, await verifiedPublisher());
    await expect(relay.publishClaimed(handle)).rejects.toThrow(/unresolved/);
    expect(repository.recordFailure).toHaveBeenCalledWith(handle, {
      kind: "ambiguous",
      code: "accepted_marker_unresolved"
    });
    expect(Object.keys(repository)).not.toEqual(
      expect.arrayContaining(["receive", "delete", "changeVisibility", "consume"])
    );
  });

  it("never propagates provider bodies, payloads, or credentials through relay errors", async () => {
    const repository = {
      claimNext: vi.fn(async () => handle),
      publishClaimed: vi.fn(async () => {
        throw Object.assign(new Error("credential=secret payload={raw source}"), {
          name: "ServiceUnavailable"
        });
      }),
      recordFailure: vi.fn(async () => "retry_wait" as const)
    };
    const relay = new ProductOutboxRelay(repository as never, await verifiedPublisher());
    let failure: unknown;
    try {
      await relay.publishClaimed(handle);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProductPublicationFailedError);
    expect(failure).toMatchObject({ kind: "ambiguous", code: "service_unavailable" });
    expect(String(failure)).not.toMatch(/credential|secret|payload|raw source/i);
  });

  it("records a transport deadline as ambiguous without waiting for settlement", async () => {
    const publisher = await ProductSqsPublisher.createVerified(
      {
        send: vi.fn((command: unknown) =>
          (command as { kind?: string }).kind === "attributes"
            ? Promise.resolve({
                Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "false" }
              })
            : new Promise<never>(() => undefined)
        ),
        destroy: vi.fn()
      },
      "http://localhost:4566/000/test-product",
      commands,
      20,
      100
    );
    const repository = {
      claimNext: vi.fn(async () => handle),
      publishClaimed: vi.fn(
        async (_handle: ProductOutboxClaimHandle, transport: ProductSqsPublisher) =>
          transport.publish(envelope)
      ),
      recordFailure: vi.fn(async () => "retry_wait" as const)
    };
    const relay = new ProductOutboxRelay(repository as never, publisher);
    await expect(withDeadline(relay.publishClaimed(handle), 250)).rejects.toMatchObject({
      kind: "ambiguous",
      code: "timeout_error"
    });
    expect(repository.recordFailure).toHaveBeenCalledWith(handle, {
      kind: "ambiguous",
      code: "timeout_error"
    });
  });

  it("fails runtime configuration closed without exposing DSNs or dummy credentials", () => {
    const valid = {
      TEST_PRODUCT_RELAY_DATABASE_URL:
        "postgres://throughline_product_relay:test-password@localhost/throughline_b1_test",
      PRODUCT_SQS_ENDPOINT: "http://localhost:4566",
      PRODUCT_SQS_QUEUE_URL: "http://localhost:4566/000000000000/throughline-b1-test-product",
      PRODUCT_SQS_QUEUE_NAME: "throughline-b1-test-product",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test"
    };
    expect(parseProductRelayRuntimeEnvironment(valid)).toMatchObject({
      queueName: "throughline-b1-test-product"
    });
    let failure: unknown;
    try {
      parseProductRelayRuntimeEnvironment({ ...valid, PRODUCT_SQS_ENDPOINT: "https://sqs.aws" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Product relay runtime configuration is invalid");
    expect((failure as Error).message).not.toContain("test-password");
  });
});

async function verifiedPublisher(): Promise<ProductSqsPublisher> {
  return ProductSqsPublisher.createVerified(
    {
      send: vi.fn(async (command: unknown) =>
        (command as { kind?: string }).kind === "attributes"
          ? { Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "false" } }
          : { MessageId: "verified-test-message" }
      ),
      destroy: vi.fn()
    },
    "http://localhost:4566/000/test-product",
    commands,
    100
  );
}

async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("unit deadline exceeded")), deadlineMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
