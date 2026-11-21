/**
 * Local development setup (idempotent). Run with `pnpm dev:setup`.
 *
 *  1. creates the database (DEV_DB_NAME, default delulu_dev) if it does not exist;
 *  2. runs the migrations as the owner (the admin connection, DATABASE_URL);
 *  3. sets LOGIN passwords for app_web, app_pay and app_jobs (ALTER ROLE ... PASSWORD);
 *  4. seeds the 60-product catalog from apps/web/src/data/seed-catalog.ts;
 *  5. prints the lines for apps/web/.env.local on stdout (progress goes to stderr).
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
import { migrate, seedCatalog } from "../packages/db/src/index.ts";

// pg is a dependency of @delulu/db, resolved from there (the repository root has no dependencies)
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg") as typeof import("pg");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DB_NAME = process.env.DEV_DB_NAME ?? "delulu_dev";
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";
const ENV_LOCAL = fileURLToPath(new URL("../apps/web/.env.local", import.meta.url));

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
      app_jobs: passwordFor("app_jobs", null),
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

    const lines = [
      "# apps/web/.env.local (generated by pnpm dev:setup; git-ignored; never commit)",
      `DATABASE_URL_WEB=${dbUrl("app_web", passwords.app_web)}`,
      `DATABASE_URL_PAY=${dbUrl("app_pay", passwords.app_pay)}`,
      `DATABASE_URL_OWNER=${ownerUrl.toString()}`,
      `IDENTITY_KEY=${hexKey("IDENTITY_KEY")}`,
      `CARD_KEY=${hexKey("CARD_KEY")}`,
      `PIN_PEPPER=${hexKey("PIN_PEPPER")}`,
      `FIELD_KEY=${hexKey("FIELD_KEY")}`,
      "AUTH_PROVIDER=dev",
      `APP_ORIGIN=${APP_ORIGIN}`,
      "# held by the jobs deployment, not the web app",
      `APP_JOBS_PASSWORD=${passwords.app_jobs}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    await owner.end();
  }
}

main().catch((error: unknown) => {
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
