import { Pool } from "pg";
import { env } from "./config";

let pool: Pool | undefined;

/**
 * The Postgres database when DATABASE_URL is set, otherwise null: in production the Railway Postgres in the
 * KT-01 project, over the private network. The pool stays small and lets idle connections go. No named queries,
 * so it also works through a transaction pooler, which doesn't keep prepared statements.
 */
export function postgres(): Pool | null {
  const connectionString = env("DATABASE_URL");
  if (!connectionString) return null;
  pool ??= new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}
