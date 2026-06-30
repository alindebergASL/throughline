import type { SecurityContext } from "@throughline/core-types";
import { z } from "zod";

const uuidSchema = z.string().uuid();
const isoDateSchema = z.string().datetime({ offset: true });

export const securityContextSchema = z
  .object({
    requestId: z.string().min(1),
    traceId: z.string().min(1),
    tenantId: uuidSchema,
    workspaceId: uuidSchema,
    actorUserId: uuidSchema.optional(),
    actorMembershipId: uuidSchema.optional(),
    actorDisplayPersonId: uuidSchema.optional(),
    servicePrincipalId: uuidSchema.optional(),
    agentPrincipalId: uuidSchema.optional(),
    delegatedByUserId: uuidSchema.optional(),
    delegatedByMembershipId: uuidSchema.optional(),
    requestedSpaceIds: z.array(uuidSchema),
    membershipIds: z.array(uuidSchema),
    roleHints: z.array(z.string().min(1)),
    dataClassCeiling: z.enum(["public", "workspace", "restricted", "confidential"]),
    policyVersion: z.string().min(1),
    issuedAt: isoDateSchema,
    expiresAt: isoDateSchema
  })
  .superRefine((context, issue) => {
    const hasUserPrincipal = Boolean(context.actorUserId && context.actorMembershipId);
    const principalCount = [
      hasUserPrincipal,
      Boolean(context.servicePrincipalId),
      Boolean(context.agentPrincipalId)
    ].filter(Boolean).length;

    if (principalCount !== 1) {
      issue.addIssue({
        code: "custom",
        message: "SecurityContext must carry exactly one user, service, or agent principal",
        path: ["actorUserId"]
      });
    }

    if (Date.parse(context.expiresAt) <= Date.parse(context.issuedAt)) {
      issue.addIssue({
        code: "custom",
        message: "SecurityContext expiresAt must be later than issuedAt",
        path: ["expiresAt"]
      });
    }
  });

export type SecurityContextValidationError = z.ZodError<SecurityContext>;

export function parseSecurityContext(input: unknown): SecurityContext {
  return securityContextSchema.parse(input) as SecurityContext;
}

export function validateSecurityContext(input: unknown): SecurityContext {
  return parseSecurityContext(input);
}

export function isSecurityContextExpired(context: SecurityContext, now = new Date()): boolean {
  return Date.parse(context.expiresAt) <= now.getTime();
}
