import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PostgresAuthorizationService } from "@throughline/authorization";
import type {
  B2AuthorizedDomainCommand,
  B2CommandResultMap,
  SecurityContext
} from "@throughline/core-types";
import { createPgPool, type PgPool } from "@throughline/db";
import {
  TruthLedgerDomainCommandBus,
  type DurableTruthCommandKind
} from "@throughline/truth-ledger";

@Injectable()
export class B2TruthRuntime implements OnModuleDestroy {
  private pool?: PgPool;
  private authorization?: PostgresAuthorizationService;
  private bus?: TruthLedgerDomainCommandBus;

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  execute<K extends DurableTruthCommandKind>(
    command: B2AuthorizedDomainCommand<K>,
    context: SecurityContext
  ): Promise<B2CommandResultMap[K]> {
    return this.commandBus().execute(command, context);
  }

  private databasePool(): PgPool {
    this.pool ??= createPgPool();
    return this.pool;
  }

  private authorizationService(): PostgresAuthorizationService {
    this.authorization ??= new PostgresAuthorizationService(this.databasePool());
    return this.authorization;
  }

  private commandBus(): TruthLedgerDomainCommandBus {
    this.bus ??= new TruthLedgerDomainCommandBus(this.databasePool(), this.authorizationService());
    return this.bus;
  }
}
