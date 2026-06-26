import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";

async function createTestApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe("HealthController", () => {
  it("returns health with request and trace identifiers from diagnostic headers", async () => {
    const app = await createTestApp();

    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "GET",
          url: "/health",
          headers: {
            "x-request-id": "req_http_wave_a1",
            "x-trace-id": "trace_http_wave_a1"
          }
        });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        service: "throughline-api",
        requestId: "req_http_wave_a1",
        traceId: "trace_http_wave_a1"
      });
    } finally {
      await app.close();
    }
  });

  it("generates identifiers when diagnostic headers are absent", async () => {
    const app = await createTestApp();

    try {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: "/health"
      });
      const body = response.json() as { requestId?: string; traceId?: string };

      expect(response.statusCode).toBe(200);
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await app.close();
    }
  });
});
