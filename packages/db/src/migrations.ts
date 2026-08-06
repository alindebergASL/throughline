import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPool, PgPoolClient } from "./client.js";
import {
  assertB1MigrationStateAbsent,
  B1_MIGRATION_IDS,
  validateB1CatalogContract,
  validateMigrationJournal
} from "./b1-catalog-contract.js";
import {
  assertB2MigrationStateAbsent,
  B2_MIGRATION_IDS,
  validateB2CatalogContract
} from "./b2-catalog-contract.js";

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
        await client.query("DROP SCHEMA IF EXISTS truth CASCADE");
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

    const allFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const migrationSources = new Map<string, string>();
    const migrationChecksums = new Map<string, string>();
    for (const file of allFiles) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      migrationSources.set(file, sql);
      migrationChecksums.set(file, createHash("sha256").update(sql).digest("hex"));
    }
    const journal = await validateMigrationJournal(client, migrationChecksums);
    const files = allFiles.filter((file) => !options.through || file <= options.through);
    const firstUnrecordedProductMigration = files.find(
      (file) =>
        !journal.has(file) &&
        (B1_MIGRATION_IDS.includes(file as (typeof B1_MIGRATION_IDS)[number]) ||
          B2_MIGRATION_IDS.includes(file as (typeof B2_MIGRATION_IDS)[number]))
    );
    if (firstUnrecordedProductMigration) {
      await client.query("BEGIN");
      try {
        if (
          B1_MIGRATION_IDS.includes(
            firstUnrecordedProductMigration as (typeof B1_MIGRATION_IDS)[number]
          )
        ) {
          await assertB1MigrationStateAbsent(
            client,
            firstUnrecordedProductMigration as (typeof B1_MIGRATION_IDS)[number]
          );
        } else {
          await assertB2MigrationStateAbsent(
            client,
            firstUnrecordedProductMigration as (typeof B2_MIGRATION_IDS)[number]
          );
        }
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    for (const file of files) {
      const sql = migrationSources.get(file)!;
      const checksum = migrationChecksums.get(file)!;
      const recordedChecksum = journal.get(file);
      const isB1Migration = B1_MIGRATION_IDS.includes(file as (typeof B1_MIGRATION_IDS)[number]);
      const isB2Migration = B2_MIGRATION_IDS.includes(file as (typeof B2_MIGRATION_IDS)[number]);

      if (recordedChecksum) {
        if (isB1Migration || isB2Migration) {
          await client.query("BEGIN");
          try {
            await validateInstalledProductCatalog(client, journal, migrationSources);
            await client.query("ROLLBACK");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        result.skipped.push(file);
        continue;
      }

      await client.query("BEGIN");
      try {
        if (isB1Migration) {
          await assertB1MigrationStateAbsent(client, file as (typeof B1_MIGRATION_IDS)[number]);
        } else if (isB2Migration) {
          await assertB2MigrationStateAbsent(client, file as (typeof B2_MIGRATION_IDS)[number]);
        }
        if (isB1Migration || isB2Migration) {
          await validateInstalledProductCatalog(client, journal, migrationSources);
        }
        await client.query("SELECT set_config('throughline.migration_batch_applied', $1, true)", [
          result.applied.join(",")
        ]);
        await client.query(sql);
        if (isB1Migration || isB2Migration) {
          const nextJournal = new Map(journal);
          nextJournal.set(file, checksum);
          await validateInstalledProductCatalog(client, nextJournal, migrationSources);
        }
        await client.query(
          `
          INSERT INTO throughline_migrations.journal (id, checksum)
          VALUES ($1, $2)
          `,
          [file, checksum]
        );
        await client.query("COMMIT");
        journal.set(file, checksum);
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

async function validateInstalledProductCatalog(
  client: PgPoolClient,
  journal: ReadonlyMap<string, string>,
  migrationSources: ReadonlyMap<string, string>
): Promise<void> {
  const b2Phase = B2_MIGRATION_IDS.filter((id) => journal.has(id)).length;
  switch (b2Phase) {
    case 0:
      await validateB1CatalogContract(client, journal, migrationSources);
      return;
    case 1:
      await validateB1CatalogContract(client, journal, migrationSources, {
        additiveB2Phase: 1
      });
      await validateB2CatalogContract(client, journal, migrationSources);
      return;
    case 2:
      await validateB1CatalogContract(client, journal, migrationSources, {
        additiveB2Phase: 2
      });
      await validateB2CatalogContract(client, journal, migrationSources);
      return;
    case 3:
      await validateB1CatalogContract(client, journal, migrationSources, {
        additiveB2Phase: 3
      });
      await validateB2CatalogContract(client, journal, migrationSources);
      return;
    case 4:
      await validateB1CatalogContract(client, journal, migrationSources, {
        additiveB2Phase: 4
      });
      await validateB2CatalogContract(client, journal, migrationSources);
      return;
    case 5:
      await validateB1CatalogContract(client, journal, migrationSources, {
        additiveB2Phase: 5
      });
      await validateB2CatalogContract(client, journal, migrationSources);
      return;
    case 6:
      await validateB1CatalogContract(client, journal, migrationSources, {
        additiveB2Phase: 6
      });
      await validateB2CatalogContract(client, journal, migrationSources);
      return;
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
