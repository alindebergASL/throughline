import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_SOLUTIONS_PROFILE_VERSION,
  DomainProfileRegistry,
  aiSolutionsProfileSchema,
  loadAiSolutionsProfile
} from "./profile.js";

const profilePath = resolve(import.meta.dirname, "../../../profiles/ai-solutions.v1.json");
const canonical = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;

describe("AI Solutions profile", () => {
  it("loads the exact published file and validates all references", () => {
    const profile = loadAiSolutionsProfile(profilePath);
    expect(profile.id).toBe("ai-solutions");
    expect(profile.version).toBe(AI_SOLUTIONS_PROFILE_VERSION);
    expect(profile.activityTemplates.map(({ key }) => key)).toContain("ai_workshop");
  });

  it("rejects unknown keys, executable conditions, duplicates, and reference drift", () => {
    expect(() => aiSolutionsProfileSchema.parse({ ...canonical, authorization: {} })).toThrow();
    expect(() =>
      aiSolutionsProfileSchema.parse({
        ...canonical,
        playbookSeeds: [
          { key: "bad", condition: { op: "eval", expression: "true" }, recommend: "x" }
        ]
      })
    ).toThrow();
    expect(() =>
      aiSolutionsProfileSchema.parse({
        ...canonical,
        initiativeTypes: [
          ...(canonical.initiativeTypes as unknown[]),
          (canonical.initiativeTypes as unknown[])[0]
        ]
      })
    ).toThrow();
    expect(() =>
      aiSolutionsProfileSchema.parse({
        ...canonical,
        evidenceRules: [{ stageKey: "not_a_stage", requiredSignals: ["use_case_validated"] }]
      })
    ).toThrow();
    const readiness = canonical.readinessDimensions as Array<Record<string, unknown>>;
    expect(() =>
      aiSolutionsProfileSchema.parse({
        ...canonical,
        readinessDimensions: [{ ...readiness[0], options: ["none", "none"] }, ...readiness.slice(1)]
      })
    ).toThrow();
  });

  it("fails closed for incompatible, unpublished, unknown, and latest pins", () => {
    expect(() => aiSolutionsProfileSchema.parse({ ...canonical, status: "draft" })).toThrow();
    expect(() =>
      aiSolutionsProfileSchema.parse({ ...canonical, minCoreVersion: "9.0.0" })
    ).toThrow();
    const registry = new DomainProfileRegistry();
    registry.register(canonical);
    expect(() => registry.resolve("ai-solutions", "latest")).toThrow();
    expect(() => registry.resolve("unknown", "1.0.0")).toThrow();
  });
});
