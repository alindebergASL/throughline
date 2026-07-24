import { isDomainNotificationTimestamp, unicodeScalarLength } from "@throughline/core-types";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export class TruthContractValidationError extends Error {
  constructor(message = "Truth Ledger contract is invalid") {
    super(message);
    this.name = "TruthContractValidationError";
  }
}

export function failContract(): never {
  throw new TruthContractValidationError();
}

export function exactObject(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (!isPlainRecord(input)) return failContract();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key !== "string")) return failContract();
  const keys = ownKeys as string[];
  if (requiredKeys.some((key) => !Object.hasOwn(input, key))) return failContract();
  if (keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) {
    return failContract();
  }
  return input;
}

export function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function requireString(input: unknown): string {
  if (typeof input !== "string") return failContract();
  return input;
}

export function requireUuidV7(input: unknown): string {
  if (typeof input !== "string" || !UUID_V7_PATTERN.test(input)) return failContract();
  return input;
}

export function requireSha256(input: unknown): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) return failContract();
  return input;
}

export function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) return failContract();
  return input as number;
}

export function requireNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) return failContract();
  return input as number;
}

export function requireLiteral<const T extends string | number | boolean | null>(
  input: unknown,
  literal: T
): T {
  if (input !== literal) return failContract();
  return literal;
}

export function requireEnum<const T extends readonly string[]>(
  input: unknown,
  values: T
): T[number] {
  if (typeof input !== "string" || !values.includes(input)) return failContract();
  return input as T[number];
}

export function requireTimestamp(input: unknown): string {
  if (!isDomainNotificationTimestamp(input)) return failContract();
  return input;
}

export function requireSafeReference(input: unknown): string {
  if (typeof input !== "string" || !SAFE_REFERENCE_PATTERN.test(input)) return failContract();
  return input;
}

export function requireCanonicalRationale(input: unknown): string {
  if (typeof input !== "string" || input !== input.normalize("NFC") || input.trim() !== input) {
    return failContract();
  }
  const scalars = Array.from(input);
  if (
    unicodeScalarLength(input) < 1 ||
    unicodeScalarLength(input) > 2_000 ||
    scalars.some((character) => {
      const codePoint = character.codePointAt(0)!;
      return (codePoint < 32 && codePoint !== 9 && codePoint !== 10) || codePoint === 127;
    })
  ) {
    return failContract();
  }
  return input;
}

export function requireIdempotencyKey(input: unknown): string {
  if (
    typeof input !== "string" ||
    unicodeScalarLength(input) < 1 ||
    unicodeScalarLength(input) > 200
  ) {
    return failContract();
  }
  if (
    Array.from(input).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    return failContract();
  }
  return input;
}
