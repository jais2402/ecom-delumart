import { randomBytes } from "node:crypto";
import { generateCardNumber } from "@delulu/core";
import pg from "pg";
import { migrate } from "../src/migrate";
import { onboardingStatus, recordBirthdate, recordPhoneVerified } from "../src/onboarding";
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

/**
 * Supabase-shaped auth.users / auth.sessions (the columns the application and its tests read, with
 * Supabase's names and types; defaults as the sign-in service fills them). Created before the
 * migrations when `supabaseAuth` is set, so the migrations choose their Supabase variants (the
 * strict SMS check of 0070, the phone holder lookup of 0075, the anonymous check of 0074).
 */
export const SUPABASE_AUTH_DDL = `
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY, aud varchar(255), role varchar(255), email varchar(255),
  email_confirmed_at timestamptz, phone text UNIQUE DEFAULT NULL, phone_confirmed_at timestamptz,
  banned_until timestamptz, deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), not_after timestamptz
);
CREATE INDEX sessions_user ON auth.sessions (user_id);`;

/** Creates a uniquely named throwaway database, migrates it, and returns a pool to it. */
export async function createTestDatabase(
  options: { migrate?: boolean; poolSize?: number; supabaseAuth?: boolean } = {},
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
      if (options.supabaseAuth) await pool.query(SUPABASE_AUTH_DDL);
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
  const id = rows[0]?.id ?? uuidv7();
  if (!rows[0]) await c.query("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [id, userId]);
  // as the web server does after verifying the sign-in service's token (migration 0074)
  await c.query("SELECT core.register_app_session($1, $2)", [id, userId]);
  return id;
}

/**
 * OWNER-ONLY TEST PATH: marks a session row as accepted by the web server without the checks of
 * core.register_app_session, for tests that need an accepted session which is expired, too old or
 * otherwise refused (they assert core.actor_id() refuses it for THAT reason).
 */
export async function acceptForTest(
  c: pg.Pool | pg.PoolClient,
  sessionId: string,
  userId: string,
): Promise<void> {
  await c.query("INSERT INTO core.app_session (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    sessionId,
    userId,
  ]);
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
  /** Stand-in for the AES-256-GCM ciphertext of the birthdate (the database never decrypts it). */
  birthdateEnc: Buffer;
  isAdult: boolean;
};

/** A provisioned user with a live sign-in session (the caller's bearer secret). */
export type TestUser = ProvisionResult & { authSessionId: string };

/** A DeluluMart card number (LLD §5.4: Luhn-invalid by construction) from a random test key. */
export function cardNumberFor(userId: string, sequence = 0): string {
  return generateCardNumber({
    cardKey: randomBytes(32),
    userId,
    birthdate: "1990-01-01",
    sequence,
    prefix: "042424",
  });
}

/** Fresh, unique provisioning input. Card numbers come from the card-number algorithm. */
export function provisionInput(overrides: Partial<TestProvisionInput> = {}): TestProvisionInput {
  counter += 1;
  const tag = randomBytes(4).toString("hex");
  const userId = overrides.userId ?? uuidv7();
  return {
    userId,
    emailFingerprint: randomBytes(32),
    phoneFingerprint: randomBytes(32),
    cardNumbers: [cardNumberFor(userId, 0), cardNumberFor(userId, 1)],
    alias: `alias-${tag}-${counter}`,
    upiStyleId: `u${tag}${counter}@delulu`,
    birthdateEnc: randomBytes(40),
    isAdult: true,
    ...overrides,
  };
}

/**
 * The onboarding steps before provisioning (LLD §7.1), as app_pay with the user's session: the
 * verified phone (which creates the profile with the email fingerprint) and the encrypted
 * birthdate. Steps already done are skipped; a user without a phone fingerprint skips the phone.
 */
export async function onboard(
  pool: pg.Pool,
  input: Pick<TestProvisionInput, "emailFingerprint" | "phoneFingerprint" | "birthdateEnc" | "isAdult">,
  authSessionId: string,
): Promise<void> {
  const status = await onboardingStatus(pool, { authSessionId });
  if (status.provisioned) return;
  if (!status.phoneRecorded && input.phoneFingerprint) {
    await recordPhoneVerified(pool, {
      authSessionId,
      phoneFingerprint: input.phoneFingerprint,
      emailFingerprint: input.emailFingerprint,
    });
  }
  if (!status.hasBirthdate && input.phoneFingerprint) {
    await recordBirthdate(pool, { authSessionId, birthdateEnc: input.birthdateEnc, isAdult: input.isAdult });
  }
}

/**
 * Signs the user up with the auth service (auth.users row and a live session, committed), runs
 * the onboarding steps and provisions them through core.provision_account as app_pay with that
 * session.
 */
export async function provisionAccount(pool: pg.Pool, input: TestProvisionInput): Promise<TestUser> {
  const authSessionId = input.authSessionId ?? (await sessionFor(pool, input.userId));
  await onboard(pool, input, authSessionId);
  const result = await provisionAccountAs(pool, {
    authSessionId,
    emailFingerprint: input.emailFingerprint,
    phoneFingerprint: input.phoneFingerprint,
    cardNumbers: input.cardNumbers,
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
