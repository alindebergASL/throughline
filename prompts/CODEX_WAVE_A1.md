# Codex Wave A1 Kickoff

```text
Create a new repository named `throughline` and implement only Wave A1 from Throughline Implementation Kickoff v0.1 and Epic P0-1 from Throughline Phase 0/1 Build Specification v0.1.1.

Treat both documents as binding architecture. Do not implement product features beyond the repository and delivery skeleton. Do not add a microservice framework, generic plugin SDK, Solution Pack runtime, OpenFGA, or provider integrations.

Required output:
1. pnpm/Turborepo monorepo with apps/web, apps/api, apps/agent-worker, apps/connector-worker, and apps/outbox-relay;
2. shared packages matching the approved module boundaries, with dependency linting that prevents Core from importing Account Operations, profiles, or adapters;
3. Next.js and NestJS/Fastify health endpoints;
4. local Docker Compose for PostgreSQL with pgvector, S3-compatible storage, and SQS-compatible queueing;
5. Drizzle migration foundation;
6. transactional outbox proof: one API request writes a domain test row and an outbox row in one transaction, the relay publishes it, and a worker consumes it idempotently;
7. OpenTelemetry trace propagation across web/API/outbox/worker;
8. unit and integration tests plus CI;
9. README with exact local startup and proof steps;
10. ADR-015 draft for identity-provider choice, without implementing production auth yet.

Keep the code production-oriented, typed, and minimal. Stop after the A1 gate is demonstrably passing. Report deviations, risks, commands run, and test results.
```
