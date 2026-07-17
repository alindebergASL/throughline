import type { PostgresAuthorizationService } from "@throughline/authorization";
import type { ContentRepository } from "@throughline/content";
import type { SecurityContext } from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import { readAuthorizedSource } from "./b1-account-operations.runtime.js";

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
});
