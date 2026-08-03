export const ASSISTED_OBJECTIVE_RULE_IDS = ["explicit_primary_objective"] as const;

export type AssistedObjectiveRuleId = (typeof ASSISTED_OBJECTIVE_RULE_IDS)[number];
export type AssistedObjectiveAbstentionReason = "unsupported" | "ambiguous" | "conflicting";

export type AssistedObjectiveAdvice =
  | {
      status: "suggested";
      exactExcerpt: string;
      objective: string;
      ruleId: AssistedObjectiveRuleId;
    }
  | { status: "abstained"; reason: AssistedObjectiveAbstentionReason };

export type AssistedObjectiveDraft =
  | {
      mode: "suggested";
      objective: string;
      exactExcerpt: string;
      ruleId: AssistedObjectiveRuleId;
    }
  | {
      mode: "manual";
      objective: string;
      exactExcerpt: string;
      reason: AssistedObjectiveAbstentionReason | "rejected";
    };

const SOURCE_MAX_CODE_UNITS = 100_000;
const SOURCE_CHUNK_MAX_SCALARS = 2_000;
const CANDIDATE_MAX_SCALARS = 320;
const CANDIDATE_LIMIT = 32;

const SUPPORTED_OBJECTIVE_BODY_SCALAR =
  /^(?:[A-Za-z0-9 ,.\-']|[\p{L}\p{M}\p{N}]|\u2019|\p{Extended_Pictographic})$/u;

const LIST_PREFIX = /^(?:[-*•]\s+|\d{1,3}[.)]\s+)/u;
const PRIMARY_OBJECTIVE_CUE =
  /^(?:the\s+primary\s+objective\s+is\s+to\s+|primary\s+objective\s*:\s*to\s+)/iu;
const PRIMARY_OBJECTIVE_CUE_OCCURRENCE = /primary\s+objective/giu;

const UNCERTAIN_OR_DEPENDENT_LANGUAGE =
  /\b(?:tbd|unclear|uncertain|unresolved|unknown|tentative|provisional|possibly|possible|potential(?:ly)?|plausibl(?:e|y)|conceivabl(?:e|y)|probably|likely|unlikely|apparently|perhaps|maybe|may|might|could|considering|reportedly|allegedly|presum(?:e|es|ed|ing|ably)|ostensibl(?:e|y)|expect(?:s|ed|ing|edly)?|contingent|conditional(?:ly)?|conditioned|dependent|provided|assuming|awaiting|upon|once|when|whenever|pending|unless|until|if|after|before)\b/iu;
const CONDITIONAL_PHRASE =
  /\b(?:subject\s+to|on\s+the\s+condition\s+that|on\s+condition\s+that|provided\s+that|dependent\s+(?:up)?on|contingent\s+(?:up)?on|conditional\s+(?:up)?on)\b/iu;
const APPROVAL_FAMILY_LANGUAGE =
  /\b(?:approv(?:al|als|e|es|ed|ing)|authoriz(?:ation|ations|e|es|ed|ing))\b/iu;

export function advisePrimaryObjective(normalizedSource: string): AssistedObjectiveAdvice {
  if (
    typeof normalizedSource !== "string" ||
    normalizedSource.length === 0 ||
    normalizedSource.length > SOURCE_MAX_CODE_UNITS ||
    hasUnicodeLineOrParagraphSeparator(normalizedSource) ||
    hasUnsupportedControl(normalizedSource)
  ) {
    return { status: "abstained", reason: "unsupported" };
  }

  const exactExcerpt = normalizedSource.trim();
  if (exactExcerpt === "") {
    return { status: "abstained", reason: "unsupported" };
  }
  if (/[\r\n]/u.test(exactExcerpt)) return { status: "abstained", reason: "conflicting" };

  const supportedLine = exactExcerpt.replace(LIST_PREFIX, "");
  const cueCount = Array.from(supportedLine.matchAll(PRIMARY_OBJECTIVE_CUE_OCCURRENCE)).length;
  if (cueCount === 0) return { status: "abstained", reason: "unsupported" };
  if (cueCount > CANDIDATE_LIMIT) return { status: "abstained", reason: "ambiguous" };
  if (cueCount !== 1) return { status: "abstained", reason: "unsupported" };

  const cue = PRIMARY_OBJECTIVE_CUE.exec(supportedLine);
  if (!cue) return { status: "abstained", reason: "unsupported" };

  const objective = normalizeObjective(supportedLine.slice(cue[0].length));
  if (!objective || !isSafeSupportedLine(supportedLine, objective)) {
    return { status: "abstained", reason: "unsupported" };
  }

  if (countOccurrences(normalizedSource, exactExcerpt, 2) !== 1) {
    return { status: "abstained", reason: "ambiguous" };
  }
  if (!isExcerptWithinCanonicalChunk(normalizedSource, exactExcerpt)) {
    return { status: "abstained", reason: "unsupported" };
  }

  return {
    status: "suggested",
    exactExcerpt,
    objective,
    ruleId: "explicit_primary_objective"
  };
}

export function createAssistedObjectiveDraft(normalizedSource: string): AssistedObjectiveDraft {
  const advice = advisePrimaryObjective(normalizedSource);
  return advice.status === "suggested"
    ? {
        mode: "suggested",
        objective: advice.objective,
        exactExcerpt: advice.exactExcerpt,
        ruleId: advice.ruleId
      }
    : { mode: "manual", objective: "", exactExcerpt: "", reason: advice.reason };
}

export function rejectAssistedObjective(): AssistedObjectiveDraft {
  return { mode: "manual", objective: "", exactExcerpt: "", reason: "rejected" };
}

function normalizeObjective(remainder: string): string | null {
  if (remainder === "" || remainder !== remainder.trim()) return null;

  const withoutTerminalPeriod = remainder.endsWith(".") ? remainder.slice(0, -1) : remainder;
  if (withoutTerminalPeriod === "" || withoutTerminalPeriod !== withoutTerminalPeriod.trim()) {
    return null;
  }

  const scalars = Array.from(withoutTerminalPeriod);
  const capitalized = scalars[0]!.toLocaleUpperCase("en");
  if (Array.from(capitalized).length === 1) scalars[0] = capitalized;
  return `${scalars.join("")}.`;
}

function isSafeSupportedLine(supportedLine: string, objective: string): boolean {
  const scalarLength = Array.from(objective).length;
  const words = objective.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? [];
  const body = objective.slice(0, -1);
  const safetyBody = createSafetyView(body);

  if (
    scalarLength < 15 ||
    scalarLength > CANDIDATE_MAX_SCALARS ||
    words.length < 3 ||
    hasUnsupportedControl(supportedLine) ||
    hasUnsupportedSentenceTerminal(body) ||
    !hasOnlySupportedObjectiveBodyScalars(body) ||
    hasUnsafeLetterStructure(body) ||
    /\s-\s/u.test(body) ||
    UNCERTAIN_OR_DEPENDENT_LANGUAGE.test(safetyBody) ||
    CONDITIONAL_PHRASE.test(safetyBody) ||
    APPROVAL_FAMILY_LANGUAGE.test(safetyBody) ||
    /\bsign[- ]?off\b/iu.test(safetyBody)
  ) {
    return false;
  }

  const lower = safetyBody.toLocaleLowerCase("en");
  return !(
    /\b(?:not agreed|not decided|under discussion|under review|(?:to\s+)?be determined|(?:to\s+)?be confirmed|no longer (?:correct|current|valid)|wrong|outdated|superseded|contested|disputed|rejected)\b/u.test(
      lower
    ) ||
    /\b(?:not|never)\b|\bno\b/u.test(lower) ||
    /\b(?:either|or|and\/or|versus|vs)\b/u.test(lower) ||
    /\bignore\b.{0,80}\b(?:instruction|policy|rule)s?\b/u.test(lower) ||
    /\b(?:system override|previous instructions?|stored credentials?|call tools?|tool loop)\b/u.test(
      lower
    ) ||
    /\b(?:upload|exfiltrate)\b/u.test(lower)
  );
}

function createSafetyView(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "");
}

function hasUnsafeLetterStructure(body: string): boolean {
  if (/[\p{Variation_Selector}\p{Lm}]/u.test(body)) return true;

  const letterTokens = body.match(/[\p{L}\p{M}]+/gu) ?? [];
  return letterTokens.some((token) => {
    let hasAsciiBaseLetter = false;
    let hasNonAsciiBaseLetter = false;

    for (const scalar of token) {
      if (/^[A-Za-z]$/u.test(scalar)) {
        hasAsciiBaseLetter = true;
      } else if (/^\p{L}$/u.test(scalar)) {
        hasNonAsciiBaseLetter = true;
      }
      if (hasAsciiBaseLetter && hasNonAsciiBaseLetter) return true;
    }
    return false;
  });
}

function hasOnlySupportedObjectiveBodyScalars(body: string): boolean {
  for (const scalar of body) {
    if (!SUPPORTED_OBJECTIVE_BODY_SCALAR.test(scalar)) return false;
  }
  return true;
}

function hasUnsupportedSentenceTerminal(body: string): boolean {
  const scalars = Array.from(body);

  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index]!;
    if (!/^\p{Sentence_Terminal}$/u.test(scalar)) continue;
    if (scalar !== "." || !isDottedInitialismPeriod(scalars, index)) return true;
  }
  return false;
}

function isDottedInitialismPeriod(scalars: readonly string[], index: number): boolean {
  const isLetter = (scalar: string | undefined): boolean =>
    scalar !== undefined && /^\p{L}$/u.test(scalar);

  const beginsNextComponent =
    isLetter(scalars[index - 1]) &&
    isLetter(scalars[index + 1]) &&
    scalars[index + 2] === "." &&
    !isLetter(scalars[index - 2]);
  const endsComponentAfterPriorPeriod =
    isLetter(scalars[index - 1]) &&
    scalars[index - 2] === "." &&
    isLetter(scalars[index - 3]) &&
    (scalars[index + 1] === "," ||
      (scalars[index + 1] === " " && /^\p{Ll}$/u.test(scalars[index + 2] ?? "")));

  return beginsNextComponent || endsComponentAfterPriorPeriod;
}

function hasUnicodeLineOrParagraphSeparator(value: string): boolean {
  return /[\p{Zl}\p{Zp}]/u.test(value);
}

function hasUnsupportedControl(value: string): boolean {
  for (const character of value) {
    if (character !== "\n" && /[\p{Cc}\p{Cf}]/u.test(character)) return true;
  }
  return false;
}

function isExcerptWithinCanonicalChunk(source: string, excerpt: string): boolean {
  const codeUnitStart = source.indexOf(excerpt);
  if (codeUnitStart < 0) return false;
  const scalars = Array.from(source);
  const excerptStart = Array.from(source.slice(0, codeUnitStart)).length;
  const excerptEnd = excerptStart + Array.from(excerpt).length;
  let chunkStart = 0;

  while (chunkStart < scalars.length) {
    const maximumEnd = Math.min(chunkStart + SOURCE_CHUNK_MAX_SCALARS, scalars.length);
    const chunkEnd =
      maximumEnd === scalars.length
        ? maximumEnd
        : chooseCanonicalChunkBoundary(scalars, chunkStart, maximumEnd);
    if (excerptStart >= chunkStart && excerptEnd <= chunkEnd) return true;
    if (excerptStart < chunkEnd && excerptEnd > chunkEnd) return false;
    chunkStart = chunkEnd;
  }
  return false;
}

function chooseCanonicalChunkBoundary(
  scalars: readonly string[],
  start: number,
  maximumEnd: number
): number {
  for (let index = maximumEnd - 1; index > start; index -= 1) {
    if (scalars[index - 1] === "\n" && scalars[index] === "\n") return index + 1;
  }
  for (let index = maximumEnd - 1; index >= start; index -= 1) {
    if (scalars[index] === "\n") return index + 1;
  }
  for (let index = maximumEnd - 1; index >= start; index -= 1) {
    if (/^\s$/u.test(scalars[index]!)) return index + 1;
  }
  return maximumEnd;
}

function countOccurrences(source: string, excerpt: string, stopAt: number): number {
  let count = 0;
  let start = 0;
  while (start <= source.length - excerpt.length && count < stopAt) {
    const index = source.indexOf(excerpt, start);
    if (index === -1) break;
    count += 1;
    start = index + 1;
  }
  return count;
}
