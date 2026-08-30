import { Pool } from "pg";

// Shared Postgres connection for the read-only dashboard surfaces. Rendered via the
// compose-injected DATABASE_URL. A single module-level pool survives hot-reloads of
// individual routes (Next dev keeps per-module instances stable).
const globalForPool = globalThis as unknown as { __recoveryPool?: Pool };

export const pool: Pool =
  globalForPool.__recoveryPool ??
  new Pool({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== "production") globalForPool.__recoveryPool = pool;

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function qOne<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q<T>(sql, params);
  return rows[0];
}

// The Go decision-engine, used for the promise "simulate respond" action so the same
// state machine endpoint drives the state (single source of truth).
export const DECISION_ENGINE_URL =
  process.env.DECISION_ENGINE_URL || "http://localhost:8082";
