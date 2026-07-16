import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPool, PgPoolClient } from "./client.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(packageRoot, "migrations");
const migrationLockName = "throughline:migrations";

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
}

export async function applyMigrations(
  pool: PgPool,
  options: { reset?: boolean; through?: string } = {}
): Promise<MigrationRunResult> {
  const client = await pool.connect();
  const result: MigrationRunResult = { applied: [], skipped: [] };
  let lockAcquired = false;

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockName]);
    lockAcquired = true;

    if (options.reset) {
      await client.query("BEGIN");
      try {
        await client.query("DROP SCHEMA IF EXISTS content CASCADE");
        await client.query("DROP SCHEMA IF EXISTS work CASCADE");
        await client.query("DROP SCHEMA IF EXISTS access CASCADE");
        await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
        await client.query("DROP SCHEMA IF EXISTS ops CASCADE");
        await client.query("DROP SCHEMA IF EXISTS throughline_migrations CASCADE");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    await ensureMigrationJournal(client);

    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql") && (!options.through || file <= options.through))
      .sort();

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const recorded = await client.query<{ checksum: string }>(
        "SELECT checksum FROM throughline_migrations.journal WHERE id = $1",
        [file]
      );

      if (recorded.rows[0]) {
        if (recorded.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for ${file}`);
        }

        result.skipped.push(file);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('throughline.migration_batch_applied', $1, true)", [
          result.applied.join(",")
        ]);
        await client.query(sql);
        await client.query(
          `
          INSERT INTO throughline_migrations.journal (id, checksum)
          VALUES ($1, $2)
          `,
          [file, checksum]
        );
        await client.query("COMMIT");
        result.applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return result;
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [migrationLockName]);
      }
    } finally {
      client.release();
    }
  }
}

async function ensureMigrationJournal(client: PgPoolClient): Promise<void> {
  await client.query("CREATE SCHEMA IF NOT EXISTS throughline_migrations");
  await client.query(`
    CREATE TABLE IF NOT EXISTS throughline_migrations.journal (
      id text PRIMARY KEY,
      checksum text NOT NULL CHECK (length(checksum) = 64),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}
