import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCheckoutSession, createPaymentAttempt } from "../src/checkout";
import { MINT_ACCOUNT_ID, SINK_ACCOUNT_ID } from "../src/provision";
import { withTransaction } from "../src/transaction";
import {
  CLEAN,
  CRORE,
  checkout,
  codeOf,
  key,
  merchantCoupon,
  payFor,
  product,
  RUPEE,
  reconcile,
  type Seller,
  seller,
  standard,
  user,
} from "./checkout-fixtures";
import {
  type Actor,
  commitError,
  commitState,
  countRows,
  createTestDatabase,
  inRolledBackTx,
  plant,
  RAW_WRITER,
  sqlState,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";

/**
 * Fourth security review (no blocker; its major findings). Each test names the finding it closes
 * and fails without the rule that closes it.
 */
describe("fourth security review", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let buyer: TestUser;
  let victim: TestUser;
  let s: Seller;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    buyer = await user(pool);
    victim = await user(pool);
    s = await seller(pool);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const jobs: Actor = { role: "app_jobs" };
  const owner: Actor = {};

  /** A balanced journal of `type`; touched USER wallets are synced (as the owner would). */
  async function journal(c: pg.PoolClient, type: string, postings: [string, bigint][]): Promise<string> {
    const j = uuidv7();
    await c.query("INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)", [
      j,
      type,
    ]);
    for (const [account, amount] of postings) {
      await c.query(
        "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x')",
        [j, account, amount.toString()],
      );
    }
    const users = postings.map(([a]) => a).filter((a) => a !== MINT_ACCOUNT_ID && a !== SINK_ACCOUNT_ID);
    await c.query("SELECT ledger.sync_wallets($1)", [users]);
    return j;
  }

  /** A completed purchase of one stocked unit of `s`; returns its unit, line and seller order. */
  async function soldUnit(
    who: TestUser,
  ): Promise<{ unit: string; line: string; sellerOrder: string; group: string }> {
    const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 500n * RUPEE });
    const receipt = await payFor(pool, who, await checkout(pool, who, [p], standard(s)));
    const { rows } = await pool.query<{ unit: string; line: string; so: string }>(
      `SELECT u.id AS unit, l.id AS line, so.id AS so FROM core.inventory_unit u
         JOIN core.order_line l ON l.id = u.order_line_id JOIN core.seller_order so ON so.id = l.seller_order_id
        WHERE so.order_group_id = $1`,
      [receipt.orderGroupId],
    );
    const row = rows[0];
    if (!row) throw new Error("fixture: no issued unit");
    return { unit: row.unit, line: row.line, sellerOrder: row.so, group: receipt.orderGroupId };
  }

  // ------------------------------------------------------------------------------ item 1
  describe("item 1: the job runner's powers", () => {
    it("app_jobs holds no INSERT on journal, posting or grant_record, no UPDATE on units, ownership or seller orders, and cannot run ledger.sync_wallets", async () => {
      const { rows } = await pool.query<{ what: string }>(
        `SELECT t || ' ' || p AS what FROM (VALUES
            ('ledger.journal', 'INSERT'), ('ledger.posting', 'INSERT'), ('ledger.grant_record', 'INSERT'),
            ('ledger.ledger_account', 'INSERT'), ('ledger.wallet', 'INSERT'), ('ledger.wallet', 'UPDATE'),
            ('core.inventory_unit', 'UPDATE'), ('core.ownership', 'UPDATE'), ('core.seller_order', 'UPDATE')) v(t, p)
          WHERE has_any_column_privilege('app_jobs', t, p)`,
      );
      expect(rows).toEqual([]);
      const fn = await pool.query<{ ok: boolean }>(
        "SELECT has_function_privilege('app_jobs', 'ledger.sync_wallets(uuid[])', 'EXECUTE') AS ok",
      );
      expect(fn.rows[0]?.ok).toBe(false);
    });

    it("app_jobs can neither mint an uncapped COMPENSATION, move a victim's money by REVERSAL, nor retire an account", async () => {
      const compensation = (c: pg.PoolClient) =>
        journal(c, "COMPENSATION", [
          [MINT_ACCOUNT_ID, -1_000n * CRORE],
          [buyer.ledgerAccountId, 1_000n * CRORE],
        ]);
      const reversal = (c: pg.PoolClient) =>
        journal(c, "REVERSAL", [
          [victim.ledgerAccountId, -CRORE],
          [buyer.ledgerAccountId, CRORE],
        ]);
      const retirement = (c: pg.PoolClient) =>
        journal(c, "ACCOUNT_RETIREMENT", [
          [victim.ledgerAccountId, -CRORE],
          [SINK_ACCOUNT_ID, CRORE],
        ]);
      for (const attack of [compensation, reversal, retirement]) {
        expect(await commitState(pool, jobs, attack)).toBe("42501");
      }
    });

    it("COMPENSATION, REVERSAL and ACCOUNT_RETIREMENT journals are refused to every non-owner role, even one granted INSERT", async () => {
      for (const role of ["app_jobs", "app_pay", "app_web", RAW_WRITER]) {
        for (const type of ["COMPENSATION", "REVERSAL", "ACCOUNT_RETIREMENT"]) {
          const message = await inRolledBackTx(pool, async (c) => {
            // a grant mistake: the role is given INSERT (rolled back with the test)
            await c.query(`GRANT INSERT ON ledger.journal TO ${role}`);
            await c.query(`SET LOCAL ROLE ${role}`);
            try {
              await c.query(
                "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)",
                [uuidv7(), type],
              );
              return "no error";
            } catch (error) {
              return (error as Error).message;
            }
          });
          expect(message, `${role} ${type}`).toMatch(/only by the database owner/);
        }
      }
    });

    it("the owner may still post them (control: the structural rules still apply)", async () => {
      expect(
        await commitState(pool, owner, (c) =>
          journal(c, "COMPENSATION", [
            [MINT_ACCOUNT_ID, -5n],
            [buyer.ledgerAccountId, 5n],
          ]),
        ),
      ).toBe("no error");
    });

    it("app_jobs cannot reverse a seller order or revoke ownership by direct UPDATE", async () => {
      const sold = await soldUnit(buyer);
      expect(
        await stateOf(
          pool,
          "UPDATE core.seller_order SET status = 'REVERSED' WHERE id = $1",
          [sold.sellerOrder],
          jobs,
        ),
      ).toBe("42501");
      expect(
        await stateOf(
          pool,
          "UPDATE core.ownership SET state = 'REVOKED' WHERE order_line_id = $1",
          [sold.line],
          jobs,
        ),
      ).toBe("42501");
      expect(
        await stateOf(
          pool,
          "UPDATE core.inventory_unit SET state = 'AVAILABLE' WHERE id = $1",
          [sold.unit],
          jobs,
        ),
      ).toBe("42501");
    });

    it("a sold unit never goes back on sale, for any role, the owner included (counters kept consistent)", async () => {
      const sold = await soldUnit(buyer);
      const restock = async (c: pg.PoolClient) => {
        await c.query(
          "UPDATE core.inventory_unit SET state = 'AVAILABLE', order_line_id = NULL WHERE id = $1",
          [sold.unit],
        );
        await c.query(
          "UPDATE core.product SET available_units = available_units + 1 WHERE id = (SELECT product_id FROM core.inventory_unit WHERE id = $1)",
          [sold.unit],
        );
        await c.query(
          "UPDATE core.warehouse SET used = used + 1 WHERE id = (SELECT warehouse_id FROM core.inventory_unit WHERE id = $1)",
          [sold.unit],
        );
      };
      expect(await commitError(pool, owner, restock)).toMatch(/inventory unit .* may move only/);
      expect(await commitError(pool, { role: RAW_WRITER }, restock)).toMatch(
        /inventory unit .* may move only/,
      );
    });

    it("unit states move only AVAILABLE→ISSUED, AVAILABLE→RETIRED_UNSOLD, ISSUED→REVOKED_ISSUED", async () => {
      const sold = await soldUnit(buyer);
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 500n * RUPEE,
        units: 1,
      });
      const fresh = (
        await pool.query<{ id: string }>("SELECT id FROM core.inventory_unit WHERE product_id = $1", [p.id])
      ).rows[0]?.id;
      const move = (unit: string | undefined, to: string, counters: boolean) => async (c: pg.PoolClient) => {
        await c.query("UPDATE core.inventory_unit SET state = $2 WHERE id = $1", [unit, to]);
        if (counters) {
          await c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [
            p.id,
          ]);
          await c.query("UPDATE core.warehouse SET used = used - 1 WHERE id = $1", [s.warehouseId]);
        }
      };
      const refused = /inventory unit .* may move only/;
      expect(await commitError(pool, owner, move(sold.unit, "RETIRED_UNSOLD", false))).toMatch(refused);
      expect(await commitError(pool, owner, move(fresh, "REVOKED_ISSUED", true))).toMatch(refused);
      // allowed moves (controls)
      expect(await commitState(pool, owner, move(sold.unit, "REVOKED_ISSUED", false))).toBe("no error");
      expect(await commitState(pool, owner, move(fresh, "RETIRED_UNSOLD", true))).toBe("no error");
      // and nothing leaves a final state
      await pool.query("UPDATE core.inventory_unit SET state = 'REVOKED_ISSUED' WHERE id = $1", [sold.unit]);
      for (const to of ["AVAILABLE", "ISSUED", "RETIRED_UNSOLD"]) {
        expect(await commitError(pool, owner, move(sold.unit, to, false)), to).toMatch(refused);
      }
    });
  });

  // ------------------------------------------------------------------------------ item 2
  describe("item 2: sealed records are never deleted, counters move only with their rows", () => {
    /** Runs sql as `as` in a rolled-back transaction and returns the error message, or "no error". */
    const tryAs = (as: Actor, sql: string, params: unknown[] = []) =>
      commitError(pool, as, (c) => c.query(sql, params));

    it("no role, the owner included, deletes ownership, orders, lines, shipments, redemptions, grant records, units or seals", async () => {
      const { code } = await merchantCoupon(pool, s, { percent: 10 });
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2_000n * RUPEE });
      const receipt = await payFor(pool, buyer, await checkout(pool, buyer, [p], standard(s), code));
      const g = receipt.orderGroupId;
      const targets: [string, string][] = [
        [
          "core.ownership",
          "order_line_id IN (SELECT l.id FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id WHERE so.order_group_id = $1)",
        ],
        [
          "core.order_line",
          "seller_order_id IN (SELECT id FROM core.seller_order WHERE order_group_id = $1)",
        ],
        ["core.shipment", "seller_order_id IN (SELECT id FROM core.seller_order WHERE order_group_id = $1)"],
        ["core.seller_order", "order_group_id = $1"],
        ["core.order_group", "id = $1"],
        ["core.coupon_redemption", "order_group_id = $1"],
        ["core.order_group_seal", "order_group_id = $1"],
        ["ledger.journal_seal", "journal_id = (SELECT journal_id FROM core.order_group WHERE id = $1)"],
        ["ledger.grant_record", "user_id = (SELECT buyer_user_id FROM core.order_group WHERE id = $1)"],
        [
          "core.inventory_unit",
          "product_id = (SELECT product_id FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id WHERE so.order_group_id = $1)",
        ],
      ];
      for (const [table, where] of targets) {
        for (const as of [owner, { role: RAW_WRITER }]) {
          expect(
            await tryAs(as, `DELETE FROM ${table} WHERE ${where}`, [g]),
            `${table} ${as.role ?? "owner"}`,
          ).toMatch(/rows are never deleted/);
        }
        expect(await tryAs(owner, `TRUNCATE ${table} CASCADE`), `TRUNCATE ${table}`).toMatch(/never deleted/);
      }
    });

    it("a redemption cannot be deleted to reuse a coupon, and coupon.redeemed never decreases", async () => {
      const { id: couponId, code } = await merchantCoupon(pool, s, { percent: 10 });
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2_000n * RUPEE });
      await payFor(pool, buyer, await checkout(pool, buyer, [p], standard(s), code));
      const reuse = async (c: pg.PoolClient) => {
        await c.query("DELETE FROM core.coupon_redemption WHERE coupon_id = $1", [couponId]);
        await c.query("UPDATE core.coupon SET redeemed = redeemed - 1 WHERE id = $1", [couponId]);
      };
      expect(await commitError(pool, { role: RAW_WRITER }, reuse)).toMatch(/never deleted/);
      expect(
        await tryAs(owner, "UPDATE core.coupon SET redeemed = redeemed - 1 WHERE id = $1", [couponId]),
      ).toMatch(/redeemed never decreases/);
    });

    it("product and warehouse counters change only together with the units they count (checked at once, not only at commit)", async () => {
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 700n * RUPEE,
        units: 2,
      });
      const asOwner = (sql: string, params: unknown[]) =>
        inRolledBackTx(pool, (c) =>
          c.query(sql, params).then(
            () => "no error",
            (e: Error) => e.message,
          ),
        );
      expect(
        await asOwner("UPDATE core.product SET available_units = available_units + 5 WHERE id = $1", [p.id]),
      ).toMatch(/available_units .* AVAILABLE units/);
      expect(
        await asOwner("UPDATE core.warehouse SET used = used + 5 WHERE id = $1", [s.warehouseId]),
      ).toMatch(/used .* AVAILABLE units/);
      // retiring a unit with both counters following it is accepted (control)
      expect(
        await commitState(pool, owner, async (c) => {
          await c.query(
            "UPDATE core.inventory_unit SET state = 'RETIRED_UNSOLD' WHERE id = (SELECT id FROM core.inventory_unit WHERE product_id = $1 AND state = 'AVAILABLE' LIMIT 1)",
            [p.id],
          );
          await c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [
            p.id,
          ]);
          await c.query("UPDATE core.warehouse SET used = used - 1 WHERE id = $1", [s.warehouseId]);
        }),
      ).toBe("no error");
    });
  });

  // ------------------------------------------------------------------------------ item 3
  describe("item 3: payment attempts, daily purchase lines and open checkout sessions are bounded per actor", () => {
    const seedProducts = async (n: number) => {
      const out = [];
      for (let i = 0; i < n; i++)
        out.push(await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE }));
      return out;
    };

    it("at most 10 payment attempts per actor in any rolling minute (RATE_LIMITED), counted from committed rows", async () => {
      const u = await user(pool);
      const [p] = await seedProducts(1);
      if (!p) throw new Error("fixture");
      const co = await checkout(pool, u, [p], standard("SEED")); // attempt 1
      const attempt = () =>
        codeOf(
          createPaymentAttempt(pool, {
            authSessionId: u.authSessionId,
            sessionId: co.sessionId,
            method: "BALANCE",
          }),
        );
      for (let i = 2; i <= 10; i++) expect(await attempt(), `attempt ${i}`).toBe("ok");
      expect(await attempt()).toBe("RATE_LIMITED");
      // other actors are unaffected
      const other = await user(pool);
      expect(await codeOf(checkout(pool, other, [p], standard("SEED")))).toBe("ok");
      // a minute later the window has moved on (planted: the attempts are immutable)
      await plant(pool, (c) =>
        c.query(
          "UPDATE core.payment_attempt SET created_at = created_at - interval '61 seconds' WHERE user_id = $1",
          [u.userId],
        ),
      );
      expect(await attempt()).toBe("ok");
    });

    it("at most 100 completed purchase lines per actor per UTC day, read from the current configuration; concurrent purchases cannot both pass the last line", async () => {
      const u = await user(pool);
      const products = await seedProducts(104);
      const take = (n: number) => products.splice(0, n);
      for (const cart of [take(20), take(20), take(20), take(20), take(19)]) {
        await payFor(pool, u, await checkout(pool, u, cart, standard("SEED")));
      }
      // 99 lines today: two concurrent one-line purchases, only one may complete
      const [a, b] = [take(1), take(1)];
      const coA = await checkout(pool, u, a, standard("SEED"));
      const coB = await checkout(pool, u, b, standard("SEED"));
      // both pass the early count, then queue on the buyer's wallet (held here) and run one by one
      const holder = await pool.connect();
      let outcomes: string[];
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM ledger.wallet WHERE account_id = $1 FOR UPDATE", [
          u.ledgerAccountId,
        ]);
        const both = Promise.all([codeOf(payFor(pool, u, coA)), codeOf(payFor(pool, u, coB))]);
        await new Promise((resolve) => setTimeout(resolve, 600));
        await holder.query("ROLLBACK");
        outcomes = (await both).sort();
      } finally {
        holder.release();
      }
      expect(outcomes).toEqual(["RATE_LIMITED", "ok"]);
      expect(
        await countRows(
          pool,
          `SELECT count(*) AS n FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id
            WHERE so.buyer_user_id = $1`,
          [u.userId],
        ),
      ).toBe(100);
      // the limit comes from the current configuration version
      const next = take(1);
      expect(await codeOf(payFor(pool, u, await checkout(pool, u, next, standard("SEED"))))).toBe(
        "RATE_LIMITED",
      );
      await pool.query(
        `INSERT INTO core.config_version (values, effective_from, note)
         SELECT values || '{"purchase_lines_per_day": 101}', now() - interval '1 second', 'test: limit' FROM core.config_version WHERE id = 1`,
      );
      try {
        expect(await codeOf(payFor(pool, u, await checkout(pool, u, next, standard("SEED"))))).toBe("ok");
      } finally {
        await pool.query(
          `INSERT INTO core.config_version (values, effective_from, note)
           SELECT values, now() - interval '1 second', 'test: restore' FROM core.config_version WHERE id = 1`,
        );
      }
    });

    it("at most 5 OPEN checkout sessions per actor: creating a sixth expires the oldest", async () => {
      const u = await user(pool);
      const products = await seedProducts(6);
      const sessions: string[] = [];
      for (const p of products) {
        const created = await createCheckoutSession(pool, {
          authSessionId: u.authSessionId,
          lines: [{ productId: p.id }],
          speedBySeller: standard("SEED"),
          idempotencyKey: key(),
        });
        sessions.push(created.sessionId);
      }
      const { rows } = await pool.query<{ id: string; state: string }>(
        "SELECT id, state FROM core.checkout_session WHERE user_id = $1 ORDER BY created_at, id",
        [u.userId],
      );
      expect(rows.filter((r) => r.state === "OPEN").map((r) => r.id)).toEqual(sessions.slice(1));
      expect(rows.find((r) => r.id === sessions[0])?.state).toBe("EXPIRED");
      expect(
        await codeOf(
          createPaymentAttempt(pool, {
            authSessionId: u.authSessionId,
            sessionId: sessions[0] ?? "",
            method: "BALANCE",
          }),
        ),
      ).toBe("CONFLICT");
    });
  });

  // ------------------------------------------------------------------------------ item 4
  describe("item 4: private coupon codes are generated, never chosen", () => {
    const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/;
    /** The stable code a statement was refused with (DM001 carries it in HINT), its SQLSTATE, or "ok". */
    const outcome = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return "ok";
      } catch (error) {
        const e = error as { code?: string; hint?: string };
        return e.code === "DM001" ? (e.hint ?? "DM001") : (e.code ?? "?");
      }
    };
    const create = (
      c: pg.PoolClient,
      company: string,
      opts: { kind?: string; value?: bigint; isPublic?: boolean; code?: string | null } = {},
    ) =>
      c.query<{ r: { couponId: string; code: string } }>(
        "SELECT core.create_coupon($1, $2, $3, 0, NULL, NULL, NULL, $4, $5) AS r",
        [
          company,
          opts.kind ?? "PERCENT",
          (opts.value ?? 10n).toString(),
          opts.isPublic ?? false,
          opts.code ?? null,
        ],
      );

    it("no application role can create a private coupon with a chosen code, directly or through core.create_coupon", async () => {
      const shop = await seller(pool);
      const chosen = (c: pg.PoolClient) =>
        c.query(
          `INSERT INTO core.coupon (id, scope, company_id, code_normalised, kind, value)
           VALUES ($1, 'MERCHANT', $2, 'CHOSEN10', 'PERCENT', 10)`,
          [uuidv7(), shop.companyId],
        );
      for (const role of ["app_web", "app_pay", "app_jobs"]) {
        expect(await commitState(pool, { role, userId: shop.owner.userId }, chosen), role).toBe("42501");
      }
      // not even a writer the grants missed, nor the owner: a private coupon's code is generated
      expect(await commitError(pool, { role: RAW_WRITER }, chosen)).toMatch(
        /private coupon's code is generated/,
      );
      expect(await commitError(pool, owner, chosen)).toMatch(/private coupon's code is generated/);
      // the definer function refuses a chosen code for a private coupon, and generates one
      const refused = await asWeb(shop.owner, (c) =>
        outcome(create(c, shop.companyId, { code: "CHOSEN10" })),
      );
      expect(refused).toBe("VALIDATION_FAILED");
      const made = await asWeb(shop.owner, async (c) => (await create(c, shop.companyId)).rows[0]?.r);
      expect(made?.code).toMatch(ALPHABET);
      // a job cannot rename a private code to a chosen one, or make a coupon public
      const existing = await asWeb(shop.owner, async (c) => {
        const r = (await create(c, shop.companyId)).rows[0]?.r;
        await c.query("RESET ROLE");
        await c.query("SET LOCAL ROLE app_jobs");
        const tryIt = async (sql: string) => {
          await c.query("SAVEPOINT s");
          const o = await outcome(c.query(sql, [r?.couponId]));
          await c.query("ROLLBACK TO SAVEPOINT s");
          return o;
        };
        return {
          rename: await tryIt("UPDATE core.coupon SET code_normalised = 'CHOSEN10' WHERE id = $1"),
          publish: await tryIt("UPDATE core.coupon SET is_public = true WHERE id = $1"),
        };
      });
      expect(existing).toEqual({ rename: "23514", publish: "23514" });
    });

    it("core.create_coupon: only the company's owner, five active coupons per company, percent 1–90, public codes of 4–16 characters", async () => {
      const shop = await seller(pool);
      const stranger = await user(pool);
      const results = await inRolledBackTx(pool, async (c) => {
        const as = async (u: TestUser) => {
          await c.query("RESET ROLE");
          await c.query("SELECT set_config('app.session_id', $1, true)", [u.authSessionId]);
          await c.query("SET LOCAL ROLE app_web");
        };
        const tryIt = async (fn: () => Promise<unknown>) => {
          await c.query("SAVEPOINT s");
          const r = await outcome(fn());
          await c.query(r === "ok" ? "RELEASE SAVEPOINT s" : "ROLLBACK TO SAVEPOINT s");
          return r;
        };
        await as(stranger);
        const notOwner = await tryIt(() => create(c, shop.companyId));
        await as(shop.owner);
        const out = {
          notOwner,
          percent0: await tryIt(() => create(c, shop.companyId, { value: 0n })),
          percent91: await tryIt(() => create(c, shop.companyId, { value: 91n })),
          flat0: await tryIt(() => create(c, shop.companyId, { kind: "FLAT", value: 0n })),
          short: await tryIt(() => create(c, shop.companyId, { isPublic: true, code: "ABC" })),
          long: await tryIt(() => create(c, shop.companyId, { isPublic: true, code: "A".repeat(17) })),
          publicOk: await tryIt(() => create(c, shop.companyId, { isPublic: true, code: " diwali25 " })),
          duplicate: await tryIt(() => create(c, shop.companyId, { isPublic: true, code: "DIWALI25" })),
          made: [] as string[],
        };
        for (let i = 0; i < 5; i++) out.made.push(await tryIt(() => create(c, shop.companyId)));
        const codes = await c.query<{ code_normalised: string; code_generated: boolean; is_public: boolean }>(
          "SELECT code_normalised, code_generated, is_public FROM core.coupon WHERE company_id = $1 ORDER BY is_public DESC",
          [shop.companyId],
        );
        return { ...out, codes: codes.rows };
      });
      expect(results).toMatchObject({
        notOwner: "FORBIDDEN",
        percent0: "VALIDATION_FAILED",
        percent91: "VALIDATION_FAILED",
        flat0: "VALIDATION_FAILED",
        short: "VALIDATION_FAILED",
        long: "VALIDATION_FAILED",
        publicOk: "ok",
        duplicate: "CONFLICT",
        made: ["ok", "ok", "ok", "ok", "CONFLICT"], // the public one plus four private: five active
      });
      expect(results.codes[0]).toEqual({
        code_normalised: "DIWALI25",
        code_generated: false,
        is_public: true,
      });
      for (const row of results.codes.slice(1)) {
        expect(row.code_generated).toBe(true);
        expect(row.code_normalised).toMatch(ALPHABET);
      }
      // only app_web may call it
      for (const role of ["app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        const { rows } = await pool.query<{ ok: boolean }>(
          `SELECT has_function_privilege($1, 'core.create_coupon(uuid,text,bigint,bigint,timestamptz,timestamptz,integer,boolean,text)', 'EXECUTE') AS ok`,
          [role],
        );
        expect(rows[0]?.ok, role).toBe(false);
      }
    });

    it("core.set_coupon_status: the company's owner pauses, resumes and ends a coupon; nobody else", async () => {
      const shop = await seller(pool);
      const stranger = await user(pool);
      const made = await asWebCommitted(shop.owner, (c) =>
        create(c, shop.companyId).then((r) => r.rows[0]?.r),
      );
      const set = (u: TestUser, status: string) =>
        asWebCommitted(u, (c) =>
          outcome(c.query("SELECT core.set_coupon_status($1, $2)", [made?.couponId, status])),
        );
      expect(await set(stranger, "PAUSED")).toBe("FORBIDDEN");
      expect(await set(shop.owner, "PAUSED")).toBe("ok");
      expect(await set(shop.owner, "ACTIVE")).toBe("ok");
      expect(await set(shop.owner, "ENDED")).toBe("ok");
      expect(await set(shop.owner, "ACTIVE")).toBe("CONFLICT");
      expect(await set(shop.owner, "BOGUS")).toBe("VALIDATION_FAILED");
      const { rows } = await pool.query<{ status: string }>("SELECT status FROM core.coupon WHERE id = $1", [
        made?.couponId,
      ]);
      expect(rows[0]?.status).toBe("ENDED");
    });

    it("10,000 generated codes are 16 characters of the 32-symbol alphabet and all different", async () => {
      const { rows } = await pool.query<{ n: string; d: string; ok: boolean }>(
        `SELECT count(*) AS n, count(DISTINCT c) AS d, bool_and(c ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$') AS ok
           FROM (SELECT core.generate_coupon_code() AS c FROM generate_series(1, 10000)) x`,
      );
      expect(rows[0]).toEqual({ n: "10000", d: "10000", ok: true });
      // every symbol is used (the alphabet is the whole range, not a prefix of it)
      const symbols = await pool.query<{ n: string }>(
        `SELECT count(DISTINCT ch) AS n FROM (SELECT core.generate_coupon_code() AS c FROM generate_series(1, 2000)) x,
                regexp_split_to_table(c, '') ch`,
      );
      expect(symbols.rows[0]?.n).toBe("32");
    });

    it("100,000 well-formed guesses find no private coupon", async () => {
      const shop = await seller(pool);
      const codes: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await asWebCommitted(shop.owner, (c) =>
          create(c, shop.companyId).then((x) => x.rows[0]?.r.code),
        );
        if (r) codes.push(r);
      }
      expect(codes).toHaveLength(5);
      const { rows } = await pool.query<{ hits: string }>(
        `SELECT count(*) AS hits
           FROM (SELECT core.generate_coupon_code() AS guess FROM generate_series(1, 100000)) g
           JOIN core.coupon c ON c.code_normalised = g.guess AND NOT c.is_public`,
      );
      expect(rows[0]?.hits).toBe("0");
    });

    /** Runs fn as app_web signed in as `u`, rolled back. */
    function asWeb<T>(u: TestUser, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      return inRolledBackTx(pool, async (c) => {
        await c.query("SELECT set_config('app.session_id', $1, true)", [u.authSessionId]);
        await c.query("SET LOCAL ROLE app_web");
        return fn(c);
      });
    }
    /** Runs fn as app_web signed in as `u`, committed. */
    async function asWebCommitted<T>(u: TestUser, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.session_id', $1, true)", [u.authSessionId]);
        await c.query("SET LOCAL ROLE app_web");
        const r = await fn(c);
        await c.query("COMMIT");
        return r;
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
    }
  });

  // ------------------------------------------------------------------------------ item 5
  describe("item 5: a money session that holds its locks open is terminated by the watchdog", () => {
    it("commit_purchase takes the sellers' wallet locks last: while it waits on anything else, no seller wallet is held", async () => {
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 800n * RUPEE });
      const co = await checkout(pool, victim, [p], standard(s));
      const holder = await pool.connect();
      const prober = await pool.connect();
      try {
        await holder.query("BEGIN");
        // something the purchase reads under lock is held elsewhere (here: the purchases switch)
        await holder.query("SELECT 1 FROM core.system_switch WHERE name = 'purchases' FOR UPDATE");
        const paying = codeOf(payFor(pool, victim, co));
        await new Promise((resolve) => setTimeout(resolve, 700));
        const probe = await sqlState(
          prober.query("SELECT 1 FROM ledger.wallet WHERE account_id = $1 FOR UPDATE NOWAIT", [
            s.owner.ledgerAccountId,
          ]),
        );
        await holder.query("ROLLBACK");
        expect(probe).toBe("no error");
        expect(await paying).toBe("ok");
      } finally {
        holder.release();
        prober.release();
      }
    });

    it("an app_pay session that completes commit_purchase and never commits: victims get BUSY until ops.terminate_stuck_money_sessions ends it; nothing of it commits and the victim's retry succeeds", async () => {
      const password = `pw-${uuidv7()}`;
      await pool.query(`ALTER ROLE app_pay PASSWORD '${password}'`);
      const url = new URL(db.url);
      url.username = "app_pay";
      url.password = password;
      const attackerPool = new pg.Pool({ connectionString: url.toString(), max: 1 });
      attackerPool.on("error", () => undefined); // the terminated connection reports here
      let reachCommit: () => void = () => undefined;
      const atCommit = new Promise<void>((resolve) => {
        reachCommit = resolve;
      });
      let letCommit: () => void = () => undefined;
      const commitGate = new Promise<void>((resolve) => {
        letCommit = resolve;
      });
      // pay() as it runs in production, on the attacker's own app_pay login, except that its
      // COMMIT is held back: the transaction stays open with every lock commit_purchase took
      const holdingPool = {
        connect: async () => {
          const client = await attackerPool.connect();
          client.on("error", () => undefined);
          await client.query("SET idle_in_transaction_session_timeout = 0"); // raised by the attacker
          return new Proxy(client, {
            get(target, prop, receiver) {
              if (prop !== "query") return Reflect.get(target, prop, receiver);
              return async (text: unknown, ...rest: unknown[]) => {
                if (text === "COMMIT") {
                  reachCommit();
                  await commitGate;
                }
                return (target.query as (...a: unknown[]) => Promise<unknown>).call(target, text, ...rest);
              };
            },
          });
        },
      } as unknown as pg.Pool;

      try {
        const attacker = await user(pool);
        const p1 = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 900n * RUPEE });
        const p2 = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 900n * RUPEE });
        const coA = await checkout(pool, attacker, [p1], standard(s));
        const coV = await checkout(pool, victim, [p2], standard(s));
        const attack = codeOf(payFor(holdingPool, attacker, coA));
        await atCommit; // the attacker's purchase succeeded inside its open transaction

        const k = key();
        expect(await codeOf(payFor(pool, victim, coV, k))).toBe("BUSY");
        const before = await countRows(
          pool,
          "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'terminate_stuck_money_session'",
        );
        for (const role of ["app_web", "app_pay"]) {
          expect(await stateOf(pool, "SELECT ops.terminate_stuck_money_sessions()", [], { role }), role).toBe(
            "42501",
          );
        }
        // the watchdog (scheduled every few seconds in production), as the job runner
        const killed = await withTransaction(
          pool,
          async (c) =>
            (
              await c.query<{ n: number }>(
                "SELECT ops.terminate_stuck_money_sessions(interval '1 second') AS n",
              )
            ).rows[0]?.n,
          { role: "app_jobs" },
        );
        expect(killed).toBe(1);
        letCommit();
        expect(await attack).not.toBe("ok");

        // nothing of the attacker's purchase committed
        expect(
          await countRows(pool, "SELECT count(*) AS n FROM core.order_group WHERE session_id = $1", [
            coA.sessionId,
          ]),
        ).toBe(0);
        const { rows } = await pool.query<{ s: string; a: string }>(
          `SELECT s.state AS s, a.state AS a FROM core.checkout_session s JOIN core.payment_attempt a ON a.session_id = s.id
            WHERE s.id = $1`,
          [coA.sessionId],
        );
        expect(rows[0]).toEqual({ s: "OPEN", a: "PENDING" });
        // the victim's retry with the same idempotency key completes
        const receipt = await payFor(pool, victim, coV, k);
        expect(receipt.totalPaise).toBe(900n * RUPEE + 1_000n * RUPEE);
        // one audit row per termination: the system acted; no personal data
        const audit = await pool.query<{
          actor_kind: string;
          actor_id: string | null;
          detail: Record<string, unknown>;
        }>(
          `SELECT actor_kind, actor_id, detail FROM audit.audit_log WHERE action = 'terminate_stuck_money_session'
            ORDER BY id`,
        );
        expect(audit.rows.length).toBe(before + 1);
        const last = audit.rows[audit.rows.length - 1];
        expect(last?.actor_kind).toBe("SYSTEM");
        expect(last?.actor_id).toBeNull();
        expect(Object.keys(last?.detail ?? {}).sort()).toEqual([
          "maxAgeSeconds",
          "pid",
          "role",
          "tables",
          "transactionAgeSeconds",
        ]);
        expect(last?.detail.role).toBe("app_pay");
      } finally {
        letCommit();
        await attackerPool.end().catch(() => undefined);
        await pool.query("ALTER ROLE app_pay PASSWORD NULL");
      }
    });

    it("the watchdog leaves short transactions and other logins alone", async () => {
      const holder = await pool.connect();
      try {
        // a long transaction holding a wallet lock, but on a login that is not app_pay or app_web
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM ledger.wallet WHERE account_id = $1 FOR UPDATE", [
          s.owner.ledgerAccountId,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        const killed = await withTransaction(
          pool,
          async (c) =>
            (
              await c.query<{ n: number }>(
                "SELECT ops.terminate_stuck_money_sessions(interval '1 second') AS n",
              )
            ).rows[0]?.n,
          { role: "app_jobs" },
        );
        expect(killed).toBe(0);
        expect((await holder.query("SELECT 1 AS alive")).rows[0]).toEqual({ alive: 1 });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });
  });
});
