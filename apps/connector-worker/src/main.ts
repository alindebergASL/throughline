import { createRequestTraceContext } from "@throughline/observability";

const context = createRequestTraceContext({
  requestId: process.env.REQUEST_ID,
  traceId: process.env.TRACE_ID
});

console.log(JSON.stringify({ service: "throughline-connector-worker", ...context }));
