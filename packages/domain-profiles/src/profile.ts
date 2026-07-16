import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const CORE_PROFILE_CONTRACT_VERSION = "0.1.0" as const;
export const AI_SOLUTIONS_PROFILE_ID = "ai-solutions" as const;
export const AI_SOLUTIONS_PROFILE_VERSION = "1.0.0" as const;
export const AI_SOLUTIONS_PROFILE_SHA256 =
  "9073332e78a265a6e79707a986a322eb38e7982b480b4ee0801991dc8564b828" as const;

const key = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const label = z.string().trim().min(1).max(200);
const signalKeys = [
  "business_problem_validated",
  "customer_owner_identified",
  "workshop_objective_confirmed",
  "attendees_identified",
  "assessment_scope_confirmed",
  "use_case_validated",
  "proposed_approach_presented",
  "customer_validation_recorded",
  "next_commitment_confirmed"
] as const;
const readinessFields = [
  "readiness.executive_sponsorship",
  "readiness.governance_process",
  "readiness.ai_inventory",
  "readiness.risk_classification",
  "readiness.data_readiness",
  "readiness.security_validation",
  "readiness.human_oversight",
  "readiness.monitoring"
] as const;
const conditionFields = [...readinessFields, "initiative.stage"] as const;

const eqConditionSchema = z
  .object({
    op: z.literal("eq"),
    field: z.enum(conditionFields),
    value: z.union([z.string().min(1), z.number().finite(), z.boolean()])
  })
  .strict();
const inConditionSchema = z
  .object({
    op: z.literal("in"),
    field: z.enum(conditionFields),
    values: z.array(z.union([z.string().min(1), z.number().finite(), z.boolean()])).min(1)
  })
  .strict();

const enumDimensionSchema = z
  .object({
    key,
    label,
    valueType: z.literal("enum"),
    options: z.array(key).min(1)
  })
  .strict();
const scoreDimensionSchema = z
  .object({
    key,
    label,
    valueType: z.literal("score"),
    min: z.number().finite(),
    max: z.number().finite()
  })
  .strict()
  .refine((value) => value.min < value.max, { message: "score min must be less than max" });

export const aiSolutionsProfileSchema = z
  .object({
    id: z.literal(AI_SOLUTIONS_PROFILE_ID),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: z.literal("published"),
    minCoreVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    displayName: label,
    labels: z
      .object({
        organization: label,
        initiative: label,
        activity: label,
        readiness: label,
        useCase: label,
        pulse: label
      })
      .strict(),
    initiativeTypes: z.array(z.object({ key, label }).strict()).min(1),
    stagePipeline: z
      .array(z.object({ key, label, order: z.number().int().positive() }).strict())
      .min(1),
    evidenceRules: z
      .array(
        z
          .object({
            stageKey: key,
            requiredSignals: z.array(z.enum(signalKeys)).min(1)
          })
          .strict()
      )
      .min(1),
    readinessDimensions: z
      .array(z.discriminatedUnion("valueType", [enumDimensionSchema, scoreDimensionSchema]))
      .min(1),
    activityTemplates: z
      .array(
        z
          .object({ key, label, defaultObjectives: z.array(z.string().trim().min(1)).min(1) })
          .strict()
      )
      .min(1),
    playbookSeeds: z
      .array(
        z
          .object({
            key,
            condition: z.discriminatedUnion("op", [eqConditionSchema, inConditionSchema]),
            recommend: z.string().trim().min(1).max(500)
          })
          .strict()
      )
      .min(1),
    frameworks: z.array(z.string().trim().min(1)).min(1)
  })
  .strict()
  .superRefine((profile, context) => {
    requireUnique(profile.initiativeTypes, "initiative type", context);
    requireUnique(profile.stagePipeline, "stage", context);
    requireUnique(profile.readinessDimensions, "readiness dimension", context);
    requireUnique(profile.activityTemplates, "activity template", context);
    requireUnique(profile.playbookSeeds, "playbook", context);
    requireUniqueStrings(
      profile.evidenceRules.map(({ stageKey }) => stageKey),
      "evidence rule stage",
      context
    );
    for (const rule of profile.evidenceRules) {
      requireUniqueStrings(rule.requiredSignals, "evidence signal", context);
    }
    for (const dimension of profile.readinessDimensions) {
      if (dimension.valueType === "enum") {
        requireUniqueStrings(dimension.options, "readiness option", context);
      }
    }
    requireUniqueStrings(profile.frameworks, "framework", context);
    const orders = profile.stagePipeline.map(({ order }) => order);
    if (orders.some((order, index) => index > 0 && order <= orders[index - 1]!)) {
      context.addIssue({ code: "custom", message: "stage order must be strictly increasing" });
    }
    const stages = new Set(profile.stagePipeline.map(({ key: stageKey }) => stageKey));
    for (const rule of profile.evidenceRules) {
      if (!stages.has(rule.stageKey)) {
        context.addIssue({ code: "custom", message: "evidence rule references unknown stage" });
      }
    }
    const readiness = new Map(
      profile.readinessDimensions.map((dimension) => [`readiness.${dimension.key}`, dimension])
    );
    for (const playbook of profile.playbookSeeds) {
      if (playbook.condition.field === "initiative.stage") {
        const values = conditionValues(playbook.condition);
        if (values.some((value) => typeof value !== "string" || !stages.has(value))) {
          context.addIssue({ code: "custom", message: "playbook references unknown stage value" });
        }
        continue;
      }
      const dimension = readiness.get(playbook.condition.field);
      const values = conditionValues(playbook.condition);
      if (!dimension || !conditionValuesMatchDimension(values, dimension)) {
        context.addIssue({
          code: "custom",
          message: "playbook value does not match profile field"
        });
      }
    }
    if (compareSemver(profile.minCoreVersion, CORE_PROFILE_CONTRACT_VERSION) > 0) {
      context.addIssue({
        code: "custom",
        message: "profile requires an incompatible Core version"
      });
    }
  });

export type AiSolutionsProfile = z.infer<typeof aiSolutionsProfileSchema>;

export class DomainProfileRegistry {
  private readonly profiles = new Map<string, AiSolutionsProfile>();

  register(profileInput: unknown): AiSolutionsProfile {
    const profile = aiSolutionsProfileSchema.parse(profileInput);
    const registryKey = `${profile.id}@${profile.version}`;
    if (this.profiles.has(registryKey))
      throw new Error("Domain profile tuple is already registered");
    this.profiles.set(registryKey, profile);
    return profile;
  }

  resolve(profileId: string, profileVersion: string): AiSolutionsProfile {
    const profile = this.profiles.get(`${profileId}@${profileVersion}`);
    if (!profile) throw new Error("Workspace profile pin is unavailable or incompatible");
    return profile;
  }
}

export function loadAiSolutionsProfile(
  profilePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../profiles/ai-solutions.v1.json"
  )
): AiSolutionsProfile {
  const bytes = readFileSync(profilePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== AI_SOLUTIONS_PROFILE_SHA256) {
    throw new Error("Published AI Solutions profile does not match its build manifest");
  }
  return aiSolutionsProfileSchema.parse(JSON.parse(bytes.toString("utf8")));
}

export function createDefaultProfileRegistry(): DomainProfileRegistry {
  const registry = new DomainProfileRegistry();
  registry.register(loadAiSolutionsProfile());
  return registry;
}

function requireUnique(
  values: readonly { key: string }[],
  labelName: string,
  context: z.RefinementCtx
): void {
  const keys = values.map(({ key: itemKey }) => itemKey);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: `${labelName} keys must be unique` });
  }
}

function requireUniqueStrings(
  values: readonly string[],
  labelName: string,
  context: z.RefinementCtx
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `${labelName} values must be unique` });
  }
}

function conditionValues(condition: z.infer<typeof eqConditionSchema | typeof inConditionSchema>) {
  return condition.op === "eq" ? [condition.value] : condition.values;
}

function conditionValuesMatchDimension(
  values: readonly (string | number | boolean)[],
  dimension: z.infer<typeof enumDimensionSchema | typeof scoreDimensionSchema>
): boolean {
  if (dimension.valueType === "score") {
    return values.every(
      (value) => typeof value === "number" && value >= dimension.min && value <= dimension.max
    );
  }
  return values.every((value) => typeof value === "string" && dimension.options.includes(value));
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
