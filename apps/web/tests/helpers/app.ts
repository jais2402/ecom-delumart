/**
 * A throwaway database per test file (packages/db/tests/helpers.ts), migrated, with three seed
 * products, and the web server's environment pointed at it. The web and pay pools log in as
 * test-only login roles that are members of app_web and app_pay respectively (so SET ROLE works
 * exactly as for the real logins, and the real roles' passwords are never touched).
 */
import { randomBytes } from "node:crypto";
import { seedCatalog, seedProductId } from "@delulu/db";
import pg from "pg";
import { createTestDatabase, type TestDatabase } from "../../../../packages/db/tests/helpers";
import { CATEGORIES, SEED_PRODUCTS, type SeedProduct } from "../../src/data/seed-catalog";
import { closePools } from "../../src/server/db";
import { resetEnvCache } from "../../src/server/env";

export const APP_ORIGIN = "https://app.delulu.test";
export const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const TEST_LOGINS = [
  { login: "delulu_web_test_login", role: "app_web" },
  { login: "delulu_pay_test_login", role: "app_pay" },
] as const;
/** Fresh for every test run; the logins are dropped again when the test file ends. */
const TEST_LOGIN_PASSWORD = randomBytes(18).toString("hex");

async function ensureTestLogins(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const { login, role } of TEST_LOGINS) {
      try {
        await admin.query(`CREATE ROLE ${login} LOGIN NOINHERIT`);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "42710" && code !== "23505") throw error;
      }
      await admin.query(`ALTER ROLE ${login} PASSWORD '${TEST_LOGIN_PASSWORD}'`);
      await admin.query(`GRANT ${role} TO ${login}`);
    }
  } finally {
    await admin.end();
  }
}

async function dropTestLogins(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const { login } of TEST_LOGINS) await admin.query(`DROP ROLE IF EXISTS ${login}`);
  } finally {
    await admin.end();
  }
}

function urlAs(dbUrl: string, login: string): string {
  const url = new URL(dbUrl);
  url.username = login;
  url.password = TEST_LOGIN_PASSWORD;
  return url.toString();
}

export interface TestApp {
  db: TestDatabase;
  products: { id: string; seed: SeedProduct; pricePaise: bigint }[];
  stop: () => Promise<void>;
}

/** The three cheapest seed products, so a starting balance buys them all. */
export function cheapestSeedProducts(n = 3): SeedProduct[] {
  return [...SEED_PRODUCTS].sort((a, b) => a.priceRupees - b.priceRupees).slice(0, n);
}

export function setTestEnv(dbUrl: string, overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string | undefined> = {
    DATABASE_URL_WEB: urlAs(dbUrl, TEST_LOGINS[0].login),
    DATABASE_URL_PAY: urlAs(dbUrl, TEST_LOGINS[1].login),
    DATABASE_URL_OWNER: dbUrl,
    IDENTITY_KEY: randomBytes(32).toString("hex"),
    CARD_KEY: randomBytes(32).toString("hex"),
    PIN_PEPPER: randomBytes(32).toString("hex"),
    FIELD_KEY: randomBytes(32).toString("hex"),
    AUTH_PROVIDER: "dev",
    APP_ORIGIN,
    TRUSTED_PROXY_HOPS: undefined,
    RATE_LIMIT_MULTIPLIER: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

/** The dev provider refuses to load unless AUTH_PROVIDER is 'dev': import it only after the env is set. */
async function closeDevAuth(): Promise<void> {
  if (process.env.AUTH_PROVIDER !== "dev") return;
  const dev = await import("../../src/server/auth/dev");
  await dev.closeDevAuth();
}

/**
 * `env` overrides the server environment for this test file only, e.g. RATE_LIMIT_MULTIPLIER for a
 * property test that makes more calls per minute than one real player may (the production limits
 * themselves are never changed; the server refuses the multiplier in production).
 */
export async function startTestApp(
  options: { env?: Record<string, string | undefined> } = {},
): Promise<TestApp> {
  await ensureTestLogins();
  const db = await createTestDatabase();
  try {
    const seeds = cheapestSeedProducts();
    await seedCatalog(db.pool, seeds, CATEGORIES);
    setTestEnv(db.url, options.env);
    await closePools();
    await closeDevAuth();
    return {
      db,
      products: seeds.map((seed) => ({
        id: seedProductId(seed.id),
        seed,
        pricePaise: BigInt(seed.priceRupees) * 100n,
      })),
      stop: async () => {
        await closePools();
        await closeDevAuth();
        await db.drop();
        await dropTestLogins();
      },
    };
  } catch (error) {
    await db.drop();
    await dropTestLogins();
    throw error;
  }
}

/** Every secret the server holds, for "never in a response" assertions. */
export function serverSecrets(): string[] {
  return ["IDENTITY_KEY", "CARD_KEY", "PIN_PEPPER", "FIELD_KEY"].flatMap((k) => {
    const hex = process.env[k] ?? "";
    return [hex, Buffer.from(hex, "hex").toString("base64")];
  });
}
