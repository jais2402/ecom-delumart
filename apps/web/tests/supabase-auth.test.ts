/**
 * US-01 with the Supabase sign-in provider, end to end through the route handlers against a FAKE
 * Supabase Auth over real HTTP (tests/helpers/fake-supabase.ts: real P-256 keys, JWKS, PKCE codes
 * that work once, admin and logout endpoints) and the test database.
 */
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { safeReturnPath } from "../src/app/_lib/onboarding-flow";
import * as callback from "../src/app/api/v1/auth/callback/[state]/route";
import * as devSignIn from "../src/app/api/v1/auth/dev/sign-in/route";
import * as emailStart from "../src/app/api/v1/auth/email/start/route";
import * as emailVerify from "../src/app/api/v1/auth/email/verify/route";
import * as googleStart from "../src/app/api/v1/auth/google/start/route";
import { resetSupabaseAuthState } from "../src/server/auth/supabase";
import { resetEnvCache } from "../src/server/env";
import { APP_ORIGIN, startTestApp, type TestApp } from "./helpers/app";
import { Browser, type CallResult, str } from "./helpers/browser";
import { FakeSupabase } from "./helpers/fake-supabase";
import { ADULT_BIRTHDATE, R, uniqueEmail, uniquePhone } from "./helpers/flows";

let app: TestApp;
let fake: FakeSupabase;
/** Every Set-Cookie header and body the server sent in this file. */
const setCookies: string[] = [];
const bodies: string[] = [];

async function call(b: Browser, ...args: Parameters<Browser["call"]>): Promise<CallResult> {
  const result = await b.call(...args);
  setCookies.push(...result.headers.getSetCookie());
  bodies.push(result.text, result.headers.get("location") ?? "");
  return result;
}

async function browser(): Promise<Browser> {
  const b = new Browser();
  const token = await call(b, R.csrf.GET, "GET", "/api/v1/auth/csrf");
  b.csrfToken = str(token.json.csrfToken);
  return b;
}

const SESSION = "__Host-dm_session";
const FLOW = "__Host-dm_auth_flow";

/** Follows a link the fake "emailed" (or a Google redirect) into the callback route. */
async function followCallback(b: Browser, link: string): Promise<CallResult> {
  const url = new URL(link);
  const state = url.pathname.split("/").pop() ?? "";
  expect(url.pathname).toBe(`/api/v1/auth/callback/${state}`);
  return call(b, callback.GET, "GET", `${url.pathname}${url.search}`, { params: { state } });
}

async function emailSignIn(email = uniqueEmail(), next?: string): Promise<{ b: Browser; done: CallResult }> {
  const b = await browser();
  const started = await call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", {
    body: next === undefined ? { email } : { email, next },
  });
  expect(started.status).toBe(200);
  const mail = fake.lastEmail(email);
  if (!mail) throw new Error("no email sent");
  const done = await followCallback(b, mail.link);
  return { b, done };
}

function signedInTo(result: CallResult): boolean {
  return result.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=`) && !c.includes("Max-Age=0"));
}

beforeAll(async () => {
  app = await startTestApp({ env: { AUTH_PROVIDER: "supabase" } });
  fake = await new FakeSupabase().start(app.db.url);
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_PUBLISHABLE_KEY = fake.publishableKey;
  process.env.SUPABASE_SECRET_KEY = fake.secretKey;
  resetEnvCache();
  resetSupabaseAuthState();
});

afterEach(() => {
  fake.tokenMode = "valid";
  fake.jwksDown = false;
  vi.useRealTimers();
});

afterAll(async () => {
  await fake?.stop();
  await app?.stop();
  for (const k of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) delete process.env[k];
  resetEnvCache();
});

describe("US-01: Supabase sign-in (email link, email code, Google) with server-side PKCE", () => {
  it("email link: the callback exchanges the code, sets the opaque session cookie and goes on to the return path", async () => {
    const email = uniqueEmail();
    const { b, done } = await emailSignIn(email, "/p/moon-lamp");
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in/continue?next=%2Fp%2Fmoon-lamp`);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect(done.headers.get("referrer-policy")).toBe("no-referrer");
    expect(signedInTo(done)).toBe(true);
    // the flow cookie is spent
    expect(b.cookie(FLOW)).toBeUndefined();
    const sessionCookie = done.headers.getSetCookie().find((c) => c.startsWith(`${SESSION}=`)) ?? "";
    expect(sessionCookie).toMatch(
      /^__Host-dm_session=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
    );
    // the cookie holds the Supabase session id, which the database accepts
    const me = await call(b, R.me.GET, "GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.json.phoneVerification).toBe("sms");
  });

  it("email code: the code typed in the browser that asked signs in; in another browser, or for another address, it does not", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", { body: { email } });
    const code = fake.lastEmail(email)?.code ?? "";
    // another browser (no flow cookie) cannot use the code
    const other = await browser();
    const stolen = await call(other, emailVerify.POST, "POST", "/api/v1/auth/email/verify", {
      body: { email, code },
    });
    expect(stolen.status).toBe(422);
    // the right browser, another address: refused without asking Supabase
    const wrongAddress = await call(b, emailVerify.POST, "POST", "/api/v1/auth/email/verify", {
      body: { email: uniqueEmail(), code },
    });
    expect(wrongAddress.status).toBe(422);
    const wrong = await call(b, emailVerify.POST, "POST", "/api/v1/auth/email/verify", {
      body: { email, code: code === "000000" ? "111111" : "000000" },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error?.message).toBe(stolen.json.error?.message);
    const ok = await call(b, emailVerify.POST, "POST", "/api/v1/auth/email/verify", {
      body: { email, code },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ signedIn: true, csrfToken: ok.json.csrfToken, next: "/account" });
    b.csrfToken = str(ok.json.csrfToken);
    expect((await call(b, R.me.GET, "GET", "/api/v1/me")).status).toBe(200);
  });

  it("Google: start answers the Supabase authorize URL with an S256 challenge; the redirect back signs in", async () => {
    const b = await browser();
    const started = await call(b, googleStart.POST, "POST", "/api/v1/auth/google/start", {
      body: { next: "/cart" },
    });
    expect(started.status).toBe(200);
    const url = new URL(str(started.json.url));
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.url}/auth/v1/authorize`);
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_to")).toMatch(
      new RegExp(`^${APP_ORIGIN}/api/v1/auth/callback/[A-Za-z0-9_-]{43}$`),
    );
    const back = await fetch(url, { redirect: "manual" });
    expect(back.status).toBe(302);
    const done = await followCallback(b, back.headers.get("location") ?? "");
    expect(done.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in/continue?next=%2Fcart`);
    expect((await call(b, R.me.GET, "GET", "/api/v1/me")).status).toBe(200);
  });

  it("the answer to 'email me a link' is the same for a new and an existing account", async () => {
    const existing = uniqueEmail();
    await emailSignIn(existing);
    const a = await call(await browser(), emailStart.POST, "POST", "/api/v1/auth/email/start", {
      body: { email: existing },
    });
    const n = await call(await browser(), emailStart.POST, "POST", "/api/v1/auth/email/start", {
      body: { email: uniqueEmail() },
    });
    expect([a.status, a.text]).toEqual([n.status, n.text]);
    expect(a.json).toEqual({ next: "check-email" });
  });

  it("per-address email limit: the sixth link for one address in an hour is refused, whichever browser asks", async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await call(await browser(), emailStart.POST, "POST", "/api/v1/auth/email/start", {
            body: { email },
          })
        ).status,
      ).toBe(200);
    }
    const sixth = await call(await browser(), emailStart.POST, "POST", "/api/v1/auth/email/start", {
      body: { email },
    });
    expect(sixth.status).toBe(429);
    expect(sixth.json.error?.code).toBe("RATE_LIMITED");
  });
});

describe("US-01: the callback refuses every bad token, code, state and flow", () => {
  const modes = [
    "HS256",
    "none",
    "unknown-kid",
    "expired",
    "wrong-issuer",
    "wrong-audience",
    "other-project",
    "user-mismatch",
  ] as const;
  for (const mode of modes) {
    it(`a token that is ${mode}: no sign-in`, async () => {
      fake.tokenMode = mode;
      const { done } = await emailSignIn();
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in?error=link`);
      expect(signedInTo(done)).toBe(false);
    });
  }

  it("a code works once (replayed callback refused)", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", { body: { email } });
    const copy = new Browser();
    for (const [k, v] of b.jar) copy.jar.set(k, v);
    const link = fake.lastEmail(email)?.link ?? "";
    expect(signedInTo(await followCallback(b, link))).toBe(true);
    const replay = await followCallback(copy, link);
    expect(replay.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in?error=link`);
    expect(signedInTo(replay)).toBe(false);
  });

  it("a state that is not this browser's flow is refused before the code is used; no flow cookie (no verifier) is refused", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", { body: { email } });
    const link = new URL(fake.lastEmail(email)?.link ?? "");
    const tokenCalls = () => fake.requests.filter((r) => r.path === "/auth/v1/token").length;
    const before = tokenCalls();
    const forged = `/api/v1/auth/callback/${"A".repeat(43)}${link.search}`;
    const mismatch = await call(b, callback.GET, "GET", forged, { params: { state: "A".repeat(43) } });
    expect(mismatch.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in?error=link`);
    expect(tokenCalls()).toBe(before);
    // a browser without the flow (no verifier): refused, also without spending the code
    const stranger = await browser();
    const noFlow = await followCallback(stranger, link.toString());
    expect(noFlow.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in?error=link`);
    expect(tokenCalls()).toBe(before);
    // an altered flow cookie
    const flow = b.cookie(FLOW) ?? "";
    b.jar.set(FLOW, `${flow.slice(0, -2)}${flow.endsWith("A") ? "BB" : "AA"}`);
    expect((await followCallback(b, link.toString())).headers.get("location")).toBe(
      `${APP_ORIGIN}/sign-in?error=link`,
    );
    // a Supabase error redirect (no code)
    const errorBack = await call(
      await browser(),
      callback.GET,
      "GET",
      `/api/v1/auth/callback/x?error=access_denied`,
      {
        params: { state: "x" },
      },
    );
    expect(errorBack.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in?error=link`);
  });

  it("JWKS unreachable: fail closed (no sign-in)", async () => {
    resetSupabaseAuthState();
    fake.jwksDown = true;
    const { done } = await emailSignIn();
    expect(done.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in?error=link`);
    expect(signedInTo(done)).toBe(false);
    fake.jwksDown = false;
    resetSupabaseAuthState();
  });

  it("key rotation: a token signed with the project's new key is accepted after one JWKS re-read", async () => {
    expect(signedInTo((await emailSignIn()).done)).toBe(true);
    fake.rotateKey();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const jwksReads = () => fake.requests.filter((r) => r.path === "/auth/v1/.well-known/jwks.json").length;
    const before = jwksReads();
    expect(signedInTo((await emailSignIn()).done)).toBe(true);
    expect(jwksReads()).toBe(before + 1);
  });

  it("open redirects: any return path that is not a same-origin path becomes /account (property)", async () => {
    for (const next of [
      "//evil.example",
      "https://evil.example/x",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "javascript:alert(1)",
    ]) {
      const { done } = await emailSignIn(uniqueEmail(), next);
      expect(done.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in/continue?next=%2Faccount`);
    }
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (next) => {
        const b = await browser();
        const email = uniqueEmail();
        await call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", { body: { email, next } });
        const done = await followCallback(b, fake.lastEmail(email)?.link ?? "");
        const location = new URL(done.headers.get("location") ?? "");
        expect(location.origin).toBe(APP_ORIGIN);
        expect(location.pathname).toBe("/sign-in/continue");
        const back = location.searchParams.get("next") ?? "";
        expect(back.startsWith("/") && !back.startsWith("//")).toBe(true);
        expect(safeReturnPath(back, APP_ORIGIN)).toBe(back);
      }),
      { numRuns: 15 },
    );
  });
});

describe("US-01: sessions after sign-in", () => {
  it("a session deleted by Supabase (or the user banned) signs the browser out on its next request", async () => {
    const { b, done } = await emailSignIn();
    expect(signedInTo(done)).toBe(true);
    const sid = b.cookie(SESSION) ?? "";
    expect((await call(b, R.me.GET, "GET", "/api/v1/me")).status).toBe(200);
    await app.db.pool.query("DELETE FROM auth.sessions WHERE id = $1", [sid]);
    expect((await call(b, R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
  });

  it("sign-out ends the session in the database and clears the cookie; the old cookie no longer works", async () => {
    const { b } = await emailSignIn();
    const sid = b.cookie(SESSION) ?? "";
    const tokenFetch = await call(b, R.csrf.GET, "GET", "/api/v1/auth/csrf");
    b.csrfToken = str(tokenFetch.json.csrfToken);
    const out = await call(b, R.signOut.POST, "POST", "/api/v1/auth/sign-out");
    expect(out.status).toBe(200);
    expect(
      out.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    const again = new Browser();
    again.jar.set(SESSION, sid);
    expect((await call(again, R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
    const { rowCount } = await app.db.pool.query("SELECT 1 FROM core.ended_session WHERE session_id = $1", [
      sid,
    ]);
    expect(rowCount).toBe(1);
  });

  it("signing in again rotates the session: the previous one in this browser is ended", async () => {
    const email = uniqueEmail();
    const { b } = await emailSignIn(email);
    const first = b.cookie(SESSION) ?? "";
    b.csrfToken = str((await call(b, R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
    const again = await call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", { body: { email } });
    expect(again.status).toBe(200);
    await followCallback(b, fake.lastEmail(email)?.link ?? "");
    expect(b.cookie(SESSION)).not.toBe(first);
    const old = new Browser();
    old.jar.set(SESSION, first);
    expect((await call(old, R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
  });

  it("the dev sign-in route is refused (404) while AUTH_PROVIDER is supabase", async () => {
    const b = await browser();
    const res = await call(b, devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
      body: { email: uniqueEmail() },
    });
    expect(res.status).toBe(404);
  });
});

describe("US-01 / R3.1: the phone step with Supabase", () => {
  async function signedInBrowser(): Promise<Browser> {
    const { b } = await emailSignIn();
    const t = await call(b, R.csrf.GET, "GET", "/api/v1/auth/csrf");
    b.csrfToken = str(t.json.csrfToken);
    return b;
  }

  it("'sms' mode: the number is set with the admin API, the SMS code verifies it, the extra Supabase session is ended", async () => {
    const b = await signedInBrowser();
    const phone = uniquePhone();
    const sent = await call(b, R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone } });
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ sent: true });
    const sms = fake.sms[fake.sms.length - 1];
    if (!sms) throw new Error("no sms");
    const wrong = await call(b, R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", {
      body: { code: sms.code === "000000" ? "111111" : "000000" },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error?.details?.reason).toBe("WRONG_CODE");
    const ok = await call(b, R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", {
      body: { code: sms.code },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.onboarding?.phoneVerified).toBe(true);
    // the only live Supabase session of this user is the browser's
    const sid = b.cookie(SESSION) ?? "";
    const { rows } = await app.db.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM auth.sessions WHERE user_id = (SELECT user_id FROM auth.sessions WHERE id = $1)",
      [sid],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(
      (
        await call(b, R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
          body: { birthdate: ADULT_BIRTHDATE },
        })
      ).status,
    ).toBe(200);
    expect((await call(b, R.provision.POST, "POST", "/api/v1/onboarding/provision")).status).toBe(201);
  });

  it("'sms' mode: a number another account holds gets the same answer and no SMS", async () => {
    const a = await signedInBrowser();
    const phone = uniquePhone();
    await call(a, R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone } });
    const smsBefore = fake.sms.length;
    const b = await signedInBrowser();
    const res = await call(b, R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ sent: true });
    expect(fake.sms.length).toBe(smsBefore);
  });

  it("'unverified' mode (owner switch): the number is recorded without a code, marked unverified, one account per number", async () => {
    await app.db.pool.query(
      "UPDATE core.deployment_setting SET value = 'unverified' WHERE key = 'identity.phone_verification'",
    );
    try {
      const b = await signedInBrowser();
      const phone = uniquePhone();
      const smsBefore = fake.sms.length;
      const res = await call(b, R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone } });
      expect(res.status).toBe(200);
      expect(res.json.recorded).toBe(true);
      expect(res.json.onboarding?.phoneVerified).toBe(true);
      expect(fake.sms.length).toBe(smsBefore);
      expect((await call(b, R.me.GET, "GET", "/api/v1/me")).json.phoneVerification).toBe("unverified");
      const sid = b.cookie(SESSION) ?? "";
      const { rows } = await app.db.pool.query<{ v: boolean }>(
        "SELECT p.phone_verified AS v FROM core.user_profile p JOIN auth.sessions s ON s.user_id = p.id WHERE s.id = $1",
        [sid],
      );
      expect(rows[0]?.v).toBe(false);
      const verify = await call(b, R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", {
        body: { code: "123456" },
      });
      expect(verify.status).toBe(404);
      const other = await signedInBrowser();
      const dup = await call(other, R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone } });
      expect(dup.status).toBe(409);
      expect(
        (
          await call(b, R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
            body: { birthdate: ADULT_BIRTHDATE },
          })
        ).status,
      ).toBe(200);
      expect((await call(b, R.provision.POST, "POST", "/api/v1/onboarding/provision")).status).toBe(201);
    } finally {
      await app.db.pool.query(
        "UPDATE core.deployment_setting SET value = 'sms' WHERE key = 'identity.phone_verification'",
      );
    }
  });
});

describe("US-01: Supabase credentials stay on the server", () => {
  it("no access or refresh token ever appears in a Set-Cookie header, a response body or a redirect", () => {
    expect(fake.issuedTokens.length).toBeGreaterThan(5);
    const everything = [...setCookies, ...bodies].join("\n");
    for (const t of [...fake.issuedTokens, ...fake.refreshTokens]) expect(everything).not.toContain(t);
    expect(everything).not.toContain(fake.secretKey);
    expect(everything).not.toContain(fake.publishableKey);
  });

  it("the secret key is sent only to the admin endpoints; public endpoints get the publishable key", () => {
    const secret = fake.requests.filter((r) => r.key === "secret");
    expect(secret.length).toBeGreaterThan(0);
    for (const r of secret) expect(r.path).toMatch(/^\/auth\/v1\/admin\/users\//);
    for (const r of fake.requests.filter((x) => x.path.startsWith("/auth/v1/admin/")))
      expect(r.key).toBe("secret");
    for (const r of fake.requests) expect(r.key).not.toBe("other");
    // the secret key is never sent as a bearer token
    for (const r of fake.requests.filter((x) => x.bearer)) expect(r.path).toBe("/auth/v1/logout");
  });
});
