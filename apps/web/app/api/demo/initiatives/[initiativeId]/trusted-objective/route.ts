import { forwardDemoRequest, unavailableResponse } from "../../../../../../lib/demo-bff";

interface RouteContext {
  params: Promise<{ initiativeId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  if (new URL(request.url).search !== "") return unavailableResponse();
  return forwardDemoRequest({ initiativeId: (await context.params).initiativeId });
}

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginJsonMutation(request)) return unavailableResponse();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = parseAction(raw?.action);
  if (!action || !raw || hasUnexpectedEnvelopeKeys(raw)) return unavailableResponse();
  const body = bodyForAction(action, raw);
  if (body === null) return unavailableResponse();
  return forwardDemoRequest({
    initiativeId: (await context.params).initiativeId,
    action,
    body
  });
}

function isSameOriginJsonMutation(request: Request): boolean {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  const contentType = request.headers.get("content-type");
  if (
    !contentType ||
    !/^application\/json(?:\s*;\s*charset=[a-z0-9._-]+)?\s*$/i.test(contentType)
  ) {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const requestHost = request.headers.get("host") ?? requestUrl.host;
  if (
    originUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname) ||
    originUrl.host.toLowerCase() !== requestHost.toLowerCase()
  ) {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

function parseAction(
  value: unknown
): "source" | "proposal" | "accept" | "draft-confirmation" | null {
  return value === "source" ||
    value === "proposal" ||
    value === "accept" ||
    value === "draft-confirmation"
    ? value
    : null;
}

function hasUnexpectedEnvelopeKeys(value: Record<string, unknown>): boolean {
  const allowed = new Set(["action", "note", "objective", "exactExcerpt"]);
  return Object.keys(value).some((key) => !allowed.has(key));
}

function bodyForAction(
  action: "source" | "proposal" | "accept" | "draft-confirmation",
  value: Record<string, unknown>
): Record<string, unknown> | null {
  if (action === "source") {
    return typeof value.note === "string" &&
      value.objective === undefined &&
      value.exactExcerpt === undefined
      ? { note: value.note }
      : null;
  }
  if (action === "proposal") {
    return typeof value.objective === "string" &&
      typeof value.exactExcerpt === "string" &&
      value.note === undefined
      ? { objective: value.objective, exactExcerpt: value.exactExcerpt }
      : null;
  }
  return value.note === undefined &&
    value.objective === undefined &&
    value.exactExcerpt === undefined
    ? {}
    : null;
}
