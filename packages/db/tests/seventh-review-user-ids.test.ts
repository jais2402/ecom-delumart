import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveReview } from "../src/review";
import {
  CLEAN,
  checkout,
  merchantCoupon,
  payFor,
  reconcile,
  type Seller,
  standard,
} from "./checkout-fixtures";
import { become, createTestDatabase, inRolledBackTx, plant, type TestDatabase, uuidv7 } from "./helpers";
import { asFixture, type Creator, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

const ROLES = ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"] as const;

/**
 * Columns that hold a user id although their name does not say so and they carry no foreign key
 * (found by reading the schema); the generated test treats them like any `%user_id%` column.
 */
const ALSO_USER_ID_COLUMNS = [
  "analytics.experiment_exposure.subject_id",
  "audit.pending_action.requested_by",
  "core.config_version.created_by",
];

/**
 * `role:schema.table.column` -> why that role may read another person's user id there. Empty: no
 * application role reads anyone's user id but the acting user's own.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

interface Column {
  role: string;
  rel: string;
  col: string;
  relkind: string;
  rls: boolean;
}

/**
 * Seventh security review, blocker 1 (migration 0053): a store must not be linkable to its owner's
 * user id. GENERATED over the catalog: every column of every table or view an application role can
 * read that holds a user id (name like %user_id%, a foreign key to core.user_profile or auth.users,
 * or listed above) is unreadable by that role, or row-level security shows the role only the acting
 * user's own rows (proved with two users who both have rows there), or it is an explained exception.
 */
describe("seventh security review: no application role reads another person's user id", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let a: Creator;
  let b: Creator;
  let listingA = "";

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    const seeds = await published(pool, 3);
    a = await creator(pool, seeds);
    b = await creator(pool, seeds);
    // each publishes a listing, and buys the other's with the other's public coupon
    const la = asFixture(await publishListing(pool, a));
    const lb = asFixture(await publishListing(pool, b));
    listingA = la.id;
    const shop = (c: Creator): Seller => ({ owner: c.u, companyId: c.companyId, warehouseId: c.warehouseId });
    const ca = await merchantCoupon(pool, shop(a), { percent: 10, publicCode: "MOONA10" });
    const cb = await merchantCoupon(pool, shop(b), { percent: 10, publicCode: "MOONB10" });
    await payFor(pool, a.u, await checkout(pool, a.u, [lb], standard(shop(b)), cb.code));
    await payFor(pool, b.u, await checkout(pool, b.u, [la], standard(shop(a)), ca.code));
    // each reviews what they bought (migration 0078): the review tables hold both users' ids
    await saveReview(pool, {
      authSessionId: a.u.authSessionId,
      productId: lb.id,
      rating: 4,
      title: "A",
      body: null,
    });
    await saveReview(pool, {
      authSessionId: b.u.authSessionId,
      productId: la.id,
      rating: 5,
      title: "B",
      body: null,
    });
    // rows the purchase journey does not create, planted for both users (who can SEE them is the question)
    await plant(pool, async (x) => {
      const experiment = uuidv7();
      await x.query(
        `INSERT INTO analytics.experiment (id, key, salt, status, variants, audience, guardrails)
         VALUES ($1, 'seventh-review', '\\x00'::bytea, 'DRAFT', '[]', '{}', '[]')`,
        [experiment],
      );
      for (const u of [a.u, b.u]) {
        await x.query(
          "INSERT INTO private.address (id, user_id, kind, label, locality_id) VALUES ($1, $2, 'FICTIONAL', 'HOME', 1)",
          [uuidv7(), u.userId],
        );
        await x.query(
          `INSERT INTO core.membership (id, user_id, starts_at, ends_at, journal_id)
           VALUES ($1, $2, now(), now() + interval '30 days', $3)`,
          [uuidv7(), u.userId, uuidv7()],
        );
        await x.query(
          "INSERT INTO analytics.experiment_exposure (experiment_id, subject_id, variant) VALUES ($1, $2, 'A')",
          [experiment, u.userId],
        );
        await x.query(
          `INSERT INTO audit.pending_action (id, action, payload, payload_hash, requested_by, not_before)
           VALUES ($1, 'seventh.test', '{}'::jsonb, '\\x00'::bytea, $2, now())`,
          [uuidv7(), u.userId],
        );
        // a configuration written by this user, effective only in the far future
        await x.query(
          `INSERT INTO core.config_version (values, effective_from, created_by)
           SELECT cv.values, '2999-01-01', $1 FROM core.config_version cv ORDER BY cv.id LIMIT 1`,
          [u.userId],
        );
      }
    });
    expect(await reconcile(pool)).toEqual(CLEAN);
  }, 240_000);
  afterAll(async () => {
    await db.drop();
  });

  async function userIdColumns(): Promise<Column[]> {
    const { rows } = await pool.query<Column>(
      `WITH fk AS (
         SELECT c.conrelid AS rel, a.attname AS col
           FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f' AND c.confrelid IN ('core.user_profile'::regclass, 'auth.users'::regclass))
       SELECT r AS role, format('%I.%I', n.nspname, cl.relname) AS rel, a.attname AS col, cl.relkind::text AS relkind,
              cl.relrowsecurity AS rls
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped,
              unnest($1::text[]) r
        WHERE cl.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
          AND (a.attname ILIKE '%user\\_id%' OR (cl.oid, a.attname) IN (SELECT rel, col FROM fk)
               OR format('%s.%s.%s', n.nspname, cl.relname, a.attname) = ANY ($2::text[]))
          AND has_schema_privilege(r, n.nspname, 'USAGE') AND has_column_privilege(r, cl.oid, a.attname, 'SELECT')
        ORDER BY 2, 3, 1`,
      [ROLES, ALSO_USER_ID_COLUMNS],
    );
    return rows;
  }

  /** The distinct non-null values of the column that `role`, signed in as `userId`, can see. */
  const visible = (c: Column, userId: string) =>
    inRolledBackTx(pool, async (x) => {
      await become(x, { role: c.role, userId });
      const { rows } = await x.query<{ v: string }>(
        `SELECT DISTINCT ${c.col}::text AS v FROM ${c.rel} WHERE ${c.col} IS NOT NULL`,
      );
      return rows.map((r) => r.v);
    });

  it("blocker 1 (generated): every readable user-id column is RLS-scoped to the acting user's own rows, proved with two users, or an explained exception", async () => {
    const columns = await userIdColumns();
    // the scan sees the user-id columns the application legitimately reads (its own rows)
    expect(columns.some((c) => c.rel === "core.order_group" && c.col === "buyer_user_id")).toBe(true);
    const leaks: string[] = [];
    for (const c of columns) {
      const key = `${c.role}:${c.rel}.${c.col}`;
      if (key in EXCEPTIONS) continue;
      if (!c.rls || c.relkind === "v" || c.relkind === "m") {
        leaks.push(`${key}: readable without row-level security`);
        continue;
      }
      // both users have rows here (the proof is not vacuous) ...
      const { rows: owners } = await pool.query<{ n: string }>(
        `SELECT count(DISTINCT ${c.col}) AS n FROM ${c.rel} WHERE ${c.col}::text = ANY ($1::text[])`,
        [[a.u.userId, b.u.userId]],
      );
      if (Number(owners[0]?.n) !== 2) {
        leaks.push(`${key}: the fixture gave both users no rows here, so nothing is proved`);
        continue;
      }
      // ... and each sees only their own
      for (const u of [a.u, b.u]) {
        const seen = await visible(c, u.userId);
        const others = seen.filter((v) => v !== u.userId);
        if (others.length > 0)
          leaks.push(`${key}: signed in as one user, sees ${others.length} other user id(s)`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("blocker 1 (reviews, 0078): both users' reviews are stored, and no application role can read a review's author", async () => {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(DISTINCT user_id) AS n FROM core.product_review WHERE user_id = ANY ($1::uuid[])",
      [[a.u.userId, b.u.userId]],
    );
    expect(Number(rows[0]?.n)).toBe(2);
    const columns = await userIdColumns();
    expect(columns.filter((c) => c.rel.startsWith("core.product_review"))).toEqual([]);
  });

  it("blocker 1: the reviewer's query — a store's listings joined to their author — no longer yields the owner's user id", async () => {
    for (const role of ["app_web", "app_pay", "npc_worker"]) {
      const state = await inRolledBackTx(pool, async (x) => {
        await become(x, { role, userId: b.u.userId });
        try {
          await x.query(
            `SELECT co.handle, v.author_user_id FROM core.product_version v
               JOIN core.product p ON p.id = v.product_id JOIN core.company co ON co.id = p.company_id`,
          );
          return "no error";
        } catch (error) {
          return (error as { code?: string }).code ?? "?";
        }
      });
      expect(state, role).toBe("42501");
    }
  });

  it("blocker 1: the application still reads a published listing's public columns", async () => {
    for (const role of ["app_web", "app_pay", "npc_worker"]) {
      const n = await inRolledBackTx(pool, async (x) => {
        await become(x, { role, userId: b.u.userId });
        const { rows } = await x.query<{ n: string }>(
          `SELECT count(*) AS n FROM core.product_version v
            WHERE v.product_id = $1 AND v.name <> '' AND v.price_paise > 0 AND v.created_at IS NOT NULL`,
          [listingA],
        );
        return Number(rows[0]?.n);
      });
      expect(n, role).toBeGreaterThanOrEqual(1);
    }
  });
});
