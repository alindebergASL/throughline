import { Injectable } from "@nestjs/common";
import type { RequestTraceContext } from "@throughline/observability";

export interface HealthResponse extends RequestTraceContext {
  status: "ok";
  service: "throughline-api";
}

@Injectable()
export class HealthService {
  getHealth(traceContext: RequestTraceContext): HealthResponse {
    return {
      status: "ok",
      service: "throughline-api",
      requestId: traceContext.requestId,
      traceId: traceContext.traceId
    };
  }
}
