import { randomBytes } from "node:crypto";
import type { TenantDbTransaction } from "./transaction.js";

export const PRODUCT_NOTIFICATION_RELAY_PURPOSE = "product_notification_relay" as const;
export const PRODUCT_NOTIFICATION_RELAY_NAME = "Throughline Product Notification Relay" as const;

export interface ProductRelayPrincipalScope {
  tenantId: string;
  workspaceId: string;
}

export interface ProductRelaySpaceScope extends ProductRelayPrincipalScope {
  spaceId: string;
}

export async function provisionWorkspaceProductRelayPrincipal(
  tx: TenantDbTransaction,
  scope: ProductRelayPrincipalScope
): Promise<{ id: string; created: boolean }> {
  const workspace = await tx.query<{ id: string }>(
    `SELECT id FROM identity.workspaces
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [scope.tenantId, scope.workspaceId]
  );
  if (workspace.rows.length !== 1) throw provisioningError();

  const existing = await tx.query<{ id: string; status: string; name: string }>(
    `SELECT id, status, name FROM identity.service_principals
     WHERE tenant_id = $1 AND workspace_id = $2 AND purpose = 'product_notification_relay'
     LIMIT 1
     FOR UPDATE`,
    [scope.tenantId, scope.workspaceId]
  );
  const principal = existing.rows[0];
  if (principal) {
    if (principal.status !== "active" || principal.name !== PRODUCT_NOTIFICATION_RELAY_NAME) {
      throw provisioningError();
    }
    return { id: principal.id, created: false };
  }

  const id = generateUuidV7();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO identity.service_principals (
       id, tenant_id, workspace_id, name, purpose, status
     ) VALUES ($1, $2, $3, $4, 'product_notification_relay', 'active')
     RETURNING id`,
    [id, scope.tenantId, scope.workspaceId, PRODUCT_NOTIFICATION_RELAY_NAME]
  );
  if (inserted.rows.length !== 1) throw provisioningError();
  return { id: inserted.rows[0]!.id, created: true };
}

export async function provisionProductRelayDirectManagerAccess(
  tx: TenantDbTransaction,
  scope: ProductRelaySpaceScope
): Promise<{ id: string; principalId: string; created: boolean }> {
  const principal = await provisionWorkspaceProductRelayPrincipal(tx, scope);
  const lockedPrincipal = await tx.query<{ id: string }>(
    `SELECT id FROM identity.service_principals
     WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
       AND purpose = 'product_notification_relay' AND status = 'active'
     LIMIT 1
     FOR UPDATE`,
    [scope.tenantId, scope.workspaceId, principal.id]
  );
  if (lockedPrincipal.rows.length !== 1) throw provisioningError();

  const space = await tx.query<{ id: string }>(
    `SELECT id FROM access.spaces
     WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [scope.tenantId, scope.workspaceId, scope.spaceId]
  );
  if (space.rows.length !== 1) throw provisioningError();

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM access.access_relationships
     WHERE tenant_id = $1 AND workspace_id = $2
       AND subject_type = 'service_principal' AND subject_id = $3
       AND relation = 'manager' AND resource_type = 'space' AND resource_id = $4
       AND source = 'direct'
     LIMIT 2
     FOR UPDATE`,
    [scope.tenantId, scope.workspaceId, principal.id, scope.spaceId]
  );
  if (existing.rows.length > 1) throw provisioningError();
  if (existing.rows[0]) {
    return { id: existing.rows[0].id, principalId: principal.id, created: false };
  }

  const relationshipId = generateUuidV7();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO access.access_relationships (
       id, tenant_id, workspace_id, subject_type, subject_id,
       relation, resource_type, resource_id, source
     ) VALUES (
       $1, $2, $3, 'service_principal', $4,
       'manager', 'space', $5, 'direct'
     ) RETURNING id`,
    [relationshipId, scope.tenantId, scope.workspaceId, principal.id, scope.spaceId]
  );
  if (inserted.rows.length !== 1) throw provisioningError();
  return { id: inserted.rows[0]!.id, principalId: principal.id, created: true };
}

function generateUuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw provisioningError();
  }
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

function provisioningError(): Error {
  return new Error("Product notification relay provisioning invariant failed");
}
