import type {
  RelayClaimIdentity,
  RelayPublicationPublisher,
  RelayPublicationRequest
} from "@throughline/db";
import { describe, expect, it, vi } from "vitest";
import {
  FoundationOutboxRelay,
  FoundationSqsPublisher,
  classifySqsPublicationError
} from "./relay.js";
import type { SqsSendMessageInput } from "./relay.js";
import { parseLocalSqsConfiguration } from "./main.js";

const claim = {
  eventId: "11111111-1111-4111-8111-111111111101",
  claimedBy: "relay-a",
  publicationAttempt: 1,
  claimToken: Buffer.alloc(32, 4).toString("base64url")
} as RelayClaimIdentity;

const request: RelayPublicationRequest = {
  eventType: "foundation.proof.created.v1",
  aggregateType: "foundation_test_aggregate",
  aggregateId: "11111111-1111-4111-8111-111111111102",
  aggregateVersion: 1,
  causationId: "11111111-1111-4111-8111-111111111103",
  contextReferenceId: "11111111-1111-4111-8111-111111111105",
  routingKey:
    "tenant/11111111-1111-4111-8111-111111111111/workspace/11111111-1111-4111-8111-111111111112/space/11111111-1111-4111-8111-111111111114",
  envelope: {
    version: "v1",
    eventId: claim.eventId,
    jobId: "11111111-1111-4111-8111-111111111104",
    scope: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "11111111-1111-4111-8111-111111111112",
      spaceId: "11111111-1111-4111-8111-111111111114"
    },
    contextReference: "tlctx.v1.hs256.test.opaque.signature",
    requestId: "request-1",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: "vendor=value"
  }
};

function repository(
  publishResult?: (publisher: RelayPublicationPublisher) => Promise<{
    status: "published" | "unresolved";
    eventId: string;
    messageId: string;
  }>
) {
  return {
    claimNext: vi.fn(async () => claim),
    publishClaimed: vi.fn(async (_context, _claim, publisher: RelayPublicationPublisher) =>
      publishResult
        ? publishResult(publisher)
        : publisher.publish(request).then(({ messageId }) => ({
            status: "published" as const,
            eventId: claim.eventId,
            messageId
          }))
    ),
    recordRetry: vi.fn(async () => undefined),
    recordTerminal: vi.fn(async () => undefined)
  };
}

describe("FoundationOutboxRelay", () => {
  it("aborts at the bounded send deadline but awaits send settlement before returning", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let rejectSend!: (error: unknown) => void;
    const send = vi.fn(
      async (command: unknown, options?: { abortSignal?: AbortSignal }): Promise<never> => {
        void command;
        signal = options?.abortSignal;
        return new Promise<never>((resolve, reject) => {
          void resolve;
          rejectSend = reject;
        });
      }
    );
    try {
      const publisher = new FoundationSqsPublisher(
        { send },
        "http://localhost:4566/queue/test",
        { create: (input) => ({ input }) },
        10
      );
      let returned = false;
      const publication = publisher.publish(request).finally(() => {
        returned = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(signal?.aborted).toBe(true);
      expect(returned).toBe(false);
      rejectSend(Object.assign(new Error("aborted"), { name: "AbortError" }));
      await expect(publication).rejects.toMatchObject({ name: "TimeoutError" });
      expect(returned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes only the persisted request and includes every mandatory duplicate attribute", async () => {
    const repo = repository();
    const sqs = {
      send: vi.fn(async () => ({
        MessageId: "message-1"
      }))
    };
    const relay = new FoundationOutboxRelay(repo as never, sqs, "http://localhost:4566/queue/test");

    await expect(
      relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).resolves.toEqual({
      status: "published",
      eventId: claim.eventId,
      messageId: "message-1"
    });
    const input = (sqs.send.mock.calls as unknown as Array<[{ input: SqsSendMessageInput }]>)[0]![0]
      .input;
    expect(JSON.parse(input.MessageBody)).toMatchObject(request.envelope);
    expect(input.MessageAttributes).toMatchObject({
      routingKey: { DataType: "String", StringValue: request.routingKey },
      tenantId: { DataType: "String", StringValue: request.envelope.scope.tenantId },
      workspaceId: { DataType: "String", StringValue: request.envelope.scope.workspaceId },
      spaceId: { DataType: "String", StringValue: request.envelope.scope.spaceId },
      eventId: { DataType: "String", StringValue: request.envelope.eventId },
      jobId: { DataType: "String", StringValue: request.envelope.jobId },
      requestId: { DataType: "String", StringValue: request.envelope.requestId },
      traceparent: { DataType: "String", StringValue: expect.any(String) },
      tracestate: { DataType: "String", StringValue: request.envelope.tracestate }
    });
    expect(input.MessageBody).not.toMatch(/claimToken|servicePrincipalId|secret|credential/i);
  });

  it("records a missing MessageId as retryable ambiguity", async () => {
    const repo = repository();
    const relay = new FoundationOutboxRelay(
      repo as never,
      { send: vi.fn(async () => ({})) },
      "http://localhost:4566/queue/test"
    );
    await expect(
      relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).rejects.toThrow(/MessageId/);
    expect(repo.recordRetry).toHaveBeenCalledWith(
      expect.anything(),
      claim,
      expect.objectContaining({ code: "missing_message_id" })
    );
    expect(repo.recordTerminal).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "ThrottlingException" }, "retryable"],
    [{ name: "TimeoutError" }, "retryable"],
    [{ name: "InvalidMessageContents" }, "terminal"],
    [{ name: "AccessDeniedException" }, "terminal"]
  ] as const)("classifies %o as %s", (error, expected) => {
    expect(classifySqsPublicationError(error).kind).toBe(expected);
  });

  it("records definite terminal rejection without direct DLQ publication", async () => {
    const repo = repository();
    const sqs = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("bad"), { name: "InvalidMessageContents" });
      })
    };
    const relay = new FoundationOutboxRelay(repo as never, sqs, "http://localhost:4566/queue/test");
    await expect(
      relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).rejects.toThrow("bad");
    expect(repo.recordTerminal).toHaveBeenCalledWith(
      expect.anything(),
      claim,
      "invalid_message_contents"
    );
    expect(repo.recordRetry).not.toHaveBeenCalled();
    expect(sqs.send).toHaveBeenCalledOnce();
  });

  it("keeps accepted-but-unresolved publication retryable with stable identities", async () => {
    const bodies: string[] = [];
    const repo = repository(async (publisher) => {
      const acknowledgment = await publisher.publish(request);
      return { status: "unresolved", eventId: claim.eventId, messageId: acknowledgment.messageId };
    });
    const sqs = {
      send: vi.fn(async (command: { input: { MessageBody: string } }) => {
        bodies.push(command.input.MessageBody);
        return { MessageId: "accepted-message" };
      })
    };
    const relay = new FoundationOutboxRelay(repo as never, sqs, "http://localhost:4566/queue/test");
    await expect(
      relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).rejects.toThrow(/unresolved/);
    await expect(
      relay.publishNext({} as never, { claimedBy: "relay-a", leaseSeconds: 30 })
    ).rejects.toThrow(/unresolved/);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(repo.recordRetry).toHaveBeenCalledTimes(2);
    expect(repo.recordTerminal).not.toHaveBeenCalled();
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
  });
});
