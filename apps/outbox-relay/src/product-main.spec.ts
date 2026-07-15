import type { PgPool } from "@throughline/db";
import { describe, expect, it, vi } from "vitest";
import {
  composeProductRelayRuntime,
  type ProductAwsSqsModule,
  type ProductRelayRuntimeEnvironment
} from "./product-main.js";

const environment: ProductRelayRuntimeEnvironment = {
  TEST_PRODUCT_RELAY_DATABASE_URL:
    "postgres://throughline_product_relay:test-password@localhost/throughline_b1_test",
  PRODUCT_SQS_ENDPOINT: "http://localhost:4566",
  PRODUCT_SQS_QUEUE_URL: "http://localhost:4566/000000000000/throughline-b1-test-product",
  PRODUCT_SQS_QUEUE_NAME: "throughline-b1-test-product",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test"
};

describe("verified product relay runtime composition", () => {
  for (const [name, outcome] of [
    ["wrong retention", { Attributes: { MessageRetentionPeriod: "60", FifoQueue: "false" } }],
    [
      "redrive present",
      {
        Attributes: {
          MessageRetentionPeriod: "86400",
          RedrivePolicy: "{}",
          FifoQueue: "false"
        }
      }
    ],
    ["FIFO queue", { Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "true" } }],
    ["missing attributes", {}],
    ["missing retention", { Attributes: { FifoQueue: "false" } }],
    ["GetQueueAttributes failure", new Error("provider body must not escape")]
  ] as const) {
    it(`fails closed and disposes resources for ${name}`, async () => {
      const harness = compositionHarness(outcome);
      await expect(
        composeProductRelayRuntime(environment, harness.dependencies)
      ).rejects.toMatchObject({
        message: "Product notification queue contract verification failed"
      });
      expect(harness.poolConnect).not.toHaveBeenCalled();
      expect(harness.sendMessageConstructions).toHaveBeenCalledTimes(0);
      expect(harness.poolEnd).toHaveBeenCalledTimes(1);
      expect(harness.destroy).toHaveBeenCalledTimes(1);
    });
  }

  it("returns a usable relay only after verification and closes both resources once", async () => {
    const harness = compositionHarness({
      Attributes: { MessageRetentionPeriod: "86400", FifoQueue: "false" }
    });
    const runtime = await composeProductRelayRuntime(environment, harness.dependencies);
    expect(runtime).toEqual({ relay: expect.any(Object), close: expect.any(Function) });
    expect(harness.getAttributesConstructions).toHaveBeenCalledTimes(1);
    expect(harness.poolConnect).not.toHaveBeenCalled();
    await Promise.all([runtime.close(), runtime.close()]);
    expect(harness.poolEnd).toHaveBeenCalledTimes(1);
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });
});

function compositionHarness(
  outcome:
    | Error
    | {
        Attributes?: Record<string, string | undefined>;
      }
) {
  const poolEnd = vi.fn(async () => undefined);
  const poolConnect = vi.fn();
  const destroy = vi.fn();
  const sendMessageConstructions = vi.fn();
  const getAttributesConstructions = vi.fn();

  class FakeSqsClient {
    send(command: unknown) {
      if ((command as { kind?: string }).kind !== "attributes") {
        return Promise.resolve({ MessageId: "unexpected-send" });
      }
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    }

    destroy() {
      destroy();
    }
  }

  class FakeSendMessageCommand {
    readonly kind = "send";
    constructor(readonly input: unknown) {
      sendMessageConstructions(input);
    }
  }

  class FakeGetQueueAttributesCommand {
    readonly kind = "attributes";
    constructor(readonly input: unknown) {
      getAttributesConstructions(input);
    }
  }

  const sdk: ProductAwsSqsModule = {
    SQSClient: FakeSqsClient,
    SendMessageCommand: FakeSendMessageCommand,
    GetQueueAttributesCommand: FakeGetQueueAttributesCommand
  } as ProductAwsSqsModule;
  const pool = { end: poolEnd, connect: poolConnect } as unknown as PgPool;

  return {
    dependencies: {
      loadSdk: async () => sdk,
      createPool: () => pool,
      sendTimeoutMs: 50,
      verificationTimeoutMs: 50
    },
    poolEnd,
    poolConnect,
    destroy,
    sendMessageConstructions,
    getAttributesConstructions
  };
}
