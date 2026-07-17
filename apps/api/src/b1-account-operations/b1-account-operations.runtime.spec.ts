import type { PostgresAuthorizationService } from "@throughline/authorization";
import type { ContentRepository } from "@throughline/content";
import type { SecurityContext } from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import { createDevSecurityContext } from "@throughline/tenancy";
import type { WorkGraphRepository } from "@throughline/work-graph";
import { describe, expect, it, vi } from "vitest";
import {
  listAuthorizedActivitySources,
  readAuthorizedSource,
  readInitiativeWithAuthorizedOrganizations
} from "./b1-account-operations.runtime.js";

describe("authorized source projection ordering", () => {
  it("does not resolve a correction terminal or materialize source text/chunks after denial", async () => {
    const resolveCurrentSourceId = vi.fn();
    const getSource = vi.fn();
    const canInTransaction = vi.fn(async () => ({
      allowed: false,
      reasonCode: "b1_resource_not_available",
      policyVersion: "policy"
    }));

    await expect(
      readAuthorizedSource({
        content: { resolveCurrentSourceId, getSource } as unknown as ContentRepository,
        authorization: { canInTransaction } as unknown as PostgresAuthorizationService,
        tx: {} as TenantDbTransaction,
        context: createDevSecurityContext("tenant-a-owner") as SecurityContext,
        sourceArtifactId: "70000000-0000-7000-8000-000000000001"
      })
    ).rejects.toThrow("unavailable");

    expect(canInTransaction).toHaveBeenCalledTimes(1);
    expect(resolveCurrentSourceId).not.toHaveBeenCalled();
    expect(getSource).not.toHaveBeenCalled();
  });

  it("reauthorizes a corrected terminal before materializing it", async () => {
    const requestedId = "70000000-0000-7000-8000-000000000001";
    const terminalId = "70000000-0000-7000-8000-000000000002";
    const calls: string[] = [];
    const canInTransaction = vi.fn(async (_context, _action, resource: { id: string }) => {
      calls.push(`authorize:${resource.id}`);
      return { allowed: true, reasonCode: "allowed", policyVersion: "policy" };
    });
    const resolveCurrentSourceId = vi.fn(async () => {
      calls.push("resolve");
      return terminalId;
    });
    const getSource = vi.fn(async () => {
      calls.push("materialize");
      return { id: terminalId };
    });

    await expect(
      readAuthorizedSource({
        content: { resolveCurrentSourceId, getSource } as unknown as ContentRepository,
        authorization: { canInTransaction } as unknown as PostgresAuthorizationService,
        tx: {} as TenantDbTransaction,
        context: createDevSecurityContext("tenant-a-owner") as SecurityContext,
        sourceArtifactId: requestedId
      })
    ).resolves.toEqual({ id: terminalId });

    expect(calls).toEqual([
      `authorize:${requestedId}`,
      "resolve",
      `authorize:${terminalId}`,
      "materialize"
    ]);
    expect(getSource).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      terminalId,
      true
    );
  });

  it("enumerates identifiers, authorizes every candidate, then materializes only allowed sources", async () => {
    const sourceA = "70000000-0000-7000-8000-000000000011";
    const sourceDenied = "70000000-0000-7000-8000-000000000012";
    const sourceB = "70000000-0000-7000-8000-000000000013";
    const calls: string[] = [];
    const listActivitySourceCandidates = vi.fn(async () => {
      calls.push("enumerate");
      return [sourceA, sourceDenied, sourceB];
    });
    const canInTransaction = vi.fn(
      async (
        _context: SecurityContext,
        _action: string,
        resource: { id: string },
        _tx: TenantDbTransaction,
        options: { lockAuthority?: boolean }
      ) => {
        calls.push(`authorize:${resource.id}`);
        expect(options).toEqual({ lockAuthority: true });
        return {
          allowed: resource.id !== sourceDenied,
          reasonCode: "test",
          policyVersion: "policy"
        };
      }
    );
    const getSource = vi.fn(async (_tenant, _workspace, id: string) => {
      calls.push(`materialize:${id}`);
      return { id };
    });

    await expect(
      listAuthorizedActivitySources({
        content: {
          listActivitySourceCandidates,
          getSource
        } as unknown as ContentRepository,
        authorization: { canInTransaction } as unknown as PostgresAuthorizationService,
        tx: {} as TenantDbTransaction,
        context: createDevSecurityContext("tenant-a-owner") as SecurityContext,
        activityId: "70000000-0000-7000-8000-000000000014",
        activitySpaceId: "70000000-0000-7000-8000-000000000015"
      })
    ).resolves.toEqual([{ id: sourceA }, { id: sourceB }]);

    expect(calls).toEqual([
      "enumerate",
      `authorize:${sourceA}`,
      `authorize:${sourceDenied}`,
      `authorize:${sourceB}`,
      `materialize:${sourceA}`,
      `materialize:${sourceB}`
    ]);
    expect(getSource).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      sourceDenied,
      expect.anything()
    );
  });
});

describe("authorized Initiative organization projection", () => {
  it("removes unreadable associations and represents an unreadable primary as null", async () => {
    const hiddenPrimary = "70000000-0000-7000-8000-000000000021";
    const readableSupporting = "70000000-0000-7000-8000-000000000022";
    const getInitiativeOrganizationCandidates = vi.fn(async () => [
      hiddenPrimary,
      readableSupporting
    ]);
    const canInTransaction = vi.fn(
      async (_context: SecurityContext, _action: string, resource: { id: string }) => ({
        allowed: resource.id === readableSupporting,
        reasonCode: "test",
        policyVersion: "policy"
      })
    );
    const getInitiative = vi.fn(
      async (
        _tenant,
        _workspace,
        initiativeId: string,
        options: { organizationIds: string[] }
      ) => ({
        id: initiativeId,
        organizationIds: options.organizationIds,
        primaryOrganizationId: null
      })
    );

    const result = await readInitiativeWithAuthorizedOrganizations({
      graph: {
        getInitiativeOrganizationCandidates,
        getInitiative
      } as unknown as WorkGraphRepository,
      authorization: { canInTransaction } as unknown as PostgresAuthorizationService,
      tx: {} as TenantDbTransaction,
      context: createDevSecurityContext("tenant-a-owner") as SecurityContext,
      initiativeId: "70000000-0000-7000-8000-000000000023"
    });

    expect(getInitiative).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      { organizationIds: [readableSupporting] }
    );
    expect(result).toMatchObject({
      organizationIds: [readableSupporting],
      primaryOrganizationId: null
    });
    expect(JSON.stringify(result)).not.toContain(hiddenPrimary);
  });
});
