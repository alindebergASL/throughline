import { DynamicModule, Module } from "@nestjs/common";
import { PostgresAuthorizationService } from "@throughline/authorization";
import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import type { PgPool } from "@throughline/db";
import type { AsyncContextReferenceCodec } from "@throughline/tenancy";
import { FoundationProofController } from "./foundation-proof.controller.js";
import { FoundationProofGuard } from "./foundation-proof.guard.js";
import {
  defaultFoundationProofRuntimeOptions,
  FoundationProofService
} from "./foundation-proof.service.js";
import {
  FOUNDATION_PROOF_AUTHORIZATION,
  FOUNDATION_PROOF_CODEC,
  FOUNDATION_PROOF_OPTIONS,
  FOUNDATION_PROOF_POOL
} from "./foundation-proof.tokens.js";

export interface FoundationProofModuleOptions {
  pool: PgPool;
  contextReferenceCodec: AsyncContextReferenceCodec;
  relayServicePrincipalId: string;
  workerServicePrincipalId: string;
  authorization?: TransactionAwareAuthorizationService;
  uuidV7?: () => string;
}

@Module({})
export class FoundationProofModule {
  static register(options: FoundationProofModuleOptions): DynamicModule {
    const runtimeOptions = defaultFoundationProofRuntimeOptions({
      relayServicePrincipalId: options.relayServicePrincipalId,
      workerServicePrincipalId: options.workerServicePrincipalId,
      ...(options.uuidV7 ? { uuidV7: options.uuidV7 } : {})
    });
    return {
      module: FoundationProofModule,
      controllers: [FoundationProofController],
      providers: [
        FoundationProofGuard,
        FoundationProofService,
        { provide: FOUNDATION_PROOF_POOL, useValue: options.pool },
        { provide: FOUNDATION_PROOF_CODEC, useValue: options.contextReferenceCodec },
        { provide: FOUNDATION_PROOF_OPTIONS, useValue: runtimeOptions },
        {
          provide: FOUNDATION_PROOF_AUTHORIZATION,
          useValue: options.authorization ?? new PostgresAuthorizationService(options.pool)
        }
      ]
    };
  }
}
