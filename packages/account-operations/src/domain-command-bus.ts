import type {
  AccessClass,
  B1AuthorizedDomainCommand,
  B1CommandKind,
  B1CommandResultMap,
  DomainNotificationEnvelope,
  DomainNotificationEventType,
  ResourceRef,
  SecurityContext
} from "@throughline/core-types";
import type { TransactionAwareAuthorizationService } from "@throughline/authorization";
import { PostgresAuthorizationService } from "@throughline/authorization";
import { ContentRepository, normalizeAndChunkSource } from "@throughline/content";
import {
  ProductDomainTransactionRepositories,
  ProductDomainInvariantError,
  hashCanonicalCommandRequest,
  type DomainCommandRepository,
  type PgPool,
  type TenantDbTransaction,
  withCreatedChildSpaceScope,
  withTenantTransaction
} from "@throughline/db";
import {
  createDefaultProfileRegistry,
  type AiSolutionsProfile,
  type DomainProfileRegistry
} from "@throughline/domain-profiles";
import {
  WorkGraphRepository,
  deriveRelationshipGoverningSpace,
  normalizeOrganizationDomains,
  normalizeOrganizationName,
  resolveActivityGoverningParent,
  validateActivityTime,
  validateInitiativeAssociations,
  type Activity,
  type Relationship,
  type RelationshipEndpoint
} from "@throughline/work-graph";
import { createHash, randomBytes } from "node:crypto";
import {
  B1CommandInvariantError,
  canonicalizeB1Payload,
  parseB1Command,
  parseStoredB1Result
} from "./command-schemas.js";

const APP_ROLE = "throughline_app";
const COMMAND_SCHEMA_VERSION = 1;

type ParsedCommand = B1AuthorizedDomainCommand<B1CommandKind>;

export class B1AuthorizationError extends Error {
  constructor() {
    super("B1 resource is unavailable");
    this.name = "B1AuthorizationError";
  }
}

export class B1IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key conflicts with another request");
    this.name = "B1IdempotencyConflictError";
  }
}

export class AccountOperationsDomainCommandBus {
  private readonly authorization: TransactionAwareAuthorizationService;
  private readonly profiles: DomainProfileRegistry;

  constructor(
    private readonly pool: PgPool,
    authorization?: TransactionAwareAuthorizationService,
    profiles = createDefaultProfileRegistry()
  ) {
    this.authorization = authorization ?? new PostgresAuthorizationService(pool);
    this.profiles = profiles;
  }

  async execute<K extends B1CommandKind>(
    input: B1AuthorizedDomainCommand<K>,
    context: SecurityContext
  ): Promise<B1CommandResultMap[K]> {
    const command = parseB1Command(input) as ParsedCommand;
    const trustedCommand = {
      kind: command.kind,
      idempotencyKey: command.idempotencyKey,
      payload: canonicalizeB1Payload(command.kind, command.payload)
    } as ParsedCommand;
    const reservationSpaceId = await this.resolveReservationSpace(trustedCommand, context);
    const mutationContext = { ...context, requestedSpaceIds: [reservationSpaceId] };
    return withTenantTransaction({ pool: this.pool, context: mutationContext }, async (tx) => {
      await assertApplicationRole(tx);
      const result = await this.executeInTransaction(
        trustedCommand,
        mutationContext,
        reservationSpaceId,
        tx
      );
      return result as B1CommandResultMap[K];
    });
  }

  private async resolveReservationSpace(
    command: ParsedCommand,
    context: SecurityContext
  ): Promise<string> {
    return withTenantTransaction({ pool: this.pool, context }, async (tx) => {
      await assertApplicationRole(tx);
      const graph = new WorkGraphRepository(tx);
      switch (command.kind) {
        case "organization.create":
          return (await graph.getWorkspaceProfilePin(context.tenantId, context.workspaceId))
            .rootSpaceId;
        case "initiative.create":
          return (
            await graph.getOrganization(
              context.tenantId,
              context.workspaceId,
              command.payload.primaryOrganizationId
            )
          ).spaceId;
        case "activity.create": {
          const parent = resolveActivityGoverningParent(command.payload);
          return parent.type === "initiative"
            ? (await graph.getInitiative(context.tenantId, context.workspaceId, parent.id)).spaceId
            : (await graph.getOrganization(context.tenantId, context.workspaceId, parent.id))
                .spaceId;
        }
        case "relationship.create":
          return (await deriveRelationshipScope(tx, graph, context, command.payload)).spaceId;
        case "relationship.end":
          return (
            await graph.getRelationship(
              context.tenantId,
              context.workspaceId,
              command.payload.relationshipId
            )
          ).spaceId;
        case "content.create":
          return command.payload.spaceId;
        case "content.revise":
          return (
            await new ContentRepository(tx).getContentItemScope(
              context.tenantId,
              context.workspaceId,
              command.payload.contentItemId
            )
          ).spaceId;
        case "source.capture":
          return (
            await graph.getActivityScope(
              context.tenantId,
              context.workspaceId,
              command.payload.activityId
            )
          ).spaceId;
        case "source.correct":
          return (
            await new ContentRepository(tx).getSourceScope(
              context.tenantId,
              context.workspaceId,
              command.payload.predecessorSourceArtifactId
            )
          ).spaceId;
        case "source.tombstone":
          return (
            await new ContentRepository(tx).getSourceScope(
              context.tenantId,
              context.workspaceId,
              command.payload.sourceArtifactId
            )
          ).spaceId;
      }
    });
  }

  private async executeInTransaction(
    command: ParsedCommand,
    context: SecurityContext,
    reservationSpaceId: string,
    tx: TenantDbTransaction
  ): Promise<B1CommandResultMap[B1CommandKind]> {
    const actor = requireHumanActor(context);
    const graph = new WorkGraphRepository(tx);
    const content = new ContentRepository(tx);
    const domain = new ProductDomainTransactionRepositories(tx);
    const requestHash = hashCanonicalCommandRequest({
      kind: command.kind,
      payload: command.payload
    });
    const trace = traceCarrier(context);

    switch (command.kind) {
      case "organization.create": {
        const pin = await graph.getWorkspaceProfilePin(context.tenantId, context.workspaceId);
        this.profiles.resolve(pin.profileId, pin.profileVersion);
        if (pin.rootSpaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        const parent = await graph.getSpace(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId,
          true
        );
        await this.authorize(tx, context, "organization.create", { type: "space", id: parent.id });
        await this.authorize(tx, context, "space.create_child", { type: "space", id: parent.id });
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const normalizedName = normalizeOrganizationName(command.payload.name);
        const domains = normalizeOrganizationDomains(command.payload.domains);
        const result = await withCreatedChildSpaceScope(
          tx,
          {
            tenantId: context.tenantId,
            workspaceId: context.workspaceId,
            expectedParentSpaceId: reservationSpaceId,
            kind: "organization",
            name: command.payload.name,
            accessClass: pin.defaultAccessClass,
            inheritanceMode: "inherit"
          },
          async (child) => {
            const { organizationId } = await child.createOrganization({
              name: command.payload.name,
              normalizedName,
              domains
            });
            await child.insertAudit(
              auditInput(
                context,
                trace,
                reservation.commandId,
                child.childSpaceId,
                "organization.create",
                "organization",
                organizationId,
                { organizationId }
              )
            );
            await child.insertOutbox({
              envelope: notification(
                context,
                trace,
                reservation.commandId,
                child.childSpaceId,
                "organization.created",
                organizationId,
                1,
                { organizationId }
              ),
              policyVersionId: context.policyVersion
            });
            return { organizationId, spaceId: child.childSpaceId, version: 1 as const };
          }
        );
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "organization",
          result.organizationId,
          result
        );
        return result;
      }
      case "initiative.create": {
        const primary = await graph.getOrganization(
          context.tenantId,
          context.workspaceId,
          command.payload.primaryOrganizationId
        );
        if (primary.spaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        const parent = await graph.getSpace(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId,
          true
        );
        await this.authorize(tx, context, "initiative.create", { type: "space", id: parent.id });
        await this.authorize(tx, context, "space.create_child", { type: "space", id: parent.id });
        const pin = await graph.getWorkspaceProfilePin(context.tenantId, context.workspaceId);
        const profile = this.profiles.resolve(pin.profileId, pin.profileVersion);
        requireProfileInitiative(profile, command.payload.typeKey, command.payload.stageKey);
        const organizationIds = [
          ...new Set([
            command.payload.primaryOrganizationId,
            ...(command.payload.organizationIds ?? [])
          ])
        ].sort();
        validateInitiativeAssociations({
          organizationIds,
          primaryOrganizationId: command.payload.primaryOrganizationId
        });
        for (const organizationId of organizationIds) {
          const organization =
            organizationId === primary.id
              ? primary
              : await graph.getOrganization(context.tenantId, context.workspaceId, organizationId);
          await this.authorize(tx, context, "organization.read", {
            type: "organization",
            id: organization.id
          });
        }
        const ownerPersonId = command.payload.ownerPersonId ?? actor.displayPersonId;
        const contributorPersonIds = [
          ...new Set(command.payload.contributorPersonIds ?? [])
        ].sort();
        await graph.getSafePeople(context.tenantId, context.workspaceId, [
          ownerPersonId,
          ...contributorPersonIds
        ]);
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const result = await withCreatedChildSpaceScope(
          tx,
          {
            tenantId: context.tenantId,
            workspaceId: context.workspaceId,
            expectedParentSpaceId: reservationSpaceId,
            kind: "initiative",
            name: command.payload.title,
            accessClass: parent.accessClass,
            inheritanceMode: "inherit"
          },
          async (child) => {
            const { initiativeId } = await child.createInitiative({
              title: command.payload.title,
              typeKey: command.payload.typeKey,
              stageKey: command.payload.stageKey,
              health: command.payload.health ?? "active",
              ownerPersonId,
              profileId: pin.profileId,
              profileVersion: pin.profileVersion,
              primaryOrganizationId: primary.id,
              supportingOrganizationIds: organizationIds.filter((id) => id !== primary.id),
              contributorPersonIds
            });
            await child.insertAudit(
              auditInput(
                context,
                trace,
                reservation.commandId,
                child.childSpaceId,
                "initiative.create",
                "initiative",
                initiativeId,
                { initiativeId }
              )
            );
            await child.insertOutbox({
              envelope: notification(
                context,
                trace,
                reservation.commandId,
                child.childSpaceId,
                "initiative.created",
                initiativeId,
                1,
                { initiativeId }
              ),
              policyVersionId: context.policyVersion
            });
            return { initiativeId, spaceId: child.childSpaceId, version: 1 as const };
          }
        );
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "initiative",
          result.initiativeId,
          result
        );
        return result;
      }
      case "activity.create": {
        const parentRef = resolveActivityGoverningParent(command.payload);
        validateActivityTime(command.payload);
        const governing =
          parentRef.type === "initiative"
            ? await graph.getInitiative(context.tenantId, context.workspaceId, parentRef.id)
            : await graph.getOrganization(context.tenantId, context.workspaceId, parentRef.id);
        if (governing.spaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        const parent = await graph.getSpace(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId,
          true
        );
        await this.authorize(tx, context, "activity.create", { type: "space", id: parent.id });
        const pin = await graph.getWorkspaceProfilePin(context.tenantId, context.workspaceId);
        const profile = this.profiles.resolve(pin.profileId, pin.profileVersion);
        if (
          !profile.activityTemplates.some(({ key }) => key === command.payload.profileTemplateKey)
        ) {
          throw new B1CommandInvariantError();
        }
        for (const organizationId of command.payload.organizationIds) {
          await graph.getOrganization(context.tenantId, context.workspaceId, organizationId);
          await this.authorize(tx, context, "organization.read", {
            type: "organization",
            id: organizationId
          });
        }
        for (const initiativeId of command.payload.initiativeIds) {
          await graph.getInitiative(context.tenantId, context.workspaceId, initiativeId);
          await this.authorize(tx, context, "initiative.read", {
            type: "initiative",
            id: initiativeId
          });
        }
        const ownerPersonId = command.payload.ownerPersonId ?? actor.displayPersonId;
        const attendeePersonIds = [...new Set(command.payload.attendeePersonIds ?? [])].sort();
        await graph.getSafePeople(context.tenantId, context.workspaceId, [
          ownerPersonId,
          ...attendeePersonIds
        ]);
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const activityId = generateUuidV7();
        const activity: Activity = {
          id: activityId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: reservationSpaceId,
          subtype: command.payload.profileTemplateKey,
          profileTemplateKey: command.payload.profileTemplateKey,
          title: command.payload.title,
          status: command.payload.status ?? "planned",
          ...(command.payload.occurredAt ? { occurredAt: command.payload.occurredAt } : {}),
          ...(command.payload.startsAt ? { startsAt: command.payload.startsAt } : {}),
          ...(command.payload.endsAt ? { endsAt: command.payload.endsAt } : {}),
          ownerPersonId,
          ...(command.payload.governingInitiativeId
            ? { governingInitiativeId: command.payload.governingInitiativeId }
            : {}),
          ...(command.payload.governingOrganizationId
            ? { governingOrganizationId: command.payload.governingOrganizationId }
            : {}),
          organizationIds: [...new Set(command.payload.organizationIds)].sort(),
          initiativeIds: [...new Set(command.payload.initiativeIds)].sort(),
          attendeePersonIds,
          version: 1
        };
        await graph.createActivity(activity);
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "activity.create",
            "activity",
            activityId,
            { activityId }
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "activity.created",
            activityId,
            1,
            { activityId }
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = { activityId, spaceId: reservationSpaceId, version: 1 as const };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "activity",
          activityId,
          result
        );
        return result;
      }
      case "relationship.create": {
        const derived = await deriveRelationshipScope(tx, graph, context, command.payload);
        if (derived.spaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        await graph.getSpace(context.tenantId, context.workspaceId, reservationSpaceId, true);
        await this.authorize(tx, context, "relationship.create", {
          type: "space",
          id: reservationSpaceId
        });
        await this.authorizeRelationshipEndpoints(tx, context, command.payload, reservationSpaceId);
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const relationshipId = generateUuidV7();
        const relationship: Relationship = {
          id: relationshipId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: reservationSpaceId,
          subject: command.payload.subject,
          predicate: command.payload.predicate,
          object: command.payload.object,
          ...(command.payload.context ? { context: command.payload.context } : {}),
          ...(command.payload.validFrom ? { validFrom: command.payload.validFrom } : {}),
          version: 1
        };
        await graph.createRelationship(relationship);
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "relationship.create",
            "relationship",
            relationshipId,
            { relationshipId }
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "relationship.created",
            relationshipId,
            1,
            { relationshipId }
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = { relationshipId, spaceId: reservationSpaceId, version: 1 as const };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "relationship",
          relationshipId,
          result
        );
        return result;
      }
      case "relationship.end": {
        const relationship = await graph.getRelationship(
          context.tenantId,
          context.workspaceId,
          command.payload.relationshipId,
          true
        );
        if (relationship.spaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        const relationshipDecision = await this.authorize(tx, context, "relationship.end", {
          type: "relationship",
          id: relationship.id
        });
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const endpointAuthority = await this.authorizeRelationshipEndpoints(
          tx,
          context,
          relationship,
          reservationSpaceId,
          { type: "relationship", id: relationship.id }
        );
        if (relationship.version !== command.payload.expectedVersion || relationship.validTo)
          throw new B1CommandInvariantError();
        const authorityRequirements = spaceGrantRequirements([
          ...(relationshipDecision.evaluatedRelationships ?? []),
          ...endpointAuthority
        ]);
        const updated = await graph.endRelationship({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          relationshipId: relationship.id,
          expectedVersion: command.payload.expectedVersion,
          validTo: command.payload.validTo,
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId,
          authorityRequirements
        });
        if (!updated.authorized) throw new B1AuthorizationError();
        if (!updated.relationship) throw new B1CommandInvariantError();
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "relationship.end",
            "relationship",
            relationship.id,
            { relationshipId: relationship.id, validTo: command.payload.validTo }
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "relationship.ended",
            relationship.id,
            updated.relationship.version,
            { relationshipId: relationship.id, validTo: command.payload.validTo }
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = {
          relationshipId: relationship.id,
          version: updated.relationship.version,
          validTo: command.payload.validTo
        };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "relationship",
          relationship.id,
          result
        );
        return result;
      }
      case "content.create": {
        const space = await graph.getSpace(
          context.tenantId,
          context.workspaceId,
          command.payload.spaceId,
          true
        );
        if (space.id !== reservationSpaceId) throw new B1CommandInvariantError();
        await this.authorize(tx, context, "content.create", { type: "space", id: space.id });
        const ownerPersonId = command.payload.ownerPersonId ?? actor.displayPersonId;
        await graph.getSafePeople(context.tenantId, context.workspaceId, [ownerPersonId]);
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const contentItemId = generateUuidV7();
        await content.createContent({
          contentItemId,
          revisionId: generateUuidV7(),
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: reservationSpaceId,
          type: command.payload.type,
          title: command.payload.title,
          body: command.payload.body,
          ownerPersonId,
          accessClass: space.accessClass,
          metadata: command.payload.metadata ?? {},
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId
        });
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "content.create",
            "content_item",
            contentItemId,
            { contentItemId }
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "content.created",
            contentItemId,
            1,
            { contentItemId }
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = { contentItemId, revisionNumber: 1 as const, version: 1 as const };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "content_item",
          contentItemId,
          result
        );
        return result;
      }
      case "content.revise": {
        const item = await content.getContentItemScope(
          context.tenantId,
          context.workspaceId,
          command.payload.contentItemId,
          true
        );
        if (item.spaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        await this.authorize(tx, context, "content.revise", {
          type: "content_item",
          id: command.payload.contentItemId
        });
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        if (item.currentRevision !== command.payload.expectedRevision)
          throw new B1CommandInvariantError();
        const updated = await content.reviseContent({
          revisionId: generateUuidV7(),
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          contentItemId: command.payload.contentItemId,
          expectedRevision: command.payload.expectedRevision,
          ...(command.payload.title ? { title: command.payload.title } : {}),
          body: command.payload.body,
          ...(command.payload.metadata ? { metadata: command.payload.metadata } : {}),
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId
        });
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "content.revise",
            "content_item",
            command.payload.contentItemId,
            { contentItemId: command.payload.contentItemId, revisionNumber: updated.revisionNumber }
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "content.revised",
            command.payload.contentItemId,
            updated.version,
            { contentItemId: command.payload.contentItemId, revisionNumber: updated.revisionNumber }
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = {
          contentItemId: command.payload.contentItemId,
          revisionNumber: updated.revisionNumber,
          version: updated.version
        };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "content_item",
          command.payload.contentItemId,
          result
        );
        return result;
      }
      case "source.capture": {
        const activity = await graph.lockActivityForSourceCapture(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId,
          command.payload.activityId
        );
        if (activity.spaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        await this.authorize(
          tx,
          context,
          "source.capture",
          {
            type: "space",
            id: reservationSpaceId
          },
          command.payload.requestedAccessClass
            ? { requestedAccessClass: command.payload.requestedAccessClass }
            : undefined
        );
        const space = await graph.getSpace(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId
        );
        const pin = await graph.getWorkspaceProfilePin(context.tenantId, context.workspaceId);
        let originAccessClass: AccessClass | undefined;
        let sourceText = command.payload.text;
        if (command.payload.originContentItemId) {
          const origin = await readAuthorizedOriginRevision({
            authorization: this.authorization,
            content,
            tx,
            context,
            contentItemId: command.payload.originContentItemId,
            revisionNumber: command.payload.originContentRevision!,
            requiredSpaceId: reservationSpaceId,
            guessedText: command.payload.text
          });
          sourceText = origin.body;
          originAccessClass = origin.accessClass;
        }
        const accessClass = ContentRepository.deriveSourceAccessClass(
          space.accessClass,
          command.payload.requestedAccessClass,
          originAccessClass
        );
        if (!ContentRepository.canProjectSource(context.dataClassCeiling, accessClass))
          throw new B1AuthorizationError();
        const normalized = normalizeAndChunkSource(sourceText);
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const sourceArtifactId = generateUuidV7();
        await content.persistSource({
          sourceArtifactId,
          chunkIds: normalized.chunks.map(() => generateUuidV7()),
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: reservationSpaceId,
          sourceType: command.payload.sourceType,
          ...(command.payload.title ? { title: command.payload.title } : {}),
          source: normalized.source,
          chunks: normalized.chunks,
          capturedByUserId: actor.userId,
          capturedByMembershipId: actor.membershipId,
          accessClass,
          hashRetentionPolicy: ContentRepository.deriveHashRetentionPolicy(pin.retentionPolicyId),
          ...(pin.retentionPolicyId ? { retentionPolicyId: pin.retentionPolicyId } : {}),
          ...(command.payload.originContentItemId
            ? {
                originContentItemId: command.payload.originContentItemId,
                originContentRevision: command.payload.originContentRevision
              }
            : {}),
          ...(command.payload.occurredAt ? { occurredAt: command.payload.occurredAt } : {}),
          activityId: activity.id
        });
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "source_artifact.capture",
            "source_artifact",
            sourceArtifactId,
            { sourceArtifactId }
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "source_artifact.captured",
            sourceArtifactId,
            1,
            { sourceArtifactId }
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = {
          sourceArtifactId,
          activityId: activity.id,
          chunkCount: normalized.chunks.length,
          version: 1 as const
        };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "source_artifact",
          sourceArtifactId,
          result
        );
        return result;
      }
      case "source.correct": {
        const predecessorResource = {
          type: "source" as const,
          id: command.payload.predecessorSourceArtifactId
        };
        await this.authorize(tx, context, "source.read", predecessorResource, {
          lockAuthority: true
        });
        await this.authorize(tx, context, "source.correct", predecessorResource, {
          lockAuthority: true
        });
        const initialActivityLink = await content.resolveSourceActivityLinkForCorrection(
          context.tenantId,
          context.workspaceId,
          command.payload.predecessorSourceArtifactId
        );
        const activityId = command.payload.activityId ?? initialActivityLink.activityId;
        if (
          initialActivityLink.spaceId !== reservationSpaceId ||
          activityId !== initialActivityLink.activityId
        ) {
          throw new B1CommandInvariantError();
        }
        const activity = await graph.lockActivityForSourceCapture(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId,
          activityId
        );
        if (activity.spaceId !== reservationSpaceId) throw new B1CommandInvariantError();
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        const predecessor = await content.lockCurrentSourceForCorrection(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId,
          command.payload.predecessorSourceArtifactId
        );
        if (
          predecessor.id !== command.payload.predecessorSourceArtifactId ||
          predecessor.spaceId !== reservationSpaceId
        ) {
          throw new B1CommandInvariantError();
        }
        await content.revalidateSourceActivityLinkForCorrection({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          governingSpaceId: reservationSpaceId,
          activityId,
          sourceArtifactId: predecessor.id
        });
        const currentPredecessorResource = { type: "source" as const, id: predecessor.id };
        await this.authorize(tx, context, "source.read", currentPredecessorResource, {
          lockAuthority: true
        });
        await this.authorize(tx, context, "source.correct", currentPredecessorResource, {
          lockAuthority: true
        });
        const space = await graph.getSpace(
          context.tenantId,
          context.workspaceId,
          reservationSpaceId
        );
        const pin = await graph.getWorkspaceProfilePin(context.tenantId, context.workspaceId);
        const accessClass = ContentRepository.deriveSourceAccessClass(
          space.accessClass,
          command.payload.requestedAccessClass,
          predecessor.accessClass
        );
        if (!ContentRepository.canProjectSource(context.dataClassCeiling, accessClass))
          throw new B1AuthorizationError();
        const normalized = normalizeAndChunkSource(command.payload.text);
        const sourceArtifactId = generateUuidV7();
        await content.persistSource({
          sourceArtifactId,
          chunkIds: normalized.chunks.map(() => generateUuidV7()),
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          spaceId: reservationSpaceId,
          sourceType: command.payload.sourceType,
          ...(command.payload.title ? { title: command.payload.title } : {}),
          source: normalized.source,
          chunks: normalized.chunks,
          capturedByUserId: actor.userId,
          capturedByMembershipId: actor.membershipId,
          accessClass,
          hashRetentionPolicy: ContentRepository.deriveHashRetentionPolicy(pin.retentionPolicyId),
          ...(pin.retentionPolicyId ? { retentionPolicyId: pin.retentionPolicyId } : {}),
          supersedesSourceId: predecessor.id,
          ...(command.payload.occurredAt ? { occurredAt: command.payload.occurredAt } : {}),
          activityId
        });
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "source_artifact.correct",
            "source_artifact",
            sourceArtifactId,
            { sourceArtifactId, previousSourceArtifactId: predecessor.id }
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "source_artifact.corrected",
            sourceArtifactId,
            1,
            { sourceArtifactId, previousSourceArtifactId: predecessor.id }
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = {
          sourceArtifactId,
          previousSourceArtifactId: predecessor.id,
          chunkCount: normalized.chunks.length,
          version: 1 as const
        };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "source_artifact",
          sourceArtifactId,
          result
        );
        return result;
      }
      case "source.tombstone": {
        const sourceResource = {
          type: "source" as const,
          id: command.payload.sourceArtifactId
        };
        await this.authorize(tx, context, "source.read", sourceResource, {
          lockAuthority: true
        });
        await this.authorize(tx, context, "source.tombstone", sourceResource, {
          lockAuthority: true
        });
        const source = await content.lockSource(
          context.tenantId,
          context.workspaceId,
          command.payload.sourceArtifactId
        );
        if (
          source.id !== command.payload.sourceArtifactId ||
          source.spaceId !== reservationSpaceId
        ) {
          throw new B1CommandInvariantError();
        }
        const currentSourceResource = { type: "source" as const, id: source.id };
        await this.authorize(tx, context, "source.read", currentSourceResource, {
          lockAuthority: true
        });
        await this.authorize(tx, context, "source.tombstone", currentSourceResource, {
          lockAuthority: true
        });
        const reservation = await reserveCommand(
          domain.commands,
          command,
          context,
          requestHash,
          trace,
          reservationSpaceId
        );
        if (reservation.replay) return reservation.result;
        if (source.version !== command.payload.expectedVersion || source.deletedAt)
          throw new B1CommandInvariantError();
        const updated = await content.tombstoneSource({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          sourceArtifactId: source.id,
          expectedVersion: command.payload.expectedVersion,
          deletionReasonCategory: command.payload.deletionReasonCategory,
          deletionPolicyRef: command.payload.deletionPolicyRef
        });
        const relay = await relayPrincipalForSpace(tx, context, reservationSpaceId);
        const safe = {
          sourceArtifactId: source.id,
          deletionReasonCategory: command.payload.deletionReasonCategory,
          deletionPolicyRef: command.payload.deletionPolicyRef,
          hashDisposition: updated.hashDisposition
        };
        await domain.audit.insert(
          auditInput(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "source_artifact.tombstone",
            "source_artifact",
            source.id,
            safe
          )
        );
        await domain.outbox.insertOrReplay({
          envelope: notification(
            context,
            trace,
            reservation.commandId,
            reservationSpaceId,
            "source_artifact.tombstoned",
            source.id,
            updated.version,
            safe
          ),
          relayServicePrincipalId: relay,
          policyVersionId: context.policyVersion
        });
        const result = {
          sourceArtifactId: source.id,
          version: updated.version,
          hashDisposition: updated.hashDisposition
        };
        await completeCommand(
          domain.commands,
          command,
          context,
          requestHash,
          reservationSpaceId,
          reservation.commandId,
          "source_artifact",
          source.id,
          result
        );
        return result;
      }
    }
  }

  private async authorize(
    tx: TenantDbTransaction,
    context: SecurityContext,
    action: Parameters<TransactionAwareAuthorizationService["canInTransaction"]>[1],
    resource: ResourceRef,
    options?: Parameters<TransactionAwareAuthorizationService["canInTransaction"]>[4]
  ): Promise<Awaited<ReturnType<TransactionAwareAuthorizationService["canInTransaction"]>>> {
    const decision = await this.authorization.canInTransaction(
      context,
      action,
      resource,
      tx,
      options
    );
    if (!decision.allowed) throw new B1AuthorizationError();
    return decision;
  }

  private async authorizeRelationshipEndpoints(
    tx: TenantDbTransaction,
    context: SecurityContext,
    payload: {
      subject: RelationshipEndpoint;
      object: RelationshipEndpoint;
      context?: RelationshipEndpoint;
    },
    governingSpaceId: string,
    personUseSite?: ResourceRef
  ): Promise<string[]> {
    const useSite: ResourceRef =
      personUseSite ??
      (payload.context && payload.context.type !== "person"
        ? endpointResource(payload.context)
        : payload.subject.type !== "person"
          ? endpointResource(payload.subject)
          : payload.object.type !== "person"
            ? endpointResource(payload.object)
            : { type: "space", id: governingSpaceId });
    const endpoints = [
      payload.subject,
      payload.object,
      ...(payload.context ? [payload.context] : [])
    ]
      .filter(
        (endpoint, index, values) =>
          values.findIndex((candidate) => endpointKey(candidate) === endpointKey(endpoint)) ===
          index
      )
      .sort((left, right) => endpointKey(left).localeCompare(endpointKey(right)));
    const authorityTokens: string[] = [];
    for (const endpoint of endpoints) {
      let decision;
      if (endpoint.type === "space") {
        decision = await this.authorize(tx, context, "space.read", {
          type: "space",
          id: endpoint.id
        });
      } else if (endpoint.type === "person") {
        decision = await this.authorize(
          tx,
          context,
          "person.read",
          { type: "person", id: endpoint.id },
          { personUseSite: useSite }
        );
      } else {
        decision = await this.authorize(
          tx,
          context,
          `${endpoint.type}.read` as
            | "organization.read"
            | "initiative.read"
            | "activity.read"
            | "content.read",
          endpointResource(endpoint)
        );
      }
      authorityTokens.push(...(decision.evaluatedRelationships ?? []));
    }
    return authorityTokens;
  }
}

export function sourceTextMatchesRevisionBody(sourceText: string, revisionBody: string): boolean {
  if (sourceText !== revisionBody) return false;
  return Buffer.from(sourceText, "utf8").equals(Buffer.from(revisionBody, "utf8"));
}

export async function readAuthorizedOriginRevision(input: {
  authorization: TransactionAwareAuthorizationService;
  content: ContentRepository;
  tx: TenantDbTransaction;
  context: SecurityContext;
  contentItemId: string;
  revisionNumber: number;
  requiredSpaceId: string;
  guessedText: string;
}): Promise<{ body: string; accessClass: AccessClass }> {
  const decision = await input.authorization.canInTransaction(
    input.context,
    "content.read",
    { type: "content_item", id: input.contentItemId },
    input.tx,
    {
      contentRevision: input.revisionNumber,
      requiredSpaceId: input.requiredSpaceId,
      lockAuthority: true
    }
  );
  if (!decision.allowed) throw new B1AuthorizationError();
  const origin = await input.content.getContentRevisionScope(
    input.context.tenantId,
    input.context.workspaceId,
    input.contentItemId,
    input.revisionNumber
  );
  if (origin.spaceId !== input.requiredSpaceId) throw new B1AuthorizationError();
  const body = await input.content.getContentRevisionBody(
    input.context.tenantId,
    input.context.workspaceId,
    input.contentItemId,
    input.revisionNumber
  );
  if (!sourceTextMatchesRevisionBody(input.guessedText, body)) {
    throw new B1CommandInvariantError();
  }
  return { body, accessClass: origin.accessClass };
}

function spaceGrantRequirements(
  tokens: readonly string[]
): Array<{ grantId: string; resourceId: string }> {
  const requirements = new Map<string, { grantId: string; resourceId: string }>();
  for (const token of tokens) {
    const match = /^space_grant:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(token);
    if (!match) continue;
    const requirement = { grantId: match[1]!.toLowerCase(), resourceId: match[2]!.toLowerCase() };
    requirements.set(`${requirement.grantId}:${requirement.resourceId}`, requirement);
  }
  return [...requirements.values()].sort((left, right) =>
    `${left.resourceId}:${left.grantId}`.localeCompare(`${right.resourceId}:${right.grantId}`)
  );
}

async function reserveCommand(
  repository: DomainCommandRepository,
  command: ParsedCommand,
  context: SecurityContext,
  requestHash: string,
  trace: TraceCarrier,
  reservationSpaceId: string
): Promise<
  { replay: false; commandId: string } | { replay: true; result: B1CommandResultMap[B1CommandKind] }
> {
  const commandId = generateUuidV7();
  let reservation;
  try {
    reservation = await repository.reserve({
      id: commandId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      reservationSpaceId,
      commandKind: `${command.kind}.v1`,
      commandSchemaVersion: COMMAND_SCHEMA_VERSION,
      idempotencyKey: command.idempotencyKey,
      canonicalRequestHash: requestHash,
      actorUserId: context.actorUserId!,
      actorMembershipId: context.actorMembershipId!,
      ...(context.delegatedByUserId ? { delegatingUserId: context.delegatedByUserId } : {}),
      ...(context.delegatedByMembershipId
        ? { delegatingMembershipId: context.delegatedByMembershipId }
        : {}),
      policyVersionId: context.policyVersion,
      requestId: context.requestId,
      traceparent: trace.traceparent,
      ...(trace.tracestate ? { tracestate: trace.tracestate } : {})
    });
  } catch (error) {
    if (error instanceof ProductDomainInvariantError) throw new B1IdempotencyConflictError();
    throw error;
  }
  if (reservation.status === "replay") {
    return {
      replay: true,
      result: parseStoredB1Result(command.kind, reservation.command.safeResponse)
    };
  }
  if (reservation.commandId !== commandId) throw new B1CommandInvariantError();
  return { replay: false, commandId };
}

async function completeCommand(
  repository: DomainCommandRepository,
  command: ParsedCommand,
  context: SecurityContext,
  requestHash: string,
  reservationSpaceId: string,
  commandId: string,
  resourceType: string,
  resourceId: string,
  result: unknown
): Promise<void> {
  await repository.complete({
    commandId,
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    reservationSpaceId,
    commandKind: `${command.kind}.v1`,
    idempotencyKey: command.idempotencyKey,
    canonicalRequestHash: requestHash,
    resultResourceType: resourceType,
    resultResourceId: resourceId,
    safeResponse: result
  });
}

async function deriveRelationshipScope(
  _tx: TenantDbTransaction,
  graph: WorkGraphRepository,
  context: SecurityContext,
  payload: Extract<ParsedCommand, { kind: "relationship.create" }>["payload"]
): Promise<{ spaceId: string; accessClass: AccessClass }> {
  const endpoints = [
    payload.subject,
    payload.object,
    ...(payload.context ? [payload.context] : [])
  ];
  const resolved = new Map<string, Awaited<ReturnType<WorkGraphRepository["resolveEndpoint"]>>>();
  for (const endpoint of endpoints) {
    resolved.set(
      endpointKey(endpoint),
      await graph.resolveEndpoint(context.tenantId, context.workspaceId, endpoint)
    );
  }
  return deriveRelationshipGoverningSpace({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    subject: payload.subject,
    predicate: payload.predicate,
    object: payload.object,
    ...(payload.context ? { context: payload.context } : {}),
    ...(payload.validFrom ? { validFrom: payload.validFrom } : {}),
    resolve: (endpoint) => resolved.get(endpointKey(endpoint))
  });
}

function endpointKey(endpoint: RelationshipEndpoint): string {
  return `${endpoint.type}:${endpoint.id}`;
}

function endpointResource(endpoint: RelationshipEndpoint): ResourceRef {
  return { type: endpoint.type === "content" ? "content_item" : endpoint.type, id: endpoint.id };
}

function requireProfileInitiative(
  profile: AiSolutionsProfile,
  typeKey: string,
  stageKey: string
): void {
  if (
    !profile.initiativeTypes.some(({ key }) => key === typeKey) ||
    !profile.stagePipeline.some(({ key }) => key === stageKey)
  ) {
    throw new B1CommandInvariantError();
  }
}

async function assertApplicationRole(tx: TenantDbTransaction): Promise<void> {
  const role = await tx.query<{ current_user: string }>("SELECT current_user AS current_user");
  if (role.rows.length !== 1 || role.rows[0]?.current_user !== APP_ROLE)
    throw new B1AuthorizationError();
}

async function relayPrincipalForSpace(
  tx: TenantDbTransaction,
  context: SecurityContext,
  spaceId: string
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `SELECT principal.id
     FROM identity.service_principals principal
     JOIN access.access_relationships access
       ON access.tenant_id = principal.tenant_id AND access.workspace_id = principal.workspace_id
      AND access.subject_type = 'service_principal' AND access.subject_id = principal.id
      AND access.relation = 'manager' AND access.resource_type = 'space'
      AND access.resource_id = $3 AND access.source = 'direct'
     WHERE principal.tenant_id = $1 AND principal.workspace_id = $2
       AND principal.purpose = 'product_notification_relay' AND principal.status = 'active'
     ORDER BY principal.id LIMIT 2 FOR UPDATE OF principal, access`,
    [context.tenantId, context.workspaceId, spaceId]
  );
  if (result.rows.length !== 1) throw new B1CommandInvariantError();
  return result.rows[0]!.id;
}

interface TraceCarrier {
  traceparent: string;
  tracestate?: string;
}

function traceCarrier(context: SecurityContext): TraceCarrier {
  const requestedTrace =
    /^[0-9a-f]{32}$/i.test(context.traceId) && context.traceId !== "0".repeat(32)
      ? context.traceId.toLowerCase()
      : createHash("sha256").update(context.traceId).digest("hex").slice(0, 32);
  const span = createHash("sha256")
    .update(`${context.requestId}:${context.traceId}`)
    .digest("hex")
    .slice(0, 16);
  return {
    traceparent: `00-${requestedTrace}-${span === "0".repeat(16) ? "1".padStart(16, "0") : span}-01`
  };
}

function requireHumanActor(context: SecurityContext): {
  userId: string;
  membershipId: string;
  displayPersonId: string;
} {
  if (
    !context.actorUserId ||
    !context.actorMembershipId ||
    !context.actorDisplayPersonId ||
    context.servicePrincipalId ||
    context.agentPrincipalId
  ) {
    throw new B1AuthorizationError();
  }
  return {
    userId: context.actorUserId,
    membershipId: context.actorMembershipId,
    displayPersonId: context.actorDisplayPersonId
  };
}

function auditInput(
  context: SecurityContext,
  trace: TraceCarrier,
  commandId: string,
  spaceId: string,
  action: Parameters<ProductDomainTransactionRepositories["audit"]["insert"]>[0]["action"],
  resourceType: Parameters<
    ProductDomainTransactionRepositories["audit"]["insert"]
  >[0]["resourceType"],
  resourceId: string,
  safeDetail: Parameters<ProductDomainTransactionRepositories["audit"]["insert"]>[0]["safeDetail"]
): Parameters<ProductDomainTransactionRepositories["audit"]["insert"]>[0] {
  return {
    id: generateUuidV7(),
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    spaceId,
    causationCommandId: commandId,
    actorUserId: context.actorUserId!,
    actorMembershipId: context.actorMembershipId!,
    ...(context.delegatedByUserId ? { delegatingUserId: context.delegatedByUserId } : {}),
    ...(context.delegatedByMembershipId
      ? { delegatingMembershipId: context.delegatedByMembershipId }
      : {}),
    policyVersionId: context.policyVersion,
    requestId: context.requestId,
    traceparent: trace.traceparent,
    auditSchemaVersion: 1,
    action,
    resourceType,
    resourceId,
    safeDetail
  } as Parameters<ProductDomainTransactionRepositories["audit"]["insert"]>[0];
}

function notification(
  context: SecurityContext,
  trace: TraceCarrier,
  commandId: string,
  spaceId: string,
  eventType: DomainNotificationEventType,
  aggregateId: string,
  aggregateVersion: number,
  payload: Record<string, unknown>
): DomainNotificationEnvelope {
  const aggregateTypes = {
    "organization.created": "organization",
    "initiative.created": "initiative",
    "activity.created": "activity",
    "activity.capture_added": "activity",
    "relationship.created": "relationship",
    "relationship.ended": "relationship",
    "content.created": "content_item",
    "content.revised": "content_item",
    "source_artifact.captured": "source_artifact",
    "source_artifact.corrected": "source_artifact",
    "source_artifact.tombstoned": "source_artifact"
  } as const;
  return {
    eventId: generateUuidV7(),
    eventType,
    eventSchemaVersion: 1,
    payloadSchemaVersion: 1,
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    spaceId,
    aggregateType: aggregateTypes[eventType],
    aggregateId,
    aggregateVersion,
    causationCommandId: commandId,
    payload,
    requestId: context.requestId,
    traceparent: trace.traceparent
  } as DomainNotificationEnvelope;
}

function generateUuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
