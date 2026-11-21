import "./server-only";
import { z } from "zod";

/**
 * Server configuration from process.env, parsed once (on first use, so `next build` can load the
 * route modules without secrets) and refused as a whole with a message that names the bad
 * variables but never repeats a value. Keys are 32 bytes, hex encoded.
 */
export interface Env {
  nodeEnv: string;
  databaseUrlWeb: string;
  databaseUrlPay: string;
  /** Development and tests only: migrations, seeding and the dev sign-in provider. */
  databaseUrlOwner: string | null;
  identityKey: Buffer;
  cardKey: Buffer;
  pinPepper: Buffer;
  fieldKey: Buffer;
  authProvider: "dev" | "supabase";
  /** Scheme, host and port only, e.g. "https://delulumart.example". */
  appOrigin: string;
  /**
   * Reverse proxies in front of the server that append to X-Forwarded-For. 0 (the default): the
   * header is ignored and the client address is the connection's peer address.
   */
  trustedProxyHops: number;
  /** Tests and local development only (refused in production): multiplies every rate limit. */
  rateLimitMultiplier: number;
  /**
   * The job runner's login (database role app_jobs). Null: this server runs no jobs and
   * POST /api/internal/jobs/run answers 503.
   */
  databaseUrlJobs: string | null;
  /** The key the scheduler signs POST /api/internal/jobs/run with (HMAC-SHA-256). Null: disabled. */
  jobsSigningKey: Buffer | null;
  /**
   * Keys the daily-rotating analytics visitor key (HMAC-SHA-256 over day, address prefix and user
   * agent; analytics.ts). Null: no analytics events are recorded at all.
   */
  analyticsKey: Buffer | null;
  /**
   * Where the approximate place of a request comes from (PRD R7.1): "vercel" reads the hosting
   * edge's x-vercel-ip-* headers (which that edge overwrites); "none" ignores every geo header (any
   * other host would let a client set them). Default: "vercel" when VERCEL=1, else "none".
   */
  geoSource: "vercel" | "none";
  /**
   * Development only (refused in production): a fixed place for every request, "CC", "CC/REGION"
   * or "CC/REGION/City" (URL-encoded parts), so the console's place views can be tried locally.
   */
  devGeo: { country: string; region: string | null; city: string | null } | null;
}

/**
 * The example key values of apps/web/.env.example. They are public, so a server holding one has no
 * secret at all; production refuses them (as it refuses any key that is one repeated byte).
 */
const EXAMPLE_KEYS: ReadonlySet<string> = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000001",
  "0000000000000000000000000000000000000000000000000000000000000002",
  "0000000000000000000000000000000000000000000000000000000000000003",
  "0000000000000000000000000000000000000000000000000000000000000004",
  "0000000000000000000000000000000000000000000000000000000000000005",
]);

const KEY_NAMES = ["IDENTITY_KEY", "CARD_KEY", "PIN_PEPPER", "FIELD_KEY"] as const;
const OPTIONAL_KEY_NAMES = ["JOBS_SIGNING_KEY", "ANALYTICS_KEY"] as const;

function placeholderKey(hex: string): boolean {
  const lower = hex.toLowerCase();
  return EXAMPLE_KEYS.has(lower) || lower === lower.slice(0, 2).repeat(lower.length / 2);
}

const hexKey = z
  .string({ error: "is required" })
  .regex(/^[0-9a-fA-F]{64}$/, { error: "must be 64 hex characters (32 bytes)" });

const postgresUrl = z
  .string({ error: "is required" })
  .refine((v) => /^postgres(ql)?:\/\/[^\s]+$/.test(v), { error: "must be a postgres:// connection string" });

const origin = z.string({ error: "is required" }).refine(
  (v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && u.origin === v.replace(/\/$/, "");
    } catch {
      return false;
    }
  },
  { error: "must be an origin such as https://delulumart.example (no path)" },
);

const schema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL_WEB: postgresUrl,
  DATABASE_URL_PAY: postgresUrl,
  DATABASE_URL_OWNER: postgresUrl.optional(),
  DATABASE_URL_JOBS: postgresUrl.optional(),
  JOBS_SIGNING_KEY: hexKey.optional(),
  ANALYTICS_KEY: hexKey.optional(),
  VERCEL: z.string().optional(),
  GEO_SOURCE: z.enum(["vercel", "none"], { error: "must be 'vercel' or 'none'" }).optional(),
  DEV_GEO: z
    .string()
    .regex(/^[A-Za-z]{2}(\/[^/\s]{1,200}){0,2}$/, { error: "must be CC, CC/REGION or CC/REGION/City" })
    .optional(),
  IDENTITY_KEY: hexKey,
  CARD_KEY: hexKey,
  PIN_PEPPER: hexKey,
  FIELD_KEY: hexKey,
  AUTH_PROVIDER: z.enum(["dev", "supabase"], { error: "must be 'dev' or 'supabase'" }),
  APP_ORIGIN: origin,
  TRUSTED_PROXY_HOPS: z
    .string()
    .regex(/^\d{1,2}$/, { error: "must be a whole number from 0 to 10" })
    .refine((v) => Number(v) <= 10, { error: "must be a whole number from 0 to 10" })
    .optional(),
  RATE_LIMIT_MULTIPLIER: z
    .string()
    .regex(/^[1-9]\d{0,3}$/, { error: "must be a whole number from 1 to 9999" })
    .optional(),
});

function loginOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return "";
  }
}

function devGeoOf(value: string): { country: string; region: string | null; city: string | null } {
  const [country = "", region, city] = value.split("/");
  return { country, region: region ?? null, city: city ?? null };
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  // an empty value (VAR=) counts as unset
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(present);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join(".")} ${issue.message}`);
  } else {
    const v = parsed.data;
    const production = v.NODE_ENV === "production";
    const keys = [v.IDENTITY_KEY, v.CARD_KEY, v.PIN_PEPPER, v.FIELD_KEY, v.JOBS_SIGNING_KEY, v.ANALYTICS_KEY]
      .filter((k): k is string => k !== undefined)
      .map((k) => k.toLowerCase());
    if (new Set(keys).size !== keys.length) {
      problems.push(
        "IDENTITY_KEY, CARD_KEY, PIN_PEPPER, FIELD_KEY, JOBS_SIGNING_KEY and ANALYTICS_KEY must be distinct keys",
      );
    }
    if (v.DATABASE_URL_OWNER) {
      const owner = loginOf(v.DATABASE_URL_OWNER);
      if (loginOf(v.DATABASE_URL_WEB) === owner)
        problems.push("DATABASE_URL_WEB must not log in as the owner");
      if (loginOf(v.DATABASE_URL_PAY) === owner)
        problems.push("DATABASE_URL_PAY must not log in as the owner");
      if (v.DATABASE_URL_JOBS && loginOf(v.DATABASE_URL_JOBS) === owner)
        problems.push("DATABASE_URL_JOBS must not log in as the owner");
    }
    if (production && v.AUTH_PROVIDER === "dev") {
      problems.push("AUTH_PROVIDER 'dev' is refused when NODE_ENV is production");
    }
    if (production && v.DATABASE_URL_OWNER) {
      problems.push("DATABASE_URL_OWNER must not be set when NODE_ENV is production");
    }
    if (production) {
      for (const name of KEY_NAMES) {
        if (placeholderKey(v[name])) {
          problems.push(
            `${name} is a placeholder (an example value or one repeated byte); generate a random key`,
          );
        }
      }
      for (const name of OPTIONAL_KEY_NAMES) {
        const value = v[name];
        if (value !== undefined && placeholderKey(value)) {
          problems.push(
            `${name} is a placeholder (an example value or one repeated byte); generate a random key`,
          );
        }
      }
      if (v.RATE_LIMIT_MULTIPLIER !== undefined) {
        problems.push("RATE_LIMIT_MULTIPLIER must not be set when NODE_ENV is production");
      }
      if (v.DEV_GEO !== undefined) {
        problems.push("DEV_GEO must not be set when NODE_ENV is production");
      }
    }
    if (problems.length === 0) {
      return {
        nodeEnv: v.NODE_ENV ?? "development",
        databaseUrlWeb: v.DATABASE_URL_WEB,
        databaseUrlPay: v.DATABASE_URL_PAY,
        databaseUrlOwner: v.DATABASE_URL_OWNER ?? null,
        identityKey: Buffer.from(v.IDENTITY_KEY, "hex"),
        cardKey: Buffer.from(v.CARD_KEY, "hex"),
        pinPepper: Buffer.from(v.PIN_PEPPER, "hex"),
        fieldKey: Buffer.from(v.FIELD_KEY, "hex"),
        authProvider: v.AUTH_PROVIDER,
        appOrigin: v.APP_ORIGIN.replace(/\/$/, ""),
        trustedProxyHops: Number(v.TRUSTED_PROXY_HOPS ?? "0"),
        rateLimitMultiplier: Number(v.RATE_LIMIT_MULTIPLIER ?? "1"),
        databaseUrlJobs: v.DATABASE_URL_JOBS ?? null,
        jobsSigningKey: v.JOBS_SIGNING_KEY ? Buffer.from(v.JOBS_SIGNING_KEY, "hex") : null,
        analyticsKey: v.ANALYTICS_KEY ? Buffer.from(v.ANALYTICS_KEY, "hex") : null,
        geoSource: v.GEO_SOURCE ?? (v.VERCEL === "1" ? "vercel" : "none"),
        devGeo: v.DEV_GEO === undefined ? null : devGeoOf(v.DEV_GEO),
      };
    }
  }
  throw new Error(`Invalid server configuration (see apps/web/.env.example): ${problems.join("; ")}`);
}

let cached: Env | undefined;

/** The parsed configuration; throws on first use if it is invalid. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Tests change process.env between files; this forgets the parsed copy. */
export function resetEnvCache(): void {
  cached = undefined;
}
