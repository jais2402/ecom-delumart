import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ChallengeDeps, requireChallenge } from "./captcha";
import { resetEnvCache } from "./env";

const NOW = Date.parse("2026-11-22T10:00:00Z");
const SECRET = "0x4AAAAAAAunitTestSecretKeyNotReal00";
const saved = { ...process.env };

function setEnv(captcha: boolean): void {
  const key = () => randomBytes(32).toString("hex");
  Object.assign(process.env, {
    NODE_ENV: "production",
    DATABASE_URL_WEB: "postgres://app_web:pw@127.0.0.1:5432/x",
    DATABASE_URL_PAY: "postgres://app_pay:pw@127.0.0.1:5432/x",
    IDENTITY_KEY: key(),
    CARD_KEY: key(),
    PIN_PEPPER: key(),
    FIELD_KEY: key(),
    AUTH_PROVIDER: "supabase",
    APP_ORIGIN: "https://shop.delulu.example",
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_Abc123def456ghi789",
    SUPABASE_SECRET_KEY: "sb_secret_Zyx987wvu654tsr321qpo",
  });
  delete process.env.DATABASE_URL_OWNER;
  delete process.env.RATE_LIMIT_MULTIPLIER;
  if (captcha) {
    process.env.TURNSTILE_SITE_KEY = "0x4AAAAAAAunitTestSiteKey";
    process.env.TURNSTILE_SECRET_KEY = SECRET;
    delete process.env.CAPTCHA;
  } else {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    process.env.CAPTCHA = "off";
  }
  resetEnvCache();
}

/** A local fake siteverify: records what it was sent, answers `answer`. */
function verifier(answer: Record<string, unknown> | (() => Promise<Response>)) {
  const seen: URLSearchParams[] = [];
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new URLSearchParams(String(init?.body ?? "")));
    if (typeof answer === "function") return answer();
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  const spent = new Set<string>();
  const deps: ChallengeDeps = {
    fetch: fakeFetch,
    nowMs: () => NOW,
    spend: async (d) => {
      if (spent.has(d)) return false;
      spent.add(d);
      return true;
    },
  };
  return { seen, deps };
}

const good = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  action: "email_start",
  hostname: "shop.delulu.example",
  challenge_ts: new Date(NOW - 20_000).toISOString(),
  "error-codes": [],
  ...overrides,
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "unknown",
  );

describe("ninth review, major 2a: Turnstile is verified on the server", () => {
  beforeEach(() => setEnv(true));
  afterAll(() => {
    process.env = saved;
    resetEnvCache();
  });

  it("major 2a: a fresh token for this action and host passes; the secret goes only to the verifier", async () => {
    const v = verifier(good());
    await requireChallenge("tok.en-1", "email_start", v.deps);
    expect(v.seen[0]?.get("secret")).toBe(SECRET);
    expect(v.seen[0]?.get("response")).toBe("tok.en-1");
  });

  it("major 2a: missing or malformed tokens are refused without asking the verifier", async () => {
    const v = verifier(good());
    for (const token of [undefined, null, "", 42, "has space", "x".repeat(2049)]) {
      expect(await codeOf(requireChallenge(token, "email_start", v.deps)), String(token)).toBe(
        "CAPTCHA_FAILED",
      );
    }
    expect(v.seen).toHaveLength(0);
  });

  it("major 2a: bound to the action, the host name and the token's age", async () => {
    for (const answer of [
      good({ success: false, "error-codes": ["invalid-input-response"] }),
      good({ action: "phone_code" }),
      good({ hostname: "evil.example" }),
      good({ challenge_ts: new Date(NOW - 301_000).toISOString() }),
      good({ challenge_ts: "not a time" }),
    ]) {
      const v = verifier(answer);
      expect(await codeOf(requireChallenge("t1", "email_start", v.deps)), JSON.stringify(answer)).toBe(
        "CAPTCHA_FAILED",
      );
    }
  });

  it("major 2a: single use: a token presented twice is refused the second time, even when the verifier says yes", async () => {
    const v = verifier(good());
    await requireChallenge("same-token", "email_start", v.deps);
    expect(await codeOf(requireChallenge("same-token", "email_start", v.deps))).toBe("CAPTCHA_FAILED");
    expect(v.seen).toHaveLength(1);
  });

  it("major 2a: fail closed: timeout, network error, 5xx or an unreadable answer refuse the request", async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => Promise.reject(new TypeError("fetch failed")),
      async () => new Response("oops", { status: 503 }),
      async () => new Response("<html>", { status: 200 }),
    ];
    for (const f of failures) {
      const v = verifier(f);
      expect(await codeOf(requireChallenge("t2", "email_start", v.deps))).toBe("CAPTCHA_FAILED");
    }
  });

  it("major 2a: CAPTCHA=off (and no keys) asks for nothing", async () => {
    setEnv(false);
    const v = verifier(good({ success: false }));
    await requireChallenge(undefined, "email_start", v.deps);
    expect(v.seen).toHaveLength(0);
  });
});
