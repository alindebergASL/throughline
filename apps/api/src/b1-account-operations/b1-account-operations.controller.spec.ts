import { HttpException } from "@nestjs/common";
import { parseB1Command, B1AuthorizationError } from "@throughline/account-operations";
import { ContentInvariantError } from "@throughline/content";
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

  it("normalizes missing and unauthorized Sources to an identical public status, code, and body", async () => {
    const sourceArtifactId = "70000000-0000-7000-8000-000000000013";
    const denied = new B1AccountOperationsController({
      getSource: vi.fn(async () => {
        throw new B1AuthorizationError();
      })
    } as unknown as B1AccountOperationsRuntime);
    const missing = new B1AccountOperationsController({
      getSource: vi.fn(async () => {
        throw new ContentInvariantError("Source is unavailable");
      })
    } as unknown as B1AccountOperationsRuntime);
    const deniedReadBoundary = new B1AccountOperationsController({
      getSource: vi.fn(async () => {
        throw new Error("B1 resource is unavailable");
      })
    } as unknown as B1AccountOperationsRuntime);

    const deniedFailure = await controllerFailure(() =>
      denied.getSource(request(), sourceArtifactId)
    );
    const missingFailure = await controllerFailure(() =>
      missing.getSource(request(), sourceArtifactId)
    );
    const deniedReadBoundaryFailure = await controllerFailure(() =>
      deniedReadBoundary.getSource(request(), sourceArtifactId)
    );
    expect({ status: deniedFailure.getStatus(), response: deniedFailure.getResponse() }).toEqual({
      status: missingFailure.getStatus(),
      response: missingFailure.getResponse()
    });
    expect({
      status: deniedReadBoundaryFailure.getStatus(),
      response: deniedReadBoundaryFailure.getResponse()
    }).toEqual({
      status: missingFailure.getStatus(),
      response: missingFailure.getResponse()
    });
    expect({ status: deniedFailure.getStatus(), response: deniedFailure.getResponse() }).toEqual({
      status: 404,
      response: {
        error: "Not Found",
        message: "Resource unavailable",
        statusCode: 404
      }
    });
    expect(JSON.stringify(deniedFailure.getResponse())).not.toContain(sourceArtifactId);
  });

  it("does not turn a database/system failure into the Source unavailable 404 contract", async () => {
    const controller = new B1AccountOperationsController({
      getSource: vi.fn(async () => {
        throw new Error("database is unavailable");
      })
    } as unknown as B1AccountOperationsRuntime);

    const failure = await controllerFailure(() =>
      controller.getSource(request(), "70000000-0000-7000-8000-000000000014")
    );
    expect(failure.getStatus()).toBe(500);
    expect(failure.getResponse()).toEqual({
      error: "Internal Server Error",
      message: "Request could not be completed",
      statusCode: 500
    });
  });

  it("does not turn an unrelated typed Content invariant ending in unavailable into a 404", async () => {
    const controller = new B1AccountOperationsController({
      execute: vi.fn(async () => {
        throw new ContentInvariantError("Content projection is unavailable");
      })
    } as unknown as B1AccountOperationsRuntime);

    const failure = await controllerFailure(() =>
      controller.createOrganization(request("unrelated-content-unavailable"), {
        name: "Acme",
        domains: []
      })
    );
    expect(failure.getStatus()).toBe(409);
    expect(failure.getResponse()).toEqual({
      error: "Conflict",
      message: "Command precondition failed",
      statusCode: 409
    });
  });

  it.each(["Source correction predecessor is unavailable", "Source Activity link is unavailable"])(
    "keeps the expected Content invariant '%s' non-disclosing",
    async (message) => {
      const controller = new B1AccountOperationsController({
        execute: vi.fn(async () => {
          throw new ContentInvariantError(message);
        })
      } as unknown as B1AccountOperationsRuntime);

      const failure = await controllerFailure(() =>
        controller.createOrganization(request(`content-invariant-${message.length}`), {
          name: "Acme",
          domains: []
        })
      );
      expect(failure.getStatus()).toBe(404);
      expect(failure.getResponse()).toEqual({
        error: "Not Found",
        message: "Resource unavailable",
        statusCode: 404
      });
    }
  );

  it("maps a typed Content precondition failure to the public command-conflict contract", async () => {
    const controller = new B1AccountOperationsController({
      execute: vi.fn(async () => {
        throw new ContentInvariantError("Source tombstone precondition failed");
      })
    } as unknown as B1AccountOperationsRuntime);

    const failure = await controllerFailure(() =>
      controller.createOrganization(request("content-precondition"), { name: "Acme", domains: [] })
    );
    expect(failure.getStatus()).toBe(409);
    expect(failure.getResponse()).toEqual({
      error: "Conflict",
      message: "Command precondition failed",
      statusCode: 409
    });
  });
});

async function controllerFailure(callback: () => Promise<unknown>): Promise<HttpException> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error("Expected controller request to fail");
}
