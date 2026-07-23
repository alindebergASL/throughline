import { describe, expect, it } from "vitest";
import {
  ACCESS_CLASS_RANK,
  isUnicodeScalarString,
  maxAccessClass,
  normalizeStoredSourceText,
  sliceUnicodeScalarSpan,
  unicodeScalarLength,
  type AccessClass
} from "./index.js";

describe("shared trust primitives", () => {
  it("uses the one ADR-018 lattice for every pair", () => {
    expect(ACCESS_CLASS_RANK).toEqual({
      public: 0,
      workspace: 1,
      restricted: 2,
      confidential: 3
    });
    const classes = Object.keys(ACCESS_CLASS_RANK) as AccessClass[];
    for (const left of classes) {
      for (const right of classes) {
        const expected = ACCESS_CLASS_RANK[left] >= ACCESS_CLASS_RANK[right] ? left : right;
        expect(maxAccessClass(left, right)).toBe(expected);
        expect(maxAccessClass(right, left)).toBe(expected);
      }
    }
    expect(Object.isFrozen(ACCESS_CLASS_RANK)).toBe(true);
    expect(() => maxAccessClass()).toThrow();
    expect(() => maxAccessClass("public", "bogus" as AccessClass)).toThrow();
  });

  it("counts and slices Unicode scalar values, not UTF-16 code units", () => {
    expect(unicodeScalarLength("A😀éZ")).toBe(4);
    expect(sliceUnicodeScalarSpan("A😀éZ", 1, 3)).toBe("😀é");
    expect(() => sliceUnicodeScalarSpan("A😀éZ", 1, 5)).toThrow();
    expect(() => sliceUnicodeScalarSpan("A😀éZ", 2, 2)).toThrow();
    expect(() => sliceUnicodeScalarSpan("A\ud800Z", 0, 1)).toThrow();
    expect(isUnicodeScalarString("A😀éZ")).toBe(true);
    expect(isUnicodeScalarString("A\ud800Z")).toBe(false);
  });

  it("shares the exact B1 stored-text normalization primitive", () => {
    expect(normalizeStoredSourceText("\uFEFFCafe\u0301\r\nnext\rline")).toBe("Café\nnext\nline");
    expect(() => normalizeStoredSourceText(" \r\n ")).toThrow();
    expect(() => normalizeStoredSourceText("bad\0text")).toThrow();
    expect(() => normalizeStoredSourceText("bad\ud800text")).toThrow();
  });
});
