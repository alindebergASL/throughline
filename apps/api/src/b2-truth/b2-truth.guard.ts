import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import type { SecurityContext } from "@throughline/core-types";
import { resolveDevIdentityFromHeaders } from "@throughline/tenancy";

export interface B2TruthRequest {
  headers: Record<string, string | string[] | undefined>;
  b2Context?: SecurityContext;
}

@Injectable()
export class B2TruthGuard implements CanActivate {
  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<B2TruthRequest>();
    try {
      request.b2Context = resolveDevIdentityFromHeaders(request.headers);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Identity resolution failed";
      if (message.startsWith("Header ")) throw new BadRequestException(message);
      throw new UnauthorizedException("Authentication is unavailable");
    }
  }
}
