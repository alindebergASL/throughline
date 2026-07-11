import { describe, expect, it, vi } from "vitest";

type TimerHandle = { id: number };
type TimerCallback = () => void | Promise<void>;

class ManualScheduler {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: TimerCallback; cancelled: boolean }
  >();

  now = () => this.current;

  setTimeout = (callback: TimerCallback, delayMs: number): TimerHandle => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback, cancelled: false });
    return { id };
  };

  clearTimeout = (handle: TimerHandle): void => {
    const timer = this.timers.get(handle.id);
    if (timer) timer.cancelled = true;
  };

  activeDeadlines(): number[] {
    return [...this.timers.values()]
      .filter((timer) => !timer.cancelled)
      .map((timer) => timer.at)
      .sort((left, right) => left - right);
  }

  async advanceTo(target: number): Promise<void> {
    if (target < this.current) throw new Error("manual scheduler cannot move backwards");
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.at;
      await timer.callback();
      await flush();
    }
    this.current = target;
    await flush();
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type Receipt = {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  MessageAttributes?: Record<string, unknown>;
};

type SqsPort = {
  receiveMessage: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<{ Messages?: Receipt[] }>;
  changeMessageVisibility: (
    input: Record<string, unknown>,
    options: { signal: AbortSignal; remainingDeadlineMs: number }
  ) => Promise<void>;
  deleteMessage: (
    input: Record<string, unknown>,
    options: { signal: AbortSignal; remainingDeadlineMs: number }
  ) => Promise<void>;
  sendMessage?: (...values: unknown[]) => Promise<unknown>;
};

type RehydratedJob = {
  jobId: string;
  contextReferenceId: string;
  tenantId: string;
  workspaceId: string;
  spaceId: string;
};

type ConsumeResult =
  | { status: "applied"; aggregateVersion: number }
  | { status: "confirmed_duplicate"; aggregateVersion: number };

type ConsumerOptions = {
  queueUrl: string;
  sqs: SqsPort;
  scheduler: ManualScheduler;
  rehydrate: (
    input: { body: string; messageAttributes: Record<string, unknown> },
    options: { signal: AbortSignal }
  ) => Promise<RehydratedJob>;
  consume: (
    job: RehydratedJob,
    options: {
      signal: AbortSignal;
      deadline: { absoluteDeadlineMs: number; now(): number };
    }
  ) => Promise<ConsumeResult>;
  logger: {
    debug: (...values: unknown[]) => void;
    info: (...values: unknown[]) => void;
    warn: (...values: unknown[]) => void;
    error: (...values: unknown[]) => void;
  };
};

type ConsumerResult =
  | { status: "idle" }
  | { status: "deleted"; outcome: "applied" | "confirmed_duplicate" }
  | { status: "undeleted"; reasonCode: string };

async function createConsumer(options: ConsumerOptions): Promise<{
  receiveOne: () => Promise<ConsumerResult>;
}> {
  const modulePath = "./foundation-consumer.js";
  const loaded = (await import(modulePath)) as {
    FoundationSqsConsumer?: new (value: ConsumerOptions) => {
      receiveOne: () => Promise<ConsumerResult>;
    };
  };
  if (typeof loaded.FoundationSqsConsumer !== "function") {
    throw new Error("Task 7 requires FoundationSqsConsumer");
  }
  return new loaded.FoundationSqsConsumer(options);
}

const ids = {
  event: "70000000-0000-7000-8000-000000000011",
  job: "70000000-0000-7000-8000-000000000021",
  reference: "70000000-0000-7000-8000-000000000031",
  tenant: "11111111-1111-4111-8111-111111111111",
  workspace: "11111111-1111-4111-8111-111111111112",
  space: "11111111-1111-4111-8111-111111111113"
} as const;
const queueUrl = "http://localhost:4566/000000000000/throughline-foundation-test";
const rawToken = "tlctx.v1.hs256.task7-key.opaque-payload.opaque-mac";
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function envelope() {
  return {
    version: "v1",
    eventId: ids.event,
    jobId: ids.job,
    scope: {
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      spaceId: ids.space
    },
    contextReference: rawToken,
    requestId: "request-from-api",
    traceparent,
    tracestate: "vendor=value"
  };
}

function receipt(number = 1): Receipt {
  return {
    MessageId: `message-${number}`,
    ReceiptHandle: `receipt-${number}`,
    Body: JSON.stringify(envelope()),
    MessageAttributes: {
      traceparent: { DataType: "String", StringValue: traceparent }
    }
  };
}

function rehydrated(): RehydratedJob {
  return {
    jobId: ids.job,
    contextReferenceId: ids.reference,
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    spaceId: ids.space
  };
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function harness(overrides: Partial<ConsumerOptions> = {}) {
  const scheduler = overrides.scheduler ?? new ManualScheduler();
  const sqs: SqsPort =
    overrides.sqs ??
    ({
      receiveMessage: vi.fn(async () => ({ Messages: [receipt()] })),
      changeMessageVisibility: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined)
    } satisfies SqsPort);
  const options: ConsumerOptions = {
    queueUrl,
    sqs,
    scheduler,
    rehydrate: vi.fn(async () => rehydrated()),
    consume: vi.fn(async () => ({ status: "applied" as const, aggregateVersion: 2 })),
    logger: logger(),
    ...overrides
  };
  return { options, scheduler, sqs };
}

async function start(options: ConsumerOptions) {
  const consumer = await createConsumer(options);
  const result = consumer.receiveOne();
  await flush();
  return { consumer, result };
}

function abortablePending<T>(signal: AbortSignal, value?: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })),
      { once: true }
    );
    if (value !== undefined) resolve(value);
  });
}

describe("Foundation SQS receipt lifecycle RED contract", () => {
  it("requests one message with the exact 30-second initial visibility timeout", async () => {
    const { options, sqs } = harness();
    const consumer = await createConsumer(options);

    await consumer.receiveOne();

    expect(sqs.receiveMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(sqs.receiveMessage).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 30
      })
    );
  });

  it("starts the 15-second extension and exact 20-second deadline immediately on receipt, before JSON parse", async () => {
    const { options, scheduler } = harness();
    const originalParse = JSON.parse;
    const parseDeadlines: number[][] = [];
    const parse = vi.spyOn(JSON, "parse").mockImplementation((value: string) => {
      parseDeadlines.push(scheduler.activeDeadlines());
      return originalParse(value) as unknown;
    });
    try {
      const consumer = await createConsumer(options);
      await consumer.receiveOne();
      expect(parseDeadlines[0]).toEqual([15_000, 20_000]);
    } finally {
      parse.mockRestore();
    }
  });

  it("passes the fixed absolute monotonic deadline into transaction work", async () => {
    const { options, scheduler } = harness();
    const consume = vi.mocked(options.consume);

    const consumer = await createConsumer(options);
    await consumer.receiveOne();

    const transactionOptions = consume.mock.calls[0]?.[1];
    expect(transactionOptions).toEqual({
      signal: expect.any(AbortSignal),
      deadline: {
        absoluteDeadlineMs: 20_000,
        now: scheduler.now
      }
    });
    expect(transactionOptions?.deadline.now()).toBe(0);
  });

  it("attempts one 30-second visibility extension at exactly 15 seconds during slow rehydration", async () => {
    const pending = deferred<RehydratedJob>();
    const { options, scheduler, sqs } = harness({
      rehydrate: vi.fn(() => pending.promise)
    });
    const { result } = await start(options);

    await scheduler.advanceTo(14_999);
    expect(sqs.changeMessageVisibility).not.toHaveBeenCalled();
    await scheduler.advanceTo(15_000);
    expect(sqs.changeMessageVisibility).toHaveBeenCalledOnce();
    expect(sqs.changeMessageVisibility).toHaveBeenCalledWith(
      { QueueUrl: queueUrl, ReceiptHandle: "receipt-1", VisibilityTimeout: 30 },
      expect.objectContaining({ signal: expect.any(AbortSignal), remainingDeadlineMs: 5_000 })
    );

    pending.resolve(rehydrated());
    await expect(result).resolves.toMatchObject({ status: "deleted", outcome: "applied" });
    await scheduler.advanceTo(19_999);
    expect(sqs.changeMessageVisibility).toHaveBeenCalledOnce();
  });

  it("does not reset the absolute deadline when visibility is extended", async () => {
    const { options, scheduler, sqs } = harness({
      rehydrate: vi.fn((_input, { signal }) => abortablePending<RehydratedJob>(signal))
    });
    const { result } = await start(options);

    await scheduler.advanceTo(15_000);
    expect(sqs.changeMessageVisibility).toHaveBeenCalledOnce();
    await scheduler.advanceTo(20_000);
    await expect(result).resolves.toEqual({ status: "undeleted", reasonCode: "deadline_exceeded" });
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it("keeps the deadline active through transaction commit confirmation", async () => {
    const commit = deferred<ConsumeResult>();
    let transactionSignal: AbortSignal | undefined;
    const { options, scheduler, sqs } = harness({
      consume: vi.fn((_job, { signal }) => {
        transactionSignal = signal;
        return commit.promise;
      })
    });
    const { result } = await start(options);

    await scheduler.advanceTo(20_000);
    expect(transactionSignal?.aborted).toBe(true);
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
    commit.resolve({ status: "applied", aggregateVersion: 2 });
    await expect(result).resolves.toEqual({ status: "undeleted", reasonCode: "deadline_exceeded" });
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it("keeps the deadline active through DeleteMessage and passes an abort/remaining-time guard", async () => {
    const deletion = deferred<void>();
    let deleteOptions: { signal: AbortSignal; remainingDeadlineMs: number } | undefined;
    const { options, scheduler, sqs } = harness();
    sqs.deleteMessage = vi.fn((_input, guard) => {
      deleteOptions = guard;
      return deletion.promise;
    });
    const { result } = await start(options);

    expect(sqs.deleteMessage).toHaveBeenCalledOnce();
    expect(deleteOptions?.remainingDeadlineMs).toBe(20_000);
    expect(deleteOptions?.signal.aborted).toBe(false);
    await scheduler.advanceTo(20_000);
    expect(deleteOptions?.signal.aborted).toBe(true);
    deletion.resolve();
    await expect(result).resolves.toEqual({ status: "undeleted", reasonCode: "deadline_exceeded" });
    expect(sqs.deleteMessage).toHaveBeenCalledOnce();
  });

  it("aborts slow rehydration and never deletes when the visibility extension fails", async () => {
    let rehydrateSignal: AbortSignal | undefined;
    const { options, scheduler, sqs } = harness({
      rehydrate: vi.fn((_input, { signal }) => {
        rehydrateSignal = signal;
        return abortablePending<RehydratedJob>(signal);
      })
    });
    sqs.changeMessageVisibility = vi.fn(async () => {
      throw Object.assign(new Error("LocalStack unavailable"), { code: "ECONNRESET" });
    });
    const { result } = await start(options);

    await scheduler.advanceTo(15_000);
    expect(rehydrateSignal?.aborted).toBe(true);
    await expect(result).resolves.toEqual({
      status: "undeleted",
      reasonCode: "visibility_extension_failed"
    });
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it("aborts the in-flight repository transaction on extension failure with no detached effect", async () => {
    let effectCount = 0;
    let transactionSignal: AbortSignal | undefined;
    const lateCommit = deferred<ConsumeResult>();
    const { options, scheduler, sqs } = harness({
      consume: vi.fn((_job, { signal }) => {
        transactionSignal = signal;
        return lateCommit.promise.then((value) => {
          if (!signal.aborted) effectCount += 1;
          return value;
        });
      })
    });
    sqs.changeMessageVisibility = vi.fn(async () => {
      throw new Error("visibility extension failed");
    });
    const { result } = await start(options);

    await scheduler.advanceTo(15_000);
    expect(transactionSignal?.aborted).toBe(true);
    lateCommit.resolve({ status: "applied", aggregateVersion: 2 });
    await expect(result).resolves.toEqual({
      status: "undeleted",
      reasonCode: "visibility_extension_failed"
    });
    expect(effectCount).toBe(0);
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it.each(["applied", "confirmed_duplicate"] as const)(
    "deletes only after a durably confirmed %s result",
    async (status) => {
      const commit = deferred<ConsumeResult>();
      const { options, sqs } = harness({ consume: vi.fn(() => commit.promise) });
      const { result } = await start(options);

      expect(sqs.deleteMessage).not.toHaveBeenCalled();
      commit.resolve({ status, aggregateVersion: 2 });
      await expect(result).resolves.toEqual({ status: "deleted", outcome: status });
      expect(sqs.deleteMessage).toHaveBeenCalledOnce();
    }
  );

  it.each([
    "transient_failure",
    "terminal_denial",
    "malformed",
    "forged",
    "expired",
    "revoked",
    "cross_scope",
    "out_of_order"
  ])("leaves a %s receipt undeleted", async (reasonCode) => {
    const { options, sqs } = harness({
      rehydrate: vi.fn(async () => {
        throw Object.assign(new Error("safe failure"), { code: reasonCode });
      })
    });
    const consumer = await createConsumer(options);

    await expect(consumer.receiveOne()).resolves.toMatchObject({ status: "undeleted" });
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing Body",
      () => {
        const malformed = { ...receipt() };
        delete malformed.Body;
        return malformed;
      }
    ],
    [
      "missing ReceiptHandle",
      () => {
        const malformed = { ...receipt() };
        delete malformed.ReceiptHandle;
        return malformed;
      }
    ]
  ])(
    "leaves a malformed receipt with %s undeleted before rehydration or effects",
    async (_case, makeMalformed) => {
      const malformed = makeMalformed();
      const { options, sqs } = harness({
        sqs: {
          receiveMessage: vi.fn(async () => ({ Messages: [malformed] })),
          changeMessageVisibility: vi.fn(async () => undefined),
          deleteMessage: vi.fn(async () => undefined),
          sendMessage: vi.fn(async () => undefined)
        }
      });
      const consumer = await createConsumer(options);

      await expect(consumer.receiveOne()).resolves.toMatchObject({ status: "undeleted" });
      expect(options.rehydrate).not.toHaveBeenCalled();
      expect(options.consume).not.toHaveBeenCalled();
      expect(sqs.deleteMessage).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["WORKER_NOT_AUTHORIZED", "terminal_denial"],
    ["WORKER_INPUT_INVALID", "terminal_denial"],
    ["WORKER_AGGREGATE_CARDINALITY", "out_of_order"],
    ["WORKER_AGGREGATE_STATE", "out_of_order"]
  ] as const)("maps fixed internal %s to safe terminal %s", async (code, reasonCode) => {
    const { options, sqs } = harness({
      consume: vi.fn(async () => {
        throw Object.assign(new Error("internal detail"), { code });
      })
    });
    const consumer = await createConsumer(options);

    await expect(consumer.receiveOne()).resolves.toEqual({ status: "undeleted", reasonCode });
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it("returns only an allowlisted sanitized reason and never reflects arbitrary external error.code", async () => {
    const { options } = harness({
      consume: vi.fn(async () => {
        throw Object.assign(new Error("external secret detail"), {
          code: "CUSTOMER_TOKEN_123_SHOULD_NOT_ESCAPE"
        });
      })
    });
    const consumer = await createConsumer(options);
    const result = await consumer.receiveOne();

    expect(result).toEqual({ status: "undeleted", reasonCode: "transient_failure" });
    expect(JSON.stringify(result)).not.toContain("CUSTOMER_TOKEN_123_SHOULD_NOT_ESCAPE");
    expect(JSON.stringify(result)).not.toContain("external secret detail");
  });

  it("never issues a direct DLQ command for terminal input", async () => {
    const { options, sqs } = harness({
      rehydrate: vi.fn(async () => {
        throw Object.assign(new Error("terminal"), { code: "forged" });
      })
    });
    const consumer = await createConsumer(options);

    await consumer.receiveOne();
    expect(sqs.sendMessage).not.toHaveBeenCalled();
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it("recovers a post-commit delete failure by confirmed duplicate on redelivery with one effect", async () => {
    let receiveCount = 0;
    let effectCount = 0;
    const consume = vi.fn(async () => {
      if (effectCount === 0) {
        effectCount += 1;
        return { status: "applied" as const, aggregateVersion: 2 };
      }
      return { status: "confirmed_duplicate" as const, aggregateVersion: 2 };
    });
    const { options, sqs } = harness({ consume });
    sqs.receiveMessage = vi.fn(async () => ({ Messages: [receipt(++receiveCount)] }));
    sqs.deleteMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("post-commit delete failed"))
      .mockResolvedValueOnce(undefined);
    const consumer = await createConsumer(options);

    await expect(consumer.receiveOne()).resolves.toEqual({
      status: "undeleted",
      reasonCode: "delete_failed"
    });
    await expect(consumer.receiveOne()).resolves.toEqual({
      status: "deleted",
      outcome: "confirmed_duplicate"
    });
    expect(effectCount).toBe(1);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(sqs.deleteMessage).toHaveBeenCalledTimes(2);
    expect(sqs.deleteMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ReceiptHandle: "receipt-2" }),
      expect.anything()
    );
  });

  it("does not create a second delete path when a timed-out delete completes late", async () => {
    const deletion = deferred<void>();
    const { options, scheduler, sqs } = harness();
    sqs.deleteMessage = vi.fn(() => deletion.promise);
    const { result } = await start(options);

    await scheduler.advanceTo(20_000);
    deletion.resolve();
    await expect(result).resolves.toEqual({ status: "undeleted", reasonCode: "deadline_exceeded" });
    await flush();
    expect(sqs.deleteMessage).toHaveBeenCalledOnce();
  });

  it("never logs or returns the queue body, token, or rehydrated context", async () => {
    const capturedLogger = logger();
    const unsafeContextMarker = "RAW_CONTEXT_MARKER";
    const { options } = harness({
      logger: capturedLogger,
      rehydrate: vi.fn(async () => {
        throw Object.assign(new Error(unsafeContextMarker), { code: "revoked" });
      })
    });
    const consumer = await createConsumer(options);
    const result = await consumer.receiveOne();
    const rendered = `${JSON.stringify(result)} ${JSON.stringify(
      Object.values(capturedLogger).flatMap((entry) => entry.mock.calls)
    )}`;

    expect(rendered).not.toContain(rawToken);
    expect(rendered).not.toContain(JSON.stringify(envelope()));
    expect(rendered).not.toContain(unsafeContextMarker);
    expect(rendered).not.toMatch(/contextReference|membershipIds|roleHints/);
  });
});
