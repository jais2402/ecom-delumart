import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cartAdd, myCart } from "../src/cart";
import { catalogProduct, catalogProductPage, catalogProducts, storeProducts } from "../src/catalog";
import { createCheckoutSession } from "../src/checkout";
import { applyScreening, pendingScreenings } from "../src/jobs";
import {
  allocateAndPublish,
  archiveProduct,
  createDraft,
  deleteDraft,
  myProduct,
  myProducts,
  restockProduct,
  retireUnits,
  reviseProduct,
  setProductPrice,
  setProductShipping,
  setZapHub,
  submitProduct,
  updateDraft,
} from "../src/listing";
import {
  CLEAN,
  checkout,
  codeOf,
  count,
  key,
  type ProductFixture,
  payFor,
  RUPEE,
  reconcile,
  user,
  wallet,
} from "./checkout-fixtures";
import { createTestDatabase, inTx, type TestDatabase, uuidv7 } from "./helpers";
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

/** Player listings: the studio, submission, screening, publication and stock (migrations 0035-0038). */
describe("player listings", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 30 });
    pool = db.pool;
    await ensureCategories(pool);
    items = await published(pool, 3);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (c: Creator) => ({ authSessionId: c.u.authSessionId });
  const create = (c: Creator, o: Parameters<typeof draftInput>[0] = {}) =>
    createDraft(pool, { ...as(c), draft: draftInput(o) });
  const submit = (c: Creator, productId: string) => submitProduct(pool, { ...as(c), productId });
  const detail = (c: Creator, productId: string) => myProduct(pool, { ...as(c), productId });
  const warehouse = async (c: Creator) => {
    const { rows } = await pool.query<{ capacity: number; used: number }>(
      "SELECT capacity, used FROM core.warehouse WHERE id = $1",
      [c.warehouseId],
    );
    return rows[0];
  };
  const units = (productId: string, state?: string) =>
    count(
      pool,
      `SELECT count(*) AS n FROM core.inventory_unit WHERE product_id = $1 AND ($2::text IS NULL OR state = $2)`,
      [productId, state ?? null],
    );

  describe("the studio (US-08)", () => {
    let c: Creator;
    beforeAll(async () => {
      c = await creator(pool, items);
    });

    it("US-08: a draft keeps its fields as a first revision; nothing is public", async () => {
      const d = await create(c, {
        name: "Pocket Thunderstorm",
        hook: null,
        quantity: 3,
        offersExpress: true,
      });
      expect(d).toMatchObject({
        status: "DRAFT",
        category: "impossible-tech",
        inventoryMode: "STANDARD_STOCKED",
        quantity: 3,
        offersExpress: true,
        freeStandardDelivery: false,
        approvedNeedsStock: false,
        live: null,
        nextAction: "SUBMIT",
        stock: { available: 0, issued: 0, retired: 0 },
      });
      expect(d.current).toMatchObject({
        revision: 1,
        name: "Pocket Thunderstorm",
        hook: null,
        pricePaise: 50_000n,
      });
      expect(await catalogProduct(pool, d.productId)).toBeNull();
      expect(await catalogProductPage(pool, d.productId)).toBeNull();
    });

    it("US-08: field limits are enforced by the database, inclusive at each bound", async () => {
      const ok = [
        { name: "abc" },
        { name: "x".repeat(80) },
        { hook: "h".repeat(140) },
        { description: "d".repeat(20) },
        { description: "d".repeat(1000) },
        { altText: "a".repeat(300) },
        { templateId: 0 },
        { templateId: 359 },
        { pricePaise: 100n * RUPEE },
        { pricePaise: 1_000_000_000n * RUPEE },
        { inventoryMode: "EXCLUSIVE" as const, quantity: 1 },
      ];
      for (const o of ok)
        expect(
          await codeOf(create(c, o)),
          JSON.stringify(o, (_, v) => String(v)),
        ).toBe("ok");
      const bad = [
        { name: "ab" },
        { name: "x".repeat(81) },
        { hook: "h".repeat(141) },
        { description: "d".repeat(19) },
        { description: "d".repeat(1001) },
        { altText: "a".repeat(301) },
        { templateId: -1 },
        { templateId: 360 },
        { pricePaise: 99n * RUPEE },
        { pricePaise: 1_000_000_001n * RUPEE },
        { pricePaise: 500n * RUPEE + 50n },
        { quantity: 0 },
        { category: "not-a-category" },
        { inventoryMode: "UNLIMITED_SEED" as never },
        { name: "Moon\u0007Lamp" },
      ];
      for (const o of bad) {
        expect(
          await codeOf(create(c, o)),
          JSON.stringify(o, (_, v) => String(v)),
        ).toBe("VALIDATION_FAILED");
      }
      // clean up: the studio's private cap is shared with the cap test below
      for (const l of (await myProducts(pool, { ...as(c), status: "DRAFT", pageSize: 50 })).items) {
        await deleteDraft(pool, { ...as(c), productId: l.productId });
      }
    });

    it("US-08: the studio needs creator access and a registered company", async () => {
      const nobody = await user(pool);
      expect(
        await codeOf(createDraft(pool, { authSessionId: nobody.authSessionId, draft: draftInput() })),
      ).toBe("CREATOR_LOCKED");
      const passportOnly = await user(pool);
      const { completePassport } = await import("./selling-fixtures");
      await completePassport(pool, passportOnly, items);
      expect(
        await codeOf(createDraft(pool, { authSessionId: passportOnly.authSessionId, draft: draftInput() })),
      ).toBe("COMPANY_FEE_REQUIRED");
    });

    it("US-08: editing a draft is a new revision the draft points at; an empty hook clears it", async () => {
      const d = await create(c);
      const e = await updateDraft(pool, {
        ...as(c),
        productId: d.productId,
        changes: { name: "Moon Lamp Mk II", hook: null, pricePaise: 700n * RUPEE, quantity: 4 },
      });
      expect(e.current).toMatchObject({
        revision: 2,
        name: "Moon Lamp Mk II",
        hook: null,
        pricePaise: 70_000n,
      });
      expect(e.quantity).toBe(4);
      expect(e.versions.map((v) => [v.revision, v.isCurrent])).toEqual([
        [2, true],
        [1, false],
      ]);
      await deleteDraft(pool, { ...as(c), productId: d.productId });
      expect(await codeOf(detail(c, d.productId))).toBe("NOT_FOUND");
    });

    it("US-08: at most 20 private drafts per company, also under 25 parallel creates", async () => {
      const fresh = await creator(pool, items);
      const results = await Promise.all(Array.from({ length: 25 }, () => codeOf(create(fresh))));
      expect(results.filter((r) => r === "ok")).toHaveLength(20);
      expect(results.filter((r) => r === "DRAFT_LIMIT")).toHaveLength(5);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.product WHERE company_id = $1", [fresh.companyId]),
      ).toBe(20);
      // a deleted draft frees a place
      const [first] = (await myProducts(pool, { ...as(fresh), pageSize: 1 })).items;
      await deleteDraft(pool, { ...as(fresh), productId: first?.productId ?? "" });
      expect(await codeOf(create(fresh))).toBe("ok");
      expect(await codeOf(create(fresh))).toBe("DRAFT_LIMIT");
    });

    it("my_products pages newest first and filters by status", async () => {
      const fresh = await creator(pool, items);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await create(fresh)).productId);
      await submit(fresh, ids[0] ?? "");
      const page1 = await myProducts(pool, { ...as(fresh), pageSize: 2 });
      expect(page1.items.map((l) => l.productId)).toEqual([ids[2], ids[1]]);
      const page2 = await myProducts(pool, { ...as(fresh), pageSize: 2, cursor: page1.nextCursor });
      expect(page2.items.map((l) => l.productId)).toEqual([ids[0]]);
      expect(page2.nextCursor).toBeNull();
      const screening = await myProducts(pool, { ...as(fresh), status: "SCREENING" });
      expect(screening.items.map((l) => [l.productId, l.nextAction])).toEqual([
        [ids[0], "WAIT_FOR_SCREENING"],
      ]);
      await screen(pool, ids[0] ?? "", "OK");
    });
  });

  describe("submission and screening", () => {
    let c: Creator;
    beforeAll(async () => {
      c = await creator(pool, items);
    });

    it("US-08: submit pins the revision and writes listing_submitted; an edit while screening is refused", async () => {
      const d = await create(c, { name: "Pinned Lamp" });
      const s = await submit(c, d.productId);
      expect(s).toMatchObject({ status: "SCREENING", nextAction: "WAIT_FOR_SCREENING" });
      expect(s.pending).toMatchObject({ kind: "FIRST", state: "SCREENING" });
      expect(s.pending?.version.versionId).toBe(d.current?.versionId);
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM audit.outbox WHERE type = 'listing_submitted' AND aggregate_id = $1",
          [d.productId],
        ),
      ).toBe(1);
      const payload = await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM audit.outbox WHERE type = 'listing_submitted' AND aggregate_id = $1",
        [d.productId],
      );
      expect(Object.keys(payload.rows[0]?.payload ?? {}).sort()).toEqual([
        "companyId",
        "kind",
        "productId",
        "submissionId",
        "versionId",
      ]);
      expect(
        await codeOf(updateDraft(pool, { ...as(c), productId: d.productId, changes: { name: "Later" } })),
      ).toBe("NOT_EDITABLE");
      expect(await codeOf(submit(c, d.productId))).toBe("NOT_EDITABLE");
      expect(await codeOf(deleteDraft(pool, { ...as(c), productId: d.productId }))).toBe("NOT_EDITABLE");

      // a later revision written behind the studio's back is not what gets published
      const later = uuidv7();
      await pool.query(
        `INSERT INTO core.product_version (id, product_id, revision, name, description, alt_text, template_id, price_paise)
         VALUES ($1, $2, 99, 'Something else', 'A different text that was never screened.', '', 1, 90000)`,
        [later, d.productId],
      );
      expect(
        await codeOf(
          applyScreening(pool, { productId: d.productId, versionId: later, verdict: "OK", reasons: [] }),
        ),
      ).toBe("CONFLICT");
      expect((await detail(c, d.productId)).status).toBe("SCREENING");
      expect(await screen(pool, d.productId)).toMatchObject({ outcome: "PUBLISHED" });
      const live = await catalogProduct(pool, d.productId);
      expect(live?.name).toBe("Pinned Lamp");
      expect((await detail(c, d.productId)).live?.versionId).toBe(d.current?.versionId);
    });

    it("screening results are applied by the jobs role only, and once", async () => {
      const d = await create(c);
      await submit(c, d.productId);
      const versionId = d.current?.versionId ?? "";
      for (const role of ["app_web", "app_pay"]) {
        const state = await pool.connect().then(async (cl) => {
          try {
            await cl.query("BEGIN");
            await cl.query(`SET LOCAL ROLE ${role}`);
            await cl.query("SELECT core.screening_apply($1, $2, 'OK', '[]')", [d.productId, versionId]);
            return "no error";
          } catch (e) {
            return (e as { code?: string }).code ?? "?";
          } finally {
            await cl.query("ROLLBACK");
            cl.release();
          }
        });
        expect(state, role).toBe("42501");
      }
      expect((await detail(c, d.productId)).status).toBe("SCREENING");
      await screen(pool, d.productId, "OK");
      // a second application of the same result is refused: nothing is pinned any more
      expect(
        await codeOf(applyScreening(pool, { productId: d.productId, versionId, verdict: "OK", reasons: [] })),
      ).toBe("CONFLICT");
    });

    it("US-08: REJECT keeps the listing private with its reasons; an edit returns it to DRAFT", async () => {
      const d = await create(c, { description: "A lamp you can order at moonlamp.shop for less." });
      await submit(c, d.productId);
      expect(await screen(pool, d.productId)).toMatchObject({ outcome: "REJECTED" });
      const r = await detail(c, d.productId);
      expect(r).toMatchObject({ status: "REJECTED", nextAction: "EDIT_AND_RESUBMIT", live: null });
      expect(r.lastDecision).toMatchObject({ state: "REJECTED", decidedBy: "SCREENING" });
      expect(r.lastDecision?.reasons).toContainEqual({ field: "description", code: "LINK" });
      expect(await catalogProductPage(pool, d.productId)).toBeNull();
      const e = await updateDraft(pool, {
        ...as(c),
        productId: d.productId,
        changes: { description: "A lamp that is mostly moon and partly nap." },
      });
      expect(e.status).toBe("DRAFT");
      await submit(c, d.productId);
      expect(await screen(pool, d.productId)).toMatchObject({ outcome: "PUBLISHED" });
    });

    it("US-08: NEEDS_REVIEW waits for the Super Admin; an edit withdraws it to DRAFT", async () => {
      const d = await create(c, { name: "MOON LAMP DELUXE EDITION" });
      await submit(c, d.productId);
      expect(await screen(pool, d.productId)).toMatchObject({ outcome: "NEEDS_REVIEW" });
      const r = await detail(c, d.productId);
      expect(r).toMatchObject({ status: "NEEDS_REVIEW", nextAction: "WAIT_FOR_REVIEW" });
      expect(r.pending?.reasons).toContainEqual({ field: "name", code: "CAPS" });
      const e = await updateDraft(pool, {
        ...as(c),
        productId: d.productId,
        changes: { name: "Moon Lamp Deluxe" },
      });
      expect(e).toMatchObject({ status: "DRAFT", pending: null });
      expect(e.versions[1]?.submissions[0]).toMatchObject({ state: "WITHDRAWN", decidedBy: "OWNER" });
      await deleteDraft(pool, { ...as(c), productId: d.productId });
    });

    it("an outage leaves the listing in SCREENING: nothing is approved by default", async () => {
      const d = await create(c);
      await submit(c, d.productId);
      // the job never ran (or failed): the listing stays private, waiting
      const r = await detail(c, d.productId);
      expect(r.status).toBe("SCREENING");
      expect(await catalogProduct(pool, d.productId)).toBeNull();
      expect((await pendingScreenings(pool, 100)).map((p) => p.productId)).toContain(d.productId);
      await screen(pool, d.productId, "OK");
    });

    it("at most 10 submissions per store per UTC day", async () => {
      const fresh = await creator(pool, items);
      for (let i = 0; i < 10; i++) {
        const d = await create(fresh);
        await submit(fresh, d.productId);
        await screen(pool, d.productId, "REJECT");
      }
      const d = await create(fresh);
      expect(await codeOf(submit(fresh, d.productId))).toBe("SUBMISSION_LIMIT");
      expect((await detail(fresh, d.productId)).status).toBe("DRAFT");
    });

    it("US-08: at most 10 published listings; submitting the 11th is refused, and so is publishing it", async () => {
      const fresh = await creator(pool, items);
      for (let i = 0; i < 10; i++) await publishListing(pool, fresh);
      const eleventh = await create(fresh);
      expect(await codeOf(submit(fresh, eleventh.productId))).toBe("PUBLISH_LIMIT");
      // forced into screening behind the studio's back: approval still does not publish it
      await pool.query(
        `INSERT INTO core.listing_submission (id, product_id, version_id, company_id, kind, state)
         VALUES ($1, $2, $3, $4, 'FIRST', 'SCREENING')`,
        [uuidv7(), eleventh.productId, eleventh.current?.versionId, fresh.companyId],
      );
      await pool.query(
        "UPDATE core.product SET status = 'SCREENING', pending_version_id = current_version_id WHERE id = $1",
        [eleventh.productId],
      );
      expect(await screen(pool, eleventh.productId, "OK")).toMatchObject({ outcome: "NEEDS_STOCK" });
      const r = await detail(fresh, eleventh.productId);
      expect(r).toMatchObject({ status: "DRAFT", approvedNeedsStock: true, nextAction: "ALLOCATE_STOCK" });
      expect(await codeOf(allocateAndPublish(pool, { ...as(fresh), productId: eleventh.productId }))).toBe(
        "PUBLISH_LIMIT",
      );
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM core.product WHERE company_id = $1 AND status = 'PUBLISHED'",
          [fresh.companyId],
        ),
      ).toBe(10);
    });
  });

  describe("publication and stock (US-29)", () => {
    it("US-29: 60 standard + 40 exclusive units fill the starter warehouse; the next unit is refused with nothing changed", async () => {
      const c = await creator(pool, items);
      const std = await publishListing(pool, c, { quantity: 60 });
      const exc = await publishListing(pool, c, { inventoryMode: "EXCLUSIVE", quantity: 40 });
      expect(std).toMatchObject({ status: "PUBLISHED", stock: { available: 60, issued: 0, retired: 0 } });
      expect(exc).toMatchObject({ status: "PUBLISHED", edition: { supply: 40, issued: 0 } });
      expect(await warehouse(c)).toEqual({ capacity: 100, used: 100 });
      const { rows } = await pool.query<{ serial: number }>(
        "SELECT serial FROM core.inventory_unit WHERE product_id = $1 ORDER BY serial",
        [exc.productId],
      );
      expect(rows.map((r) => r.serial)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.exclusive_edition WHERE product_id = $1", [
          exc.productId,
        ]),
      ).toBe(1);

      expect(await codeOf(restockProduct(pool, { ...as(c), productId: std.productId, quantity: 1 }))).toBe(
        "CAPACITY_EXCEEDED",
      );
      expect(await warehouse(c)).toEqual({ capacity: 100, used: 100 });
      expect(await units(std.productId)).toBe(60);

      // a third listing is approved but cannot be stocked: recorded, not published
      const third = await create(c, { quantity: 1 });
      await submit(c, third.productId);
      expect(await screen(pool, third.productId, "OK")).toMatchObject({ outcome: "NEEDS_STOCK" });
      expect(await detail(c, third.productId)).toMatchObject({
        status: "DRAFT",
        approvedNeedsStock: true,
        live: null,
        nextAction: "ALLOCATE_STOCK",
      });
      expect(await units(third.productId)).toBe(0);
      expect(await warehouse(c)).toEqual({ capacity: 100, used: 100 });
      expect(await catalogProduct(pool, third.productId)).toBeNull();
    });

    it("US-29: an exclusive edition's supply and mode never change, by any command", async () => {
      const c = await creator(pool, items);
      const exc = await publishListing(pool, c, { inventoryMode: "EXCLUSIVE", quantity: 40 });
      const id = exc.productId;
      expect(await codeOf(restockProduct(pool, { ...as(c), productId: id, quantity: 1 }))).toBe(
        "NOT_EDITABLE",
      );
      expect(
        await codeOf(
          updateDraft(pool, {
            ...as(c),
            productId: id,
            changes: { quantity: 50, inventoryMode: "STANDARD_STOCKED" },
          }),
        ),
      ).toBe("NOT_EDITABLE");
      expect(await codeOf(allocateAndPublish(pool, { ...as(c), productId: id, quantity: 10 }))).toBe(
        "NOT_EDITABLE",
      );
      await setProductPrice(pool, { ...as(c), productId: id, pricePaise: 900n * RUPEE });
      await reviseProduct(pool, { ...as(c), productId: id, revision: { name: "Exclusive Moon" } });
      await screen(pool, id, "OK");
      await setProductShipping(pool, { ...as(c), productId: id, offersExpress: true });
      const after = await detail(c, id);
      expect(after).toMatchObject({ inventoryMode: "EXCLUSIVE", quantity: 40, edition: { supply: 40 } });
      expect(after.live).toMatchObject({ name: "Exclusive Moon", pricePaise: 90_000n });
      // and not as the owner of the database either
      expect(
        await codeOf(pool.query("UPDATE core.product SET exclusive_supply = 41 WHERE id = $1", [id])),
      ).toBe("23514");
      expect(
        await codeOf(
          pool.query("UPDATE core.product SET inventory_mode = 'STANDARD_STOCKED' WHERE id = $1", [id]),
        ),
      ).toBe("23514");
      expect(
        await codeOf(pool.query("UPDATE core.exclusive_edition SET supply = 41 WHERE product_id = $1", [id])),
      ).toBe("23514");
      expect(
        await codeOf(
          pool.query("INSERT INTO core.exclusive_edition (product_id, supply) VALUES ($1, 40)", [id]),
        ),
      ).toBe("23505");
      // retiring units lowers what can ever be sold, and says so; the edition record stays at 40
      const retired = await retireUnits(pool, { ...as(c), productId: id, quantity: 5 });
      expect(retired).toMatchObject({ retired: 5, sellableSupply: 35 });
      expect(retired.product.stock).toEqual({ available: 35, issued: 0, retired: 5 });
      expect(retired.product.edition).toEqual({ supply: 40, issued: 0 });
      const { rows } = await pool.query<{ serial: number }>(
        "SELECT serial FROM core.inventory_unit WHERE product_id = $1 AND state = 'RETIRED_UNSOLD' ORDER BY serial",
        [id],
      );
      expect(rows.map((r) => r.serial)).toEqual([36, 37, 38, 39, 40]);
    });

    it("US-29: approved but waiting for stock: the owner frees space or lowers the supply (never raises it), then publishes", async () => {
      const c = await creator(pool, items);
      const big = await publishListing(pool, c, { quantity: 98 });
      const exc = await create(c, { inventoryMode: "EXCLUSIVE", quantity: 5 });
      await submit(c, exc.productId);
      expect(await screen(pool, exc.productId, "OK")).toMatchObject({ outcome: "NEEDS_STOCK" });
      expect(await codeOf(allocateAndPublish(pool, { ...as(c), productId: exc.productId }))).toBe(
        "CAPACITY_EXCEEDED",
      );
      expect(
        await codeOf(allocateAndPublish(pool, { ...as(c), productId: exc.productId, quantity: 6 })),
      ).toBe("VALIDATION_FAILED");
      expect((await detail(c, exc.productId)).quantity).toBe(5);
      await retireUnits(pool, { ...as(c), productId: big.productId, quantity: 1 });
      const p = await allocateAndPublish(pool, { ...as(c), productId: exc.productId, quantity: 3 });
      expect(p).toMatchObject({
        status: "PUBLISHED",
        quantity: 3,
        approvedNeedsStock: false,
        edition: { supply: 3 },
      });
      expect(p.live?.versionId).toBe(exc.current?.versionId);
      expect(await warehouse(c)).toEqual({ capacity: 100, used: 100 });
      expect(p.priceHistory).toEqual([expect.objectContaining({ reason: "PUBLISHED", previousPaise: null })]);
    });

    it("US-29: property: restock and retire keep every counter equal to the units it counts", async () => {
      const c = await creator(pool, items);
      const p = await publishListing(pool, c, { quantity: 10 });
      // a small seeded generator (fast-check is not a dependency of this package): 8 runs of 1-6 ops
      let seed = 20261121;
      const next = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      for (let run = 0; run < 8; run++) {
        const ops = Array.from({ length: 1 + next(6) }, () => [next(2) === 0, 1 + next(15)] as const);
        for (const [restock, q] of ops) {
          const call = restock
            ? restockProduct(pool, { ...as(c), productId: p.productId, quantity: q })
            : retireUnits(pool, { ...as(c), productId: p.productId, quantity: q });
          expect(["ok", "CAPACITY_EXCEEDED", "VALIDATION_FAILED"]).toContain(await codeOf(call));
        }
        const d = await detail(c, p.productId);
        const w = await warehouse(c);
        expect(d.stock.available).toBe(await units(p.productId, "AVAILABLE"));
        expect(w?.used).toBe(await units(p.productId, "AVAILABLE"));
        expect(d.stock.retired).toBe(await units(p.productId, "RETIRED_UNSOLD"));
        expect(await reconcile(pool)).toEqual(CLEAN);
      }
    });

    it("revise: the approved version stays live until the revision is approved; a rejected revision changes nothing", async () => {
      const c = await creator(pool, items);
      const p = await publishListing(pool, c, { name: "Original Moon" });
      const r = await reviseProduct(pool, {
        ...as(c),
        productId: p.productId,
        revision: { name: "Revised Moon" },
      });
      expect(r).toMatchObject({ status: "PUBLISHED", nextAction: "WAIT_FOR_REVISION" });
      expect(r.pending).toMatchObject({ kind: "REVISION", state: "SCREENING" });
      expect((await catalogProduct(pool, p.productId))?.name).toBe("Original Moon");
      expect(await screen(pool, p.productId, "OK")).toMatchObject({ outcome: "REVISED" });
      expect((await catalogProduct(pool, p.productId))?.name).toBe("Revised Moon");

      await reviseProduct(pool, {
        ...as(c),
        productId: p.productId,
        revision: { description: "Buy it at moonlamp.shop for less money." },
      });
      expect(await screen(pool, p.productId)).toMatchObject({ outcome: "REJECTED" });
      const after = await detail(c, p.productId);
      expect(after.live?.name).toBe("Revised Moon");
      expect(after.live?.description).not.toMatch(/moonlamp/);
      expect(after.lastDecision).toMatchObject({ kind: "REVISION", state: "REJECTED" });
      expect(
        await codeOf(reviseProduct(pool, { ...as(c), productId: p.productId, revision: { name: "x" } })),
      ).toBe("VALIDATION_FAILED");
    });

    it("a price-only change is live at once, recorded in the price history, and an older quote is re-derived at pay", async () => {
      const c = await creator(pool, items);
      const p = await publishListing(pool, c, { pricePaise: 500n * RUPEE, quantity: 2 });
      const buyer = await user(pool);
      const before = await checkout(pool, buyer, [asFixture(p)], { [c.companyId]: "STANDARD" });
      const r = await setProductPrice(pool, { ...as(c), productId: p.productId, pricePaise: 650n * RUPEE });
      expect(r.live?.pricePaise).toBe(65_000n);
      expect((await catalogProduct(pool, p.productId))?.pricePaise).toBe(65_000n);
      expect(r.priceHistory.map((h) => [h.reason, h.pricePaise, h.previousPaise])).toEqual([
        ["PRICE_CHANGE", 65_000n, 50_000n],
        ["PUBLISHED", 50_000n, null],
      ]);
      expect(await codeOf(payFor(pool, buyer, before))).toBe("CART_CHANGED");
      expect(
        await codeOf(
          setProductPrice(pool, { ...as(c), productId: p.productId, pricePaise: 650n * RUPEE + 1n }),
        ),
      ).toBe("VALIDATION_FAILED");
      // a revision approved after the price changed goes live at the live price
      await reviseProduct(pool, { ...as(c), productId: p.productId, revision: { name: "Repriced Moon" } });
      await setProductPrice(pool, { ...as(c), productId: p.productId, pricePaise: 700n * RUPEE });
      await screen(pool, p.productId, "OK");
      expect(await catalogProduct(pool, p.productId)).toMatchObject({
        name: "Repriced Moon",
        pricePaise: 70_000n,
      });
    });

    it("archive retires the remaining units, frees their slots and takes the listing off sale; buyers keep theirs", async () => {
      const c = await creator(pool, items);
      const p = await publishListing(pool, c, { quantity: 5 });
      const buyer = await user(pool);
      await payFor(pool, buyer, await checkout(pool, buyer, [asFixture(p)], { [c.companyId]: "STANDARD" }));
      const a = await archiveProduct(pool, { ...as(c), productId: p.productId });
      expect(a).toMatchObject({ status: "ARCHIVED", stock: { available: 0, issued: 1, retired: 4 } });
      expect(await warehouse(c)).toEqual({ capacity: 100, used: 0 });
      expect(await catalogProduct(pool, p.productId)).toBeNull();
      expect(await catalogProductPage(pool, p.productId)).toEqual({
        status: "UNAVAILABLE",
        productId: p.productId,
      });
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.ownership WHERE product_id = $1 AND user_id = $2", [
          p.productId,
          buyer.userId,
        ]),
      ).toBe(1);
      expect(await codeOf(archiveProduct(pool, { ...as(c), productId: p.productId }))).toBe("NOT_EDITABLE");
      expect(await codeOf(deleteDraft(pool, { ...as(c), productId: p.productId }))).toBe("NOT_EDITABLE");
    });

    it("Zap: a player product is Zap-available when an AVAILABLE unit is in the company's Zap hub; pay takes the hub's unit", async () => {
      const c = await creator(pool, items);
      const p = await publishListing(pool, c, { quantity: 3 });
      const buyer = await user(pool);
      expect((await catalogProduct(pool, p.productId))?.zap).toBe(false);
      expect(
        await codeOf(
          createCheckoutSession(pool, {
            authSessionId: buyer.authSessionId,
            lines: [{ productId: p.productId }],
            speedBySeller: { [c.companyId]: "ZAP" },
            idempotencyKey: key(),
          }),
        ),
      ).toBe("DELIVERY_UNAVAILABLE");
      // a second warehouse becomes the hub, holding one unit (written as the owner: warehouse purchases are not built)
      const hub = uuidv7();
      const hubUnit = uuidv7();
      await inTx(pool, async (tx) => {
        await tx.query(
          "INSERT INTO core.warehouse (id, company_id, kind, capacity, used) VALUES ($1, $2, 'PURCHASED', 10, 1)",
          [hub, c.companyId],
        );
        await tx.query(
          "INSERT INTO core.inventory_unit (id, product_id, warehouse_id, state) VALUES ($1, $2, $3, 'AVAILABLE')",
          [hubUnit, p.productId, hub],
        );
        await tx.query("UPDATE core.product SET available_units = available_units + 1 WHERE id = $1", [
          p.productId,
        ]);
      });
      const ws = await setZapHub(pool, { ...as(c), warehouseId: hub, enabled: true });
      expect(ws.filter((w) => w.zapHub).map((w) => w.id)).toEqual([hub]);
      expect((await catalogProduct(pool, p.productId))?.zap).toBe(true);
      await cartAdd(pool, { authSessionId: buyer.authSessionId, productId: p.productId });
      expect((await myCart(pool, { authSessionId: buyer.authSessionId })).lines[0]?.zapAvailable).toBe(true);
      const receipt = await payFor(
        pool,
        buyer,
        await checkout(pool, buyer, [asFixture(p)], { [c.companyId]: "ZAP" }),
      );
      expect(receipt.orderGroupId).toBeDefined();
      expect(
        (
          await pool.query<{ state: string }>("SELECT state FROM core.inventory_unit WHERE id = $1", [
            hubUnit,
          ])
        ).rows[0]?.state,
      ).toBe("ISSUED");
      // the hub is empty now: no more Zap
      expect((await catalogProduct(pool, p.productId))?.zap).toBe(false);
      // the starter warehouse as the hub (the previous hub stops being one)
      const ws2 = await setZapHub(pool, { ...as(c), warehouseId: c.warehouseId, enabled: true });
      expect(ws2.filter((w) => w.zapHub).map((w) => w.id)).toEqual([c.warehouseId]);
      expect((await catalogProduct(pool, p.productId))?.zap).toBe(true);
      await setZapHub(pool, { ...as(c), warehouseId: c.warehouseId, enabled: false });
      expect((await catalogProduct(pool, p.productId))?.zap).toBe(false);
    });

    it("a player product sells end to end: the seller gets the price less the 5% fee; the owner cannot buy their own", async () => {
      const c = await creator(pool, items);
      const p = await publishListing(pool, c, {
        pricePaise: 1_000n * RUPEE,
        quantity: 2,
        inventoryMode: "EXCLUSIVE",
      });
      const buyer = await user(pool);
      const sellerBefore = await wallet(pool, c.u.ledgerAccountId);
      const receipt = await payFor(
        pool,
        buyer,
        await checkout(pool, buyer, [asFixture(p)], { [c.companyId]: "STANDARD" }),
      );
      expect(receipt.orderGroupId).toBeDefined();
      expect(await wallet(pool, c.u.ledgerAccountId)).toBe(sellerBefore + 95_000n);
      const d = await detail(c, p.productId);
      expect(d.edition).toEqual({ supply: 2, issued: 1 });
      expect((await catalogProduct(pool, p.productId))?.edition).toEqual({ issued: 1, supply: 2 });
      expect(
        await codeOf(
          createCheckoutSession(pool, {
            authSessionId: c.u.authSessionId,
            lines: [{ productId: p.productId }],
            speedBySeller: { [c.companyId]: "STANDARD" },
            idempotencyKey: key(),
          }),
        ),
      ).toBe("SELF_PURCHASE");
    });
  });

  describe("public reads", () => {
    it("published player products appear in the catalog and their store with seller, handle and stock band", async () => {
      const c = await creator(pool, items);
      const p = await publishListing(pool, c, { name: "Store Lamp", quantity: 3 });
      const draft = await create(c);
      const fromCatalog: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await catalogProducts(pool, { cursor, pageSize: 50 });
        fromCatalog.push(...page.items.map((i) => i.productId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(fromCatalog).toContain(p.productId);
      expect(fromCatalog).not.toContain(draft.productId);
      const one = await catalogProduct(pool, p.productId);
      expect(one).toMatchObject({
        name: "Store Lamp",
        sellerKey: c.companyId,
        sellerName: "Moon Lamps",
        storeHandle: c.handle,
        inventoryMode: "STANDARD_STOCKED",
        stockBand: "LOW",
        edition: null,
        available: true,
      });
      const store = await storeProducts(pool, { handle: c.handle });
      expect(store.items.map((i) => i.productId)).toEqual([p.productId]);
      expect((await storeProducts(pool, { handle: "no-such-store" })).items).toEqual([]);
      const seed = await catalogProduct(pool, items[0]?.id ?? "");
      expect(seed).toMatchObject({
        sellerKey: "SEED",
        storeHandle: null,
        stockBand: "UNLIMITED",
        edition: null,
      });
    });
  });

  describe("privacy: user A never sees or changes user B's listings", () => {
    it("every studio command answers NOT_FOUND for another company's product", async () => {
      const a = await creator(pool, items);
      const b = await creator(pool, items);
      const draft = await create(a);
      const live = await publishListing(pool, a, { quantity: 2 });
      const asB = as(b);
      const calls: [string, () => Promise<unknown>][] = [
        ["my_product", () => myProduct(pool, { ...asB, productId: draft.productId })],
        [
          "update",
          () => updateDraft(pool, { ...asB, productId: draft.productId, changes: { name: "Mine now" } }),
        ],
        ["delete", () => deleteDraft(pool, { ...asB, productId: draft.productId })],
        ["submit", () => submitProduct(pool, { ...asB, productId: draft.productId })],
        [
          "revise",
          () => reviseProduct(pool, { ...asB, productId: live.productId, revision: { name: "Mine now" } }),
        ],
        [
          "price",
          () => setProductPrice(pool, { ...asB, productId: live.productId, pricePaise: 100n * RUPEE }),
        ],
        ["restock", () => restockProduct(pool, { ...asB, productId: live.productId, quantity: 1 })],
        ["retire", () => retireUnits(pool, { ...asB, productId: live.productId, quantity: 1 })],
        ["allocate", () => allocateAndPublish(pool, { ...asB, productId: draft.productId })],
        ["archive", () => archiveProduct(pool, { ...asB, productId: live.productId })],
        [
          "shipping",
          () => setProductShipping(pool, { ...asB, productId: live.productId, offersExpress: true }),
        ],
        ["zap", () => setZapHub(pool, { ...asB, warehouseId: a.warehouseId, enabled: true })],
      ];
      for (const [name, call] of calls) expect(await codeOf(call()), name).toBe("NOT_FOUND");
      expect((await myProducts(pool, asB)).items.map((l) => l.productId)).not.toContain(draft.productId);
      expect(await detail(a, draft.productId)).toMatchObject({ status: "DRAFT", current: { revision: 1 } });
      expect(await detail(a, live.productId)).toMatchObject({ status: "PUBLISHED", stock: { available: 2 } });
      // and the web role, signed in as B, reads none of A's private rows directly
      const cl = await pool.connect();
      try {
        await cl.query("BEGIN");
        await cl.query("SELECT set_config('app.session_id', $1, true)", [b.u.authSessionId]);
        await cl.query("SET LOCAL ROLE app_web");
        const seen = await cl.query("SELECT 1 FROM core.product WHERE id = $1", [draft.productId]);
        const versions = await cl.query("SELECT 1 FROM core.product_version WHERE product_id = $1", [
          draft.productId,
        ]);
        expect([seen.rowCount, versions.rowCount]).toEqual([0, 0]);
      } finally {
        await cl.query("ROLLBACK");
        cl.release();
      }
    });
  });
});
