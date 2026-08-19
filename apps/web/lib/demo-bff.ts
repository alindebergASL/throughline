import { NextResponse } from "next/server";

const LOOPBACK_TIMEOUT_MS = 5_000;

export async function forwardDemoRequest(input: {
  initiativeId: string;
  action?:
    | "source"
    | "proposal"
    | "proposal/withdraw"
    | "proposal/rework"
    | "accept"
    | "supersede"
    | "revoke"
    | "draft-confirmation";
  body?: unknown;
  signal?: AbortSignal;
}): Promise<NextResponse> {
  if (!isUuid(input.initiativeId) || process.env.NODE_ENV === "production") {
    return unavailableResponse();
  }
  const origin = apiOrigin();
  if (!origin) return unavailableResponse();
  const suffix = input.action ? `/${input.action}` : "";
  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  if (input.signal?.aborted) abortUpstream();
  else input.signal?.addEventListener("abort", abortUpstream, { once: true });
  const timeout = setTimeout(abortUpstream, LOOPBACK_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${origin}/v1/demo/initiatives/${encodeURIComponent(input.initiativeId)}/trusted-objective${suffix}`,
      {
        method: input.action ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-request-id": `demo-${crypto.randomUUID()}`,
          "x-trace-id": crypto.randomUUID().replaceAll("-", "")
        },
        ...(input.action ? { body: JSON.stringify(input.body ?? {}) } : {}),
        cache: "no-store",
        signal: controller.signal
      }
    ).catch(() => null);
    if (!response || response.status === 404) return unavailableResponse();
    if (!response.ok) {
      if (response.status === 400) {
        return noStoreJson(
          { statusCode: 400, message: "Request is invalid", error: "Bad Request" },
          400
        );
      }
      if (response.status !== 409) return unavailableResponse();
      return noStoreJson(
        { statusCode: 409, message: "Command precondition failed", error: "Conflict" },
        409
      );
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return unavailableResponse();
    }
    const body = await response.json().catch(() => null);
    if (body === null) return unavailableResponse();
    return noStoreJson(body, response.status);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortUpstream);
  }
}

export function unavailableResponse(): NextResponse {
  return noStoreJson({ statusCode: 404, message: "Resource unavailable", error: "Not Found" }, 404);
}

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store, max-age=0" }
  });
}

function apiOrigin(): string | null {
  try {
    const url = new URL(process.env.THROUGHLINE_API_ORIGIN ?? "http://127.0.0.1:3001");
    if (
      url.protocol !== "http:" ||
      url.username !== "" ||
      url.password !== "" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
