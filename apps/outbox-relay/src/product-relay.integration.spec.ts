import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  type Message
} from "@aws-sdk/client-sqs";
import { PostgresAuthorizationService } from "@throughline/authorization";
import type { DomainNotificationEnvelope, SecurityContext } from "@throughline/core-types";
import {
  ProductDomainTransactionRepositories,
  ProductOutboxRepository,
  ProductRelayAuthorizationError,
  ProductRelayClaimRejectedError,
  applyMigrations,
  createPgPool,
  hashCanonicalCommandRequest,
  provisionProductRelayDirectManagerAccess,
  provisionTestAppRole,
  provisionTestProductRelayRole,
  seedWaveA2DeterministicData,
  withTenantTransaction,
  type ProductOutboxClaimHandle,
  type PgPool,
  type TenantDbTransaction
} from "@throughline/db";
import { createDevSecurityContext, devFixtures, DEV_POLICY_VERSION } from "@throughline/tenancy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ProductSqsPublisher,
  createProductSendMessageInput,
  type ProductSqsClient,
  type ProductSqsCommandFactory
} from "./product-relay.js";

const required = [
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "TEST_PRODUCT_RELAY_DATABASE_URL",
  "PRODUCT_SQS_ENDPOINT",
  "PRODUCT_SQS_QUEUE_URL",
  "PRODUCT_SQS_QUEUE_NAME",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY"
] as const;
const authoritative = process.env.B1_0_AUTHORITATIVE_GATE === "1";
const configured = required.every((name) => Boolean(process.env[name]));
const maybeDescribe = configured || authoritative ? describe.sequential : describe.skip;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

maybeDescribe("B1.0 real PostgreSQL and LocalStack product relay", () => {
  let ownerPool!: PgPool;
  let appPool!: PgPool;
  let productRelayPool!: PgPool;
  let sqs!: SQSClient;
  const queueUrl = process.env.PRODUCT_SQS_QUEUE_URL ?? "";
  const commands: ProductSqsCommandFactory = {
    sendMessage: (input) => new SendMessageCommand(input),
    getQueueAttributes: (input) =>
      new GetQueueAttributesCommand({
        QueueUrl: input.QueueUrl,
        AttributeNames: [...input.AttributeNames]
      })
  };
  let productRelayPrincipalId: string;
  let authorization: PostgresAuthorizationService;
  let repository: ProductOutboxRepository;
  let publisher: ProductSqsPublisher;

  beforeAll(async () => {
    if (!configured) throw new Error("Authoritative B1.0 service configuration is missing");
    ownerPool = createPgPool(process.env.TEST_DATABASE_URL!);
    appPool = createPgPool(process.env.TEST_APP_DATABASE_URL!);
    productRelayPool = createPgPool(process.env.TEST_PRODUCT_RELAY_DATABASE_URL!);
    sqs = new SQSClient({
      endpoint: process.env.PRODUCT_SQS_ENDPOINT!,
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      }
    });
    await applyMigrations(ownerPool, { reset: true });
    await provisionTestAppRole(ownerPool, process.env.TEST_APP_DATABASE_URL!);
    await provisionTestProductRelayRole(ownerPool, process.env.TEST_PRODUCT_RELAY_DATABASE_URL!);
    await seedWaveA2DeterministicData(ownerPool);
    const provisioned = await withOwnerTransaction(ownerPool, (tx) =>
      provisionProductRelayDirectManagerAccess(tx, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA
      })
    );
    productRelayPrincipalId = provisioned.principalId;
    authorization = new PostgresAuthorizationService(productRelayPool);
    repository = new ProductOutboxRepository(productRelayPool, authorization);
    publisher = new ProductSqsPublisher(sqs as ProductSqsClient, queueUrl, commands, 2_000);
  });

  afterAll(async () => {
    sqs?.destroy();
    await productRelayPool?.end();
    await appPool?.end();
    await ownerPool?.end();
  });

  it("observes the exact Standard queue retention and absence of redrive/FIFO configuration", async () => {
    await expect(publisher.verifyQueueContract()).resolves.toBeUndefined();
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["MessageRetentionPeriod", "RedrivePolicy", "FifoQueue"]
      })
    );
    expect(attributes.Attributes?.MessageRetentionPeriod).toBe("86400");
    expect(attributes.Attributes).not.toHaveProperty("RedrivePolicy");
    expect(attributes.Attributes?.FifoQueue).not.toBe("true");
  });

  it("round-trips fresh millisecond claim bindings through publish and failure recording", async () => {
    const publishEvent = await createPendingEvent(3);
    const publishHandle = await claim(publishEvent);
    await expectClaimTimestampsAtMillisecondPrecision(publishHandle);
    await expect(
      repository.publishClaimed(publishHandle, {
        publish: async () => ({ messageId: "millisecond-fresh-publish" })
      })
    ).resolves.toMatchObject({ status: "published", eventId: publishEvent.eventId });

    const failureEvent = await createAttemptFiveEvent(4);
    const failureHandle = await claim(failureEvent);
    expect(failureHandle.publicationAttempt).toBe(6);
    await expectClaimTimestampsAtMillisecondPrecision(failureHandle);
    await expect(
      repository.recordFailure(failureHandle, {
        kind: "deterministic",
        code: "millisecond_fresh_failure"
      })
    ).resolves.toBe("terminal_failed");

    const settled = await ownerPool.query<{ id: string; publication_state: string }>(
      `SELECT id, publication_state
       FROM ops.product_outbox_events
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[publishEvent.eventId, failureEvent.eventId]]
    );
    expect(Object.fromEntries(settled.rows.map((row) => [row.id, row.publication_state]))).toEqual({
      [publishEvent.eventId]: "published",
      [failureEvent.eventId]: "terminal_failed"
    });
    expect(
      settled.rows.some((row) =>
        ["pending", "retry_wait", "claimed"].includes(row.publication_state)
      )
    ).toBe(false);
  });

  it("binds claim handles to server ownership, owner/token/attempt/expiry/policy and exact row", async () => {
    const event = await createPendingEvent(1);
    const handle = await claim(event);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.envelope)).toBe(true);
    expect(handle.publicationAttempt).toBe(1);

    for (const forged of [
      { ...handle, claimedBy: "wrong-owner" },
      { ...handle, claimToken: "A".repeat(43) },
      { ...handle, publicationAttempt: 2 },
      { ...handle, policyVersionId: "wrong-policy" },
      { ...handle, eventId: uuid7("999") }
    ]) {
      await expect(
        repository.publishClaimed(forged as ProductOutboxClaimHandle, {
          publish: vi.fn(async () => ({ messageId: "must-not-send" }))
        })
      ).rejects.toBeInstanceOf(ProductRelayClaimRejectedError);
    }
    const otherRelayInstance = new ProductOutboxRepository(productRelayPool, authorization);
    const crossInstanceSend = vi.fn(async () => ({ messageId: "must-not-send" }));
    await expect(
      otherRelayInstance.publishClaimed(handle, { publish: crossInstanceSend })
    ).rejects.toBeInstanceOf(ProductRelayClaimRejectedError);
    expect(crossInstanceSend).not.toHaveBeenCalled();

    const noPolicy = await repository.claimNext(
      { ...scope(), policyVersionId: "wrong-policy" },
      { claimedBy: "relay-test", leaseSeconds: 5 }
    );
    expect(noPolicy).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 5_050));
    const send = vi.fn(async () => ({ messageId: "must-not-send" }));
    await expect(repository.publishClaimed(handle, { publish: send })).rejects.toBeInstanceOf(
      ProductRelayClaimRejectedError
    );
    expect(send).not.toHaveBeenCalled();
    const reclaimed = await repository.claimNext(scope(), {
      claimedBy: "relay-test-reclaim",
      leaseSeconds: 5
    });
    expect(reclaimed?.eventId).toBe(event.eventId);
    await expect(
      repository.publishClaimed(reclaimed!, {
        publish: async () => ({ messageId: "expiry-reclaim-ack" })
      })
    ).resolves.toMatchObject({ status: "published" });
  }, 15_000);

  it("rejects a replayed stale handle after a later publication attempt owns the row", async () => {
    const event = await createPendingEvent(2);
    const first = await claim(event);
    await expect(
      repository.recordFailure(first, { kind: "ambiguous", code: "first_attempt_unknown" })
    ).resolves.toBe("retry_wait");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const second = await claim(event);
    const staleSend = vi.fn(async () => ({ messageId: "must-not-send" }));
    await expect(repository.publishClaimed(first, { publish: staleSend })).rejects.toBeInstanceOf(
      ProductRelayClaimRejectedError
    );
    expect(staleSend).not.toHaveBeenCalled();
    await expect(
      repository.publishClaimed(second, {
        publish: async () => ({ messageId: "second-attempt-ack" })
      })
    ).resolves.toMatchObject({ status: "published" });
  });

  it("rejects every authority revocation before publish with zero broker sends", async () => {
    const revocations: Array<{
      revoke: () => Promise<unknown>;
      restore: () => Promise<unknown>;
    }> = [
      {
        revoke: () =>
          ownerPool.query("UPDATE identity.tenants SET status = 'suspended' WHERE id = $1", [
            devFixtures.tenantA
          ]),
        restore: () =>
          ownerPool.query("UPDATE identity.tenants SET status = 'active' WHERE id = $1", [
            devFixtures.tenantA
          ])
      },
      {
        revoke: () =>
          ownerPool.query("UPDATE identity.workspaces SET status = 'archived' WHERE id = $1", [
            devFixtures.workspaceA
          ]),
        restore: () =>
          ownerPool.query("UPDATE identity.workspaces SET status = 'active' WHERE id = $1", [
            devFixtures.workspaceA
          ])
      },
      {
        revoke: () =>
          ownerPool.query(
            "UPDATE identity.policy_versions SET status = 'retired' WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
            [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
          ),
        restore: () =>
          ownerPool.query(
            "UPDATE identity.policy_versions SET status = 'active' WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
            [devFixtures.tenantA, devFixtures.workspaceA, DEV_POLICY_VERSION]
          )
      },
      {
        revoke: () =>
          ownerPool.query(
            "UPDATE identity.service_principals SET status = 'disabled' WHERE id = $1",
            [productRelayPrincipalId]
          ),
        restore: () =>
          ownerPool.query(
            "UPDATE identity.service_principals SET status = 'active' WHERE id = $1",
            [productRelayPrincipalId]
          )
      },
      {
        revoke: () =>
          ownerPool.query(
            "UPDATE access.spaces SET archived_at = clock_timestamp() WHERE id = $1",
            [devFixtures.restrictedSpaceA]
          ),
        restore: () =>
          ownerPool.query("UPDATE access.spaces SET archived_at = NULL WHERE id = $1", [
            devFixtures.restrictedSpaceA
          ])
      },
      {
        revoke: deleteDirectManagerGrant,
        restore: restoreDirectManagerGrant
      }
    ];

    for (const [index, revocation] of revocations.entries()) {
      const event = await createPendingEvent(10 + index);
      const handle = await claim(event);
      await revocation.revoke();
      const send = vi.fn(async () => ({ messageId: "must-not-send" }));
      try {
        await expect(repository.publishClaimed(handle, { publish: send })).rejects.toBeInstanceOf(
          ProductRelayAuthorizationError
        );
        expect(send).not.toHaveBeenCalled();
      } finally {
        await revocation.restore();
      }
      await expect(
        repository.publishClaimed(handle, {
          publish: async () => ({ messageId: `revocation-restored-${index}` })
        })
      ).resolves.toMatchObject({ status: "published" });
    }
  });

  it("holds all authority locks across send and marker commit, blocking revocation", async () => {
    const event = await createPendingEvent(30);
    const handle = await claim(event);
    let revocationSettled = false;
    let revocation: Promise<unknown> | undefined;
    const result = await repository.publishClaimed(handle, {
      publish: async () => {
        revocation = deleteDirectManagerGrant().finally(() => {
          revocationSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(revocationSettled).toBe(false);
        return { messageId: "locked-publication-ack" };
      }
    });
    expect(result).toMatchObject({ status: "published", eventId: event.eventId });
    await revocation;
    expect(revocationSettled).toBe(true);
    await restoreDirectManagerGrant();
  });

  it("releases relay and authority locks on timeout/rollback", async () => {
    const event = await createPendingEvent(31);
    const handle = await claim(event);
    let revocationSettled = false;
    let revocation: Promise<unknown> | undefined;
    const abortingClient: ProductSqsClient = {
      send: (_command, options) => {
        revocation = deleteDirectManagerGrant().finally(() => {
          revocationSettled = true;
        });
        return new Promise((_, reject) => {
          options?.abortSignal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("sanitized timeout"), { name: "AbortError" }))
          );
        });
      }
    };
    const timeoutPublisher = new ProductSqsPublisher(abortingClient, queueUrl, commands, 50);
    await expect(repository.publishClaimed(handle, timeoutPublisher)).rejects.toBeDefined();
    await revocation;
    expect(revocationSettled).toBe(true);
    await restoreDirectManagerGrant();
    await expect(
      repository.recordFailure(handle, { kind: "ambiguous", code: "timeout_error" })
    ).resolves.toBe("retry_wait");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const retry = await repository.claimNext(scope(), {
      claimedBy: "relay-timeout-retry",
      leaseSeconds: 5
    });
    expect(retry?.eventId).toBe(event.eventId);
    await repository.publishClaimed(retry!, {
      publish: async () => ({ messageId: "timeout-retry-ack" })
    });
  });

  it("uses one global authority lock order without deadlock under concurrent publishes", async () => {
    const first = await claim(await createPendingEvent(32));
    const second = await claim(await createPendingEvent(33));
    const slowPublisher = {
      publish: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { messageId: `concurrent-${cryptoRandomSuffix()}` };
      }
    };
    const results = Promise.all([
      repository.publishClaimed(first, slowPublisher),
      repository.publishClaimed(second, slowPublisher)
    ]);
    await expect(withDeadline(results, 2_000)).resolves.toHaveLength(2);
  });

  it("exhausts deterministic and ambiguous attempt six into distinct terminal states", async () => {
    const deterministic = await createAttemptFiveEvent(40);
    const ambiguous = await createAttemptFiveEvent(41);
    const deterministicHandle = await claim(deterministic);
    const ambiguousHandle = await claim(ambiguous);
    expect(deterministicHandle.publicationAttempt).toBe(6);
    expect(ambiguousHandle.publicationAttempt).toBe(6);
    await expect(
      repository.recordFailure(deterministicHandle, {
        kind: "deterministic",
        code: "invalid_message_contents"
      })
    ).resolves.toBe("terminal_failed");
    await expect(
      repository.recordFailure(ambiguousHandle, {
        kind: "ambiguous",
        code: "timeout_error"
      })
    ).resolves.toBe("terminal_unconfirmed");
    const rows = await ownerPool.query<{
      id: string;
      publication_state: string;
      published_at: Date | null;
      published_message_id: string | null;
    }>(
      `
      SELECT id, publication_state, published_at, published_message_id
      FROM ops.product_outbox_events WHERE id IN ($1, $2) ORDER BY id
    `,
      [deterministic.eventId, ambiguous.eventId]
    );
    expect(rows.rows).toEqual([
      {
        id: deterministic.eventId,
        publication_state: "terminal_failed",
        published_at: null,
        published_message_id: null
      },
      {
        id: ambiguous.eventId,
        publication_state: "terminal_unconfirmed",
        published_at: null,
        published_message_id: null
      }
    ]);
  });

  it("retries an accepted send after marker rollback with the identical eventId/envelope", async () => {
    const event = await createPendingEvent(50);
    const firstHandle = await claim(event);
    await ownerPool.query(`
      CREATE OR REPLACE FUNCTION ops.b1_0_test_reject_product_marker()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.id = '${event.eventId}'::uuid AND NEW.publication_state = 'published' THEN
          RAISE EXCEPTION 'test-only marker rollback';
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER b1_0_test_reject_product_marker
      BEFORE UPDATE ON ops.product_outbox_events
      FOR EACH ROW EXECUTE FUNCTION ops.b1_0_test_reject_product_marker();
    `);

    const first = await repository.publishClaimed(firstHandle, publisher);
    expect(first.status).toBe("unresolved");
    const afterRollback = await ownerPool.query<{
      publication_state: string;
      published_at: Date | null;
    }>("SELECT publication_state, published_at FROM ops.product_outbox_events WHERE id = $1", [
      event.eventId
    ]);
    expect(afterRollback.rows[0]).toEqual({ publication_state: "claimed", published_at: null });
    await expect(
      repository.recordFailure(firstHandle, {
        kind: "ambiguous",
        code: "accepted_marker_unresolved"
      })
    ).resolves.toBe("retry_wait");

    await ownerPool.query(
      "DROP TRIGGER b1_0_test_reject_product_marker ON ops.product_outbox_events"
    );
    await ownerPool.query("DROP FUNCTION ops.b1_0_test_reject_product_marker()");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const secondHandle = await claim(event);
    const second = await repository.publishClaimed(secondHandle, publisher);
    expect(second.status).toBe("published");

    const observed = await observeTestMessages(4);
    const duplicates = observed.filter(
      (message) => message.MessageAttributes?.event_id?.StringValue === event.eventId
    );
    expect(duplicates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(duplicates.map(({ Body }) => Body))).toEqual(
      new Set([createProductSendMessageInput(queueUrl, event.envelope).MessageBody])
    );
    expect(new Set(duplicates.map(({ MessageId }) => MessageId)).size).toBeGreaterThanOrEqual(2);
    const marker = await ownerPool.query<{
      publication_state: string;
      publication_attempt: number;
      published_at: Date | null;
      published_message_id: string | null;
    }>(
      `
      SELECT publication_state, publication_attempt, published_at, published_message_id
      FROM ops.product_outbox_events WHERE id = $1
    `,
      [event.eventId]
    );
    expect(marker.rows[0]).toMatchObject({
      publication_state: "published",
      publication_attempt: 2,
      published_message_id: second.messageId
    });
    expect(marker.rows[0]?.published_at).toBeInstanceOf(Date);
    expect(marker.rows[0]?.published_message_id).not.toBe(event.eventId);
    const effects = await ownerPool.query<{
      organizations: string | null;
      activities: string | null;
      content_items: string | null;
      domain_events: string | null;
    }>(`
      SELECT
        to_regclass('work.organizations')::text AS organizations,
        to_regclass('work.activities')::text AS activities,
        to_regclass('content.content_items')::text AS content_items,
        to_regclass('ops.domain_events')::text AS domain_events
    `);
    expect(effects.rows[0]).toEqual({
      organizations: null,
      activities: null,
      content_items: null,
      domain_events: null
    });
  }, 15_000);

  async function createPendingEvent(sequence: number) {
    const fixture = fixtureFor(sequence);
    await withTenantTransaction({ pool: appPool, context: appContext() }, async (tx) => {
      const repositories = new ProductDomainTransactionRepositories(tx);
      await repositories.commands.reserve(fixture.reservation);
      await repositories.audit.insert(fixture.audit);
      await repositories.outbox.insertOrReplay({
        envelope: fixture.envelope,
        relayServicePrincipalId: productRelayPrincipalId,
        policyVersionId: DEV_POLICY_VERSION
      });
      await repositories.commands.complete(fixture.completion);
    });
    return fixture;
  }

  async function createAttemptFiveEvent(sequence: number) {
    const fixture = fixtureFor(sequence);
    await withTenantTransaction({ pool: appPool, context: appContext() }, async (tx) => {
      const repositories = new ProductDomainTransactionRepositories(tx);
      await repositories.commands.reserve(fixture.reservation);
      await repositories.audit.insert(fixture.audit);
      await repositories.commands.complete(fixture.completion);
      await tx.query(
        `INSERT INTO ops.product_outbox_events (
             id, tenant_id, workspace_id, space_id, relay_service_principal_id, policy_version_id,
             event_type, event_schema_version, payload_schema_version, aggregate_type, aggregate_id,
             aggregate_version, causation_command_id, payload, request_id, traceparent,
             publication_state, publication_attempt, next_attempt_at, last_outcome_code
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             'organization.created', 1, 1, 'organization', $7,
             1, $8, $9::jsonb, $10, $11,
             'retry_wait', 5, clock_timestamp() - interval '1 second', 'prior_retry'
           )`,
        [
          fixture.eventId,
          devFixtures.tenantA,
          devFixtures.workspaceA,
          devFixtures.restrictedSpaceA,
          productRelayPrincipalId,
          DEV_POLICY_VERSION,
          fixture.aggregateId,
          fixture.commandId,
          JSON.stringify(fixture.envelope.payload),
          fixture.envelope.requestId,
          traceparent
        ]
      );
    });
    return fixture;
  }

  async function claim(event: ReturnType<typeof fixtureFor>): Promise<ProductOutboxClaimHandle> {
    const handle = await repository.claimNext(scope(), {
      claimedBy: "relay-test",
      leaseSeconds: 5
    });
    if (!handle || handle.eventId !== event.eventId) {
      throw new Error("Expected exact product event was not claimable");
    }
    return handle;
  }

  async function expectClaimTimestampsAtMillisecondPrecision(
    handle: ProductOutboxClaimHandle
  ): Promise<void> {
    const persisted = await ownerPool.query<{
      claimed_submillisecond: number;
      expires_submillisecond: number;
    }>(
      `SELECT
         (extract(microseconds FROM claimed_at)::bigint % 1000)::integer
           AS claimed_submillisecond,
         (extract(microseconds FROM claim_expires_at)::bigint % 1000)::integer
           AS expires_submillisecond
       FROM ops.product_outbox_events
       WHERE id = $1`,
      [handle.eventId]
    );
    expect(persisted.rows[0]).toEqual({
      claimed_submillisecond: 0,
      expires_submillisecond: 0
    });
  }

  function fixtureFor(sequence: number) {
    const commandId = uuid7(String(1000 + sequence));
    const eventId = uuid7(String(2000 + sequence));
    const aggregateId = uuid7(String(3000 + sequence));
    const auditId = uuid7(String(4000 + sequence));
    const requestHash = hashCanonicalCommandRequest({ sequence, aggregateId });
    const envelope: DomainNotificationEnvelope = {
      eventId,
      eventType: "organization.created",
      eventSchemaVersion: 1,
      payloadSchemaVersion: 1,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.restrictedSpaceA,
      aggregateType: "organization",
      aggregateId,
      aggregateVersion: 1,
      causationCommandId: commandId,
      payload: { organizationId: aggregateId },
      requestId: `product-relay-${sequence}`,
      traceparent
    };
    const reservation = {
      id: commandId,
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      reservationSpaceId: devFixtures.restrictedSpaceA,
      commandKind: "b1_0.fixture.v1",
      commandSchemaVersion: 1,
      idempotencyKey: `product-relay-${sequence}`,
      canonicalRequestHash: requestHash,
      actorUserId: devFixtures.userA,
      actorMembershipId: devFixtures.membershipAOwner,
      policyVersionId: DEV_POLICY_VERSION,
      requestId: envelope.requestId,
      traceparent
    };
    return {
      commandId,
      eventId,
      aggregateId,
      envelope,
      reservation,
      audit: {
        id: auditId,
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA,
        causationCommandId: commandId,
        action: "organization.create" as const,
        resourceType: "organization" as const,
        resourceId: aggregateId,
        actorUserId: devFixtures.userA,
        actorMembershipId: devFixtures.membershipAOwner,
        policyVersionId: DEV_POLICY_VERSION,
        requestId: envelope.requestId,
        traceparent,
        auditSchemaVersion: 1,
        safeDetail: { organizationId: aggregateId }
      },
      completion: {
        commandId,
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        reservationSpaceId: devFixtures.restrictedSpaceA,
        commandKind: reservation.commandKind,
        idempotencyKey: reservation.idempotencyKey,
        canonicalRequestHash: requestHash,
        resultResourceType: "organization",
        resultResourceId: aggregateId,
        safeResponse: { organizationId: aggregateId }
      }
    };
  }

  function scope() {
    return {
      tenantId: devFixtures.tenantA,
      workspaceId: devFixtures.workspaceA,
      spaceId: devFixtures.restrictedSpaceA,
      relayServicePrincipalId: productRelayPrincipalId,
      policyVersionId: DEV_POLICY_VERSION
    };
  }

  function appContext(): SecurityContext {
    return {
      ...createDevSecurityContext("tenant-a-owner"),
      requestedSpaceIds: [devFixtures.restrictedSpaceA]
    };
  }

  function deleteDirectManagerGrant(): Promise<unknown> {
    return ownerPool.query(
      `DELETE FROM access.access_relationships
       WHERE tenant_id = $1 AND workspace_id = $2
         AND subject_type = 'service_principal' AND subject_id = $3
         AND relation = 'manager' AND resource_type = 'space' AND resource_id = $4
         AND source = 'direct'`,
      [
        devFixtures.tenantA,
        devFixtures.workspaceA,
        productRelayPrincipalId,
        devFixtures.restrictedSpaceA
      ]
    );
  }

  async function restoreDirectManagerGrant(): Promise<unknown> {
    return withOwnerTransaction(ownerPool, (tx) =>
      provisionProductRelayDirectManagerAccess(tx, {
        tenantId: devFixtures.tenantA,
        workspaceId: devFixtures.workspaceA,
        spaceId: devFixtures.restrictedSpaceA
      })
    );
  }

  async function observeTestMessages(maxPolls: number) {
    const messages: Message[] = [];
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const observed = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ["All"]
        })
      );
      messages.push(...(observed.Messages ?? []));
      if (messages.length >= 2) break;
    }
    return messages;
  }
});

function uuid7(decimalSuffix: string): string {
  return `76000000-0000-7000-8000-${decimalSuffix.padStart(12, "0")}`;
}

function cryptoRandomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("B1.0 deadlock deadline exceeded")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function withOwnerTransaction<T>(
  pool: PgPool,
  operation: (tx: TenantDbTransaction) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx: TenantDbTransaction = {
      client,
      query: (text, values) => client.query(text, values ? [...values] : undefined)
    };
    const result = await operation(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
