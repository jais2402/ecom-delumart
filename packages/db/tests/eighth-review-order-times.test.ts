import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { myStatement } from "../src/account";
import { myBrandProgress, myEarnings, myInventory, mySellerOrder, mySellerOrders } from "../src/merchant";
import { aMinuteLater, CLEAN, checkout, codeOf, payFor, reconcile, user } from "./checkout-fixtures";
import {
  become,
  createTestDatabase,
  inRolledBackTx,
  stateOf,
  type TestDatabase,
  type TestUser,
} from "./helpers";
import { asFixture, type Creator, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

const ROLES = [
  "app_web",
  "app_pay",
  "app_jobs",
  "npc_worker",
  "research_ro",
  "anon",
  "authenticated",
] as const;

/**
 * `role:schema.table.column` -> why that role may read, on a row that is not the acting buyer's,
 * a time-ordered id or a sub-minute time of an order. Every entry needs a reason.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

interface Column {
  role: string;
  rel: string;
  col: string;
  type: string;
}

type Viewer = { name: string; userId: string | null };

/**
 * Eighth security review, major 1 (migration 0060). GENERATED over the catalog, extending the
 * seventh review's user-id scan: for every column an application role can read, on the rows that
 * role can see as someone who is NOT the buyer (the seller of the order, an unrelated signed-in
 * user, and no session at all), no value is
 *   * a version-7 uuid of an order-side record of that buyer's purchase (order group, checkout
 *     session, payment attempt, seller order, order line, shipment, ownership, purchase journal,
 *     and so the inventory unit's sale linkage), nor
 *   * a timestamp finer than a minute on a row linked to that purchase (a row with any uuid column
 *     naming one of those records),
 * unless the column is an explained exception above.
 */
describe("eighth security review: no application role reads an order's time-ordered ids or exact times unless it is the buyer", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let s: Creator;
  let buyer: TestUser;
  let stranger: TestUser;
  let productId = "";
  let orderSide = new Set<string>();

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    const seeds = await published(pool, 3);
    s = await creator(pool, seeds);
    const p = asFixture(await publishListing(pool, s, { quantity: 3 }));
    productId = p.id;
    buyer = await user(pool);
    stranger = await user(pool);
    await payFor(pool, buyer, await checkout(pool, buyer, [p], { [s.companyId]: "STANDARD" }));
    const p2 = asFixture(await publishListing(pool, s, { quantity: 3 }));
    const seed = seeds[0];
    if (!seed) throw new Error("fixture: no seed product");
    await payFor(
      pool,
      buyer,
      await checkout(pool, buyer, [p2, seed], { [s.companyId]: "STANDARD", SEED: "STANDARD" }),
    );
    expect(await reconcile(pool)).toEqual(CLEAN);
    const { rows } = await pool.query<{ id: string }>(
      `WITH g AS (SELECT * FROM core.order_group WHERE buyer_user_id = $1),
            so AS (SELECT so.* FROM core.seller_order so JOIN g ON g.id = so.order_group_id),
            l AS (SELECT l.* FROM core.order_line l JOIN so ON so.id = l.seller_order_id)
       SELECT g.id::text FROM g
       UNION SELECT g.session_id::text FROM g
       UNION SELECT g.payment_attempt_id::text FROM g
       UNION SELECT g.journal_id::text FROM g
       UNION SELECT j.id::text FROM ledger.journal j JOIN g ON g.id = j.order_group_id
       UNION SELECT so.id::text FROM so
       UNION SELECT l.id::text FROM l
       UNION SELECT sh.id::text FROM core.shipment sh JOIN so ON so.id = sh.seller_order_id
       UNION SELECT o.id::text FROM core.ownership o JOIN l ON l.id = o.order_line_id`,
      [buyer.userId],
    );
    orderSide = new Set(rows.map((r) => r.id.toLowerCase()).filter((id) => id[14] === "7"));
  }, 240_000);
  afterAll(async () => {
    await db.drop();
  });

  async function readableColumns(): Promise<Column[]> {
    const { rows } = await pool.query<Column>(
      `SELECT r AS role, format('%I.%I', n.nspname, cl.relname) AS rel, a.attname AS col,
              format_type(a.atttypid, NULL) AS type
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped,
              unnest($1::text[]) r
        WHERE cl.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
          AND a.atttypid IN ('uuid'::regtype, 'timestamptz'::regtype, 'timestamp'::regtype)
          AND has_schema_privilege(r, n.nspname, 'USAGE') AND has_column_privilege(r, cl.oid, a.attname, 'SELECT')
        ORDER BY 2, 3, 1`,
      [ROLES],
    );
    return rows;
  }

  /** As the owner: the primary keys (as text) of the rows of `rel` that name a record of the purchase. */
  async function linkedKeys(rel: string): Promise<{ pk: string | null; keys: string[] }> {
    const { rows: cols } = await pool.query<{ col: string; pk: boolean }>(
      `SELECT a.attname AS col, false AS pk FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
       UNION ALL
       SELECT a.attname, true FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary AND i.indnatts = 1`,
      [rel],
    );
    const pk = cols.find((c) => c.pk)?.col ?? null;
    const uuids = cols.filter((c) => !c.pk).map((c) => c.col);
    if (pk === null || uuids.length === 0) return { pk, keys: [] };
    const where = uuids.map((c) => `${c}::text = ANY ($1::text[])`).join(" OR ");
    const { rows } = await pool.query<{ k: string }>(`SELECT ${pk}::text AS k FROM ${rel} WHERE ${where}`, [
      [...orderSide],
    ]);
    return { pk, keys: rows.map((r) => r.k) };
  }

  const asViewer = <T>(role: string, v: Viewer, fn: (c: pg.PoolClient) => Promise<T>) =>
    inRolledBackTx(pool, async (x) => {
      await become(x, v.userId === null ? { role } : { role, userId: v.userId });
      return fn(x);
    });

  it("major 1 (generated): no non-buyer reads a v7 order-side id or a sub-minute order time, as the seller, a stranger or nobody", async () => {
    expect(orderSide.size).toBeGreaterThanOrEqual(15);
    const viewers: Viewer[] = [
      { name: "seller", userId: s.u.userId },
      { name: "stranger", userId: stranger.userId },
      { name: "no session", userId: null },
    ];
    const columns = await readableColumns();
    // the scan reaches the order tables (it is not vacuous)
    expect(columns.some((c) => c.rel === "core.order_group" && c.col === "created_at")).toBe(true);
    const links = new Map<string, { pk: string | null; keys: string[] }>();
    for (const rel of new Set(columns.map((c) => c.rel))) links.set(rel, await linkedKeys(rel));
    const pkReadable = new Set(columns.map((c) => `${c.role}:${c.rel}.${c.col}`));
    const leaks: string[] = [];
    for (const c of columns) {
      const key = `${c.role}:${c.rel}.${c.col}`;
      if (key in EXCEPTIONS) continue;
      const link = links.get(c.rel) ?? { pk: null, keys: [] };
      for (const v of viewers) {
        if (c.type === "uuid") {
          const seen = await asViewer(c.role, v, async (x) => {
            try {
              return (
                await x.query<{ v: string }>(
                  `SELECT DISTINCT ${c.col}::text AS v FROM ${c.rel} WHERE ${c.col} IS NOT NULL`,
                )
              ).rows.map((r) => r.v.toLowerCase());
            } catch {
              return [];
            }
          });
          const hits = seen.filter((id) => orderSide.has(id));
          if (hits.length > 0) leaks.push(`${key} (${v.name}): ${hits.length} order-side v7 id(s)`);
        } else if (link.keys.length > 0) {
          // a time on a row of the purchase, finer than a minute
          const byPk = link.pk !== null && pkReadable.has(`${c.role}:${c.rel}.${link.pk}`);
          const n = await asViewer(c.role, v, async (x) => {
            try {
              const { rows } = await x.query<{ n: string }>(
                byPk
                  ? `SELECT count(*) AS n FROM ${c.rel} WHERE ${link.pk}::text = ANY ($1::text[])
                       AND ${c.col} <> date_trunc('minute', ${c.col})`
                  : `SELECT count(*) AS n FROM ${c.rel} WHERE ${c.col} <> date_trunc('minute', ${c.col})`,
                byPk ? [link.keys] : [],
              );
              return Number(rows[0]?.n);
            } catch {
              return 0;
            }
          });
          if (n > 0)
            leaks.push(
              `${key} (${v.name}): ${n} row(s) with a sub-minute time${byPk ? "" : " (key unreadable)"}`,
            );
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("major 1: the reviewer's reproductions are refused or empty", async () => {
    const seller = { role: "app_web", userId: s.u.userId };
    const count = (sql: string, params: unknown[], as: { role: string; userId?: string }) =>
      inRolledBackTx(pool, async (x) => {
        await become(x, as);
        return Number((await x.query<{ n: string }>(sql, params)).rows[0]?.n);
      });
    // a seller order's id and buyer-side group; a shipment's time and address; a line's unit
    for (const sql of [
      "SELECT count(*) AS n FROM (SELECT id, order_group_id FROM core.seller_order) x",
      "SELECT count(*) AS n FROM (SELECT placed_at, address_id FROM core.shipment) x",
      "SELECT count(*) AS n FROM (SELECT id, inventory_unit_id FROM core.order_line) x",
    ]) {
      const state = await stateOf(pool, sql, [], seller);
      if (state === "no error") expect(await count(sql, [], seller), sql).toBe(0);
      else expect(state, sql).toBe("42501");
    }
    // with no session: the sale linkage of the units of a published product
    for (const role of ["app_web", "app_pay"]) {
      expect(
        await stateOf(
          pool,
          "SELECT order_line_id FROM core.inventory_unit WHERE product_id = $1",
          [productId],
          {
            role,
          },
        ),
        role,
      ).toBe("42501");
    }
    // the buyer still reads their own order rows
    expect(
      await count("SELECT count(*) AS n FROM core.seller_order", [], {
        role: "app_web",
        userId: buyer.userId,
      }),
    ).toBe(3);
  });

  it("major 1: a seller's statement names neither the sale's journal nor the buyer's order, and its time is to the minute; the buyer's own statement keeps them", async () => {
    const sales = (await myStatement(pool, { authSessionId: s.u.authSessionId, pageSize: 50 })).items.filter(
      (r) => r.eventType === "PURCHASE",
    );
    expect(sales.length).toBeGreaterThanOrEqual(2);
    for (const r of sales) {
      expect(r.journalId).toBeNull();
      expect(r.orderGroupId).toBeNull();
      expect(r.createdAt.getUTCSeconds() + r.createdAt.getUTCMilliseconds()).toBe(0);
    }
    const own = (await myStatement(pool, { authSessionId: buyer.authSessionId, pageSize: 50 })).items.filter(
      (r) => r.eventType === "PURCHASE",
    );
    expect(own).toHaveLength(2);
    for (const r of own) {
      expect(r.journalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.orderGroupId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("minor 7: an order reaches the seller's reads only once the minute it was placed in has ended; list, detail, earnings, brand progress and stock agree", async () => {
    const as = { authSessionId: s.u.authSessionId };
    const p = asFixture(await publishListing(pool, s, { quantity: 4 }));
    await aMinuteLater(pool); // everything earlier is visible
    const snapshot = async () => {
      const inv = await myInventory(pool, as);
      return {
        orders: (await mySellerOrders(pool, { ...as, pageSize: 50 })).items.length,
        earned: (await myEarnings(pool, as)).current.orders,
        gross: (await myBrandProgress(pool, as)).qualifyingGrossPaise,
        available: inv.products.find((x) => x.productId === p.id)?.available,
        issued: inv.products.find((x) => x.productId === p.id)?.issued,
        used: inv.warehouses.reduce((n, w) => n + w.used, 0),
      };
    };
    const before = await snapshot();
    expect(before).toMatchObject({ available: 4, issued: 0 });
    // within the minute of the sale, nothing has changed for the seller (retried if a minute
    // boundary falls between the sale and the reads)
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      const minute = async () =>
        (await pool.query<{ m: string }>("SELECT date_trunc('minute', clock_timestamp())::text AS m")).rows[0]
          ?.m;
      const b = await user(pool);
      const start = await minute();
      const receipt = await payFor(pool, b, await checkout(pool, b, [p], { [s.companyId]: "STANDARD" }));
      const ref = (
        await pool.query<{ reference: string }>(
          `SELECT r.reference FROM core.seller_order_ref r JOIN core.seller_order so ON so.id = r.seller_order_id
            WHERE so.order_group_id = $1`,
          [receipt.orderGroupId],
        )
      ).rows[0]?.reference;
      const during = await snapshot();
      const detail = await codeOf(mySellerOrder(pool, { ...as, orderRef: ref ?? "" }));
      if ((await minute()) !== start) continue;
      expect(during).toEqual(before);
      expect(detail).toBe("NOT_FOUND");
      settled = true;
      await aMinuteLater(pool);
      const after = await snapshot();
      expect(after.orders).toBe(before.orders + 1);
      expect(after.earned).toBe(before.earned + 1);
      expect(after.gross).toBeGreaterThan(before.gross);
      expect(after).toMatchObject({ available: 3, issued: 1, used: before.used - 1 });
      expect((await mySellerOrder(pool, { ...as, orderRef: ref ?? "" })).orderRef).toBe(ref);
    }
    expect(settled).toBe(true);
  });
});
