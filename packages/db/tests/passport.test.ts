import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  creatorAccess,
  mySaves,
  passportProgress,
  saveProduct,
  submitPassportConcept,
  submitPassportQuiz,
  unsaveProduct,
} from "../src/passport";
import {
  CLEAN,
  CRORE,
  checkout,
  codeOf,
  count,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  reconcile,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  type Actor,
  commitError,
  createTestDatabase,
  RAW_WRITER,
  sessionFor,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";
import {
  CONCEPT,
  CORRECT_ANSWERS,
  completePassport,
  passQuiz,
  published,
  STARTING,
  spendTo,
} from "./selling-fixtures";

const web = (u: TestUser): Actor => ({ role: "app_web", userId: u.userId });
const payAs = (u: TestUser): Actor => ({ role: "app_pay", userId: u.userId });
const rawAs = (u: TestUser): Actor => ({ role: RAW_WRITER, userId: u.userId });

/** Saves (A) and the Inventor Passport (B, US-05), migration 0032. */
describe("saves and the Inventor Passport", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 30 });
    pool = db.pool;
    items = await published(pool, 5);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const save = (u: TestUser, p: ProductFixture | string) =>
    saveProduct(pool, { authSessionId: u.authSessionId, productId: typeof p === "string" ? p : p.id });
  const unsave = (u: TestUser, p: ProductFixture) =>
    unsaveProduct(pool, { authSessionId: u.authSessionId, productId: p.id });
  const savedIds = async (u: TestUser) =>
    (await mySaves(pool, { authSessionId: u.authSessionId })).items.map((s) => s.productId);
  const at = (i: number): ProductFixture => {
    const p = items[i];
    if (!p) throw new Error("fixture");
    return p;
  };

  /** A DRAFT product of a company (not published), written as the owner. */
  async function draftProduct(): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode)
       VALUES ($1, NULL, 'SEED', 'DRAFT', 'gadgets', 'UNLIMITED_SEED')`,
      [id],
    );
    return id;
  }

  describe("saves (A)", () => {
    it("A: save, list, unsave; one save per person and product; a new (<24 h) account may save", async () => {
      const a = await user(pool);
      await save(a, at(0));
      await save(a, at(1));
      await save(a, at(0)); // again: a no-op
      expect(await savedIds(a)).toEqual([at(1).id, at(0).id]); // newest first
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.product_save WHERE user_id = $1", [a.userId]),
      ).toBe(2);
      const listed = (await mySaves(pool, { authSessionId: a.authSessionId })).items[0];
      expect(listed).toMatchObject({
        published: true,
        name: "Moon Lamp",
        pricePaise: 100n * RUPEE,
        available: true,
      });
      await unsave(a, at(1));
      await unsave(a, at(1)); // already unsaved: a no-op
      expect(await savedIds(a)).toEqual([at(0).id]);
      await save(a, at(1));
      expect(await savedIds(a)).toEqual([at(1).id, at(0).id]);
    });

    it("A: only PUBLISHED products can be saved", async () => {
      const a = await user(pool);
      expect(await codeOf(save(a, await draftProduct()))).toBe("PRODUCT_UNAVAILABLE");
      expect(await codeOf(save(a, uuidv7()))).toBe("PRODUCT_UNAVAILABLE");
      expect(await savedIds(a)).toEqual([]);
    });

    it("A: pages by the last save id", async () => {
      const a = await user(pool);
      for (const p of items) await save(a, p);
      const first = await mySaves(pool, { authSessionId: a.authSessionId, pageSize: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBe(first.items[1]?.saveId);
      const second = await mySaves(pool, {
        authSessionId: a.authSessionId,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      const third = await mySaves(pool, {
        authSessionId: a.authSessionId,
        pageSize: 2,
        cursor: second.nextCursor,
      });
      expect([...first.items, ...second.items, ...third.items].map((s) => s.productId)).toEqual(
        [...items].reverse().map((p) => p.id),
      );
      expect(third.nextCursor).toBeNull();
    });

    it("A: user B can never see or change user A's saves", async () => {
      const a = await user(pool);
      const b = await user(pool);
      await save(a, at(2));
      expect(await savedIds(b)).toEqual([]);
      await unsave(b, at(2)); // B's own (absent) save: changes nothing of A's
      expect(await savedIds(a)).toEqual([at(2).id]);
      // the table itself is closed to every application role
      for (const as of [web(b), payAs(b), web(a)]) {
        expect(await stateOf(pool, "SELECT 1 FROM core.product_save", [], as)).toBe("42501");
        expect(
          await stateOf(
            pool,
            "INSERT INTO core.product_save (id, user_id, product_id, first_saved_at, saved_at) VALUES ($1, $2, $3, now(), now())",
            [uuidv7(), a.userId, at(3).id],
            as,
          ),
        ).toBe("42501");
      }
    });

    it("A: needs a sign-in session and a finished onboarding", async () => {
      const a = await user(pool);
      expect(await codeOf(saveProduct(pool, { authSessionId: uuidv7(), productId: at(0).id }))).toBe(
        "FORBIDDEN",
      );
      // signed in, but no account yet
      const fresh = uuidv7();
      const session = await sessionFor(pool, fresh);
      expect(await codeOf(saveProduct(pool, { authSessionId: session, productId: at(0).id }))).toBe(
        "ONBOARDING_REQUIRED",
      );
      expect(await savedIds(a)).toEqual([]);
    });
  });

  describe("passport (US-05)", () => {
    const progress = (u: TestUser) => passportProgress(pool, { authSessionId: u.authSessionId });
    // graded by the database against its own key (sixth review, 0050)
    const quiz = async (u: TestUser, passed: boolean, answers?: Record<string, string>) =>
      (
        await submitPassportQuiz(pool, {
          authSessionId: u.authSessionId,
          answers:
            answers ?? (passed ? CORRECT_ANSWERS : { ...CORRECT_ANSWERS, "q-money": "opt-money-real" }),
        })
      ).passport;
    const concept = (u: TestUser, text = CONCEPT, screening: "OK" | "NEEDS_REVIEW" | "REJECT" = "OK") =>
      submitPassportConcept(pool, { authSessionId: u.authSessionId, concept: text, screening });
    const entitlements = (u: TestUser) =>
      pool.query<{ source: string; rule_version: string | null; evidence_order_group_id: string | null }>(
        "SELECT source, rule_version, evidence_order_group_id FROM core.creator_entitlement WHERE user_id = $1",
        [u.userId],
      );
    const evidence = async (u: TestUser) =>
      (
        await pool.query<{ route: string }>(
          "SELECT route FROM core.creator_route_evidence WHERE user_id = $1 ORDER BY route",
          [u.userId],
        )
      ).rows.map((r) => r.route);

    it("US-05: a fresh passport has no step done; creator access is locked on both routes", async () => {
      const a = await user(pool);
      expect(await creatorAccess(pool, { authSessionId: a.authSessionId })).toMatchObject({
        unlocked: false,
        source: null,
        unlockedAt: null,
        ruleVersion: null,
        routes: { spend: { balancePaise: STARTING, thresholdPaise: CRORE, reached: false, reachedAt: null } },
      });
      expect(await progress(a)).toMatchObject({
        ruleVersion: "passport_v1",
        quiz: { done: false, failedAttempts: 0 },
        saves: { done: false, count: 0, required: 3 },
        concept: { done: false, text: null },
        completedAt: null,
      });
    });

    it("US-05 step 1: a wrong quiz may be retried without limit; a pass is kept; malformed answers are refused", async () => {
      const a = await user(pool);
      for (let i = 0; i < 4; i++) await quiz(a, false);
      expect((await progress(a)).quiz).toMatchObject({ done: false, failedAttempts: 4 });
      expect(await codeOf(quiz(a, true, { "q-money": 3 } as unknown as Record<string, string>))).toBe(
        "VALIDATION_FAILED",
      );
      expect((await progress(a)).quiz.done).toBe(false);
      const passed = await quiz(a, true);
      expect(passed.quiz.done).toBe(true);
      await quiz(a, false); // a later failed try does not undo the pass
      expect((await progress(a)).quiz.done).toBe(true);
      // only pass/fail and the rule version are stored: no answers anywhere
      const { rows } = await pool.query("SELECT * FROM core.passport_progress WHERE user_id = $1", [
        a.userId,
      ]);
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
        [
          "completed_at",
          "concept_submitted_at",
          "created_at",
          "quiz_failed_count",
          "quiz_passed_at",
          "rule_version",
          "saves_completed_at",
          "updated_at",
          "user_id",
        ].sort(),
      );
    });

    it("US-05 step 2: three distinct PUBLISHED saves; unsaving later does not undo the step", async () => {
      const a = await user(pool);
      await save(a, at(0));
      // a product saved and then unpublished does not count
      const hidden = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      await save(a, hidden);
      await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [hidden.id]);
      await save(a, at(1));
      await save(a, at(0)); // the same product twice is one save
      expect((await progress(a)).saves).toMatchObject({ done: false, count: 2 });
      await save(a, at(2));
      const done = await progress(a);
      expect(done.saves).toMatchObject({ done: true, count: 3 });
      await unsave(a, at(0));
      await unsave(a, at(1));
      expect((await progress(a)).saves).toMatchObject({ done: true, count: 1 });
    });

    it("US-05 step 3: the concept is 20–280 characters and needs the web server's OK; anything else stores nothing", async () => {
      const a = await user(pool);
      expect(await codeOf(concept(a, CONCEPT, "NEEDS_REVIEW"))).toBe("VALIDATION_FAILED");
      expect(await codeOf(concept(a, CONCEPT, "REJECT"))).toBe("VALIDATION_FAILED");
      expect(await codeOf(concept(a, "too short to count"))).toBe("VALIDATION_FAILED"); // 18
      expect(await codeOf(concept(a, `   ${"x".repeat(19)}   `))).toBe("VALIDATION_FAILED"); // trimmed
      expect(await codeOf(concept(a, "x".repeat(281)))).toBe("VALIDATION_FAILED");
      expect(await codeOf(concept(a, `${"x".repeat(20)}\u0007`))).toBe("VALIDATION_FAILED");
      expect(
        await count(pool, "SELECT count(*) AS n FROM private.invention_concept WHERE user_id = $1", [
          a.userId,
        ]),
      ).toBe(0);
      expect((await progress(a)).concept.done).toBe(false);
      const ok = await concept(a, "x".repeat(20));
      expect(ok.concept).toMatchObject({ done: true, text: "x".repeat(20) });
      expect((await concept(a, `  ${"y".repeat(280)}  `)).concept.text).toBe("y".repeat(280));
    });

    it("US-05: the concept is readable by its owner only", async () => {
      const a = await user(pool);
      const b = await user(pool);
      await concept(a);
      expect((await progress(a)).concept.text).toBe(CONCEPT);
      expect((await progress(b)).concept.text).toBeNull();
      for (const as of [web(b), payAs(b), web(a), payAs(a)]) {
        expect(await stateOf(pool, "SELECT concept FROM private.invention_concept", [], as)).toBe("42501");
      }
      for (const as of [web(b), payAs(b)]) {
        expect(await stateOf(pool, "SELECT 1 FROM core.passport_progress", [], as)).toBe("42501");
      }
    });

    it("US-05: steps in any order; completion grants the entitlement once, as ACHIEVEMENT with the rule version; the wallet is untouched", async () => {
      const a = await user(pool);
      const journalsBefore = await count(pool, "SELECT count(*) AS n FROM ledger.journal");
      await concept(a);
      await save(a, at(0));
      await save(a, at(1));
      expect((await creatorAccess(pool, { authSessionId: a.authSessionId })).unlocked).toBe(false);
      await save(a, at(2));
      expect((await progress(a)).completedAt).toBeNull();
      const done = await quiz(a, true);
      expect(done.completedAt).toBeInstanceOf(Date);
      expect((await entitlements(a)).rows).toEqual([
        { source: "ACHIEVEMENT", rule_version: "passport_v1", evidence_order_group_id: null },
      ]);
      expect(await evidence(a)).toEqual(["PASSPORT"]);
      // more steps, reads and retries change nothing
      await quiz(a, true);
      await concept(a, "A second concept, still long enough.");
      await save(a, at(3));
      await progress(a);
      expect((await entitlements(a)).rows).toHaveLength(1);
      const access = await creatorAccess(pool, { authSessionId: a.authSessionId });
      expect(access).toMatchObject({
        unlocked: true,
        source: "ACHIEVEMENT",
        ruleVersion: "passport_v1",
        routes: { spend: { balancePaise: STARTING, thresholdPaise: CRORE, reached: false } },
      });
      // the full ₹100 crore is intact and no money moved
      expect(await wallet(pool, a.ledgerAccountId)).toBe(STARTING);
      expect(await count(pool, "SELECT count(*) AS n FROM ledger.journal")).toBe(journalsBefore);
    });

    it("US-05: concurrent final steps grant exactly one entitlement", async () => {
      const a = await user(pool);
      await passQuiz(pool, a);
      await save(a, at(0));
      await save(a, at(1));
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => codeOf(concept(a))),
        ...Array.from({ length: 4 }, () => codeOf(save(a, at(2)))),
        ...Array.from({ length: 2 }, () => codeOf(progress(a))),
      ]);
      expect(results.every((r) => r === "ok")).toBe(true);
      expect((await entitlements(a)).rows).toHaveLength(1);
      expect(await evidence(a)).toEqual(["PASSPORT"]);
    });

    it("US-04 + US-05: passport first, then the spending threshold: one entitlement, the spend recorded as evidence", async () => {
      const a = await user(pool);
      await completePassport(pool, a, items.slice(0, 3));
      const receipt = await spendTo(pool, a, 50n * 100_000n * RUPEE); // ₹50 lakh: below ₹1 crore
      expect(receipt.creatorUnlocked).toBe(false); // already unlocked
      expect((await entitlements(a)).rows).toEqual([
        { source: "ACHIEVEMENT", rule_version: "passport_v1", evidence_order_group_id: null },
      ]);
      expect(await evidence(a)).toEqual(["PASSPORT", "SPEND"]);
      const access = await creatorAccess(pool, { authSessionId: a.authSessionId });
      expect(access.routes.spend).toMatchObject({ reached: true, balancePaise: 50n * 100_000n * RUPEE });
      // a later purchase below the threshold records nothing more
      const small = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      await payFor(pool, a, await checkout(pool, a, [small], standard("SEED")));
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.creator_route_evidence WHERE user_id = $1", [
          a.userId,
        ]),
      ).toBe(2);
    });

    it("US-04 + US-05: spending threshold first, then the passport: one entitlement, the passport recorded as evidence", async () => {
      const a = await user(pool);
      const receipt = await spendTo(pool, a, 50n * 100_000n * RUPEE);
      expect(receipt.creatorUnlocked).toBe(true);
      expect(await evidence(a)).toEqual(["SPEND"]);
      await completePassport(pool, a, items.slice(0, 3));
      const rows = (await entitlements(a)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("PURCHASE_THRESHOLD");
      expect(await evidence(a)).toEqual(["PASSPORT", "SPEND"]);
      expect((await progress(a)).completedAt).toBeInstanceOf(Date);
      const access = await creatorAccess(pool, { authSessionId: a.authSessionId });
      expect(access).toMatchObject({
        unlocked: true,
        source: "PURCHASE_THRESHOLD",
        routes: { spend: { reached: true } },
      });
    });

    it("US-04: a purchase that stays above the threshold records no evidence", async () => {
      const a = await user(pool);
      const small = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      await payFor(pool, a, await checkout(pool, a, [small], standard("SEED")));
      expect(await evidence(a)).toEqual([]);
    });

    describe("structural rules (second line), for any writer", () => {
      it("an ACHIEVEMENT entitlement needs a completed passport", async () => {
        const a = await user(pool);
        await passQuiz(pool, a);
        const insert = (c: pg.PoolClient) =>
          c.query(
            "INSERT INTO core.creator_entitlement (id, user_id, source, rule_version) VALUES ($1, $2, 'ACHIEVEMENT', 'passport_v1')",
            [uuidv7(), a.userId],
          );
        expect(await commitError(pool, rawAs(a), insert)).toMatch(/completed passport/);
        expect(await commitError(pool, {}, insert)).toMatch(/completed passport/); // the owner too
        expect(await commitError(pool, web(a), insert)).toMatch(/permission denied/);
        expect(await commitError(pool, payAs(a), insert)).toMatch(/permission denied/);
      });

      it("route evidence only for a route really reached, next to an entitlement", async () => {
        const a = await user(pool);
        const passport = (c: pg.PoolClient) =>
          c.query(
            "INSERT INTO core.creator_route_evidence (user_id, route, rule_version) VALUES ($1, 'PASSPORT', 'passport_v1')",
            [a.userId],
          );
        expect(await commitError(pool, rawAs(a), passport)).toMatch(/no creator entitlement/);
        const rich = await spendTo(pool, a, 50n * CRORE); // ₹50 crore: above the threshold
        const spend = (c: pg.PoolClient) =>
          c.query(
            "INSERT INTO core.creator_route_evidence (user_id, route, evidence_order_group_id) VALUES ($1, 'SPEND', $2)",
            [a.userId, rich.orderGroupId],
          );
        expect(await commitError(pool, rawAs(a), spend)).toMatch(/no creator entitlement/);
        expect(await commitError(pool, web(a), spend)).toMatch(/permission denied/);
      });

      it("a completed passport step is never undone, and evidence never changes or goes", async () => {
        const a = await user(pool);
        await completePassport(pool, a, items.slice(0, 3));
        for (const col of ["quiz_passed_at", "saves_completed_at", "concept_submitted_at", "completed_at"]) {
          expect(
            await commitError(pool, rawAs(a), (c) =>
              c.query(`UPDATE core.passport_progress SET ${col} = NULL WHERE user_id = $1`, [a.userId]),
            ),
          ).toMatch(/never undone/);
        }
        expect(
          await commitError(pool, {}, (c) =>
            c.query("DELETE FROM core.creator_route_evidence WHERE user_id = $1", [a.userId]),
          ),
        ).toMatch(/never deleted/);
        expect(
          await commitError(pool, {}, (c) =>
            c.query("UPDATE core.creator_route_evidence SET recorded_at = now() WHERE user_id = $1", [
              a.userId,
            ]),
          ),
        ).toMatch(/never changes/);
      });

      it("no application role writes or reads the new tables directly", async () => {
        const a = await user(pool);
        for (const role of ["app_web", "app_pay", "app_jobs"]) {
          for (const t of [
            "core.product_save",
            "core.passport_progress",
            "private.invention_concept",
            "core.creator_route_evidence",
          ]) {
            const { rows } = await pool.query<{ any: boolean }>(
              `SELECT has_table_privilege($1, $2, 'SELECT') OR has_table_privilege($1, $2, 'INSERT')
                   OR has_table_privilege($1, $2, 'UPDATE') OR has_table_privilege($1, $2, 'DELETE') AS any`,
              [role, t],
            );
            expect(rows[0]?.any, `${role} ${t}`).toBe(false);
          }
        }
        expect(
          await stateOf(pool, "UPDATE core.passport_progress SET quiz_passed_at = now()", [], web(a)),
        ).toBe("42501");
      });
    });
  });
});
