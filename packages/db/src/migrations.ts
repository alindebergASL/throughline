import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPool } from "./client.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(packageRoot, "migrations");

export async function applyMigrations(
  pool: PgPool,
  options: { reset?: boolean } = {}
): Promise<void> {
  if (options.reset) {
    await pool.query("DROP SCHEMA IF EXISTS access CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS identity CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS ops CASCADE");
  }

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
}
