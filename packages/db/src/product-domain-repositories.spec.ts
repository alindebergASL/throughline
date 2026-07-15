import type { DomainNotificationEnvelope } from "@throughline/core-types";
import { describe, expect, it, vi } from "vitest";
import {
  DomainCommandRepository,
  ProductDomainInvariantError,
  ProductDomainOutboxWriter,
  ProductDomainTransactionRepositories,
  hashCanonicalCommandRequest
} from "./product-domain-repositories.js";
import type { TenantDbTransaction } from "./transaction.js";

const ids = {
  event: "70000000-0000-7000-8000-000000000001",
  aggregate: "70000000-0000-7000-8000-000000000002",
  command: "70000000-0000-7000-8000-000000000003",
  tenant: "10000000-0000-4000-8000-000000000001",
  workspace: "10000000-0000-4000-8000-000000000002",
  space: "10000000-0000-4000-8000-000000000003",
  user: "10000000-0000-4000-8000-000000000004",
  membership: "10000000-0000-4000-8000-000000000005",
  relay: "10000000-0000-4000-8000-000000000006"
} as const;

const requestHash = hashCanonicalCommandRequest({ title: "Trusted title", expectedVersion: 1 });

const reservation = {
  id: ids.command,
  tenantId: ids.tenant,
  workspaceId: ids.workspace,
  reservationSpaceId: ids.space,
  commandKind: "b1_0.fixture.v1",
  commandSchemaVersion: 1,
  idempotencyKey: "fixture-command-1",
  canonicalRequestHash: requestHash,
  actorUserId: ids.user,
  actorMembershipId: ids.membership,
  policyVersionId: "dev-policy-v1",
  requestId: "request-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
} as const;

const envelope: DomainNotificationEnvelope = {
  eventId: ids.event,
  eventType: "organization.created",
  eventSchemaVersion: 1,
  payloadSchemaVersion: 1,
  tenantId: ids.tenant,
  workspaceId: ids.workspace,
  spaceId: ids.space,
  aggregateType: "organization",
  aggregateId: ids.aggregate,
  aggregateVersion: 1,
  causationCommandId: ids.command,
  payload: { organizationId: ids.aggregate },
  requestId: "request-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
};

function txWithRows(...rowSets: unknown[][]): {
  tx: TenantDbTransaction;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  for (const rows of rowSets) query.mockResolvedValueOnce({ rows });
  return { tx: { query } as unknown as TenantDbTransaction, query };
}

describe("transaction-bound product domain repositories", () => {
  it("reserves with one fixed parameterized statement and composes only one transaction", async () => {
    const { tx, query } = txWithRows([{ id: ids.command }]);
    const repositories = new ProductDomainTransactionRepositories(tx);
    await expect(repositories.commands.reserve(reservation)).resolves.toEqual({
      status: "reserved",
      commandId: ids.command
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO ops.domain_command_records");
    expect(query.mock.calls[0]?.[0]).not.toMatch(/\$\{|fixture-command-1/);
    expect(repositories.audit).toBeDefined();
    expect(repositories.outbox).toBeDefined();
  });

  it("returns an exact completed replay and rejects trusted metadata/hash mismatches", async () => {
    const completed = {
      id: ids.command,
      command_schema_version: 1,
      canonical_request_hash: requestHash,
      state: "completed",
      actor_user_id: ids.user,
      actor_membership_id: ids.membership,
      delegating_user_id: null,
      delegating_membership_id: null,
      agent_principal_id: null,
      policy_version_id: "dev-policy-v1",
      result_resource_type: "organization",
      result_resource_id: ids.aggregate,
      safe_response: { organizationId: ids.aggregate },
      completed_at: new Date("2026-07-14T12:00:00Z")
    };
    const exact = txWithRows([], [completed]);
    await expect(new DomainCommandRepository(exact.tx).reserve(reservation)).resolves.toMatchObject(
      {
        status: "replay",
        command: { id: ids.command, resultResourceId: ids.aggregate }
      }
    );

    const mismatch = txWithRows([], [{ ...completed, canonical_request_hash: "0".repeat(64) }]);
    await expect(
      new DomainCommandRepository(mismatch.tx).reserve(reservation)
    ).rejects.toBeInstanceOf(ProductDomainInvariantError);
  });

  it("completes only through the exact state/result/safe-response columns", async () => {
    const completedAt = new Date("2026-07-14T12:00:00Z");
    const { tx, query } = txWithRows([
      {
        id: ids.command,
        result_resource_type: "organization",
        result_resource_id: ids.aggregate,
        safe_response: { organizationId: ids.aggregate },
        completed_at: completedAt
      }
    ]);
    await new DomainCommandRepository(tx).complete({
      commandId: ids.command,
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      reservationSpaceId: ids.space,
      commandKind: "b1_0.fixture.v1",
      idempotencyKey: "fixture-command-1",
      canonicalRequestHash: requestHash,
      resultResourceType: "organization",
      resultResourceId: ids.aggregate,
      safeResponse: { organizationId: ids.aggregate }
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("state = 'completed'");
    expect(sql).toContain("state = 'reserved'");
    expect(sql).not.toMatch(/tenant_id\s*=\s*\$\d+,/);
  });

  it("inserts or replays only a byte-equivalent trusted envelope and binding", async () => {
    const inserted = txWithRows([{ id: ids.event }]);
    await expect(
      new ProductDomainOutboxWriter(inserted.tx).insertOrReplay({
        envelope,
        relayServicePrincipalId: ids.relay,
        policyVersionId: "dev-policy-v1"
      })
    ).resolves.toEqual({ eventId: ids.event, replay: false });

    const row = {
      id: ids.event,
      tenant_id: ids.tenant,
      workspace_id: ids.workspace,
      space_id: ids.space,
      relay_service_principal_id: ids.relay,
      policy_version_id: "dev-policy-v1",
      event_type: envelope.eventType,
      event_schema_version: 1,
      payload_schema_version: 1,
      aggregate_type: envelope.aggregateType,
      aggregate_id: ids.aggregate,
      aggregate_version: 1,
      causation_command_id: ids.command,
      payload: envelope.payload,
      request_id: envelope.requestId,
      traceparent: envelope.traceparent,
      tracestate: null
    };
    const replay = txWithRows([], [row]);
    await expect(
      new ProductDomainOutboxWriter(replay.tx).insertOrReplay({
        envelope,
        relayServicePrincipalId: ids.relay,
        policyVersionId: "dev-policy-v1"
      })
    ).resolves.toEqual({ eventId: ids.event, replay: true });
    const replaySql = replay.query.mock.calls[1]?.[0] as string;
    expect(replaySql).toContain("FROM ops.product_outbox_events");
    expect(replaySql).not.toMatch(/\bFOR\s+(?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/i);

    const mismatch = txWithRows([], [{ ...row, request_id: "trusted-difference" }]);
    await expect(
      new ProductDomainOutboxWriter(mismatch.tx).insertOrReplay({
        envelope,
        relayServicePrincipalId: ids.relay,
        policyVersionId: "dev-policy-v1"
      })
    ).rejects.toBeInstanceOf(ProductDomainInvariantError);
  });

  it("hashes canonical key order but preserves Unicode and numeric trusted differences", () => {
    expect(hashCanonicalCommandRequest({ b: 2, a: "é" })).toBe(
      hashCanonicalCommandRequest({ a: "é", b: 2 })
    );
    expect(hashCanonicalCommandRequest({ value: "é" })).not.toBe(
      hashCanonicalCommandRequest({ value: "e\u0301" })
    );
    expect(hashCanonicalCommandRequest({ value: 1 })).not.toBe(
      hashCanonicalCommandRequest({ value: "1" })
    );
  });
});
