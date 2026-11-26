import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogProduct, catalogProducts, storeProducts } from "../src/catalog";
import { createCheckoutSession } from "../src/checkout";
import {
  archiveProduct,
  endSale,
  hideListing,
  myProduct,
  myProducts,
  restoreListing,
  setProductPrice,
  setProductShipping,
  setSalePrice,
} from "../src/listing";
import { createCoupon, myEarnings } from "../src/merchant";
import {
  aMinuteLater,
  CLEAN,
  checkout,
  codeOf,
  journalPostings,
  key,
  type ProductFixture,
  payFor,
  RUPEE,
  reconcile,
  STANDARD_DELIVERY,
  sinkBalance,
  user,
} from "./checkout-fixtures";
import { createTestDatabase, inTx, plant, stateOf, type TestDatabase, type TestUser } from "./helpers";
import { asFixture, type Creator, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

const REASON = "Checking the sale price rules.";

/** Sale price with a reference price (R6.2, US-43), price history (R8), free Standard delivery (R6.5, R6.6). */
describe("sale price and merchant-funded delivery (migrations 0080-0082)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;
  let seeds: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    seeds = await published(pool, 3);
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  }, 120_000);
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });
  const store = () => creator(pool, seeds);
  const std = (c: Creator) => ({ [c.companyId]: "STANDARD" as const });
  /** The product's price history reads: the earlier prices were live for `interval` before the newest change. */
  const backdate = (productId: string, interval: string) =>
    plant(pool, (x) =>
      x.query(
        `UPDATE core.price_history SET changed_at = (SELECT max(changed_at) FROM core.price_history WHERE product_id = $1) - $2::interval
          WHERE product_id = $1 AND id < (SELECT max(id) FROM core.price_history WHERE product_id = $1)`,
        [productId, interval],
      ),
    );
  /** Moves every price change of the product back by `interval` (so the current price has been live that long). */
  const ageHistory = (productId: string, interval: string) =>
    plant(pool, (x) =>
      x.query("UPDATE core.price_history SET changed_at = changed_at - $2::interval WHERE product_id = $1", [
        productId,
        interval,
      ]),
    );
  const ref = async (productId: string) => (await catalogProduct(pool, productId))?.referencePricePaise;
  const live = async (c: Creator, productId: string) => myProduct(pool, { ...as(c.u), productId });
  const versions = (productId: string) =>
    pool
      .query<{ n: string }>("SELECT count(*) AS n FROM core.product_version WHERE product_id = $1", [
        productId,
      ])
      .then((r) => Number(r.rows[0]?.n));

  // ------------------------------------------------------------------ setting and ending a sale
  describe("setting and ending a sale", () => {
    it("US-43: a sale makes the lower price the live price, with the list price kept for ending it", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE, quantity: 3 });
      const r = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: 800n * RUPEE,
      });
      expect(r.live?.pricePaise).toBe(800n * RUPEE);
      expect(r.sale).toMatchObject({
        active: true,
        listPaise: 1_000n * RUPEE,
        salePaise: 800n * RUPEE,
        referencePaise: null, // the list price was live for seconds only
        canShowReference: false,
      });
      expect((await catalogProduct(pool, l.productId))?.pricePaise).toBe(800n * RUPEE);
      expect(r.priceHistory.map((h) => [h.reason, h.pricePaise, h.previousPaise])).toEqual([
        ["SALE_START", 800n * RUPEE, 1_000n * RUPEE],
        ["PUBLISHED", 1_000n * RUPEE, null],
      ]);
      // not on sale before
      expect((await live(c, l.productId)).sale.active).toBe(true);
      expect(
        (await myProducts(pool, as(c.u))).items.find((i) => i.productId === l.productId)?.sale.active,
      ).toBe(true);
    });

    it("US-43: the previous price shows struck through only when it was the published price for 24 hours", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "24 hours");
      const r = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: 800n * RUPEE,
      });
      expect(r.sale).toMatchObject({ referencePaise: 1_000n * RUPEE });
      expect(await ref(l.productId)).toBe(1_000n * RUPEE);
      const inStore = (await storeProducts(pool, { handle: c.handle })).items.find(
        (p) => p.productId === l.productId,
      );
      expect(inStore).toMatchObject({ pricePaise: 800n * RUPEE, referencePricePaise: 1_000n * RUPEE });
      let seen: bigint | null | undefined;
      let cursor: string | null = null;
      do {
        const page = await catalogProducts(pool, { cursor, pageSize: 50 });
        seen ??= page.items.find((p) => p.productId === l.productId)?.referencePricePaise;
        cursor = page.nextCursor;
      } while (cursor !== null && seen === undefined);
      expect(seen).toBe(1_000n * RUPEE);
    });

    it("US-43: the 24-hour edge of a sale's reference: exactly 24 hours shows it, one microsecond short does not", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      await backdate(l.productId, "23 hours 59 minutes 59.999999 seconds");
      expect(await ref(l.productId)).toBeNull();
      await backdate(l.productId, "24 hours");
      expect(await ref(l.productId)).toBe(1_000n * RUPEE);
    });

    it("US-43: a sale on a price live for less than 24 hours shows only the current price (no error unless a reference was asked for)", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "23 hours");
      const r = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: 800n * RUPEE,
      });
      expect(r.live?.pricePaise).toBe(800n * RUPEE);
      expect(await ref(l.productId)).toBeNull();
    });

    it("US-43: REFERENCE_PRICE_INELIGIBLE when a reference was asked for and the earlier price does not qualify; nothing changes", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "23 hours");
      const before = await versions(l.productId);
      expect(
        await codeOf(
          setSalePrice(pool, {
            ...as(c.u),
            productId: l.productId,
            salePricePaise: 800n * RUPEE,
            requireReference: true,
          }),
        ),
      ).toBe("REFERENCE_PRICE_INELIGIBLE");
      const after = await live(c, l.productId);
      expect(after.live?.pricePaise).toBe(1_000n * RUPEE);
      expect(after.sale.active).toBe(false);
      expect(after.priceHistory).toHaveLength(1);
      expect(await versions(l.productId)).toBe(before);
      // an hour later (24 hours in all) it qualifies
      await ageHistory(l.productId, "1 hour");
      const ok = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: 800n * RUPEE,
        requireReference: true,
      });
      expect(ok.sale.referencePaise).toBe(1_000n * RUPEE);
    });

    it("US-43: canShowReference says exactly what asking for a reference would do (24 hours, a hide breaks it)", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      expect((await live(c, l.productId)).sale.canShowReference).toBe(false);
      await ageHistory(l.productId, "24 hours");
      expect((await live(c, l.productId)).sale.canShowReference).toBe(true);
      // a listing hidden while the price was live was not continuously published
      await hideListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      await restoreListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      await plant(pool, (x) =>
        x.query(
          `UPDATE core.listing_hide SET hidden_at = hidden_at - interval '10 hours',
                  lifted_at = lifted_at - interval '10 hours' WHERE product_id = $1`,
          [l.productId],
        ),
      );
      expect((await live(c, l.productId)).sale.canShowReference).toBe(false);
      expect(
        await codeOf(
          setSalePrice(pool, {
            ...as(c.u),
            productId: l.productId,
            salePricePaise: 800n * RUPEE,
            requireReference: true,
          }),
        ),
      ).toBe("REFERENCE_PRICE_INELIGIBLE");
    });

    it("US-43: ending a sale restores the list price and removes the reference", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE, quantity: 2 });
      await ageHistory(l.productId, "48 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 700n * RUPEE });
      expect(await ref(l.productId)).toBe(1_000n * RUPEE);
      const r = await endSale(pool, { ...as(c.u), productId: l.productId });
      expect(r.live?.pricePaise).toBe(1_000n * RUPEE);
      expect(r.sale).toMatchObject({ active: false, salePaise: null });
      expect(await ref(l.productId)).toBeNull();
      expect((await catalogProduct(pool, l.productId))?.pricePaise).toBe(1_000n * RUPEE);
      expect(r.priceHistory.map((h) => h.reason)).toEqual(["SALE_END", "SALE_START", "PUBLISHED"]);
      expect(r.priceHistory[0]).toMatchObject({ pricePaise: 1_000n * RUPEE, previousPaise: 700n * RUPEE });
      expect(await codeOf(endSale(pool, { ...as(c.u), productId: l.productId }))).toBe("NOT_EDITABLE");
    });

    it("US-43: a sale ended and restarted at once shows no reference (the list price was live for minutes)", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "100 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      await endSale(pool, { ...as(c.u), productId: l.productId });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      expect(await ref(l.productId)).toBeNull();
    });

    it("US-43: changing the sale price keeps the list price; the old sale price is the reference only if it was live 24 hours", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      const r = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: 700n * RUPEE,
      });
      expect(r.sale).toMatchObject({ active: true, listPaise: 1_000n * RUPEE, salePaise: 700n * RUPEE });
      expect(r.priceHistory.map((h) => h.reason)).toEqual(["SALE_CHANGE", "SALE_START", "PUBLISHED"]);
      expect(await ref(l.productId)).toBeNull();
      const ended = await endSale(pool, { ...as(c.u), productId: l.productId });
      expect(ended.live?.pricePaise).toBe(1_000n * RUPEE);
    });

    it("US-43: a sale price must be lower than the list price, a whole-rupee price in range; only a live listing goes on sale", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      const set = (p: bigint) =>
        setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: p });
      expect(await codeOf(set(1_000n * RUPEE))).toBe("VALIDATION_FAILED");
      expect(await codeOf(set(1_200n * RUPEE))).toBe("VALIDATION_FAILED");
      expect(await codeOf(set(800n * RUPEE + 1n))).toBe("VALIDATION_FAILED");
      expect(await codeOf(set(99n * RUPEE))).toBe("VALIDATION_FAILED");
      expect(await codeOf(set(0n))).toBe("VALIDATION_FAILED");
      // while on sale, the bound is still the LIST price
      await set(800n * RUPEE);
      expect(await codeOf(set(900n * RUPEE))).toBe("ok");
      expect(await codeOf(set(1_000n * RUPEE))).toBe("VALIDATION_FAILED");
      // a draft and an archived listing are not put on sale
      const draft = await publishListing(pool, c, { pricePaise: 500n * RUPEE, quantity: 2 });
      await archiveProduct(pool, { ...as(c.u), productId: draft.productId });
      expect(
        await codeOf(
          setSalePrice(pool, { ...as(c.u), productId: draft.productId, salePricePaise: 200n * RUPEE }),
        ),
      ).toBe("NOT_EDITABLE");
    });

    it("US-08: the list price cannot be changed during a sale (end the sale first); afterwards it can", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      expect(
        await codeOf(
          setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 1_200n * RUPEE }),
        ),
      ).toBe("NOT_EDITABLE");
      expect((await live(c, l.productId)).live?.pricePaise).toBe(800n * RUPEE);
      await endSale(pool, { ...as(c.u), productId: l.productId });
      const r = await setProductPrice(pool, {
        ...as(c.u),
        productId: l.productId,
        pricePaise: 1_200n * RUPEE,
      });
      expect(r.live?.pricePaise).toBe(1_200n * RUPEE);
    });

    it("US-08: a price-changing command that is a no-op writes nothing (same sale price again)", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      const n = await versions(l.productId);
      const r = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: 800n * RUPEE,
      });
      expect(r.priceHistory).toHaveLength(2);
      expect(await versions(l.productId)).toBe(n);
    });

    it("US-08: price changes per listing per day are limited from configuration (RATE_LIMITED), counting sales and price changes", async () => {
      await inTx(pool, async (x) => {
        await x.query(
          `INSERT INTO core.config_version (values, effective_from, note)
           SELECT values || '{"price_changes_per_product_per_day": 4}'::jsonb, now(), 'price change cap test'
             FROM core.config_version ORDER BY id DESC LIMIT 1`,
        );
      });
      try {
        const c = await store();
        const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
        const go = (p: bigint) =>
          setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: p });
        await go(900n * RUPEE); // 1
        await go(800n * RUPEE); // 2
        await endSale(pool, { ...as(c.u), productId: l.productId }); // 3
        await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 1_100n * RUPEE }); // 4
        expect(await codeOf(go(900n * RUPEE))).toBe("RATE_LIMITED");
        expect(
          await codeOf(
            setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 1_200n * RUPEE }),
          ),
        ).toBe("RATE_LIMITED");
        // another listing has its own allowance
        const other = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
        expect(
          await codeOf(
            setSalePrice(pool, { ...as(c.u), productId: other.productId, salePricePaise: 900n * RUPEE }),
          ),
        ).toBe("ok");
      } finally {
        await inTx(pool, async (x) => {
          await x.query(
            `INSERT INTO core.config_version (values, effective_from, note)
             SELECT values - 'price_changes_per_product_per_day', now(), 'price change cap test: restore'
               FROM core.config_version ORDER BY id DESC LIMIT 1`,
          );
        });
      }
    });
  });

  // ------------------------------------------------------------------ who may
  describe("who may change a live price", () => {
    it("US-45 R8: only the company owner; another company, a worker or a stranger is refused (NOT_FOUND / COMPANY_FEE_REQUIRED), and nothing changes", async () => {
      const a = await store();
      const b = await store();
      const l = await publishListing(pool, a, { pricePaise: 1_000n * RUPEE });
      const stranger = await user(pool);
      const asB = { authSessionId: b.u.authSessionId };
      expect(
        await codeOf(setSalePrice(pool, { ...asB, productId: l.productId, salePricePaise: 500n * RUPEE })),
      ).toBe("NOT_FOUND");
      expect(await codeOf(endSale(pool, { ...asB, productId: l.productId }))).toBe("NOT_FOUND");
      // a signed-in player with no creator access or no company (a worker is such a person: there are no seats yet)
      expect(
        await codeOf(
          setSalePrice(pool, { ...as(stranger), productId: l.productId, salePricePaise: 500n * RUPEE }),
        ),
      ).toMatch(/^(CREATOR_LOCKED|COMPANY_FEE_REQUIRED)$/);
      expect((await live(a, l.productId)).live?.pricePaise).toBe(1_000n * RUPEE);
      // no session at all
      expect(
        await stateOf(pool, "SELECT core.product_set_sale_price($1, 50000, false)", [l.productId], {
          role: "app_web",
        }),
      ).not.toBe("no error");
      expect(
        await stateOf(pool, "SELECT core.product_end_sale($1)", [l.productId], { role: "app_web" }),
      ).not.toBe("no error");
    });

    it("US-08: the sale commands run only for app_web; app_pay, app_jobs, anon and authenticated cannot execute them", async () => {
      const { rows } = await pool.query<{ role: string; f: string }>(
        `SELECT r AS role, p.oid::regprocedure::text AS f
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro','anon','authenticated']) r
          WHERE n.nspname = 'core' AND p.proname IN
                ('product_set_sale_price', 'product_end_sale', 'reference_price', 'reference_price_possible',
                 'price_change_check')
            AND has_function_privilege(r, p.oid, 'EXECUTE')
          ORDER BY 1, 2`,
      );
      expect(rows).toEqual([
        { role: "app_web", f: "core.product_end_sale(uuid)" },
        { role: "app_web", f: "core.product_set_sale_price(uuid,bigint,boolean)" },
      ]);
    });

    it("US-08: no application role reads or writes the sale table or the price history directly", async () => {
      for (const role of [
        "app_web",
        "app_pay",
        "app_jobs",
        "anon",
        "authenticated",
        "npc_worker",
        "research_ro",
      ]) {
        const held = await pool.query<{ t: string; p: string }>(
          `SELECT t, p FROM unnest(ARRAY['core.product_sale', 'core.price_history']) t,
                  unnest(ARRAY['SELECT','INSERT','UPDATE']) p WHERE has_any_column_privilege($1, t, p)
           UNION ALL
           SELECT t, p FROM unnest(ARRAY['core.product_sale', 'core.price_history']) t,
                  unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege($1, t, p)`,
          [role],
        );
        expect(held.rows, role).toEqual([]);
      }
      const rls = await pool.query<{ rls: boolean; policies: string }>(
        `SELECT c.relrowsecurity AS rls, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
           FROM pg_class c WHERE c.oid = 'core.product_sale'::regclass`,
      );
      expect(rls.rows[0]).toEqual({ rls: true, policies: "1" });
    });

    it("US-08: the sale record cannot be deleted, re-pointed or re-dated, even by the owner role", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      const other = await publishListing(pool, c, { pricePaise: 600n * RUPEE });
      const bad = [
        "DELETE FROM core.product_sale WHERE product_id = $1",
        "UPDATE core.product_sale SET list_paise = list_paise + 100 WHERE product_id = $1",
        "UPDATE core.product_sale SET started_at = started_at - interval '1 day' WHERE product_id = $1",
        `UPDATE core.product_sale SET product_id = '${other.productId}' WHERE product_id = $1`,
        "UPDATE core.product_sale SET sale_paise = list_paise WHERE product_id = $1",
        "UPDATE core.product_sale SET sale_paise = 0 WHERE product_id = $1",
      ];
      for (const sql of bad) {
        expect(await stateOf(pool, sql, [l.productId]), sql).not.toBe("no error");
      }
      await endSale(pool, { ...as(c.u), productId: l.productId });
      expect(
        await stateOf(pool, "UPDATE core.product_sale SET ended_at = NULL WHERE product_id = $1", [
          l.productId,
        ]),
      ).not.toBe("no error");
      // one open sale per product
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      expect(
        await stateOf(
          pool,
          "INSERT INTO core.product_sale (product_id, list_paise, sale_paise) VALUES ($1, 1000000, 900000)",
          [l.productId],
        ),
      ).not.toBe("no error");
    });
  });

  // ------------------------------------------------------------------ the event
  describe("the sale_price_set event", () => {
    it("R10: a sale writes sale_price_set to the outbox, an end writes sale_price_ended; payloads carry ids and prices only", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "48 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      await endSale(pool, { ...as(c.u), productId: l.productId });
      const { rows } = await pool.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM audit.outbox WHERE aggregate_id = $1 AND type IN ('sale_price_set', 'sale_price_ended')
          ORDER BY id`,
        [l.productId],
      );
      expect(rows.map((r) => r.type)).toEqual(["sale_price_set", "sale_price_ended"]);
      expect(rows[0]?.payload).toMatchObject({
        productId: l.productId,
        companyId: c.companyId,
        listPaise: (1_000n * RUPEE).toString(),
        salePaise: (800n * RUPEE).toString(),
        referencePaise: (1_000n * RUPEE).toString(),
      });
      expect(rows[1]?.payload).toMatchObject({
        productId: l.productId,
        listPaise: (1_000n * RUPEE).toString(),
      });
      const text = JSON.stringify(rows);
      expect(text).not.toContain(c.u.userId);
      expect(text).not.toContain(c.u.authSessionId);
    });
  });

  // ------------------------------------------------------------------ buying
  describe("buying at the sale price", () => {
    it("US-43 US-08: a quote taken before a sale (or before it ends) is refused at pay (CART_CHANGED); a fresh quote pays the sale price", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE, quantity: 5 });
      const buyer = await user(pool);
      const before = await checkout(pool, buyer, [asFixture(l)], std(c));
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      expect(await codeOf(payFor(pool, buyer, before))).toBe("CART_CHANGED");
      const onSale = await live(c, l.productId);
      const fresh = await checkout(pool, buyer, [asFixture(onSale)], std(c));
      expect(fresh.totalPaise).toBe(800n * RUPEE + STANDARD_DELIVERY);
      // the sale ends before the buyer pays: the quote at the sale price is stale
      await endSale(pool, { ...as(c.u), productId: l.productId });
      expect(await codeOf(payFor(pool, buyer, fresh))).toBe("CART_CHANGED");
      const again = await checkout(pool, buyer, [asFixture(await live(c, l.productId))], std(c));
      expect(again.totalPaise).toBe(1_000n * RUPEE + STANDARD_DELIVERY);
    });

    it("R6.6 US-40: at the sale price the marketplace fee is 5% of the sale price; the buyer, seller and SINK postings balance", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 2_000n * RUPEE, quantity: 2 });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 1_000n * RUPEE });
      const buyer = await user(pool);
      const p = asFixture(await live(c, l.productId));
      const sinkBefore = await sinkBalance(pool);
      const receipt = await payFor(pool, buyer, await checkout(pool, buyer, [p], std(c)));
      const posts = await journalPostings(pool, receipt.orderGroupId);
      expect(posts.get(buyer.ledgerAccountId)).toBe(-(1_000n * RUPEE + STANDARD_DELIVERY));
      expect(posts.get(c.u.ledgerAccountId)).toBe(950n * RUPEE);
      expect((await sinkBalance(pool)) - sinkBefore).toBe(50n * RUPEE + STANDARD_DELIVERY);
    });

    it("R6.5 R6.6: free Standard delivery offered by the merchant on a sale item: buyer pays no fee, seller +₹94,000, SINK +₹6,000 (the fee is deducted from the seller)", async () => {
      const c = await store();
      const l = await publishListing(pool, c, {
        pricePaise: 125_000n * RUPEE,
        quantity: 2,
        freeStandardDelivery: true,
      });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 100_000n * RUPEE });
      const buyer = await user(pool);
      const p = asFixture(await live(c, l.productId));
      const sinkBefore = await sinkBalance(pool);
      const co = await checkout(pool, buyer, [p], std(c));
      expect(co.totalPaise).toBe(100_000n * RUPEE);
      expect(co.sellers[0]).toMatchObject({
        deliveryFeeBuyerPaise: 0n,
        deliveryFeeSellerPaise: STANDARD_DELIVERY,
      });
      const receipt = await payFor(pool, buyer, co);
      const posts = await journalPostings(pool, receipt.orderGroupId);
      expect(posts.get(buyer.ledgerAccountId)).toBe(-100_000n * RUPEE);
      expect(posts.get(c.u.ledgerAccountId)).toBe(94_000n * RUPEE);
      expect((await sinkBalance(pool)) - sinkBefore).toBe(6_000n * RUPEE);
    });

    it("R6.5: the free-delivery toggle applies to later quotes only and is per product; switching it off charges the buyer again", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 5_000n * RUPEE, quantity: 3 });
      const buyer = await user(pool);
      const p = asFixture(l);
      expect((await checkout(pool, buyer, [p], std(c))).totalPaise).toBe(5_000n * RUPEE + STANDARD_DELIVERY);
      await setProductShipping(pool, { ...as(c.u), productId: l.productId, freeStandardDelivery: true });
      expect((await checkout(pool, buyer, [p], std(c))).totalPaise).toBe(5_000n * RUPEE);
      await setProductShipping(pool, { ...as(c.u), productId: l.productId, freeStandardDelivery: false });
      expect((await checkout(pool, buyer, [p], std(c))).totalPaise).toBe(5_000n * RUPEE + STANDARD_DELIVERY);
    });

    it("R6.5: free delivery that the sale price cannot fund (fee above the seller's proceeds) is refused at quote time with DELIVERY_UNAVAILABLE", async () => {
      const c = await store();
      const l = await publishListing(pool, c, {
        pricePaise: 5_000n * RUPEE,
        quantity: 3,
        freeStandardDelivery: true,
      });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 500n * RUPEE });
      const buyer = await user(pool);
      // ₹500 sale: fee ₹25, proceeds ₹475, merchant-funded delivery ₹1,000
      expect(
        await codeOf(
          createCheckoutSession(pool, {
            authSessionId: buyer.authSessionId,
            lines: [{ productId: l.productId }],
            speedBySeller: std(c),
            idempotencyKey: key(),
          }),
        ),
      ).toBe("DELIVERY_UNAVAILABLE");
    });
  });

  // ------------------------------------------------------------------ finances
  describe("finances: discount given and merchant-funded delivery (R8)", () => {
    it("US-45 R6.6: earnings show gross, discount, fee, merchant-funded delivery and net once each, and net equals the ledger credit", async () => {
      const c = await store();
      const l = await publishListing(pool, c, {
        pricePaise: 10_000n * RUPEE,
        quantity: 3,
        freeStandardDelivery: true,
      });
      await ageHistory(l.productId, "30 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 8_000n * RUPEE });
      const onSale = asFixture(await live(c, l.productId));
      await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "PERCENT", value: 10n, isPublic: true, publicCode: "SALE10" },
      });
      const buyer = await user(pool);
      const co = await checkout(pool, buyer, [onSale], std(c), "sale10");
      // 10% coupon on the sale price: ₹800 off, buyer pays ₹7,200 and no delivery fee
      expect(co.totalPaise).toBe(7_200n * RUPEE);
      const receipt = await payFor(pool, buyer, co);
      await aMinuteLater(pool);
      const e = await myEarnings(pool, { ...as(c.u), days: 7 });
      // gross = list (the sale price) after the coupon; the coupon is the discount given
      expect(e.current).toMatchObject({
        orders: 1,
        grossPaise: 7_200n * RUPEE,
        discountPaise: 800n * RUPEE,
        feesPaise: 360n * RUPEE,
        merchantDeliveryPaise: STANDARD_DELIVERY,
        netPaise: 7_200n * RUPEE - 360n * RUPEE - STANDARD_DELIVERY,
      });
      const posts = await journalPostings(pool, receipt.orderGroupId);
      expect(posts.get(c.u.ledgerAccountId)).toBe(BigInt(e.current.netPaise));
      expect(e.current.grossPaise - e.current.feesPaise - e.current.merchantDeliveryPaise).toBe(
        e.current.netPaise,
      );
      // staff and the previous period carry the same columns, zero here
      expect(e.previous.discountPaise).toBe(0n);
      expect(e.staff.current.discountPaise).toBe(0n);
    });
  });

  // ------------------------------------------------------------------ price history
  describe("price history (R8)", () => {
    it("R8: the owner reads the whole price history of their listing newest first; another company cannot", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 1_100n * RUPEE });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 900n * RUPEE });
      await endSale(pool, { ...as(c.u), productId: l.productId });
      const r = await live(c, l.productId);
      expect(r.priceHistory.map((h) => [h.reason, h.pricePaise, h.previousPaise])).toEqual([
        ["SALE_END", 1_100n * RUPEE, 900n * RUPEE],
        ["SALE_START", 900n * RUPEE, 1_100n * RUPEE],
        ["PRICE_CHANGE", 1_100n * RUPEE, 1_000n * RUPEE],
        ["PUBLISHED", 1_000n * RUPEE, null],
      ]);
      const other = await store();
      expect(await codeOf(myProduct(pool, { ...as(other.u), productId: l.productId }))).toBe("NOT_FOUND");
      // the history says nothing about buyers or sales
      const text = JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(text).not.toMatch(/buyer|orderRef|sold/i);
    });
  });

  // ------------------------------------------------------------------ the public storefront
  describe("the public catalogue", () => {
    it("US-43: public answers carry the reference price only when eligible, and no sale record, list price or history", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      const p = await catalogProduct(pool, l.productId);
      expect(p?.referencePricePaise).toBeNull();
      expect(Object.keys(p ?? {}).sort()).toEqual(
        expect.arrayContaining(["pricePaise", "referencePricePaise"]),
      );
      expect(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(
        /listPaise|salePaise|history|canShowReference/,
      );
    });
  });
});
