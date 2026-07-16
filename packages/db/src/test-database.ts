import type { PgPool, PgPoolClient } from "./client.js";

const testAppRole = "throughline_app";
const testRelayRole = "throughline_relay";
const testWorkerRole = "throughline_worker";
const testProductRelayRole = "throughline_product_relay";

export async function provisionTestAppRole(
  ownerPool: PgPool,
  testAppDatabaseUrl: string
): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test app role provisioning is only available when NODE_ENV=test");
  }

  const appUrl = parseTestAppDatabaseUrl(testAppDatabaseUrl);
  const client = await ownerPool.connect();

  try {
    await client.query("BEGIN");

    if (appUrl.password) {
      await client.query("SELECT set_config('throughline.test_app_role_password', $1, true)", [
        appUrl.password
      ]);
      await client.query(`
        DO $bootstrap$
        BEGIN
          EXECUTE format(
            'ALTER ROLE throughline_app LOGIN NOBYPASSRLS PASSWORD %L',
            current_setting('throughline.test_app_role_password')
          );
        END
        $bootstrap$;
      `);
    } else {
      await client.query("ALTER ROLE throughline_app LOGIN NOBYPASSRLS PASSWORD NULL");
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function provisionTestFoundationRoles(
  ownerPool: PgPool,
  testRelayDatabaseUrl: string,
  testWorkerDatabaseUrl: string
): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test Foundation role provisioning is only available when NODE_ENV=test");
  }

  const relayUrl = parseTestRoleDatabaseUrl(testRelayDatabaseUrl, testRelayRole);
  const workerUrl = parseTestRoleDatabaseUrl(testWorkerDatabaseUrl, testWorkerRole);
  const client = await ownerPool.connect();

  try {
    await client.query("BEGIN");
    await provisionDisposableLogin(client, testRelayRole, relayUrl.password);
    await provisionDisposableLogin(client, testWorkerRole, workerUrl.password);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function provisionTestProductRelayRole(
  ownerPool: PgPool,
  testProductRelayDatabaseUrl: string
): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test product relay role provisioning is only available when NODE_ENV=test");
  }

  const relayUrl = parseTestRoleDatabaseUrl(testProductRelayDatabaseUrl, testProductRelayRole);
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await provisionDisposableLogin(client, testProductRelayRole, relayUrl.password);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parseTestAppDatabaseUrl(connectionString: string): {
  password: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_APP_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_APP_DATABASE_URL must use postgres:// or postgresql://");
  }

  const username = decodeURIComponent(url.username);
  if (username !== testAppRole) {
    throw new Error(`TEST_APP_DATABASE_URL must connect as ${testAppRole}`);
  }

  return { password: decodeURIComponent(url.password) };
}

function parseTestRoleDatabaseUrl(
  connectionString: string,
  expectedRole: string
): { password: string } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${expectedRole} test DSN must be a valid PostgreSQL URL`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${expectedRole} test DSN must use postgres:// or postgresql://`);
  }

  if (decodeURIComponent(url.username) !== expectedRole) {
    throw new Error(`${expectedRole} test DSN must connect as ${expectedRole}`);
  }

  return { password: decodeURIComponent(url.password) };
}

async function provisionDisposableLogin(
  client: PgPoolClient,
  role: string,
  password: string
): Promise<void> {
  await client.query("SELECT set_config('throughline.test_role_name', $1, true)", [role]);
  await client.query("SELECT set_config('throughline.test_role_password', $1, true)", [password]);
  await client.query(`
    DO $bootstrap$
    BEGIN
      EXECUTE format(
        'ALTER ROLE %I LOGIN NOBYPASSRLS PASSWORD %L',
        current_setting('throughline.test_role_name'),
        NULLIF(current_setting('throughline.test_role_password'), '')
      );
    END
    $bootstrap$;
  `);
}
