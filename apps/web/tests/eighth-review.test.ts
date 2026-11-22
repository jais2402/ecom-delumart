import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as events from "../src/app/api/v1/events/route";
import * as earnings from "../src/app/api/v1/studio/earnings/route";
import * as studioOrder from "../src/app/api/v1/studio/orders/[id]/route";
import * as studioOrders from "../src/app/api/v1/studio/orders/route";
import { settleTracking } from "../src/server/analytics";
import { PEER_HEADER, peerStampValue } from "../src/server/client-address";
import { APP_ORIGIN, startTestApp, type TestApp } from "./helpers/app";
import { arr, type Browser, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";
import { aMinuteLater, publishedListing, type Seller, seller } from "./helpers/studio";

/**
 * Eighth security review through the routes: the studio's order and earnings reads are rate
 * limited and show an order once its minute has ended (minor 7); POST /api/v1/events refuses a
 * large body before reading it (minor 8a); the pay route does not wait for analytics (minor 8c).
 */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
}, 180_000);
afterAll(async () => {
  await app.stop();
});

async function pay(b: Browser, productId: string, sellerKey = "SEED") {
  const session = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
    body: { lines: [{ productId }], speedBySeller: { [sellerKey]: "STANDARD" } },
    idempotencyKey: true,
  });
  expect(session.status, session.text).toBe(201);
  const sessionId = str(session.json.id);
  const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body: { method: "BALANCE" },
  });
  return b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId: str(attempt.json.id) },
    idempotencyKey: true,
  });
}

const count = async (sql: string) => Number((await app.db.pool.query(sql)).rows[0]?.n);

describe("minor 7: the studio's order reads", () => {
  let s: Seller;

  beforeAll(async () => {
    s = await seller(app);
    const productId = await publishedListing(s.b, { quantity: 3 });
    const paid = await pay((await player({ pin: false })).b, productId, s.companyId);
    expect(paid.status, paid.text).toBe(200);
  }, 180_000);

  it("minor 7: an order is listed once its minute has ended; then the detail opens by its reference", async () => {
    await aMinuteLater(app);
    const list = await s.b.call(studioOrders.GET, "GET", "/api/v1/studio/orders");
    expect(list.status, list.text).toBe(200);
    const ref = str(arr(list.json.items)[0]?.id);
    const detail = await s.b.call(studioOrder.GET, "GET", `/api/v1/studio/orders/${ref}`, {
      params: { id: ref },
    });
    expect(detail.status).toBe(200);
  });

  it("minor 7: the order list, detail and earnings share a per-account rate limit (30 a minute)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await s.b.call(studioOrders.GET, "GET", "/api/v1/studio/orders")).status);
      statuses.push((await s.b.call(earnings.GET, "GET", "/api/v1/studio/earnings")).status);
      statuses.push(
        (
          await s.b.call(studioOrder.GET, "GET", "/api/v1/studio/orders/SO-AAAAAAAAAAAAAAAA", {
            params: { id: "SO-AAAAAAAAAAAAAAAA" },
          })
        ).status,
      );
    }
    expect(statuses).toContain(429);
    // the earlier calls of this file count too: at most 30 answers before the first 429
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(30);
    const limited = await s.b.call(earnings.GET, "GET", "/api/v1/studio/earnings");
    expect(limited.status).toBe(429);
    expect(limited.json.error?.code).toBe("RATE_LIMITED");
  });
});

describe("minor 8a: POST /api/v1/events reads at most its cap", () => {
  function endlessRequest(headers: Record<string, string>) {
    const seen = { bytes: 0 };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = new TextEncoder().encode(" ".repeat(256));
          seen.bytes += chunk.length;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(new URL("/api/v1/events", APP_ORIGIN), {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        "content-type": "application/json",
        [PEER_HEADER]: peerStampValue("198.51.100.7"),
        ...headers,
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return { request, seen };
  }

  it("minor 8a: a Content-Length above the cap is refused before anything is read; an endless body stops at the cap", async () => {
    const before = await count("SELECT count(*) AS n FROM analytics.event");
    const declared = endlessRequest({ "content-length": "1000000" });
    const a = await events.POST(declared.request);
    expect(a.status).toBe(204);
    expect(declared.seen.bytes).toBe(0);
    const unannounced = endlessRequest({});
    const b = await events.POST(unannounced.request);
    expect(b.status).toBe(204);
    expect(unannounced.seen.bytes).toBeLessThanOrEqual(1024 + 512);
    expect(await count("SELECT count(*) AS n FROM analytics.event")).toBe(before);
  });
});

describe("minor 8c: the pay route does not wait for analytics", () => {
  it("minor 8c: a payment answers while the analytics table is locked; the purchase event is written afterwards", async () => {
    const { b } = await player({ pin: false });
    const p = app.products[1];
    if (!p) throw new Error("no product");
    const before = await count("SELECT count(*) AS n FROM analytics.event WHERE name = 'purchase'");
    const lock = await app.db.pool.connect();
    let elapsed = 0;
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE analytics.event IN EXCLUSIVE MODE");
      const t0 = Date.now();
      const paid = await pay(b, p.id);
      elapsed = Date.now() - t0;
      expect(paid.status, paid.text).toBe(200);
    } finally {
      await lock.query("COMMIT");
      lock.release();
    }
    // the event's insert waited for the lock (up to its 2s lock timeout); the answer did not
    expect(elapsed).toBeLessThan(1_500);
    await settleTracking();
    expect(await count("SELECT count(*) AS n FROM analytics.event WHERE name = 'purchase'")).toBe(before + 1);
    const { rows } = await app.db.pool.query<{ vk: boolean; props: unknown }>(
      "SELECT visitor_key IS NULL AS vk, props FROM analytics.event WHERE name = 'purchase' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0]?.vk).toBe(true);
    expect(Object.keys(rows[0]?.props ?? {})).toEqual(["amount_bucket"]);
  });
});
