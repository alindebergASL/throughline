import {
  SOURCE_CHUNKING_VERSION,
  SOURCE_CHUNK_MAX_SCALARS,
  SOURCE_NORMALIZATION_VERSION,
  normalizeStoredSourceText,
  sliceUnicodeScalarSpan
} from "@throughline/core-types";
import { createHash } from "node:crypto";

export {
  ACCESS_CLASS_RANK,
  SOURCE_CHUNKING_VERSION,
  SOURCE_CHUNK_MAX_SCALARS,
  SOURCE_NORMALIZATION_VERSION,
  canReadAccessClass,
  maxAccessClass
} from "@throughline/core-types";

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
  let normalizedText: string;
  try {
    normalizedText = normalizeStoredSourceText(capturedText);
  } catch {
    throw new SourceTextValidationError();
  }
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
  try {
    return sliceUnicodeScalarSpan(text, startOffset, endOffset);
  } catch {
    throw new SourceTextValidationError("Unicode scalar offsets are invalid");
  }
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
