import { randomUUID } from "node:crypto";
import { STARTER_GRANT_PAISE } from "@delulu/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverSecrets, startTestApp, type TestApp } from "./helpers/app";
import { arr, str } from "./helpers/browser";
import {
  ADULT_BIRTHDATE,
  checkout,
  GOOD_PIN,
  onboard,
  player,
  R,
  signedIn,
  uniquePhone,
} from "./helpers/flows";

let app: TestApp;
const DELIVERY_STANDARD_PAISE = 100_000n; // ₹1,000 (DEFAULT_PRICING_CONFIG, seeded config)

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.stop();
});

describe("sign-in, onboarding and a first purchase", () => {
  it("US-01 US-14 US-15 US-48: the full CARD journey debits price + delivery and records the order once", async () => {
    const [product] = app.products;
    if (!product) throw new Error("no seed product");
    const b = await signedIn();

    const fresh = await b.call(R.me.GET, "GET", "/api/v1/me");
    expect(fresh.status).toBe(200);
    expect(fresh.json.onboarding).toEqual({
      hasProfile: false,
      phoneVerified: false,
      hasBirthdate: false,
      isAdult: false,
      provisioned: false,
      pinSet: false,
    });
    expect(fresh.json.account).toBeNull();

    const birth = await onboard(b, ADULT_BIRTHDATE, uniquePhone());
    expect(birth.status).toBe(200);
    expect(birth.json.onboarding).toMatchObject({ phoneVerified: true, hasBirthdate: true, isAdult: true });

    const opened = await b.call(R.provision.POST, "POST", "/api/v1/onboarding/provision");
    expect(opened.status).toBe(201);
    expect(opened.json.balancePaise).toBe("100000000000");
    expect(opened.json.card?.lastFour).toMatch(/^\d{4}$/);
    expect(opened.text).not.toMatch(/042000\d{10}/); // the full number only through reveal
    const again = await b.call(R.provision.POST, "POST", "/api/v1/onboarding/provision");
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ...opened.json, created: false });
    const cardId = str(opened.json.card?.id);

    const wallet0 = await b.call(R.wallet.GET, "GET", "/api/v1/wallet");
    expect(wallet0.status).toBe(200);
    expect(wallet0.json.balancePaise).toBe(STARTER_GRANT_PAISE.toString());
    expect(wallet0.json.bankAlias).toMatch(/^DM-ACCT-[A-Z]{8}$/);
    expect(wallet0.json.delulupayId).toMatch(/^dm-[a-z]{10}@delulu$/);
    expect(wallet0.json.card).toMatchObject({ id: cardId, status: "ACTIVE", pinSet: false });

    const pinSet = await b.call(R.cardPin.POST, "POST", `/api/v1/cards/${cardId}/pin`, {
      params: { id: cardId },
      body: { pin: GOOD_PIN },
    });
    expect(pinSet.status).toBe(200);

    const reveal = await b.call(R.cardReveal.POST, "POST", `/api/v1/cards/${cardId}/reveal`, {
      params: { id: cardId },
    });
    expect(reveal.status).toBe(200);
    expect(reveal.json.cardNumber).toMatch(/^042000\d{10}$/);

    const session = await checkout(b, product.id);
    expect(session.status).toBe(201);
    const expectedTotal = product.pricePaise + DELIVERY_STANDARD_PAISE;
    expect(session.json.totalPaise).toBe(expectedTotal.toString());
    expect(arr(session.json.sellers)[0]).toMatchObject({
      sellerId: "SEED",
      speed: "STANDARD",
      listPaise: product.pricePaise.toString(),
      deliveryFeePaise: DELIVERY_STANDARD_PAISE.toString(),
    });
    const sessionId = str(session.json.id);

    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "CARD", cardId },
    });
    expect(attempt.status).toBe(201);
    expect(attempt.json.authenticated).toBe(false);
    const attemptId = str(attempt.json.id);

    const pinOk = await b.call(R.attemptPin.POST, "POST", `/api/v1/attempts/${attemptId}/pin`, {
      params: { id: attemptId },
      body: { pin: GOOD_PIN },
    });
    expect(pinOk.status).toBe(200);
    expect(pinOk.json).toEqual({ authenticated: true });

    const payKey = randomUUID();
    const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId },
      idempotencyKey: payKey,
    });
    expect(paid.status).toBe(200);
    const balanceAfter = STARTER_GRANT_PAISE - expectedTotal;
    expect(paid.json).toMatchObject({
      totalPaise: expectedTotal.toString(),
      balanceAfterPaise: balanceAfter.toString(),
      reversed: false,
    });
    const orderId = str(paid.json.orderId);

    const replay = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId },
      idempotencyKey: payKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.json.orderId).toBe(orderId);

    const wallet1 = await b.call(R.wallet.GET, "GET", "/api/v1/wallet");
    expect(wallet1.json.balancePaise).toBe(balanceAfter.toString());

    const list = await b.call(R.orders.GET, "GET", "/api/v1/orders");
    expect(list.status).toBe(200);
    expect(arr(list.json.items).map((o) => o.id)).toEqual([orderId]);
    const one = await b.call(R.order.GET, "GET", `/api/v1/orders/${orderId}`, { params: { id: orderId } });
    expect(one.status).toBe(200);
    expect(one.json.totalPaise).toBe(expectedTotal.toString());
    expect(arr(arr(one.json.sellerOrders)[0]?.lines)[0]?.productId).toBe(product.id);

    const owned = await b.call(R.collection.GET, "GET", "/api/v1/collection");
    expect(arr(owned.json.items).map((i) => i.productId)).toEqual([product.id]);

    const statement = await b.call(R.statement.GET, "GET", "/api/v1/statement");
    expect(statement.status).toBe(200);
    expect(arr(statement.json.items)[0]).toMatchObject({
      amountPaise: (-expectedTotal).toString(),
      balanceAfterPaise: balanceAfter.toString(),
      orderGroupId: orderId,
    });

    const overlay = await b.call(
      R.overlay.GET,
      "GET",
      `/api/v1/me/overlay?productIds=${app.products.map((p) => p.id).join(",")}`,
    );
    expect(overlay.json).toEqual({ owned: [product.id], balancePaise: balanceAfter.toString() });

    const me = await b.call(R.me.GET, "GET", "/api/v1/me");
    expect(me.json.onboarding).toMatchObject({ provisioned: true, pinSet: true });
    expect(me.json.account?.balancePaise).toBe(balanceAfter.toString());

    // nothing the server holds in secret ever reached the browser
    const all = b.seen.join("\n");
    for (const secret of serverSecrets()) expect(all).not.toContain(secret);
    expect(all).not.toContain(GOOD_PIN);
    const sid = b.cookie("__Host-dm_session") ?? "";
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(all).not.toContain(sid);

    // sign-out deletes the session: the old cookie no longer works
    const out = await b.call(R.signOut.POST, "POST", "/api/v1/auth/sign-out");
    expect(out.status).toBe(200);
    expect(
      out.headers.getSetCookie().some((c) => c.startsWith("__Host-dm_session=;") && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(b.cookie("__Host-dm_session")).toBeUndefined();
    const stale = await b.call(R.wallet.GET, "GET", "/api/v1/wallet", {
      headers: { cookie: `__Host-dm_session=${sid}` },
    });
    expect(stale.status).toBe(401);
    const count = await app.db.pool.query("SELECT count(*)::int AS n FROM auth.sessions WHERE id = $1", [
      sid,
    ]);
    expect(count.rows[0]?.n).toBe(0);
  });

  it("US-14: the BALANCE method pays without a PIN", async () => {
    const product = app.products[1];
    if (!product) throw new Error("no seed product");
    const { b } = await player({ pin: false });
    const session = await checkout(b, product.id);
    expect(session.status).toBe(201);
    const sessionId = str(session.json.id);
    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "BALANCE" },
    });
    expect(attempt.status).toBe(201);
    expect(attempt.json.authenticated).toBe(true);
    const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId: str(attempt.json.id) },
      idempotencyKey: true,
    });
    expect(paid.status).toBe(200);
    const total = product.pricePaise + DELIVERY_STANDARD_PAISE;
    expect(paid.json.balanceAfterPaise).toBe((STARTER_GRANT_PAISE - total).toString());
    const wallet = await b.call(R.wallet.GET, "GET", "/api/v1/wallet");
    expect(wallet.json.balancePaise).toBe((STARTER_GRANT_PAISE - total).toString());
  });

  it("US-14: creating a checkout session again with the same Idempotency-Key returns the same session", async () => {
    const product = app.products[2];
    if (!product) throw new Error("no seed product");
    const { b } = await player({ pin: false });
    const key = randomUUID();
    const first = await checkout(b, product.id, key);
    const second = await checkout(b, product.id, key);
    expect(second.status).toBe(201);
    expect(second.json.id).toBe(first.json.id);
  });
});
