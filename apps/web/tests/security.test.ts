import { randomUUID } from "node:crypto";
import { uuidv7 } from "@delulu/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as adminActionCancel from "../src/app/api/v1/admin/actions/[id]/cancel/route";
import * as adminActions from "../src/app/api/v1/admin/actions/route";
import * as adminConfig from "../src/app/api/v1/admin/config/route";
import * as adminReviewHide from "../src/app/api/v1/admin/reviews/[id]/hide/route";
import * as adminReviewRestore from "../src/app/api/v1/admin/reviews/[id]/restore/route";
import * as adminReviews from "../src/app/api/v1/admin/reviews/route";
import * as myReview from "../src/app/api/v1/me/reviews/[productId]/route";
import * as productReview from "../src/app/api/v1/products/[id]/review/route";
import type { RouteHandler } from "../src/server/http";
import { serverSecrets, startTestApp, type TestApp } from "./helpers/app";
import { Browser, type CallOptions, type CallResult, str } from "./helpers/browser";
import { checkout, GOOD_PIN, player, R, signedIn } from "./helpers/flows";

let app: TestApp;
/** A: a player who bought a product with a CARD; B: another player. */
let A: Awaited<ReturnType<typeof player>> & { orderId: string; sessionId: string; attemptId: string };
let B: Awaited<ReturnType<typeof player>>;

beforeAll(async () => {
  app = await startTestApp();
  const product = app.products[0];
  if (!product) throw new Error("no seed product");
  const a = await player();
  const s = await checkout(a.b, product.id);
  const sessionId = str(s.json.id);
  const at = await a.b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body: { method: "CARD", cardId: a.cardId },
  });
  const attemptId = str(at.json.id);
  await a.b.call(R.attemptPin.POST, "POST", `/api/v1/attempts/${attemptId}/pin`, {
    params: { id: attemptId },
    body: { pin: GOOD_PIN },
  });
  const paid = await a.b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId },
    idempotencyKey: true,
  });
  expect(paid.status).toBe(200);
  A = { ...a, orderId: str(paid.json.orderId), sessionId, attemptId };
  B = await player();
});

afterAll(async () => {
  await app.stop();
});

interface PrivateRoute {
  name: string;
  handler: RouteHandler;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  options: () => CallOptions;
}

const ID = "0192f6a0-0000-7000-8000-0000000000ff";

/** Every route that needs a session, with a valid-looking request. */
const PRIVATE: PrivateRoute[] = [
  { name: "me", handler: R.me.GET, method: "GET", path: "/api/v1/me", options: () => ({}) },
  {
    name: "overlay",
    handler: R.overlay.GET,
    method: "GET",
    path: `/api/v1/me/overlay?productIds=${ID}`,
    options: () => ({}),
  },
  { name: "wallet", handler: R.wallet.GET, method: "GET", path: "/api/v1/wallet", options: () => ({}) },
  {
    name: "statement",
    handler: R.statement.GET,
    method: "GET",
    path: "/api/v1/statement",
    options: () => ({}),
  },
  { name: "orders", handler: R.orders.GET, method: "GET", path: "/api/v1/orders", options: () => ({}) },
  {
    name: "order",
    handler: R.order.GET,
    method: "GET",
    path: `/api/v1/orders/${ID}`,
    options: () => ({ params: { id: ID } }),
  },
  {
    name: "collection",
    handler: R.collection.GET,
    method: "GET",
    path: "/api/v1/collection",
    options: () => ({}),
  },
  {
    name: "phone",
    handler: R.phone.POST,
    method: "POST",
    path: "/api/v1/onboarding/phone",
    options: () => ({ body: { phone: "+919876543210" } }),
  },
  {
    name: "phone verify",
    handler: R.phoneVerify.POST,
    method: "POST",
    path: "/api/v1/onboarding/phone/verify",
    options: () => ({ body: { code: "000000" } }),
  },
  {
    name: "birthdate",
    handler: R.birthdate.POST,
    method: "POST",
    path: "/api/v1/onboarding/birthdate",
    options: () => ({ body: { birthdate: "1990-01-01" } }),
  },
  {
    name: "provision",
    handler: R.provision.POST,
    method: "POST",
    path: "/api/v1/onboarding/provision",
    options: () => ({}),
  },
  {
    name: "card pin",
    handler: R.cardPin.POST,
    method: "POST",
    path: `/api/v1/cards/${ID}/pin`,
    options: () => ({ params: { id: ID }, body: { pin: GOOD_PIN } }),
  },
  {
    name: "card pin reset",
    handler: R.cardPinReset.POST,
    method: "POST",
    path: `/api/v1/cards/${ID}/pin/reset`,
    options: () => ({ params: { id: ID }, body: { pin: GOOD_PIN } }),
  },
  {
    name: "card freeze",
    handler: R.cardFreeze.POST,
    method: "POST",
    path: `/api/v1/cards/${ID}/freeze`,
    options: () => ({ params: { id: ID }, body: { frozen: true } }),
  },
  {
    name: "card reveal",
    handler: R.cardReveal.POST,
    method: "POST",
    path: `/api/v1/cards/${ID}/reveal`,
    options: () => ({ params: { id: ID } }),
  },
  {
    name: "checkout",
    handler: R.checkoutSessions.POST,
    method: "POST",
    path: "/api/v1/checkout-sessions",
    options: () => ({
      body: { lines: [{ productId: ID }], speedBySeller: { SEED: "STANDARD" } },
      idempotencyKey: true,
    }),
  },
  {
    name: "attempts",
    handler: R.attempts.POST,
    method: "POST",
    path: `/api/v1/checkout-sessions/${ID}/attempts`,
    options: () => ({ params: { id: ID }, body: { method: "BALANCE" } }),
  },
  {
    name: "attempt pin",
    handler: R.attemptPin.POST,
    method: "POST",
    path: `/api/v1/attempts/${ID}/pin`,
    options: () => ({ params: { id: ID }, body: { pin: GOOD_PIN } }),
  },
  {
    name: "pay",
    handler: R.pay.POST,
    method: "POST",
    path: `/api/v1/checkout-sessions/${ID}/pay`,
    options: () => ({ params: { id: ID }, body: { attemptId: ID }, idempotencyKey: true }),
  },
  // ratings and reviews (decisions.md #14)
  {
    name: "my review",
    handler: myReview.GET,
    method: "GET",
    path: `/api/v1/me/reviews/${ID}`,
    options: () => ({ params: { productId: ID } }),
  },
  {
    name: "review write",
    handler: productReview.PUT,
    method: "PUT",
    path: `/api/v1/products/${ID}/review`,
    options: () => ({ params: { id: ID }, body: { rating: 5 } }),
  },
  {
    name: "review delete",
    handler: productReview.DELETE,
    method: "DELETE",
    path: `/api/v1/products/${ID}/review`,
    options: () => ({ params: { id: ID } }),
  },
  {
    name: "admin reviews",
    handler: adminReviews.GET,
    method: "GET",
    path: "/api/v1/admin/reviews",
    options: () => ({}),
  },
  {
    name: "admin review hide",
    handler: adminReviewHide.POST,
    method: "POST",
    path: `/api/v1/admin/reviews/${ID}/hide`,
    options: () => ({ params: { id: ID }, body: { reason: "Test reason" } }),
  },
  {
    name: "admin review restore",
    handler: adminReviewRestore.POST,
    method: "POST",
    path: `/api/v1/admin/reviews/${ID}/restore`,
    options: () => ({ params: { id: ID }, body: { reason: "Test reason" } }),
  },
  // the Super Admin's delayed actions and configuration (migration 0090, decisions.md #16)
  {
    name: "admin actions",
    handler: adminActions.GET,
    method: "GET",
    path: "/api/v1/admin/actions",
    options: () => ({}),
  },
  {
    name: "admin action cancel",
    handler: adminActionCancel.POST,
    method: "POST",
    path: `/api/v1/admin/actions/${ID}/cancel`,
    options: () => ({ params: { id: ID }, body: { reason: "Test reason" } }),
  },
  {
    name: "admin config",
    handler: adminConfig.GET,
    method: "GET",
    path: "/api/v1/admin/config",
    options: () => ({}),
  },
  {
    name: "admin config change",
    handler: adminConfig.POST,
    method: "POST",
    path: "/api/v1/admin/config",
    options: () => ({ body: { key: "fee_percent", value: "6", reason: "Test reason" } }),
  },
];

async function anonymous(): Promise<Browser> {
  const b = new Browser();
  b.csrfToken = str((await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
  return b;
}

function expectEnvelope(res: CallResult, code: string, status: number): void {
  expect(res.status).toBe(status);
  expect(Object.keys(res.json)).toEqual(["error"]);
  expect(Object.keys(res.json.error ?? {}).sort()).toEqual(["code", "details", "message", "retryable"]);
  expect(res.json.error?.code).toBe(code);
  expect(typeof res.json.error?.message).toBe("string");
  expect(typeof res.json.error?.retryable).toBe("boolean");
}

describe("authentication", () => {
  it.each(PRIVATE)("US-01: $name answers 401 AUTH_REQUIRED without a session cookie", async (r) => {
    const b = await anonymous();
    const res = await b.call(r.handler, r.method, r.path, r.options());
    expectEnvelope(res, "AUTH_REQUIRED", 401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(PRIVATE)("US-01: $name answers 401 with a made-up session id", async (r) => {
    const b = await anonymous();
    b.jar.set("__Host-dm_session", uuidv7());
    const res = await b.call(r.handler, r.method, r.path, r.options());
    expectEnvelope(res, "AUTH_REQUIRED", 401);
  });

  it("US-01: a cookie that is not a uuid, or the localhost cookie name over https, is no session", async () => {
    const b = await anonymous();
    b.jar.set("__Host-dm_session", "1' OR '1'='1");
    expect((await b.call(R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
    const sid = A.b.cookie("__Host-dm_session") ?? "";
    const local = await anonymous();
    local.jar.set("dm_session", sid);
    expect((await local.call(R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
  });

  it("US-01: an expired session is refused", async () => {
    const b = await signedIn();
    const sid = b.cookie("__Host-dm_session") ?? "";
    await app.db.pool.query(
      "UPDATE auth.sessions SET not_after = now() - interval '1 second' WHERE id = $1",
      [sid],
    );
    expect((await b.call(R.me.GET, "GET", "/api/v1/me")).status).toBe(401);
  });

  it("US-01: the sign-in cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, and the id is in no body", async () => {
    const b = new Browser();
    b.csrfToken = str((await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
    const res = await b.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
      body: { email: "cookie.check@example.test" },
    });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-dm_session=")) ?? "";
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(cookie).toContain(attr);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(res.text).not.toContain(b.cookie("__Host-dm_session") ?? "missing");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("US-01: signing in again with the same email reaches the same account", async () => {
    const email = "same.person@example.test";
    const first = await signedIn(email);
    const second = await signedIn(email.toUpperCase());
    expect(first.cookie("__Host-dm_session")).not.toBe(second.cookie("__Host-dm_session"));
    await first.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone: "+91 7000000001" } });
    await first.call(R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", {
      body: { code: "000000" },
    });
    const me = await second.call(R.me.GET, "GET", "/api/v1/me");
    expect(me.json.onboarding?.phoneVerified).toBe(true);
  });
});

describe("one user cannot reach another user's data", () => {
  it("US-01: B cannot read A's order", async () => {
    const res = await B.b.call(R.order.GET, "GET", `/api/v1/orders/${A.orderId}`, {
      params: { id: A.orderId },
    });
    expectEnvelope(res, "NOT_FOUND", 404);
    expect(res.text).not.toContain(A.orderId);
    const own = await B.b.call(R.orders.GET, "GET", "/api/v1/orders");
    expect(own.json.items).toEqual([]);
  });

  it("US-01: B's statement and collection show none of A's rows", async () => {
    const statement = await B.b.call(R.statement.GET, "GET", "/api/v1/statement");
    expect(statement.text).not.toContain(A.orderId);
    expect(statement.json.items?.length).toBe(1); // B's own starting grant
    const collection = await B.b.call(R.collection.GET, "GET", "/api/v1/collection");
    expect(collection.json.items).toEqual([]);
  });

  it("US-15: B cannot reveal, freeze or set the PIN of A's card", async () => {
    const opts = { params: { id: A.cardId } };
    const reveal = await B.b.call(R.cardReveal.POST, "POST", `/api/v1/cards/${A.cardId}/reveal`, opts);
    expect([403, 404]).toContain(reveal.status);
    expect(reveal.text).not.toMatch(/\d{16}/);
    const freeze = await B.b.call(R.cardFreeze.POST, "POST", `/api/v1/cards/${A.cardId}/freeze`, {
      ...opts,
      body: { frozen: true },
    });
    expect([403, 404]).toContain(freeze.status);
    const pin = await B.b.call(R.cardPinReset.POST, "POST", `/api/v1/cards/${A.cardId}/pin/reset`, {
      ...opts,
      body: { pin: "736152" },
    });
    expect([403, 404]).toContain(pin.status);
    const aWallet = await A.b.call(R.wallet.GET, "GET", "/api/v1/wallet");
    expect(aWallet.json.card?.status).toBe("ACTIVE");
  });

  it("US-14: B cannot pay, attempt or PIN-verify A's checkout session", async () => {
    const product = app.products[1];
    if (!product) throw new Error("no seed product");
    const s = await checkout(A.b, product.id);
    const sessionId = str(s.json.id);
    const bAttempt = await B.b.call(
      R.attempts.POST,
      "POST",
      `/api/v1/checkout-sessions/${sessionId}/attempts`,
      {
        params: { id: sessionId },
        body: { method: "BALANCE" },
      },
    );
    expect([403, 404, 409, 422]).toContain(bAttempt.status);
    const aAttempt = await A.b.call(
      R.attempts.POST,
      "POST",
      `/api/v1/checkout-sessions/${sessionId}/attempts`,
      {
        params: { id: sessionId },
        body: { method: "BALANCE" },
      },
    );
    const attemptId = str(aAttempt.json.id);
    const bPay = await B.b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId },
      idempotencyKey: true,
    });
    expect(bPay.status).toBeGreaterThanOrEqual(400);
    expect(bPay.text).not.toContain("orderId");
    const bPin = await B.b.call(R.attemptPin.POST, "POST", `/api/v1/attempts/${A.attemptId}/pin`, {
      params: { id: A.attemptId },
      body: { pin: GOOD_PIN },
    });
    expect(bPin.status).toBeGreaterThanOrEqual(400);
    const aBefore = await A.b.call(R.wallet.GET, "GET", "/api/v1/wallet");
    const bWallet = await B.b.call(R.wallet.GET, "GET", "/api/v1/wallet");
    expect(bWallet.json.balancePaise).toBe("100000000000");
    const aOrders = await A.b.call(R.orders.GET, "GET", "/api/v1/orders");
    expect(aOrders.json.items?.length).toBe(1);
    expect(aBefore.status).toBe(200);
  });
});

describe("CSRF and request guards", () => {
  const freeze = (b: Browser, options: CallOptions) =>
    b.call(R.cardFreeze.POST, "POST", `/api/v1/cards/${B.cardId}/freeze`, {
      params: { id: B.cardId },
      body: { frozen: false },
      ...options,
    });

  it("US-01: a state-changing request without the token, with a wrong token or a foreign Origin is refused", async () => {
    for (const options of [
      { csrf: false },
      { csrf: "x".repeat(43) },
      { csrf: "" },
      { origin: "https://evil.example" },
      { origin: null },
      { origin: "http://app.delulu.test" },
    ] satisfies CallOptions[]) {
      const res = await freeze(B.b, options);
      expectEnvelope(res, "FORBIDDEN", 403);
    }
    // another browser's token does not work with this browser's cookie
    const other = await anonymous();
    expectEnvelope(await freeze(B.b, { csrf: other.csrfToken ?? "" }), "FORBIDDEN", 403);
    // the right token and origin pass
    expect((await freeze(B.b, {})).status).toBe(200);
  });

  it("US-01: CSRF also guards sign-in and sign-out (login CSRF)", async () => {
    const b = new Browser();
    const res = await b.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
      body: { email: "csrf@example.test" },
    });
    expectEnvelope(res, "FORBIDDEN", 403);
    expect(res.headers.getSetCookie()).toEqual([]);
    const out = await B.b.call(R.signOut.POST, "POST", "/api/v1/auth/sign-out", { csrf: false });
    expect(out.status).toBe(403);
    expect((await B.b.call(R.me.GET, "GET", "/api/v1/me")).status).toBe(200);
  });

  it("GETs are not blocked by the CSRF check", async () => {
    const res = await B.b.call(R.wallet.GET, "GET", "/api/v1/wallet", {
      csrf: false,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(200);
  });

  it("the CSRF endpoint keeps an existing token and sets an HttpOnly cookie", async () => {
    const b = new Browser();
    const first = await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
    const second = await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
    expect(second.json.csrfToken).toBe(first.json.csrfToken);
    const cookie = first.headers.getSetCookie()[0] ?? "";
    expect(cookie.startsWith("__Host-dm_csrf=")).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
  });

  it("US-14: checkout and pay need an Idempotency-Key UUID", async () => {
    const product = app.products[2];
    if (!product) throw new Error("no seed product");
    for (const key of [false, "not-a-uuid"] as const) {
      const res = await B.b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
        body: { lines: [{ productId: product.id }], speedBySeller: { SEED: "STANDARD" } },
        idempotencyKey: key,
      });
      expectEnvelope(res, "VALIDATION_FAILED", 400);
    }
    const pay = await B.b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${ID}/pay`, {
      params: { id: ID },
      body: { attemptId: ID },
    });
    expectEnvelope(pay, "VALIDATION_FAILED", 400);
  });

  it("no route accepts a card number, expiry or CVV (strict bodies)", async () => {
    const product = app.products[2];
    if (!product) throw new Error("no seed product");
    const s = await checkout(B.b, product.id);
    const sessionId = str(s.json.id);
    const res = await B.b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "CARD", cardId: B.cardId, cardNumber: "4111111111111111", expiry: "12/30", cvv: "123" },
    });
    expectEnvelope(res, "VALIDATION_FAILED", 400);
    expect(res.text).not.toContain("4111111111111111");
    const withNumber = await B.b.call(
      R.attempts.POST,
      "POST",
      `/api/v1/checkout-sessions/${sessionId}/attempts`,
      {
        params: { id: sessionId },
        body: { method: "CARD", cardId: "4111111111111111" },
      },
    );
    expectEnvelope(withNumber, "VALIDATION_FAILED", 400);
  });

  it("malformed bodies are 400 VALIDATION_FAILED: bad JSON, wrong content type, too large", async () => {
    const opts = { params: { id: B.cardId } };
    const path = `/api/v1/cards/${B.cardId}/freeze`;
    expectEnvelope(
      await B.b.call(R.cardFreeze.POST, "POST", path, {
        ...opts,
        rawBody: { text: "{", contentType: "application/json" },
      }),
      "VALIDATION_FAILED",
      400,
    );
    expectEnvelope(
      await B.b.call(R.cardFreeze.POST, "POST", path, {
        ...opts,
        rawBody: { text: "frozen=true", contentType: "application/x-www-form-urlencoded" },
      }),
      "VALIDATION_FAILED",
      400,
    );
    expectEnvelope(
      await B.b.call(R.cardFreeze.POST, "POST", path, {
        ...opts,
        body: { frozen: true, pad: "x".repeat(20_000) },
      }),
      "VALIDATION_FAILED",
      400,
    );
  });

  it("a path id that is not a uuid is NOT_FOUND, never a database error", async () => {
    const res = await B.b.call(R.order.GET, "GET", "/api/v1/orders/1;DROP", { params: { id: "1;DROP" } });
    expectEnvelope(res, "NOT_FOUND", 404);
  });

  it("the dev sign-in route is rate limited per client address", async () => {
    const statuses: number[] = [];
    const b = await anonymous();
    for (let i = 0; i < 22; i++) {
      const res = await b.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
        body: { email: "not-an-email" },
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});

describe("cache headers and public data", () => {
  it("US-01: every private response is private, no-store", async () => {
    for (const r of PRIVATE.filter((p) => p.method === "GET")) {
      const res = await A.b.call(r.handler, r.method, r.path, r.options());
      expect(res.headers.get("cache-control"), r.name).toBe("private, no-store");
    }
  });

  it("the public catalog is cacheable and identical with or without a session cookie", async () => {
    const anon = new Browser();
    const withCookie = await A.b.call(R.catalog.GET, "GET", "/api/v1/catalog");
    const without = await anon.call(R.catalog.GET, "GET", "/api/v1/catalog");
    expect(withCookie.status).toBe(200);
    expect(withCookie.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(withCookie.text).toBe(without.text);
    expect(withCookie.headers.getSetCookie()).toEqual([]);
    expect(withCookie.json.items?.length).toBe(3);
    const productId = app.products[0]?.id ?? "";
    const p1 = await A.b.call(R.product.GET, "GET", `/api/v1/products/${productId}`, {
      params: { id: productId },
    });
    const p2 = await anon.call(R.product.GET, "GET", `/api/v1/products/${productId}`, {
      params: { id: productId },
    });
    expect(p1.text).toBe(p2.text);
    expect(p1.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(p1.json.pricePaise).toBe(app.products[0]?.pricePaise.toString());
    expect(p1.text).not.toMatch(/owned|balance/i);
  });

  it("a missing product is a NOT_FOUND that is not cached publicly", async () => {
    const id = randomUUID();
    const res = await new Browser().call(R.product.GET, "GET", `/api/v1/products/${id}`, { params: { id } });
    expectEnvelope(res, "NOT_FOUND", 404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("catalog filters by category and pages with a cursor", async () => {
    const category = app.products[0]?.seed.category ?? "";
    const res = await new Browser().call(
      R.catalog.GET,
      "GET",
      `/api/v1/catalog?category=${category}&limit=1`,
    );
    expect(res.status).toBe(200);
    expect(res.json.items?.length).toBe(1);
    const bad = await new Browser().call(R.catalog.GET, "GET", "/api/v1/catalog?limit=500");
    expectEnvelope(bad, "VALIDATION_FAILED", 400);
  });
});

describe("errors never leak", () => {
  it("no response body anyone saw contains a PIN, a session id, a fingerprint, a key, SQL or a stack trace", async () => {
    const browsers = [A.b, B.b];
    const sessionIds = browsers.map((b) => b.cookie("__Host-dm_session") ?? "");
    const { rows } = await app.db.pool.query<{ e: Buffer; p: Buffer | null }>(
      "SELECT email_fingerprint AS e, phone_fingerprint AS p FROM core.user_profile",
    );
    const fingerprints = rows.flatMap((r) => [r.e, r.p].filter((x): x is Buffer => x !== null));
    const forbidden = [
      GOOD_PIN,
      ...sessionIds,
      ...serverSecrets(),
      ...fingerprints.flatMap((f) => [f.toString("hex"), f.toString("base64")]),
    ];
    const all = browsers.flatMap((b) => b.seen).join("\n");
    for (const value of forbidden) {
      expect(value.length).toBeGreaterThan(5);
      expect(all).not.toContain(value);
    }
    expect(all).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b.*\b(FROM|INTO|SET)\b/);
    expect(all).not.toMatch(/\bat .*\.(ts|js):\d+/);
    expect(all).not.toMatch(/SQLSTATE|pg_|DM001|stack/i);
    expect(all).not.toContain('"code":"INTERNAL"'); // every refusal above was a deliberate one
  });

  it("an unexpected failure is a generic 500 with no detail", async () => {
    const { route } = await import("../src/server/http");
    const handler = route({ auth: "anonymous" }, async () => {
      throw new Error(`relation "core.secret" does not exist; session ${A.sessionId}`);
    });
    const res = await new Browser().call(handler, "GET", "/api/v1/boom");
    expectEnvelope(res, "INTERNAL", 500);
    expect(res.text).not.toContain("core.secret");
    expect(res.text).not.toContain(A.sessionId);
  });
});
