import type { Pool, PoolClient } from "pg";

/**
 * Application database roles a transaction may run as (SET LOCAL ROLE). app_pay is the
 * money-command role (provisioning, checkout, payment attempts, pay); in production it
 * is a separate login and pool, and app_web is not a member of it, so a connection
 * authenticated as app_web cannot switch to it.
 */
export type AppRole = "app_web" | "app_pay" | "app_jobs";

const APP_ROLES: readonly AppRole[] = ["app_web", "app_pay", "app_jobs"];

export interface TransactionOptions {
  /**
   * Runs the transaction as this role (SET LOCAL ROLE). The connection's login must be
   * that role or a member of it; otherwise the transaction fails with 42501.
   */
  role?: AppRole;
  /** Sets app.user_id for row-level security policies (transaction-local). */
  userId?: string | null;
  /** Sets app.company_id; only after the server confirmed the actor owns the company. */
  companyId?: string | null;
  /** LLD §4 default: 2s. */
  lockTimeout?: string;
  /** LLD §4 default: 5s. */
  statementTimeout?: string;
}

/**
 * Runs fn inside one transaction with the LLD §4 timeouts and the RLS settings
 * applied transaction-locally. Commits on success, rolls back on any error.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    try {
      if (options.role !== undefined) {
        // a fixed allow-list: the role name is interpolated, never caller text
        if (!APP_ROLES.includes(options.role)) throw new Error(`unknown database role: ${options.role}`);
        await client.query(`SET LOCAL ROLE ${options.role}`);
      }
      await client.query(
        `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true),
                set_config('app.user_id', $3, true), set_config('app.company_id', $4, true)`,
        [
          options.lockTimeout ?? "2s",
          options.statementTimeout ?? "5s",
          options.userId ?? "",
          options.companyId ?? "",
        ],
      );
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true; // connection unusable; destroy it instead of returning it to the pool
      }
      throw error;
    }
  } finally {
    client.release(broken);
  }
}
