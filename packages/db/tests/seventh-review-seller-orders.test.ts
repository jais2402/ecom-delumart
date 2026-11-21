import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCoupon, mySellerOrder, mySellerOrders } from "../src/merchant";
import { CLEAN, checkout, codeOf, payFor, reconcile, user } from "./checkout-fixtures";
import { asActor, createTestDatabase, type TestDatabase, type TestUser } from "./helpers";
import { asFixture, type Creator, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
const REF = /^SO-[A-Z2-9]{16}$/;

/**
 * Seventh security review, major 3 (migration 0055): the seller's order view returned the seller
 * order's UUIDv7 id, whose first 48 bits are the order's millisecond timestamp. Sellers now see an
 * opaque, stable, random per-order reference instead, everywhere, and the seller reads take it.
 */
describe("seventh security review: the seller's order reference", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let s: Creator;
  let other: Creator;
  let buyers: TestUser[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    const seeds = await published(pool, 3);
    s = await creator(pool, seeds);
    other = await creator(pool, seeds);
    const p = asFixture(await publishListing(pool, s, { quantity: 5 }));
    const priv = await createCoupon(pool, {
      authSessionId: s.u.authSessionId,
      coupon: { kind: "PERCENT", value: 10n, isPublic: false },
    });
    await createCoupon(pool, {
      authSessionId: s.u.authSessionId,
      coupon: { kind: "PERCENT", value: 5n, isPublic: true, publicCode: "MOONFIVE" },
    });
    const std = { [s.companyId]: "STANDARD" as const };
    buyers = [await user(pool), await user(pool), await user(pool)];
    const [b1, b2, b3] = buyers as [TestUser, TestUser, TestUser];
    await payFor(pool, b1, await checkout(pool, b1, [p], std, priv.code));
    await payFor(pool, b2, await checkout(pool, b2, [p], std, "MOONFIVE"));
    await payFor(pool, b3, await checkout(pool, b3, [p], std));
    // a sale of the other store, whose reference s must not be able to open
    const q = asFixture(await publishListing(pool, other));
    await payFor(pool, b1, await checkout(pool, b1, [q], { [other.companyId]: "STANDARD" }));
    expect(await reconcile(pool)).toEqual(CLEAN);
  }, 240_000);
  afterAll(async () => {
    await db.drop();
  });

  /** Every id of a buyer-side record of the seller's orders (and the buyers' own ids). */
  async function buyerSideIds(): Promise<Set<string>> {
    const { rows } = await pool.query<{ id: string }>(
      `WITH so AS (SELECT * FROM core.seller_order WHERE company_id = ANY ($1::uuid[]))
       SELECT so.id::text FROM so
       UNION SELECT so.order_group_id::text FROM so
       UNION SELECT so.buyer_user_id::text FROM so
       UNION SELECT g.payment_attempt_id::text FROM core.order_group g JOIN so ON so.order_group_id = g.id
       UNION SELECT g.session_id::text FROM core.order_group g JOIN so ON so.order_group_id = g.id
       UNION SELECT g.journal_id::text FROM core.order_group g JOIN so ON so.order_group_id = g.id
       UNION SELECT l.id::text FROM core.order_line l JOIN so ON so.id = l.seller_order_id
       UNION SELECT sh.id::text FROM core.shipment sh JOIN so ON so.id = sh.seller_order_id
       UNION SELECT o.id::text FROM core.ownership o JOIN core.order_line l ON l.id = o.order_line_id JOIN so ON so.id = l.seller_order_id
       UNION SELECT u.id::text FROM core.inventory_unit u JOIN core.order_line l ON l.id = u.order_line_id JOIN so ON so.id = l.seller_order_id
       UNION SELECT la.id::text FROM ledger.ledger_account la JOIN so ON so.buyer_user_id = la.user_id`,
      [[s.companyId, other.companyId]],
    );
    return new Set(rows.map((r) => r.id.toLowerCase()));
  }

  const sellerRead = (sql: string, params: unknown[] = []) =>
    asActor(
      pool,
      { role: "app_web", userId: s.u.userId },
      async (c) => (await c.query<{ r: unknown }>(sql, params)).rows[0]?.r,
    );

  it("major 3: no seller-facing read carries a buyer-side id, and the order reads carry no time finer than a minute", async () => {
    const forbidden = await buyerSideIds();
    expect(forbidden.size).toBeGreaterThan(20);
    const first = (await sellerRead("SELECT core.my_seller_orders(NULL, 1) AS r")) as { nextCursor: string };
    const orderReads: Record<string, unknown> = {
      list: await sellerRead("SELECT core.my_seller_orders(NULL, NULL) AS r"),
      firstPage: first,
      nextPage: await sellerRead("SELECT core.my_seller_orders($1, 1) AS r", [first.nextCursor]),
      detail: await sellerRead("SELECT core.my_seller_order($1) AS r", [first.nextCursor]),
      earnings: await sellerRead("SELECT core.my_earnings(7) AS r"),
      inventory: await sellerRead("SELECT core.my_inventory() AS r"),
      brand: await sellerRead("SELECT core.my_brand_progress() AS r"),
    };
    const otherReads: Record<string, unknown> = {
      coupons: await sellerRead("SELECT core.my_coupons() AS r"),
      company: await sellerRead("SELECT core.my_company() AS r"),
      products: await sellerRead("SELECT core.my_products(NULL, NULL, NULL) AS r"),
    };
    for (const [name, value] of Object.entries({ ...orderReads, ...otherReads })) {
      const text = JSON.stringify(value);
      const leaked = (text.match(UUID) ?? []).filter((u) => forbidden.has(u.toLowerCase()));
      expect(leaked, name).toEqual([]);
    }
    for (const [name, value] of Object.entries(orderReads)) {
      const text = JSON.stringify(value);
      for (const t of text.match(TIMESTAMP) ?? []) {
        expect(t, `${name}: ${t}`).toMatch(/:\d{2}:00(?:\.0+)?(?:Z|[+-]|$)/);
      }
    }
  });

  it("major 3: each order has an opaque, stable reference that is not derived from any id", async () => {
    const a = await mySellerOrders(pool, { authSessionId: s.u.authSessionId });
    const b = await mySellerOrders(pool, { authSessionId: s.u.authSessionId });
    expect(a.items).toHaveLength(3);
    expect(a.items.map((o) => o.orderRef)).toEqual(b.items.map((o) => o.orderRef));
    const ids = await buyerSideIds();
    for (const o of a.items) {
      expect(o.orderRef).toMatch(REF);
      for (const id of ids)
        expect(id.replaceAll("-", "").toUpperCase()).not.toContain(o.orderRef.slice(3, 11));
    }
    expect(new Set(a.items.map((o) => o.orderRef)).size).toBe(3);
  });

  it("major 3: the seller reads take the reference — a v7 id, another store's reference or a malformed one is NOT_FOUND", async () => {
    const page = await mySellerOrders(pool, { authSessionId: s.u.authSessionId, pageSize: 1 });
    const ref = page.items[0]?.orderRef ?? "";
    expect((await mySellerOrder(pool, { authSessionId: s.u.authSessionId, orderRef: ref })).orderRef).toBe(
      ref,
    );
    // paging continues from the reference
    const next = await mySellerOrders(pool, {
      authSessionId: s.u.authSessionId,
      pageSize: 1,
      cursor: page.nextCursor,
    });
    expect(next.items[0]?.orderRef).not.toBe(ref);
    expect(next.items[0]?.orderRef).toMatch(REF);
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM core.seller_order WHERE company_id = $1 LIMIT 1",
      [s.companyId],
    );
    const theirs = await mySellerOrders(pool, { authSessionId: other.u.authSessionId });
    for (const bad of [rows[0]?.id ?? "", theirs.items[0]?.orderRef ?? "", "SO-' OR 1=1 --", ""]) {
      expect(
        await codeOf(mySellerOrder(pool, { authSessionId: s.u.authSessionId, orderRef: bad })),
        bad,
      ).toMatch(/NOT_FOUND|VALIDATION_FAILED/);
    }
    // the old uuid-taking reads are gone
    expect(
      (
        await pool.query(
          "SELECT 1 FROM pg_proc WHERE oid::regprocedure::text IN ('core.my_seller_order(uuid)', 'core.my_seller_orders(uuid,integer)')",
        )
      ).rowCount,
    ).toBe(0);
  });

  it("major 3: every seller order gets its reference, whoever writes it; references are unique", async () => {
    const { rows } = await pool.query<{ missing: string; dupes: string }>(
      `SELECT (SELECT count(*) FROM core.seller_order so
                WHERE NOT EXISTS (SELECT 1 FROM core.seller_order_ref r WHERE r.seller_order_id = so.id)) AS missing,
              (SELECT count(*) - count(DISTINCT reference) FROM core.seller_order_ref) AS dupes`,
    );
    expect(rows[0]).toEqual({ missing: "0", dupes: "0" });
    for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      const { rows: r } = await pool.query<{ ok: boolean }>(
        "SELECT has_table_privilege($1, 'core.seller_order_ref', 'SELECT') AS ok",
        [role],
      );
      expect(r[0]?.ok, role).toBe(false);
    }
  });
});
