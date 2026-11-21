import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/migrate";
import {
  type ProvisionInput,
  type ProvisionResult,
  provisionAccount as provisionAccountAs,
} from "../src/provision";
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
  const drop = async (): Promise<void> => {
    await pool.end();
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    try {
      // Connections that are still closing would be killed by a forced drop, which surfaces
      // as an unhandled "terminating connection" error. Wait for them to finish instead and
      // only force as a last resort.
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          await c.query(`DROP DATABASE IF EXISTS ${name}`);
          return;
        } catch (error) {
          if ((error as { code?: string }).code !== "55006") throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };
  if (options.migrate !== false) {
    try {
      await migrate(pool);
      await grantRawWriter(pool);
    } catch (error) {
      await drop(); // a failed migration must not leave a delulu_test_* database behind
      throw error;
    }
  }
  return { name, url: url.toString(), pool, drop };
}

/**
 * A deliberately over-privileged TEST-ONLY role: every privilege on the core, ledger, private and
 * audit tables, every function, and BYPASSRLS. It stands for "a writer the grants did not stop"
 * (a future grant mistake, an owner-run path with a bug), so tests can show that the structural
 * money rules of migration 0016 and the seals hold on their own, whoever writes. The application
 * roles hold none of these privileges (tests/money-attacks.test.ts asserts it). Never created by
 * a migration.
 */
export const RAW_WRITER = "test_raw_writer";

async function grantRawWriter(pool: pg.Pool): Promise<void> {
  try {
    await pool.query(`CREATE ROLE ${RAW_WRITER} NOLOGIN BYPASSRLS`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "42710" && code !== "23505") throw error; // cluster-wide: made by an earlier test database
  }
  await pool.query(`GRANT USAGE ON SCHEMA core, ledger, private, audit TO ${RAW_WRITER}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, ledger, private, audit TO ${RAW_WRITER}`,
  );
  await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core, ledger TO ${RAW_WRITER}`);
}

/**
 * A sign-in session for the user, as the auth service would create it (written as the owner,
 * on the given connection: committed with it, or rolled back with it). Creates the auth.users
 * row when missing and reuses the user's oldest live session.
 */
export async function sessionFor(c: pg.Pool | pg.PoolClient, userId: string): Promise<string> {
  await c.query("INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM auth.sessions WHERE user_id = $1 AND (not_after IS NULL OR not_after > now())
      ORDER BY created_at, id LIMIT 1`,
    [userId],
  );
  if (rows[0]) return rows[0].id;
  const id = uuidv7();
  await c.query("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [id, userId]);
  return id;
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
 * Runs one statement in its own rolled-back transaction, optionally as another role signed in
 * as a user (app.session_id set to a live session of theirs), and returns the SQLSTATE it
 * failed with ("no error" if it ran).
 */
export async function stateOf(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
  as: Actor = {},
): Promise<string> {
  return inRolledBackTx(pool, async (c) => {
    await become(c, as);
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

/**
 * Who a statement runs as: a database role, signed in as a user. The user is never named to the
 * database: become() puts a live sign-in session of the user in app.session_id and the database
 * derives the actor from it (core.actor_id(), migration 0001). `sessionId` sets a given session
 * id instead (a guessed, expired or banned one, for the identity tests). There is no company
 * either: the database derives the actor's companies from the user (migration 0012).
 */
export interface Actor {
  role?: string;
  userId?: string;
  sessionId?: string;
}

/** Signs the transaction in as the actor (as the owner, before switching role), then SET ROLE. */
export async function become(c: pg.PoolClient, as: Actor): Promise<void> {
  const session = as.sessionId ?? (as.userId ? await sessionFor(c, as.userId) : "");
  await c.query("SELECT set_config('app.session_id', $1, true)", [session]);
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

/**
 * Writes fixture rows as the owner with triggers and foreign keys switched off
 * (session_replication_role = replica, superuser only), and commits them. Used only for
 * rows that are deliberately impossible to create through the application or under the
 * structural money rules (an order group without its journal, a pre-authenticated
 * attempt, ...): tests that ask who can SEE such rows, or what pay() does when faced
 * with them. Never used for the behaviour under test.
 */
export async function plant(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs fn as the owner in one committed transaction (all deferred checks apply). */
export async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

/** Provisioning input for a user who signs up (the test stands in for the auth service). */
export type TestProvisionInput = Omit<ProvisionInput, "authSessionId"> & {
  userId: string;
  authSessionId?: string;
};

/** A provisioned user with a live sign-in session (the caller's bearer secret). */
export type TestUser = ProvisionResult & { authSessionId: string };

/** Fresh, unique provisioning input. Card numbers are synthetic 16-digit strings. */
export function provisionInput(overrides: Partial<TestProvisionInput> = {}): TestProvisionInput {
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

/**
 * Signs the user up with the auth service (auth.users row and a live session, committed) and
 * provisions them through core.provision_account as app_pay with that session.
 */
export async function provisionAccount(pool: pg.Pool, input: TestProvisionInput): Promise<TestUser> {
  const authSessionId = input.authSessionId ?? (await sessionFor(pool, input.userId));
  const result = await provisionAccountAs(pool, {
    authSessionId,
    emailFingerprint: input.emailFingerprint,
    phoneFingerprint: input.phoneFingerprint,
    cardNumber: input.cardNumber,
    alias: input.alias,
    upiStyleId: input.upiStyleId,
  });
  return { ...result, authSessionId };
}

/** Creates a bare user profile (no provisioning), as the owner, for a user the auth service knows. */
export async function createProfile(pool: pg.Pool, id: string = uuidv7()): Promise<string> {
  await pool.query("INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  await pool.query("INSERT INTO core.user_profile (id, email_fingerprint) VALUES ($1, $2)", [
    id,
    randomBytes(32),
  ]);
  return id;
}

export { uuidv7 };
