import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import type { SecurityContext } from "@throughline/core-types";
import { resolveDevIdentityFromHeaders } from "@throughline/tenancy";

const acceptedBodyFields = new Set(["spaceId", "proofKey"]);

export interface FoundationProofRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
  foundationProofContext?: SecurityContext;
}

@Injectable()
export class FoundationProofGuard implements CanActivate {
  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<FoundationProofRequest>();
    const body = request.body;
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new BadRequestException("Foundation proof body must be an object");
    }
    for (const field of Object.keys(body)) {
      if (!acceptedBodyFields.has(field)) {
        throw new BadRequestException(`Field ${field} is not accepted by the Foundation proof`);
      }
    }

    try {
      request.foundationProofContext = resolveDevIdentityFromHeaders(request.headers);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dev identity resolution failed";
      if (message.startsWith("Header ")) throw new BadRequestException(message);
      throw new UnauthorizedException(message);
    }
  }
}
