import { REVIEW_RULES } from "@delulu/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BYPASS_ATTACKS, NOT_A_CARD_NUMBER } from "../../core/src/screening/attack-cases";
import { recordEvent } from "../src/analytics";
import {
  adminReviews,
  deleteReview,
  hideReview,
  myReview,
  productReviews,
  restoreReview,
  reviewSummaries,
  saveReview,
} from "../src/review";
import {
  aMinuteLater,
  CLEAN,
  checkout,
  codeOf,
  count,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  reconcile,
  seller,
  standard,
  user,
} from "./checkout-fixtures";
import {
  become,
  createTestDatabase,
  inRolledBackTx,
  plant,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";

/**
 * Ratings and reviews (docs/decisions.md #14, migration 0078). REV-1 owner only, one per product,
 * not the seller; REV-2 the text rules; REV-3 the public aggregate; REV-4 moderation; REV-5 privacy
 * (no user id, order or purchase time; visible only once the purchase's minute has ended).
 */
const ROLES = ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro", "anon", "authenticated"];
const TABLES = ["core.product_review", "core.product_review_version"];

describe("ratings and reviews (migration 0078)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  const seedProduct = () => product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });

  /** A new player who bought `p` (a seed product) and whose purchase minute has ended. */
  async function owner(p: ProductFixture, settle = true): Promise<TestUser> {
    const u = await user(pool);
    await payFor(pool, u, await checkout(pool, u, [p], standard("SEED")));
    if (settle) await aMinuteLater(pool);
    return u;
  }

  const save = (
    u: TestUser,
    p: ProductFixture | string,
    rating: number,
    title: string | null = null,
    body: string | null = null,
  ) =>
    saveReview(pool, {
      authSessionId: u.authSessionId,
      productId: typeof p === "string" ? p : p.id,
      rating,
      title,
      body,
    });

  /**
   * Test-only stand-in for "tomorrow" (minor 4: a review is public from the reporting day after
   * the one it was written in): moves today's reviews back one day, as the owner.
   */
  const aDayLater = () =>
    plant(pool, (c) =>
      c.query(
        `UPDATE core.product_review SET created_at = created_at - interval '1 day'
          WHERE created_at >= core.review_public_before()`,
      ),
    );

  /** The public answer as it will read tomorrow (today's reviews aged past the boundary first). */
  const publicList = async (p: ProductFixture, page = 1) => {
    await aDayLater();
    const r = await productReviews(pool, { productId: p.id, page });
    if (r === null) throw new Error("expected a published product");
    return r;
  };

  const reviewIdOf = async (u: TestUser, p: ProductFixture): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id::text FROM core.product_review WHERE user_id = $1 AND product_id = $2",
      [u.userId, p.id],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("no review");
    return id;
  };

  describe("REV-1: who may review", () => {
    it("REV-1: an owner reviews a product they bought; it shows publicly with a Verified owner and the day only", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      const saved = await save(u, p, 4, "Mostly moon", "Naps well.");
      expect(saved).toMatchObject({
        rating: 4,
        title: "Mostly moon",
        body: "Naps well.",
        edited: false,
        version: 1,
      });
      // the author sees it at once; others only from the next reporting day
      expect(saved.public).toBe(false);
      const list = await publicList(p);
      expect(list).toMatchObject({
        count: 1,
        ratingSum: 4,
        averageTenths: 40,
        distribution: [0, 0, 0, 1, 0],
      });
      expect(list.items).toEqual([
        {
          rating: 4,
          title: "Mostly moon",
          body: "Naps well.",
          handle: null,
          createdOn: expect.any(String),
          edited: false,
        },
      ]);
      expect(list.items[0]?.createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("REV-1: the author's public handle is shown when they have one", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      const handle = `moon-fan-${Math.floor(Math.random() * 1e6)}`;
      await pool.query("UPDATE core.user_profile SET handle = $2 WHERE id = $1", [u.userId, handle]);
      await save(u, p, 5);
      expect((await publicList(p)).items[0]?.handle).toBe(handle);
      expect((await myReview(pool, { authSessionId: u.authSessionId, productId: p.id })).handle).toBe(handle);
    });

    it("REV-1: a player who does not own the product cannot review it; nothing is stored", async () => {
      const p = await seedProduct();
      await owner(p);
      const stranger = await user(pool);
      expect(await codeOf(save(stranger, p, 5))).toBe("REVIEW_NOT_ALLOWED");
      const mine = await myReview(pool, { authSessionId: stranger.authSessionId, productId: p.id });
      expect(mine).toMatchObject({ eligible: false, reason: "NOT_OWNER", review: null });
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.product_review WHERE user_id = $1", [
          stranger.userId,
        ]),
      ).toBe(0);
    });

    it("REV-1: an unknown or unpublished product is NOT_FOUND", async () => {
      const u = await user(pool);
      expect(await codeOf(save(u, uuidv7(), 5))).toBe("NOT_FOUND");
      const p = await seedProduct();
      const o = await owner(p);
      await pool.query("UPDATE core.product SET status = 'ARCHIVED' WHERE id = $1", [p.id]);
      expect(await codeOf(save(o, p, 5))).toBe("NOT_FOUND");
      expect(await productReviews(pool, { productId: p.id })).toBeNull();
      expect(await reviewSummaries(pool, [p.id])).toEqual([]);
    });

    it("REV-1: the owner of the selling company cannot review its product, even holding an ownership row", async () => {
      const s = await seller(pool);
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 100n * RUPEE,
        units: 2,
      });
      // an ownership the application could never create (self-purchase is refused): planted
      await plant(pool, (c) =>
        c.query(
          "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
          [uuidv7(), s.owner.userId, p.id, uuidv7()],
        ),
      );
      expect(await codeOf(save(s.owner, p, 5))).toBe("REVIEW_NOT_ALLOWED");
      expect((await myReview(pool, { authSessionId: s.owner.authSessionId, productId: p.id })).reason).toBe(
        "SELLER",
      );
      // a real buyer of the same product may
      const b = await user(pool);
      await payFor(pool, b, await checkout(pool, b, [p], standard(s)));
      expect((await save(b, p, 3)).rating).toBe(3);
    });

    it("REV-1: one review per player and product: saving again edits it (a new version, shown as Edited)", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 2, "Hmm");
      const edited = await save(u, p, 5, "Grew on me", "It glows.");
      expect(edited).toMatchObject({ rating: 5, version: 2, edited: true, changed: true });
      const list = await publicList(p);
      expect(list.count).toBe(1);
      expect(list.items[0]).toMatchObject({ rating: 5, title: "Grew on me", edited: true });
      const id = await reviewIdOf(u, p);
      const { rows } = await pool.query<{ version: number; rating: number; title: string }>(
        "SELECT version, rating, title FROM core.product_review_version WHERE review_id = $1 ORDER BY version",
        [id],
      );
      expect(rows).toEqual([
        { version: 1, rating: 2, title: "Hmm" },
        { version: 2, rating: 5, title: "Grew on me" },
      ]);
    });

    it("REV-1: saving the same review again (a client retry) changes nothing", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 4, "Nice");
      const again = await save(u, p, 4, "Nice");
      expect(again).toMatchObject({ version: 1, changed: false, edited: false });
    });

    it("REV-1: two saves racing for the same product leave one review with consecutive versions", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      const results = await Promise.allSettled([1, 2, 3, 4, 5].map((r) => save(u, p, r)));
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.product_review WHERE user_id = $1", [u.userId]),
      ).toBe(1);
      const id = await reviewIdOf(u, p);
      const { rows } = await pool.query<{ v: number[] }>(
        "SELECT array_agg(version ORDER BY version) AS v FROM core.product_review_version WHERE review_id = $1",
        [id],
      );
      const v = rows[0]?.v ?? [];
      expect(v).toEqual(v.map((_, i) => i + 1));
    });

    it("REV-1: a player whose ownership was revoked can no longer write, and their review leaves the public list", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 1);
      expect((await publicList(p)).count).toBe(1);
      await plant(pool, (c) =>
        c.query("UPDATE core.ownership SET state = 'REVOKED' WHERE user_id = $1 AND product_id = $2", [
          u.userId,
          p.id,
        ]),
      );
      expect((await publicList(p)).count).toBe(0);
      expect(await codeOf(save(u, p, 3))).toBe("REVIEW_NOT_ALLOWED");
    });

    it("REV-1: a suspended account's review leaves the public list", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 1);
      await pool.query("UPDATE core.user_profile SET status = 'SUSPENDED' WHERE id = $1", [u.userId]);
      expect((await publicList(p)).count).toBe(0);
    });

    it("REV-1: no job or seeding path creates reviews: no function but the author's command inserts one", async () => {
      const { rows } = await pool.query<{ f: string }>(
        `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('core', 'ledger', 'analytics', 'audit', 'ops', 'private', 'sandbox')
            AND p.prosrc ~* 'INSERT\\s+INTO\\s+core\\.product_review\\M' ORDER BY 1`,
      );
      expect(rows.map((r) => r.f)).toEqual(["core.review_save(uuid,integer,text,text)"]);
    });
  });

  describe("REV-2: the text rules", () => {
    it("REV-2: a bad rating, an over-long title or body, control characters, links and long digit runs are REVIEW_INVALID", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      const bad: [number, string | null, string | null][] = [
        [0, null, null],
        [6, null, null],
        [3, "t".repeat(81), null],
        [3, null, "b".repeat(1001)],
        [3, "line\nbreak", null],
        [3, null, "bell\u0007"],
        [3, null, "see https://example.test"],
        [3, "www.example.test", null],
        [3, null, `card ${NOT_A_CARD_NUMBER}`],
        // review round 1, M1: every reported bypass, and hidden format characters (minor 1)
        ...BYPASS_ATTACKS.map(([t]) => [3, null, t] as [number, string | null, string | null]),
        ...BYPASS_ATTACKS.map(
          ([t]) => [3, t.replace(/\n/g, " "), null] as [number, string | null, string | null],
        ),
        [3, "fine\u2028title", null],
        [3, null, "a\u2029b"],
        [3, null, "nice\u202Elamp"],
        [3, null, "\uFEFFlamp"],
        [3, null, "ring ০১২৩৪৫৬৭৮৯"],
        [3, null, "call ０１２３４５６７８９"],
        [3, null, "see moon.example"],
        [3, null, "mail moon@example.test"],
      ];
      for (const [rating, title, body] of bad) {
        expect(await codeOf(save(u, p, rating, title, body)), `${rating} ${title} ${body}`).toBe(
          "REVIEW_INVALID",
        );
      }
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.product_review WHERE user_id = $1", [u.userId]),
      ).toBe(0);
      // the limits are inclusive; blank text is stored as none; a line break in the body is fine
      const ok = await save(u, p, 3, ` ${"t".repeat(80)} `, `${"b".repeat(999)}\n`);
      expect(ok.title).toHaveLength(80);
      const blank = await save(u, p, 3, "   ", "");
      expect(blank).toMatchObject({ title: null, body: null });
      // prose with full stops and spaces, short numbers and Indic joiners are fine
      expect(await save(u, p, 3, "Fine. Great", "It works. Really well. Room ४५.\nक्\u200Dष")).toMatchObject({
        title: "Fine. Great",
      });
    });
  });

  describe("REV-1: deleting", () => {
    it("REV-1: the author deletes their review for real: text and versions go, the aggregate drops; a repeat answers the same", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 5, "Secret title", "Secret body");
      await save(u, p, 4, "Secret title 2");
      const id = await reviewIdOf(u, p);
      expect(await deleteReview(pool, { authSessionId: u.authSessionId, productId: p.id })).toMatchObject({
        deleted: true,
        changed: true,
      });
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.product_review_version WHERE review_id = $1", [id]),
      ).toBe(0);
      const { rows } = await pool.query(
        "SELECT row_to_json(r)::text AS t FROM core.product_review r WHERE id = $1",
        [id],
      );
      expect(JSON.stringify(rows)).not.toMatch(/Secret/);
      expect((await publicList(p)).count).toBe(0);
      expect(await deleteReview(pool, { authSessionId: u.authSessionId, productId: p.id })).toMatchObject({
        deleted: true,
        changed: false,
      });
      // and may write a new one later
      expect(await save(u, p, 2)).toMatchObject({ version: 1, edited: false });
      expect((await publicList(p)).count).toBe(1);
    });

    it("REV-1: deleting a review that does not exist, or someone else's, is REVIEW_NOT_FOUND", async () => {
      const p = await seedProduct();
      const a = await owner(p);
      const b = await owner(p);
      await save(a, p, 5);
      expect(await codeOf(deleteReview(pool, { authSessionId: b.authSessionId, productId: p.id }))).toBe(
        "REVIEW_NOT_FOUND",
      );
      expect((await publicList(p)).count).toBe(1);
    });
  });

  describe("REV-3: the public aggregate", () => {
    it("REV-3: count, sum, average (tenths, from integers), distribution and newest-first pages of 10", async () => {
      const p = await seedProduct();
      const ratings = [5, 4, 4, 3, 5, 1, 2, 5, 4, 4, 3, 5];
      const owners: TestUser[] = [];
      for (const r of ratings) {
        const u = await owner(p, false);
        owners.push(u);
        await save(u, p, r, `Review ${owners.length}`);
      }
      await aMinuteLater(pool);
      const first = await publicList(p);
      const sum = ratings.reduce((a, b) => a + b, 0);
      expect(first).toMatchObject({
        count: 12,
        ratingSum: sum,
        averageTenths: Math.floor((20 * sum + 12) / 24),
        distribution: [1, 1, 2, 4, 4],
        page: 1,
        pageSize: 10,
        totalPages: 2,
      });
      expect(first.items).toHaveLength(10);
      expect(first.items[0]?.title).toBe("Review 12");
      const second = await publicList(p, 2);
      expect(second.items.map((i) => i.title)).toEqual(["Review 2", "Review 1"]);
      expect((await publicList(p, 3)).items).toEqual([]);
      // a hidden review leaves the aggregate and the list
      const hiddenOwner = owners[0];
      if (!hiddenOwner) throw new Error("fixture");
      await hideReview(pool, {
        authSessionId: admin.authSessionId,
        reviewId: await reviewIdOf(hiddenOwner, p),
        reason: "Off-topic content",
      });
      const after = await publicList(p);
      expect(after).toMatchObject({ count: 11, ratingSum: sum - 5, distribution: [1, 1, 2, 4, 3] });
      await aDayLater();
      const [summary] = await reviewSummaries(pool, [p.id]);
      expect(summary).toEqual({
        productId: p.id,
        count: 11,
        ratingSum: sum - 5,
        averageTenths: Math.floor((20 * (sum - 5) + 11) / 22),
      });
    });

    it("REV-3: summaries for a list of ids: published products only, zero for none, unknown ids left out", async () => {
      const a = await seedProduct();
      const b = await seedProduct();
      const u = await owner(a);
      await save(u, a, 3);
      await aDayLater();
      const out = await reviewSummaries(pool, [a.id, b.id, uuidv7()]);
      expect(out).toHaveLength(2);
      expect(out.find((s) => s.productId === a.id)).toEqual({
        productId: a.id,
        count: 1,
        ratingSum: 3,
        averageTenths: 30,
      });
      expect(out.find((s) => s.productId === b.id)).toEqual({
        productId: b.id,
        count: 0,
        ratingSum: 0,
        averageTenths: 0,
      });
      expect(
        await codeOf(
          reviewSummaries(
            pool,
            Array.from({ length: 101 }, () => uuidv7()),
          ),
        ),
      ).toBe("VALIDATION_FAILED");
    });

    it("REV-3: no float reaches the answer: every number is a whole number", async () => {
      const p = await seedProduct();
      for (const r of [5, 4, 4]) await save(await owner(p, false), p, r);
      await aMinuteLater(pool);
      const list = await publicList(p);
      for (const n of [list.count, list.ratingSum, list.averageTenths, ...list.distribution])
        expect(Number.isInteger(n)).toBe(true);
      expect(list.averageTenths).toBe(43);
    });
  });

  describe("REV-4: moderation by the Super Admin", () => {
    it("REV-4: hide needs the Super Admin and a reason; it is audited; the author sees it hidden; restore brings it back", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 1, "Rude words");
      const reviewId = await reviewIdOf(u, p);
      expect(
        await codeOf(
          hideReview(pool, { authSessionId: u.authSessionId, reviewId, reason: "Not allowed here" }),
        ),
      ).toBe("FORBIDDEN");
      expect(await codeOf(adminReviews(pool, { authSessionId: u.authSessionId }))).toBe("FORBIDDEN");
      expect(
        await codeOf(hideReview(pool, { authSessionId: admin.authSessionId, reviewId, reason: "no" })),
      ).toBe("VALIDATION_FAILED");
      const auditBefore = await count(
        pool,
        "SELECT count(*) AS n FROM audit.audit_log WHERE target_id = $1",
        [reviewId],
      );
      expect(
        await hideReview(pool, { authSessionId: admin.authSessionId, reviewId, reason: "Abusive language" }),
      ).toEqual({ reviewId, hidden: true });
      expect(
        await codeOf(
          hideReview(pool, { authSessionId: admin.authSessionId, reviewId, reason: "Again please" }),
        ),
      ).toBe("CONFLICT");
      expect((await publicList(p)).count).toBe(0);
      const own = await myReview(pool, { authSessionId: u.authSessionId, productId: p.id });
      expect(own.review).toMatchObject({ hidden: true, hiddenReason: "Abusive language", public: false });
      // editing, or deleting and writing again, does not bring it back
      await save(u, p, 2, "Edited");
      expect((await publicList(p)).count).toBe(0);
      await deleteReview(pool, { authSessionId: u.authSessionId, productId: p.id });
      await save(u, p, 3, "Fresh start");
      expect((await publicList(p)).count).toBe(0);
      const listed = await adminReviews(pool, { authSessionId: admin.authSessionId, filter: "HIDDEN" });
      expect(listed.items.find((i) => i.reviewId === reviewId)).toMatchObject({
        productId: p.id,
        rating: 3,
        title: "Fresh start",
        hidden: true,
      });
      expect(
        await restoreReview(pool, {
          authSessionId: admin.authSessionId,
          reviewId,
          reason: "Reviewed, acceptable",
        }),
      ).toEqual({ reviewId, hidden: false });
      expect((await publicList(p)).items[0]?.title).toBe("Fresh start");
      expect(
        await codeOf(
          restoreReview(pool, { authSessionId: admin.authSessionId, reviewId, reason: "Already visible" }),
        ),
      ).toBe("CONFLICT");
      const { rows } = await pool.query<{ action: string; actor_kind: string }>(
        "SELECT action, actor_kind FROM audit.audit_log WHERE target_id = $1 ORDER BY id",
        [reviewId],
      );
      expect(rows.length).toBe(auditBefore + 2);
      expect(rows.map((r) => r.action)).toEqual(["review.hide", "review.restore"]);
      expect(
        await codeOf(
          hideReview(pool, { authSessionId: admin.authSessionId, reviewId: uuidv7(), reason: "Unknown one" }),
        ),
      ).toBe("REVIEW_NOT_FOUND");
    });

    it("REV-4: the console list is newest first, paged, and names no user id", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 4, "Console check");
      const page = await adminReviews(pool, { authSessionId: admin.authSessionId });
      expect(page.items[0]).toMatchObject({
        productId: p.id,
        title: "Console check",
        productName: "Moon Lamp",
      });
      expect(JSON.stringify(page)).not.toContain(u.userId);
      // review ids are random (version 4), so they say nothing about when a review was written
      for (const i of page.items) expect(i.reviewId[14]).toBe("4");
    });
  });

  describe("REV-5: privacy", () => {
    it("REV-5 (minor 4): a review is public only from the reporting day after it was written; the author sees it at once", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      const saved = await save(u, p, 5, "Tomorrow");
      expect(saved.public).toBe(false);
      const now = await productReviews(pool, { productId: p.id });
      expect(now?.items.some((i) => i.title === "Tomorrow")).toBe(false);
      expect(now?.count).toBe(0);
      expect((await reviewSummaries(pool, [p.id]))[0]?.count).toBe(0);
      const mine = await myReview(pool, { authSessionId: u.authSessionId, productId: p.id });
      expect(mine.review).toMatchObject({ title: "Tomorrow", public: false });
      // the boundary is the start of the reporting day (Asia/Kolkata)
      const { rows } = await pool.query<{ ok: boolean }>(
        `SELECT core.review_public_before() = (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Kolkata')
                                                AT TIME ZONE 'Asia/Kolkata') AS ok`,
      );
      expect(rows[0]?.ok).toBe(true);
      // tomorrow
      expect((await publicList(p)).items.some((i) => i.title === "Tomorrow")).toBe(true);
      expect((await reviewSummaries(pool, [p.id]))[0]?.count).toBe(1);
      expect((await myReview(pool, { authSessionId: u.authSessionId, productId: p.id })).review?.public).toBe(
        true,
      );
    });

    it("REV-5 (minor 4): the boundary cannot be moved by an application role", async () => {
      for (const role of ["app_web", "app_pay", "app_jobs"]) {
        expect(await stateOf(pool, "SELECT core.review_public_before()", [], { role }), role).toBe("42501");
      }
    });

    it("REV-5: no public or author answer carries a user id, an order-side id, a review id or a time finer than a day", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await pool.query("UPDATE core.user_profile SET handle = NULL WHERE id = $1", [u.userId]);
      await save(u, p, 4, "Privacy", "Checked");
      const { rows: ids } = await pool.query<{ id: string }>(
        `WITH g AS (SELECT * FROM core.order_group WHERE buyer_user_id = $1)
         SELECT g.id::text FROM g UNION SELECT g.session_id::text FROM g UNION SELECT g.payment_attempt_id::text FROM g
         UNION SELECT g.journal_id::text FROM g
         UNION SELECT so.id::text FROM core.seller_order so JOIN g ON g.id = so.order_group_id
         UNION SELECT l.id::text FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id JOIN g ON g.id = so.order_group_id
         UNION SELECT o.id::text FROM core.ownership o WHERE o.user_id = $1
         UNION SELECT r.id::text FROM core.product_review r WHERE r.user_id = $1
         UNION SELECT $1::text UNION SELECT $2::text`,
        [u.userId, u.authSessionId],
      );
      expect(ids.length).toBeGreaterThanOrEqual(8);
      const answers = JSON.stringify([
        await publicList(p),
        await reviewSummaries(pool, [p.id]),
        await myReview(pool, { authSessionId: u.authSessionId, productId: p.id }),
      ]);
      for (const { id } of ids) expect(answers).not.toContain(id);
      expect(answers).not.toMatch(/\d{2}:\d{2}/); // no clock time anywhere
      expect(answers).not.toMatch(/userId|orderId|ownership|createdAt|reviewId/);
      const keys = Object.keys((await publicList(p)).items[0] ?? {}).sort();
      expect(keys).toEqual(["body", "createdOn", "edited", "handle", "rating", "title"]);
    });

    it("REV-5 (generated): no application role holds any privilege on the review tables, and row-level security is on", async () => {
      for (const t of TABLES) {
        const { rows } = await pool.query<{ rls: boolean }>(
          "SELECT relrowsecurity AS rls FROM pg_class WHERE oid = $1::regclass",
          [t],
        );
        expect(rows[0]?.rls, t).toBe(true);
        for (const role of ROLES) {
          const held = await pool.query<{ p: string }>(
            `SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p WHERE has_any_column_privilege($1, $2, p)
             UNION ALL SELECT p FROM unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) p WHERE has_table_privilege($1, $2, p)`,
            [role, t],
          );
          expect(held.rows, `${role} ${t}`).toEqual([]);
        }
      }
    });

    it("REV-5: direct reads, writes and row locks on the review tables are refused for every application role", async () => {
      const p = await seedProduct();
      const u = await owner(p);
      await save(u, p, 4);
      for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        for (const sql of [
          "SELECT user_id FROM core.product_review",
          "SELECT body FROM core.product_review_version",
          "UPDATE core.product_review SET rating = 1",
          "UPDATE core.product_review SET hidden = false",
          "DELETE FROM core.product_review",
          "INSERT INTO core.product_review_version (review_id, version, rating) VALUES (gen_random_uuid(), 99, 5)",
          "SELECT 1 FROM core.product_review FOR UPDATE",
        ]) {
          expect(await stateOf(pool, sql, [], { role, userId: u.userId }), `${role}: ${sql}`).toBe("42501");
        }
      }
    });

    it("REV-5 (generated): every review function is executable only by the roles listed here", async () => {
      const EXPECTED: Record<string, string[]> = {
        "core.product_reviews(uuid,integer)": ["app_web"],
        "core.product_review_summaries(uuid[])": ["app_web"],
        "core.my_review(uuid)": ["app_web"],
        "core.review_save(uuid,integer,text,text)": ["app_web"],
        "core.review_delete(uuid)": ["app_web"],
        "core.admin_reviews(text,integer)": ["app_web"],
        "core.admin_review_hide(uuid,text)": ["app_web"],
        "core.admin_review_restore(uuid,text)": ["app_web"],
      };
      const { rows } = await pool.query<{ f: string; role: string }>(
        `SELECT p.oid::regprocedure::text AS f, r AS role
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest($1::text[]) r
          WHERE n.nspname = 'core' AND (p.proname ~ 'review' AND p.proname !~ '^(listing|admin_listing)')
            AND has_function_privilege(r, p.oid, 'EXECUTE')
          ORDER BY 1, 2`,
        [ROLES],
      );
      const held: Record<string, string[]> = {};
      for (const r of rows) held[r.f] = [...(held[r.f] ?? []), r.role];
      expect(held).toEqual(EXPECTED);
      // and every one of them is an owner-run definer with a pinned search path
      const { rows: defs } = await pool.query<{ f: string; secdef: boolean; cfg: string[] | null }>(
        `SELECT p.oid::regprocedure::text AS f, p.prosecdef AS secdef, p.proconfig AS cfg
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'core' AND p.oid::regprocedure::text = ANY ($1::text[])`,
        [Object.keys(EXPECTED)],
      );
      expect(defs).toHaveLength(Object.keys(EXPECTED).length);
      for (const d of defs) {
        expect(d.secdef, d.f).toBe(true);
        expect(d.cfg ?? [], d.f).toContain("search_path=pg_catalog, pg_temp");
      }
    });

    it("REV-5: the author's command cannot be pointed at another user: the actor comes from the session only", async () => {
      const p = await seedProduct();
      const a = await owner(p);
      const b = await user(pool);
      // b signed in, calling the command directly as app_web: refused, a's review untouched
      await save(a, p, 5, "Mine");
      const state = await inRolledBackTx(pool, async (x) => {
        await become(x, { role: "app_web", userId: b.userId });
        try {
          await x.query("SELECT core.review_save($1, 1, 'Hijack', NULL)", [p.id]);
          return "no error";
        } catch (error) {
          return (error as { hint?: string }).hint ?? "?";
        }
      });
      expect(state).toBe("REVIEW_NOT_ALLOWED");
      expect((await publicList(p)).items[0]?.title).toBe("Mine");
      // with no session at all
      const none = await inRolledBackTx(pool, async (x) => {
        await become(x, { role: "app_web" });
        try {
          await x.query("SELECT core.review_save($1, 1, NULL, NULL)", [p.id]);
          return "no error";
        } catch (error) {
          return (error as { hint?: string }).hint ?? "?";
        }
      });
      expect(none).toBe("FORBIDDEN");
    });

    it("minor 3: the database's review limits default to REVIEW_RULES in core (one source)", async () => {
      const { rows } = await pool.query<{ k: string; v: number }>(
        `SELECT k, core.review_limit(k) AS v FROM unnest(ARRAY['review_title_max_chars', 'review_body_max_chars',
           'review_page_size', 'review_admin_page_size', 'review_summary_max']) k`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.k, r.v]))).toEqual({
        review_title_max_chars: REVIEW_RULES.titleMaxChars,
        review_body_max_chars: REVIEW_RULES.bodyMaxChars,
        review_page_size: REVIEW_RULES.pageSize,
        review_admin_page_size: REVIEW_RULES.adminPageSize,
        review_summary_max: REVIEW_RULES.summaryMax,
      });
      // and the refusal message names the configured number, not a literal
      const p = await seedProduct();
      const u = await owner(p);
      const message = await save(u, p, 3, "t".repeat(REVIEW_RULES.titleMaxChars + 1)).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(message).toContain(String(REVIEW_RULES.titleMaxChars));
    });

    it("minor 3: every review setting is clamped: a page size of 0 or a huge title limit cannot break anything", async () => {
      const p = await seedProduct();
      const result = await inRolledBackTx(pool, async (c) => {
        await c.query(
          `INSERT INTO core.config_version (values, effective_from)
           SELECT cv.values || '{"review_page_size": 0, "review_admin_page_size": 0, "review_title_max_chars": 99999,
                                 "review_body_max_chars": 0, "review_summary_max": 100000}'::jsonb, now() - interval '1 second'
             FROM core.config_version cv ORDER BY cv.id DESC LIMIT 1`,
        );
        const { rows } = await c.query<{ r: { pageSize: number; totalPages: number } }>(
          "SELECT core.product_reviews($1, 1) AS r",
          [p.id],
        );
        const limits = await c.query<{ k: string; v: number }>(
          `SELECT k, core.review_limit(k) AS v FROM unnest(ARRAY['review_title_max_chars', 'review_body_max_chars',
             'review_page_size', 'review_admin_page_size', 'review_summary_max']) k`,
        );
        return { page: rows[0]?.r, limits: Object.fromEntries(limits.rows.map((r) => [r.k, r.v])) };
      });
      expect(result.page).toMatchObject({ pageSize: 1, totalPages: 0 });
      expect(result.limits).toEqual({
        review_title_max_chars: 200,
        review_body_max_chars: 1,
        review_page_size: 1,
        review_admin_page_size: 1,
        review_summary_max: 100,
      });
    });

    it("REV-5: review analytics events are server events with no props, no visitor key and no user id", async () => {
      const u = await user(pool);
      const base = {
        authSessionId: u.authSessionId,
        surface: "shop",
        visitorKey: null,
        placeKey: null,
        country: "ZZ",
        region: null,
        city: null,
        deviceClass: "unknown",
      };
      expect(await recordEvent(pool, { ...base, name: "review_submitted", props: {} })).toBe(true);
      expect(await recordEvent(pool, { ...base, name: "review_hidden", surface: "console", props: {} })).toBe(
        true,
      );
      expect(
        await codeOf(
          recordEvent(pool, { ...base, name: "review_submitted", props: { product_id: uuidv7() } }),
        ),
      ).toBe("VALIDATION_FAILED");
      expect(
        await codeOf(
          recordEvent(pool, { ...base, authSessionId: null, name: "review_submitted", props: {} }),
        ),
      ).toBe("VALIDATION_FAILED");
      const { rows } = await pool.query<{ visitor_key: Buffer | null; props: unknown; on_hour: boolean }>(
        `SELECT visitor_key, props, mod(extract(epoch FROM occurred_at), 3600) = 0 AS on_hour
           FROM analytics.event WHERE name IN ('review_submitted', 'review_hidden')`,
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r).toEqual({ visitor_key: null, props: {}, on_hour: true });
      // the daily rollup still runs with them present
      await pool.query("SELECT analytics.rollup_day((now() AT TIME ZONE 'UTC')::date)");
    });

    it("REV-5: the money and order records are untouched by reviewing", async () => {
      expect(await reconcile(pool)).toEqual(CLEAN);
    });
  });
});
