import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/demo/initiatives/[initiativeId]/trusted-objective/route";
import { forwardDemoRequest } from "./demo-bff";
import {
  demoActionEnvelope,
  nextActionForState,
  type TrustedObjectiveState
} from "./trusted-objective";

const initiativeId = "70000000-0000-7000-8000-000000000204";
const objective = "Reduce response time.";
const sourceRevisionAnchor = `trusted-objective:source-revision:${"b".repeat(64)}`;
const routeUrl = `http://localhost:3000/api/demo/initiatives/${initiativeId}/trusted-objective`;
const routeContext = { params: Promise.resolve({ initiativeId }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("trusted-objective UI and BFF contracts", () => {
  it("builds browser envelopes with action data and no authority-bearing fields", () => {
    const source = demoActionEnvelope("source", { note: "Maya: reduce response time." });
    const proposal = demoActionEnvelope("proposal", {
      objective: "Reduce response time.",
      exactExcerpt: "reduce response time",
      proposalGenerationAnchor: `trusted-objective:proposal-generation:${"a".repeat(64)}`,
      sourceRevisionAnchor,
      supportConfirmed: true
    });
    const rework = demoActionEnvelope("proposal/rework", {
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 2,
      objective: "Reduce governed response time.",
      exactExcerpt: "reduce governed response time",
      sourceRevisionAnchor,
      supportConfirmed: true
    });
    const accept = demoActionEnvelope("accept", {
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 2
    });
    const supersede = demoActionEnvelope("supersede" as never, {
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "accepted_value_changed",
      rationale: "The accepted objective changed."
    });
    const revoke = demoActionEnvelope("revoke" as never, {
      factId: "70000000-0000-7000-8000-000000000502",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The objective is no longer current."
    });

    expect(source).toEqual({ action: "source", note: "Maya: reduce response time." });
    expect(proposal).toEqual({
      action: "proposal",
      objective: "Reduce response time.",
      exactExcerpt: "reduce response time",
      proposalGenerationAnchor: `trusted-objective:proposal-generation:${"a".repeat(64)}`,
      sourceRevisionAnchor,
      supportConfirmed: true
    });
    expect(rework).toMatchObject({
      action: "proposal/rework",
      supportConfirmed: true,
      expectedClaimVersion: 1
    });
    expect(accept).toEqual({
      action: "accept",
      claimId: "70000000-0000-7000-8000-000000000401",
      expectedClaimVersion: 1,
      expectedInitiativeVersion: 2
    });
    expect(supersede).toEqual({
      action: "supersede",
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "accepted_value_changed",
      rationale: "The accepted objective changed."
    });
    expect(revoke).toEqual({
      action: "revoke",
      factId: "70000000-0000-7000-8000-000000000502",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The objective is no longer current."
    });
    expect(JSON.stringify([source, proposal, rework, accept, supersede, revoke])).not.toMatch(
      /persona|identity|user|tenant|workspace|membership|role|permission|policy|visibility|accessClass|evidence(?:Hash|Offset)|excerptHash|startOffset|endOffset|acceptedBy|acceptanceScope|authority/i
    );
  });

  it("constructs lifecycle envelopes field by field and drops exotic or authority-looking keys", () => {
    const inherited = Object.create({ tenantId: "inherited-tenant" }) as Record<
      string,
      string | number | boolean
    >;
    Object.assign(inherited, {
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The objective is no longer current.",
      actorUserId: "browser-owned"
    });
    Object.defineProperty(inherited, "policyVersion", {
      value: "hidden-policy",
      enumerable: false
    });
    Object.defineProperty(inherited, Symbol("authority"), {
      value: "symbol-authority",
      enumerable: true
    });
    const revoke = demoActionEnvelope("revoke", inherited);
    const supersede = demoActionEnvelope("supersede", {
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "accepted_value_changed",
      rationale: "The accepted objective changed.",
      authorityBasis: "browser-owned",
      __proto__: "browser-prototype"
    });

    expect(revoke).toEqual({
      action: "revoke",
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      reasonCode: "no_longer_true",
      rationale: "The objective is no longer current."
    });
    expect(supersede).toEqual({
      action: "supersede",
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "accepted_value_changed",
      rationale: "The accepted objective changed."
    });
    expect(Reflect.ownKeys(revoke)).toEqual([
      "action",
      "factId",
      "expectedFactVersion",
      "reasonCode",
      "rationale"
    ]);
  });

  it("maps trust states to one deterministic primary action", () => {
    const base = {
      initiative: { canAccept: false },
      proposal: null
    } as unknown as Parameters<typeof nextActionForState>[0];
    expect(nextActionForState({ ...base, state: "empty" })).toBe("Capture engagement note");
    expect(nextActionForState({ ...base, state: "captured" })).toBe("Propose trusted objective");
    expect(nextActionForState({ ...base, state: "accepted" })).toBe("Draft confirmation question");
    expect(
      nextActionForState({
        ...base,
        state: "accepted",
        replacementReview: { canSupersede: true }
      } as never)
    ).toBe("Supersede trusted objective");
    expect(nextActionForState({ ...base, state: "revoked" } as never)).toBe(
      "Capture updated objective"
    );
    expect(
      nextActionForState({
        ...base,
        state: "proposed",
        initiative: { ...base.initiative, canAccept: true },
        proposal: { supportConfirmed: true } as never,
        history: [{ availability: "redacted", objective: null, status: "Revoked" }]
      } as never)
    ).toBe("Accept trusted objective");
    expect(
      nextActionForState({
        ...base,
        state: "proposed",
        initiative: { ...base.initiative, canAccept: false },
        proposal: { supportConfirmed: true, canRework: true } as never
      })
    ).toBe("Rework proposed objective");
  });

  it("keeps accepted and replacement rework lineage explicitly attributed in the Web shape", () => {
    const acceptedLineage = [
      {
        predecessorClaimId: "70000000-0000-7000-8000-000000000399",
        successorClaimId: "70000000-0000-7000-8000-000000000401",
        disposition: "reworked" as const,
        reasonCode: "reworked" as const,
        reworkedAt: "2026-07-31T00:00:00.000Z"
      }
    ];
    const replacementLineage = [
      {
        predecessorClaimId: "70000000-0000-7000-8000-000000000400",
        successorClaimId: "70000000-0000-7000-8000-000000000402",
        disposition: "reworked" as const,
        reasonCode: "reworked" as const,
        reworkedAt: "2026-08-02T00:00:00.000Z"
      }
    ];
    const mapped = {
      reworkLineage: acceptedLineage,
      replacementReview: {
        status: "Replacement proposed, not accepted." as const,
        currentFactId: "70000000-0000-7000-8000-000000000501",
        currentFactVersion: 1,
        replacementClaimId: "70000000-0000-7000-8000-000000000402",
        replacementClaimVersion: 1,
        exactExcerpt: "exact evidence for B",
        sourceTitle: "Engagement note",
        changePreview: { from: "Objective A", to: "Objective B" },
        reworkLineage: replacementLineage,
        canSupersede: true
      }
    } satisfies Pick<TrustedObjectiveState, "reworkLineage" | "replacementReview">;

    expect(mapped.reworkLineage).toEqual(acceptedLineage);
    expect(mapped.replacementReview.reworkLineage).toEqual(replacementLineage);
    expect(mapped.reworkLineage).not.toEqual(mapped.replacementReview.reworkLineage);
  });

  it("forwards correlation metadata but no identity or authority", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "empty" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await forwardDemoRequest({ initiativeId });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-request-id"]).toMatch(/^demo-/);
    expect(headers["x-trace-id"]).toMatch(/^[a-f0-9]{32}$/);
    expect(headers).not.toHaveProperty("x-throughline-dev-identity");
    expect(headers).not.toHaveProperty("x-throughline-tenant-id");
    expect(headers).not.toHaveProperty("x-throughline-membership-id");
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates caller abort and bounds a stalled loopback fetch", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.useFakeTimers();
    const seenSignals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          seenSignals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const caller = new AbortController();
    const callerRequest = forwardDemoRequest({ initiativeId, signal: caller.signal });
    caller.abort();
    await expect(callerRequest).resolves.toMatchObject({ status: 404 });
    expect(seenSignals[0]?.aborted).toBe(true);

    const timeoutRequest = forwardDemoRequest({ initiativeId });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timeoutRequest).resolves.toMatchObject({ status: 404 });
    expect(seenSignals[1]?.aborted).toBe(true);
  });

  it("keeps the timeout active while a JSON body stalls after headers", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    let bodyReadStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        upstreamSignal = init.signal as AbortSignal;
        return stalledJsonResponse(upstreamSignal, () => {
          bodyReadStarted = true;
        });
      })
    );

    const pending = forwardDemoRequest({ initiativeId });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodyReadStarted).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      statusCode: 404,
      message: "Resource unavailable",
      error: "Not Found"
    });
  });

  it("propagates caller abort while a JSON body stalls after headers", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const caller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    let bodyReadStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        upstreamSignal = init.signal as AbortSignal;
        return stalledJsonResponse(upstreamSignal, () => {
          bodyReadStarted = true;
        });
      })
    );

    const pending = forwardDemoRequest({ initiativeId, signal: caller.signal });
    await vi.waitFor(() => expect(bodyReadStarted).toBe(true));
    caller.abort();
    const response = await withTestDeadline(pending);

    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      statusCode: 404,
      message: "Resource unavailable",
      error: "Not Found"
    });
  });

  it.each(["http://127.0.0.1:3001", "http://localhost:3001", "http://[::1]:3001"])(
    "allows the loopback API origin %s",
    async (origin) => {
      vi.stubEnv("NODE_ENV", "test");
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
      vi.stubEnv("THROUGHLINE_API_ORIGIN", origin);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await forwardDemoRequest({ initiativeId });

      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("normalizes denied and missing upstream resources to the same response", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ statusCode: 404 }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const denied = await forwardDemoRequest({ initiativeId });
    const missing = await forwardDemoRequest({ initiativeId });

    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());
  });

  it.each([401, 403, 500])(
    "normalizes non-conflict upstream status %s to generic unavailable",
    async (status) => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ statusCode: status }), { status }))
      );

      const response = await forwardDemoRequest({ initiativeId });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        statusCode: 404,
        message: "Resource unavailable",
        error: "Not Found"
      });
    }
  );

  it("preserves the trusted API generic validation response without details", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ internal: "must not pass through" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const response = await forwardDemoRequest({
      initiativeId,
      action: "revoke" as never,
      body: {}
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      statusCode: 400,
      message: "Request is invalid",
      error: "Bad Request"
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    ["malformed JSON", "not-json", "application/json"],
    ["non-JSON", "plain text", "text/plain"]
  ])("normalizes %s upstream 2xx to generic unavailable", async (_label, body, contentType) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { "content-type": contentType } })
        )
    );

    const response = await forwardDemoRequest({ initiativeId });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      statusCode: 404,
      message: "Resource unavailable",
      error: "Not Found"
    });
  });

  it("rejects browser-selected identity and unexpected authority fields before the upstream", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const queryInjection = await GET(new Request(`${routeUrl}?persona=unavailable`), routeContext);
    const bodyInjection = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: sameOriginJsonHeaders(),
        body: JSON.stringify({ action: "accept", persona: "unavailable" })
      }),
      routeContext
    );
    const authorityInjection = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: sameOriginJsonHeaders(),
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

  it("ignores and drops Next-injected forwarding metadata", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "empty" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(routeUrl, {
        headers: {
          host: "localhost:3000",
          "x-forwarded-for": "203.0.113.10",
          "x-forwarded-host": "public-proxy.example:8443",
          "x-forwarded-proto": "https"
        }
      }),
      routeContext
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `http://127.0.0.1:3001/v1/demo/initiatives/${initiativeId}/trusted-objective`
    );
    const outboundHeaders = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(Object.keys(outboundHeaders).sort()).toEqual([
      "content-type",
      "x-request-id",
      "x-trace-id"
    ]);
    expect(outboundHeaders).not.toHaveProperty("x-forwarded-for");
    expect(outboundHeaders).not.toHaveProperty("x-forwarded-host");
    expect(outboundHeaders).not.toHaveProperty("x-forwarded-proto");
  });

  it.each([
    ["Authorization", "authorization", "Bearer browser-owned"],
    ["Cookie", "cookie", "session=browser-owned"],
    ["Forwarded", "forwarded", "for=127.0.0.1;host=localhost:3000;proto=http"],
    ["Idempotency-Key", "idempotency-key", "browser-owned"],
    ["Proxy-Authorization", "proxy-authorization", "Basic browser-owned"],
    ["Role", "role", "workspace-owner"],
    ["X-Request-Id", "x-request-id", "browser-owned"],
    ["X-Trace-Id", "x-trace-id", "browser-owned"],
    ["X-Throughline-*", "x-throughline-browser-authority", "browser-owned"]
  ])("continues to reject the %s requester authority header", async (_label, name, value) => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request(routeUrl, { headers: { [name]: value } }), routeContext);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      statusCode: 404,
      message: "Resource unavailable",
      error: "Not Found"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects authority-bearing headers, invalid UUIDs, and lifecycle envelope extras before upstream", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const headerInjection = await GET(
      new Request(routeUrl, { headers: { "x-throughline-tenant-id": "tenant-a" } }),
      routeContext
    );
    const nonLoopbackGet = await GET(
      new Request(`https://app.example/api/demo/initiatives/${initiativeId}/trusted-objective`),
      routeContext
    );
    const nonLoopbackPost = await POST(
      new Request(`https://app.example/api/demo/initiatives/${initiativeId}/trusted-objective`, {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json"
        },
        body: JSON.stringify({ action: "source", note: "Exact source note" })
      }),
      routeContext
    );
    const queryPost = await POST(
      new Request(`${routeUrl}?tenant=tenant-a`, {
        method: "POST",
        headers: sameOriginJsonHeaders(),
        body: JSON.stringify({ action: "source", note: "Exact source note" })
      }),
      routeContext
    );
    const extraLifecycleField = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: sameOriginJsonHeaders(),
        body: JSON.stringify({
          action: "supersede",
          factId: "70000000-0000-7000-8000-000000000501",
          expectedFactVersion: 1,
          replacementClaimId: "70000000-0000-7000-8000-000000000402",
          expectedReplacementClaimVersion: 1,
          expectedInitiativeVersion: 2,
          reasonCode: "accepted_value_changed",
          rationale: "The accepted objective changed.",
          idempotencyKey: "browser-owned"
        })
      }),
      routeContext
    );
    const invalidUuid = await forwardDemoRequest({ initiativeId: "not-a-uuid" });

    expect([
      headerInjection.status,
      nonLoopbackGet.status,
      nonLoopbackPost.status,
      queryPost.status,
      extraLifecycleField.status,
      invalidUuid.status
    ]).toEqual([404, 404, 404, 404, 404, 404]);
    expect(headerInjection.headers.get("cache-control")).toContain("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards exact same-origin lifecycle envelopes without browser-owned authority metadata", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "accepted" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: sameOriginJsonHeaders(),
        body: JSON.stringify({
          action: "supersede",
          factId: "70000000-0000-7000-8000-000000000501",
          expectedFactVersion: 1,
          replacementClaimId: "70000000-0000-7000-8000-000000000402",
          expectedReplacementClaimVersion: 1,
          expectedInitiativeVersion: 2,
          reasonCode: "accepted_value_changed",
          rationale: "The accepted objective changed."
        })
      }),
      routeContext
    );

    expect(response.status).toBe(201);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `http://127.0.0.1:3001/v1/demo/initiatives/${initiativeId}/trusted-objective/supersede`
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      factId: "70000000-0000-7000-8000-000000000501",
      expectedFactVersion: 1,
      replacementClaimId: "70000000-0000-7000-8000-000000000402",
      expectedReplacementClaimVersion: 1,
      expectedInitiativeVersion: 2,
      reasonCode: "accepted_value_changed",
      rationale: "The accepted objective changed."
    });
  });

  it("rejects missing, forged, stale, or cross-action support confirmation envelopes", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const body of [
      { action: "proposal", objective, exactExcerpt: "evidence" },
      { action: "proposal", objective, exactExcerpt: "evidence", supportConfirmed: false },
      {
        action: "proposal",
        objective,
        exactExcerpt: "evidence",
        supportConfirmed: true,
        claimId: "70000000-0000-7000-8000-000000000401"
      },
      {
        action: "proposal/rework",
        claimId: "70000000-0000-7000-8000-000000000401",
        expectedClaimVersion: 1,
        expectedInitiativeVersion: 1,
        objective,
        exactExcerpt: "evidence",
        supportConfirmed: { confirmed: true }
      }
    ]) {
      const response = await POST(
        new Request(routeUrl, {
          method: "POST",
          headers: sameOriginJsonHeaders(),
          body: JSON.stringify(body)
        }),
        routeContext
      );
      expect(response.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bare acceptance envelope before forwarding", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: sameOriginJsonHeaders(),
        body: JSON.stringify({ action: "accept" })
      }),
      routeContext
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the demo identity seam closed in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await forwardDemoRequest({ initiativeId });

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "hostile safelisted text POST",
      { origin: "https://attacker.example", "content-type": "text/plain" }
    ],
    [
      "cross-origin JSON",
      { origin: "https://attacker.example", "content-type": "application/json" }
    ],
    ["missing Origin", { "content-type": "application/json" }],
    ["plain text", { origin: new URL(routeUrl).origin, "content-type": "text/plain" }],
    [
      "form encoding",
      { origin: new URL(routeUrl).origin, "content-type": "application/x-www-form-urlencoded" }
    ],
    ["cross-site fetch metadata", { ...sameOriginJsonHeaders(), "sec-fetch-site": "cross-site" }],
    [
      "malformed content type",
      { origin: new URL(routeUrl).origin, "content-type": "application/jsonx" }
    ]
  ])("rejects %s before parsing or forwarding", async (_label, headers) => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "accept",
          claimId: "70000000-0000-7000-8000-000000000401",
          expectedClaimVersion: 1,
          expectedInitiativeVersion: 2
        })
      }),
      routeContext
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      statusCode: 404,
      message: "Resource unavailable",
      error: "Not Found"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a same-origin JSON mutation with charset", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "accepted" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: {
          origin: new URL(routeUrl).origin,
          "content-type": "application/json; charset=utf-8",
          "sec-fetch-site": "same-origin"
        },
        body: JSON.stringify({
          action: "accept",
          claimId: "70000000-0000-7000-8000-000000000401",
          expectedClaimVersion: 1,
          expectedInitiativeVersion: 2
        })
      }),
      routeContext
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["duplicate member", '{"action":"source","note":"safe","note":"override"}', "application/json"],
    [
      "escaped duplicate member",
      '{"action":"source","note":"safe","n\\u006fte":"override"}',
      "application/json"
    ],
    ["malformed JSON", '{"action":"source",', "application/json"],
    [
      "prototype member",
      '{"action":"source","note":"safe","__proto__":{"polluted":true}}',
      "application/json"
    ],
    ["non-UTF-8 bytes", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), "application/json"],
    [
      "non-UTF-8 charset",
      '{"action":"source","note":"safe"}',
      "application/json; charset=iso-8859-1"
    ],
    [
      "duplicate charset",
      '{"action":"source","note":"safe"}',
      "application/json; charset=utf-8; charset=utf-8"
    ]
  ])("rejects %s before forwarding", async (_label, body, contentType) => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: {
          origin: new URL(routeUrl).origin,
          "content-type": contentType,
          "sec-fetch-site": "same-origin"
        },
        body
      }),
      routeContext
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the route request abort signal into the loopback helper", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const caller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          upstreamSignal = init.signal as AbortSignal;
          if (upstreamSignal.aborted) {
            reject(upstreamSignal.reason);
            return;
          }
          upstreamSignal.addEventListener("abort", () => reject(upstreamSignal?.reason), {
            once: true
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const routeRequest = new Request(routeUrl, {
      method: "POST",
      headers: sameOriginJsonHeaders(),
      body: JSON.stringify({ action: "source", note: "Exact source note" }),
      signal: caller.signal
    });
    const responsePromise = POST(routeRequest, routeContext);
    caller.abort();

    await expect(responsePromise).resolves.toMatchObject({ status: 404 });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("uses the actual loopback Host when the framework normalizes request.url", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "captured" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(routeUrl.replace("127.0.0.1", "localhost"), {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin"
        },
        body: JSON.stringify({ action: "source", note: "Exact source note" })
      }),
      routeContext
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("contains static semantic, focus-management, and overflow safeguards", async () => {
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
      "Suggested from the latest engagement · Not applied",
      "Correct evidence manually",
      "Reject suggestion and enter manually",
      'pendingFocusRef.current = "evidence"',
      'pendingFocusRef.current = "objective"',
      "focusAssistedObjectiveTarget",
      "did not find one safe objective",
      "Create proposed objective",
      "Nothing changes until you submit and approve it.",
      "I confirm that this exact excerpt semantically supports this exact objective.",
      "setSupportConfirmed(false)",
      "Candidate supporting excerpt",
      "Treat the excerpt as a candidate until it is verified.",
      "data-step-heading",
      "Suggested update · Not applied",
      "Draft only · not sent"
    ]) {
      expect(normalizeSource(component)).toContain(contract);
    }
    expect(component).not.toContain("x-throughline-dev-identity");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("overflow-x: hidden");
    expect(css).toContain("min-width: 0");
    expect(css).toContain(".action-announcement");
    expect(css).toContain("max-width: 72ch");
    expect(css).toContain(".manual-evidence");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(component).not.toContain('className="sr-only" role="status"');
  });

  it("presents the accepted objective and replacement review in calm domain-to-human language", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const current = sourceFunction(
      component,
      "CurrentObjectiveSurface",
      "ReplacementReviewSurface"
    );
    const replacement = sourceFunction(
      component,
      "ReplacementReviewSurface",
      "NoCurrentObjectiveSurface"
    );

    const normalizedCurrent = normalizeSource(current);
    const normalizedReplacement = normalizeSource(replacement);
    expect(normalizedCurrent).not.toContain("> Primary objective <");
    expect(normalizedCurrent).toContain(
      "Confirmed · {formatDateOnly(state.acceptedMemory.acceptedAt)} ·"
    );
    expect(normalizedCurrent).not.toContain("From {state.initiative.engagementTitle}");
    expect(normalizedCurrent).toContain("engagementTitle={state.initiative.engagementTitle}");
    expect(normalizedCurrent).toContain("Prepare the next conversation");
    expect(normalizedCurrent).toContain('className="text-action"');
    expect(normalizedCurrent).toContain("Suggest a revision");
    expect(normalizedCurrent).not.toContain("Update objective");
    expect(normalizedCurrent).toContain("History and options");
    expect(normalizedReplacement).toContain("An objective update is ready for your review");
    expect(normalizedReplacement).toContain("Current");
    expect(normalizedReplacement).toContain("Suggested update");
    expect(normalizedReplacement).toContain("Suggested from the latest engagement · Not applied");
    expect(normalizedReplacement).toContain(
      "The current objective stays in place until you approve this update. Approving moves it to history. Nothing is sent."
    );
    expect(normalizedReplacement).not.toContain("different primary objective for the Initiative");
    expect(normalizedReplacement).not.toContain('className="effect-copy"');
    expect(normalizedReplacement).toContain("Use updated objective");
    expect(normalizedReplacement).toContain("Keep current");
  });

  it("keeps the context to one quiet organization-and-title line", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const experience = sourceFunction(
      component,
      "TrustedObjectiveExperience",
      "CurrentObjectiveSurface"
    );

    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    const context = experience.slice(
      experience.indexOf('<p className="initiative-context">'),
      experience.indexOf("</p>", experience.indexOf('<p className="initiative-context">'))
    );

    expect(normalizeSource(context)).toMatch(
      /\{state\.initiative\.organizationName\} <span aria-hidden="true">·<\/span>.*\{state\.initiative\.title\}/
    );
    expect(context).not.toMatch(/>\s*Initiative\s*</);
    expect(css).toMatch(/\.initiative-context\s*\{[^}]*overflow:\s*hidden;[^}]*\}/s);
    expect(css).toMatch(/\.initiative-context\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*\}/s);
    expect(css).toMatch(/\.initiative-context\s*\{[^}]*white-space:\s*nowrap;[^}]*\}/s);
    expect(experience).not.toContain("<nav");
    expect(experience).not.toContain('aria-label="Primary"');
    expect(experience).not.toContain('className="eyebrow"');
    expect(experience).not.toContain("state.initiative.engagementTitle");
  });

  it("wires lifecycle actions to the existing exact envelopes without automatic supersession", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const replacement = sourceFunction(
      component,
      "ReplacementReviewSurface",
      "NoCurrentObjectiveSurface"
    );
    const removal = sourceFunction(component, "RemovalConfirmation", "EvidenceDisclosure");

    expect(replacement).toContain('act("supersede", {');
    expect(replacement).toContain("factId: acceptedMemory.factId");
    expect(replacement).toContain("replacementClaimId: replacementReview.replacementClaimId");
    expect(replacement).toContain('reasonCode: "accepted_value_changed"');
    expect(replacement).toContain('openRecovery("rejected")');
    expect(replacement).not.toMatch(/useEffect[\s\S]*act\("supersede"/);
    expect(removal).toContain('act("revoke", {');
    expect(removal).toContain("factId: acceptedMemory.factId");
    expect(removal).toContain("expectedFactVersion: acceptedMemory.version");
    expect(removal).toContain("reasonCode: removalReason");
    expect(removal).toContain("rationale: removalRationale.trim()");
  });

  it("keeps evidence, history, destructive management, and machinery progressively disclosed", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );

    const current = sourceFunction(
      component,
      "CurrentObjectiveSurface",
      "ReplacementReviewSurface"
    );
    const evidence = sourceFunction(
      component,
      "EvidenceDisclosure",
      "ProposalRecoveryConfirmation"
    );
    const primaryEvidence = evidence.slice(
      evidence.indexOf('<div className="evidence-panel">'),
      evidence.indexOf('className="review-details"')
    );

    expect(component).toContain("<EvidenceDisclosure");
    expect(evidence).toMatch(/<summary[^>]*>Source<\/summary>/);
    expect(evidence).toMatch(/<details\s+className="review-details"/);
    expect(evidence).toMatch(/<summary[^>]*>Review details<\/summary>/);
    expect(primaryEvidence).toContain("input.exactExcerpt");
    expect(primaryEvidence).toContain("input.sourceTitle");
    expect(primaryEvidence).toContain("input.relevantDate");
    expect(primaryEvidence).not.toContain("input.basis");
    expect(primaryEvidence).not.toContain("input.status");
    expect(primaryEvidence).not.toContain("input.confirmedBy");
    expect(primaryEvidence).not.toContain("input.supportStatement");
    expect(primaryEvidence).not.toContain("input.visibility");
    expect(current.match(/<summary>History and options<\/summary>/g)).toHaveLength(1);
    expect(current).not.toContain("<summary>More</summary>");
    expect(current).toContain("History");
    expect(current).not.toContain("<summary>Changed from</summary>");
    expect(current).not.toContain("<summary>Manage objective</summary>");
    expect(component).toContain("Exact excerpt");
    expect(component).toContain("Confirmed by");
    expect(component).toContain("does not establish");
    expect(component).not.toMatch(/>Trusted memory</);
    expect(component).not.toMatch(/Acceptance authority:/);
    expect(component).not.toMatch(/Effective visibility/);
    expect(component).not.toMatch(/Sent: \{String\(draft\.sent\)\}/);
    expect(component).not.toContain('placeholder="Search or ask Throughline..." disabled');
  });

  it("renders humane removal, honest absence, supersession completion, and draft-only boundaries", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const removal = sourceFunction(component, "RemovalConfirmation", "EvidenceDisclosure");
    const absent = sourceFunction(component, "NoCurrentObjectiveSurface", "RemovalConfirmation");

    expect(normalizeSource(component)).toContain(
      'setAnnouncement( "Objective updated. The previous objective remains in history. Nothing was sent." );'
    );
    expect(component).not.toContain('className="completion-note" role="status"');
    expect(component).toContain("Draft only · not sent");
    expect(normalizeSource(removal)).toContain(
      "This leaves the Initiative without a current objective. The objective and its evidence remain in history. Nothing is sent."
    );
    expect(removal).toContain("Why are you removing it?");
    expect(removal).toContain("Brief explanation");
    expect(removal).toContain("REVOKE_REASONS.map");
    expect(removal).toContain("maxLength={2000}");
    expect(removal).toContain("removalConfirmed");
    expect(absent).toContain("No current primary objective");
    expect(absent).toContain("The previous objective is no longer current. Its history remains.");
    expect(absent).toContain("Capture updated objective");
    expect(absent).not.toContain("acceptedMemory.objective");
  });

  it("keeps one filled primary per lifecycle surface with focus, escape, touch, and reflow safeguards", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    const current = sourceFunction(
      component,
      "CurrentObjectiveSurface",
      "ReplacementReviewSurface"
    );
    const replacement = sourceFunction(
      component,
      "ReplacementReviewSurface",
      "NoCurrentObjectiveSurface"
    );
    const absent = sourceFunction(component, "NoCurrentObjectiveSurface", "RemovalConfirmation");

    expect(current.match(/className="primary"/g)).toHaveLength(1);
    expect(replacement.match(/className="primary"/g)).toHaveLength(1);
    expect(absent.match(/className="primary"/g)).toHaveLength(1);
    expect(component).toContain('event.key === "Escape"');
    expect(component).toContain("summaryRef.current?.focus()");
    expect(component).toContain("reviewHeadingRef.current?.focus()");
    expect(component).toContain("No unconfirmed change occurred.");
    expect(component).toContain("Refresh current objective");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("min-width: 44px");
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("does not focus the first successful objective render but restores focus after actionable changes", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const experience = sourceFunction(
      component,
      "TrustedObjectiveExperience",
      "CurrentObjectiveSurface"
    );
    const focusEffect = experience.slice(
      experience.indexOf("useEffect(() => {", experience.indexOf("refreshCurrentObjective")),
      experience.indexOf("function openRecovery")
    );
    const normalizedEffect = normalizeSource(focusEffect);

    expect(experience).toContain("const hasRenderedSuccessfulStateRef = useRef(false)");
    expect(normalizedEffect).toContain("if (!state) return;");
    expect(normalizedEffect).toContain(
      "if (!hasRenderedSuccessfulStateRef.current) { hasRenderedSuccessfulStateRef.current = true; return; }"
    );
    expect(focusEffect.indexOf("hasRenderedSuccessfulStateRef.current = true")).toBeLessThan(
      focusEffect.indexOf('document.querySelector<HTMLElement>("[data-step-heading]")')
    );
    expect(focusEffect).toContain('document.querySelector<HTMLElement>("[data-step-heading]")');
    expect(focusEffect).toContain("postFailureFocusEpoch");
    expect(focusEffect).toContain("state?.state");
    expect(focusEffect).toContain("suggestingUpdate");
    expect(focusEffect).toContain("removalOpen");
  });

  it("keeps Source and the revision text action compact on 390px mobile", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    const current = sourceFunction(
      component,
      "CurrentObjectiveSurface",
      "ReplacementReviewSurface"
    );
    const mobile = css.slice(css.indexOf("@media (max-width: 480px)"));

    expect(normalizeSource(current)).toContain(
      '<div className="source-line"> <span>Confirmed · {formatDateOnly(state.acceptedMemory.acceptedAt)} ·</span> <EvidenceDisclosure'
    );
    expect(css).toMatch(/\.source-line\s*>\s*span\s*\{[^}]*white-space:\s*nowrap;[^}]*\}/s);
    expect(mobile).not.toContain(".objective-actions button");
    expect(mobile).toMatch(/\.objective-actions \.text-action\s*\{[^}]*width:\s*auto;[^}]*\}/s);
    expect(css).toContain(".more-disclosure > summary::after");
    expect(css).toContain('content: "›"');
    expect(css).toContain(".more-disclosure[open] > summary::after");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.more-disclosure > summary::after\s*\{[^}]*transition:\s*none;/
    );
  });

  it("statically wires every proposal-preparation control to the in-flight request lock", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const card = component.slice(
      component.indexOf("function ObjectiveSuggestionCard"),
      component.indexOf("function manualExplanation")
    );

    expect(card).toContain("const controlsDisabled = input.busy");
    expect(card.match(/disabled=\{controlsDisabled\}/g)).toHaveLength(8);
    expect(card).toContain("readOnly={isSuggested && !correctingEvidence}");
  });

  it("runs synchronous action attempts as an owner-token single flight", async () => {
    const helper = await import("./assisted-objective-focus");
    const runSingleFlight = Reflect.get(helper, "runSingleFlight") as <Result>(
      owner: { current: symbol | null },
      setBusy: (busy: boolean) => void,
      request: () => Promise<Result>
    ) => Promise<Result | undefined>;
    const owner = { current: null as symbol | null };
    const busyEvents: boolean[] = [];
    const announcements: string[] = [];
    let requestCount = 0;
    let settle!: (value: string) => void;
    const deferred = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const request = () => {
      requestCount += 1;
      announcements.push("Saving");
      return deferred;
    };

    const first = runSingleFlight(owner, (busy) => busyEvents.push(busy), request);
    const losing = runSingleFlight(owner, (busy) => busyEvents.push(busy), request);

    expect(requestCount).toBe(1);
    expect(announcements).toEqual(["Saving"]);
    expect(busyEvents).toEqual([true]);
    expect(owner.current).not.toBeNull();
    await expect(losing).resolves.toBeUndefined();

    settle("saved");
    await expect(first).resolves.toBe("saved");
    expect(busyEvents).toEqual([true, false]);
    expect(owner.current).toBeNull();

    let settleStale!: () => void;
    const staleDeferred = new Promise<void>((resolve) => {
      settleStale = resolve;
    });
    const staleOwner = { current: null as symbol | null };
    const staleBusyEvents: boolean[] = [];
    const staleFlight = runSingleFlight(
      staleOwner,
      (busy) => staleBusyEvents.push(busy),
      () => staleDeferred
    );
    const replacementOwner = Symbol("replacement owner");
    staleOwner.current = replacementOwner;
    settleStale();
    await staleFlight;

    expect(staleOwner.current).toBe(replacementOwner);
    expect(staleBusyEvents).toEqual([true]);
  });

  it("statically uses the synchronous single-flight owner around every trusted action", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );

    expect(component).toContain("runSingleFlight");
    expect(component).toContain("requestOwnerRef");
    expect(component).toContain("runSingleFlight(requestOwnerRef, setBusy, async () =>");
    for (const action of [
      '| "source"',
      '| "proposal"',
      '| "proposal/withdraw"',
      '| "proposal/rework"',
      '| "accept"',
      '| "supersede"',
      '| "revoke"',
      '| "draft-confirmation"'
    ]) {
      expect(component).toContain(action);
    }
    expect(component).toContain("const controlsDisabled = input.busy");
    expect(component).toContain('disabled={busy || note.trim() === ""}');
    expect(component).toContain("disabled={busy}");
  });

  it("refreshes capabilities after both conflict and unavailable mutation failures", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const failedMutation = component.slice(
      component.indexOf("if (!response.ok) {"),
      component.indexOf('if (action === "draft-confirmation")')
    );
    expect(failedMutation).toContain("await load(");
    expect(failedMutation).toContain("response.status === 409");
    expect(normalizeSource(failedMutation)).toContain(
      "This objective changed before your action completed. No unconfirmed change occurred. The current Initiative objective was refreshed."
    );
    expect(normalizeSource(failedMutation)).toContain(
      "The request could not be completed. No unconfirmed change occurred. The current Initiative objective was refreshed."
    );
    expect(failedMutation).toContain("setReworking(false)");
    expect(failedMutation).toContain("setSuggestingUpdate(false)");
    expect(failedMutation).toContain("setRecoveryIntent(null)");
    expect(failedMutation).toContain("setFailureMessage(message)");
    expect(component).toContain("setUnavailable(true)");
    expect(component).toContain("setState(null)");
  });

  it("refocuses the refreshed workflow after every failed mutation", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    expect(component.match(/setPostFailureFocusEpoch\(\(epoch\) => epoch \+ 1\)/g)).toHaveLength(2);
    for (const dependency of [
      "state?.state",
      "reworking",
      "suggestingUpdate",
      "recoveryIntent",
      "removalOpen",
      "unavailable",
      "postFailureFocusEpoch"
    ]) {
      expect(component).toContain(dependency);
    }
    expect(component).toContain("unavailableHeadingRef.current?.focus()");
    const unavailableSurface = component.slice(
      component.indexOf('<section className="unavailable"'),
      component.indexOf(") : !state ? (")
    );
    expect(unavailableSurface).toContain("ref={unavailableHeadingRef}");
    expect(unavailableSurface).toContain("tabIndex={-1}");
  });

  it("keeps proposal identifiers and rework lineage out of the default frontstage", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    expect(component).not.toContain("<ReworkLineage");
    expect(component).not.toContain("This successor was reworked from proposal");
    expect(component).not.toContain("Inspect objective rework lineage");
    expect(component).not.toContain("shortClaimId");
    expect(component).not.toMatch(/generic.*(?:claim|fact).*history/i);
  });

  it("keeps deterministic assistance pure, browser-only, and separate from authority", async () => {
    const adviser = await readFile(new URL("./assisted-objective.ts", import.meta.url), "utf8");
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );

    expect(adviser).not.toMatch(/^import\s/m);
    expect(adviser).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/
    );
    expect(component).toContain("createAssistedObjectiveDraft(input.source.note)");
    expect(component).toContain('act("proposal", {');
    expect(component).toContain("proposalGenerationAnchor: state.proposalGenerationAnchor");
    expect(component).toContain("sourceRevisionAnchor: state.sourceRevisionAnchor!");
    expect(component).toContain("claimId: state.proposal!.claimId");
    expect(component).not.toMatch(
      /assistedObjective.*(?:tenant|workspace|membership|authority|hash|offset)/i
    );
  });
});

function sameOriginJsonHeaders(): Record<string, string> {
  return {
    origin: new URL(routeUrl).origin,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin"
  };
}

function stalledJsonResponse(signal: AbortSignal, onRead: () => void): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: vi.fn(() => {
      onRead();
      return new Promise<never>((_resolve, reject) => {
        const rejectOnAbort = () => reject(signal.reason ?? new Error("Upstream aborted"));
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
    })
  } as unknown as Response;
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Test operation did not settle")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sourceFunction(source: string, startName: string, endName: string): string {
  const start = source.indexOf(`function ${startName}`);
  const end = source.indexOf(`function ${endName}`);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

function normalizeSource(source: string): string {
  return source.replace(/\s+/g, " ");
}
