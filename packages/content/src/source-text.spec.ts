import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  SOURCE_CHUNK_MAX_SCALARS,
  canReadAccessClass,
  chunkNormalizedSource,
  maxAccessClass,
  normalizeAndChunkSource,
  normalizeSourceText,
  sliceByScalarOffsets
} from "./source-text.js";

describe("source-normalization.v1", () => {
  it("normalizes one BOM, newlines, and Unicode NFC while preserving other whitespace", () => {
    const result = normalizeSourceText("\uFEFF  Cafe\u0301\r\nline\r\n\tend  ");
    expect(result.normalizedText).toBe("  Café\nline\n\tend  ");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.normalizedContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.contentHash).not.toBe(result.normalizedContentHash);
  });

  it("rejects invalid UTF-8, NUL, and empty/whitespace-only input", () => {
    expect(() => normalizeSourceText(Uint8Array.from([0xc3, 0x28]))).toThrow();
    expect(() => normalizeSourceText("a\0b")).toThrow();
    expect(() => normalizeSourceText(" \r\n\t ")).toThrow();
    expect(() => normalizeSourceText("unpaired-\ud800-surrogate")).toThrow();
  });
});

describe("source-chunking.v1", () => {
  it("uses paragraph, line, whitespace, then hard scalar boundaries losslessly", () => {
    const paragraph = `${"a".repeat(1_500)}\n\n${"b".repeat(700)}`;
    expect(chunkNormalizedSource(paragraph)[0]?.normalizedText.endsWith("\n\n")).toBe(true);
    const line = `${"a".repeat(1_500)}\n${"b".repeat(700)}`;
    expect(chunkNormalizedSource(line)[0]?.normalizedText.endsWith("\n")).toBe(true);
    const whitespace = `${"a".repeat(1_500)} ${"b".repeat(700)}`;
    expect(chunkNormalizedSource(whitespace)[0]?.normalizedText.endsWith(" ")).toBe(true);
    const hard = "x".repeat(SOURCE_CHUNK_MAX_SCALARS + 3);
    expect(chunkNormalizedSource(hard).map(({ endOffset }) => endOffset)).toEqual([2_000, 2_003]);
  });

  it("indexes emoji by Unicode scalar rather than UTF-16 code units", () => {
    const text = `A😀e\u0301Z`;
    const { source, chunks } = normalizeAndChunkSource(text);
    expect(source.normalizedText).toBe("A😀éZ");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startOffset: 0, endOffset: 4 });
    expect(sliceByScalarOffsets(source.normalizedText, 1, 3)).toBe("😀é");
  });

  it("is deterministic across retries", () => {
    const first = normalizeAndChunkSource(`${"alpha ".repeat(800)}omega`);
    const second = normalizeAndChunkSource(`${"alpha ".repeat(800)}omega`);
    expect(second).toEqual(first);
    expect(first.chunks.map(({ normalizedText }) => normalizedText).join("")).toBe(
      first.source.normalizedText
    );
  });

  it("captures the adversarial transcript fixture only as opaque untrusted text", async () => {
    const transcript = await readFile(
      new URL("../../../tests/fixtures/transcripts/adversarial_injection.txt", import.meta.url),
      "utf8"
    );
    const result = normalizeAndChunkSource(transcript);
    expect(result.source.capturedText).toBe(transcript);
    expect(result.chunks.map(({ normalizedText }) => normalizedText).join("")).toBe(
      result.source.normalizedText
    );
    expect(result.source.normalizedText).toContain("Ignore all previous security policies");
  });
});

describe("ADR-018 access lattice", () => {
  it("orders all four classes and never downgrades", () => {
    expect(maxAccessClass("public", "workspace")).toBe("workspace");
    expect(maxAccessClass("restricted", "workspace", "confidential")).toBe("confidential");
    expect(canReadAccessClass("workspace", "restricted")).toBe(false);
    expect(canReadAccessClass("restricted", "restricted")).toBe(true);
    expect(canReadAccessClass("confidential", "public")).toBe(true);
    for (const [ceiling, expected] of [
      ["public", [true, false, false, false]],
      ["workspace", [true, true, false, false]],
      ["restricted", [true, true, true, false]],
      ["confidential", [true, true, true, true]]
    ] as const) {
      expect(
        (["public", "workspace", "restricted", "confidential"] as const).map((resource) =>
          canReadAccessClass(ceiling, resource)
        )
      ).toEqual(expected);
    }
  });
});
