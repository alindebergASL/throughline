import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/demo/initiatives/[initiativeId]/trusted-objective/route";
import { forwardDemoRequest } from "./demo-bff";
import { demoActionEnvelope, nextActionForState } from "./trusted-objective";

const initiativeId = "70000000-0000-7000-8000-000000000204";
const routeUrl = `http://localhost:3000/api/demo/initiatives/${initiativeId}/trusted-objective`;
const routeContext = { params: Promise.resolve({ initiativeId }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("trusted-objective UI and BFF contracts", () => {
  it("builds browser envelopes with action data and no authority-bearing fields", () => {
    const source = demoActionEnvelope("source", { note: "Maya: reduce response time." });
    const proposal = demoActionEnvelope("proposal", {
      objective: "Reduce response time.",
      exactExcerpt: "reduce response time"
    });
    const accept = demoActionEnvelope("accept", {});

    expect(source).toEqual({ action: "source", note: "Maya: reduce response time." });
    expect(proposal).toEqual({
      action: "proposal",
      objective: "Reduce response time.",
      exactExcerpt: "reduce response time"
    });
    expect(accept).toEqual({ action: "accept" });
    expect(JSON.stringify([source, proposal, accept])).not.toMatch(
      /persona|identity|user|tenant|workspace|membership|role|permission|policy|visibility|accessClass|evidence(?:Hash|Offset)|excerptHash|startOffset|endOffset|acceptedBy|acceptanceScope|authority/i
    );
  });

  it("maps trust states to one deterministic primary action", () => {
    expect(
      ["empty", "captured", "proposed", "accepted"].map((state) =>
        nextActionForState(state as "empty" | "captured" | "proposed" | "accepted")
      )
    ).toEqual([
      "Capture engagement note",
      "Propose trusted objective",
      "Accept trusted objective",
      "Draft confirmation question"
    ]);
  });

  it.each([
    ["owner", "tenant-a-owner"],
    ["unavailable", "tenant-b-viewer"]
  ])("maps the server environment value %s to its dev identity", async (value, identity) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", value);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "empty" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await forwardDemoRequest({ initiativeId });

    expect(response.status).toBe(200);
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-throughline-dev-identity"]).toBe(identity);
    expect(headers).not.toHaveProperty("x-throughline-tenant-id");
    expect(headers).not.toHaveProperty("x-throughline-membership-id");
  });

  it.each(["http://127.0.0.1:3001", "http://localhost:3001", "http://[::1]:3001"])(
    "allows the loopback API origin %s",
    async (origin) => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", "owner");
      vi.stubEnv("THROUGHLINE_API_ORIGIN", origin);
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ state: "empty" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await forwardDemoRequest({ initiativeId });

      expect(response.status).toBe(200);
      expect(fetchMock.mock.calls[0]![0]).toBe(
        `${origin}/v1/demo/initiatives/${initiativeId}/trusted-objective`
      );
    }
  );

  it.each(["https://localhost:3001", "http://api.example:3001"])(
    "rejects the non-loopback or non-http API origin %s",
    async (origin) => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", "owner");
      vi.stubEnv("THROUGHLINE_API_ORIGIN", origin);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await forwardDemoRequest({ initiativeId });

      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "", "admin", " owner ", "OWNER", "unavailable\n"])(
    "fails closed without an upstream request for server environment value %s",
    async (value) => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", value);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await forwardDemoRequest({ initiativeId });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        statusCode: 404,
        message: "Resource unavailable",
        error: "Not Found"
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("normalizes denied and missing upstream resources to the same response", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ statusCode: 404 }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", "unavailable");
    const denied = await forwardDemoRequest({ initiativeId });
    vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", "owner");
    const missing = await forwardDemoRequest({ initiativeId });

    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());
  });

  it("rejects browser-selected identity and unexpected authority fields before the upstream", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", "owner");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const queryInjection = await GET(new Request(`${routeUrl}?persona=unavailable`), routeContext);
    const bodyInjection = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept", persona: "unavailable" })
      }),
      routeContext
    );
    const authorityInjection = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept", tenantId: "tenant-a" })
      }),
      routeContext
    );

    expect([queryInjection.status, bodyInjection.status, authorityInjection.status]).toEqual([
      404, 404, 404
    ]);
    const queryBody = await queryInjection.json();
    const injectedBody = await bodyInjection.json();
    const authorityBody = await authorityInjection.json();
    expect(queryBody).toEqual(injectedBody);
    expect(injectedBody).toEqual(authorityBody);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the demo identity seam closed in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_OBJECTIVE_DEMO_PERSONA", "owner");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await forwardDemoRequest({ initiativeId });

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the Initiative flow semantic, keyboard-selectable, announced, focused, and responsive", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    for (const contract of [
      "<main",
      "<h1",
      "<h2",
      'aria-live="polite"',
      'className="action-announcement"',
      'role="status"',
      'aria-atomic="true"',
      'htmlFor="captured-source"',
      "selectionStart",
      "readOnly",
      "state.proposal.status",
      "Not sent"
    ]) {
      expect(component).toContain(contract);
    }
    expect(component).not.toContain("x-throughline-dev-identity");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("overflow-x: hidden");
    expect(css).toContain("min-width: 0");
    expect(css).toContain(".action-announcement");
    expect(css).toContain("max-width: 72ch");
    expect(component).not.toContain('className="sr-only" role="status"');
  });
});
