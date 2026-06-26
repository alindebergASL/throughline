import {
  createRequestTraceContext,
  toWorkerTraceEnvelope,
  type RequestTraceContext,
  type RequestTraceContextInput
} from "@throughline/observability";

export interface WorkerBootstrapContext extends RequestTraceContext {
  worker: "agent-worker";
}

export function createAgentWorkerContext(
  input: RequestTraceContextInput = {}
): WorkerBootstrapContext {
  const traceContext = toWorkerTraceEnvelope(createRequestTraceContext(input));
  return {
    worker: "agent-worker",
    requestId: traceContext.requestId,
    traceId: traceContext.traceId
  };
}
