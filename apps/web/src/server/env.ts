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
  IDENTITY_KEY: hexKey,
  CARD_KEY: hexKey,
  PIN_PEPPER: hexKey,
  FIELD_KEY: hexKey,
  AUTH_PROVIDER: z.enum(["dev", "supabase"], { error: "must be 'dev' or 'supabase'" }),
  APP_ORIGIN: origin,
});

function loginOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return "";
  }
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
    const keys = [v.IDENTITY_KEY, v.CARD_KEY, v.PIN_PEPPER, v.FIELD_KEY].map((k) => k.toLowerCase());
    if (new Set(keys).size !== keys.length) {
      problems.push("IDENTITY_KEY, CARD_KEY, PIN_PEPPER and FIELD_KEY must be distinct keys");
    }
    if (v.DATABASE_URL_OWNER) {
      const owner = loginOf(v.DATABASE_URL_OWNER);
      if (loginOf(v.DATABASE_URL_WEB) === owner)
        problems.push("DATABASE_URL_WEB must not log in as the owner");
      if (loginOf(v.DATABASE_URL_PAY) === owner)
        problems.push("DATABASE_URL_PAY must not log in as the owner");
    }
    if (production && v.AUTH_PROVIDER === "dev") {
      problems.push("AUTH_PROVIDER 'dev' is refused when NODE_ENV is production");
    }
    if (production && v.DATABASE_URL_OWNER) {
      problems.push("DATABASE_URL_OWNER must not be set when NODE_ENV is production");
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
