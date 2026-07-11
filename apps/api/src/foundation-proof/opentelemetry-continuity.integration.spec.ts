import {
  context as otelContext,
  propagation,
  trace,
  type Attributes,
  type Span
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan
} from "@opentelemetry/sdk-trace-base";
import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import type { ClaimedOutboxEvent, PgPool, PgPoolClient } from "@throughline/db";
import {
  createAsyncContextReferenceCodec,
  createDevSecurityContext,
  devFixtures
} from "@throughline/tenancy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rehydrateFoundationWorkerContext } from "../../../agent-worker/src/worker-context.js";
import { FoundationOutboxRelay } from "../../../outbox-relay/src/relay.js";
import {
  defaultFoundationProofRuntimeOptions,
  FoundationProofService
} from "./foundation-proof.service.js";

const spanNames = {
  api: "foundation.api.outbox",
  relay: "foundation.relay.publish",
  worker: "foundation.worker.receive"
} as const;

const now = new Date("2030-07-11T03:00:00.000Z");
const signingKey = new Uint8Array(32).fill(23);
let provider: BasicTracerProvider | undefined;
let contextManager: AsyncLocalStorageContextManager | undefined;

afterEach(async () => {
  await provider?.shutdown();
  contextManager?.disable();
  propagation.disable();
  trace.disable();
  otelContext.disable();
  provider = undefined;
  contextManager = undefined;
});

describe("Foundation OpenTelemetry continuity", () => {
  it("exports one sanitized parent chain through the actual API, relay, and worker seams", async () => {
    const exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    });
    contextManager = new AsyncLocalStorageContextManager().enable();
    expect(otelContext.setGlobalContextManager(contextManager)).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);

    const context = {
      ...createDevSecurityContext("tenant-a-owner", { now }),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000).toISOString()
    };
    const codec = createAsyncContextReferenceCodec({
      verificationKeys: new Map([["task8-signing-key", signingKey]]),
      activeKeyId: "task8-signing-key",
      clock: () => now
    });
    const writes = new Map<string, readonly unknown[]>();
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql === 'SELECT current_user AS "currentUser"') {
        return { rows: [{ currentUser: "throughline_app" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ops.security_context_references")) {
        writes.set("reference", values ?? []);
      }
      if (sql.includes("INSERT INTO ops.foundation_test_aggregates")) {
        return {
          rows: [{ id: "70000000-0000-7000-8000-000000000181", aggregateVersion: 1 }],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO ops.outbox_events")) writes.set("outbox", values ?? []);
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() } as unknown as PgPoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;
    const authorization = {
      can: vi.fn(),
      canInTransaction: vi.fn(async () => ({
        allowed: true,
        reasonCode: "allowed",
        policyVersion: context.policyVersion
      }))
    } as unknown as TransactionAwareAuthorizationService;
    let nextId = 181;
    const service = new FoundationProofService(
      pool,
      authorization,
      codec,
      defaultFoundationProofRuntimeOptions({
        relayServicePrincipalId: devFixtures.relayServicePrincipalA,
        workerServicePrincipalId: devFixtures.servicePrincipalA,
        uuidV7: () => `70000000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`
      })
    );

    let queueInput:
      | {
          MessageBody: string;
          MessageAttributes: Record<string, { StringValue: string }>;
        }
      | undefined;
    let workerResult: Awaited<ReturnType<typeof rehydrateFoundationWorkerContext>> | undefined;
    const tracer = trace.getTracer("throughline-task8-contract-test");
    await tracer.startActiveSpan("task8.external-client", async (rootSpan: Span) => {
      const root = rootSpan.spanContext();
      const traceparent = `00-${root.traceId}-${root.spanId}-01`;

      const created = await service.create({
        context,
        spaceId: devFixtures.restrictedSpaceA,
        proofKey: "proof-key-must-never-be-traced",
        traceparent,
        tracestate: "throughline=task8"
      });
      const outbox = requiredWrite(writes, "outbox");
      const claimed = claimedEvent(outbox);
      expect(claimed.jobId).toBe(created.jobId);

      const repository = {
        claimNext: vi.fn(async () => claimed),
        markPublished: vi.fn(async () => undefined),
        markRetry: vi.fn(),
        markTerminal: vi.fn()
      };
      const sqs = {
        send: vi.fn(async (command: { input: typeof queueInput }) => {
          queueInput = command.input;
          return { MessageId: "task8-message" };
        })
      };
      const relay = new FoundationOutboxRelay(
        repository as never,
        sqs as never,
        "http://localhost:4566/000000000000/throughline-foundation-test"
      );
      await relay.publishNext(context, { claimedBy: "relay-task8", leaseSeconds: 30 });

      const message = requiredQueueInput(queueInput);
      const reference = requiredWrite(writes, "reference");
      workerResult = await rehydrateFoundationWorkerContext({
        body: message.MessageBody,
        messageAttributes: message.MessageAttributes,
        codec,
        targetWorkerServicePrincipalId: devFixtures.servicePrincipalA,
        targetPolicyVersionId: context.policyVersion,
        bootstrapReference: vi.fn(async () => ({
          id: String(reference[0]),
          jobId: String(reference[1]),
          tenantId: String(reference[2]),
          workspaceId: String(reference[3]),
          spaceId: String(reference[4]),
          workerServicePrincipalId: String(reference[5]),
          delegatingUserId: String(reference[6]),
          delegatingMembershipId: String(reference[7]),
          policyVersionId: String(reference[8]),
          contextSnapshot: JSON.parse(String(reference[9])),
          issuedAt: reference[10] as Date,
          expiresAt: reference[11] as Date,
          status: "active",
          revokedAt: null,
          signingKeyId: String(reference[12])
        })),
        clock: () => now
      });
      rootSpan.end();
    });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const apiSpan = requiredSpan(spans, spanNames.api);
    const relaySpan = requiredSpan(spans, spanNames.relay);
    const workerSpan = requiredSpan(spans, spanNames.worker);
    const outbox = requiredWrite(writes, "outbox");
    const message = requiredQueueInput(queueInput);
    const result = requiredWorkerResult(workerResult);
    const clientSpan = requiredSpan(spans, "task8.external-client");

    expect(
      new Set(
        [apiSpan, relaySpan, workerSpan, clientSpan].map((span) => span.spanContext().traceId)
      )
    ).toEqual(new Set([clientSpan.spanContext().traceId]));
    expect(parentSpanId(apiSpan)).toBe(clientSpan.spanContext().spanId);
    expect(parentSpanId(relaySpan)).toBe(apiSpan.spanContext().spanId);
    expect(parentSpanId(workerSpan)).toBe(relaySpan.spanContext().spanId);
    expect(spanIdFromTraceparent(String(outbox[8]))).toBe(apiSpan.spanContext().spanId);
    expect(spanIdFromTraceparent(JSON.parse(message.MessageBody).traceparent)).toBe(
      relaySpan.spanContext().spanId
    );
    expect(message.MessageAttributes.traceparent?.StringValue).toBe(
      JSON.parse(message.MessageBody).traceparent
    );
    expect(spanIdFromTraceparent(result.metadata.traceparent)).toBe(
      workerSpan.spanContext().spanId
    );

    const expected = {
      "throughline.request.id": context.requestId,
      "throughline.job.id": String(outbox[10]),
      "throughline.tenant.id": context.tenantId,
      "throughline.workspace.id": context.workspaceId,
      "throughline.space.id": devFixtures.restrictedSpaceA
    };
    for (const span of [apiSpan, relaySpan, workerSpan]) {
      expect(span.attributes).toMatchObject(expected);
    }
    expectSanitized(spans, {
      actorUserId: context.actorUserId,
      actorMembershipId: context.actorMembershipId,
      signedToken: String(outbox[13]),
      signingKeyId: "task8-signing-key",
      proofKey: "proof-key-must-never-be-traced",
      rawBody: message.MessageBody
    });
  });
});

function requiredWrite(writes: Map<string, readonly unknown[]>, name: string) {
  const values = writes.get(name);
  if (!values) throw new Error(`Missing mocked ${name} write`);
  return values;
}

function claimedEvent(values: readonly unknown[]): ClaimedOutboxEvent {
  return {
    eventId: String(values[0]),
    eventType: "foundation.proof.created.v1",
    tenantId: String(values[1]),
    workspaceId: String(values[2]),
    spaceId: String(values[3]),
    aggregateType: "foundation_test_aggregate",
    aggregateId: String(values[4]),
    aggregateVersion: Number(values[5]),
    causationId: String(values[6]),
    requestId: String(values[7]),
    traceparent: String(values[8]),
    ...(values[9] === null ? {} : { tracestate: String(values[9]) }),
    jobId: String(values[10]),
    contextReferenceId: String(values[12]),
    signedContextReference: String(values[13]),
    claimedBy: "relay-task8",
    publicationAttempt: 1
  };
}

function requiredQueueInput<T>(value: T | undefined): T {
  if (!value) throw new Error("The actual relay did not publish a queue input");
  return value;
}

function requiredWorkerResult<T>(value: T | undefined): T {
  if (!value) throw new Error("The actual worker seam did not return rehydrated metadata");
  return value;
}

function requiredSpan(spans: ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(
      `Task 8 requires actual seam span ${name}; exported: ${spans.map((item) => item.name).join(", ")}`
    );
  }
  return span;
}

function parentSpanId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

function spanIdFromTraceparent(value: string): string {
  const match = /^00-[0-9a-f]{32}-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(value);
  if (!match?.[1]) throw new Error(`Invalid traceparent in Task 8 seam: ${value}`);
  return match[1];
}

function expectSanitized(spans: ReadableSpan[], secrets: Record<string, unknown>): void {
  const rendered = JSON.stringify(
    spans.map((span) => ({
      attributes: span.attributes as Attributes,
      events: span.events
    }))
  );
  expect(rendered).not.toMatch(
    /token|security.?context|proof.?key|signing.?key|actor|delegat|membership|role.?hint|data.?class|credential|raw.?body/i
  );
  for (const value of Object.values(secrets)) {
    if (value !== undefined) expect(rendered).not.toContain(String(value));
  }
}
