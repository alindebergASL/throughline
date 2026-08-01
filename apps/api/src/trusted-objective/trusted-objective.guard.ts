import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { SecurityContext } from "@throughline/core-types";
import { assertNoHeaderSourcedAuthority, createDevSecurityContext } from "@throughline/tenancy";

export interface TrustedObjectiveRequest {
  headers: Record<string, string | string[] | undefined>;
  trustedObjectiveContext?: SecurityContext;
}

@Injectable()
export class TrustedObjectiveGuard implements CanActivate {
  private readonly startupIdentity = resolveStartupIdentity();

  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<TrustedObjectiveRequest>();
    try {
      if (!this.startupIdentity || hasHeader(request.headers, "x-throughline-dev-identity")) {
        throw new Error("Trusted-objective demo identity is unavailable");
      }
      assertNoHeaderSourcedAuthority(request.headers);
      request.trustedObjectiveContext = createDevSecurityContext(this.startupIdentity, {
        requestId: readHeader(request.headers, "x-request-id") ?? "dev-request",
        traceId: readHeader(request.headers, "x-trace-id") ?? "dev-trace"
      });
      return true;
    } catch {
      throw new UnauthorizedException("Authentication is unavailable");
    }
  }
}

function resolveStartupIdentity(): "tenant-a-owner" | "tenant-b-viewer" | null {
  if (process.env.NODE_ENV === "production" || process.env.AUTH_ADAPTER !== "dev") return null;
  if (process.env.TRUSTED_OBJECTIVE_DEMO_PERSONA === "owner") return "tenant-a-owner";
  if (process.env.TRUSTED_OBJECTIVE_DEMO_PERSONA === "unavailable") return "tenant-b-viewer";
  return null;
}

function hasHeader(headers: TrustedObjectiveRequest["headers"], name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function readHeader(headers: TrustedObjectiveRequest["headers"], name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}
