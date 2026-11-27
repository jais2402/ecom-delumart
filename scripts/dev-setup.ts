/**
 * Local development setup (idempotent). Run with `pnpm dev:setup`.
 *
 *  1. creates the database (DEV_DB_NAME, default delulu_dev) if it does not exist;
 *  2. runs the migrations as the owner (the admin connection, DATABASE_URL);
 *  3. sets LOGIN passwords for app_web, app_pay and app_jobs (ALTER ROLE ... PASSWORD);
 *  4. seeds the 60-product catalog from apps/web/src/data/seed-catalog.ts;
 *  4b. turns the payment test scenarios on (deployment_setting 'payments.test_scenarios'; PRD R4.6);
 *  5. optionally makes one dev account the Super Admin (SUPER_ADMIN_EMAIL, below);
 *  5b. optionally (SEED_ANALYTICS=1) writes ~30 days of synthetic analytics traffic across Indian
 *     states and cities and rolls it up, through the owner-only
 *     analytics.dev_seed_synthetic_events (never callable by an application role), so the
 *     console's analytics have data locally. Each run adds another 30 days' worth of events;
 *  6. prints the lines for apps/web/.env.local on stdout (progress goes to stderr), including
 *     DATABASE_URL_JOBS (the app_jobs login of the job runner) and JOBS_SIGNING_KEY (the key that
 *     signs POST /api/internal/jobs/run) and ANALYTICS_KEY (keys the daily-rotating visitor key).
 *
 * Super Admin locally: sign in once with the dev provider using that email and finish the phone
 * step (which creates the profile), then run
 *     SUPER_ADMIN_EMAIL=you@example.com pnpm dev:setup
 * The role is assigned here, as the database owner, and nowhere else: the account with that email
 * becomes the only SUPER_ADMIN (any other loses the role). The email is matched through the same
 * keyed id the dev sign-in provider derives from it (IDENTITY_KEY), never stored or printed.
 *
 * Re-running keeps every password and key already present in the environment or in
 * apps/web/.env.local (a new FIELD_KEY would make stored birthdates unreadable); only missing ones
 * are generated with crypto.randomBytes. Never run against production: it uses the owner login.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Pool as PgPool } from "pg";
import { CATEGORIES, SEED_PRODUCTS } from "../apps/web/src/data/seed-catalog.ts";
import { devUserId } from "../apps/web/src/server/auth/dev-user-id.ts";
import { normalizeEmail } from "../packages/core/src/identity/index.ts";
import { migrate, seedCatalog } from "../packages/db/src/index.ts";

// pg is a dependency of @delulu/db, resolved from there (the repository root has no dependencies)
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg") as typeof import("pg");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DB_NAME = process.env.DEV_DB_NAME ?? "delulu_dev";
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";
const ENV_LOCAL = fileURLToPath(new URL("../apps/web/.env.local", import.meta.url));

/** Days of synthetic analytics traffic written by SEED_ANALYTICS=1. */
const SYNTHETIC_ANALYTICS_DAYS = 30;

const log = (message: string) => process.stderr.write(`[dev-setup] ${message}\n`);

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(DB_NAME))
  throw new Error("DEV_DB_NAME must be a plain lowercase identifier");

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

const existing = readEnvFile(ENV_LOCAL);
const known = (name: string): string | undefined => process.env[name] ?? existing[name];
const hexKey = (name: string): string => {
  const v = known(name);
  return v && /^[0-9a-fA-F]{64}$/.test(v) ? v : randomBytes(32).toString("hex");
};

/** The password of a role: from APP_<ROLE>_PASSWORD, else from the existing .env.local URL, else new. */
function passwordFor(role: string, urlVar: string | null): string {
  const explicit = process.env[`${role.toUpperCase()}_PASSWORD`];
  if (explicit) return explicit;
  const url = urlVar ? existing[urlVar] : existing[`${role.toUpperCase()}_PASSWORD`];
  if (url) {
    try {
      const parsed = urlVar ? decodeURIComponent(new URL(url).password) : url;
      if (parsed) return parsed;
    } catch {
      // regenerate below
    }
  }
  return randomBytes(18).toString("hex");
}

function dbUrl(user: string, password: string): string {
  const url = new URL(ADMIN_URL);
  url.username = user;
  url.password = encodeURIComponent(password);
  url.pathname = `/${DB_NAME}`;
  return url.toString();
}

async function main(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${DB_NAME}`);
      log(`created database ${DB_NAME}`);
    } else {
      log(`database ${DB_NAME} exists`);
    }
  } finally {
    await admin.end();
  }

  const ownerUrl = new URL(ADMIN_URL);
  ownerUrl.pathname = `/${DB_NAME}`;
  const owner: PgPool = new pg.Pool({ connectionString: ownerUrl.toString(), max: 2 });
  try {
    const result = await migrate(owner);
    log(`migrations: ${result.applied.length} applied, ${result.skipped.length} already applied`);

    const passwords = {
      app_web: passwordFor("app_web", "DATABASE_URL_WEB"),
      app_pay: passwordFor("app_pay", "DATABASE_URL_PAY"),
      app_jobs: passwordFor("app_jobs", "DATABASE_URL_JOBS"),
    };
    const client = await owner.connect();
    try {
      for (const [role, password] of Object.entries(passwords)) {
        // role names come from the fixed list above; the password is escaped as a literal
        await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
      }
    } finally {
      client.release();
    }
    log("set login passwords for app_web, app_pay, app_jobs");

    const seeded = await seedCatalog(owner, SEED_PRODUCTS, CATEGORIES);
    log(
      `catalog: ${seeded.categories} categories, ${seeded.productsCreated} products created, ` +
        `${seeded.versionsCreated} versions created (of ${SEED_PRODUCTS.length})`,
    );

    // PRD R4.6: payment test scenarios (forced declines, a slow or unavailable bank, a code that expires)
    // are open in local development and staging, never by default: the migrations leave this 'off', and
    // this script (which uses the owner login and is never run against production) turns it on.
    await owner.query(
      "UPDATE core.deployment_setting SET value = 'on' WHERE key = 'payments.test_scenarios'",
    );
    log("payment test scenarios: on (local development only)");

    const identityKey = hexKey("IDENTITY_KEY");
    const adminEmail = process.env.SUPER_ADMIN_EMAIL;
    if (adminEmail) await markSuperAdmin(owner, identityKey, adminEmail);

    if (process.env.SEED_ANALYTICS === "1") {
      const { rows } = await owner.query<{ r: { days: number; events: number } }>(
        "SELECT analytics.dev_seed_synthetic_events($1) AS r",
        [SYNTHETIC_ANALYTICS_DAYS],
      );
      log(
        `analytics: ${rows[0]?.r.events ?? 0} synthetic events over ${rows[0]?.r.days ?? 0} days, rolled up`,
      );
    }

    const lines = [
      "# apps/web/.env.local (generated by pnpm dev:setup; git-ignored; never commit)",
      `DATABASE_URL_WEB=${dbUrl("app_web", passwords.app_web)}`,
      `DATABASE_URL_PAY=${dbUrl("app_pay", passwords.app_pay)}`,
      `DATABASE_URL_OWNER=${ownerUrl.toString()}`,
      `DATABASE_URL_JOBS=${dbUrl("app_jobs", passwords.app_jobs)}`,
      `JOBS_SIGNING_KEY=${hexKey("JOBS_SIGNING_KEY")}`,
      `IDENTITY_KEY=${identityKey}`,
      `CARD_KEY=${hexKey("CARD_KEY")}`,
      `PIN_PEPPER=${hexKey("PIN_PEPPER")}`,
      `FIELD_KEY=${hexKey("FIELD_KEY")}`,
      `ANALYTICS_KEY=${hexKey("ANALYTICS_KEY")}`,
      "AUTH_PROVIDER=dev",
      `APP_ORIGIN=${APP_ORIGIN}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    await owner.end();
  }
}

/**
 * Makes the dev account of `email` the single Super Admin (LLD §3.1: assigned only by the owner).
 * The account must have signed in once and finished the phone step (which creates its profile).
 */
async function markSuperAdmin(owner: PgPool, identityKey: string, email: string): Promise<void> {
  let userId: string;
  try {
    userId = devUserId(Buffer.from(identityKey, "hex"), normalizeEmail(email));
  } catch {
    log("SUPER_ADMIN_EMAIL is not a valid email address; no Super Admin set");
    return;
  }
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query("SELECT 1 FROM core.user_profile WHERE id = $1", [userId]);
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      log(
        "SUPER_ADMIN_EMAIL: that account has no profile yet; sign in and verify a phone first, then re-run",
      );
      return;
    }
    await client.query(
      "UPDATE core.user_profile SET role = 'PLAYER' WHERE role = 'SUPER_ADMIN' AND id <> $1",
      [userId],
    );
    await client.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [userId]);
    await client.query("COMMIT");
    log("SUPER_ADMIN_EMAIL: that account is now the Super Admin");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error: unknown) => {
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
