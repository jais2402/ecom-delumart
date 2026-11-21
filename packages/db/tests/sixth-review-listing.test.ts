import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogProduct } from "../src/catalog";
import { moderationSafetyNet } from "../src/jobs";
import {
  adminStatus,
  createDraft,
  decideListing,
  deleteDraft,
  hideListing,
  restoreListing,
  setSystemSwitch,
  submitProduct,
} from "../src/listing";
import { CLEAN, codeOf, count, reconcile, user } from "./checkout-fixtures";
import { createTestDatabase, stateOf, type TestDatabase, type TestUser } from "./helpers";
import {
  type Creator,
  creator,
  draftInput,
  ensureCategories,
  publishListing,
  screen,
} from "./listing-fixtures";
import { published } from "./selling-fixtures";

const REASON = "Looks fine after a closer read.";

/** Sixth security review: the submission cap (major 2, 0045) and the moderation safety net (major 4, 0046). */
describe("sixth security review: listing submissions", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: Awaited<ReturnType<typeof published>>;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    items = await published(pool, 3);
  }, 120_000);
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
    await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = 'publication'");
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });

  it("major 2 (US-08): create, submit, get rejected, delete, repeat — the eleventh submission that UTC day is refused", async () => {
    const c: Creator = await creator(pool, items);
    for (let i = 0; i < 10; i++) {
      const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
      await submitProduct(pool, { ...as(c.u), productId: d.productId });
      expect(await screen(pool, d.productId, "REJECT")).toMatchObject({ outcome: "REJECTED" });
      await deleteDraft(pool, { ...as(c.u), productId: d.productId });
    }
    // every draft and its submissions are gone ...
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.listing_submission WHERE company_id = $1", [
        c.companyId,
      ]),
    ).toBe(0);
    // ... but the day's submissions are still counted
    const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
    expect(await codeOf(submitProduct(pool, { ...as(c.u), productId: d.productId }))).toBe(
      "SUBMISSION_LIMIT",
    );
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.listing_submission_log WHERE company_id = $1", [
        c.companyId,
      ]),
    ).toBe(10);
    // another store has its own budget
    const other = await creator(pool, items);
    const o = await createDraft(pool, { ...as(other.u), draft: draftInput() });
    expect(await codeOf(submitProduct(pool, { ...as(other.u), productId: o.productId }))).toBe("ok");
  });

  it("major 2: the submission log is append-only and readable or writable by no application role", async () => {
    const c = await creator(pool, items);
    const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
    await submitProduct(pool, { ...as(c.u), productId: d.productId });
    // the owner itself cannot delete or change an entry
    expect(
      await stateOf(pool, "DELETE FROM core.listing_submission_log WHERE company_id = $1", [c.companyId]),
    ).toBe("23001");
    expect(
      await stateOf(pool, "UPDATE core.listing_submission_log SET submitted_at = now() - interval '2 days'"),
    ).toBe("23514");
    expect(await stateOf(pool, "TRUNCATE core.listing_submission_log")).toBe("23001");
    for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      for (const sql of [
        "SELECT * FROM core.listing_submission_log",
        "DELETE FROM core.listing_submission_log",
      ]) {
        expect(await stateOf(pool, sql, [], { role, userId: c.u.userId }), `${role}: ${sql}`).toBe("42501");
      }
    }
  });

  // ------------------------------------------------------------------ major 4
  describe("major 4: the safety net and the publication switch", () => {
    let admin: TestUser;
    beforeAll(async () => {
      admin = await user(pool);
      await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
    });
    const publication = async () =>
      (
        await pool.query<{ enabled: boolean }>(
          "SELECT enabled FROM core.system_switch WHERE name = 'publication'",
        )
      ).rows[0]?.enabled;
    /** A listing held for review by screening. */
    async function inReview(c: Creator) {
      const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
      await submitProduct(pool, { ...as(c.u), productId: d.productId });
      expect(await screen(pool, d.productId, "NEEDS_REVIEW")).toMatchObject({ outcome: "NEEDS_REVIEW" });
      return { productId: d.productId, versionId: d.current?.versionId ?? "" };
    }
    const overdueRows = () =>
      count(
        pool,
        "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'moderation.overdue' AND actor_kind = 'SYSTEM'",
      );

    it("one overdue listing never switches publication off; it is recorded once per UTC day and other listings keep publishing", async () => {
      const c = await creator(pool, items);
      const l = await inReview(c);
      const before = await overdueRows();
      // not yet overdue
      expect(await moderationSafetyNet(pool)).toMatchObject({ audited: false });
      await pool.query(
        "UPDATE core.listing_submission SET submitted_at = now() - interval '49 hours' WHERE product_id = $1",
        [l.productId],
      );
      const first = await moderationSafetyNet(pool);
      expect(first).toMatchObject({ overdue: true, audited: true });
      expect(first.count).toBeGreaterThanOrEqual(1);
      expect(first.oldestAgeSeconds).toBeGreaterThanOrEqual(49 * 3600);
      expect(await publication()).toBe(true);
      // the same day: no second row, the switch still on
      expect(await moderationSafetyNet(pool)).toMatchObject({ overdue: true, audited: false });
      expect(await overdueRows()).toBe(before + 1);
      const { rows } = await pool.query(
        "SELECT actor_id, actor_kind FROM audit.audit_log WHERE action = 'moderation.overdue' ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]).toEqual({ actor_id: null, actor_kind: "SYSTEM" });
      // another store's listing still publishes automatically; the overdue one stays unpublished
      const other = await publishListing(pool, await creator(pool, items));
      expect(other.status).toBe("PUBLISHED");
      expect(await catalogProduct(pool, l.productId)).toBeNull();
      // the console sees it
      expect((await adminStatus(pool, as(admin))).moderationOverdue.count).toBeGreaterThanOrEqual(1);
      await decideListing(pool, { ...as(admin), ...l, decision: "REJECT", reason: REASON });
    });

    it("while publication is off the Super Admin still approves and restores; only screening is paused", async () => {
      const c = await creator(pool, items);
      const l = await inReview(c);
      const hidden = await publishListing(pool, c);
      await hideListing(pool, { ...as(admin), productId: hidden.productId, reason: REASON });
      await setSystemSwitch(pool, { ...as(admin), name: "publication", enabled: false, reason: REASON });
      expect(
        await decideListing(pool, { ...as(admin), ...l, decision: "APPROVE", reason: REASON }),
      ).toMatchObject({
        outcome: "PUBLISHED",
      });
      expect(await catalogProduct(pool, l.productId)).not.toBeNull();
      expect(
        await restoreListing(pool, { ...as(admin), productId: hidden.productId, reason: REASON }),
      ).toMatchObject({
        outcome: "PUBLISHED",
      });
      // the screening job publishes nothing while the switch is off
      const d = await createDraft(pool, { ...as(c.u), draft: draftInput() });
      await submitProduct(pool, { ...as(c.u), productId: d.productId });
      expect(await screen(pool, d.productId, "OK")).toMatchObject({ outcome: "PAUSED" });
      expect(await catalogProduct(pool, d.productId)).toBeNull();
      expect((await adminStatus(pool, as(admin))).publication.enabled).toBe(false);
    });

    it("admin_status: the switch, overdue counts, open report cases and appeals, for the Super Admin only", async () => {
      const s = await adminStatus(pool, as(admin));
      expect(Object.keys(s).sort()).toEqual(
        // seventh review (0057): screeningStalled reported separately
        [
          "moderationOverdue",
          "needsReview",
          "openAppeals",
          "openReportCases",
          "publication",
          "screeningStalled",
        ].sort(),
      );
      expect(s.publication.enabled).toBe(true);
      expect(s.moderationOverdue.thresholdHours).toBe(48);
      const someone = await user(pool);
      expect(await codeOf(adminStatus(pool, as(someone)))).toBe("FORBIDDEN");
      for (const role of ["app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        expect(
          await stateOf(pool, "SELECT core.admin_status()", [], { role, userId: admin.userId }),
          role,
        ).toBe("42501");
      }
    });
  });
});
