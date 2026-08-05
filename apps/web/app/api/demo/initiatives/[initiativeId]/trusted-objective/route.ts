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
  if (!action || !raw || !hasExactEnvelopeKeys(action, raw)) return unavailableResponse();
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
):
  | "source"
  | "proposal"
  | "proposal/withdraw"
  | "proposal/rework"
  | "accept"
  | "draft-confirmation"
  | null {
  return value === "source" ||
    value === "proposal" ||
    value === "proposal/withdraw" ||
    value === "proposal/rework" ||
    value === "accept" ||
    value === "draft-confirmation"
    ? value
    : null;
}

function hasExactEnvelopeKeys(
  action: Exclude<ReturnType<typeof parseAction>, null>,
  value: Record<string, unknown>
): boolean {
  const expected = {
    source: ["action", "note"],
    proposal: [
      "action",
      "exactExcerpt",
      "objective",
      "proposalGenerationAnchor",
      "sourceRevisionAnchor",
      "supportConfirmed"
    ],
    "proposal/withdraw": [
      "action",
      "claimId",
      "disposition",
      "expectedClaimVersion",
      "expectedInitiativeVersion",
      "reasonCode"
    ],
    "proposal/rework": [
      "action",
      "claimId",
      "exactExcerpt",
      "expectedClaimVersion",
      "expectedInitiativeVersion",
      "objective",
      "sourceRevisionAnchor",
      "supportConfirmed"
    ],
    accept: ["action", "claimId", "expectedClaimVersion", "expectedInitiativeVersion"],
    "draft-confirmation": ["action"]
  } as const;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected[action]].sort());
}

function bodyForAction(
  action:
    | "source"
    | "proposal"
    | "proposal/withdraw"
    | "proposal/rework"
    | "accept"
    | "draft-confirmation",
  value: Record<string, unknown>
): Record<string, unknown> | null {
  if (action === "source") {
    return typeof value.note === "string" &&
      value.objective === undefined &&
      value.exactExcerpt === undefined &&
      value.supportConfirmed === undefined
      ? { note: value.note }
      : null;
  }
  if (action === "proposal") {
    return typeof value.objective === "string" &&
      typeof value.exactExcerpt === "string" &&
      typeof value.proposalGenerationAnchor === "string" &&
      typeof value.sourceRevisionAnchor === "string" &&
      value.supportConfirmed === true &&
      value.note === undefined
      ? {
          objective: value.objective,
          exactExcerpt: value.exactExcerpt,
          proposalGenerationAnchor: value.proposalGenerationAnchor,
          sourceRevisionAnchor: value.sourceRevisionAnchor,
          supportConfirmed: true
        }
      : null;
  }
  if (action === "proposal/rework") {
    return typeof value.objective === "string" &&
      typeof value.exactExcerpt === "string" &&
      typeof value.sourceRevisionAnchor === "string" &&
      value.supportConfirmed === true &&
      typeof value.claimId === "string" &&
      value.expectedClaimVersion === 1 &&
      typeof value.expectedInitiativeVersion === "number" &&
      value.note === undefined
      ? {
          claimId: value.claimId,
          expectedClaimVersion: value.expectedClaimVersion,
          expectedInitiativeVersion: value.expectedInitiativeVersion,
          objective: value.objective,
          exactExcerpt: value.exactExcerpt,
          sourceRevisionAnchor: value.sourceRevisionAnchor,
          supportConfirmed: true
        }
      : null;
  }
  if (action === "proposal/withdraw") {
    return typeof value.claimId === "string" &&
      value.expectedClaimVersion === 1 &&
      typeof value.expectedInitiativeVersion === "number" &&
      (value.disposition === "withdrawn" || value.disposition === "rejected") &&
      typeof value.reasonCode === "string" &&
      value.note === undefined &&
      value.objective === undefined &&
      value.exactExcerpt === undefined &&
      value.supportConfirmed === undefined
      ? {
          claimId: value.claimId,
          expectedClaimVersion: value.expectedClaimVersion,
          expectedInitiativeVersion: value.expectedInitiativeVersion,
          disposition: value.disposition,
          reasonCode: value.reasonCode
        }
      : null;
  }
  if (action === "accept") {
    return typeof value.claimId === "string" &&
      value.expectedClaimVersion === 1 &&
      typeof value.expectedInitiativeVersion === "number"
      ? {
          claimId: value.claimId,
          expectedClaimVersion: value.expectedClaimVersion,
          expectedInitiativeVersion: value.expectedInitiativeVersion
        }
      : null;
  }
  return value.note === undefined &&
    value.objective === undefined &&
    value.exactExcerpt === undefined &&
    value.supportConfirmed === undefined &&
    value.claimId === undefined &&
    value.expectedClaimVersion === undefined &&
    value.expectedInitiativeVersion === undefined &&
    value.disposition === undefined &&
    value.reasonCode === undefined &&
    value.proposalGenerationAnchor === undefined &&
    value.sourceRevisionAnchor === undefined
    ? {}
    : null;
}
