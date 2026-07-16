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
import { SourceTextValidationError } from "@throughline/content";
import { WorkGraphInvariantError } from "@throughline/work-graph";
import {
  B1AccountOperationsGuard,
  type B1AccountOperationsRequest
} from "./b1-account-operations.guard.js";
import { B1AccountOperationsRuntime } from "./b1-account-operations.runtime.js";

type JsonBody = Record<string, unknown>;

@Controller("v1")
@UseGuards(B1AccountOperationsGuard)
export class B1AccountOperationsController {
  constructor(
    @Inject(B1AccountOperationsRuntime) private readonly runtime: B1AccountOperationsRuntime
  ) {}

  @Post("organizations")
  createOrganization(@Req() request: B1AccountOperationsRequest, @Body() body: JsonBody) {
    return this.safe(() =>
      this.runtime.execute(
        {
          kind: "organization.create",
          idempotencyKey: requireIdempotencyKey(request),
          payload: body as never
        },
        requireContext(request)
      )
    );
  }

  @Get("organizations")
  listOrganizations(@Req() request: B1AccountOperationsRequest) {
    return this.safe(() => this.runtime.listOrganizations(requireContext(request)));
  }

  @Get("organizations/:organizationId")
  getOrganization(
    @Req() request: B1AccountOperationsRequest,
    @Param("organizationId") organizationId: string
  ) {
    return this.safe(() =>
      this.runtime.getOrganization(requireContext(request), requireUuid(organizationId))
    );
  }

  @Post("initiatives")
  createInitiative(@Req() request: B1AccountOperationsRequest, @Body() body: JsonBody) {
    return this.safe(() =>
      this.runtime.execute(
        {
          kind: "initiative.create",
          idempotencyKey: requireIdempotencyKey(request),
          payload: body as never
        },
        requireContext(request)
      )
    );
  }

  @Get("initiatives/:initiativeId")
  getInitiative(
    @Req() request: B1AccountOperationsRequest,
    @Param("initiativeId") initiativeId: string
  ) {
    return this.safe(() =>
      this.runtime.getInitiative(requireContext(request), requireUuid(initiativeId))
    );
  }

  @Post("activities")
  createActivity(@Req() request: B1AccountOperationsRequest, @Body() body: JsonBody) {
    return this.safe(() =>
      this.runtime.execute(
        {
          kind: "activity.create",
          idempotencyKey: requireIdempotencyKey(request),
          payload: body as never
        },
        requireContext(request)
      )
    );
  }

  @Get("activities/:activityId")
  getActivity(@Req() request: B1AccountOperationsRequest, @Param("activityId") activityId: string) {
    return this.safe(() =>
      this.runtime.getActivity(requireContext(request), requireUuid(activityId))
    );
  }

  @Post("activities/:activityId/sources")
  captureSource(
    @Req() request: B1AccountOperationsRequest,
    @Param("activityId") activityId: string,
    @Body() body: JsonBody
  ) {
    if (Object.hasOwn(body, "activityId"))
      throw new BadRequestException("activityId is path-derived");
    if (Object.hasOwn(body, "requestedAccessClass")) {
      throw new BadRequestException("access class is server-derived");
    }
    return this.safe(() =>
      this.runtime.execute(
        {
          kind: "source.capture",
          idempotencyKey: requireIdempotencyKey(request),
          payload: { ...body, activityId: requireUuid(activityId) } as never
        },
        requireContext(request)
      )
    );
  }

  @Get("activities/:activityId/sources")
  listSources(@Req() request: B1AccountOperationsRequest, @Param("activityId") activityId: string) {
    return this.safe(() =>
      this.runtime.listActivitySources(requireContext(request), requireUuid(activityId))
    );
  }

  @Get("sources/:sourceArtifactId")
  getSource(
    @Req() request: B1AccountOperationsRequest,
    @Param("sourceArtifactId") sourceArtifactId: string
  ) {
    return this.safe(() =>
      this.runtime.getSource(requireContext(request), requireUuid(sourceArtifactId))
    );
  }

  private async safe<T>(callback: () => Promise<T>): Promise<T> {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (
        error instanceof B1CommandValidationError ||
        error instanceof SourceTextValidationError ||
        error instanceof WorkGraphInvariantError
      ) {
        throw new BadRequestException("Request is invalid");
      }
      if (error instanceof B1IdempotencyConflictError) {
        throw new ConflictException("Idempotency key conflict");
      }
      if (error instanceof B1AuthorizationError || isUnavailable(error)) {
        throw new NotFoundException("Resource unavailable");
      }
      if (error instanceof B1CommandInvariantError) {
        throw new ConflictException("Command precondition failed");
      }
      throw new InternalServerErrorException("Request could not be completed");
    }
  }
}

function requireContext(request: B1AccountOperationsRequest) {
  if (!request.b1Context) throw new BadRequestException("Request context is unavailable");
  return request.b1Context;
}

function requireIdempotencyKey(request: B1AccountOperationsRequest): string {
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

function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException("Identifier is invalid");
  }
  return value.toLowerCase();
}

function isUnavailable(error: unknown): boolean {
  return error instanceof Error && /unavailable|not available/i.test(error.message);
}
