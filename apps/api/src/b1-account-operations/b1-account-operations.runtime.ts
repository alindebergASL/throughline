import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { AccountOperationsDomainCommandBus } from "@throughline/account-operations";
import { PostgresAuthorizationService } from "@throughline/authorization";
import { ContentRepository } from "@throughline/content";
import type {
  B1AuthorizedDomainCommand,
  B1CommandKind,
  B1CommandResultMap,
  SafePersonProjection,
  SecurityContext
} from "@throughline/core-types";
import { createPgPool, type PgPool, withTenantTransaction } from "@throughline/db";
import { createDefaultProfileRegistry } from "@throughline/domain-profiles";
import { WorkGraphRepository, type Activity, type Initiative } from "@throughline/work-graph";

@Injectable()
export class B1AccountOperationsRuntime implements OnModuleDestroy {
  private readonly profiles = createDefaultProfileRegistry();
  private pool?: PgPool;
  private authorization?: PostgresAuthorizationService;
  private bus?: AccountOperationsDomainCommandBus;

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  execute<K extends B1CommandKind>(
    command: B1AuthorizedDomainCommand<K>,
    context: SecurityContext
  ): Promise<B1CommandResultMap[K]> {
    return this.commandBus().execute(command, context);
  }

  listOrganizations(context: SecurityContext) {
    return this.read(context, async (tx, graph, authorization) => {
      const candidates = await tx.query<{ id: string; space_id: string }>(
        `SELECT id, space_id FROM work.organizations
         WHERE tenant_id = $1 AND workspace_id = $2 AND status = 'active'
         ORDER BY space_id`,
        [context.tenantId, context.workspaceId]
      );
      const permitted: string[] = [];
      for (const { id, space_id: spaceId } of candidates.rows) {
        const decision = await authorization.canInTransaction(
          context,
          "organization.read",
          { type: "organization", id },
          tx
        );
        if (decision.allowed) permitted.push(spaceId);
      }
      return graph.listOrganizations(
        context.tenantId,
        context.workspaceId,
        permitted,
        context.dataClassCeiling
      );
    });
  }

  getOrganization(context: SecurityContext, organizationId: string) {
    return this.read(context, async (tx, graph, authorization) => {
      await requireAllowed(
        authorization.canInTransaction(
          context,
          "organization.read",
          { type: "organization", id: organizationId },
          tx
        )
      );
      return graph.getOrganization(context.tenantId, context.workspaceId, organizationId);
    });
  }

  getInitiative(context: SecurityContext, initiativeId: string) {
    return this.read(context, async (tx, graph, authorization) => {
      await requireAllowed(
        authorization.canInTransaction(
          context,
          "initiative.read",
          { type: "initiative", id: initiativeId },
          tx
        )
      );
      const initiative = await graph.getInitiative(
        context.tenantId,
        context.workspaceId,
        initiativeId
      );
      return {
        ...initiative,
        people: await this.safePeopleForUseSite(
          tx,
          graph,
          authorization,
          context,
          uniqueDefined([initiative.ownerPersonId, ...initiative.contributorPersonIds]),
          { type: "initiative", id: initiative.id }
        )
      };
    });
  }

  getActivity(context: SecurityContext, activityId: string) {
    return this.read(context, async (tx, graph, authorization) => {
      await requireAllowed(
        authorization.canInTransaction(
          context,
          "activity.read",
          { type: "activity", id: activityId },
          tx
        )
      );
      const candidates = await graph.getActivityAssociationCandidates(
        context.tenantId,
        context.workspaceId,
        activityId
      );
      const organizationIds = await permittedResourceIds(candidates.organizationIds, (id) =>
        authorization.canInTransaction(
          context,
          "organization.read",
          { type: "organization", id },
          tx
        )
      );
      const initiativeIds = await permittedResourceIds(candidates.initiativeIds, (id) =>
        authorization.canInTransaction(context, "initiative.read", { type: "initiative", id }, tx)
      );
      const personIds = await permittedResourceIds(candidates.personIds, (id) =>
        authorization.canInTransaction(context, "person.read", { type: "person", id }, tx, {
          personUseSite: { type: "activity", id: activityId }
        })
      );
      const activity = await graph.getActivity(context.tenantId, context.workspaceId, activityId, {
        organizationIds,
        initiativeIds,
        personIds
      });
      return {
        ...activity,
        people: await graph.getSafePeople(
          context.tenantId,
          context.workspaceId,
          uniqueDefined([activity.ownerPersonId, ...activity.attendeePersonIds])
        )
      };
    });
  }

  listActivitySources(context: SecurityContext, activityId: string) {
    return this.read(context, async (tx, graph, authorization) => {
      await requireAllowed(
        authorization.canInTransaction(
          context,
          "activity.read",
          { type: "activity", id: activityId },
          tx
        )
      );
      const activity = await graph.getActivityScope(
        context.tenantId,
        context.workspaceId,
        activityId
      );
      const sources = await new ContentRepository(tx).listActivitySources({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        activityId,
        activitySpaceId: activity.spaceId,
        permittedSourceSpaceIds: [activity.spaceId],
        dataClassCeiling: context.dataClassCeiling
      });
      for (const source of sources) {
        await requireAllowed(
          authorization.canInTransaction(
            context,
            "source.read",
            { type: "source", id: source.id },
            tx
          )
        );
      }
      return sources;
    });
  }

  getSource(context: SecurityContext, sourceArtifactId: string) {
    return this.read(context, async (tx, _graph, authorization) => {
      return readAuthorizedSource({
        content: new ContentRepository(tx),
        authorization,
        tx,
        context,
        sourceArtifactId
      });
    });
  }

  private async safePeopleForUseSite(
    tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
    graph: WorkGraphRepository,
    authorization: PostgresAuthorizationService,
    context: SecurityContext,
    personIds: string[],
    useSite: { type: "initiative" | "activity"; id: string }
  ): Promise<SafePersonProjection[]> {
    for (const personId of personIds) {
      await requireAllowed(
        authorization.canInTransaction(
          context,
          "person.read",
          { type: "person", id: personId },
          tx,
          { personUseSite: useSite }
        )
      );
    }
    return graph.getSafePeople(context.tenantId, context.workspaceId, personIds);
  }

  private read<T>(
    context: SecurityContext,
    callback: (
      tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
      graph: WorkGraphRepository,
      authorization: PostgresAuthorizationService
    ) => Promise<T>
  ): Promise<T> {
    const pool = this.databasePool();
    const authorization = this.authorizationService();
    return withTenantTransaction({ pool, context }, (tx) =>
      assertAppRole(tx).then(() => callback(tx, new WorkGraphRepository(tx), authorization))
    );
  }

  private databasePool(): PgPool {
    this.pool ??= createPgPool();
    return this.pool;
  }

  private authorizationService(): PostgresAuthorizationService {
    this.authorization ??= new PostgresAuthorizationService(this.databasePool());
    return this.authorization;
  }

  private commandBus(): AccountOperationsDomainCommandBus {
    this.bus ??= new AccountOperationsDomainCommandBus(
      this.databasePool(),
      this.authorizationService(),
      this.profiles
    );
    return this.bus;
  }
}

export async function readAuthorizedSource(input: {
  content: ContentRepository;
  authorization: PostgresAuthorizationService;
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0];
  context: SecurityContext;
  sourceArtifactId: string;
}) {
  await requireAllowed(
    input.authorization.canInTransaction(
      input.context,
      "source.read",
      { type: "source", id: input.sourceArtifactId },
      input.tx
    )
  );
  const currentId = await input.content.resolveCurrentSourceId(
    input.context.tenantId,
    input.context.workspaceId,
    input.sourceArtifactId
  );
  await requireAllowed(
    input.authorization.canInTransaction(
      input.context,
      "source.read",
      { type: "source", id: currentId },
      input.tx
    )
  );
  return input.content.getSource(
    input.context.tenantId,
    input.context.workspaceId,
    currentId,
    true
  );
}

async function requireAllowed(
  decision: ReturnType<PostgresAuthorizationService["canInTransaction"]>
) {
  if (!(await decision).allowed) throw new Error("B1 resource is unavailable");
}

function uniqueDefined(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))].sort();
}

async function permittedResourceIds(
  ids: readonly string[],
  decide: (id: string) => ReturnType<PostgresAuthorizationService["canInTransaction"]>
): Promise<string[]> {
  const permitted: string[] = [];
  for (const id of [...new Set(ids)].sort()) {
    if ((await decide(id)).allowed) permitted.push(id);
  }
  return permitted;
}

async function assertAppRole(
  tx: Parameters<Parameters<typeof withTenantTransaction>[1]>[0]
): Promise<void> {
  const result = await tx.query<{ current_user: string }>("SELECT current_user AS current_user");
  if (result.rows.length !== 1 || result.rows[0]?.current_user !== "throughline_app") {
    throw new Error("B1 resource is unavailable");
  }
}

export type B1InitiativeResponse = Initiative & { people: SafePersonProjection[] };
export type B1ActivityResponse = Activity & { people: SafePersonProjection[] };
