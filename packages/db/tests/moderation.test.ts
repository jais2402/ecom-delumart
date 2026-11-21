import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { myCollection } from "../src/account";
import { cartAdd, myCart } from "../src/cart";
import { catalogProduct, catalogProductPage, catalogProducts, storeProducts } from "../src/catalog";
import { createCheckoutSession } from "../src/checkout";
import { moderationSafetyNet } from "../src/jobs";
import {
  allocateAndPublish,
  createDraft,
  decideListing,
  hideListing,
  moderationQueue,
  myProduct,
  restoreListing,
  setSystemSwitch,
  submitProduct,
} from "../src/listing";
import { CLEAN, checkout, codeOf, count, key, type ProductFixture, payFor, reconcile, user } from "./checkout-fixtures";
import {
  commitState,
  createTestDatabase,
  RAW_WRITER,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";
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

const REASON = "Looks fine after a closer read.";

/** Super Admin moderation, the publication switch, the safety net and the structural rules (0035-0038). */
describe("listing moderation", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: ProductFixture[];
  let admin: TestUser;
  let c: Creator;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    items = await published(pool, 3);
    admin = await user(pool);
    // the role is assigned only by the database owner (scripts/dev-setup.ts does it locally)
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
    c = await creator(pool, items);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
    await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = 'publication'");
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });
  const auditRows = () => count(pool, "SELECT count(*) AS n FROM audit.audit_log");
  /** A listing of `c` held for review by screening. */
  async function inReview(name = "MOON LAMP DELUXE EDITION") {
    const d = await createDraft(pool, { ...as(c.u), draft: draftInput({ name }) });
    await submitProduct(pool, { ...as(c.u), productId: d.productId });
    expect(await screen(pool, d.productId)).toMatchObject({ outcome: "NEEDS_REVIEW" });
    return { productId: d.productId, versionId: d.current?.versionId ?? "" };
  }

  describe("who may moderate", () => {
    it("non-admins are refused (FORBIDDEN as a user; no EXECUTE for app_pay and app_jobs), whether or not the target exists, and nothing is written", async () => {
      const l = await inReview();
      const live = await publishListing(pool, c);
      const before = await auditRows();
      const player = c.u;
      const calls: [string, () => Promise<unknown>][] = [
        ["queue", () => moderationQueue(pool, as(player))],
        ["approve", () => decideListing(pool, { ...as(player), ...l, decision: "APPROVE", reason: REASON })],
        ["reject", () => decideListing(pool, { ...as(player), ...l, decision: "REJECT", reason: REASON })],
        ["hide", () => hideListing(pool, { ...as(player), productId: live.productId, reason: REASON })],
        ["hide missing", () => hideListing(pool, { ...as(player), productId: uuidv7(), reason: REASON })],
        ["restore", () => restoreListing(pool, { ...as(player), productId: live.productId, reason: REASON })],
        ["switch", () => setSystemSwitch(pool, { ...as(player), name: "publication", enabled: false, reason: REASON })],
        ["switch missing", () => setSystemSwitch(pool, { ...as(player), name: "nope", enabled: false, reason: "x" })],
      ];
      for (const [name, call] of calls) expect(await codeOf(call()), name).toBe("FORBIDDEN");
      const statements = [
        "SELECT core.admin_moderation_queue(NULL, NULL)",
        `SELECT core.admin_listing_decide('${l.productId}', '${l.versionId}', 'APPROVE', '${REASON}')`,
        `SELECT core.admin_listing_hide('${live.productId}', '${REASON}')`,
        `SELECT core.admin_listing_restore('${live.productId}', '${REASON}')`,
        `SELECT core.admin_set_switch('publication', false, '${REASON}')`,
      ];
      for (const sql of statements) {
        for (const role of ["app_pay", "app_jobs"]) {
          expect(await stateOf(pool, sql, [], { role, userId: admin.userId }), `${role}: ${sql}`).toBe("42501");
        }
      }
      expect(await auditRows()).toBe(before);
      expect((await myProduct(pool, { ...as(c.u), productId: l.productId })).status).toBe("NEEDS_REVIEW");
      expect((await myProduct(pool, { ...as(c.u), productId: live.productId })).status).toBe("PUBLISHED");
      expect(await count(pool, "SELECT count(*) AS n FROM core.system_switch WHERE name = 'publication' AND enabled")).toBe(1);
      await decideListing(pool, { ...as(admin), ...l, decision: "REJECT", reason: REASON });
    });

    it("a reason is 5-500 characters with no contact details or links; a bad one writes nothing", async () => {
      const l = await inReview();
      const before = await auditRows();
      for (const reason of ["no", "x".repeat(501), "write to someone@example.com", "call 98765 43210 now", "see https://x.example"]) {
        expect(await codeOf(decideListing(pool, { ...as(admin), ...l, decision: "APPROVE", reason })), reason).toBe(
          "VALIDATION_FAILED",
        );
      }
      expect(await auditRows()).toBe(before);
      expect((await myProduct(pool, { ...as(c.u), productId: l.productId })).status).toBe("NEEDS_REVIEW");
      await decideListing(pool, { ...as(admin), ...l, decision: "REJECT", reason: REASON });
    });
  });

  describe("the review queue and decisions", () => {
    it("the queue lists reviews oldest first with the submitted text, the screening reasons and the store", async () => {
      const first = await inReview("FIRST LOUD LAMP");
      const second = await inReview("SECOND LOUD LAMP");
      const q = await moderationQueue(pool, { ...as(admin), pageSize: 50 });
      const mine = q.items.filter((i) => [first.productId, second.productId].includes(i.productId));
      expect(mine.map((i) => i.productId)).toEqual([first.productId, second.productId]);
      expect(mine[0]).toMatchObject({
        kind: "FIRST",
        versionId: first.versionId,
        store: { handle: c.handle, displayName: "Moon Lamps" },
        version: { name: "FIRST LOUD LAMP" },
      });
      expect(mine[0]?.reasons).toContainEqual({ field: "name", code: "CAPS" });
      expect(q.appeals).toEqual([]);
      const paged = await moderationQueue(pool, { ...as(admin), pageSize: 1 });
      expect(paged.items).toHaveLength(1);
      const next = await moderationQueue(pool, { ...as(admin), pageSize: 1, cursor: paged.nextCursor });
      expect(next.items[0]?.submittedAt.getTime()).toBeGreaterThanOrEqual(paged.items[0]?.submittedAt.getTime() ?? 0);
      for (const l of [first, second]) await decideListing(pool, { ...as(admin), ...l, decision: "REJECT", reason: REASON });
    });

    it("APPROVE publishes and appends a chained audit row; REJECT shows the owner the reason", async () => {
      const l = await inReview();
      const before = await auditRows();
      const r = await decideListing(pool, { ...as(admin), ...l, decision: "APPROVE", reason: REASON });
      expect(r).toMatchObject({ outcome: "PUBLISHED", productId: l.productId });
      expect((await catalogProduct(pool, l.productId))?.name).toBe("MOON LAMP DELUXE EDITION");
      const { rows } = await pool.query(
        `SELECT actor_id, actor_kind, action, target_type, target_id, reason, prev_hash IS NOT NULL AS chained
           FROM audit.audit_log ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0]).toEqual({
        actor_id: admin.userId,
        actor_kind: "SUPER_ADMIN",
        action: "listing.approve",
        target_type: "product",
        target_id: l.productId,
        reason: REASON,
        chained: before > 0,
      });
      expect(await auditRows()).toBe(before + 1);

      const rejected = await inReview();
      await decideListing(pool, { ...as(admin), ...rejected, decision: "REJECT", reason: "Shouting names are not allowed." });
      const owner = await myProduct(pool, { ...as(c.u), productId: rejected.productId });
      expect(owner).toMatchObject({ status: "REJECTED", moderationReason: "Shouting names are not allowed." });
      expect(owner.lastDecision).toMatchObject({ state: "REJECTED", decidedBy: "SUPER_ADMIN" });
      // a decision names the revision under review: anything else is a CONFLICT
      expect(
        await codeOf(decideListing(pool, { ...as(admin), ...rejected, decision: "APPROVE", reason: REASON })),
      ).toBe("CONFLICT");
      expect(
        await codeOf(decideListing(pool, { ...as(admin), productId: uuidv7(), versionId: uuidv7(), decision: "APPROVE", reason: REASON })),
      ).toBe("NOT_FOUND");
    });
  });

  describe("hide and restore", () => {
    it("hide removes a listing from every public read at once; buyers keep it; the product page says unavailable", async () => {
      const p = await publishListing(pool, c, { quantity: 3 });
      const buyer = await user(pool);
      await payFor(pool, buyer, await checkout(pool, buyer, [asFixture(p)], { [c.companyId]: "STANDARD" }));
      const other = await user(pool);
      await cartAdd(pool, { authSessionId: other.authSessionId, productId: p.productId });

      const before = await auditRows();
      expect(await hideListing(pool, { ...as(admin), productId: p.productId, reason: "Reported as misleading." })).toMatchObject({
        outcome: "HIDDEN",
      });
      expect(await auditRows()).toBe(before + 1);
      expect(await catalogProduct(pool, p.productId)).toBeNull();
      expect(await catalogProductPage(pool, p.productId)).toEqual({ status: "UNAVAILABLE", productId: p.productId });
      const all = await catalogProducts(pool, { pageSize: 50 });
      expect(all.items.map((i) => i.productId)).not.toContain(p.productId);
      expect((await storeProducts(pool, { handle: c.handle })).items.map((i) => i.productId)).not.toContain(p.productId);
      expect((await myCart(pool, as(other))).lines[0]?.issue).toBe("UNAVAILABLE");
      expect(
        await codeOf(
          createCheckoutSession(pool, {
            authSessionId: other.authSessionId,
            lines: [{ productId: p.productId }],
            speedBySeller: { [c.companyId]: "STANDARD" },
            idempotencyKey: key(),
          }),
        ),
      ).toBe("PRODUCT_UNAVAILABLE");
      // the buyer keeps what they bought
      expect((await myCollection(pool, as(buyer))).map((o) => [o.productId, o.state])).toEqual([[p.productId, "ACTIVE"]]);
      expect(await myProduct(pool, { ...as(c.u), productId: p.productId })).toMatchObject({
        status: "HIDDEN",
        moderationReason: "Reported as misleading.",
        nextAction: "HIDDEN_BY_MODERATION",
      });
      expect(await codeOf(hideListing(pool, { ...as(admin), productId: p.productId, reason: REASON }))).toBe("CONFLICT");

      await restoreListing(pool, { ...as(admin), productId: p.productId, reason: "The report was not upheld." });
      expect((await catalogProduct(pool, p.productId))?.productId).toBe(p.productId);
      expect((await myCart(pool, as(other))).lines[0]?.issue).toBeNull();
    });
  });

  describe("the publication switch and the safety net", () => {
    it("with publication off, submissions stay in SCREENING and nothing publishes", async () => {
      const full = await creator(pool, items);
      const hidden = (await publishListing(pool, full, { quantity: 99 })).productId;
      await hideListing(pool, { ...as(admin), productId: hidden, reason: REASON });
      const waiting = (await publishListing(pool, full, { quantity: 2 })).productId;
      expect((await myProduct(pool, { ...as(full.u), productId: waiting })).approvedNeedsStock).toBe(true);
      const before = await auditRows();
      expect(await setSystemSwitch(pool, { ...as(admin), name: "publication", enabled: false, reason: REASON })).toEqual({
        name: "publication",
        enabled: false,
      });
      expect(await auditRows()).toBe(before + 1);
      const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
      await submitProduct(pool, { ...as(c.u), productId: d.productId });
      expect(await screen(pool, d.productId, "OK")).toMatchObject({ outcome: "PAUSED" });
      expect((await myProduct(pool, { ...as(c.u), productId: d.productId })).status).toBe("SCREENING");
      expect(await catalogProduct(pool, d.productId)).toBeNull();

      const l = await (async () => {
        await setSystemSwitch(pool, { ...as(admin), name: "publication", enabled: true, reason: REASON });
        const r = await inReview();
        await setSystemSwitch(pool, { ...as(admin), name: "publication", enabled: false, reason: REASON });
        return r;
      })();
      expect(await codeOf(decideListing(pool, { ...as(admin), ...l, decision: "APPROVE", reason: REASON }))).toBe(
        "PUBLICATION_PAUSED",
      );
      // an approval waiting for stock is not published either, nor is a hidden listing restored
      expect(await codeOf(allocateAndPublish(pool, { ...as(full.u), productId: waiting }))).toBe("PUBLICATION_PAUSED");
      expect(await codeOf(restoreListing(pool, { ...as(admin), productId: hidden, reason: REASON }))).toBe(
        "PUBLICATION_PAUSED",
      );
      expect(await codeOf(setSystemSwitch(pool, { ...as(admin), name: "no_such_switch", enabled: true, reason: REASON }))).toBe(
        "NOT_FOUND",
      );

      await setSystemSwitch(pool, { ...as(admin), name: "publication", enabled: true, reason: REASON });
      expect(await screen(pool, d.productId, "OK")).toMatchObject({ outcome: "PUBLISHED" });
      await decideListing(pool, { ...as(admin), ...l, decision: "REJECT", reason: REASON });
    });

    it("the safety net pauses publication when the oldest waiting listing is over 48 hours old, once, as SYSTEM", async () => {
      const fresh = await creator(pool, items);
      const d = await createDraft(pool, { ...as(fresh.u), draft: draftInput() });
      await submitProduct(pool, { ...as(fresh.u), productId: d.productId });
      expect(await moderationSafetyNet(pool)).toEqual({ paused: false });
      await pool.query(
        "UPDATE core.listing_submission SET submitted_at = now() - interval '49 hours' WHERE product_id = $1",
        [d.productId],
      );
      await pool.query("UPDATE core.system_switch SET updated_at = now() - interval '72 hours' WHERE name = 'publication'");
      const before = await auditRows();
      expect(await moderationSafetyNet(pool)).toEqual({ paused: true });
      expect(await count(pool, "SELECT count(*) AS n FROM core.system_switch WHERE name = 'publication' AND enabled")).toBe(0);
      const { rows } = await pool.query("SELECT actor_id, actor_kind, action FROM audit.audit_log ORDER BY id DESC LIMIT 1");
      expect(rows[0]).toEqual({ actor_id: null, actor_kind: "SYSTEM", action: "moderation.safety_net" });
      // idempotent
      expect(await moderationSafetyNet(pool)).toEqual({ paused: false });
      expect(await auditRows()).toBe(before + 1);
      // switched back on by the Super Admin: not paused again for the same overdue listing
      await setSystemSwitch(pool, { ...as(admin), name: "publication", enabled: true, reason: "Clearing the queue now." });
      expect(await moderationSafetyNet(pool)).toEqual({ paused: false });
      await screen(pool, d.productId, "OK");
    });
  });

  describe("structural rules (every writer)", () => {
    let c: Creator;
    beforeAll(async () => {
      c = await creator(pool, items);
    });
    const raw = () => ({ role: RAW_WRITER, userId: c.u.userId });

    it("a product is not published without its stock, whoever writes it", async () => {
      const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
      const publish = (x: pg.PoolClient) =>
        x.query("UPDATE core.product SET status = 'PUBLISHED', published_at = now() WHERE id = $1", [d.productId]);
      expect(await commitState(pool, raw(), publish)).toBe("42501");
      expect(await commitState(pool, {}, publish)).toBe("23514");
      const exc = await createDraft(pool, { ...as(c.u), draft: draftInput({ inventoryMode: "EXCLUSIVE", quantity: 2 }) });
      // units but no edition record, or fewer units than the supply: refused at commit
      const units = (x: pg.PoolClient, n: number) =>
        x.query(
          `INSERT INTO core.inventory_unit (id, product_id, warehouse_id, serial, state)
           SELECT gen_random_uuid(), $1, $2, g, 'AVAILABLE' FROM generate_series(1, $3::int) g`,
          [exc.productId, c.warehouseId, n],
        );
      const stockAndPublish = async (x: pg.PoolClient, n: number, edition: boolean) => {
        await units(x, n);
        await x.query("UPDATE core.warehouse SET used = used + $2 WHERE id = $1", [c.warehouseId, n]);
        await x.query("UPDATE core.product SET available_units = $2 WHERE id = $1", [exc.productId, n]);
        if (edition) await x.query("INSERT INTO core.exclusive_edition (product_id, supply) VALUES ($1, 2)", [exc.productId]);
        await x.query("UPDATE core.product SET status = 'PUBLISHED', published_at = now() WHERE id = $1", [exc.productId]);
      };
      expect(await commitState(pool, {}, (x) => stockAndPublish(x, 2, false))).toBe("23514");
      expect(await commitState(pool, {}, (x) => stockAndPublish(x, 1, true))).toBe("23514");
      expect(await commitState(pool, {}, (x) => stockAndPublish(x, 2, true))).toBe("no error");
    });

    it("units never exceed a warehouse's capacity, never go to another company's warehouse, and an edition's serials stay within its supply", async () => {
      const p = await publishListing(pool, c, { quantity: 1 });
      const exc = await publishListing(pool, c, { inventoryMode: "EXCLUSIVE", quantity: 2 });
      const other = await creator(pool, items);
      const addUnit = (warehouse: string, product: string, serial: number | null) => async (x: pg.PoolClient) => {
        await x.query(
          "INSERT INTO core.inventory_unit (id, product_id, warehouse_id, serial, state) VALUES ($1, $2, $3, $4, 'AVAILABLE')",
          [uuidv7(), product, warehouse, serial],
        );
        await x.query("UPDATE core.warehouse SET used = used + 1 WHERE id = $1", [warehouse]);
        await x.query("UPDATE core.product SET available_units = available_units + 1 WHERE id = $1", [product]);
      };
      // beyond capacity
      expect(
        await commitState(pool, raw(), async (x) => {
          await x.query("UPDATE core.warehouse SET capacity = used WHERE id = $1", [c.warehouseId]);
          await addUnit(c.warehouseId, p.productId, null)(x);
        }),
      ).toBe("23514");
      expect(await commitState(pool, raw(), addUnit(other.warehouseId, p.productId, null))).toBe("23514");
      expect(await commitState(pool, raw(), addUnit(c.warehouseId, exc.productId, 3))).toBe("23514");
      expect(await commitState(pool, raw(), addUnit(c.warehouseId, exc.productId, null))).toBe("23514");
      // the control: a unit within the rules is accepted
      expect(await commitState(pool, raw(), addUnit(c.warehouseId, p.productId, null))).toBe("no error");
    });

    it("an exclusive supply never changes and an edition is recorded once, whoever writes it", async () => {
      const exc = await publishListing(pool, c, { inventoryMode: "EXCLUSIVE", quantity: 2 });
      const id = exc.productId;
      for (const who of [raw(), {}]) {
        expect(await stateOf(pool, "UPDATE core.product SET exclusive_supply = 3 WHERE id = $1", [id], who)).toBe("23514");
        expect(await stateOf(pool, "UPDATE core.exclusive_edition SET supply = 3 WHERE product_id = $1", [id], who)).toBe(
          "23514",
        );
        expect(
          await stateOf(pool, "INSERT INTO core.exclusive_edition (product_id, supply) VALUES ($1, 2)", [id], who),
        ).toBe("23505");
        expect(await stateOf(pool, "DELETE FROM core.exclusive_edition WHERE product_id = $1", [id], who)).toBe("23001");
      }
      expect(
        await stateOf(pool, "UPDATE core.product_version SET name = 'Changed' WHERE id = $1", [exc.live?.versionId], raw()),
      ).toBe("23514");
      expect(await stateOf(pool, "DELETE FROM core.product WHERE id = $1", [id], raw())).toBe("23001");
    });

    it("app_web, app_pay and app_jobs write no product, version, unit, warehouse, edition, submission or price row directly", async () => {
      const tables = [
        "core.product",
        "core.product_version",
        "core.inventory_unit",
        "core.warehouse",
        "core.exclusive_edition",
        "core.listing_submission",
        "core.price_history",
      ];
      const held = await pool.query<{ r: string; t: string; p: string }>(
        `SELECT r, t, p FROM unnest(ARRAY['app_web','app_pay','app_jobs']) r, unnest($1::text[]) t,
                unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
          WHERE CASE WHEN p IN ('INSERT','UPDATE') THEN has_any_column_privilege(r, t, p)
                     ELSE has_table_privilege(r, t, p) END`,
        [tables],
      );
      expect(held.rows).toEqual([]);
      const p = await publishListing(pool, c);
      for (const role of ["app_web", "app_pay", "app_jobs"]) {
        const who = { role, userId: c.u.userId };
        for (const sql of [
          `UPDATE core.product SET offers_express = true WHERE id = '${p.productId}'`,
          `INSERT INTO core.product_version (id, product_id, revision, name, description, alt_text, template_id, price_paise)
           VALUES ('${uuidv7()}', '${p.productId}', 50, 'x', 'y', 'z', 1, 10000)`,
          `UPDATE core.inventory_unit SET state = 'RETIRED_UNSOLD' WHERE product_id = '${p.productId}'`,
          `UPDATE core.warehouse SET zap_hub = true WHERE id = '${c.warehouseId}'`,
          `INSERT INTO core.exclusive_edition (product_id, supply) VALUES ('${p.productId}', 1)`,
          `UPDATE core.listing_submission SET state = 'APPROVED' WHERE product_id = '${p.productId}'`,
          `INSERT INTO core.price_history (product_id, version_id, price_paise, reason) VALUES ('${p.productId}', '${p.live?.versionId}', 100, 'PUBLISHED')`,
        ]) {
          expect(await stateOf(pool, sql, [], who), `${role}: ${sql}`).toBe("42501");
        }
      }
    });
  });
});
