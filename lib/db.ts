// ==================================================================
// HARD STREET BACKEND - Pool de MySQL (mysql2/promise)
// ==================================================================
import mysql from "mysql2/promise";
import type { Pool, PoolConnection, ResultSetHeader } from "mysql2/promise";

declare global {
  // eslint-disable-next-line no-var
  var __hsMysqlPool: Pool | undefined;
}

export const pool: Pool =
  global.__hsMysqlPool ||
  mysql.createPool({
    uri: process.env.DATABASE_URL,
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "hardstreet",
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10_000,
    // mysql2 devuelve TINYINT(1) como boolean; los flags active/is_public
    // se comparan con 1 en SQL, así que devolvemos números tal cual.
    typeCast: (field, next) => {
      if (String(field.type) === "TINYINT" && field.length === 1) {
        const v = field.string();
        return v === null ? null : Number(v);
      }
      return next();
    },
    decimalNumbers: true, // DECIMAL -> number (los mappers ya lo aceptan)
  });

if (process.env.NODE_ENV !== "production") global.__hsMysqlPool = pool;

/** SELECT -> filas. Placeholders estilo MySQL (?). */
export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query(text, params as any[]);
  return rows as T[];
}

/** INSERT/UPDATE/DELETE -> { insertId, affectedRows }. */
export async function exec(
  text: string,
  params: unknown[] = []
): Promise<{ insertId: number; affectedRows: number }> {
  const [res] = await pool.query(text, params as any[]);
  const h = res as ResultSetHeader;
  return { insertId: Number(h.insertId || 0), affectedRows: Number(h.affectedRows || 0) };
}

/** Varias consultas dentro de una transaccion (commit/rollback automatico). */
export async function transaccion<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try {
      await conn.rollback();
    } catch {
      /* noop */
    }
    throw e;
  } finally {
    conn.release();
  }
}

export const ACTIVE = "active = 1";
