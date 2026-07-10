import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { FoundationProofGuard, type FoundationProofRequest } from "./foundation-proof.guard.js";
import { FoundationProofService } from "./foundation-proof.service.js";

interface FoundationProofBody {
  spaceId?: unknown;
  proofKey?: unknown;
}

@Controller("__test/foundation-proof")
@UseGuards(FoundationProofGuard)
export class FoundationProofController {
  constructor(@Inject(FoundationProofService) private readonly service: FoundationProofService) {}

  @Post()
  create(@Req() request: FoundationProofRequest, @Body() body: FoundationProofBody) {
    if (!request.foundationProofContext) {
      throw new BadRequestException("Foundation proof identity context is unavailable");
    }
    if (typeof body.spaceId !== "string" || !isUuid(body.spaceId)) {
      throw new BadRequestException("spaceId must be a UUID");
    }
    if (
      typeof body.proofKey !== "string" ||
      body.proofKey.length < 1 ||
      body.proofKey.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(body.proofKey)
    ) {
      throw new BadRequestException("proofKey is invalid");
    }

    const traceparent = readHeader(request.headers, "traceparent");
    const tracestate = readHeader(request.headers, "tracestate");
    return this.service.create({
      context: request.foundationProofContext,
      spaceId: body.spaceId,
      proofKey: body.proofKey,
      ...(traceparent ? { traceparent } : {}),
      ...(tracestate ? { tracestate } : {})
    });
  }
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
