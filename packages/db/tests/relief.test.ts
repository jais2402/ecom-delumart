import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { passportProgress, saveProduct, unsaveProduct } from "../src/passport";
import { claimRelief, reliefStatus } from "../src/relief";
import {
  CLEAN,
  codeOf,
  count,
  LAKH,
  type ProductFixture,
  RUPEE,
  reconcile,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  type Actor,
  createTestDatabase,
  plant,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";
import { published, spendTo } from "./selling-fixtures";

const MINT = "00000000-0000-7000-8000-000000000001";
const RELIEF = 10n * LAKH;

/** The relief grant (C), migration 0033. */
describe("relief grant", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 30 });
    pool = db.pool;
    items = await published(pool, 12);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const at = (i: number): ProductFixture => {
    const p = items[i];
    if (!p) throw new Error("fixture");
    return p;
  };
  const claim = (u: TestUser, p: ProductFixture | string) =>
    claimRelief(pool, { authSessionId: u.authSessionId, productId: typeof p === "string" ? p : p.id });
  const status = (u: TestUser) => reliefStatus(pool, { authSessionId: u.authSessionId });
  const grants = (u: TestUser) =>
    count(pool, "SELECT count(*) AS n FROM ledger.grant_record WHERE user_id = $1 AND type = 'RELIEF'", [
      u.userId,
    ]);
  const saved = (u: TestUser, p: ProductFixture) =>
    count(pool, "SELECT count(*) AS n FROM core.product_save WHERE user_id = $1 AND product_id = $2", [
      u.userId,
      p.id,
    ]);
  /** A user whose balance is ₹5 lakh. */
  const poor = async (): Promise<TestUser> => {
    const u = await user(pool);
    await spendTo(pool, u, 5n * LAKH);
    return u;
  };

  /** Relief grants on earlier UTC days, planted as history (no postings: counting only). */
  async function pastReliefs(u: TestUser, days: number): Promise<void> {
    await plant(pool, async (c) => {
      for (let d = 1; d <= days; d++) {
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'RELIEF_GRANT', 1)",
          [j],
        );
        await c.query(
          `INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
           VALUES ($1, $2, $3, 'RELIEF', $4, (now() AT TIME ZONE 'UTC')::date - $5::int)`,
          [uuidv7(), u.userId, j, RELIEF.toString(), d],
        );
      }
    });
  }

  it("C: eligible only below ₹10 lakh; a refusal saves nothing", async () => {
    const rich = await user(pool);
    expect(await status(rich)).toMatchObject({ eligible: false, reason: "BALANCE_TOO_HIGH", claimsUsed: 0 });
    expect(await codeOf(claim(rich, at(0)))).toBe("RELIEF_NOT_ELIGIBLE");
    expect(await saved(rich, at(0))).toBe(0);
    const edge = await user(pool);
    await spendTo(pool, edge, RELIEF); // exactly ₹10 lakh: not below
    expect(await codeOf(claim(edge, at(0)))).toBe("RELIEF_NOT_ELIGIBLE");
    expect(await grants(edge)).toBe(0);
  });

  it("C: a claim saves the product and posts exactly ₹10 lakh MINT → the claimant", async () => {
    const u = await user(pool);
    await spendTo(pool, u, RELIEF - RUPEE); // ₹9,99,999
    expect(await status(u)).toMatchObject({ eligible: true, reason: null, claimsRemaining: 7 });
    const before = await wallet(pool, u.ledgerAccountId);
    const r = await claim(u, at(1));
    expect(r).toMatchObject({
      productId: at(1).id,
      grantedPaise: RELIEF,
      balancePaise: before + RELIEF,
      claimsUsed: 1,
      claimsRemaining: 6,
      eligible: false,
      reason: "CLAIMED_TODAY",
    });
    expect(await wallet(pool, u.ledgerAccountId)).toBe(before + RELIEF);
    expect(await saved(u, at(1))).toBe(1);
    const { rows } = await pool.query<{ account_id: string; amount: string }>(
      `SELECT p.account_id, p.amount::text FROM ledger.posting p JOIN ledger.grant_record g ON g.journal_id = p.journal_id
        WHERE g.user_id = $1 AND g.type = 'RELIEF' ORDER BY p.amount`,
      [u.userId],
    );
    expect(rows).toEqual([
      { account_id: MINT, amount: (-RELIEF).toString() },
      { account_id: u.ledgerAccountId, amount: RELIEF.toString() },
    ]);
    // the outbox carries ids and amounts only
    const outbox = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit.outbox WHERE type = 'relief_granted' AND payload ->> 'userId' = $1",
      [u.userId],
    );
    expect(Object.keys(outbox.rows[0]?.payload ?? {}).sort()).toEqual(
      ["amountPaise", "grantRecordId", "journalId", "userId"].sort(),
    );
    const next = (await status(u)).nextResetAt;
    expect(next.getUTCHours()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  it("C: needs a published product never saved before (unsaving does not make it new)", async () => {
    const u = await poor();
    await saveProduct(pool, { authSessionId: u.authSessionId, productId: at(2).id });
    expect(await codeOf(claim(u, at(2)))).toBe("CONFLICT");
    await unsaveProduct(pool, { authSessionId: u.authSessionId, productId: at(2).id });
    expect(await codeOf(claim(u, at(2)))).toBe("CONFLICT");
    expect(await codeOf(claim(u, uuidv7()))).toBe("PRODUCT_UNAVAILABLE");
    expect(await grants(u)).toBe(0);
    expect((await claim(u, at(3))).claimsUsed).toBe(1);
  });

  it("C: one grant per UTC day under 10 concurrent claims (different and identical products)", async () => {
    const u = await poor();
    const before = await wallet(pool, u.ledgerAccountId);
    const results = await Promise.all([
      ...items.slice(0, 6).map((p) => codeOf(claim(u, p))),
      ...Array.from({ length: 4 }, () => codeOf(claim(u, at(6)))),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(
      results.filter((r) => r !== "ok").every((r) => r === "RELIEF_NOT_ELIGIBLE" || r === "CONFLICT"),
    ).toBe(true);
    expect(await grants(u)).toBe(1);
    expect(await wallet(pool, u.ledgerAccountId)).toBe(before + RELIEF);
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.product_save WHERE user_id = $1", [u.userId]),
    ).toBe(1);
  });

  it("C: at most seven in the account's life", async () => {
    const six = await poor();
    await pastReliefs(six, 6);
    expect(await status(six)).toMatchObject({ eligible: true, claimsUsed: 6, claimsRemaining: 1 });
    expect((await claim(six, at(7))).claimsRemaining).toBe(0);
    const seven = await poor();
    await pastReliefs(seven, 7);
    expect(await status(seven)).toMatchObject({
      eligible: false,
      reason: "LIFETIME_LIMIT",
      claimsRemaining: 0,
    });
    expect(await codeOf(claim(seven, at(8)))).toBe("RELIEF_LIMIT");
    expect(await saved(seven, at(8))).toBe(0);
  });

  it("C: the save counts towards the passport's saves step", async () => {
    const u = await poor();
    await claim(u, at(9));
    expect((await passportProgress(pool, { authSessionId: u.authSessionId })).saves.count).toBe(1);
  });

  it("C: only the checkout role may claim; no application role writes grants or saves directly", async () => {
    const u = await poor();
    const as = (role: string): Actor => ({ role, userId: u.userId });
    for (const role of ["app_web", "app_jobs"]) {
      expect(await stateOf(pool, "SELECT core.claim_relief($1)", [at(10).id], as(role))).toBe("42501");
    }
    for (const role of ["app_web", "app_pay"]) {
      expect(
        await stateOf(
          pool,
          `INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
           VALUES ($1, $2, $3, 'RELIEF', 100000000, current_date)`,
          [uuidv7(), u.userId, uuidv7()],
          as(role),
        ),
      ).toBe("42501");
    }
    expect(await grants(u)).toBe(0);
  });

  it("C: a user's status and claims never touch another user's", async () => {
    const a = await poor();
    const b = await poor();
    await claim(a, at(11));
    expect(await status(b)).toMatchObject({ eligible: true, claimsUsed: 0 });
    expect(await grants(b)).toBe(0);
  });
});
