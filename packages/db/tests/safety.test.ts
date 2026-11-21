import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogProduct, storeProducts } from "../src/catalog";
import { createCheckoutSession, PayFailure } from "../src/checkout";
import {
  createDraft,
  hideListing,
  moderationQueue,
  myProduct,
  restoreListing,
  submitProduct,
} from "../src/listing";
import {
  adminReports,
  blockStore,
  createAppeal,
  createReport,
  myAppeals,
  myBlocks,
  myReports,
  resolveAppeal,
  resolveReportCase,
  unblockStore,
} from "../src/safety";
import {
  CLEAN,
  checkout,
  codeOf,
  count,
  key,
  merchantCoupon,
  payFor,
  reconcile,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  createProfile,
  createTestDatabase,
  plant,
  sessionFor,
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

const REASON = "Reviewed the reports and the listing.";
const STATEMENT = "This lamp is a fictional product and breaks no rule; please look again.";
const REFERENCE = /^R-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

/** Reports, the automatic hide, report cases, appeals and blocks (migrations 0039, 0040). */
describe("trust and safety", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;
  let c: Creator;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    const items = await published(pool, 3);
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
    c = await creator(pool, items);
  }, 120_000);
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });
  /**
   * A player whose account was created `hours` ago (written as the owner, like the auth service would
   * date it). The default, eight days, makes the reporter established (sixth review, 0044: at least
   * seven days old or a completed purchase) as well as older than the 24-hour minimum.
   */
  const aged = async (hours = 8 * 24): Promise<TestUser> => {
    const u = await user(pool);
    await pool.query(
      "UPDATE core.user_profile SET created_at = now() - make_interval(hours => $2) WHERE id = $1",
      [u.userId, hours],
    );
    return u;
  };
  const report = (u: TestUser, productId: string, reason = "SCAM_OR_PAYMENT", detail?: string) =>
    createReport(pool, {
      ...as(u),
      targetType: "PRODUCT",
      targetId: productId,
      reason,
      detail: detail ?? null,
    });
  const status = async (productId: string) =>
    (await pool.query<{ status: string }>("SELECT status FROM core.product WHERE id = $1", [productId]))
      .rows[0]?.status;
  const audit = (action: string, target: string) =>
    count(pool, "SELECT count(*) AS n FROM audit.audit_log WHERE action = $1 AND target_id = $2", [
      action,
      target,
    ]);

  // ------------------------------------------------------------------ reports
  describe("reports", () => {
    beforeAll(async () => {
      c = await creator(pool, await published(pool, 3));
    });

    it("§7.7: any onboarded user reports a published product or a store and gets an unguessable case reference", async () => {
      const l = await publishListing(pool, c);
      const r = await aged();
      const receipt = await report(r, l.productId, "COPYRIGHT", "  Looks copied from somewhere.  ");
      expect(receipt.reference).toMatch(REFERENCE);
      const store = await createReport(pool, {
        ...as(r),
        targetType: "STORE",
        targetId: c.companyId,
        reason: "SCAM_OR_PAYMENT",
      });
      expect(store.reference).toMatch(REFERENCE);
      expect(store.reference).not.toBe(receipt.reference);
      // the detail is stored as given (trimmed), the reporter's own list shows status only
      const { rows } = await pool.query<{ detail: string }>(
        "SELECT detail FROM core.report WHERE reference = $1",
        [receipt.reference],
      );
      expect(rows[0]?.detail).toBe("Looks copied from somewhere.");
      const mine = await myReports(pool, as(r));
      expect(mine.map((m) => m.reference).sort()).toEqual([receipt.reference, store.reference].sort());
      expect(Object.keys(mine[0] ?? {}).sort()).toEqual(
        ["createdAt", "reason", "reference", "resolvedAt", "status", "targetId", "targetType"].sort(),
      );
      expect(mine.every((m) => m.status === "OPEN")).toBe(true);
      // another user sees none of them
      expect(await myReports(pool, as(await user(pool)))).toEqual([]);
    });

    it("§7.7: not onboarded, own listing, a draft, a seed or missing target, bad reason or detail are refused", async () => {
      const l = await publishListing(pool, c);
      const draft = await createDraft(pool, { ...as(c.u), draft: draftInput() });
      const r = await user(pool);
      const bare = await createProfile(pool);
      const bareSession = await sessionFor(pool, bare);
      const seed = (await published(pool, 1))[0];
      expect(
        await codeOf(
          createReport(pool, {
            authSessionId: bareSession,
            targetType: "PRODUCT",
            targetId: l.productId,
            reason: "OTHER",
          }),
        ),
      ).toBe("ONBOARDING_REQUIRED");
      expect(await codeOf(report(c.u, l.productId))).toBe("VALIDATION_FAILED");
      expect(
        await codeOf(
          createReport(pool, { ...as(c.u), targetType: "STORE", targetId: c.companyId, reason: "OTHER" }),
        ),
      ).toBe("VALIDATION_FAILED");
      expect(await codeOf(report(r, draft.productId))).toBe("NOT_FOUND");
      expect(await codeOf(report(r, seed?.id ?? ""))).toBe("NOT_FOUND");
      expect(await codeOf(report(r, uuidv7()))).toBe("NOT_FOUND");
      expect(await codeOf(report(r, l.productId, "BORING"))).toBe("VALIDATION_FAILED");
      expect(await codeOf(report(r, l.productId, "OTHER", "x".repeat(501)))).toBe("VALIDATION_FAILED");
      expect(await codeOf(report(r, l.productId, "OTHER", "bell\u0007"))).toBe("VALIDATION_FAILED");
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.report WHERE reporter_user_id = $1", [r.userId]),
      ).toBe(0);
    });

    it("§11.2: one open report per reporter per target, and five reports per account per hour (committed rows)", async () => {
      const targets = [];
      for (let i = 0; i < 5; i++) targets.push((await publishListing(pool, c)).productId);
      const r = await user(pool);
      expect(await codeOf(report(r, targets[0] ?? ""))).toBe("ok");
      expect(await codeOf(report(r, targets[0] ?? "", "HATE"))).toBe("ALREADY_REPORTED");
      for (const t of targets.slice(1)) expect(await codeOf(report(r, t))).toBe("ok");
      // the sixth within the hour is refused, whatever the target
      const store = () =>
        createReport(pool, { ...as(r), targetType: "STORE", targetId: c.companyId, reason: "OTHER" });
      expect(await codeOf(store())).toBe("REPORT_LIMIT");
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.report WHERE reporter_user_id = $1", [r.userId]),
      ).toBe(5);
      // the limit is counted on the committed reports of the last hour: once they are older, it is free
      // again (planted: a report never changes)
      await plant(pool, (x) =>
        x.query(
          "UPDATE core.report SET created_at = created_at - interval '61 minutes' WHERE reporter_user_id = $1",
          [r.userId],
        ),
      );
      expect(await codeOf(store())).toBe("ok");
    });
  });

  // ------------------------------------------------------------------ the automatic hide
  describe("the automatic hide at three independent reports", () => {
    beforeAll(async () => {
      c = await creator(pool, await published(pool, 3));
    });

    it("§7.7: two reporters, a young account and the owner do not hide; the third qualifying reporter does, at once", async () => {
      const l = await publishListing(pool, c);
      const [r1, r2, r4] = [await aged(), await aged(), await aged(24)];
      // r4 is exactly 24 hours old: established by a completed purchase (sixth review, 0044)
      const [seed] = await published(pool, 1);
      if (!seed) throw new Error("no seed");
      await payFor(pool, r4, await checkout(pool, r4, [seed], { SEED: "STANDARD" }));
      const young = await aged(23);
      await report(r1, l.productId);
      await report(r2, l.productId, "HATE");
      expect(await status(l.productId)).toBe("PUBLISHED");
      await report(young, l.productId);
      expect(await status(l.productId)).toBe("PUBLISHED");
      expect(await catalogProduct(pool, l.productId)).not.toBeNull();
      const outboxBefore = await count(
        pool,
        "SELECT count(*) AS n FROM audit.outbox WHERE type = 'listing_hidden' AND aggregate_id = $1",
        [l.productId],
      );
      await report(r4, l.productId);
      expect(await status(l.productId)).toBe("HIDDEN");
      expect(await catalogProduct(pool, l.productId)).toBeNull();
      expect((await storeProducts(pool, { handle: c.handle })).items.map((p) => p.productId)).not.toContain(
        l.productId,
      );
      // the owner sees the neutral reason; a SYSTEM audit row and one outbox event (ids only)
      const mine = await myProduct(pool, { ...as(c.u), productId: l.productId });
      expect(mine).toMatchObject({
        status: "HIDDEN",
        moderationReason: "Hidden pending review",
        appealable: true,
      });
      const { rows } = await pool.query<{
        actor_kind: string;
        actor_id: string | null;
        detail: Record<string, unknown>;
      }>(
        "SELECT actor_kind, actor_id, detail FROM audit.audit_log WHERE action = 'listing.auto_hide' AND target_id = $1",
        [l.productId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_kind: "SYSTEM",
        actor_id: null,
        detail: { qualifyingReporters: 3 },
      });
      const events = await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM audit.outbox WHERE type = 'listing_hidden' AND aggregate_id = $1",
        [l.productId],
      );
      expect(events.rows).toHaveLength(outboxBefore + 1);
      const text = JSON.stringify(events.rows) + JSON.stringify(rows);
      for (const u of [r1, r2, r4, young]) expect(text).not.toContain(u.userId);
    });

    it("§7.7: a report by the company's own side never counts (planted: the command refuses the owner)", async () => {
      const l = await publishListing(pool, c);
      const [r1, r2] = [await aged(), await aged()];
      await report(r1, l.productId);
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM core.report_case WHERE product_id = $1 AND status = 'OPEN'",
        [l.productId],
      );
      await pool.query("UPDATE core.user_profile SET created_at = now() - interval '9 days' WHERE id = $1", [
        c.u.userId,
      ]);
      await plant(pool, (x) =>
        x.query(
          `INSERT INTO core.report (id, reference, case_id, reporter_user_id, reason, reporter_aged,
                                    reporter_established, reporter_in_standing)
           VALUES ($1, $2, $3, $4, 'OTHER', true, true, true)`,
          [uuidv7(), "R-WNERPLANTZ", rows[0]?.id, c.u.userId],
        ),
      );
      await report(r2, l.productId);
      expect(await status(l.productId)).toBe("PUBLISHED");
      expect(
        (await pool.query<{ n: number }>("SELECT core.report_qualifying_count($1) AS n", [rows[0]?.id]))
          .rows[0]?.n,
      ).toBe(2);
    });

    it("§7.7: reporter identity is unreadable by the owner and by every application role", async () => {
      const l = await publishListing(pool, c);
      const r1 = await aged();
      await report(r1, l.productId, "OTHER", "secret detail for staff");
      for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        for (const t of [
          "core.report",
          "core.report_case",
          "core.listing_hide",
          "core.appeal",
          "core.store_block",
        ]) {
          expect(
            await stateOf(pool, `SELECT * FROM ${t}`, [], { role, userId: c.u.userId }),
            `${role} ${t}`,
          ).toBe("42501");
        }
      }
      const mine = JSON.stringify(await myProduct(pool, { ...as(c.u), productId: l.productId }), (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      expect(mine).not.toContain(r1.userId);
      expect(mine).not.toContain("secret detail");
      // the reporter's own report list does not name anyone else either
      expect(JSON.stringify(await myReports(pool, as(r1)))).not.toContain(c.u.userId);
      // the owner cannot use the admin read
      expect(await codeOf(adminReports(pool, as(c.u)))).toBe("FORBIDDEN");
    });
  });

  // ------------------------------------------------------------------ Super Admin
  describe("report cases (Super Admin)", () => {
    beforeAll(async () => {
      c = await creator(pool, await published(pool, 3));
    });

    it("§7.7: open cases show the target, reason counts and reporters only as per-case numbers", async () => {
      const l = await publishListing(pool, c);
      const [r1, r2] = [await aged(), await user(pool)];
      await report(r1, l.productId, "HATE", "rude words");
      await report(r2, l.productId, "HATE");
      const page = await adminReports(pool, { ...as(admin), pageSize: 50 });
      const item = page.items.find(
        (i) => (i.target as { productId?: string } | null)?.productId === l.productId,
      );
      expect(item).toMatchObject({
        targetType: "PRODUCT",
        status: "OPEN",
        autoHidden: false,
        reasonCounts: { HATE: 2 },
        reporterCount: 2,
        qualifyingReporterCount: 1,
      });
      expect(item?.reports.map((x) => x.reporter)).toEqual([1, 2]);
      expect(item?.reports[0]?.detail).toBe("rude words");
      const text = JSON.stringify(page);
      for (const u of [r1, r2]) expect(text).not.toContain(u.userId);
    });

    it("§7.7: non-admins get the same FORBIDDEN whether or not the case exists; nothing is written", async () => {
      const l = await publishListing(pool, c);
      await report(await aged(), l.productId);
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM core.report_case WHERE product_id = $1",
        [l.productId],
      );
      const before = await count(pool, "SELECT count(*) AS n FROM audit.audit_log");
      for (const id of [rows[0]?.id ?? "", uuidv7()]) {
        expect(
          await codeOf(
            resolveReportCase(pool, { ...as(c.u), caseId: id, outcome: "DISMISSED", reason: REASON }),
          ),
        ).toBe("FORBIDDEN");
      }
      expect(await count(pool, "SELECT count(*) AS n FROM audit.audit_log")).toBe(before);
      expect(
        await codeOf(
          resolveReportCase(pool, { ...as(admin), caseId: uuidv7(), outcome: "DISMISSED", reason: REASON }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("§7.7: DISMISSED restores a product the case hid; UPHELD hides a published one; both audited, once", async () => {
      const hidden = await publishListing(pool, c);
      for (let i = 0; i < 3; i++) await report(await aged(), hidden.productId);
      expect(await status(hidden.productId)).toBe("HIDDEN");
      const caseOf = async (productId: string) =>
        (
          await pool.query<{ id: string }>(
            "SELECT id FROM core.report_case WHERE product_id = $1 ORDER BY opened_at DESC",
            [productId],
          )
        ).rows[0]?.id ?? "";
      const dismissed = await resolveReportCase(pool, {
        ...as(admin),
        caseId: await caseOf(hidden.productId),
        outcome: "DISMISSED",
        reason: REASON,
      });
      expect(dismissed).toMatchObject({
        outcome: "DISMISSED",
        effect: "RESTORED",
        productStatus: "PUBLISHED",
      });
      expect(await catalogProduct(pool, hidden.productId)).not.toBeNull();
      expect(await audit("report.dismiss", await caseOf(hidden.productId))).toBe(1);
      expect(
        await codeOf(
          resolveReportCase(pool, {
            ...as(admin),
            caseId: await caseOf(hidden.productId),
            outcome: "UPHELD",
            reason: REASON,
          }),
        ),
      ).toBe("CONFLICT");
      // a resolved case frees the reporters to report again (a new case)
      const again = await aged();
      expect(await codeOf(report(again, hidden.productId))).toBe("ok");

      const live = await publishListing(pool, c);
      await report(await aged(), live.productId);
      const upheld = await resolveReportCase(pool, {
        ...as(admin),
        caseId: await caseOf(live.productId),
        outcome: "UPHELD",
        reason: REASON,
      });
      expect(upheld).toMatchObject({ effect: "HIDDEN", productStatus: "HIDDEN" });
      expect(await audit("report.uphold", await caseOf(live.productId))).toBe(1);
      expect((await myProduct(pool, { ...as(c.u), productId: live.productId })).moderationReason).toBe(
        REASON,
      );
      expect(
        await codeOf(
          resolveReportCase(pool, {
            ...as(admin),
            caseId: await caseOf(live.productId),
            outcome: "MAYBE" as "UPHELD",
            reason: REASON,
          }),
        ),
      ).toBe("VALIDATION_FAILED");
    });

    it("§7.7: DISMISSED while publication is paused still restores an auto-hidden product (sixth review: the switch stops only automatic publication)", async () => {
      const l = await publishListing(pool, c);
      for (let i = 0; i < 3; i++) await report(await aged(), l.productId);
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM core.report_case WHERE product_id = $1",
        [l.productId],
      );
      await pool.query("UPDATE core.system_switch SET enabled = false WHERE name = 'publication'");
      try {
        expect(
          await resolveReportCase(pool, {
            ...as(admin),
            caseId: rows[0]?.id ?? "",
            outcome: "DISMISSED",
            reason: REASON,
          }),
        ).toMatchObject({ effect: "RESTORED", productStatus: "PUBLISHED" });
        expect(await status(l.productId)).toBe("PUBLISHED");
      } finally {
        await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = 'publication'");
      }
    });
  });

  // ------------------------------------------------------------------ appeals
  describe("appeals", () => {
    beforeAll(async () => {
      c = await creator(pool, await published(pool, 3));
    });

    it("§7.7: a hidden listing is appealed once; UPHELD restores it with its stock and orders intact", async () => {
      const l = await publishListing(pool, c, { quantity: 3 });
      const buyer = await user(pool);
      await payFor(pool, buyer, await checkout(pool, buyer, [asFixture(l)], { [c.companyId]: "STANDARD" }));
      for (let i = 0; i < 3; i++) await report(await aged(), l.productId);
      expect(await status(l.productId)).toBe("HIDDEN");
      const before = await myProduct(pool, { ...as(c.u), productId: l.productId });
      const orders = await count(pool, "SELECT count(*) AS n FROM core.seller_order WHERE company_id = $1", [
        c.companyId,
      ]);

      expect(
        await codeOf(createAppeal(pool, { ...as(c.u), productId: l.productId, statement: "too short" })),
      ).toBe("VALIDATION_FAILED");
      const other = await user(pool);
      expect(
        await codeOf(createAppeal(pool, { ...as(other), productId: l.productId, statement: STATEMENT })),
      ).toBe("CREATOR_LOCKED");
      const appeal = await createAppeal(pool, { ...as(c.u), productId: l.productId, statement: STATEMENT });
      expect(appeal).toMatchObject({ kind: "HIDE", status: "OPEN", productId: l.productId });
      expect(
        await codeOf(createAppeal(pool, { ...as(c.u), productId: l.productId, statement: STATEMENT })),
      ).toBe("APPEAL_EXISTS");
      expect((await myAppeals(pool, as(c.u))).map((a) => a.appealId)).toContain(appeal.appealId);
      const detail = await myProduct(pool, { ...as(c.u), productId: l.productId });
      expect(detail.appeal).toMatchObject({ appealId: appeal.appealId, status: "OPEN" });
      expect(detail.appealable).toBe(false);

      // the Super Admin sees it in the queue with the original decision and the evidence
      const queue = await moderationQueue(pool, as(admin));
      const item = queue.appeals.find((a) => a.appealId === appeal.appealId);
      expect(item).toMatchObject({
        kind: "HIDE",
        statement: STATEMENT,
        productStatus: "HIDDEN",
        decision: { action: "HIDDEN", reason: "Hidden pending review", by: "REPORTS" },
        evidence: { reports: { reasonCounts: { SCAM_OR_PAYMENT: 3 }, reporterCount: 3 } },
      });
      expect(
        await codeOf(
          resolveAppeal(pool, { ...as(c.u), appealId: appeal.appealId, outcome: "UPHELD", reason: REASON }),
        ),
      ).toBe("FORBIDDEN");

      const decided = await resolveAppeal(pool, {
        ...as(admin),
        appealId: appeal.appealId,
        outcome: "UPHELD",
        reason: REASON,
      });
      expect(decided).toMatchObject({ outcome: "UPHELD", effect: "RESTORED", productStatus: "PUBLISHED" });
      const after = await myProduct(pool, { ...as(c.u), productId: l.productId });
      expect(after.stock).toEqual(before.stock);
      expect(after.moderationReason).toBeNull();
      expect(after.appeal).toMatchObject({ status: "UPHELD", decisionReason: REASON });
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.seller_order WHERE company_id = $1", [c.companyId]),
      ).toBe(orders);
      expect(await catalogProduct(pool, l.productId)).not.toBeNull();
      expect(await audit("appeal.uphold", appeal.appealId)).toBe(1);
      // the reports behind the hide are answered: the case is closed
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM core.report_case WHERE product_id = $1 AND status = 'OPEN'",
          [l.productId],
        ),
      ).toBe(0);
      expect(
        await codeOf(
          resolveAppeal(pool, { ...as(admin), appealId: appeal.appealId, outcome: "DENIED", reason: REASON }),
        ),
      ).toBe("CONFLICT");
      // a new hide is a new moderation action: it may be appealed again
      await hideListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      expect(
        await codeOf(createAppeal(pool, { ...as(c.u), productId: l.productId, statement: STATEMENT })),
      ).toBe("ok");
    });

    it("§7.7: a rejected listing is appealed once; UPHELD returns it to DRAFT, DENIED leaves it rejected", async () => {
      const make = async () => {
        const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
        await submitProduct(pool, { ...as(c.u), productId: d.productId });
        await screen(pool, d.productId, "REJECT");
        return d.productId;
      };
      const [up, down] = [await make(), await make()];
      expect(await status(up)).toBe("REJECTED");
      const a1 = await createAppeal(pool, { ...as(c.u), productId: up, statement: STATEMENT });
      const a2 = await createAppeal(pool, { ...as(c.u), productId: down, statement: STATEMENT });
      expect(a1.kind).toBe("REJECTION");
      expect(await codeOf(createAppeal(pool, { ...as(c.u), productId: up, statement: STATEMENT }))).toBe(
        "APPEAL_EXISTS",
      );
      const queued = (await moderationQueue(pool, as(admin))).appeals.find((a) => a.appealId === a1.appealId);
      expect(queued?.decision).toMatchObject({ action: "REJECTED", by: "SCREENING" });
      expect(
        await resolveAppeal(pool, { ...as(admin), appealId: a1.appealId, outcome: "UPHELD", reason: REASON }),
      ).toMatchObject({
        effect: "RETURNED_TO_DRAFT",
        productStatus: "DRAFT",
      });
      expect(
        await resolveAppeal(pool, { ...as(admin), appealId: a2.appealId, outcome: "DENIED", reason: REASON }),
      ).toMatchObject({
        effect: "NONE",
        productStatus: "REJECTED",
      });
      expect(await audit("appeal.deny", a2.appealId)).toBe(1);
      // a second appeal of the same rejection stays refused after the decision
      expect(await codeOf(createAppeal(pool, { ...as(c.u), productId: down, statement: STATEMENT }))).toBe(
        "APPEAL_EXISTS",
      );
      // resubmission works for the upheld one
      expect(await codeOf(submitProduct(pool, { ...as(c.u), productId: up }))).toBe("ok");
    });

    it("§7.7: a published or draft listing is NOT_APPEALABLE; another company's is NOT_FOUND", async () => {
      const l = await publishListing(pool, c);
      const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
      expect(
        await codeOf(createAppeal(pool, { ...as(c.u), productId: l.productId, statement: STATEMENT })),
      ).toBe("NOT_APPEALABLE");
      expect(
        await codeOf(createAppeal(pool, { ...as(c.u), productId: d.productId, statement: STATEMENT })),
      ).toBe("NOT_APPEALABLE");
      const c2 = await creator(pool, await published(pool, 3));
      await hideListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      expect(
        await codeOf(createAppeal(pool, { ...as(c2.u), productId: l.productId, statement: STATEMENT })),
      ).toBe("NOT_FOUND");
      await restoreListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      expect(await myAppeals(pool, as(c2.u))).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ blocks
  describe("blocks", () => {
    it("§7.7: a block refuses purchases both ways at checkout and at pay, invisibly to the blocked store", async () => {
      const s = await creator(pool, await published(pool, 3)); // the store that gets blocked
      const b = await creator(pool, await published(pool, 3)); // the blocker, who also owns a store
      const sProduct = asFixture(await publishListing(pool, s, { quantity: 3 }));
      const bProduct = asFixture(await publishListing(pool, b, { quantity: 3 }));
      const toS = { [s.companyId]: "STANDARD" as const };
      const toB = { [b.companyId]: "STANDARD" as const };
      // sessions quoted before the block
      const early1 = await checkout(pool, b.u, [sProduct], toS);
      const early2 = await checkout(pool, s.u, [bProduct], toB);

      expect(await codeOf(blockStore(pool, { ...as(b.u), companyId: b.companyId }))).toBe(
        "VALIDATION_FAILED",
      );
      expect(await codeOf(blockStore(pool, { ...as(b.u), companyId: uuidv7() }))).toBe("NOT_FOUND");
      await blockStore(pool, { ...as(b.u), companyId: s.companyId });
      await blockStore(pool, { ...as(b.u), companyId: s.companyId }); // idempotent
      expect((await myBlocks(pool, as(b.u))).map((x) => x.companyId)).toEqual([s.companyId]);
      // invisible to the other party
      expect(await myBlocks(pool, as(s.u))).toEqual([]);

      const quote = (buyer: TestUser, p: typeof sProduct, speeds: Record<string, "STANDARD">) =>
        createCheckoutSession(pool, {
          authSessionId: buyer.authSessionId,
          lines: [{ productId: p.id }],
          speedBySeller: speeds,
          idempotencyKey: key(),
        });
      expect(await codeOf(quote(b.u, sProduct, toS))).toBe("PRODUCT_UNAVAILABLE");
      expect(await codeOf(quote(s.u, bProduct, toB))).toBe("PRODUCT_UNAVAILABLE");

      const walletsBefore = [
        await wallet(pool, b.u.ledgerAccountId),
        await wallet(pool, s.u.ledgerAccountId),
      ];
      for (const [buyer, co] of [
        [b.u, early1],
        [s.u, early2],
      ] as const) {
        const failure = await payFor(pool, buyer, co).then(
          () => null,
          (e: unknown) => e,
        );
        expect(failure).toBeInstanceOf(PayFailure);
        expect((failure as PayFailure).code).toBe("PRODUCT_UNAVAILABLE");
      }
      expect([await wallet(pool, b.u.ledgerAccountId), await wallet(pool, s.u.ledgerAccountId)]).toEqual(
        walletsBefore,
      );

      // others still buy; after unblocking, the blocker buys again
      const third = await user(pool);
      expect(await codeOf(payFor(pool, third, await checkout(pool, third, [sProduct], toS)))).toBe("ok");
      await unblockStore(pool, { ...as(b.u), companyId: s.companyId });
      expect(await myBlocks(pool, as(b.u))).toEqual([]);
      expect(await codeOf(payFor(pool, b.u, await checkout(pool, b.u, [sProduct], toS)))).toBe("ok");
    });

    it("US-41: an account on either side of a block cannot redeem the store's coupon", async () => {
      const s = await creator(pool, await published(pool, 3));
      const p = asFixture(await publishListing(pool, s, { quantity: 2 }));
      const coupon = await merchantCoupon(
        pool,
        { owner: s.u, companyId: s.companyId, warehouseId: s.warehouseId },
        {
          percent: 10,
          publicCode: "BLOCKED10",
        },
      );
      const blocker = await user(pool);
      await blockStore(pool, { ...as(blocker), companyId: s.companyId });
      const refused = createCheckoutSession(pool, {
        authSessionId: blocker.authSessionId,
        lines: [{ productId: p.id }],
        speedBySeller: { [s.companyId]: "STANDARD" },
        couponCode: coupon.code,
        idempotencyKey: key(),
      });
      expect(await codeOf(refused)).toBe("PRODUCT_UNAVAILABLE");
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.coupon_redemption WHERE coupon_id = $1", [
          coupon.id,
        ]),
      ).toBe(0);
    });

    it("the seller order trigger refuses a blocked purchase for every writer", async () => {
      const s = await creator(pool, await published(pool, 3));
      const blocker = await user(pool);
      await blockStore(pool, { ...as(blocker), companyId: s.companyId });
      const { rows } = await pool.query<{ blocked: boolean }>(
        "SELECT core.purchase_blocked($1, $2) AS blocked",
        [blocker.userId, s.companyId],
      );
      expect(rows[0]?.blocked).toBe(true);
      const state = await stateOf(
        pool,
        `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise, fee_paise, net_paise)
         VALUES ($1, $2, $3, $4, 'USER', 10000, 500, 9500)`,
        [uuidv7(), uuidv7(), blocker.userId, s.companyId],
      );
      expect(state).toBe("DM001");
    });
  });
});
