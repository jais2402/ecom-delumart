import { PASSPORT_V1 } from "@delulu/core";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { myCompany, updateStore } from "../src/company";
import { createDraft } from "../src/listing";
import { createCoupon, mySellerOrders } from "../src/merchant";
import { passportProgress, submitPassportQuiz } from "../src/passport";
import { createReport } from "../src/safety";
import { CLEAN, checkout, codeOf, payFor, reconcile, user } from "./checkout-fixtures";
import { asActor, countRows, createTestDatabase, stateOf, type TestDatabase, type TestUser } from "./helpers";
import {
  asFixture,
  type Creator,
  creator,
  draftInput,
  ensureCategories,
  publishListing,
} from "./listing-fixtures";
import { CORRECT_ANSWERS, published } from "./selling-fixtures";

/**
 * Sixth security review, minor 7 (facts the database took on the server's word, 0050) and minor 8
 * (the seller's order view, 0051).
 */
describe("sixth security review: server-trusted facts and the seller's order view", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let seeds: Awaited<ReturnType<typeof published>>;
  let c: Creator;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    seeds = await published(pool, 3);
    c = await creator(pool, seeds);
  }, 120_000);
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });

  // ------------------------------------------------------------------ 7a
  it("minor 7a (US-05): the seeded answer key is packages/core's passport_v1 key, in question order", async () => {
    const { rows } = await pool.query<{
      rule_version: string;
      question_id: string;
      correct_option_id: string;
    }>(
      "SELECT rule_version, question_id, correct_option_id FROM core.passport_answer_key ORDER BY rule_version, ordinal",
    );
    expect(rows).toEqual(
      PASSPORT_V1.questions.map((q) => ({
        rule_version: PASSPORT_V1.ruleVersion,
        question_id: q.id,
        correct_option_id: q.correctOptionId,
      })),
    );
    // and every correct option is one of the question's options
    for (const q of PASSPORT_V1.questions) expect(q.options.map((o) => o.id)).toContain(q.correctOptionId);
  });

  it("minor 7a (US-05): the database grades the quiz and names the wrong questions in order; nobody can record a pass without answers", async () => {
    const u = await user(pool);
    const wrong = await submitPassportQuiz(pool, {
      ...as(u),
      answers: { "q-buyers": "opt-buyers-people", "q-money": "opt-money-play" },
    });
    expect(wrong).toMatchObject({
      passed: false,
      wrong: ["q-delivery", "q-buyers"],
      ruleVersion: "passport_v1",
    });
    expect(wrong.passport.quiz).toMatchObject({ done: false, failedAttempts: 1 });
    // the old "the server says it passed" command is gone for every application role
    for (const role of ["app_web", "app_pay", "app_jobs"]) {
      expect(
        await stateOf(pool, "SELECT core.passport_record_quiz(true, 'passport_v1')", [], {
          role,
          userId: u.userId,
        }),
        role,
      ).toBe("42501");
      expect(
        await stateOf(pool, "SELECT * FROM core.passport_answer_key", [], { role, userId: u.userId }),
        role,
      ).toBe("42501");
    }
    expect((await passportProgress(pool, as(u))).quiz.done).toBe(false);
    const right = await submitPassportQuiz(pool, { ...as(u), answers: CORRECT_ANSWERS });
    expect(right).toMatchObject({ passed: true, wrong: [] });
    expect(right.passport.quiz.done).toBe(true);
  });

  // ------------------------------------------------------------------ 7b
  it("minor 7b: the commands that store screened text run for app_pay only, never on the app_web pool", async () => {
    const l = await publishListing(pool, c);
    const reporter = await user(pool);
    const calls: [string, unknown[], TestUser][] = [
      [
        "SELECT core.passport_submit_concept('A lamp that is mostly moon and partly nap.', 'OK')",
        [],
        reporter,
      ],
      ["SELECT core.update_store('Unscreened Name', 'unscreened words')", [], c.u],
      [
        "SELECT core.report_create('PRODUCT', $1, 'OTHER', 'unscreened detail', '[]'::jsonb)",
        [l.productId],
        reporter,
      ],
      ["SELECT core.appeal_create($1, 'An unscreened statement that is long enough.')", [l.productId], c.u],
      ["SELECT core.company_quote('lamps-unscreened', 'Unscreened', '')", [], reporter],
    ];
    for (const [sql, params, who] of calls) {
      expect(await stateOf(pool, sql, params, { role: "app_web", userId: who.userId }), sql).toBe("42501");
    }
    // through the pay credential they work as before
    expect(await updateStore(pool, { ...as(c.u), description: "Lamps that are mostly moon." })).toMatchObject(
      {
        description: "Lamps that are mostly moon.",
      },
    );
    expect(
      await codeOf(
        createReport(pool, {
          ...as(reporter),
          targetType: "PRODUCT",
          targetId: l.productId,
          reason: "OTHER",
        }),
      ),
    ).toBe("ok");
  });

  // ------------------------------------------------------------------ 7c
  it("minor 7c: no application role reads a company's owner; the owner still sees their own drafts through row-level security", async () => {
    for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      for (const sql of [
        "SELECT owner_user_id FROM core.company",
        "SELECT * FROM core.company",
        "SELECT id FROM core.company WHERE owner_user_id IS NOT NULL",
      ]) {
        expect(await stateOf(pool, sql, [], { role, userId: c.u.userId }), `${role}: ${sql}`).toBe("42501");
      }
    }
    expect(
      await stateOf(pool, "SELECT id, handle, name, description, tier FROM core.company", [], {
        role: "app_web",
      }),
    ).toBe("no error");
    // row-level security (core.actor_company_ids, now a definer) still lets the owner, and only the
    // owner, see the store's draft
    const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
    const drafts = (u: TestUser) =>
      asActor(pool, { role: "app_web", userId: u.userId }, (x) =>
        countRows(x, "SELECT count(*) AS n FROM core.product WHERE id = $1", [d.productId]),
      );
    expect(await drafts(c.u)).toBe(1);
    expect(await drafts(await user(pool))).toBe(0);
    expect((await myCompany(pool, as(c.u)))?.companyId).toBe(c.companyId);
  });

  // ------------------------------------------------------------------ 8
  it("minor 8 (US-45): a private coupon's code never reaches the seller (couponKind PRIVATE); a public one does; times are to the minute", async () => {
    const s = await creator(pool, seeds);
    const p = asFixture(await publishListing(pool, s, { quantity: 2 }));
    const priv = await createCoupon(pool, {
      ...as(s.u),
      coupon: { kind: "PERCENT", value: 10n, isPublic: false },
    });
    await createCoupon(pool, {
      ...as(s.u),
      coupon: { kind: "PERCENT", value: 5n, isPublic: true, publicCode: "SHOWN05" },
    });
    const std = { [s.companyId]: "STANDARD" as const };
    const b1 = await user(pool);
    await payFor(pool, b1, await checkout(pool, b1, [p], std, priv.code ?? ""));
    const b2 = await user(pool);
    await payFor(pool, b2, await checkout(pool, b2, [p], std, "SHOWN05"));
    const items = (await mySellerOrders(pool, as(s.u))).items;
    expect(items.map((o) => [o.couponCode, o.couponKind])).toEqual([
      ["SHOWN05", "PUBLIC"],
      [null, "PRIVATE"],
    ]);
    const raw = JSON.stringify(
      (
        await pool.query(
          "SELECT core.seller_order_json(id) AS j FROM core.seller_order WHERE company_id = $1",
          [s.companyId],
        )
      ).rows,
    );
    expect(raw).not.toContain(priv.code ?? "never");
    for (const o of items) {
      expect(o.orderedAt.getUTCSeconds()).toBe(0);
      expect(o.orderedAt.getUTCMilliseconds()).toBe(0);
      for (const t of [o.delivery?.placedAt, o.delivery?.deliveredAt]) expect(t?.getUTCSeconds()).toBe(0);
    }
  });
});
