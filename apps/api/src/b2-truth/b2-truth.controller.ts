import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { B2_TRUTH_PREDICATE_CATALOG_VERSION } from "@throughline/core-types";
import {
  B2AuthorizationError,
  B2CommandInvariantError,
  B2CommandValidationError,
  B2IdempotencyConflictError,
  TruthLedgerConflictError,
  VerifiedClaimSourceSpanError
} from "@throughline/truth-ledger";
import { B2TruthGuard, type B2TruthRequest } from "./b2-truth.guard.js";
import { B2TruthRuntime } from "./b2-truth.runtime.js";

type JsonBody = Record<string, unknown>;

@Controller("internal/v1")
@UseGuards(B2TruthGuard)
export class B2TruthController {
  constructor(@Inject(B2TruthRuntime) private readonly runtime: B2TruthRuntime) {}

  @Post("claims")
  createClaim(@Req() request: B2TruthRequest, @Body() body: JsonBody) {
    return this.safe(
      () =>
        this.runtime.execute(
          {
            kind: "claim.create",
            idempotencyKey: requireIdempotencyKey(request),
            predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
            payload: body as never
          },
          requireContext(request)
        ),
      true
    );
  }

  @Post("facts")
  acceptFact(@Req() request: B2TruthRequest, @Body() body: JsonBody) {
    return this.safe(() =>
      this.runtime.execute(
        {
          kind: "fact.accept",
          idempotencyKey: requireIdempotencyKey(request),
          predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
          payload: body as never
        },
        requireContext(request)
      )
    );
  }

  @Post("facts/supersede")
  supersedeFact(@Req() request: B2TruthRequest, @Body() body: JsonBody) {
    return this.safe(() => {
      requireJsonContentType(request);
      return this.runtime.execute(
        {
          kind: "fact.supersede",
          idempotencyKey: requireIdempotencyKey(request),
          predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
          payload: body as never
        },
        requireContext(request)
      );
    });
  }

  @Post("facts/revoke")
  revokeFact(@Req() request: B2TruthRequest, @Body() body: JsonBody) {
    return this.safe(() => {
      requireJsonContentType(request);
      return this.runtime.execute(
        {
          kind: "fact.revoke",
          idempotencyKey: requireIdempotencyKey(request),
          predicateCatalogVersion: B2_TRUTH_PREDICATE_CATALOG_VERSION,
          payload: body as never
        },
        requireContext(request)
      );
    });
  }

  private async safe<T>(
    callback: () => Promise<T>,
    concealValidationAsUnavailable = false
  ): Promise<T> {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof B2CommandValidationError) {
        if (concealValidationAsUnavailable) {
          throw new NotFoundException("Resource unavailable");
        }
        throw new BadRequestException("Request is invalid");
      }
      if (
        error instanceof TruthLedgerConflictError ||
        error instanceof B2IdempotencyConflictError ||
        error instanceof B2CommandInvariantError
      ) {
        throw new ConflictException("Command precondition failed");
      }
      if (error instanceof B2AuthorizationError || error instanceof VerifiedClaimSourceSpanError) {
        throw new NotFoundException("Resource unavailable");
      }
      throw new InternalServerErrorException("Request could not be completed");
    }
  }
}

function requireContext(request: B2TruthRequest) {
  if (!request.b2Context) throw new BadRequestException("Request context is unavailable");
  return request.b2Context;
}

function requireJsonContentType(request: B2TruthRequest): void {
  const value = request.headers["content-type"];
  const contentType = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  if (
    contentType === undefined ||
    !/^\s*application\/json\s*(?:;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu.test(contentType)
  ) {
    throw new BadRequestException("Request is invalid");
  }
}

function requireIdempotencyKey(request: B2TruthRequest): string {
  const value = request.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || key.length > 200 || hasAsciiControlCharacter(key)) {
    throw new BadRequestException("Idempotency-Key is required");
  }
  return key;
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });
}
