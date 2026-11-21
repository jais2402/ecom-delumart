import { afterEach, describe, expect, it, vi } from "vitest";
import { assertServerOnly } from "../src/server/server-only";

const saved = { NODE_ENV: process.env.NODE_ENV, AUTH_PROVIDER: process.env.AUTH_PROVIDER };

/** process.env.NODE_ENV is typed read-only by Next; tests change it to load the providers. */
const mutableEnv = process.env as Record<string, string | undefined>;

function setEnv(name: "NODE_ENV" | "AUTH_PROVIDER", value: string | undefined): void {
  if (value === undefined) delete mutableEnv[name];
  else mutableEnv[name] = value;
}

afterEach(() => {
  setEnv("NODE_ENV", saved.NODE_ENV);
  setEnv("AUTH_PROVIDER", saved.AUTH_PROVIDER);
  vi.resetModules();
});

describe("sign-in providers", () => {
  it("US-01: the dev provider refuses to load when NODE_ENV is production", async () => {
    vi.resetModules();
    setEnv("AUTH_PROVIDER", "dev");
    setEnv("NODE_ENV", "production");
    await expect(import("../src/server/auth/dev")).rejects.toThrow(/refused in production/);
  });

  it("US-01: the dev provider refuses to load unless AUTH_PROVIDER is 'dev'", async () => {
    for (const provider of ["supabase", undefined, "DEV"]) {
      vi.resetModules();
      setEnv("NODE_ENV", "development");
      setEnv("AUTH_PROVIDER", provider);
      await expect(import("../src/server/auth/dev")).rejects.toThrow(/AUTH_PROVIDER/);
    }
  });

  it("US-01: the dev provider loads in development with AUTH_PROVIDER=dev", async () => {
    vi.resetModules();
    setEnv("NODE_ENV", "development");
    setEnv("AUTH_PROVIDER", "dev");
    const dev = await import("../src/server/auth/dev");
    expect(dev.devAuthProvider().kind).toBe("dev");
  });

  it("US-01: the dev user id is stable per normalised email and keyed", async () => {
    vi.resetModules();
    setEnv("NODE_ENV", "test");
    setEnv("AUTH_PROVIDER", "dev");
    const { devUserId } = await import("../src/server/auth/dev");
    const key = Buffer.alloc(32, 7);
    const id = devUserId(key, "a@example.test");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(devUserId(key, "a@example.test")).toBe(id);
    expect(devUserId(Buffer.alloc(32, 8), "a@example.test")).not.toBe(id);
  });

  it("the supabase provider is a stub: every method throws", async () => {
    const { supabaseAuthProvider } = await import("../src/server/auth/supabase");
    const p = supabaseAuthProvider();
    const sid = "0192f6a0-0000-7000-8000-000000000001";
    await expect(p.beginSignIn("a@example.test")).rejects.toThrow(/not implemented/);
    await expect(p.completeDevSignIn("a@example.test")).rejects.toThrow(/not implemented/);
    await expect(p.signOut(sid)).rejects.toThrow(/not implemented/);
    await expect(p.verifiedEmail(sid)).rejects.toThrow(/not implemented/);
    await expect(p.sendPhoneCode(sid, "+919876543210")).rejects.toThrow(/not implemented/);
    await expect(p.verifyPhoneCode(sid, "000000")).rejects.toThrow(/not implemented/);
  });

  it("server modules refuse to run in a browser", () => {
    expect(() => assertServerOnly({ window: {} })).toThrow(/server-only/);
    expect(() => assertServerOnly({})).not.toThrow();
  });
});
