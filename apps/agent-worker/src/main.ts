import { createAgentWorkerContext } from "./worker-context.js";

const context = createAgentWorkerContext({
  requestId: process.env.REQUEST_ID,
  traceId: process.env.TRACE_ID
});

console.log(JSON.stringify({ service: "throughline-agent-worker", ...context }));
