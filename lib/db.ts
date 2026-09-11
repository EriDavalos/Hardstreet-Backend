// ==================================================================
// HARD STREET BACKEND - Pool de Postgres (Neon compatible)
// ==================================================================
import { Pool, PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __hsPool: Pool | undefined;
}

function sslNeeded(conn: string | undefined): boolean {
  if (!conn) return true;
  return /sslmode=(disable|prefer)/i.test(conn) ? false : true;
}

export const pool: Pool =
  global.__hsPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslNeeded(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") global.__hsPool = pool;

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const client: PoolClient = await pool.connect();
  try {
    const res = await client.query(text, params as any[]);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

export const ACTIVE = "active = 1";
