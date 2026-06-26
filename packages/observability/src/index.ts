import { randomUUID } from "node:crypto";

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
