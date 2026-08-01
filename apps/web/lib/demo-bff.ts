import { NextResponse } from "next/server";

type DemoPersona = "owner" | "unavailable";

const identityForPersona = Object.freeze({
  owner: "tenant-a-owner",
  unavailable: "tenant-b-viewer"
} as const satisfies Record<DemoPersona, string>);

export async function forwardDemoRequest(input: {
  initiativeId: string;
  action?: "source" | "proposal" | "accept" | "draft-confirmation";
  body?: unknown;
}): Promise<NextResponse> {
  if (!isUuid(input.initiativeId) || process.env.NODE_ENV === "production") {
    return unavailableResponse();
  }
  const identity = resolveDemoIdentity();
  if (!identity) return unavailableResponse();
  const origin = apiOrigin();
  if (!origin) return unavailableResponse();
  const suffix = input.action ? `/${input.action}` : "";
  const response = await fetch(
    `${origin}/v1/demo/initiatives/${encodeURIComponent(input.initiativeId)}/trusted-objective${suffix}`,
    {
      method: input.action ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        "x-throughline-dev-identity": identity,
        "x-request-id": `demo-${crypto.randomUUID()}`,
        "x-trace-id": crypto.randomUUID().replaceAll("-", "")
      },
      ...(input.action ? { body: JSON.stringify(input.body ?? {}) } : {}),
      cache: "no-store"
    }
  ).catch(() => null);
  if (!response || response.status === 404) return unavailableResponse();
  if (!response.ok) {
    return NextResponse.json(
      response.status === 409
        ? { statusCode: 409, message: "Command precondition failed", error: "Conflict" }
        : { statusCode: response.status, message: "Request could not be completed" },
      { status: response.status }
    );
  }
  return NextResponse.json(await response.json(), { status: response.status });
}

function resolveDemoIdentity(): string | null {
  const value: unknown = process.env.TRUSTED_OBJECTIVE_DEMO_PERSONA;
  return value === "owner" || value === "unavailable" ? identityForPersona[value] : null;
}

export function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { statusCode: 404, message: "Resource unavailable", error: "Not Found" },
    { status: 404 }
  );
}

function apiOrigin(): string | null {
  try {
    const url = new URL(process.env.THROUGHLINE_API_ORIGIN ?? "http://127.0.0.1:3001");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
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
