import { HttpException } from "@nestjs/common";
import { parseB1Command, B1AuthorizationError } from "@throughline/account-operations";
import { createDevSecurityContext } from "@throughline/tenancy";
import { describe, expect, it, vi } from "vitest";
import { B1AccountOperationsController } from "./b1-account-operations.controller.js";
import type { B1AccountOperationsRequest } from "./b1-account-operations.guard.js";
import type { B1AccountOperationsRuntime } from "./b1-account-operations.runtime.js";

function request(idempotencyKey = "request-key"): B1AccountOperationsRequest {
  return {
    headers: { "idempotency-key": idempotencyKey },
    b1Context: createDevSecurityContext("tenant-a-owner")
  };
}

describe("B1AccountOperationsController", () => {
  it("forwards a manual body only through the typed command facade", async () => {
    const execute = vi.fn(async (command: unknown) => {
      const parsed = parseB1Command(command as never);
      return {
        organizationId: "70000000-0000-7000-8000-000000000001",
        spaceId: "70000000-0000-7000-8000-000000000002",
        version: 1,
        parsed
      };
    });
    const controller = new B1AccountOperationsController({
      execute
    } as unknown as B1AccountOperationsRuntime);
    await controller.createOrganization(request(), { name: "Acme", domains: ["acme.example"] });
    expect(execute).toHaveBeenCalledWith(
      {
        kind: "organization.create",
        idempotencyKey: "request-key",
        payload: { name: "Acme", domains: ["acme.example"] }
      },
      expect.objectContaining({ actorUserId: expect.any(String) })
    );
  });

  it.each([
    ["missing", ""],
    ["control character", "bad\nkey"],
    ["too long", "x".repeat(201)]
  ])("rejects a %s Idempotency-Key before runtime mutation", async (_case, key) => {
    const execute = vi.fn();
    const controller = new B1AccountOperationsController({
      execute
    } as unknown as B1AccountOperationsRuntime);
    await expect(
      controller.createOrganization(request(key), { name: "Acme", domains: [] })
    ).rejects.toMatchObject({ status: 400 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied trusted scope, profile, hash, and audit fields", async () => {
    const execute = vi.fn(async (command: unknown) => parseB1Command(command as never));
    const controller = new B1AccountOperationsController({
      execute
    } as unknown as B1AccountOperationsRuntime);
    for (const field of [
      "tenantId",
      "workspaceId",
      "spaceId",
      "profileVersion",
      "contentHash",
      "actorUserId",
      "auditAction"
    ]) {
      const outcome = controller.createOrganization(request(`key-${field}`), {
        name: "Acme",
        domains: [],
        [field]: "caller-controlled"
      });
      await expect(outcome).rejects.toMatchObject({ status: 400 });
    }
  });

  it("derives source Activity identity from the path and rejects a body override", async () => {
    const controller = new B1AccountOperationsController({
      execute: vi.fn()
    } as unknown as B1AccountOperationsRuntime);
    expect(() =>
      controller.captureSource(request(), "70000000-0000-7000-8000-000000000003", {
        activityId: "70000000-0000-7000-8000-000000000004",
        sourceType: "note",
        text: "opaque"
      })
    ).toThrowError(HttpException);
    expect(() =>
      controller.captureSource(request(), "70000000-0000-7000-8000-000000000003", {
        sourceType: "note",
        text: "opaque",
        requestedAccessClass: "public"
      })
    ).toThrowError(HttpException);
  });

  it("uses one non-leaking 404 response for denied and missing resources", async () => {
    const controller = new B1AccountOperationsController({
      getActivity: vi.fn(async () => {
        throw new B1AuthorizationError();
      })
    } as unknown as B1AccountOperationsRuntime);
    let failure: unknown;
    try {
      await controller.getActivity(request(), "70000000-0000-7000-8000-000000000003");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 404, response: { message: "Resource unavailable" } });
    expect(JSON.stringify(failure)).not.toContain("70000000-0000-7000-8000-000000000003");
  });
});
