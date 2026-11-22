import "./server-only";
import { type DatabaseTls, decodeCaCertificate, isLoopbackHost } from "@delulu/db/runtime";
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
  /**
   * Supabase Auth (AUTH_PROVIDER=supabase): the project URL, the publishable key (public auth
   * endpoints) and the SECRET key (admin endpoints; server-only, never logged or sent to a
   * browser). Null for the dev provider.
   */
  supabase: { url: string; publishableKey: string; secretKey: string } | null;
  /**
   * TLS to the database: "verify-full" (default whenever a database host is not loopback; refused
   * off in production then) or "disable" (local only).
   */
  databaseTls: DatabaseTls;
  /** PEM of the database's CA certificate (DATABASE_CA_CERT, PEM or base64 of it); null: system roots. */
  databaseCa: string | null;
  /** The bearer Vercel Cron sends (Authorization: Bearer <CRON_SECRET>); null: the cron route is off. */
  cronSecret: string | null;
  /** True on Vercel (VERCEL=1): serverless pool sizes. */
  serverless: boolean;
  /** The first 12 characters of the deployed git commit (VERCEL_GIT_COMMIT_SHA), for /api/health. */
  commit: string | null;
  /**
   * Cloudflare Turnstile (ninth review, major 2a) on email sign-in start, email-code check and the
   * phone step. `siteKey` is public (it reaches the browser); `secretKey` is server-only. `verifyUrl`
   * is Cloudflare's siteverify endpoint unless TURNSTILE_VERIFY_URL names a verifier on this machine
   * (tests and the local smoke only). Null: no challenge (development without keys, or CAPTCHA=off).
   */
  captcha: { siteKey: string; secretKey: string; verifyUrl: string } | null;
  /** CAPTCHA=off was set explicitly: /api/v1/admin/health reports `captcha: "off"` as a warning. */
  captchaOff: boolean;
}

/** Cloudflare's documented server-side validation endpoint. */
export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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

const supabaseOrigin = z.string().refine(
  (v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && u.origin === v.replace(/\/$/, "");
    } catch {
      return false;
    }
  },
  { error: "must be the project URL such as https://<project-ref>.supabase.co (no path)" },
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
  SUPABASE_URL: supabaseOrigin.optional(),
  SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .regex(/^sb_publishable_[A-Za-z0-9_-]{10,200}$/, {
      error: "must be the project's publishable key (sb_publishable_...)",
    })
    .optional(),
  SUPABASE_SECRET_KEY: z
    .string()
    .regex(/^sb_secret_[A-Za-z0-9_-]{10,200}$/, {
      error: "must be a secret key of the project (sb_secret_...)",
    })
    .optional(),
  DATABASE_TLS: z
    .enum(["verify-full", "disable"], { error: "must be 'verify-full' or 'disable'" })
    .optional(),
  DATABASE_CA_CERT: z.string().optional(),
  CRON_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/, {
      error: "must be 32 or more letters, digits, '-' or '_' (openssl rand -hex 32)",
    })
    .optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  TURNSTILE_SITE_KEY: z
    .string()
    .regex(/^[0-9A-Za-z_-]{10,100}$/, { error: "must be the Turnstile site key (letters, digits, '-', '_')" })
    .optional(),
  TURNSTILE_SECRET_KEY: z
    .string()
    .regex(/^[0-9A-Za-z_-]{20,200}$/, {
      error: "must be the Turnstile secret key (letters, digits, '-', '_')",
    })
    .optional(),
  TURNSTILE_VERIFY_URL: z
    .string()
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.hostname);
        } catch {
          return false;
        }
      },
      {
        error: "must be a verifier on this machine (http://127.0.0.1:<port>/...); tests and local smoke only",
      },
    )
    .optional(),
  CAPTCHA: z.enum(["on", "off"], { error: "must be 'on' or 'off'" }).optional(),
});

/** Cloudflare's documented test secret keys (always pass / always fail / already spent). */
const TURNSTILE_TEST_SECRET = /^[123]x0{30,}AA$/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

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
    const supabaseNames = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"] as const;
    if (v.AUTH_PROVIDER === "supabase") {
      for (const name of supabaseNames) {
        if (v[name] === undefined) problems.push(`${name} is required when AUTH_PROVIDER is 'supabase'`);
      }
    }
    const dbUrls = [v.DATABASE_URL_WEB, v.DATABASE_URL_PAY, v.DATABASE_URL_JOBS].filter(
      (u): u is string => u !== undefined,
    );
    const allLoopback = dbUrls.every((u) => isLoopbackHost(hostOf(u)));
    const databaseTls: DatabaseTls = v.DATABASE_TLS ?? (allLoopback ? "disable" : "verify-full");
    if (production && databaseTls === "disable" && !allLoopback) {
      problems.push(
        "DATABASE_TLS 'disable' is refused in production for a database that is not on this machine",
      );
    }
    let databaseCa: string | null = null;
    try {
      databaseCa = decodeCaCertificate(v.DATABASE_CA_CERT);
    } catch {
      problems.push("DATABASE_CA_CERT must be the CA certificate as PEM text or base64 of it");
    }
    if (production) {
      const origin = new URL(v.APP_ORIGIN);
      if (origin.protocol !== "https:" && !isLoopbackHost(origin.hostname)) {
        problems.push("APP_ORIGIN must be https when NODE_ENV is production");
      }
      if (v.SUPABASE_URL !== undefined) {
        const sb = new URL(v.SUPABASE_URL);
        if (sb.protocol !== "https:" && !isLoopbackHost(sb.hostname)) {
          problems.push("SUPABASE_URL must be https when NODE_ENV is production");
        }
      }
      if (v.CRON_SECRET !== undefined && new Set(v.CRON_SECRET).size < 8) {
        problems.push("CRON_SECRET is a placeholder (too few different characters); generate a random one");
      }
    }
    const hasSite = v.TURNSTILE_SITE_KEY !== undefined;
    const hasSecret = v.TURNSTILE_SECRET_KEY !== undefined;
    if (hasSite !== hasSecret) {
      problems.push("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set together or not at all");
    }
    if (production && v.AUTH_PROVIDER === "supabase" && !(hasSite && hasSecret) && v.CAPTCHA !== "off") {
      problems.push(
        "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are required when NODE_ENV is production and AUTH_PROVIDER is 'supabase' (or set CAPTCHA=off explicitly)",
      );
    }
    if (production && hasSecret && TURNSTILE_TEST_SECRET.test(v.TURNSTILE_SECRET_KEY ?? "")) {
      problems.push(
        "TURNSTILE_SECRET_KEY is one of Cloudflare's public test keys; use the site's real secret",
      );
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
        supabase:
          v.AUTH_PROVIDER === "supabase" &&
          v.SUPABASE_URL &&
          v.SUPABASE_PUBLISHABLE_KEY &&
          v.SUPABASE_SECRET_KEY
            ? {
                url: v.SUPABASE_URL.replace(/\/$/, ""),
                publishableKey: v.SUPABASE_PUBLISHABLE_KEY,
                secretKey: v.SUPABASE_SECRET_KEY,
              }
            : null,
        databaseTls,
        databaseCa,
        cronSecret: v.CRON_SECRET ?? null,
        serverless: v.VERCEL === "1",
        commit: /^[0-9a-f]{12,40}$/i.test(v.VERCEL_GIT_COMMIT_SHA ?? "")
          ? (v.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 12).toLowerCase()
          : null,
        captcha:
          v.CAPTCHA !== "off" && v.TURNSTILE_SITE_KEY && v.TURNSTILE_SECRET_KEY
            ? {
                siteKey: v.TURNSTILE_SITE_KEY,
                secretKey: v.TURNSTILE_SECRET_KEY,
                verifyUrl: v.TURNSTILE_VERIFY_URL ?? TURNSTILE_SITEVERIFY_URL,
              }
            : null,
        captchaOff: v.CAPTCHA === "off",
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
