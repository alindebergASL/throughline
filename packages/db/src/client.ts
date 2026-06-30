import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type PgPool = pg.Pool;
export type PgPoolClient = pg.PoolClient;
export type PgQueryResult<T extends object = Record<string, unknown>> = pg.QueryResult<T>;

export function createPgPool(connectionString = process.env.DATABASE_URL): PgPool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new pg.Pool({ connectionString });
}

export function createDrizzleDb(pool: PgPool) {
  return drizzle(pool, { schema });
}
