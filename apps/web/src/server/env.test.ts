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
