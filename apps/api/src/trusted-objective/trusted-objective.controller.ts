import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import {
  B1AuthorizationError,
  B1CommandInvariantError,
  B1CommandValidationError,
  B1IdempotencyConflictError
} from "@throughline/account-operations";
import { ContentInvariantError, SourceTextValidationError } from "@throughline/content";
import {
  B2AuthorizationError,
  B2CommandInvariantError,
  B2CommandValidationError,
  B2IdempotencyConflictError,
  TruthLedgerConflictError,
  VerifiedClaimSourceSpanError
} from "@throughline/truth-ledger";
import {
  TrustedObjectiveConflictError,
  TrustedObjectiveInputError,
  TrustedObjectiveUnavailableError,
  parseCaptureBody,
  parseEmptyBody,
  parseProposalBody
} from "./trusted-objective.contract.js";
import { TrustedObjectiveGuard, type TrustedObjectiveRequest } from "./trusted-objective.guard.js";
import { TrustedObjectiveRuntime } from "./trusted-objective.runtime.js";

@Controller("v1/demo/initiatives/:initiativeId/trusted-objective")
@UseGuards(TrustedObjectiveGuard)
export class TrustedObjectiveController {
  constructor(@Inject(TrustedObjectiveRuntime) private readonly runtime: TrustedObjectiveRuntime) {}

  @Get()
  getState(@Req() request: TrustedObjectiveRequest, @Param("initiativeId") initiativeId: string) {
    return this.safe(() =>
      this.runtime.getState(requireContext(request), requireUuid(initiativeId))
    );
  }

  @Post("source")
  capture(
    @Req() request: TrustedObjectiveRequest,
    @Param("initiativeId") initiativeId: string,
    @Body() body: unknown
  ) {
    return this.safe(() => {
      const { note } = parseCaptureBody(body);
      return this.runtime.capture(requireContext(request), requireUuid(initiativeId), note);
    });
  }

  @Post("proposal")
  propose(
    @Req() request: TrustedObjectiveRequest,
    @Param("initiativeId") initiativeId: string,
    @Body() body: unknown
  ) {
    return this.safe(() => {
      const input = parseProposalBody(body);
      return this.runtime.propose(requireContext(request), requireUuid(initiativeId), input);
    });
  }

  @Post("accept")
  accept(
    @Req() request: TrustedObjectiveRequest,
    @Param("initiativeId") initiativeId: string,
    @Body() body: unknown
  ) {
    return this.safe(() => {
      parseEmptyBody(body);
      return this.runtime.accept(requireContext(request), requireUuid(initiativeId));
    });
  }

  @Post("draft-confirmation")
  draftConfirmation(
    @Req() request: TrustedObjectiveRequest,
    @Param("initiativeId") initiativeId: string,
    @Body() body: unknown
  ) {
    return this.safe(() => {
      parseEmptyBody(body);
      return this.runtime.draftConfirmation(requireContext(request), requireUuid(initiativeId));
    });
  }

  private async safe<T>(callback: () => Promise<T>): Promise<T> {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (
        error instanceof TrustedObjectiveInputError ||
        error instanceof B1CommandValidationError ||
        error instanceof B2CommandValidationError ||
        error instanceof SourceTextValidationError
      ) {
        throw new BadRequestException("Request is invalid");
      }
      if (
        error instanceof TrustedObjectiveConflictError ||
        error instanceof B1CommandInvariantError ||
        error instanceof B1IdempotencyConflictError ||
        error instanceof B2CommandInvariantError ||
        error instanceof B2IdempotencyConflictError ||
        error instanceof TruthLedgerConflictError ||
        error instanceof ContentInvariantError
      ) {
        throw new ConflictException("Command precondition failed");
      }
      if (
        error instanceof TrustedObjectiveUnavailableError ||
        error instanceof B1AuthorizationError ||
        error instanceof B2AuthorizationError ||
        error instanceof VerifiedClaimSourceSpanError
      ) {
        throw new NotFoundException("Resource unavailable");
      }
      throw new InternalServerErrorException("Request could not be completed");
    }
  }
}

function requireContext(request: TrustedObjectiveRequest) {
  if (!request.trustedObjectiveContext)
    throw new BadRequestException("Request context is unavailable");
  return request.trustedObjectiveContext;
}

function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException("Identifier is invalid");
  }
  return value.toLowerCase();
}
