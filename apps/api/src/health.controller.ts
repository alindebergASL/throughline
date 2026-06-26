import { Controller, Get, Headers, Inject } from "@nestjs/common";
import { createRequestTraceContext } from "@throughline/observability";
import { HealthService } from "./health.service.js";

@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get("health")
  health(@Headers("x-request-id") requestId?: string, @Headers("x-trace-id") traceId?: string) {
    // Wave A1 diagnostic only. Authenticated security context must not be sourced from headers.
    const traceContext = createRequestTraceContext({ requestId, traceId });
    return this.healthService.getHealth(traceContext);
  }
}
