import { describe, expect, it } from "vitest";
import { createAgentWorkerContext } from "./worker-context.js";

describe("createAgentWorkerContext", () => {
  it("preserves request and trace identifiers from the API boundary", () => {
    expect(
      createAgentWorkerContext({
        requestId: "req_from_api",
        traceId: "trace_from_api"
      })
    ).toEqual({
      worker: "agent-worker",
      requestId: "req_from_api",
      traceId: "trace_from_api"
    });
  });

  it("generates request and trace identifiers when no input is provided", () => {
    const context = createAgentWorkerContext();

    expect(context.worker).toBe("agent-worker");
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
