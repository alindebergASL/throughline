import type { AccessClass } from "@throughline/core-types";
import { createHash } from "node:crypto";

export const SOURCE_NORMALIZATION_VERSION = "source-normalization.v1" as const;
export const SOURCE_CHUNKING_VERSION = "source-chunking.v1" as const;
export const SOURCE_CHUNK_MAX_SCALARS = 2_000 as const;

export const ACCESS_CLASS_RANK = {
  public: 0,
  workspace: 1,
  restricted: 2,
  confidential: 3
} as const satisfies Record<AccessClass, number>;

export interface NormalizedSourceText {
  capturedText: string;
  normalizedText: string;
  contentHash: string;
  normalizedContentHash: string;
  normalizationVersion: typeof SOURCE_NORMALIZATION_VERSION;
}

export interface DeterministicSourceChunk {
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  normalizedText: string;
  contentHash: string;
  normalizationVersion: typeof SOURCE_NORMALIZATION_VERSION;
  chunkingVersion: typeof SOURCE_CHUNKING_VERSION;
}

export class SourceTextValidationError extends Error {
  constructor(message = "Source text is invalid or unsupported") {
    super(message);
    this.name = "SourceTextValidationError";
  }
}

export function normalizeSourceText(input: string | Uint8Array): NormalizedSourceText {
  if (typeof input === "string" && Buffer.from(input, "utf8").toString("utf8") !== input) {
    throw new SourceTextValidationError();
  }
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  let capturedText: string;
  try {
    capturedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SourceTextValidationError();
  }
  if (capturedText.includes("\0")) throw new SourceTextValidationError();
  const withoutBom = capturedText.startsWith("\uFEFF") ? capturedText.slice(1) : capturedText;
  const normalizedText = withoutBom.replace(/\r\n?/g, "\n").normalize("NFC");
  if (normalizedText.trim().length === 0) throw new SourceTextValidationError();
  return {
    capturedText,
    normalizedText,
    contentHash: sha256(bytes),
    normalizedContentHash: sha256(Buffer.from(normalizedText, "utf8")),
    normalizationVersion: SOURCE_NORMALIZATION_VERSION
  };
}

export function chunkNormalizedSource(normalizedText: string): DeterministicSourceChunk[] {
  if (normalizedText.length === 0 || normalizedText.includes("\0")) {
    throw new SourceTextValidationError();
  }
  const scalars = Array.from(normalizedText);
  const chunks: DeterministicSourceChunk[] = [];
  let startOffset = 0;
  while (startOffset < scalars.length) {
    const maximumEnd = Math.min(startOffset + SOURCE_CHUNK_MAX_SCALARS, scalars.length);
    const endOffset =
      maximumEnd === scalars.length ? maximumEnd : chooseBoundary(scalars, startOffset, maximumEnd);
    if (endOffset <= startOffset) throw new SourceTextValidationError();
    const text = scalars.slice(startOffset, endOffset).join("");
    chunks.push({
      chunkIndex: chunks.length,
      startOffset,
      endOffset,
      normalizedText: text,
      contentHash: sha256(Buffer.from(text, "utf8")),
      normalizationVersion: SOURCE_NORMALIZATION_VERSION,
      chunkingVersion: SOURCE_CHUNKING_VERSION
    });
    startOffset = endOffset;
  }
  assertChunkReconstruction(normalizedText, chunks);
  return chunks;
}

export function normalizeAndChunkSource(input: string | Uint8Array): {
  source: NormalizedSourceText;
  chunks: DeterministicSourceChunk[];
} {
  const source = normalizeSourceText(input);
  return { source, chunks: chunkNormalizedSource(source.normalizedText) };
}

export function sliceByScalarOffsets(text: string, startOffset: number, endOffset: number): string {
  const scalars = Array.from(text);
  if (
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > scalars.length
  ) {
    throw new SourceTextValidationError("Unicode scalar offsets are invalid");
  }
  return scalars.slice(startOffset, endOffset).join("");
}

export function maxAccessClass(...values: readonly AccessClass[]): AccessClass {
  if (values.length === 0) throw new Error("At least one access class is required");
  return values.reduce((maximum, current) =>
    ACCESS_CLASS_RANK[current] > ACCESS_CLASS_RANK[maximum] ? current : maximum
  );
}

export function canReadAccessClass(ceiling: AccessClass, resourceClass: AccessClass): boolean {
  return ACCESS_CLASS_RANK[resourceClass] <= ACCESS_CLASS_RANK[ceiling];
}

export function assertChunkReconstruction(
  normalizedText: string,
  chunks: readonly DeterministicSourceChunk[]
): void {
  let expectedStart = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.chunkIndex !== index ||
      chunk.startOffset !== expectedStart ||
      chunk.endOffset <= chunk.startOffset ||
      sliceByScalarOffsets(normalizedText, chunk.startOffset, chunk.endOffset) !==
        chunk.normalizedText ||
      sha256(Buffer.from(chunk.normalizedText, "utf8")) !== chunk.contentHash
    ) {
      throw new SourceTextValidationError("Source chunk reconstruction failed");
    }
    expectedStart = chunk.endOffset;
  }
  if (expectedStart !== Array.from(normalizedText).length) {
    throw new SourceTextValidationError("Source chunks are not lossless");
  }
  const reconstructed = chunks.map(({ normalizedText: text }) => text).join("");
  if (
    reconstructed !== normalizedText ||
    sha256(Buffer.from(reconstructed, "utf8")) !== sha256(Buffer.from(normalizedText, "utf8"))
  ) {
    throw new SourceTextValidationError("Source chunks are not lossless");
  }
}

function chooseBoundary(scalars: readonly string[], start: number, maximumEnd: number): number {
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
