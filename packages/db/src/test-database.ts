import type { PgPool } from "./client.js";

const testAppRole = "throughline_app";

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
