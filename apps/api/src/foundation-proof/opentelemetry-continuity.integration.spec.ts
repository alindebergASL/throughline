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
import type {
  RelayClaimIdentity,
  RelayPublicationRequest,
  PgPool,
  PgPoolClient
} from "@throughline/db";
import {
  createAsyncContextReferenceCodec,
  createDevSecurityContext,
  devFixtures
} from "@throughline/tenancy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rehydrateFoundationWorkerContext } from "../../../agent-worker/src/worker-context.js";
import { consumeFoundationRuntimeJob } from "../../../agent-worker/src/main.js";
import { FoundationOutboxRelay } from "../../../outbox-relay/src/relay.js";
import {
  defaultFoundationProofRuntimeOptions,
  FoundationProofService
} from "./foundation-proof.service.js";

const spanNames = {
  api: "foundation.api.request",
  commit: "foundation.api.database-outbox-commit",
  relay: "foundation.relay.publish",
  workerReceive: "foundation.worker.receive",
  workerRehydrate: "foundation.worker.rehydrate",
  workerAuthorize: "foundation.worker.authorize",
  workerHandle: "foundation.worker.handle"
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
      if (sql.includes("AS settings_cleared")) {
        return { rows: [{ settings_cleared: true }], rowCount: 1 };
      }
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
    let durableWorkerResult: Awaited<ReturnType<typeof consumeFoundationRuntimeJob>> | undefined;
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
        claimNext: vi.fn(async () => claimed.identity),
        publishClaimed: vi.fn(async (_context, claim, publisher) => {
          const acknowledgment = await publisher.publish(claimed.request);
          return {
            status: "published" as const,
            eventId: claim.eventId,
            messageId: acknowledgment.messageId
          };
        }),
        recordRetry: vi.fn(),
        recordTerminal: vi.fn()
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
      const rehydrated = requiredWorkerResult(workerResult);
      durableWorkerResult = await consumeFoundationRuntimeJob({
        pool: createWorkerPool(rehydrated.metadata.jobId),
        authorization: {
          canInTransaction: vi.fn(async () => ({
            allowed: true,
            reasonCode: "allowed",
            policyVersion: context.policyVersion
          }))
        },
        job: {
          jobId: rehydrated.metadata.jobId,
          contextReferenceId: rehydrated.metadata.contextReferenceId,
          securityContext: rehydrated.securityContext,
          continuationCarrier: rehydrated.metadata.continuationCarrier
        },
        deadline: { absoluteDeadlineMs: Date.now() + 20_000, now: Date.now }
      });
      rootSpan.end();
    });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const apiSpan = requiredSpan(spans, spanNames.api);
    const commitSpan = requiredSpan(spans, spanNames.commit);
    const relaySpan = requiredSpan(spans, spanNames.relay);
    const workerReceiveSpan = requiredSpan(spans, spanNames.workerReceive);
    const workerRehydrateSpan = requiredSpan(spans, spanNames.workerRehydrate);
    const workerAuthorizeSpan = requiredSpan(spans, spanNames.workerAuthorize);
    const workerHandleSpan = requiredSpan(spans, spanNames.workerHandle);
    const outbox = requiredWrite(writes, "outbox");
    const message = requiredQueueInput(queueInput);
    const result = requiredWorkerResult(workerResult);
    expect(durableWorkerResult).toMatchObject({ status: "applied", effectCount: 1 });
    const clientSpan = requiredSpan(spans, "task8.external-client");

    expect(
      new Set(
        [
          apiSpan,
          commitSpan,
          relaySpan,
          workerReceiveSpan,
          workerRehydrateSpan,
          workerAuthorizeSpan,
          workerHandleSpan,
          clientSpan
        ].map((span) => span.spanContext().traceId)
      )
    ).toEqual(new Set([clientSpan.spanContext().traceId]));
    expect(parentSpanId(apiSpan)).toBe(clientSpan.spanContext().spanId);
    expect(parentSpanId(commitSpan)).toBe(apiSpan.spanContext().spanId);
    expect(parentSpanId(relaySpan)).toBe(commitSpan.spanContext().spanId);
    expect(parentSpanId(workerReceiveSpan)).toBe(relaySpan.spanContext().spanId);
    expect(parentSpanId(workerRehydrateSpan)).toBe(workerReceiveSpan.spanContext().spanId);
    expect(parentSpanId(workerAuthorizeSpan)).toBe(workerRehydrateSpan.spanContext().spanId);
    expect(parentSpanId(workerHandleSpan)).toBe(workerAuthorizeSpan.spanContext().spanId);
    expect(spanIdFromTraceparent(String(outbox[8]))).toBe(commitSpan.spanContext().spanId);
    expect(spanIdFromTraceparent(JSON.parse(message.MessageBody).traceparent)).toBe(
      relaySpan.spanContext().spanId
    );
    expect(message.MessageAttributes.traceparent?.StringValue).toBe(
      JSON.parse(message.MessageBody).traceparent
    );
    expect(spanIdFromTraceparent(result.metadata.traceparent)).toBe(
      workerReceiveSpan.spanContext().spanId
    );

    const expected = {
      "throughline.request.id": context.requestId,
      "throughline.job.id": String(outbox[10]),
      "throughline.tenant.id": context.tenantId,
      "throughline.workspace.id": context.workspaceId,
      "throughline.space.id": devFixtures.restrictedSpaceA
    };
    for (const span of [
      apiSpan,
      commitSpan,
      relaySpan,
      workerReceiveSpan,
      workerRehydrateSpan,
      workerAuthorizeSpan,
      workerHandleSpan
    ]) {
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

function createWorkerPool(jobId: string): PgPool {
  const aggregate = {
    id: "70000000-0000-7000-8000-000000000181",
    pendingJobId: jobId,
    lastEffectJobId: null,
    effectCount: 0,
    aggregateVersion: 1
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("current_user") && sql.includes("pg_backend_pid")) {
      return {
        rows: [{ currentUser: "throughline_worker", backendPid: 801 }],
        rowCount: 1
      };
    }
    if (sql.includes("FROM ops.foundation_test_aggregates")) {
      return { rows: [aggregate], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO ops.idempotency_records")) {
      return { rows: [{ id: "70000000-0000-7000-8000-000000000191" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE ops.foundation_test_aggregates")) {
      return { rows: [{ aggregateVersion: 2, effectCount: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const cancellationQuery = vi.fn(async (sql: string) => {
    if (sql.includes("current_user") && sql.includes("pg_backend_pid")) {
      return {
        rows: [{ currentUser: "throughline_worker", backendPid: 802 }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const clients = [
    { query, release: vi.fn() },
    { query: cancellationQuery, release: vi.fn() }
  ] as unknown as PgPoolClient[];
  return {
    connect: vi.fn(async () => {
      const client = clients.shift();
      if (!client) throw new Error("Unexpected worker connection");
      return client;
    })
  } as unknown as PgPool;
}

function claimedEvent(values: readonly unknown[]): {
  identity: RelayClaimIdentity;
  request: RelayPublicationRequest;
  jobId: string;
} {
  const tenantId = String(values[1]);
  const workspaceId = String(values[2]);
  const spaceId = String(values[3]);
  const eventId = String(values[0]);
  const jobId = String(values[10]);
  return {
    jobId,
    identity: {
      eventId,
      claimedBy: "relay-task8",
      publicationAttempt: 1,
      claimToken: Buffer.alloc(32, 2).toString("base64url")
    } as RelayClaimIdentity,
    request: {
      eventType: "foundation.proof.created.v1",
      aggregateType: "foundation_test_aggregate",
      aggregateId: String(values[4]),
      aggregateVersion: Number(values[5]),
      causationId: String(values[6]),
      contextReferenceId: String(values[12]),
      routingKey: `tenant/${tenantId}/workspace/${workspaceId}/space/${spaceId}`,
      envelope: {
        version: "v1",
        eventId,
        jobId,
        scope: { tenantId, workspaceId, spaceId },
        contextReference: String(values[13]),
        requestId: String(values[7]),
        traceparent: String(values[8]),
        ...(values[9] === null ? {} : { tracestate: String(values[9]) })
      }
    }
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
