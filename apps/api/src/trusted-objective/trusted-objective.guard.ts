import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { SecurityContext } from "@throughline/core-types";
import { assertNoHeaderSourcedAuthority, createDevSecurityContext } from "@throughline/tenancy";

export interface TrustedObjectiveRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  socket?: { remoteAddress?: string | undefined };
  trustedObjectiveContext?: SecurityContext;
}

@Injectable()
export class TrustedObjectiveGuard implements CanActivate {
  private readonly startupIdentity = resolveStartupIdentity();

  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<TrustedObjectiveRequest>();
    try {
      if (
        !this.startupIdentity ||
        hasHeader(request.headers, "x-throughline-dev-identity") ||
        hasForwardedHeaders(request.headers) ||
        !isLoopbackAddress(request.socket?.remoteAddress) ||
        !hasLoopbackHost(request.headers) ||
        !hasTrustedMutationContentType(request)
      ) {
        throw new Error("Trusted-objective demo identity is unavailable");
      }
      assertNoHeaderSourcedAuthority(request.headers);
      const requestId = readCorrelationHeader(
        request.headers,
        "x-request-id",
        /^[\x21-\x7e]{1,200}$/u
      );
      const traceId = readCorrelationHeader(request.headers, "x-trace-id", /^[0-9a-f]{32}$/iu);
      request.trustedObjectiveContext = createDevSecurityContext(this.startupIdentity, {
        requestId: requestId ?? "dev-request",
        traceId: traceId ?? "dev-trace"
      });
      return true;
    } catch {
      throw new UnauthorizedException("Authentication is unavailable");
    }
  }
}

function hasTrustedMutationContentType(request: TrustedObjectiveRequest): boolean {
  if (request.method.toUpperCase() === "GET") return true;
  const contentType = readHeader(request.headers, "content-type");
  return (
    contentType !== undefined &&
    /^application\/json(?:\s*;\s*charset\s*=\s*(?:"[^"]+"|[!#$%&'*+.^_`|~0-9A-Za-z-]+))*\s*$/iu.test(
      contentType
    )
  );
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

function hasForwardedHeaders(headers: TrustedObjectiveRequest["headers"]): boolean {
  return ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((name) =>
    hasHeader(headers, name)
  );
}

function readHeader(headers: TrustedObjectiveRequest["headers"], name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function readCorrelationHeader(
  headers: TrustedObjectiveRequest["headers"],
  name: string,
  schema: RegExp
): string | undefined {
  const value = readHeader(headers, name);
  if (value !== undefined && !schema.test(value)) {
    throw new Error("Trusted-objective correlation metadata is unavailable");
  }
  return value;
}

function hasLoopbackHost(headers: TrustedObjectiveRequest["headers"]): boolean {
  const host = readHeader(headers, "host");
  if (
    !host ||
    Array.isArray(Object.entries(headers).find(([key]) => key.toLowerCase() === "host")?.[1])
  ) {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(127(?:\.\d{1,3}){3})$/u)?.[1];
  return isIpv4Loopback(mapped ?? normalized);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname.toLowerCase() === "localhost") return true;
  const address =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isLoopbackAddress(address);
}

function isIpv4Loopback(address: string): boolean {
  const octets = address.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}
