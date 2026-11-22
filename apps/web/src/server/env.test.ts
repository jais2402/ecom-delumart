import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const key = () => randomBytes(32).toString("hex");

function valid(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    DATABASE_URL_WEB: "postgres://app_web:pw@127.0.0.1:5432/delulu_dev",
    DATABASE_URL_PAY: "postgres://app_pay:pw@127.0.0.1:5432/delulu_dev",
    DATABASE_URL_OWNER: "postgres://postgres:postgres@127.0.0.1:5432/delulu_dev",
    IDENTITY_KEY: key(),
    CARD_KEY: key(),
    PIN_PEPPER: key(),
    FIELD_KEY: key(),
    AUTH_PROVIDER: "dev",
    APP_ORIGIN: "http://localhost:3000",
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_Abc123def456ghi789",
    SUPABASE_SECRET_KEY: "sb_secret_Zyx987wvu654tsr321qpo",
    ...overrides,
  };
}

describe("server configuration", () => {
  it("parses a complete development environment into keys and urls", () => {
    const source = valid();
    const env = parseEnv(source);
    expect(env.identityKey).toEqual(Buffer.from(source.IDENTITY_KEY as string, "hex"));
    expect(env.fieldKey.length).toBe(32);
    expect(env.authProvider).toBe("dev");
    expect(env.appOrigin).toBe("http://localhost:3000");
    expect(env.databaseUrlOwner).toBe(source.DATABASE_URL_OWNER);
  });

  it("fails fast naming every bad variable, never echoing a value", () => {
    const secret = "deadbeef".repeat(7); // 56 hex characters: too short
    const source = valid({ PIN_PEPPER: secret, CARD_KEY: undefined, APP_ORIGIN: "not a url" });
    let message = "";
    try {
      parseEnv(source);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("PIN_PEPPER");
    expect(message).toContain("CARD_KEY");
    expect(message).toContain("APP_ORIGIN");
    expect(message).not.toContain(secret);
  });

  it("refuses an APP_ORIGIN with a path", () => {
    expect(() => parseEnv(valid({ APP_ORIGIN: "https://delulu.example/app" }))).toThrow(/APP_ORIGIN/);
  });

  it("refuses the same key for two purposes", () => {
    const shared = key();
    expect(() => parseEnv(valid({ CARD_KEY: shared, FIELD_KEY: shared }))).toThrow(/distinct/);
  });

  it("refuses a web or pay connection that logs in as the owner", () => {
    expect(() =>
      parseEnv(valid({ DATABASE_URL_WEB: "postgres://postgres:postgres@127.0.0.1:5432/delulu_dev" })),
    ).toThrow(/DATABASE_URL_WEB/);
  });

  it("refuses the dev sign-in provider and the owner credential in production", () => {
    expect(() => parseEnv(valid({ NODE_ENV: "production" }))).toThrow(/AUTH_PROVIDER/);
    expect(() => parseEnv(valid({ NODE_ENV: "production", AUTH_PROVIDER: "supabase" }))).toThrow(
      /DATABASE_URL_OWNER/,
    );
    const prod = parseEnv(
      valid({ NODE_ENV: "production", AUTH_PROVIDER: "supabase", DATABASE_URL_OWNER: undefined }),
    );
    expect(prod.databaseUrlOwner).toBeNull();
    const empty = parseEnv(
      valid({ NODE_ENV: "production", AUTH_PROVIDER: "supabase", DATABASE_URL_OWNER: "" }),
    );
    expect(empty.databaseUrlOwner).toBeNull();
  });

  describe("fifth security review: placeholder keys are refused in production", () => {
    const production = (overrides: Record<string, string | undefined> = {}) =>
      valid({
        NODE_ENV: "production",
        AUTH_PROVIDER: "supabase",
        DATABASE_URL_OWNER: undefined,
        ...overrides,
      });

    it("a complete production environment with random keys parses", () => {
      expect(parseEnv(production()).nodeEnv).toBe("production");
    });

    it.each(["IDENTITY_KEY", "CARD_KEY", "PIN_PEPPER", "FIELD_KEY"])(
      "%s made of one repeated byte is refused, never echoed",
      (name) => {
        for (const byte of ["00", "ff", "41", "a5"]) {
          const value = byte.repeat(32);
          let message = "";
          try {
            parseEnv(production({ [name]: value }));
          } catch (error) {
            message = (error as Error).message;
          }
          expect(message, byte).toContain(name);
          expect(message).not.toContain(value);
        }
      },
    );

    it("the documented example values (apps/web/.env.example) are refused", () => {
      const example = readFileSync(fileURLToPath(new URL("../../.env.example", import.meta.url)), "utf8");
      const values: Record<string, string> = {};
      for (const m of example.matchAll(
        /^(IDENTITY_KEY|CARD_KEY|PIN_PEPPER|FIELD_KEY)=([0-9a-fA-F]{64})$/gm,
      )) {
        if (m[1] && m[2]) values[m[1]] = m[2];
      }
      expect(Object.keys(values).sort()).toEqual(["CARD_KEY", "FIELD_KEY", "IDENTITY_KEY", "PIN_PEPPER"]);
      for (const [name, value] of Object.entries(values)) {
        expect(() => parseEnv(production({ [name]: value })), name).toThrow(new RegExp(name));
      }
    });

    it("two equal keys, keys shorter than 32 bytes, AUTH_PROVIDER=dev and an owner URL are refused", () => {
      const shared = key();
      expect(() => parseEnv(production({ IDENTITY_KEY: shared, PIN_PEPPER: shared }))).toThrow(/distinct/);
      expect(() => parseEnv(production({ FIELD_KEY: randomBytes(31).toString("hex") }))).toThrow(/FIELD_KEY/);
      expect(() => parseEnv(production({ AUTH_PROVIDER: "dev" }))).toThrow(/AUTH_PROVIDER/);
      expect(() =>
        parseEnv(production({ DATABASE_URL_OWNER: "postgres://migrator:pw@127.0.0.1:5432/delulu" })),
      ).toThrow(/DATABASE_URL_OWNER/);
    });

    it("development still accepts the example values (local setup only)", () => {
      expect(() => parseEnv(valid({ IDENTITY_KEY: "00".repeat(32) }))).not.toThrow();
    });
  });

  describe("fifth security review: trusted proxy hops and test-only rate limit scaling", () => {
    it("TRUSTED_PROXY_HOPS defaults to 0 and accepts small non-negative integers", () => {
      expect(parseEnv(valid()).trustedProxyHops).toBe(0);
      expect(parseEnv(valid({ TRUSTED_PROXY_HOPS: "2" })).trustedProxyHops).toBe(2);
      for (const bad of ["-1", "1.5", "x", "100"]) {
        expect(() => parseEnv(valid({ TRUSTED_PROXY_HOPS: bad })), bad).toThrow(/TRUSTED_PROXY_HOPS/);
      }
    });

    it("RATE_LIMIT_MULTIPLIER is for tests and development only: refused in production", () => {
      expect(parseEnv(valid()).rateLimitMultiplier).toBe(1);
      expect(parseEnv(valid({ RATE_LIMIT_MULTIPLIER: "50" })).rateLimitMultiplier).toBe(50);
      expect(() =>
        parseEnv(
          valid({
            NODE_ENV: "production",
            AUTH_PROVIDER: "supabase",
            DATABASE_URL_OWNER: undefined,
            RATE_LIMIT_MULTIPLIER: "50",
          }),
        ),
      ).toThrow(/RATE_LIMIT_MULTIPLIER/);
    });
  });
});

describe("job runner configuration", () => {
  it("DATABASE_URL_JOBS and JOBS_SIGNING_KEY are optional; without them the server runs no jobs", () => {
    const env = parseEnv(valid());
    expect(env.databaseUrlJobs).toBeNull();
    expect(env.jobsSigningKey).toBeNull();
    const jobsKey = key();
    const set = parseEnv(
      valid({
        DATABASE_URL_JOBS: "postgres://app_jobs:pw@127.0.0.1:5432/delulu_dev",
        JOBS_SIGNING_KEY: jobsKey,
      }),
    );
    expect(set.databaseUrlJobs).toBe("postgres://app_jobs:pw@127.0.0.1:5432/delulu_dev");
    expect(set.jobsSigningKey).toEqual(Buffer.from(jobsKey, "hex"));
  });

  it("the jobs login is never the owner, and the signing key is a distinct 32-byte key", () => {
    expect(() =>
      parseEnv(valid({ DATABASE_URL_JOBS: "postgres://postgres:other@127.0.0.1:5432/delulu_dev" })),
    ).toThrow(/DATABASE_URL_JOBS must not log in as the owner/);
    expect(() => parseEnv(valid({ JOBS_SIGNING_KEY: "abc" }))).toThrow(/JOBS_SIGNING_KEY/);
    const shared = key();
    expect(() => parseEnv(valid({ FIELD_KEY: shared, JOBS_SIGNING_KEY: shared }))).toThrow(/distinct/);
  });

  it("production refuses a placeholder signing key, never echoing it", () => {
    const placeholder = "0000000000000000000000000000000000000000000000000000000000000004";
    let message = "";
    try {
      parseEnv(
        valid({
          NODE_ENV: "production",
          AUTH_PROVIDER: "supabase",
          DATABASE_URL_OWNER: undefined,
          JOBS_SIGNING_KEY: placeholder,
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("JOBS_SIGNING_KEY is a placeholder");
    expect(message).not.toContain(placeholder);
  });
});

describe("analytics configuration (0052)", () => {
  it("R16.5: ANALYTICS_KEY is optional (no key: nothing is recorded), and must differ from every other key", () => {
    expect(parseEnv(valid()).analyticsKey).toBeNull();
    const k = key();
    expect(parseEnv(valid({ ANALYTICS_KEY: k })).analyticsKey).toEqual(Buffer.from(k, "hex"));
    const shared = key();
    expect(() => parseEnv(valid({ IDENTITY_KEY: shared, ANALYTICS_KEY: shared }))).toThrow(/distinct/);
    expect(() =>
      parseEnv(
        valid({
          NODE_ENV: "production",
          AUTH_PROVIDER: "supabase",
          DATABASE_URL_OWNER: undefined,
          ANALYTICS_KEY: "0000000000000000000000000000000000000000000000000000000000000005",
        }),
      ),
    ).toThrow(/ANALYTICS_KEY is a placeholder/);
  });

  it("R7.1: geo headers are read only on the Vercel edge unless GEO_SOURCE says otherwise", () => {
    expect(parseEnv(valid()).geoSource).toBe("none");
    expect(parseEnv(valid({ VERCEL: "1" })).geoSource).toBe("vercel");
    expect(parseEnv(valid({ VERCEL: "1", GEO_SOURCE: "none" })).geoSource).toBe("none");
    expect(() => parseEnv(valid({ GEO_SOURCE: "cloudflare" }))).toThrow(/GEO_SOURCE/);
  });

  it("R7.1: DEV_GEO fixes a place in development and is refused in production", () => {
    expect(parseEnv(valid({ DEV_GEO: "IN/MH/Navi%20Mumbai" })).devGeo).toEqual({
      country: "IN",
      region: "MH",
      city: "Navi%20Mumbai",
    });
    expect(parseEnv(valid({ DEV_GEO: "IN" })).devGeo).toEqual({ country: "IN", region: null, city: null });
    expect(() => parseEnv(valid({ DEV_GEO: "India, Mumbai" }))).toThrow(/DEV_GEO/);
    expect(() =>
      parseEnv(
        valid({
          NODE_ENV: "production",
          AUTH_PROVIDER: "supabase",
          DATABASE_URL_OWNER: undefined,
          DEV_GEO: "IN",
        }),
      ),
    ).toThrow(/DEV_GEO must not be set/);
  });
});

describe("deployment configuration (Vercel + Supabase)", () => {
  const prod = (overrides: Record<string, string | undefined> = {}) =>
    valid({
      NODE_ENV: "production",
      AUTH_PROVIDER: "supabase",
      DATABASE_URL_OWNER: undefined,
      APP_ORIGIN: "https://delulu.example",
      DATABASE_URL_WEB:
        "postgres://app_web.abcdefghijklmnopqrst:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
      DATABASE_URL_PAY:
        "postgres://app_pay.abcdefghijklmnopqrst:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
      ...overrides,
    });
  const messageOf = (source: Record<string, string | undefined>): string => {
    try {
      parseEnv(source);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("US-01: AUTH_PROVIDER=supabase needs SUPABASE_URL and both keys; the secret key is never echoed", () => {
    const parsed = parseEnv(prod());
    expect(parsed.supabase).toEqual({
      url: "https://abcdefghijklmnopqrst.supabase.co",
      publishableKey: "sb_publishable_Abc123def456ghi789",
      secretKey: "sb_secret_Zyx987wvu654tsr321qpo",
    });
    for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) {
      expect(messageOf(prod({ [name]: undefined })), name).toContain(name);
    }
    // the keys swapped, or a legacy JWT key: refused by shape, without repeating it
    const m = messageOf(prod({ SUPABASE_SECRET_KEY: "sb_publishable_Abc123def456ghi789" }));
    expect(m).toContain("SUPABASE_SECRET_KEY");
    expect(m).not.toContain("Abc123def456ghi789");
    expect(messageOf(prod({ SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.x" }))).toContain(
      "SUPABASE_PUBLISHABLE_KEY",
    );
    // the dev provider does not need them
    expect(
      parseEnv(
        valid({
          SUPABASE_URL: undefined,
          SUPABASE_PUBLISHABLE_KEY: undefined,
          SUPABASE_SECRET_KEY: undefined,
        }),
      ).supabase,
    ).toBeNull();
  });

  it("production needs an https APP_ORIGIN and an https SUPABASE_URL (http only for a loopback smoke test)", () => {
    expect(messageOf(prod({ APP_ORIGIN: "http://delulu.example" }))).toContain("APP_ORIGIN must be https");
    expect(messageOf(prod({ SUPABASE_URL: "http://abcdefghijklmnopqrst.supabase.co" }))).toContain(
      "SUPABASE_URL must be https",
    );
    expect(messageOf(prod({ SUPABASE_URL: "https://x.supabase.co/auth/v1" }))).toContain("SUPABASE_URL");
    expect(
      parseEnv(
        prod({
          APP_ORIGIN: "http://localhost:3400",
          SUPABASE_URL: "http://127.0.0.1:3401",
          DATABASE_URL_WEB: "postgres://app_web:pw@127.0.0.1:5432/x",
          DATABASE_URL_PAY: "postgres://app_pay:pw@127.0.0.1:5432/x",
        }),
      ).appOrigin,
    ).toBe("http://localhost:3400");
  });

  it("database TLS: verified by default for a remote host, refused off in production unless every host is loopback", () => {
    expect(parseEnv(prod()).databaseTls).toBe("verify-full");
    expect(parseEnv(valid()).databaseTls).toBe("disable");
    expect(messageOf(prod({ DATABASE_TLS: "disable" }))).toContain("DATABASE_TLS");
    expect(() => parseEnv(valid({ DATABASE_TLS: "require" }))).toThrow(/DATABASE_TLS/);
    const pem = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";
    expect(parseEnv(prod({ DATABASE_CA_CERT: pem })).databaseCa).toContain("BEGIN CERTIFICATE");
    expect(parseEnv(prod({ DATABASE_CA_CERT: Buffer.from(pem).toString("base64") })).databaseCa).toContain(
      "BEGIN CERTIFICATE",
    );
    expect(messageOf(prod({ DATABASE_CA_CERT: "nonsense" }))).toContain("DATABASE_CA_CERT");
  });

  it("CRON_SECRET is optional, long and random; serverless sizing follows VERCEL=1; the commit is read for /api/health", () => {
    expect(parseEnv(prod()).cronSecret).toBeNull();
    const secret = randomBytes(32).toString("hex");
    expect(parseEnv(prod({ CRON_SECRET: secret })).cronSecret).toBe(secret);
    const m = messageOf(prod({ CRON_SECRET: "short" }));
    expect(m).toContain("CRON_SECRET");
    expect(m).not.toContain("short");
    expect(messageOf(prod({ CRON_SECRET: "a".repeat(64) }))).toContain("CRON_SECRET is a placeholder");
    expect(parseEnv(prod({ VERCEL: "1" })).serverless).toBe(true);
    expect(parseEnv(prod()).serverless).toBe(false);
    expect(parseEnv(prod({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" })).commit).toBe(
      "0123456789ab",
    );
    expect(parseEnv(prod({ VERCEL_GIT_COMMIT_SHA: "not a sha" })).commit).toBeNull();
  });
});
