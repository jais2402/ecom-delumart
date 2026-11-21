import { randomBytes } from "node:crypto";
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
});
