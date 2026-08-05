import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/demo/initiatives/[initiativeId]/trusted-objective/route";
import { forwardDemoRequest } from "./demo-bff";
import { demoActionEnvelope, nextActionForState } from "./trusted-objective";

const initiativeId = "70000000-0000-7000-8000-000000000204";
const objective = "Reduce response time.";
const sourceRevisionAnchor = `trusted-objective:source-revision:${"b".repeat(64)}`;
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
    expect(JSON.stringify([source, proposal, rework, accept])).not.toMatch(
      /persona|identity|user|tenant|workspace|membership|role|permission|policy|visibility|accessClass|evidence(?:Hash|Offset)|excerptHash|startOffset|endOffset|acceptedBy|acceptanceScope|authority/i
    );
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
        state: "proposed",
        initiative: { ...base.initiative, canAccept: false },
        proposal: { supportConfirmed: true, canRework: true } as never
      })
    ).toBe("Rework proposed objective");
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
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-request-id"]).toMatch(/^demo-/);
    expect(headers["x-trace-id"]).toMatch(/^[a-f0-9]{32}$/);
    expect(headers).not.toHaveProperty("x-throughline-dev-identity");
    expect(headers).not.toHaveProperty("x-throughline-tenant-id");
    expect(headers).not.toHaveProperty("x-throughline-membership-id");
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
      "Suggested proposal · not accepted",
      "Correct evidence manually",
      "Reject suggestion and enter manually",
      'pendingFocusRef.current = "evidence"',
      'pendingFocusRef.current = "objective"',
      "focusAssistedObjectiveTarget",
      "did not find one safe objective",
      "Create proposed objective",
      "does not accept the objective as",
      "I confirm that this exact excerpt semantically supports this exact objective.",
      "setSupportConfirmed(false)",
      "Candidate supporting excerpt",
      "Treat the excerpt as a candidate until the server verifies it.",
      "data-step-heading",
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
    expect(css).toContain(".manual-evidence");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(component).not.toContain('className="sr-only" role="status"');
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
    expect(failedMutation).toContain(
      "The proposal changed. Current Initiative state is ready for review."
    );
    expect(failedMutation).toContain(
      "The request could not be completed. Current Initiative state was refreshed."
    );
    expect(failedMutation).toContain("setReworking(false)");
    expect(failedMutation).toContain("setRecoveryIntent(null)");
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
    expect(component).toContain(
      "[state?.state, reworking, recoveryIntent, unavailable, postFailureFocusEpoch]"
    );
    expect(component).toContain("unavailableHeadingRef.current?.focus()");
    const unavailableSurface = component.slice(
      component.indexOf('<section className="unavailable"'),
      component.indexOf(") : !state ? (")
    );
    expect(unavailableSurface).toContain("ref={unavailableHeadingRef}");
    expect(unavailableSurface).toContain("tabIndex={-1}");
  });

  it("renders only bounded objective rework lineage for proposed and accepted successors", async () => {
    const component = await readFile(
      new URL(
        "../app/organizations/initiatives/[initiativeId]/trusted-objective-experience.tsx",
        import.meta.url
      ),
      "utf8"
    );
    expect(component.match(/<ReworkLineage lineage=\{state\.reworkLineage\} \/>/g)).toHaveLength(2);
    expect(component).toContain("This successor was reworked from proposal");
    expect(component).toContain("Inspect objective rework lineage");
    expect(component).toContain("predecessorClaimId");
    expect(component).toContain("successorClaimId");
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
