import { describe, expect, it } from "vitest";
import { HealthService } from "./health.service.js";

describe("HealthService", () => {
  it("returns health status with request and trace identifiers", () => {
    const service = new HealthService();

    expect(
      service.getHealth({
        requestId: "req_wave_a1",
        traceId: "trace_wave_a1"
      })
    ).toEqual({
      status: "ok",
      service: "throughline-api",
      requestId: "req_wave_a1",
      traceId: "trace_wave_a1"
    });
  });
});
