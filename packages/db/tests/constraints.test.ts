import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProfile,
  createTestDatabase,
  inRolledBackTx,
  sqlState,
  type TestDatabase,
  uuidv7,
} from "./helpers";

/** Runs setup, then asserts the final statement fails with the given SQLSTATE; all in one rolled-back tx. */
async function rejects(
  pool: pg.Pool,
  setup: (c: pg.PoolClient) => Promise<unknown>,
  violating: (c: pg.PoolClient) => Promise<unknown>,
): Promise<string> {
  return inRolledBackTx(pool, async (c) => {
    await setup(c);
    return sqlState(violating(c));
  });
}

/** A user the auth service knows (a profile's id must reference auth.users). */
async function authUser(c: pg.PoolClient): Promise<string> {
  const id = uuidv7();
  await c.query("INSERT INTO auth.users (id) VALUES ($1)", [id]);
  return id;
}

describe("business constraints", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });

  it("one SUCCEEDED payment attempt per checkout session", async () => {
    const user = uuidv7();
    const session = uuidv7();
    const attempt = (c: pg.PoolClient, state: string) =>
      c.query(
        "INSERT INTO core.payment_attempt (id, session_id, user_id, method, state, reference) VALUES ($1, $2, $3, 'BALANCE', $4, $5)",
        [uuidv7(), session, user, state, `ref-${uuidv7()}`],
      );
    const state = await rejects(
      pool,
      async (c) => {
        await c.query(
          `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
           VALUES ($1, $2, 'PRODUCT_PURCHASE', '{}', 10000, 1, now() + interval '15 minutes')`,
          [session, user],
        );
        await attempt(c, "FAILED");
        await attempt(c, "FAILED");
        await attempt(c, "SUCCEEDED");
      },
      (c) => attempt(c, "SUCCEEDED"),
    );
    expect(state).toBe("23505");
  });

  it("ownership is unique per (user, product), revoked rows included", async () => {
    const user = uuidv7();
    const product = uuidv7();
    const own = (c: pg.PoolClient, s: string) =>
      c.query(
        "INSERT INTO core.ownership (id, user_id, product_id, order_line_id, state) VALUES ($1, $2, $3, $4, $5)",
        [uuidv7(), user, product, uuidv7(), s],
      );
    expect(
      await rejects(
        pool,
        (c) => own(c, "REVOKED"),
        (c) => own(c, "ACTIVE"),
      ),
    ).toBe("23505");
  });

  it("warehouse.used cannot exceed capacity", async () => {
    const id = uuidv7();
    const state = await rejects(
      pool,
      (c) =>
        c.query(
          "INSERT INTO core.warehouse (id, company_id, kind, capacity, used) VALUES ($1, $2, 'STARTER', 100, 100)",
          [id, uuidv7()],
        ),
      (c) => c.query("UPDATE core.warehouse SET used = used + 1 WHERE id = $1", [id]),
    );
    expect(state).toBe("23514");
    expect(
      await sqlState(
        pool.query("INSERT INTO core.warehouse (id, company_id, kind, used) VALUES ($1, $2, 'STARTER', -1)", [
          uuidv7(),
          uuidv7(),
        ]),
      ),
    ).toBe("23514");
  });

  it("product.available_units cannot go negative", async () => {
    const id = uuidv7();
    const state = await rejects(
      pool,
      (c) =>
        c.query(
          `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode, available_units)
           VALUES ($1, NULL, 'SEED', 'PUBLISHED', 'gadgets', 'STANDARD_STOCKED', 1)`,
          [id],
        ),
      async (c) => {
        await c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [id]);
        return c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [id]);
      },
    );
    expect(state).toBe("23514");
  });

  it("coupon redeemed cannot exceed max_redemptions", async () => {
    const id = uuidv7();
    const state = await rejects(
      pool,
      (c) =>
        c.query(
          `INSERT INTO core.coupon (id, scope, code_normalised, kind, value, max_redemptions, redeemed)
           VALUES ($1, 'PLATFORM', 'DELULU10', 'PERCENT', 10, 2, 1)`,
          [id],
        ),
      async (c) => {
        await c.query("UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1", [id]);
        return c.query("UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1", [id]);
      },
    );
    expect(state).toBe("23514");
  });

  it("promo campaign spent cannot exceed budget", async () => {
    const id = uuidv7();
    const state = await rejects(
      pool,
      (c) =>
        c.query(
          "INSERT INTO core.promo_campaign (id, name, budget_paise, spent_paise, status) VALUES ($1, 'Diwali', 1000, 900, 'ACTIVE')",
          [id],
        ),
      (c) => c.query("UPDATE core.promo_campaign SET spent_paise = spent_paise + 101 WHERE id = $1", [id]),
    );
    expect(state).toBe("23514");
  });

  it("overlapping memberships for one user are rejected; adjacent and other users' periods are allowed", async () => {
    const user = uuidv7();
    const member = (c: pg.PoolClient, u: string, from: string, to: string) =>
      c.query(
        "INSERT INTO core.membership (id, user_id, starts_at, ends_at, journal_id) VALUES ($1, $2, $3, $4, $5)",
        [uuidv7(), u, from, to, uuidv7()],
      );
    await inRolledBackTx(pool, async (c) => {
      await member(c, user, "2026-01-01T00:00Z", "2026-02-01T00:00Z");
      await member(c, user, "2026-02-01T00:00Z", "2026-03-01T00:00Z"); // adjacent: [) ranges do not overlap
      await member(c, uuidv7(), "2026-01-15T00:00Z", "2026-02-15T00:00Z"); // another user
      expect(await sqlState(member(c, user, "2026-01-15T00:00Z", "2026-02-15T00:00Z"))).toBe("23P01");
    });
  });

  it("R3.1: duplicate email_fingerprint is rejected", async () => {
    const fp = randomBytes(32);
    const ins = async (c: pg.PoolClient) =>
      c.query("INSERT INTO core.user_profile (id, email_fingerprint) VALUES ($1, $2)", [
        await authUser(c),
        fp,
      ]);
    expect(await rejects(pool, ins, ins)).toBe("23505");
  });

  it("R3.1: duplicate phone_fingerprint is rejected (unverified nulls do not collide)", async () => {
    const fp = randomBytes(32);
    const ins = async (c: pg.PoolClient, phone: Buffer | null) =>
      c.query(
        "INSERT INTO core.user_profile (id, email_fingerprint, phone_fingerprint) VALUES ($1, $2, $3)",
        [await authUser(c), randomBytes(32), phone],
      );
    expect(
      await rejects(
        pool,
        async (c) => {
          await ins(c, null);
          await ins(c, null);
          await ins(c, fp);
        },
        (c) => ins(c, fp),
      ),
    ).toBe("23505");
  });

  it("at most one SUPER_ADMIN profile", async () => {
    const admin = async (c: pg.PoolClient) =>
      c.query("INSERT INTO core.user_profile (id, email_fingerprint, role) VALUES ($1, $2, 'SUPER_ADMIN')", [
        await authUser(c),
        randomBytes(32),
      ]);
    expect(await rejects(pool, admin, admin)).toBe("23505");
  });

  it("one ACTIVE or FROZEN card per bank account", async () => {
    const user = await createProfile(pool);
    const state = await rejects(
      pool,
      async (c) => {
        const la = uuidv7();
        await c.query("INSERT INTO ledger.ledger_account (id, type, user_id) VALUES ($1, 'USER', $2)", [
          la,
          user,
        ]);
        await c.query(
          "INSERT INTO core.bank_account (id, user_id, ledger_account_id, alias, upi_style_id) VALUES ($1, $2, $3, 'a1', 'a1@delulu')",
          [user, user, la],
        );
        await c.query(
          "INSERT INTO core.virtual_card (id, user_id, bank_account_id, sequence, card_number, status) VALUES ($1, $2, $2, 1, '0000000000000001', 'FROZEN')",
          [uuidv7(), user],
        );
      },
      (c) =>
        c.query(
          "INSERT INTO core.virtual_card (id, user_id, bank_account_id, sequence, card_number, status) VALUES ($1, $2, $2, 2, '0000000000000002', 'ACTIVE')",
          [uuidv7(), user],
        ),
    );
    expect(state).toBe("23505");
  });
});
