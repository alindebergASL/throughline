/** Tenant, Workspace, and Space binding shared by Foundation async boundaries. */
export interface FoundationScope {
  tenantId: string;
  workspaceId: string;
  spaceId: string;
}

/**
 * Queue body contract for the Foundation proof path.
 *
 * `contextReference` is an opaque signed token. The editable SecurityContext and
 * product payloads do not belong in this envelope.
 */
export interface FoundationQueueEnvelope {
  version: "v1";
  eventId: string;
  jobId: string;
  scope: FoundationScope;
  contextReference: string;
  requestId: string;
  traceparent: string;
  tracestate?: string;
}
