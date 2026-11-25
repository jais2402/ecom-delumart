/**
 * US-01 with the Supabase sign-in provider, end to end through the route handlers against a FAKE
 * Supabase Auth over real HTTP (tests/helpers/fake-supabase.ts: real P-256 keys, JWKS, PKCE codes
 * and token hashes that work once, admin and logout endpoints, and a fake Turnstile verifier) and a
 * test database whose auth.* tables are shaped like Supabase's.
 *
 * Ninth security review: emailed links are redeemed only by the interstitial's POST (minor 6c);
 * Turnstile on email start, email code and the phone step (major 2a); per-(email, network) limits
 * (major 2b); only registered sessions sign in (minor 4); phone squatting (major 1).
 */
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { safeReturnPath } from "../src/app/_lib/onboarding-flow";
import * as callback from "../src/app/api/v1/auth/callback/[state]/route";
import * as devSignIn from "../src/app/api/v1/auth/dev/sign-in/route";
import * as emailConfirm from "../src/app/api/v1/auth/email/confirm/route";
import * as emailStart from "../src/app/api/v1/auth/email/start/route";
import * as emailVerify from "../src/app/api/v1/auth/email/verify/route";
import * as googleStart from "../src/app/api/v1/auth/google/start/route";
import { resetSupabaseAuthState } from "../src/server/auth/supabase";
import { jobsPool } from "../src/server/db";
import { resetEnvCache } from "../src/server/env";
import { runJobs } from "../src/server/jobs";
import { APP_ORIGIN, startTestApp, type TestApp } from "./helpers/app";
import { Browser, type CallResult, str } from "./helpers/browser";
import { FakeSupabase } from "./helpers/fake-supabase";
import { ADULT_BIRTHDATE, R, uniqueEmail, uniquePhone } from "./helpers/flows";

let app: TestApp;
let fake: FakeSupabase;
/** Every Set-Cookie header and body the server sent in this file. */
const setCookies: string[] = [];
const bodies: string[] = [];
const TURNSTILE_SECRET = "0x4AAAAAAAtestSecretForTheFakeVerifier";

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
const NOT_SENT =
  "We couldn't send a code to that number right now. Try again in a few minutes or use a different number.";
const challenge = (action: string) => FakeSupabase.challenge(action);

async function startEmail(b: Browser, email: string, next?: string): Promise<CallResult> {
  return call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", {
    body: { email, ...(next === undefined ? {} : { next }), challenge: challenge("email_start") },
  });
}

/** Presses the interstitial's button for a link the fake "emailed". */
async function confirmLink(b: Browser, link: string): Promise<CallResult> {
  const url = new URL(link);
  expect(`${url.origin}${url.pathname}`).toBe(`${APP_ORIGIN}/sign-in/confirm`);
  const tokenHash = url.searchParams.get("token_hash");
  const body = tokenHash
    ? { tokenHash, type: url.searchParams.get("type") ?? "" }
    : { code: url.searchParams.get("code") ?? "" };
  return call(b, emailConfirm.POST, "POST", "/api/v1/auth/email/confirm", { body });
}

/** Follows a Google redirect into the callback route. */
async function followCallback(b: Browser, link: string): Promise<CallResult> {
  const url = new URL(link);
  const state = url.pathname.split("/").pop() ?? "";
  expect(url.pathname).toBe(`/api/v1/auth/callback/${state}`);
  return call(b, callback.GET, "GET", `${url.pathname}${url.search}`, { params: { state } });
}

async function emailSignIn(email = uniqueEmail(), next?: string): Promise<{ b: Browser; done: CallResult }> {
  const b = await browser();
  const started = await startEmail(b, email, next);
  expect(started.status).toBe(200);
  const mail = fake.lastEmail(email);
  if (!mail) throw new Error("no email sent");
  const done = await confirmLink(b, mail.link);
  if (done.status === 200) b.csrfToken = str(done.json.csrfToken);
  return { b, done };
}

function signedInTo(result: CallResult): boolean {
  return result.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=`) && !c.includes("Max-Age=0"));
}

const requestsTo = (path: string) => fake.requests.filter((r) => r.path === path).length;

beforeAll(async () => {
  app = await startTestApp({ env: { AUTH_PROVIDER: "supabase", GOOGLE_SIGN_IN: "on" }, supabaseAuth: true });
  fake = await new FakeSupabase().start(app.db.url);
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_PUBLISHABLE_KEY = fake.publishableKey;
  process.env.SUPABASE_SECRET_KEY = fake.secretKey;
  process.env.TURNSTILE_SITE_KEY = "0x4AAAAAAAtestSiteKey";
  process.env.TURNSTILE_SECRET_KEY = TURNSTILE_SECRET;
  process.env.TURNSTILE_VERIFY_URL = `${fake.url}/turnstile/v0/siteverify`;
  resetEnvCache();
  resetSupabaseAuthState();
});

afterEach(() => {
  fake.tokenMode = "valid";
  fake.jwksDown = false;
  fake.captchaMode = "pass";
  fake.emailLink = "token_hash";
  vi.useRealTimers();
});

afterAll(async () => {
  await fake?.stop();
  await app?.stop();
  for (const k of [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET_KEY",
    "TURNSTILE_VERIFY_URL",
  ])
    delete process.env[k];
  resetEnvCache();
});

describe("US-01: Supabase sign-in (email link, email code, Google) with server-side PKCE", () => {
  it("minor 6c: the emailed link opens the interstitial; the button's POST redeems it, sets the opaque session cookie and answers the return path", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await startEmail(b, email, "/p/moon-lamp");
    const link = fake.lastEmail(email)?.link ?? "";
    expect(new URL(link).pathname).toBe("/sign-in/confirm");
    const done = await confirmLink(b, link);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ signedIn: true, csrfToken: done.json.csrfToken, next: "/p/moon-lamp" });
    expect(done.headers.get("cache-control")).toBe("private, no-store");
    expect(signedInTo(done)).toBe(true);
    // the flow cookie is spent
    expect(b.cookie(FLOW)).toBeUndefined();
    const sessionCookie = done.headers.getSetCookie().find((c) => c.startsWith(`${SESSION}=`)) ?? "";
    expect(sessionCookie).toMatch(
      /^__Host-dm_session=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
    );
    b.csrfToken = str(done.json.csrfToken);
    const me = await call(b, R.me.GET, "GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.json.phoneVerification).toBe("sms");
  });

  it("minor 6c: a GET never redeems: the callback refuses an email flow without asking Supabase, and the confirm route has no GET", async () => {
    const email = uniqueEmail();
    const b = await browser();
    fake.emailLink = "code"; // a link that went through Supabase's own verify page
    await startEmail(b, email);
    const link = new URL(fake.lastEmail(email)?.link ?? "");
    expect(link.pathname).toBe("/sign-in/confirm");
    const before = [requestsTo("/auth/v1/token"), requestsTo("/auth/v1/verify")];
    // a scanner (or even this browser, with its flow cookie) following it to the callback: refused,
    // nothing spent
    const copy = new Browser();
    for (const [k, v] of b.jar) copy.jar.set(k, v);
    const state = "A".repeat(43);
    const viaCallback = await call(
      copy,
      callback.GET,
      "GET",
      `/api/v1/auth/callback/${state}${link.search}`,
      {
        params: { state },
      },
    );
    expect(viaCallback.headers.get("location")).toBe(`${APP_ORIGIN}/sign-in?error=link`);
    expect([requestsTo("/auth/v1/token"), requestsTo("/auth/v1/verify")]).toEqual(before);
    expect("GET" in emailConfirm).toBe(false);
    // the button's POST, in the browser that asked, exchanges it with this browser's verifier
    const done = await confirmLink(b, link.toString());
    expect(done.status).toBe(200);
    expect(signedInTo(done)).toBe(true);
  });

  it("email code: the code typed in the browser that asked signs in; in another browser, or for another address, it does not", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await startEmail(b, email);
    const code = fake.lastEmail(email)?.code ?? "";
    const verify = (x: Browser, body: Record<string, unknown>) =>
      call(x, emailVerify.POST, "POST", "/api/v1/auth/email/verify", {
        body: { ...body, challenge: challenge("email_verify") },
      });
    // another browser (no flow cookie) cannot use the code
    const other = await browser();
    const stolen = await verify(other, { email, code });
    expect(stolen.status).toBe(422);
    // the right browser, another address: refused without asking Supabase
    const wrongAddress = await verify(b, { email: uniqueEmail(), code });
    expect(wrongAddress.status).toBe(422);
    const wrong = await verify(b, { email, code: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error?.message).toBe(stolen.json.error?.message);
    const ok = await verify(b, { email, code });
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
    const a = await startEmail(await browser(), existing);
    const n = await startEmail(await browser(), uniqueEmail());
    expect([a.status, a.text]).toEqual([n.status, n.text]);
    expect(a.json).toEqual({ next: "check-email" });
  });

  it("major 2b: per (email, client network): the sixth link from one network is refused, while the owner on another network still gets one; a higher ceiling per address from all networks", async () => {
    const email = uniqueEmail();
    const attackerNet = "2001:db8:aaaa:1";
    const fromAttacker = async () => {
      const b = await browser();
      b.peer = `${attackerNet}::${Math.floor(Math.random() * 0xffff).toString(16)}`;
      return startEmail(b, email);
    };
    for (let i = 0; i < 5; i++) expect((await fromAttacker()).status).toBe(200);
    const sixth = await fromAttacker();
    expect(sixth.status).toBe(429);
    expect(sixth.json.error?.code).toBe("RATE_LIMITED");
    // the owner, on their own network, is not locked out by the stranger
    expect((await startEmail(await browser(), email)).status).toBe(200);
    // the ceiling per address: 20 an hour from all networks together (6 counted so far)
    for (let i = 0; i < 14; i++) expect((await startEmail(await browser(), email)).status, `${i}`).toBe(200);
    expect((await startEmail(await browser(), email)).status).toBe(429);
  });
});

describe("major 2a: Cloudflare Turnstile on email start, email code and the phone step", () => {
  it("major 2a: no token, a refused token, a token for another action or one used twice: CAPTCHA_FAILED, and none of them counts against the address", async () => {
    const email = uniqueEmail();
    const b = await browser();
    const send = (extra: Record<string, unknown>) =>
      call(b, emailStart.POST, "POST", "/api/v1/auth/email/start", { body: { email, ...extra } });
    const used = challenge("email_start");
    expect((await send({ challenge: used })).status).toBe(200);
    const refusals = [
      await send({}),
      await send({ challenge: "not-a-token at all" }),
      await send({ challenge: challenge("phone_code") }),
      await send({ challenge: used }),
    ];
    fake.captchaMode = "fail";
    refusals.push(await send({ challenge: challenge("email_start") }));
    fake.captchaMode = "pass";
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe("CAPTCHA_FAILED");
    }
    // 5 refused + 1 good so far: the per-(email, network) allowance of 5 is still nearly whole
    for (let i = 0; i < 4; i++)
      expect((await send({ challenge: challenge("email_start") })).status).toBe(200);
    expect((await send({ challenge: challenge("email_start") })).status).toBe(429);
  });

  it("major 2a: the email code and the phone step need a token too; the token is never sent to Supabase", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await startEmail(b, email);
    const code = fake.lastEmail(email)?.code ?? "";
    const noToken = await call(b, emailVerify.POST, "POST", "/api/v1/auth/email/verify", {
      body: { email, code },
    });
    expect(noToken.json.error?.code).toBe("CAPTCHA_FAILED");
    const { b: player } = await emailSignIn();
    const phone = await call(player, R.phone.POST, "POST", "/api/v1/onboarding/phone", {
      body: { phone: uniquePhone() },
    });
    expect(phone.json.error?.code).toBe("CAPTCHA_FAILED");
    expect(fake.otpBodyKeys.flat()).not.toContain("captcha_token");
    expect(fake.otpBodyKeys.flat()).not.toContain("gotrue_meta_security");
  });
});

describe("US-01: the confirm step refuses every bad token, link, flow and address", () => {
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
      expect(done.status).toBe(422);
      expect(signedInTo(done)).toBe(false);
    });
  }

  it("a link works once (a replayed confirm is refused)", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await startEmail(b, email);
    const copy = new Browser();
    for (const [k, v] of b.jar) copy.jar.set(k, v);
    copy.csrfToken = b.csrfToken;
    const link = fake.lastEmail(email)?.link ?? "";
    expect(signedInTo(await confirmLink(b, link))).toBe(true);
    const replay = await confirmLink(copy, link);
    expect(replay.status).toBe(422);
    expect(signedInTo(replay)).toBe(false);
  });

  it("another browser (no flow) is refused without spending the link; an altered flow cookie too", async () => {
    const email = uniqueEmail();
    const b = await browser();
    await startEmail(b, email);
    const link = fake.lastEmail(email)?.link ?? "";
    const before = requestsTo("/auth/v1/verify");
    const stranger = await browser();
    expect((await confirmLink(stranger, link)).status).toBe(422);
    const flow = b.cookie(FLOW) ?? "";
    const altered = new Browser();
    altered.jar.set(FLOW, `${flow.slice(0, -2)}${flow.endsWith("A") ? "BB" : "AA"}`);
    altered.csrfToken = str((await call(altered, R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
    expect((await confirmLink(altered, link)).status).toBe(422);
    expect(requestsTo("/auth/v1/verify")).toBe(before);
    // malformed link parameters are refused by shape
    const bad = await call(b, emailConfirm.POST, "POST", "/api/v1/auth/email/confirm", {
      body: { tokenHash: "zz", type: "recovery" },
    });
    expect(bad.status).toBe(400);
    expect(signedInTo(await confirmLink(b, link))).toBe(true);
  });

  it("a link for ANOTHER address, pressed in this browser's flow: refused, and the session it created is ended", async () => {
    const mine = uniqueEmail();
    const theirs = uniqueEmail();
    const b = await browser();
    await startEmail(b, mine);
    await startEmail(await browser(), theirs);
    const sessionsBefore = Number(
      (await app.db.pool.query("SELECT count(*) AS n FROM auth.sessions")).rows[0]?.n,
    );
    const r = await confirmLink(b, fake.lastEmail(theirs)?.link ?? "");
    expect(r.status).toBe(422);
    expect(signedInTo(r)).toBe(false);
    const sessionsAfter = Number(
      (await app.db.pool.query("SELECT count(*) AS n FROM auth.sessions")).rows[0]?.n,
    );
    expect(sessionsAfter).toBe(sessionsBefore);
  });

  it("JWKS unreachable: fail closed (no sign-in)", async () => {
    resetSupabaseAuthState();
    fake.jwksDown = true;
    const { done } = await emailSignIn();
    expect(done.status).toBe(422);
    expect(signedInTo(done)).toBe(false);
    fake.jwksDown = false;
    resetSupabaseAuthState();
  });

  it("key rotation: a token signed with the project's new key is accepted after one JWKS re-read", async () => {
    expect(signedInTo((await emailSignIn()).done)).toBe(true);
    fake.rotateKey();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const jwksReads = () => requestsTo("/auth/v1/.well-known/jwks.json");
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
      expect(done.json.next).toBe("/account");
    }
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (next) => {
        const { done } = await emailSignIn(uniqueEmail(), next);
        const back = str(done.json.next);
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
    expect((await startEmail(b, email)).status).toBe(200);
    await confirmLink(b, fake.lastEmail(email)?.link ?? "");
    expect(b.cookie(SESSION)).not.toBe(first);
    const old = new Browser();
    old.jar.set(SESSION, first);
    expect((await call(old, R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
  });

  it("minor 4: a session minted at Supabase without this app (live in auth.sessions, never registered) signs nobody in", async () => {
    const user = await fake.createUser(uniqueEmail());
    const sid = await fake.mintPlatformSession(user.id);
    expect(
      Number(
        (await app.db.pool.query("SELECT count(*) AS n FROM auth.sessions WHERE id = $1", [sid])).rows[0]?.n,
      ),
    ).toBe(1);
    const b = new Browser();
    b.jar.set(SESSION, sid);
    expect((await call(b, R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
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
    return b;
  }
  const sendCode = (b: Browser, phone: string) =>
    call(b, R.phone.POST, "POST", "/api/v1/onboarding/phone", {
      body: { phone, challenge: challenge("phone_code") },
    });
  const verifyCode = (b: Browser, code: string) =>
    call(b, R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", { body: { code } });
  const lastSms = (phone: string) =>
    [...fake.sms].reverse().find((m) => m.phone === phone.replace(/\s/g, ""));
  const userIdOf = async (b: Browser) =>
    (
      await app.db.pool.query<{ user_id: string }>("SELECT user_id FROM auth.sessions WHERE id = $1", [
        b.cookie(SESSION),
      ])
    ).rows[0]?.user_id ?? "";
  /** Ages every hold of the user past the code lifetime (10 minutes). */
  const ageHolds = (userId: string) =>
    app.db.pool.query(
      "UPDATE core.phone_hold SET set_at = now() - interval '11 minutes' WHERE user_id = $1",
      [userId],
    );

  it("'sms' mode: the number is set with the admin API, the SMS code verifies it, the extra Supabase session is ended and never registered", async () => {
    const b = await signedInBrowser();
    const phone = uniquePhone();
    const sent = await sendCode(b, phone);
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ sent: true });
    const sms = lastSms(phone);
    if (!sms) throw new Error("no sms");
    const wrong = await verifyCode(b, sms.code === "000000" ? "111111" : "000000");
    expect(wrong.status).toBe(422);
    expect(wrong.json.error?.details?.reason).toBe("WRONG_CODE");
    const ok = await verifyCode(b, sms.code);
    expect(ok.status).toBe(200);
    expect(ok.json.onboarding?.phoneVerified).toBe(true);
    // the only live Supabase session of this user is the browser's, and only it is registered
    const userId = await userIdOf(b);
    const count = async (sql: string) => Number((await app.db.pool.query(sql, [userId])).rows[0]?.n);
    expect(await count("SELECT count(*) AS n FROM auth.sessions WHERE user_id = $1")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM core.app_session WHERE user_id = $1")).toBe(1);
    expect(
      (
        await call(b, R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
          body: { birthdate: ADULT_BIRTHDATE },
        })
      ).status,
    ).toBe(200);
    expect((await call(b, R.provision.POST, "POST", "/api/v1/onboarding/provision")).status).toBe(201);
  });

  it("major 1a: a number another account holds (recently): the honest neutral answer {sent: false}, no SMS, nothing about the holder", async () => {
    const a = await signedInBrowser();
    const phone = uniquePhone();
    expect((await sendCode(a, phone)).json).toEqual({ sent: true });
    const smsBefore = fake.sms.length;
    const b = await signedInBrowser();
    const res = await sendCode(b, phone);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ sent: false, message: NOT_SENT });
    expect(fake.sms.length).toBe(smsBefore);
  });

  it("major 1b: squatting replay ('sms'): an attacker's unconfirmed hold is released once its code expired, and the owner verifies the number", async () => {
    const attacker = await signedInBrowser();
    const phone = uniquePhone();
    expect((await sendCode(attacker, phone)).json).toEqual({ sent: true }); // the owner gets this text
    const attackerId = await userIdOf(attacker);
    const owner = await signedInBrowser();
    expect((await sendCode(owner, phone)).json).toEqual({ sent: false, message: NOT_SENT });
    await ageHolds(attackerId);
    const again = await sendCode(owner, phone);
    expect(again.json).toEqual({ sent: true });
    expect(fake.users.get(attackerId)?.phone).toBeNull();
    const ok = await verifyCode(owner, lastSms(phone)?.code ?? "");
    expect(ok.status).toBe(200);
    expect(ok.json.onboarding?.phoneVerified).toBe(true);
    // the attacker's stale code no longer works for them
    expect((await verifyCode(attacker, lastSms(phone)?.code ?? "")).status).toBe(422);
  });

  it("major 1b: a CONFIRMED holder is never touched, however old", async () => {
    const holder = await signedInBrowser();
    const phone = uniquePhone();
    await sendCode(holder, phone);
    expect((await verifyCode(holder, lastSms(phone)?.code ?? "")).status).toBe(200);
    const holderId = await userIdOf(holder);
    await ageHolds(holderId);
    await app.db.pool.query("UPDATE auth.users SET created_at = now() - interval '1 day' WHERE id = $1", [
      holderId,
    ]);
    const other = await signedInBrowser();
    expect((await sendCode(other, phone)).json).toEqual({ sent: false, message: NOT_SENT });
    expect(fake.users.get(holderId)?.phone).toBe(phone.replace(/[\s+]/g, ""));
    expect(fake.users.get(holderId)?.phoneConfirmedAt).not.toBeNull();
  });

  it("major 1b: asking for another number releases the account's own earlier unconfirmed number", async () => {
    const b = await signedInBrowser();
    const first = uniquePhone();
    await sendCode(b, first);
    const id = await userIdOf(b);
    // the second number is someone's confirmed number: refused, but the first is let go
    const holder = await signedInBrowser();
    const taken = uniquePhone();
    await sendCode(holder, taken);
    await verifyCode(holder, lastSms(taken)?.code ?? "");
    expect((await sendCode(b, taken)).json.sent).toBe(false);
    expect(fake.users.get(id)?.phone).toBeNull();
    // so another account can take the first number at once
    expect((await sendCode(await signedInBrowser(), first)).json).toEqual({ sent: true });
  });

  it("major 1b: the job runner releases holds whose code expired (unconfirmed only)", async () => {
    const b = await signedInBrowser();
    const phone = uniquePhone();
    await sendCode(b, phone);
    const id = await userIdOf(b);
    await ageHolds(id);
    const pool = jobsPool();
    if (pool === null) throw new Error("no jobs pool");
    const report = await runJobs({ pool });
    expect(report.phoneHoldsReleased).toBeGreaterThanOrEqual(1);
    expect(fake.users.get(id)?.phone).toBeNull();
    expect(
      Number(
        (await app.db.pool.query("SELECT count(*) AS n FROM core.phone_hold WHERE user_id = $1", [id]))
          .rows[0]?.n,
      ),
    ).toBe(0);
  });

  it("major 1d: at most 3 texts an hour to one number, whoever asks; then the same neutral answer", async () => {
    const b = await signedInBrowser();
    const phone = uniquePhone();
    for (let i = 0; i < 3; i++) expect((await sendCode(b, phone)).json).toEqual({ sent: true });
    const smsBefore = fake.sms.length;
    expect((await sendCode(b, phone)).json).toEqual({ sent: false, message: NOT_SENT });
    expect(fake.sms.length).toBe(smsBefore);
  });

  it("major 1c: at most 3 different numbers per account a day (repeats are free)", async () => {
    const b = await signedInBrowser();
    const numbers = [uniquePhone(), uniquePhone(), uniquePhone()];
    for (const n of numbers) expect((await sendCode(b, n)).status).toBe(200);
    expect((await sendCode(b, numbers[0] as string)).status).toBe(200);
    const fourth = await sendCode(b, uniquePhone());
    expect(fourth.status).toBe(429);
    expect(fourth.json.error?.code).toBe("RATE_LIMITED");
  });

  describe("'unverified' mode (owner switch)", () => {
    const setMode = (mode: "sms" | "unverified") =>
      app.db.pool.query(
        "UPDATE core.deployment_setting SET value = $1 WHERE key = 'identity.phone_verification'",
        [mode],
      );
    afterEach(async () => {
      await setMode("sms");
    });

    it("the number is recorded without a code, reported NOT verified, one account per number", async () => {
      await setMode("unverified");
      const b = await signedInBrowser();
      const phone = uniquePhone();
      const smsBefore = fake.sms.length;
      const res = await sendCode(b, phone);
      expect(res.status).toBe(200);
      expect(res.json.recorded).toBe(true);
      // ninth review, major 1: the step is done, but the number is not reported as verified
      expect(res.json.onboarding?.phoneRecorded).toBe(true);
      expect(res.json.onboarding?.phoneVerified).toBe(false);
      expect(fake.sms.length).toBe(smsBefore);
      const me = await call(b, R.me.GET, "GET", "/api/v1/me");
      expect(me.json.phoneVerification).toBe("unverified");
      expect(me.json.onboarding?.phoneVerified).toBe(false);
      const sid = b.cookie(SESSION) ?? "";
      const { rows } = await app.db.pool.query<{ v: boolean }>(
        "SELECT p.phone_verified AS v FROM core.user_profile p JOIN auth.sessions s ON s.user_id = p.id WHERE s.id = $1",
        [sid],
      );
      expect(rows[0]?.v).toBe(false);
      expect((await verifyCode(b, "123456")).status).toBe(404);
      const dup = await sendCode(await signedInBrowser(), phone);
      expect(dup.status).toBe(409);
      expect(
        (
          await call(b, R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
            body: { birthdate: ADULT_BIRTHDATE },
          })
        ).status,
      ).toBe(200);
      expect((await call(b, R.provision.POST, "POST", "/api/v1/onboarding/provision")).status).toBe(201);
    });

    it("major 1: squatting replay ('unverified'): the owner later confirms the number by SMS; the squatter's claim is released and they are asked again", async () => {
      await setMode("unverified");
      const squatter = await signedInBrowser();
      const phone = uniquePhone();
      expect((await sendCode(squatter, phone)).json.recorded).toBe(true);
      await setMode("sms");
      const owner = await signedInBrowser();
      expect((await sendCode(owner, phone)).json).toEqual({ sent: true });
      const ok = await verifyCode(owner, lastSms(phone)?.code ?? "");
      expect(ok.status).toBe(200);
      expect(ok.json.onboarding?.phoneVerified).toBe(true);
      const me = await call(squatter, R.me.GET, "GET", "/api/v1/me");
      expect(me.json.onboarding).toMatchObject({
        phoneRecorded: false,
        phoneVerified: false,
        phoneReverifyRequired: true,
      });
    });
  });
});

describe("US-01: Supabase and Turnstile credentials stay on the server", () => {
  it("no access or refresh token, key or Turnstile secret ever appears in a Set-Cookie header, a response body or a redirect", () => {
    expect(fake.issuedTokens.length).toBeGreaterThan(5);
    const everything = [...setCookies, ...bodies].join("\n");
    for (const t of [...fake.issuedTokens, ...fake.refreshTokens]) expect(everything).not.toContain(t);
    expect(everything).not.toContain(fake.secretKey);
    expect(everything).not.toContain(fake.publishableKey);
    expect(everything).not.toContain(TURNSTILE_SECRET);
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
