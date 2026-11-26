import {
  DEFAULT_PRICING_CONFIG,
  minPriceForFreeDelivery,
  type PricePoint,
  referenceCeiling,
  referencePrice,
} from "@delulu/core";
import fc from "fast-check";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogProduct, catalogProducts, storeProducts } from "../src/catalog";
import { createCheckoutSession } from "../src/checkout";
import {
  archiveProduct,
  createDraft,
  decideListing,
  endSale,
  hideListing,
  myProduct,
  myProducts,
  restoreListing,
  reviseProduct,
  setProductPrice,
  setProductShipping,
  setSalePrice,
  submitProduct,
  updateDraft,
} from "../src/listing";
import { createCoupon, myEarnings } from "../src/merchant";
import {
  aMinuteLater,
  CLEAN,
  checkout,
  codeOf,
  count,
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
import {
  asFixture,
  type Creator,
  creator,
  draftInput,
  ensureCategories,
  publishListing,
  screen,
} from "./listing-fixtures";
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
  /** Runs fn under a configuration version with `json` merged into the latest values, then puts those keys back. */
  const withConfig = async (json: string, fn: () => Promise<void>) => {
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    const before = (
      await pool.query<{ v: Record<string, unknown> }>(
        "SELECT values AS v FROM core.config_version ORDER BY id DESC LIMIT 1",
      )
    ).rows[0]?.v as Record<string, unknown>;
    await inTx(pool, async (x) => {
      await x.query(
        `INSERT INTO core.config_version (values, effective_from, note)
         SELECT values || $1::jsonb, now(), 'sale price test' FROM core.config_version ORDER BY id DESC LIMIT 1`,
        [json],
      );
    });
    try {
      await fn();
    } finally {
      const restore = Object.fromEntries(keys.filter((k) => k in before).map((k) => [k, before[k]]));
      await inTx(pool, async (x) => {
        await x.query(
          `INSERT INTO core.config_version (values, effective_from, note)
           SELECT (values - $1::text[]) || $2::jsonb, now(), 'sale price test: restore'
             FROM core.config_version ORDER BY id DESC LIMIT 1`,
          [keys, JSON.stringify(restore)],
        );
      });
    }
  };
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
        referenceCeilingPaise: null,
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

    it("US-43: canShowReference and the ceiling say what asking for a reference would do (24 published hours; hidden time does not count)", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      expect((await live(c, l.productId)).sale).toMatchObject({
        canShowReference: false,
        referenceCeilingPaise: null,
      });
      await ageHistory(l.productId, "30 hours");
      expect((await live(c, l.productId)).sale).toMatchObject({
        canShowReference: true,
        referenceCeilingPaise: 1_000n * RUPEE,
      });
      // hidden for 10 of the 30 hours: 20 published hours remain, under the 24 required
      await hideListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      await restoreListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      await plant(pool, (x) =>
        x.query(
          `UPDATE core.listing_hide SET hidden_at = now() - interval '25 hours', lifted_at = now() - interval '15 hours'
            WHERE product_id = $1`,
          [l.productId],
        ),
      );
      expect((await live(c, l.productId)).sale).toMatchObject({
        canShowReference: false,
        referenceCeilingPaise: null,
      });
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
      // a hide of an hour leaves 29 published hours: the reference shows
      await plant(pool, (x) =>
        x.query(
          `UPDATE core.listing_hide SET hidden_at = now() - interval '25 hours', lifted_at = now() - interval '24 hours'
            WHERE product_id = $1`,
          [l.productId],
        ),
      );
      expect((await live(c, l.productId)).sale.canShowReference).toBe(true);
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

    it("US-08: price changes per listing per day are limited from configuration (RATE_LIMITED); an end is never blocked but counts, so start/end cycles are bounded", async () => {
      await withConfig('{"price_changes_per_product_per_day": 3}', async () => {
        const c = await store();
        const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
        const go = (p: bigint) =>
          setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: p });
        const end = () => endSale(pool, { ...as(c.u), productId: l.productId });
        expect((await live(c, l.productId)).sale.rules).toMatchObject({
          priceChangesPerDay: 3,
          changesRemaining: 3,
        });
        await go(900n * RUPEE); // 1: start
        await end(); // 2: end
        await go(900n * RUPEE); // 3: start again; at the cap with a sale open
        expect((await live(c, l.productId)).sale.rules.changesRemaining).toBe(0);
        // no more starts or changes, and no list price change, at the cap
        expect(await codeOf(go(800n * RUPEE))).toBe("RATE_LIMITED");
        // fixing a mistake: ending the sale still works at the cap, and writes its history row
        const ended = await end();
        expect(ended.live?.pricePaise).toBe(1_000n * RUPEE);
        expect(ended.priceHistory[0]?.reason).toBe("SALE_END");
        // ... but it counted: the next start is refused, and so is a list price change
        expect(await codeOf(go(900n * RUPEE))).toBe("RATE_LIMITED");
        expect(
          await codeOf(
            setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 1_200n * RUPEE }),
          ),
        ).toBe("RATE_LIMITED");
        // another listing has its own allowance
        const other = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
        await setSalePrice(pool, { ...as(c.u), productId: other.productId, salePricePaise: 900n * RUPEE });
        await endSale(pool, { ...as(c.u), productId: other.productId });
        expect((await live(c, other.productId)).sale.rules.changesRemaining).toBe(1);
      });
    });

    it("US-08: with the default allowance of 20, ten start/end cycles use it up (20 cycles are no longer possible)", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      for (let i = 0; i < 10; i++) {
        await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 900n * RUPEE });
        await endSale(pool, { ...as(c.u), productId: l.productId });
      }
      expect(
        await codeOf(
          setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 900n * RUPEE }),
        ),
      ).toBe("RATE_LIMITED");
      expect((await live(c, l.productId)).sale.rules.changesRemaining).toBe(0);
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
                ('product_set_sale_price', 'product_end_sale', 'reference_price', 'reference_ceiling', 'published_low',
                 'price_change_check', 'min_free_delivery_price', 'free_delivery_check')
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

    it("R6.5 (review minor 2): a sale price that cannot fund free Standard delivery is refused with FREE_DELIVERY_UNFUNDED, naming the minimum price", async () => {
      const c = await store();
      const l = await publishListing(pool, c, {
        pricePaise: 5_000n * RUPEE,
        quantity: 3,
        freeStandardDelivery: true,
      });
      const min = minPriceForFreeDelivery(DEFAULT_PRICING_CONFIG) as bigint;
      expect((await live(c, l.productId)).sale.rules.freeDeliveryMinPaise).toBe(min);
      const err = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: min - RUPEE,
      }).then(
        () => null,
        (e: unknown) => e as { code: string; message: string },
      );
      expect(err?.code).toBe("FREE_DELIVERY_UNFUNDED");
      expect(err?.message).toContain((min / RUPEE).toString());
      expect((await live(c, l.productId)).live?.pricePaise).toBe(5_000n * RUPEE);
      // at the minimum it is buyable: the seller's credit is not negative
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: min });
      const buyer = await user(pool);
      const co = await checkout(pool, buyer, [asFixture(await live(c, l.productId))], std(c));
      expect(co.totalPaise).toBe(min);
      await payFor(pool, buyer, co);
    });

    it("R6.5 (review minor 2): turning free Standard delivery on, or lowering the price under it, is refused when the live price cannot fund it", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE, quantity: 3 });
      const min = minPriceForFreeDelivery(DEFAULT_PRICING_CONFIG) as bigint;
      expect(min).toBe(1_053n * RUPEE);
      expect(
        await codeOf(
          setProductShipping(pool, { ...as(c.u), productId: l.productId, freeStandardDelivery: true }),
        ),
      ).toBe("FREE_DELIVERY_UNFUNDED");
      // an unrelated shipping change and turning it off are fine
      expect(
        await codeOf(setProductShipping(pool, { ...as(c.u), productId: l.productId, offersExpress: true })),
      ).toBe("ok");
      expect(
        await codeOf(
          setProductShipping(pool, { ...as(c.u), productId: l.productId, freeStandardDelivery: false }),
        ),
      ).toBe("ok");
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: min });
      expect(
        await codeOf(
          setProductShipping(pool, { ...as(c.u), productId: l.productId, freeStandardDelivery: true }),
        ),
      ).toBe("ok");
      // with free delivery on, a price under the minimum is refused (a sale, or a plain price change)
      expect(
        await codeOf(setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: min - RUPEE })),
      ).toBe("FREE_DELIVERY_UNFUNDED");
      // during a sale the live (sale) price counts
      const s = await publishListing(pool, c, { pricePaise: 5_000n * RUPEE, quantity: 3 });
      await setSalePrice(pool, { ...as(c.u), productId: s.productId, salePricePaise: 1_000n * RUPEE });
      expect(
        await codeOf(
          setProductShipping(pool, { ...as(c.u), productId: s.productId, freeStandardDelivery: true }),
        ),
      ).toBe("FREE_DELIVERY_UNFUNDED");
    });

    it("R6.5: the minimum price for free delivery follows the configuration and equals the pricing function's", async () => {
      await inTx(pool, async (x) => {
        await x.query(
          `INSERT INTO core.config_version (values, effective_from, note)
           SELECT values || '{"fee_percent": 10, "delivery_fee_paise": {"STANDARD": "250000", "EXPRESS": "1000000", "ZAP": "5000000"}}'::jsonb,
                  now(), 'free delivery minimum test'
             FROM core.config_version ORDER BY id DESC LIMIT 1`,
        );
      });
      try {
        const c = await store();
        const l = await publishListing(pool, c, { pricePaise: 5_000n * RUPEE, quantity: 3 });
        const cfg = {
          ...DEFAULT_PRICING_CONFIG,
          feePercent: 10,
          deliveryFeePaise: { ...DEFAULT_PRICING_CONFIG.deliveryFeePaise, STANDARD: 250_000n },
        };
        const expected = minPriceForFreeDelivery(cfg) as bigint;
        expect(expected).not.toBe(minPriceForFreeDelivery(DEFAULT_PRICING_CONFIG));
        expect((await live(c, l.productId)).sale.rules.freeDeliveryMinPaise).toBe(expected);
      } finally {
        await inTx(pool, async (x) => {
          await x.query(
            `INSERT INTO core.config_version (values, effective_from, note)
             SELECT values - 'fee_percent' - 'delivery_fee_paise', now(), 'free delivery minimum test: restore'
               FROM core.config_version ORDER BY id DESC LIMIT 1`,
          );
        });
      }
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

  // ------------------------------------------------------------------ the lowest-prior-price rule
  describe("the reference is the lowest price of the last 30 days (review major 1)", () => {
    it("US-43 (attack 1): raising the price first, waiting 25 hours and cutting shows no reference above the 30-day low", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "26 hours");
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 100_000n * RUPEE });
      await ageHistory(l.productId, "25 hours");
      const r = await setSalePrice(pool, {
        ...as(c.u),
        productId: l.productId,
        salePricePaise: 50_000n * RUPEE,
      });
      expect(await ref(l.productId)).toBeNull();
      expect(r.sale.referencePaise).toBeNull();
      // asking for a reference is refused, and nothing is above the low of 1,000 anyway
      expect(
        await codeOf(
          setSalePrice(pool, {
            ...as(c.u),
            productId: l.productId,
            salePricePaise: 40_000n * RUPEE,
            requireReference: true,
          }),
        ),
      ).toBe("REFERENCE_PRICE_INELIGIBLE");
      // the only price that could show is the 30-day low, and only below it: nothing here is
      expect((await live(c, l.productId)).sale.referenceCeilingPaise).toBe(1_000n * RUPEE);
    });

    it("US-43 (attack 2): inside a sale, raising the sale price for 25 hours and dropping it back shows no reference above the 30-day low", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "48 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 600n * RUPEE });
      await ageHistory(l.productId, "1 hour");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 900n * RUPEE });
      await ageHistory(l.productId, "25 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 650n * RUPEE });
      expect(await ref(l.productId)).toBeNull(); // the 30-day low is 600
      // below the low it does show the low (never the raised 900 or the list 1,000)
      await ageHistory(l.productId, "25 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 500n * RUPEE });
      expect(await ref(l.productId)).toBe(600n * RUPEE);
    });

    it("US-43: a low price older than 30 days is forgotten", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 500n * RUPEE });
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "10 days"); // the 500 run ended 10 days ago and began longer ago
      await plant(pool, (x) =>
        x.query(
          `UPDATE core.price_history SET changed_at = changed_at - interval '40 days'
            WHERE product_id = $1 AND price_paise = 50000`,
          [l.productId],
        ),
      );
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      // the sale took effect now: the 500 run (40 to 10 days ago) is inside the 30 days before it
      expect(await ref(l.productId)).toBeNull();
      // the earlier prices move 31 days further back: the 500 run is now outside the 30 days
      await plant(pool, (x) =>
        x.query(
          "UPDATE core.price_history SET changed_at = changed_at - interval '31 days' WHERE product_id = $1 AND price_paise <> 80000",
          [l.productId],
        ),
      );
      expect(await ref(l.productId)).toBe(1_000n * RUPEE);
    });
  });

  describe("the database and the TypeScript rule agree (property)", () => {
    const priceArb = fc.integer({ min: 100, max: 5_000 });
    const gapArb = fc.integer({ min: 0, max: 400 });
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant("LIST" as const), rupees: priceArb, gap: gapArb }),
      fc.record({ kind: fc.constant("SALE" as const), cut: fc.integer({ min: 1, max: 90 }), gap: gapArb }),
      fc.record({ kind: fc.constant("END" as const), gap: gapArb }),
      fc.record({ kind: fc.constant("HIDE" as const), gap: gapArb, hours: fc.integer({ min: 0, max: 200 }) }),
    );

    it("US-43: for random publish, price, sale and hide histories the catalogue's reference equals referencePrice(), the ceiling equals referenceCeiling(), and a sale asking for a reference succeeds exactly when TypeScript says", async () => {
      let shown = 0;
      let refused = 0;
      await fc.assert(
        fc.asyncProperty(
          priceArb,
          fc.array(opArb, { minLength: 1, maxLength: 8 }),
          fc.integer({ min: 0, max: 120 }),
          fc.integer({ min: 100, max: 5_000 }),
          async (first, ops, idle, candidate) => {
            const c = await store();
            const l = await publishListing(pool, c, { pricePaise: BigInt(first) * RUPEE });
            const pid = l.productId;
            const count = async (table: string) =>
              Number(
                (
                  await pool.query<{ n: string }>(
                    `SELECT count(*) AS n FROM ${table} WHERE product_id = $1`,
                    [pid],
                  )
                ).rows[0]?.n,
              );
            // hours (from the start of the timeline) of each price row and each hide, in recorded order
            const priceAt: number[] = [0];
            const hideAt: [number, number][] = [];
            let t = 0;
            let live = l;
            for (const op of ops) {
              const before = await count("core.price_history");
              if (op.kind === "HIDE") {
                await hideListing(pool, { ...as(admin), productId: pid, reason: REASON });
                await restoreListing(pool, { ...as(admin), productId: pid, reason: REASON });
                hideAt.push([t + op.gap, t + op.gap + op.hours]);
                t += op.gap + op.hours;
                continue;
              }
              const list = live.sale.active
                ? (live.sale.listPaise as bigint)
                : (live.live?.pricePaise as bigint);
              if (op.kind === "LIST") {
                await codeOf(
                  setProductPrice(pool, {
                    ...as(c.u),
                    productId: pid,
                    pricePaise: BigInt(op.rupees) * RUPEE,
                  }),
                );
              } else if (op.kind === "SALE") {
                const target = ((list * BigInt(100 - op.cut)) / 100n / RUPEE) * RUPEE;
                await codeOf(setSalePrice(pool, { ...as(c.u), productId: pid, salePricePaise: target }));
              } else {
                await codeOf(endSale(pool, { ...as(c.u), productId: pid }));
              }
              live = await myProduct(pool, { ...as(c.u), productId: pid });
              if ((await count("core.price_history")) > before) {
                t += op.gap;
                priceAt.push(t);
              }
            }
            // give the recorded rows these synthetic times, the last event `idle` hours ago
            const base = Date.now() - (t + idle) * 3_600_000;
            const at = (h: number) => new Date(base + h * 3_600_000);
            await plant(pool, async (x) => {
              const rows = await x.query<{ id: string }>(
                "SELECT id FROM core.price_history WHERE product_id = $1 ORDER BY id",
                [pid],
              );
              for (const [i, r] of rows.rows.entries()) {
                await x.query("UPDATE core.price_history SET changed_at = $2 WHERE id = $1", [
                  r.id,
                  at(priceAt[i] ?? 0),
                ]);
              }
              const hides = await x.query<{ id: string }>(
                "SELECT id FROM core.listing_hide WHERE product_id = $1 ORDER BY hidden_at, id",
                [pid],
              );
              for (const [i, r] of hides.rows.entries()) {
                const [from, to] = hideAt[i] ?? [0, 0];
                await x.query("UPDATE core.listing_hide SET hidden_at = $2, lifted_at = $3 WHERE id = $1", [
                  r.id,
                  at(from),
                  at(to),
                ]);
              }
            });
            const history: PricePoint[] = (
              await pool.query<{ p: string; at: Date }>(
                "SELECT price_paise::text AS p, changed_at AS at FROM core.price_history WHERE product_id = $1 ORDER BY id",
                [pid],
              )
            ).rows.map((r) => ({ pricePaise: BigInt(r.p), at: r.at }));
            const offSale = (
              await pool.query<{ a: Date; b: Date | null }>(
                "SELECT hidden_at AS a, lifted_at AS b FROM core.listing_hide WHERE product_id = $1",
                [pid],
              )
            ).rows.map((r) => ({ from: r.a, to: r.b }));
            // the catalogue (public) answer against the TypeScript rule
            expect(await ref(pid)).toBe(referencePrice(history, { offSale }));
            // the owner's ceiling against the TypeScript rule, at the database's own clock
            const now = (await pool.query<{ n: Date }>("SELECT clock_timestamp() AS n")).rows[0]?.n as Date;
            const view = await myProduct(pool, { ...as(c.u), productId: pid });
            const ceiling = referenceCeiling(history, now, { offSale });
            expect(view.sale.referenceCeilingPaise).toBe(ceiling);
            expect(view.sale.canShowReference).toBe(ceiling !== null && ceiling > 100n * RUPEE);
            // a sale price below the list price, asked to carry a reference
            const liveNow = view.live?.pricePaise as bigint;
            const listNow = view.sale.active ? (view.sale.listPaise as bigint) : liveNow;
            const cand = BigInt(candidate) * RUPEE;
            if (cand >= listNow || cand === liveNow) return;
            const outcome = await codeOf(
              setSalePrice(pool, {
                ...as(c.u),
                productId: pid,
                salePricePaise: cand,
                requireReference: true,
              }),
            );
            if (ceiling !== null && cand < ceiling) {
              shown += 1;
              expect(outcome).toBe("ok");
              expect(await ref(pid)).toBe(ceiling);
            } else {
              refused += 1;
              expect(outcome).toBe("REFERENCE_PRICE_INELIGIBLE");
            }
          },
        ),
        { numRuns: 40, seed: 20261126 },
      );
      expect(shown).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
    }, 300_000);
  });

  describe("free delivery cannot bypass the floor (review round 2, major 1)", () => {
    const floor = 1_053n * RUPEE;
    const draftErr = (fn: () => Promise<unknown>) =>
      fn().then(
        () => null,
        (e: unknown) => e as { code: string; message: string },
      );

    it("R6.5: a draft created, updated or submitted with free Standard delivery on at a price that cannot fund it is refused, naming the minimum", async () => {
      const c = await store();
      const e1 = await draftErr(() =>
        createDraft(pool, {
          ...as(c.u),
          draft: draftInput({ pricePaise: 100n * RUPEE, freeStandardDelivery: true }),
        }),
      );
      expect(e1?.code).toBe("FREE_DELIVERY_UNFUNDED");
      expect(e1?.message).toContain("1053");
      // a draft without the flag is fine, and updating it into the flag at ₹100 is refused
      const d = await createDraft(pool, { ...as(c.u), draft: draftInput({ pricePaise: 100n * RUPEE }) });
      const e2 = await draftErr(() =>
        updateDraft(pool, { ...as(c.u), productId: d.productId, changes: { freeStandardDelivery: true } }),
      );
      expect(e2?.code).toBe("FREE_DELIVERY_UNFUNDED");
      expect((await myProduct(pool, { ...as(c.u), productId: d.productId })).freeStandardDelivery).toBe(
        false,
      );
      // lowering the price of a flagged draft under the floor is refused; at the floor it is fine
      const f = await createDraft(pool, {
        ...as(c.u),
        draft: draftInput({ pricePaise: floor, freeStandardDelivery: true }),
      });
      expect(
        (
          await draftErr(() =>
            updateDraft(pool, { ...as(c.u), productId: f.productId, changes: { pricePaise: floor - RUPEE } }),
          )
        )?.code,
      ).toBe("FREE_DELIVERY_UNFUNDED");
      expect(
        await codeOf(
          updateDraft(pool, { ...as(c.u), productId: f.productId, changes: { name: "Still fine" } }),
        ),
      ).toBe("ok");
      // a draft that got an unfunded flag some other way (the floor moved) cannot be submitted
      await withConfig('{"fee_percent": 50}', async () => {
        expect(
          (await draftErr(() => submitProduct(pool, { ...as(c.u), productId: f.productId })))?.code,
        ).toBe("FREE_DELIVERY_UNFUNDED");
      });
      expect(await codeOf(submitProduct(pool, { ...as(c.u), productId: f.productId }))).toBe("ok");
    });

    it("R6.5: the approval backstop: a first submission that became unfunded before approval is rejected with the reason, never published", async () => {
      const c = await store();
      const d = await createDraft(pool, {
        ...as(c.u),
        draft: draftInput({ pricePaise: floor, freeStandardDelivery: true, quantity: 2 }),
      });
      await submitProduct(pool, { ...as(c.u), productId: d.productId });
      await withConfig('{"fee_percent": 50}', async () => {
        expect(await screen(pool, d.productId, "OK")).toMatchObject({ outcome: "REJECTED" });
      });
      const after = await myProduct(pool, { ...as(c.u), productId: d.productId });
      expect(after.status).toBe("REJECTED");
      expect(after.moderationReason).toMatch(/free Standard delivery needs a price of at least ₹\d+/);
      expect(after.lastDecision).toMatchObject({
        state: "REJECTED",
        reasons: [{ field: "freeStandardDelivery", code: "UNFUNDED" }],
      });
      expect(after.live).toBeNull();
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.inventory_unit WHERE product_id = $1", [
          d.productId,
        ]),
      ).toBe(0);
    });

    it("R6.5: the approval backstop for a revision: the revision is rejected and the live listing stays as it was", async () => {
      const c = await store();
      const l = await publishListing(pool, c, {
        pricePaise: 1_500n * RUPEE,
        quantity: 2,
        freeStandardDelivery: true,
      });
      await reviseProduct(pool, {
        ...as(c.u),
        productId: l.productId,
        revision: { name: "Moon Lamp Deluxe" },
      });
      await withConfig('{"fee_percent": 50}', async () => {
        expect(await screen(pool, l.productId, "OK")).toMatchObject({ outcome: "REJECTED" });
      });
      const after = await myProduct(pool, { ...as(c.u), productId: l.productId });
      expect(after.status).toBe("PUBLISHED");
      expect(after.live?.name).toBe(l.live?.name);
      expect(after.lastDecision).toMatchObject({ kind: "REVISION", state: "REJECTED" });
      expect(after.lastDecision?.reason).toMatch(/at least ₹/);
    });

    it("R6.5: a Super Admin approval is held to the same backstop, and publishing from a stock wait refuses an unfunded listing", async () => {
      const c = await store();
      const d = await createDraft(pool, {
        ...as(c.u),
        draft: draftInput({ pricePaise: floor, freeStandardDelivery: true, quantity: 2 }),
      });
      await submitProduct(pool, { ...as(c.u), productId: d.productId });
      await screen(pool, d.productId, "NEEDS_REVIEW");
      await withConfig('{"fee_percent": 50}', async () => {
        const r = await decideListing(pool, {
          ...as(admin),
          productId: d.productId,
          versionId: (await myProduct(pool, { ...as(c.u), productId: d.productId })).pending?.version
            .versionId as string,
          decision: "APPROVE",
          reason: REASON,
        });
        expect(r.outcome).toBe("REJECTED");
      });
      expect((await myProduct(pool, { ...as(c.u), productId: d.productId })).status).toBe("REJECTED");
    });
  });

  describe("the floor against the real checkout under another configuration (review round 2, minor 1)", () => {
    it("R6.5: at a non-default fee and Standard fee, a quote at the SQL floor minus one rupee is refused and at the floor accepted", async () => {
      const cfg = {
        ...DEFAULT_PRICING_CONFIG,
        feePercent: 10,
        deliveryFeePaise: { ...DEFAULT_PRICING_CONFIG.deliveryFeePaise, STANDARD: 250_000n },
      };
      const expected = minPriceForFreeDelivery(cfg) as bigint;
      expect(expected).toBe(277_800n);
      const c = await store();
      // listed under the default configuration, where both prices fund the fee
      const below = await publishListing(pool, c, {
        pricePaise: expected - RUPEE,
        quantity: 2,
        freeStandardDelivery: true,
      });
      const at = await publishListing(pool, c, {
        pricePaise: expected,
        quantity: 2,
        freeStandardDelivery: true,
      });
      await withConfig(
        '{"fee_percent": 10, "delivery_fee_paise": {"STANDARD": "250000", "EXPRESS": "1000000", "ZAP": "5000000"}}',
        async () => {
          expect((await live(c, at.productId)).sale.rules.freeDeliveryMinPaise).toBe(expected);
          const buyer = await user(pool);
          const quote = (l: typeof below) =>
            createCheckoutSession(pool, {
              authSessionId: buyer.authSessionId,
              lines: [{ productId: l.productId }],
              speedBySeller: std(c),
              idempotencyKey: key(),
            });
          expect(await codeOf(quote(below))).toBe("DELIVERY_UNAVAILABLE");
          const ok = await quote(at);
          expect(ok.totalPaise).toBe(expected);
          // and the sale-price path agrees at the same floor
          expect(
            await codeOf(
              setSalePrice(pool, { ...as(c.u), productId: at.productId, salePricePaise: expected - RUPEE }),
            ),
          ).toBe("FREE_DELIVERY_UNFUNDED");
        },
      );
    });

    it("R6.5: the quote-time guard still fires for a reachable unfunded case: a merchant coupon that pushes the seller's credit below the fee", async () => {
      const c = await store();
      const l = await publishListing(pool, c, {
        pricePaise: 2_000n * RUPEE,
        quantity: 3,
        freeStandardDelivery: true,
      });
      await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "PERCENT", value: 50n, isPublic: true, publicCode: "HALFOFF" },
      });
      const buyer = await user(pool);
      // ₹2,000 funds the fee; after 50% off the seller's credit (₹1,000 - ₹50 fee) is below the ₹1,000 fee
      expect(await codeOf(checkout(pool, buyer, [asFixture(l)], std(c), "halfoff"))).toBe(
        "DELIVERY_UNAVAILABLE",
      );
      expect(await codeOf(checkout(pool, buyer, [asFixture(l)], std(c)))).toBe("ok");
    });
  });

  describe("configuration edges (review round 2, minor 2)", () => {
    it("the free-delivery floor reads the configured price minimum, as core's function does with it as a parameter", async () => {
      await withConfig(
        '{"price_min_paise": "500000", "delivery_fee_paise": {"STANDARD": "0", "EXPRESS": "1000000", "ZAP": "5000000"}}',
        async () => {
          const c = await store();
          const l = await publishListing(pool, c, { pricePaise: 5_000n * RUPEE, quantity: 2 });
          const expected = minPriceForFreeDelivery(
            {
              ...DEFAULT_PRICING_CONFIG,
              deliveryFeePaise: { ...DEFAULT_PRICING_CONFIG.deliveryFeePaise, STANDARD: 0n },
            },
            500_000n,
          );
          expect((await live(c, l.productId)).sale.rules.freeDeliveryMinPaise).toBe(expected);
          expect(expected).toBe(500_000n);
        },
      );
    });

    it("a zero, huge or negative reference or window configuration is clamped, never an error on a public read", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await ageHistory(l.productId, "50 hours");
      await setSalePrice(pool, { ...as(c.u), productId: l.productId, salePricePaise: 800n * RUPEE });
      const cases: [string, Record<string, number>][] = [
        [
          '{"reference_price_lookback_days": 0, "reference_price_min_hours": 0, "price_change_window_hours": 0}',
          { referenceLookbackDays: 1, referenceMinHours: 1, priceChangeWindowHours: 1 },
        ],
        [
          '{"reference_price_lookback_days": 999999999999, "reference_price_min_hours": 999999999999, "price_change_window_hours": 999999999999}',
          { referenceLookbackDays: 365, referenceMinHours: 8760, priceChangeWindowHours: 8760 },
        ],
        // a negative number is not a configuration value: the default applies
        [
          '{"reference_price_lookback_days": -5, "reference_price_min_hours": -1, "price_change_window_hours": -3}',
          { referenceLookbackDays: 30, referenceMinHours: 24, priceChangeWindowHours: 24 },
        ],
        // hours above lookback x 24 are clamped to it
        [
          '{"reference_price_lookback_days": 2, "reference_price_min_hours": 500}',
          { referenceLookbackDays: 2, referenceMinHours: 48 },
        ],
      ];
      for (const [json, expected] of cases) {
        await withConfig(json, async () => {
          // public reads and the owner's view never error
          expect(await catalogProduct(pool, l.productId)).toMatchObject({ productId: l.productId });
          expect((await catalogProducts(pool, { cursor: null, pageSize: 50 })).items.length).toBeGreaterThan(
            0,
          );
          expect((await live(c, l.productId)).sale.rules).toMatchObject(expected);
        });
      }
      // with the minimum hours clamped to 1, a price live for 50 hours shows its reference to a lower sale
      await withConfig('{"reference_price_min_hours": 0}', async () => {
        expect((await live(c, l.productId)).sale.canShowReference).toBe(true);
      });
    });
  });

  describe("configuration is visible (review minor 5)", () => {
    it("the reference, allowance and window keys are in the configuration with their defaults, and the owner's view reads them", async () => {
      const { rows } = await pool.query<{ v: Record<string, unknown> }>(
        "SELECT values AS v FROM core.config_version ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]?.v).toMatchObject({
        price_changes_per_product_per_day: 20,
        price_change_window_hours: 24,
        reference_price_min_hours: 24,
        reference_price_lookback_days: 30,
      });
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      expect((await live(c, l.productId)).sale.rules).toEqual({
        referenceMinHours: 24,
        referenceLookbackDays: 30,
        priceChangesPerDay: 20,
        priceChangeWindowHours: 24,
        changesRemaining: 20,
        priceMinPaise: 100n * RUPEE,
        priceMaxPaise: 100_000_000_000n,
        freeDeliveryMinPaise: 1_053n * RUPEE,
      });
      expect((await myProducts(pool, as(c.u))).items[0]?.sale.rules.referenceMinHours).toBe(24);
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
