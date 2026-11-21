import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as cartLines from "../src/app/api/v1/cart/lines/route";
import * as cartPreview from "../src/app/api/v1/cart/preview/route";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, type CallResult, str } from "./helpers/browser";
import { checkout, GOOD_PIN, onboard, player, R, signedIn, uniqueEmail } from "./helpers/flows";

/**
 * Fifth security review, through the route handlers against a throwaway database: database rate
 * limits (item 4), the pay race (item 5) and the session-bound CSRF token (item 8). The limits are
 * asserted at their production values (no RATE_LIMIT_MULTIPLIER in this file).
 */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
}, 180_000);

afterAll(async () => {
  await app.stop();
});

function seed(i = 0): string {
  const p = app.products[i];
  if (!p) throw new Error("no seed product");
  return p.id;
}

async function anonymous(): Promise<Browser> {
  const b = new Browser();
  b.csrfToken = str((await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
  return b;
}

function expectLimited(res: CallResult): void {
  expect(res.status, res.text).toBe(429);
  expect(res.json.error?.code).toBe("RATE_LIMITED");
  expect(res.json.error?.retryable).toBe(true);
  expect(Number(res.json.error?.details?.retryAfterSeconds)).toBeGreaterThan(0);
}

async function counterRows(scope: string): Promise<number> {
  const { rows } = await app.db.pool.query<{ n: string }>(
    "SELECT coalesce(sum(count), 0)::text AS n FROM core.rate_counter WHERE scope = $1",
    [scope],
  );
  return Number(rows[0]?.n);
}

describe("item 4: rate limits come from a trusted address and live in the database", () => {
  it("US-01: rotating X-Forwarded-For does not bypass the per-address sign-in limit", async () => {
    const b = await anonymous();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await b.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
        body: { email: "not-an-email" },
        headers: { "x-forwarded-for": `203.0.113.${i + 1}`, "x-real-ip": `198.51.100.${i + 1}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // another client address has its own budget
    const other = await anonymous();
    const res = await other.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
      body: { email: "not-an-email" },
    });
    expect(res.status).toBe(422);
  });

  it("US-01: no raw address or user id is stored, only 32-byte digests", async () => {
    const { rows } = await app.db.pool.query<{ subject: Buffer }>("SELECT subject FROM core.rate_counter");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.subject.length).toBe(32);
      expect(r.subject.toString("utf8")).not.toMatch(/2001:db8|203\.0\.113|198\.51\.100/);
    }
  });

  it("US-48: the per-account PIN limit survives signing in again (a new session gets no new budget)", async () => {
    const email = uniqueEmail();
    const first = await signedIn(email);
    expect((await onboard(first)).status).toBe(200);
    const opened = await first.call(R.provision.POST, "POST", "/api/v1/onboarding/provision");
    const cardId = str(opened.json.card?.id);
    const weakPin = (b: Browser) =>
      b.call(R.cardPin.POST, "POST", `/api/v1/cards/${cardId}/pin`, {
        params: { id: cardId },
        body: { pin: "111111" },
      });
    for (let i = 0; i < 10; i++) expect((await weakPin(first)).status).toBe(422);
    expectLimited(await weakPin(first));
    // a new browser, a new sign-in session, a new address: the same account is still limited
    const second = await signedIn(email);
    expect(second.cookie("__Host-dm_session")).not.toBe(first.cookie("__Host-dm_session"));
    expectLimited(await weakPin(second));
  });

  it("US-14: a business call that fails and rolls back still counts (checkout: 10 / minute / account)", async () => {
    const { b } = await player({ pin: false });
    const before = await counterRows("checkout.create.actor");
    for (let i = 0; i < 10; i++) {
      // a product that does not exist: the checkout transaction is refused and rolled back
      const res = await checkout(b, randomUUID());
      expect(res.status).not.toBe(201);
      expect(res.status).not.toBe(429);
    }
    expect(await counterRows("checkout.create.actor")).toBe(before + 10);
    expectLimited(await checkout(b, seed()));
  });

  it("US-14: pay is limited per account (10 / minute)", async () => {
    const { b } = await player({ pin: false });
    const s = await checkout(b, seed(1));
    const sessionId = str(s.json.id);
    for (let i = 0; i < 10; i++) {
      const res = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
        params: { id: sessionId },
        body: { attemptId: randomUUID() },
        idempotencyKey: true,
      });
      expect(res.status).not.toBe(429);
    }
    expectLimited(
      await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
        params: { id: sessionId },
        body: { attemptId: randomUUID() },
        idempotencyKey: true,
      }),
    );
  });

  it("US-41: coupon previews and applications are limited per account (10 / hour); previews without a code are not", async () => {
    const { b } = await player({ pin: false });
    expect(
      (await b.call(cartLines.POST, "POST", "/api/v1/cart/lines", { body: { productId: seed() } })).status,
    ).toBe(200);
    const withCode = () =>
      b.call(cartPreview.POST, "POST", "/api/v1/cart/preview", { body: { couponCode: "NOSUCHCODE" } });
    for (let i = 0; i < 6; i++) expect((await withCode()).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      const res = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
        body: { source: "CART", couponCode: "NOSUCHCODE" },
        idempotencyKey: true,
      });
      expect(res.status).not.toBe(429);
    }
    expectLimited(await withCode());
    const plain = await b.call(cartPreview.POST, "POST", "/api/v1/cart/preview", { body: {} });
    expect(plain.status).toBe(200);
  });

  it("US-33: cart writes are limited per account", async () => {
    const { b } = await player({ pin: false });
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      statuses.push(
        (await b.call(cartLines.POST, "POST", "/api/v1/cart/lines", { body: { productId: seed() } })).status,
      );
    }
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("US-49: phone codes are limited per account (5 / day) and verifications per account (10 / hour)", async () => {
    const b = await signedIn();
    const request = () =>
      b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone: "+91 9000000001" } });
    for (let i = 0; i < 5; i++) expect((await request()).status).toBe(200);
    expectLimited(await request());
    const verify = () =>
      b.call(R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", { body: { code: "123456" } });
    for (let i = 0; i < 10; i++) expect((await verify()).status).not.toBe(429);
    expectLimited(await verify());
  });

  it("US-49: phone codes are limited per address across accounts (30 / hour)", async () => {
    const shared = "2001:db8:ffff::30";
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const b = await signedIn(); // each account signs in from its own address...
      b.peer = shared; // ...then asks for a code from the shared one
      statuses.push(
        (
          await b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", {
            body: { phone: "+91 9000000002" },
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("item 5: a pay race for the same product is a 409, never a 500", () => {
  it("US-14: two pays with different keys for one product by one buyer, in parallel, 20 times: one 200 and one 409 ALREADY_OWNED with the cart's issues", async () => {
    for (let round = 0; round < 20; round++) {
      const { b } = await player({ pin: false });
      const sessions: { id: string; attemptId: string }[] = [];
      for (let i = 0; i < 2; i++) {
        const s = await checkout(b, seed(2));
        expect(s.status, s.text).toBe(201);
        const id = str(s.json.id);
        const at = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${id}/attempts`, {
          params: { id },
          body: { method: "BALANCE" },
        });
        sessions.push({ id, attemptId: str(at.json.id) });
      }
      const results = await Promise.all(
        sessions.map((s) =>
          b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${s.id}/pay`, {
            params: { id: s.id },
            body: { attemptId: s.attemptId },
            idempotencyKey: true,
          }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, `round ${round}: ${results.map((r) => r.text).join(" | ")}`).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409);
      expect(loser?.json.error?.code).toBe("ALREADY_OWNED");
      expect(Array.isArray(loser?.json.error?.details?.issues)).toBe(true);
    }
  }, 180_000);
});

describe("item 8: the CSRF token is bound to the session", () => {
  it("US-01: signing in returns a new token bound to the session; GET /auth/csrf then answers the same one", async () => {
    const b = await anonymous();
    const preSession = b.csrfToken;
    const res = await b.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
      body: { email: uniqueEmail() },
    });
    expect(res.status).toBe(200);
    const bound = str(res.json.csrfToken);
    expect(bound).not.toBe(preSession);
    expect(bound).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.text).not.toContain(b.cookie("__Host-dm_session") ?? "missing");
    const again = await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
    expect(again.json.csrfToken).toBe(bound);
    expect(b.cookie("__Host-dm_csrf")).toBe(bound);
  });

  it("US-01: a token minted for one session fails for another, even sent as both cookie and header", async () => {
    const a = await player({ pin: false });
    const victim = await player({ pin: false });
    const tokenA = str(a.b.csrfToken);
    // the attacker plants A's token as the victim's CSRF cookie and sends it in the header
    victim.b.jar.set("__Host-dm_csrf", tokenA);
    const res = await victim.b.call(R.cardFreeze.POST, "POST", `/api/v1/cards/${victim.cardId}/freeze`, {
      params: { id: victim.cardId },
      body: { frozen: true },
      csrf: tokenA,
    });
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("FORBIDDEN");
    // the victim's own token still works
    const own = await signedInToken(victim.b);
    victim.b.jar.set("__Host-dm_csrf", own);
    const ok = await victim.b.call(R.cardFreeze.POST, "POST", `/api/v1/cards/${victim.cardId}/freeze`, {
      params: { id: victim.cardId },
      body: { frozen: false },
      csrf: own,
    });
    expect(ok.status).toBe(200);
  });

  it("US-01: a pre-session random token is refused on a signed-in request (it is for the sign-in route only)", async () => {
    const { b, cardId } = await player({ pin: false });
    const random = (await anonymous()).csrfToken ?? "";
    b.jar.set("__Host-dm_csrf", random);
    const res = await b.call(R.cardFreeze.POST, "POST", `/api/v1/cards/${cardId}/freeze`, {
      params: { id: cardId },
      body: { frozen: true },
      csrf: random,
    });
    expect(res.status).toBe(403);
    // sign-out, too, needs the session's token
    const out = await b.call(R.signOut.POST, "POST", "/api/v1/auth/sign-out", { csrf: random });
    expect(out.status).toBe(403);
    expect((await b.call(R.me.GET, "GET", "/api/v1/me")).status).toBe(200);
  });

  it("US-48: the PIN step of a payment refuses another session's token too", async () => {
    const a = await player();
    const other = await player();
    const s = await checkout(a.b, seed());
    const id = str(s.json.id);
    const at = await a.b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${id}/attempts`, {
      params: { id },
      body: { method: "CARD", cardId: a.cardId },
    });
    const attemptId = str(at.json.id);
    a.b.jar.set("__Host-dm_csrf", str(other.b.csrfToken));
    const res = await a.b.call(R.attemptPin.POST, "POST", `/api/v1/attempts/${attemptId}/pin`, {
      params: { id: attemptId },
      body: { pin: GOOD_PIN },
      csrf: str(other.b.csrfToken),
    });
    expect(res.status).toBe(403);
    expect(arr([res.json.error?.code])).toEqual(["FORBIDDEN"]);
  });
});

/** The token GET /auth/csrf answers for the browser's current session cookie. */
async function signedInToken(b: Browser): Promise<string> {
  const res = await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
  return str(res.json.csrfToken);
}
