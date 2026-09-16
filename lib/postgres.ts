import { Pool } from "pg";
import { env } from "./config";

let pool: Pool | undefined;

/**
 * The Postgres database (Supabase) when DATABASE_URL is set, otherwise null. Serverless instances are
 * short-lived: the pool stays small and lets idle connections go. Supabase's transaction pooler doesn't keep
 * prepared statements, which pg only creates for named queries.
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
