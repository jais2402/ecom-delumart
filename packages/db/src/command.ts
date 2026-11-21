import { DomainError, ERROR_CODES, type ErrorCode } from "@delulu/core";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./transaction";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function requireUuid(value: unknown, field: string): void {
  if (!isUuid(value)) throw new DomainError("VALIDATION_FAILED", `${field} must be a uuid`, { field });
}

function asErrorCode(code: unknown): ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(code) ? (code as ErrorCode) : "VALIDATION_FAILED";
}

/** A refusal returned by a command function as {code, message}. */
export function domainErrorOf(error: unknown): DomainError {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  return new DomainError(asErrorCode(e.code), typeof e.message === "string" ? e.message : "request refused");
}

/**
 * Maps what a command function raised: DM001 carries a stable error code in HINT (migration
 * 0018); a lock or statement timeout, or a stale read the database asked us to retry, is the
 * retryable BUSY result (LLD §4). Anything else is a fault and is rethrown as it is.
 */
export function mapCommandError(error: unknown): unknown {
  const e = error as { code?: unknown; hint?: unknown; message?: unknown };
  if (e.code === "DM001") return new DomainError(asErrorCode(e.hint), String(e.message ?? "request refused"));
  if (e.code === "55P03" || e.code === "57014" || e.code === "40001") {
    return new DomainError("BUSY", "the request is busy; retry with the same idempotency key");
  }
  return error;
}

/**
 * Runs fn as the money-command role app_pay for the caller's sign-in session (the database
 * derives the acting user from it), under the LLD §4 timeouts. The session id is a bearer
 * secret: it is passed to the database only, never logged or echoed in an error.
 */
export async function asPay<T>(
  pool: Pool,
  authSessionId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  requireUuid(authSessionId, "authSessionId");
  try {
    return await withTransaction(pool, fn, {
      role: "app_pay",
      sessionId: authSessionId,
      lockTimeout: "2s",
      statementTimeout: "5s",
    });
  } catch (error) {
    throw mapCommandError(error);
  }
}

/**
 * Runs fn as the web role app_web, signed in with the caller's sign-in session when one is given
 * (the database derives the acting user from it), or with no identity at all for public reads.
 * Same timeouts and error mapping as asPay.
 */
export async function asWeb<T>(
  pool: Pool,
  authSessionId: string | null,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  if (authSessionId !== null) requireUuid(authSessionId, "authSessionId");
  try {
    return await withTransaction(pool, fn, {
      role: "app_web",
      sessionId: authSessionId,
      lockTimeout: "2s",
      statementTimeout: "5s",
    });
  } catch (error) {
    throw mapCommandError(error);
  }
}

/** Runs one SELECT of a function returning jsonb (`AS r`) and returns its value. */
export async function one<T>(c: PoolClient, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await c.query<{ r: T }>(sql, params);
  const r = rows[0]?.r;
  if (r === undefined || r === null) throw new Error("command returned nothing");
  return r;
}
