import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as adminStatus from "../src/app/api/v1/admin/status/route";
import * as profile from "../src/app/api/v1/profile/route";
import * as coupons from "../src/app/api/v1/studio/coupons/route";
import * as earnings from "../src/app/api/v1/studio/earnings/route";
import * as inventory from "../src/app/api/v1/studio/inventory/route";
import * as studioOrder from "../src/app/api/v1/studio/orders/[id]/route";
import * as studioOrders from "../src/app/api/v1/studio/orders/route";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, type Browser, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";
import { aMinuteLater, makeAdmin, publishedListing, type Seller, seller } from "./helpers/studio";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const REF = /^SO-[A-Z2-9]{16}$/;

/**
 * Seventh security review through the routes: the seller's order reference (major 3), screened
 * public coupon codes and user handles (minor 5a), and the stalled-screening count (minor 5b).
 */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ env: { RATE_LIMIT_MULTIPLIER: "20" } });
}, 120_000);
afterAll(async () => {
  await app.stop();
});

const p = (id: string) => ({ params: { id } });
const orders = (b: Browser, qs = "") => b.call(studioOrders.GET, "GET", `/api/v1/studio/orders${qs}`);
const order = (b: Browser, id: string) =>
  b.call(studioOrder.GET, "GET", `/api/v1/studio/orders/${encodeURIComponent(id)}`, p(id));

async function buy(b: Browser, productId: string, companyId: string) {
  const quote = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
    body: { lines: [{ productId }], speedBySeller: { [companyId]: "STANDARD" } },
    idempotencyKey: true,
  });
  expect(quote.status, quote.text).toBe(201);
  const sessionId = str(quote.json.id);
  const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body: { method: "BALANCE" },
  });
  const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId: str(attempt.json.id) },
    idempotencyKey: true,
  });
  expect(paid.status, paid.text).toBe(200);
}

describe("major 3: the seller's order reference", () => {
  let s: Seller;

  beforeAll(async () => {
    s = await seller(app);
    const productId = await publishedListing(s.b, { quantity: 3 });
    for (let i = 0; i < 2; i++) await buy((await player({ pin: false })).b, productId, s.companyId);
    await aMinuteLater(app); // 0060: a seller sees an order once its minute has ended
  }, 120_000);

  /** Every id of a buyer-side record of the store's orders. */
  async function buyerSide(): Promise<Set<string>> {
    const { rows } = await app.db.pool.query<{ id: string }>(
      `WITH so AS (SELECT * FROM core.seller_order WHERE company_id = $1)
       SELECT so.id::text FROM so
       UNION SELECT so.order_group_id::text FROM so
       UNION SELECT so.buyer_user_id::text FROM so
       UNION SELECT g.payment_attempt_id::text FROM core.order_group g JOIN so ON so.order_group_id = g.id
       UNION SELECT g.session_id::text FROM core.order_group g JOIN so ON so.order_group_id = g.id
       UNION SELECT l.id::text FROM core.order_line l JOIN so ON so.id = l.seller_order_id
       UNION SELECT sh.id::text FROM core.shipment sh JOIN so ON so.id = sh.seller_order_id
       UNION SELECT u.id::text FROM core.inventory_unit u JOIN core.order_line l ON l.id = u.order_line_id
                                                          JOIN so ON so.id = l.seller_order_id`,
      [s.companyId],
    );
    return new Set(rows.map((r) => r.id.toLowerCase()));
  }

  it("major 3: list, detail, earnings and inventory carry no buyer-side id and no time finer than a minute", async () => {
    const page = await orders(s.b, "?limit=1");
    expect(page.status).toBe(200);
    const first = arr(page.json.items)[0];
    expect(str(first?.id)).toMatch(REF);
    expect(str(page.json.nextCursor)).toMatch(REF);
    const responses = {
      list: await orders(s.b),
      page,
      next: await orders(s.b, `?limit=1&cursor=${str(page.json.nextCursor)}`),
      detail: await order(s.b, str(first?.id)),
      earnings: await s.b.call(earnings.GET, "GET", "/api/v1/studio/earnings"),
      inventory: await s.b.call(inventory.GET, "GET", "/api/v1/studio/inventory"),
    };
    const forbidden = await buyerSide();
    expect(forbidden.size).toBeGreaterThan(8);
    for (const [name, res] of Object.entries(responses)) {
      expect(res.status, `${name}: ${res.text}`).toBe(200);
      const leaked = (res.text.match(UUID) ?? []).filter((u) => forbidden.has(u.toLowerCase()));
      expect(leaked, name).toEqual([]);
      for (const t of res.text.match(TIMESTAMP) ?? [])
        expect(t, `${name}: ${t}`).toMatch(/:\d{2}:00(?:\.0+)?(?:Z|[+-])/);
    }
    expect(arr(responses.next.json.items)[0]).not.toEqual(first);
  });

  it("major 3: the detail route takes the reference only — the seller order's id, another store's reference and junk are the same 404", async () => {
    const list = await orders(s.b);
    const ref = str(arr(list.json.items)[0]?.id);
    expect((await order(s.b, ref)).json.order?.id).toBe(ref);
    const { rows } = await app.db.pool.query<{ id: string }>(
      "SELECT id FROM core.seller_order WHERE company_id = $1 LIMIT 1",
      [s.companyId],
    );
    const other = await seller(app);
    const missing = await order(s.b, "SO-AAAAAAAAAAAAAAAA");
    expect(missing.status).toBe(404);
    for (const bad of [str(rows[0]?.id), "not-a-reference", "SO-' OR 1=1"]) {
      const res = await order(s.b, bad);
      expect(res.status, bad).toBe(404);
      expect(res.json).toEqual(missing.json);
    }
    expect((await order(other.b, ref)).status).toBe(404);
    // a v7 id as the list cursor is refused
    expect((await orders(s.b, `?cursor=${str(rows[0]?.id)}`)).status).toBe(400);
  });
});

describe("minor 5a: public coupon codes and user handles are screened", () => {
  it("minor 5a: a public coupon code that screening refuses, or with a protected word, is VALIDATION_FAILED; a plain one is made", async () => {
    const s = await seller(app);
    const make = (publicCode: string) =>
      s.b.call(coupons.POST, "POST", "/api/v1/studio/coupons", {
        body: { kind: "PERCENT", value: 10, isPublic: true, publicCode },
      });
    for (const code of ["FUCKOFF1", "PAYTM50", "DELULU10", "0FFICIAL", "ADRNIN50"]) {
      const res = await make(code);
      expect(res.status, code).toBe(422);
      expect(res.json.error?.code, code).toBe("VALIDATION_FAILED");
    }
    expect((await make("SUMMERSALE")).status).toBe(201); // capitals in a code are not shouting
    expect((await make("SHOP20")).status).toBe(201);
  });

  it("minor 5a: a user handle that screening refuses is VALIDATION_FAILED; a look-alike is CONFLICT", async () => {
    const { b } = await player({ pin: false });
    const update = (handle: string) => b.call(profile.POST, "POST", "/api/v1/profile", { body: { handle } });
    const rejected = await update("paytm-deals");
    expect(rejected.status).toBe(422);
    expect(rejected.json.error?.code).toBe("VALIDATION_FAILED");
    for (const h of ["adrnin", "delulurnart", "staffpicks", "admin1"]) {
      const res = await update(h);
      expect(res.status, h).toBe(409);
      expect(res.json.error?.code, h).toBe("CONFLICT");
    }
  });
});

describe("minor 5b: GET /api/v1/admin/status", () => {
  it("minor 5b: reports submissions stuck in screening separately and keeps every earlier field", async () => {
    const admin = (await player({ pin: false })).b;
    await makeAdmin(app, admin);
    const res = await admin.call(adminStatus.GET, "GET", "/api/v1/admin/status");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({
      publication: { enabled: true },
      moderationOverdue: { count: expect.any(Number), thresholdHours: 48 },
      screeningStalled: { count: expect.any(Number), thresholdHours: 48 },
      openReportCases: expect.any(Number),
      openAppeals: expect.any(Number),
      needsReview: expect.any(Number),
    });
    expect(res.json.screeningStalled).toHaveProperty("oldestAgeSeconds");
  });
});
