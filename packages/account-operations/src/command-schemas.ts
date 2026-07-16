import type {
  B1AuthorizedDomainCommand,
  B1CommandKind,
  B1CommandPayloadMap,
  B1CommandResultMap
} from "@throughline/core-types";
import { z } from "zod";

const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 31 && codePoint !== 127;
    })
  );
const timestamp = z.string().datetime({ offset: true });
const title = z.string().trim().min(1).max(500);
const accessClass = z.enum(["public", "workspace", "restricted", "confidential"]);
const endpoint = z
  .object({
    type: z.enum(["space", "person", "organization", "initiative", "activity", "content"]),
    id: uuid
  })
  .strict();
const metadata = z.record(z.string(), z.unknown());

const schemas = {
  "organization.create": z
    .object({
      kind: z.literal("organization.create"),
      idempotencyKey,
      payload: z
        .object({ name: title, domains: z.array(z.string().min(1).max(253)).max(100) })
        .strict()
    })
    .strict(),
  "initiative.create": z
    .object({
      kind: z.literal("initiative.create"),
      idempotencyKey,
      payload: z
        .object({
          primaryOrganizationId: uuid,
          organizationIds: z.array(uuid).max(100).optional(),
          contributorPersonIds: z.array(uuid).max(100).optional(),
          title,
          typeKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
          stageKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
          health: z.enum(["active", "stalled", "paused", "blocked", "closed"]).optional(),
          ownerPersonId: uuid.optional()
        })
        .strict()
    })
    .strict(),
  "activity.create": z
    .object({
      kind: z.literal("activity.create"),
      idempotencyKey,
      payload: z
        .object({
          title,
          profileTemplateKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
          status: z
            .enum([
              "planned",
              "in_progress",
              "captured",
              "review_pending",
              "completed",
              "cancelled"
            ])
            .optional(),
          occurredAt: timestamp.optional(),
          startsAt: timestamp.optional(),
          endsAt: timestamp.optional(),
          ownerPersonId: uuid.optional(),
          governingInitiativeId: uuid.optional(),
          governingOrganizationId: uuid.optional(),
          organizationIds: z.array(uuid).max(100),
          initiativeIds: z.array(uuid).max(100),
          attendeePersonIds: z.array(uuid).max(200).optional()
        })
        .strict()
    })
    .strict(),
  "relationship.create": z
    .object({
      kind: z.literal("relationship.create"),
      idempotencyKey,
      payload: z
        .object({
          subject: endpoint,
          predicate: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/),
          object: endpoint,
          context: endpoint.optional(),
          validFrom: timestamp.optional()
        })
        .strict()
    })
    .strict(),
  "relationship.end": z
    .object({
      kind: z.literal("relationship.end"),
      idempotencyKey,
      payload: z
        .object({
          relationshipId: uuid,
          expectedVersion: z.number().int().positive(),
          validTo: timestamp
        })
        .strict()
    })
    .strict(),
  "content.create": z
    .object({
      kind: z.literal("content.create"),
      idempotencyKey,
      payload: z
        .object({
          spaceId: uuid,
          type: z.enum(["page", "note"]),
          title,
          body: z.string().max(2_000_000),
          ownerPersonId: uuid.optional(),
          metadata: metadata.optional()
        })
        .strict()
    })
    .strict(),
  "content.revise": z
    .object({
      kind: z.literal("content.revise"),
      idempotencyKey,
      payload: z
        .object({
          contentItemId: uuid,
          expectedRevision: z.number().int().positive(),
          title: title.optional(),
          body: z.string().max(2_000_000),
          metadata: metadata.optional()
        })
        .strict()
    })
    .strict(),
  "source.capture": z
    .object({
      kind: z.literal("source.capture"),
      idempotencyKey,
      payload: z
        .object({
          activityId: uuid,
          sourceType: z.enum(["note", "transcript", "human"]),
          title: title.optional(),
          text: z.string().max(2_000_000),
          requestedAccessClass: accessClass.optional(),
          originContentItemId: uuid.optional(),
          originContentRevision: z.number().int().positive().optional(),
          occurredAt: timestamp.optional()
        })
        .strict()
        .refine(
          (value) =>
            (value.originContentItemId === undefined) ===
            (value.originContentRevision === undefined),
          "content origin requires item and revision"
        )
    })
    .strict(),
  "source.correct": z
    .object({
      kind: z.literal("source.correct"),
      idempotencyKey,
      payload: z
        .object({
          predecessorSourceArtifactId: uuid,
          activityId: uuid.optional(),
          sourceType: z.enum(["note", "transcript", "human"]),
          title: title.optional(),
          text: z.string().max(2_000_000),
          requestedAccessClass: accessClass.optional(),
          occurredAt: timestamp.optional()
        })
        .strict()
    })
    .strict(),
  "source.tombstone": z
    .object({
      kind: z.literal("source.tombstone"),
      idempotencyKey,
      payload: z
        .object({
          sourceArtifactId: uuid,
          expectedVersion: z.number().int().positive(),
          deletionReasonCategory: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
          deletionPolicyRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
        })
        .strict()
    })
    .strict()
} as const;

const resultSchemas = {
  "organization.create": z
    .object({ organizationId: uuid, spaceId: uuid, version: z.literal(1) })
    .strict(),
  "initiative.create": z
    .object({ initiativeId: uuid, spaceId: uuid, version: z.literal(1) })
    .strict(),
  "activity.create": z.object({ activityId: uuid, spaceId: uuid, version: z.literal(1) }).strict(),
  "relationship.create": z
    .object({ relationshipId: uuid, spaceId: uuid, version: z.literal(1) })
    .strict(),
  "relationship.end": z
    .object({ relationshipId: uuid, version: z.number().int().positive(), validTo: timestamp })
    .strict(),
  "content.create": z
    .object({ contentItemId: uuid, revisionNumber: z.literal(1), version: z.literal(1) })
    .strict(),
  "content.revise": z
    .object({
      contentItemId: uuid,
      revisionNumber: z.number().int().positive(),
      version: z.number().int().positive()
    })
    .strict(),
  "source.capture": z
    .object({
      sourceArtifactId: uuid,
      activityId: uuid,
      chunkCount: z.number().int().positive(),
      version: z.literal(1)
    })
    .strict(),
  "source.correct": z
    .object({
      sourceArtifactId: uuid,
      previousSourceArtifactId: uuid,
      chunkCount: z.number().int().positive(),
      version: z.literal(1)
    })
    .strict(),
  "source.tombstone": z
    .object({
      sourceArtifactId: uuid,
      version: z.number().int().positive(),
      hashDisposition: z.enum(["retained", "erased"])
    })
    .strict()
} as const;

export function parseB1Command<K extends B1CommandKind>(
  input: B1AuthorizedDomainCommand<K>
): B1AuthorizedDomainCommand<K> {
  const kind = typeof input === "object" && input !== null ? input.kind : undefined;
  const schema = schemas[kind as B1CommandKind];
  if (!schema) throw new B1CommandValidationError();
  try {
    return schema.parse(input) as B1AuthorizedDomainCommand<K>;
  } catch {
    throw new B1CommandValidationError();
  }
}

export function canonicalizeB1Payload<K extends B1CommandKind>(
  kind: K,
  payload: B1CommandPayloadMap[K]
): B1CommandPayloadMap[K] {
  const copy = structuredClone(payload) as B1CommandPayloadMap[K] & Record<string, unknown>;
  for (const key of [
    "organizationIds",
    "initiativeIds",
    "attendeePersonIds",
    "contributorPersonIds"
  ]) {
    const value = copy[key];
    if (Array.isArray(value)) copy[key] = [...new Set(value as string[])].sort();
  }
  return copy;
}

export function parseStoredB1Result<K extends B1CommandKind>(
  kind: K,
  input: unknown
): B1CommandResultMap[K] {
  try {
    return resultSchemas[kind].parse(input) as B1CommandResultMap[K];
  } catch {
    throw new B1CommandInvariantError();
  }
}

export class B1CommandValidationError extends Error {
  constructor() {
    super("B1 command request is invalid");
    this.name = "B1CommandValidationError";
  }
}

export class B1CommandInvariantError extends Error {
  constructor() {
    super("B1 command transaction invariant failed");
    this.name = "B1CommandInvariantError";
  }
}
