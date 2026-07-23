import type { AccessClass } from "./index.js";

export const SOURCE_NORMALIZATION_VERSION = "source-normalization.v1" as const;
export const SOURCE_CHUNKING_VERSION = "source-chunking.v1" as const;
export const SOURCE_CHUNK_MAX_SCALARS = 2_000 as const;

export const ACCESS_CLASS_RANK = Object.freeze({
  public: 0,
  workspace: 1,
  restricted: 2,
  confidential: 3
} as const satisfies Record<AccessClass, number>);

export class UnicodeScalarOffsetError extends Error {
  constructor() {
    super("Unicode scalar offsets are invalid");
    this.name = "UnicodeScalarOffsetError";
  }
}

export function unicodeScalarLength(value: string): number {
  if (!isUnicodeScalarString(value)) throw new UnicodeScalarOffsetError();
  return Array.from(value).length;
}

export function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export class SourceTextPrimitiveError extends Error {
  constructor() {
    super("Source text is invalid or unsupported");
    this.name = "SourceTextPrimitiveError";
  }
}

export function normalizeStoredSourceText(input: string): string {
  if (!isUnicodeScalarString(input) || input.includes("\0")) {
    throw new SourceTextPrimitiveError();
  }
  const withoutBom = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const normalized = withoutBom.replace(/\r\n?/g, "\n").normalize("NFC");
  if (normalized.trim().length === 0) throw new SourceTextPrimitiveError();
  return normalized;
}

export function sliceUnicodeScalarSpan(
  text: string,
  startOffset: number,
  endOffset: number
): string {
  if (!isUnicodeScalarString(text)) throw new UnicodeScalarOffsetError();
  const scalars = Array.from(text);
  if (
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > scalars.length
  ) {
    throw new UnicodeScalarOffsetError();
  }
  return scalars.slice(startOffset, endOffset).join("");
}

export function maxAccessClass(...values: readonly AccessClass[]): AccessClass {
  if (values.length === 0) throw new Error("At least one access class is required");
  values.forEach(assertAccessClass);
  return values.reduce((maximum, current) =>
    ACCESS_CLASS_RANK[current] > ACCESS_CLASS_RANK[maximum] ? current : maximum
  );
}

export function canReadAccessClass(ceiling: AccessClass, resourceClass: AccessClass): boolean {
  assertAccessClass(ceiling);
  assertAccessClass(resourceClass);
  return ACCESS_CLASS_RANK[resourceClass] <= ACCESS_CLASS_RANK[ceiling];
}

function assertAccessClass(value: AccessClass): void {
  if (!Object.hasOwn(ACCESS_CLASS_RANK, value)) {
    throw new Error("Access class is invalid");
  }
}
