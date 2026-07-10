import { describe, expect, it, vi } from "vitest";
import {
  FoundationOutboxRelay,
  classifySqsPublicationError,
  createSendMessageInput
} from "./relay.js";
import { parseLocalSqsConfiguration } from "./main.js";

const claimed = {
  eventId: "11111111-1111-4111-8111-111111111101",
  eventType: "foundation.proof.created.v1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "11111111-1111-4111-8111-111111111112",
  spaceId: "11111111-1111-4111-8111-111111111114",
  aggregateType: "foundation_test_aggregate",
  aggregateId: "11111111-1111-4111-8111-111111111102",
  aggregateVersion: 1,
  causationId: "11111111-1111-4111-8111-111111111103",
  requestId: "request-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
  jobId: "11111111-1111-4111-8111-111111111104",
  contextReferenceId: "11111111-1111-4111-8111-111111111105",
  signedContextReference: "tlctx.v1.hs256.test.opaque.signature",
  claimedBy: "relay-a",
  publicationAttempt: 1
} as const;

describe("FoundationOutboxRelay", () => {
  it.each([
    ["event type", { eventType: "foundation.proof.created.v2" }],
    ["aggregate type", { aggregateType: "other_aggregate" }]
  ])("rejects a claimed event with the wrong %s before queue mapping", (_name, override) => {
    expect(() =>
      createSendMessageInput("http://localhost:4566/queue/test", {
        ...claimed,
        ...override
      } as never)
    ).toThrow("Claimed outbox event is outside the exact Foundation relay type");
  });

  it("accepts only injected local SDK endpoint configuration with dummy credentials", () => {
    expect(
      parseLocalSqsConfiguration({
        TEST_RELAY_DATABASE_URL: "postgres://throughline_relay:opaque@localhost/test",
        FOUNDATION_SQS_ENDPOINT: "http://localhost:4566",
        FOUNDATION_SQS_QUEUE_URL: "http://localhost:4566/000000000000/throughline-foundation-test",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test-access",
        AWS_SECRET_ACCESS_KEY: "test-secret"
      })
    ).toMatchObject({ endpoint: "http://localhost:4566/", region: "us-east-1" });
    expect(() =>
      parseLocalSqsConfiguration({
        TEST_RELAY_DATABASE_URL: "redacted",
        FOUNDATION_SQS_ENDPOINT: "https://sqs.us-east-1.amazonaws.com",
        FOUNDATION_SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/production",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "real",
        AWS_SECRET_ACCESS_KEY: "real"
      })
    ).toThrow(/local-only/);
  });

  it.each([
    ["different port", "http://localhost:4567/000000000000/throughline-foundation-test"],
    ["different scheme", "https://localhost:4566/000000000000/throughline-foundation-test"],
    ["different host", "http://127.0.0.1:4566/000000000000/throughline-foundation-test"],
    ["non-test path", "http://localhost:4566/000000000000/throughline-foundation"]
  ])("rejects a queue URL with %s", (_case, queueUrl) => {
    expect(() =>
      parseLocalSqsConfiguration({
        TEST_RELAY_DATABASE_URL: "postgres://throughline_relay:opaque@localhost/test",
        FOUNDATION_SQS_ENDPOINT: "http://localhost:4566",
        FOUNDATION_SQS_QUEUE_URL: queueUrl,
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test-access",
        AWS_SECRET_ACCESS_KEY: "test-secret"
      })
    ).toThrow(/test queue on the configured local endpoint/);
  });
  it("publishes the exact opaque envelope and scoped attributes, then marks only after acknowledgment", async () => {
    const order: string[] = [];
    const repository = {
      claimNext: vi.fn(async () => claimed),
      markPublished: vi.fn(async () => {
        order.push("marked");
      }),
      markRetry: vi.fn(),
      markTerminal: vi.fn()
    };
    const sqs = {
      send: vi.fn(async (command: { input: unknown }) => {
        order.push("ack");
        return { MessageId: "message-1", input: command.input };
      })
    };
    const relay = new FoundationOutboxRelay(
      repository as never,
      sqs as never,
      "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/throughline-foundation-test"
    );

    expect(
      await relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).toEqual({ status: "published", eventId: claimed.eventId, messageId: "message-1" });
    expect(order).toEqual(["ack", "marked"]);
    const input = (
      sqs.send.mock.calls[0]?.[0] as {
        input: { MessageBody: string; MessageAttributes: Record<string, { StringValue: string }> };
      }
    ).input;
    expect(JSON.parse(input.MessageBody)).toEqual({
      version: "v1",
      eventId: claimed.eventId,
      jobId: claimed.jobId,
      scope: {
        tenantId: claimed.tenantId,
        workspaceId: claimed.workspaceId,
        spaceId: claimed.spaceId
      },
      contextReference: claimed.signedContextReference,
      requestId: claimed.requestId,
      traceparent: claimed.traceparent,
      tracestate: claimed.tracestate
    });
    expect(input.MessageAttributes).toMatchObject({
      routingKey: {
        DataType: "String",
        StringValue: `tenant/${claimed.tenantId}/workspace/${claimed.workspaceId}/space/${claimed.spaceId}`
      },
      tenantId: { DataType: "String", StringValue: claimed.tenantId },
      workspaceId: { DataType: "String", StringValue: claimed.workspaceId },
      spaceId: { DataType: "String", StringValue: claimed.spaceId },
      eventId: { DataType: "String", StringValue: claimed.eventId },
      jobId: { DataType: "String", StringValue: claimed.jobId },
      traceparent: { DataType: "String", StringValue: claimed.traceparent },
      tracestate: { DataType: "String", StringValue: claimed.tracestate }
    });
    expect(input.MessageBody).not.toMatch(
      /servicePrincipalId|actorUserId|membershipIds|secret|credential/i
    );
  });

  it("never marks success without an SQS MessageId and records retryable ambiguity", async () => {
    const repository = {
      claimNext: vi.fn(async () => claimed),
      markPublished: vi.fn(),
      markRetry: vi.fn(),
      markTerminal: vi.fn()
    };
    const relay = new FoundationOutboxRelay(
      repository as never,
      { send: vi.fn(async () => ({})) } as never,
      "http://localhost:4566/queue/test"
    );
    await expect(
      relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).rejects.toThrow(/acknowledgment/);
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.markRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventId: claimed.eventId }),
      expect.objectContaining({ code: "missing_message_id" })
    );
  });

  it.each([
    [{ name: "ThrottlingException" }, "retryable"],
    [{ name: "TimeoutError" }, "retryable"],
    [{ name: "InvalidMessageContents" }, "terminal"],
    [{ name: "AccessDeniedException" }, "terminal"]
  ] as const)("classifies %o as %s", (error, expected) => {
    expect(classifySqsPublicationError(error).kind).toBe(expected);
  });

  it("records terminal failure without direct DLQ behavior", async () => {
    const repository = {
      claimNext: vi.fn(async () => claimed),
      markPublished: vi.fn(),
      markRetry: vi.fn(),
      markTerminal: vi.fn()
    };
    const relay = new FoundationOutboxRelay(
      repository as never,
      {
        send: vi.fn(async () => {
          throw Object.assign(new Error("bad"), { name: "InvalidMessageContents" });
        })
      } as never,
      "http://localhost:4566/queue/test"
    );
    await expect(
      relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).rejects.toThrow("bad");
    expect(repository.markTerminal).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "invalid_message_contents"
    );
    expect(repository.markRetry).not.toHaveBeenCalled();
    expect(repository.markPublished).not.toHaveBeenCalled();
  });

  it("preserves stable event/job identity across ambiguous duplicate publication", async () => {
    const bodies: string[] = [];
    const repository = {
      claimNext: vi.fn(async () => claimed),
      markPublished: vi.fn(),
      markRetry: vi.fn(),
      markTerminal: vi.fn()
    };
    const sqs = {
      send: vi.fn(async (command: { input: { MessageBody: string } }) => {
        bodies.push(command.input.MessageBody);
        return { MessageId: crypto.randomUUID() };
      })
    };
    const relay = new FoundationOutboxRelay(
      repository as never,
      sqs as never,
      "http://localhost:4566/queue/test"
    );
    await relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 });
    await relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });
});
