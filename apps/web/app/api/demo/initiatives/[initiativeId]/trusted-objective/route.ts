import { forwardDemoRequest, unavailableResponse } from "../../../../../../lib/demo-bff";

interface RouteContext {
  params: Promise<{ initiativeId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  if (
    new URL(request.url).search !== "" ||
    !isLoopbackRequest(request) ||
    hasRequesterAuthorityHeaders(request)
  ) {
    return unavailableResponse();
  }
  return forwardDemoRequest({
    initiativeId: (await context.params).initiativeId,
    signal: request.signal
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (
    new URL(request.url).search !== "" ||
    !isLoopbackRequest(request) ||
    !isSameOriginJsonMutation(request) ||
    hasRequesterAuthorityHeaders(request)
  ) {
    return unavailableResponse();
  }
  const raw = await readUniqueJsonObject(request);
  const action = parseAction(raw?.action);
  if (!action || !raw || !hasExactEnvelopeKeys(action, raw)) return unavailableResponse();
  const body = bodyForAction(action, raw);
  if (body === null) return unavailableResponse();
  return forwardDemoRequest({
    initiativeId: (await context.params).initiativeId,
    action,
    body,
    signal: request.signal
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
  if (!contentType || !isUtf8JsonContentType(contentType)) {
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
    originUrl.username !== "" ||
    originUrl.password !== "" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname) ||
    originUrl.host.toLowerCase() !== requestHost.toLowerCase()
  ) {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

function isLoopbackRequest(request: Request): boolean {
  try {
    const requestUrl = new URL(request.url);
    const requestHost = request.headers.get("host") ?? requestUrl.host;
    const hostUrl = new URL(`http://${requestHost}`);
    return (
      requestUrl.protocol === "http:" &&
      requestUrl.username === "" &&
      requestUrl.password === "" &&
      hostUrl.username === "" &&
      hostUrl.password === "" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(requestUrl.hostname) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(hostUrl.hostname)
    );
  } catch {
    return false;
  }
}

function parseAction(
  value: unknown
):
  | "source"
  | "proposal"
  | "proposal/withdraw"
  | "proposal/rework"
  | "accept"
  | "supersede"
  | "revoke"
  | "draft-confirmation"
  | null {
  return value === "source" ||
    value === "proposal" ||
    value === "proposal/withdraw" ||
    value === "proposal/rework" ||
    value === "accept" ||
    value === "supersede" ||
    value === "revoke" ||
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
    supersede: [
      "action",
      "expectedFactVersion",
      "expectedInitiativeVersion",
      "expectedReplacementClaimVersion",
      "factId",
      "rationale",
      "reasonCode",
      "replacementClaimId"
    ],
    revoke: ["action", "expectedFactVersion", "factId", "rationale", "reasonCode"],
    "draft-confirmation": ["action"]
  } as const;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.every((key) => typeof key === "string") &&
    JSON.stringify((ownKeys as string[]).sort()) === JSON.stringify([...expected[action]].sort())
  );
}

function bodyForAction(
  action:
    | "source"
    | "proposal"
    | "proposal/withdraw"
    | "proposal/rework"
    | "accept"
    | "supersede"
    | "revoke"
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
      isUuid(value.claimId) &&
      value.expectedClaimVersion === 1 &&
      isPositiveInteger(value.expectedInitiativeVersion) &&
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
      isUuid(value.claimId) &&
      value.expectedClaimVersion === 1 &&
      isPositiveInteger(value.expectedInitiativeVersion) &&
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
      isUuid(value.claimId) &&
      value.expectedClaimVersion === 1 &&
      isPositiveInteger(value.expectedInitiativeVersion)
      ? {
          claimId: value.claimId,
          expectedClaimVersion: value.expectedClaimVersion,
          expectedInitiativeVersion: value.expectedInitiativeVersion
        }
      : null;
  }
  if (action === "supersede") {
    return typeof value.factId === "string" &&
      isUuid(value.factId) &&
      isPositiveInteger(value.expectedFactVersion) &&
      typeof value.replacementClaimId === "string" &&
      isUuid(value.replacementClaimId) &&
      value.expectedReplacementClaimVersion === 1 &&
      isPositiveInteger(value.expectedInitiativeVersion) &&
      (value.reasonCode === "newer_evidence" ||
        value.reasonCode === "accepted_value_changed" ||
        value.reasonCode === "corrected_source_revalidated") &&
      validRationale(value.rationale)
      ? {
          factId: value.factId,
          expectedFactVersion: value.expectedFactVersion,
          replacementClaimId: value.replacementClaimId,
          expectedReplacementClaimVersion: value.expectedReplacementClaimVersion,
          expectedInitiativeVersion: value.expectedInitiativeVersion,
          reasonCode: value.reasonCode,
          rationale: value.rationale
        }
      : null;
  }
  if (action === "revoke") {
    return typeof value.factId === "string" &&
      isUuid(value.factId) &&
      isPositiveInteger(value.expectedFactVersion) &&
      (value.reasonCode === "no_longer_true" ||
        value.reasonCode === "support_invalidated" ||
        value.reasonCode === "entered_in_error") &&
      validRationale(value.rationale)
      ? {
          factId: value.factId,
          expectedFactVersion: value.expectedFactVersion,
          reasonCode: value.reasonCode,
          rationale: value.rationale
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

function hasRequesterAuthorityHeaders(request: Request): boolean {
  const forbidden = new Set([
    "authorization",
    "cookie",
    "forwarded",
    "idempotency-key",
    "proxy-authorization",
    "role",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-request-id",
    "x-trace-id"
  ]);
  return Array.from(request.headers.keys()).some((name) => {
    const normalized = name.toLowerCase();
    return forbidden.has(normalized) || normalized.startsWith("x-throughline-");
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function validRationale(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2_000 &&
    value.trim() !== "" &&
    value === value.normalize("NFC") &&
    value === value.trim()
  );
}

function isUtf8JsonContentType(value: string): boolean {
  const parts = value.split(";").map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== "application/json") return false;
  if (parts.length === 1) return true;
  return parts.length === 2 && /^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(parts[1]!);
}

async function readUniqueJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await request.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parseUniqueJson(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseUniqueJson(text: string): unknown {
  let offset = 0;
  const skipWhitespace = () => {
    while ([0x09, 0x0a, 0x0d, 0x20].includes(text.charCodeAt(offset))) offset += 1;
  };
  const parseString = (): string => {
    if (text[offset] !== '"') throw new Error("Invalid JSON string");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset]!;
      if (character === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      if (character.charCodeAt(0) < 0x20) throw new Error("Invalid JSON control character");
      if (character === "\\") {
        offset += 1;
        const escape = text[offset];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) throw new Error("Invalid JSON escape");
        if (escape === "u") {
          const scalar = text.slice(offset + 1, offset + 5);
          if (!/^[0-9a-f]{4}$/i.test(scalar)) throw new Error("Invalid JSON Unicode escape");
          offset += 4;
        }
      }
      offset += 1;
    }
    throw new Error("Unterminated JSON string");
  };
  const parseValue = (): unknown => {
    skipWhitespace();
    if (text[offset] === '"') return parseString();
    if (text[offset] === "{") return parseObject();
    if (text[offset] === "[") return parseArray();
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null]
    ] as const) {
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return value;
      }
    }
    const number = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) throw new Error("Invalid JSON value");
    offset += number[0].length;
    const value = Number(number[0]);
    if (!Number.isFinite(value)) throw new Error("Invalid JSON number");
    return value;
  };
  const parseObject = (): Record<string, unknown> => {
    offset += 1;
    skipWhitespace();
    const value = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (text[offset] === "}") {
      offset += 1;
      return value;
    }
    while (true) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw new Error("Duplicate JSON member");
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ":") throw new Error("Invalid JSON object");
      offset += 1;
      value[key] = parseValue();
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return value;
      }
      if (text[offset] !== ",") throw new Error("Invalid JSON object");
      offset += 1;
    }
  };
  const parseArray = (): unknown[] => {
    offset += 1;
    skipWhitespace();
    const value: unknown[] = [];
    if (text[offset] === "]") {
      offset += 1;
      return value;
    }
    while (true) {
      value.push(parseValue());
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return value;
      }
      if (text[offset] !== ",") throw new Error("Invalid JSON array");
      offset += 1;
    }
  };

  const value = parseValue();
  skipWhitespace();
  if (offset !== text.length) throw new Error("Trailing JSON data");
  return value;
}
