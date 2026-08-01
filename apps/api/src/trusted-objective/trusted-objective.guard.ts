import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import type { SecurityContext } from "@throughline/core-types";
import { resolveDevIdentityFromHeaders } from "@throughline/tenancy";

export interface TrustedObjectiveRequest {
  headers: Record<string, string | string[] | undefined>;
  trustedObjectiveContext?: SecurityContext;
}

@Injectable()
export class TrustedObjectiveGuard implements CanActivate {
  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<TrustedObjectiveRequest>();
    try {
      request.trustedObjectiveContext = resolveDevIdentityFromHeaders(request.headers);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Identity resolution failed";
      if (message.startsWith("Header ")) throw new BadRequestException(message);
      throw new UnauthorizedException("Authentication is unavailable");
    }
  }
}
