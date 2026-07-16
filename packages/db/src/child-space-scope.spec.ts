import { describe, expect, it, vi } from "vitest";
import type { PgPoolClient } from "./client.js";
import {
  withCreatedChildSpaceScope,
  type ChildCreationDbTransaction,
  type TenantDbTransaction
} from "./transaction.js";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "11111111-1111-4111-8111-111111111112",
  expectedParentSpaceId: "11111111-1111-4111-8111-111111111113",
  kind: "organization" as const,
  name: "Example Account",
  accessClass: "workspace" as const,
  inheritanceMode: "inherit" as const
};
const relayId = "70000000-0000-7000-8000-000000000051";

function fixture(initialSpace = scope.expectedParentSpaceId) {
  let currentSpace = initialSpace;
  let childScopeActive = "";
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push(values ? { sql, values } : { sql });
      if (sql.includes("set_config('app.space_id'")) currentSpace = String(values?.[0] ?? "");
      if (sql.includes("set_config('throughline.b1_child_scope_active', '1'"))
        childScopeActive = "1";
      if (sql.includes("set_config('throughline.b1_child_scope_active', ''")) childScopeActive = "";
      return { rows: [] };
    })
  } as unknown as PgPoolClient;
  const tx = {
    client,
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push(values ? { sql, values } : { sql });
      if (sql.includes("current_setting('app.space_id'")) {
        return { rows: [{ space_id: currentSpace, child_scope_active: childScopeActive || null }] };
      }
      if (sql.includes("FROM access.spaces") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: scope.expectedParentSpaceId }] };
      }
      if (sql.includes("INSERT INTO access.spaces")) return { rows: [{ id: values?.[0] }] };
      if (sql.includes("FROM identity.service_principals")) return { rows: [{ id: relayId }] };
      if (sql.includes("INSERT INTO access.access_relationships")) {
        return { rows: [{ id: values?.[0] }] };
      }
      if (sql.includes("INSERT INTO work.organizations")) return { rows: [{ id: values?.[0] }] };
      if (sql.includes("INSERT INTO work.organization_domains")) return { rows: [] };
      if (sql.includes("INSERT INTO ops.audit_events")) return { rows: [{ id: values?.[0] }] };
      if (sql.includes("INSERT INTO ops.product_outbox_events")) {
        return { rows: [{ id: values?.[0] }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    })
  } as unknown as TenantDbTransaction;
  return {
    calls,
    client,
    get currentSpace() {
      return currentSpace;
    },
    tx
  };
}

describe("withCreatedChildSpaceScope", () => {
  it("exposes only the restricted child capability and restores the exact parent", async () => {
    const fixtureState = fixture();
    const result = await withCreatedChildSpaceScope(fixtureState.tx, scope, async (child) => {
      expect(Object.keys(child).sort()).toEqual([
        "childSpaceId",
        "createInitiative",
        "createOrganization",
        "insertAudit",
        "insertOutbox",
        "relayServicePrincipalId"
      ]);
      expect("query" in child).toBe(false);
      expect("client" in child).toBe(false);
      expect(child.childSpaceId).toMatch(/^[0-9a-f-]{14}7[0-9a-f]{3}-[89ab]/i);
      const organization = await child.createOrganization({
        name: "Example Account",
        normalizedName: "example account",
        domains: ["example.com"]
      });
      await recordSideEffects(child, organization.organizationId);
      return organization;
    });

    expect(result.organizationId).toMatch(/^[0-9a-f-]{14}7[0-9a-f]{3}-[89ab]/i);
    expect(fixtureState.currentSpace).toBe(scope.expectedParentSpaceId);
    const grant = fixtureState.calls.find(({ sql }) =>
      sql.includes("INSERT INTO access.access_relationships")
    );
    expect(grant?.sql).toContain("'service_principal'");
    expect(grant?.sql).toContain("'manager'");
    expect(grant?.sql).toContain("'space'");
    expect(grant?.sql).toContain("'direct'");
    expect(grant?.values?.[3]).toBe(relayId);
  });

  it("restores parent scope when the restricted callback fails", async () => {
    const fixtureState = fixture();
    await expect(
      withCreatedChildSpaceScope(fixtureState.tx, scope, async () => {
        throw new Error("injected callback failure");
      })
    ).rejects.toThrow("injected callback failure");
    expect(fixtureState.currentSpace).toBe(scope.expectedParentSpaceId);
  });

  it("rejects a forged current scope before creating a Space or access row", async () => {
    const fixtureState = fixture("22222222-2222-4222-8222-222222222224");
    await expect(
      withCreatedChildSpaceScope(fixtureState.tx, scope, async () => undefined)
    ).rejects.toThrow("Created child Space transaction invariant failed");
    expect(fixtureState.calls.some(({ sql }) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("rejects a nested child-scope transition even when the callback captures the outer transaction", async () => {
    const fixtureState = fixture();
    await withCreatedChildSpaceScope(fixtureState.tx, scope, async (child) => {
      await expect(
        withCreatedChildSpaceScope(
          fixtureState.tx,
          { ...scope, expectedParentSpaceId: child.childSpaceId, name: "Nested" },
          async () => undefined
        )
      ).rejects.toThrow("Created child Space transaction invariant failed");
      const organization = await child.createOrganization({
        name: "Example Account",
        normalizedName: "example account",
        domains: []
      });
      await recordSideEffects(child, organization.organizationId);
    });
    expect(
      fixtureState.calls.filter(({ sql }) => sql.includes("INSERT INTO access.spaces"))
    ).toHaveLength(1);
  });

  it("cannot create a second aggregate in the generated child Space", async () => {
    const fixtureState = fixture();
    await withCreatedChildSpaceScope(fixtureState.tx, scope, async (child) => {
      const aggregate = {
        name: "Example Account",
        normalizedName: "example account",
        domains: []
      };
      await child.createOrganization(aggregate);
      await expect(child.createOrganization(aggregate)).rejects.toThrow(
        "Created child Space transaction invariant failed"
      );
      const organizationId = fixtureState.calls.find(({ sql }) =>
        sql.includes("INSERT INTO work.organizations")
      )?.values?.[0] as string;
      await recordSideEffects(child, organizationId);
    });
    expect(
      fixtureState.calls.filter(({ sql }) => sql.includes("INSERT INTO work.organizations"))
    ).toHaveLength(1);
  });

  it("rejects a successful callback that omits any aggregate, audit, or outbox write", async () => {
    const fixtureState = fixture();
    await expect(
      withCreatedChildSpaceScope(fixtureState.tx, scope, async (child) =>
        child.createOrganization({
          name: "Incomplete Account",
          normalizedName: "incomplete account",
          domains: []
        })
      )
    ).rejects.toThrow("Created child Space transaction invariant failed");
    expect(fixtureState.currentSpace).toBe(scope.expectedParentSpaceId);
  });
});

async function recordSideEffects(child: ChildCreationDbTransaction, organizationId: string) {
  const commandId = "71000000-0000-7000-8000-000000000001";
  const policyVersionId = "11111111-1111-4111-8111-111111111121";
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  await child.insertAudit({
    id: "72000000-0000-7000-8000-000000000001",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    spaceId: child.childSpaceId,
    causationCommandId: commandId,
    actorUserId: "73000000-0000-7000-8000-000000000001",
    actorMembershipId: "74000000-0000-7000-8000-000000000001",
    policyVersionId,
    requestId: "child-scope-test",
    traceparent,
    action: "organization.create",
    resourceType: "organization",
    resourceId: organizationId,
    auditSchemaVersion: 1,
    safeDetail: { organizationId }
  });
  await child.insertOutbox({
    policyVersionId,
    envelope: {
      eventId: "75000000-0000-7000-8000-000000000001",
      eventType: "organization.created",
      eventSchemaVersion: 1,
      payloadSchemaVersion: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      spaceId: child.childSpaceId,
      aggregateType: "organization",
      aggregateId: organizationId,
      aggregateVersion: 1,
      causationCommandId: commandId,
      payload: { organizationId },
      requestId: "child-scope-test",
      traceparent
    }
  });
}
