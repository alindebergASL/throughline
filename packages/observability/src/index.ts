import { randomBytes, randomUUID } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export interface TraceCarrier {
  traceparent: string;
  tracestate?: string;
}

export type SafeTraceAttributeName =
  | "throughline.request.id"
  | "throughline.job.id"
  | "throughline.tenant.id"
  | "throughline.workspace.id"
  | "throughline.space.id";

export type SafeTraceAttributes = Readonly<
  Partial<Record<SafeTraceAttributeName, string | undefined>>
>;

export interface PropagatedSpanOptions {
  name: string;
  parentCarrier?: Partial<TraceCarrier>;
  fallbackCarrier?: TraceCarrier;
  attributes?: SafeTraceAttributes;
}

export interface PropagatedSpanContext {
  span: Span;
  carrier: TraceCarrier;
}

const SAFE_TRACE_ATTRIBUTE_NAMES = new Set<string>([
  "throughline.request.id",
  "throughline.job.id",
  "throughline.tenant.id",
  "throughline.workspace.id",
  "throughline.space.id"
]);
const propagator = new W3CTraceContextPropagator();
const tracer = trace.getTracer("@throughline/observability");
const carrierGetter = {
  keys: (carrier: Partial<TraceCarrier>) => Object.keys(carrier),
  get: (carrier: Partial<TraceCarrier>, key: string) => carrier[key as keyof TraceCarrier]
};
const carrierSetter = {
  set: (carrier: Partial<TraceCarrier>, key: string, value: string) => {
    carrier[key as keyof TraceCarrier] = value;
  }
};

export async function withPropagatedSpan<T>(
  options: PropagatedSpanOptions,
  callback: (result: PropagatedSpanContext) => T | Promise<T>
): Promise<T> {
  const attributes = validateSafeTraceAttributes(options.attributes);
  const name = validateSpanName(options.name);
  const parent = selectParent(options.parentCarrier, options.fallbackCarrier);

  return tracer.startActiveSpan(name, { attributes }, parent.context, async (span) => {
    const carrier = trace.isSpanContextValid(span.spanContext())
      ? injectSpan(parent.context, span)
      : parent.carrier;
    try {
      return await callback({ span, carrier });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function selectParent(
  incoming: Partial<TraceCarrier> | undefined,
  fallback: TraceCarrier | undefined
): { context: Context; carrier: TraceCarrier } {
  const extractedIncoming = extractValidCarrier(incoming);
  if (extractedIncoming) return extractedIncoming;

  const extractedFallback = extractValidCarrier(fallback);
  if (extractedFallback) return extractedFallback;

  const carrier: TraceCarrier = {
    traceparent: `00-${randomTracePart(16)}-${randomTracePart(8)}-01`
  };
  const context = propagator.extract(ROOT_CONTEXT, carrier, carrierGetter);
  return { context, carrier };
}

function extractValidCarrier(
  carrier: Partial<TraceCarrier> | undefined
): { context: Context; carrier: TraceCarrier } | undefined {
  if (!carrier) return undefined;
  const context = propagator.extract(ROOT_CONTEXT, carrier, carrierGetter);
  const spanContext = trace.getSpanContext(context);
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;

  const sanitized: Partial<TraceCarrier> = {};
  propagator.inject(context, sanitized, carrierSetter);
  return typeof sanitized.traceparent === "string"
    ? { context, carrier: sanitized as TraceCarrier }
    : undefined;
}

function injectSpan(parent: Context, span: Span): TraceCarrier {
  const carrier: Partial<TraceCarrier> = {};
  propagator.inject(trace.setSpan(parent, span), carrier, carrierSetter);
  if (typeof carrier.traceparent !== "string") {
    throw new Error("OpenTelemetry failed to inject a valid child carrier");
  }
  return carrier as TraceCarrier;
}

function validateSafeTraceAttributes(attributes: SafeTraceAttributes | undefined) {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (!SAFE_TRACE_ATTRIBUTE_NAMES.has(name)) {
      throw new Error(`OpenTelemetry attribute is not allowlisted: ${name}`);
    }
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`OpenTelemetry attribute must be a safe string identifier: ${name}`);
    }
    safe[name] = value;
  }
  return safe;
}

function validateSpanName(name: string): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 256 || /[\r\n]/.test(name)) {
    throw new Error("OpenTelemetry span name is invalid");
  }
  return name;
}

function randomTracePart(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export interface RequestTraceContext {
  requestId: string;
  traceId: string;
}

export interface RequestTraceContextInput {
  requestId?: string | undefined;
  traceId?: string | undefined;
}

export function createRequestTraceContext(
  input: RequestTraceContextInput = {}
): RequestTraceContext {
  return {
    requestId: input.requestId ?? randomUUID(),
    traceId: input.traceId ?? randomUUID()
  };
}

export function toWorkerTraceEnvelope(context: RequestTraceContext): RequestTraceContext {
  // TODO Wave A2+: replace with a signed context reference before queue propagation.
  return {
    requestId: context.requestId,
    traceId: context.traceId
  };
}
