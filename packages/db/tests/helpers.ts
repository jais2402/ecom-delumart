import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/migrate";
import { type ProvisionInput, provisionAccount } from "../src/provision";
import { uuidv7 } from "../src/uuid";

export const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";

export interface TestDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  drop: () => Promise<void>;
}

/** Creates a uniquely named throwaway database, migrates it, and returns a pool to it. */
export async function createTestDatabase(
  options: { migrate?: boolean; poolSize?: number } = {},
): Promise<TestDatabase> {
  const name = `delulu_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: options.poolSize ?? 15 });
  if (options.migrate !== false) await migrate(pool);
  const drop = async (): Promise<void> => {
    await pool.end();
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };
  return { name, url: url.toString(), pool, drop };
}

/** Postgres SQLSTATE of a rejected promise, for asserting the reason a statement failed. */
export async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : `non-pg error: ${(error as Error).message}`;
  }
  return "no error";
}

/**
 * Runs one statement in its own rolled-back transaction, optionally as another role
 * with app.user_id set, and returns the SQLSTATE it failed with ("no error" if it ran).
 */
export async function stateOf(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
  as: { role?: string; userId?: string } = {},
): Promise<string> {
  return inRolledBackTx(pool, async (c) => {
    if (as.userId) await c.query("SELECT set_config('app.user_id', $1, true)", [as.userId]);
    if (as.role) await c.query(`SET LOCAL ROLE ${as.role}`);
    return sqlState(c.query(sql, params));
  });
}

/** Runs fn on a dedicated connection inside BEGIN/ROLLBACK, so each check leaves no trace. */
export async function inRolledBackTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Who a statement runs as: a database role plus the transaction-local RLS settings. */
export interface Actor {
  role?: string;
  userId?: string;
  companyId?: string;
}

async function become(c: pg.PoolClient, as: Actor): Promise<void> {
  await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.company_id', $2, true)", [
    as.userId ?? "",
    as.companyId ?? "",
  ]);
  if (as.role) await c.query(`SET LOCAL ROLE ${as.role}`);
}

/** Runs fn as the actor inside a transaction that is always rolled back. */
export async function asActor<T>(pool: pg.Pool, as: Actor, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inRolledBackTx(pool, async (c) => {
    await become(c, as);
    return fn(c);
  });
}

/**
 * Runs fn as the actor, then fires every deferred constraint (as COMMIT would) and
 * returns the SQLSTATE of the first failure, or "no error". Always rolled back.
 */
export async function commitState(
  pool: pg.Pool,
  as: Actor,
  fn: (c: pg.PoolClient) => Promise<unknown>,
): Promise<string> {
  return asActor(pool, as, (c) =>
    sqlState(
      (async () => {
        await fn(c);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      })(),
    ),
  );
}

/** Like commitState, but returns the error message (or "no error") for asserting which rule fired. */
export async function commitError(
  pool: pg.Pool,
  as: Actor,
  fn: (c: pg.PoolClient) => Promise<unknown>,
): Promise<string> {
  return asActor(pool, as, async (c) => {
    try {
      await fn(c);
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      return "no error";
    } catch (error) {
      return (error as Error).message;
    }
  });
}

/** Number of rows a counting query returns as `n`. */
export async function countRows(
  c: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const { rows } = await c.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

let counter = 0;

/** Fresh, unique provisioning input. Card numbers are synthetic 16-digit strings. */
export function provisionInput(overrides: Partial<ProvisionInput> = {}): ProvisionInput {
  counter += 1;
  const tag = randomBytes(4).toString("hex");
  const digits = (BigInt(`0x${randomBytes(8).toString("hex")}`) % 10n ** 15n).toString().padStart(15, "0");
  return {
    userId: uuidv7(),
    emailFingerprint: randomBytes(32),
    phoneFingerprint: randomBytes(32),
    cardNumber: `0${digits}`,
    alias: `alias-${tag}-${counter}`,
    upiStyleId: `u${tag}${counter}@delulu`,
    ...overrides,
  };
}

/** Creates a bare user profile (no provisioning). */
export async function createProfile(pool: pg.Pool, id: string = uuidv7()): Promise<string> {
  await pool.query("INSERT INTO core.user_profile (id, email_fingerprint) VALUES ($1, $2)", [
    id,
    randomBytes(32),
  ]);
  return id;
}

export { provisionAccount, uuidv7 };
