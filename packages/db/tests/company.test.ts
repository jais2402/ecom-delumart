import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPaymentAttempt } from "../src/checkout";
import { companyQuote, myCompany, registerCompany, storeByHandle, updateStore } from "../src/company";
import { creatorAccess } from "../src/passport";
import {
  authenticateCard,
  CLEAN,
  CRORE,
  codeOf,
  count,
  LAKH,
  type ProductFixture,
  RUPEE,
  reconcile,
  sinkBalance,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  type Actor,
  commitError,
  createTestDatabase,
  RAW_WRITER,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";
import { completePassport, passQuiz, published, STARTING, spendTo } from "./selling-fixtures";

const MINT = "00000000-0000-7000-8000-000000000001";
const SINK = "00000000-0000-7000-8000-000000000002";
const FEE = 5n * LAKH;

const handle = (): string => `lamps-${randomBytes(5).toString("hex")}`; // "shop" is reserved as a token (0049)

/** Company registration (E, US-18, US-19), migration 0034. */
describe("company registration", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 30 });
    pool = db.pool;
    items = await published(pool, 3);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  // ------------------------------------------------------------------ fixtures
  /** A creator by the passport (full ₹100 crore), optionally spent down to `balance` afterwards. */
  async function passportCreator(balance?: bigint): Promise<TestUser> {
    const u = await user(pool);
    await completePassport(pool, u, items);
    if (balance !== undefined) await spendTo(pool, u, balance);
    return u;
  }
  /** A creator by spending (balance below ₹1 crore), with or without the passport quiz passed. */
  async function spendCreator(balance: bigint, quiz: boolean): Promise<TestUser> {
    const u = await user(pool);
    await spendTo(pool, u, balance);
    if (quiz) await passQuiz(pool, u);
    return u;
  }
  const quote = (
    u: TestUser,
    h: string,
    displayName = "Moon Lamps",
    description = "Lamps that are mostly moon.",
  ) => companyQuote(pool, { authSessionId: u.authSessionId, handle: h, displayName, description });
  const attempt = (u: TestUser, sessionId: string) =>
    createPaymentAttempt(pool, { authSessionId: u.authSessionId, sessionId, method: "BALANCE" });
  const register = (u: TestUser, sessionId: string, attemptId: string, key = `k-${uuidv7()}`) =>
    registerCompany(pool, { authSessionId: u.authSessionId, sessionId, attemptId, idempotencyKey: key });
  /** Quote, BALANCE attempt, register. */
  async function registered(u: TestUser, h = handle()) {
    const q = await quote(u, h);
    const a = await attempt(u, q.sessionId);
    return { q, a, receipt: await register(u, q.sessionId, a.attemptId) };
  }
  const companies = (u: TestUser) =>
    count(pool, "SELECT count(*) AS n FROM core.company WHERE owner_user_id = $1", [u.userId]);
  const registrationJournals = (u: TestUser) =>
    count(
      pool,
      `SELECT count(*) AS n FROM ledger.journal j JOIN ledger.posting p ON p.journal_id = j.id
        WHERE j.event_type = 'COMPANY_REGISTRATION' AND p.account_id = $1`,
      [u.ledgerAccountId],
    );
  async function postingsOf(journalId: string): Promise<Record<string, bigint>> {
    const { rows } = await pool.query<{ account_id: string; amount: string }>(
      "SELECT account_id, SUM(amount)::text AS amount FROM ledger.posting WHERE journal_id = $1 GROUP BY account_id",
      [journalId],
    );
    return Object.fromEntries(rows.map((r) => [r.account_id, BigInt(r.amount)]));
  }
  async function journalOf(companyId: string): Promise<string> {
    const { rows } = await pool.query<{ journal_id: string }>(
      "SELECT journal_id FROM core.company_registration WHERE company_id = $1",
      [companyId],
    );
    const id = rows[0]?.journal_id;
    if (!id) throw new Error("no registration");
    return id;
  }

  // ------------------------------------------------------------------ US-18
  it("US-18: from ₹90 lakh: one SOLO company with a 100-slot starter warehouse, SINK +₹5 lakh, ₹85 lakh left", async () => {
    const u = await passportCreator(90n * LAKH);
    const sinkBefore = await sinkBalance(pool);
    const h = handle();
    const q = await quote(u, h);
    expect(q).toMatchObject({
      handle: h,
      feePaise: FEE,
      sponsorshipPaise: 0n,
      payablePaise: FEE,
      balancePaise: 90n * LAKH,
      balanceAfterPaise: 85n * LAKH,
      sufficient: true,
    });
    expect(q.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
    const a = await attempt(u, q.sessionId);
    const r = await register(u, q.sessionId, a.attemptId);
    expect(r).toMatchObject({
      handle: h,
      displayName: "Moon Lamps",
      tier: "SOLO",
      feePaise: FEE,
      paidPaise: FEE,
      sponsorshipPaise: 0n,
      balanceAfterPaise: 85n * LAKH,
      paymentReference: a.reference,
      replayed: false,
    });
    expect(await wallet(pool, u.ledgerAccountId)).toBe(85n * LAKH);
    expect((await sinkBalance(pool)) - sinkBefore).toBe(FEE);
    expect(await postingsOf(await journalOf(r.companyId))).toEqual({
      [u.ledgerAccountId]: -FEE,
      [SINK]: FEE,
    });
    const mine = await myCompany(pool, { authSessionId: u.authSessionId });
    expect(mine).toMatchObject({
      companyId: r.companyId,
      handle: h,
      displayName: "Moon Lamps",
      description: "Lamps that are mostly moon.",
      tier: "SOLO",
      warehouses: {
        count: 1,
        capacity: 100,
        used: 0,
        starter: { id: r.warehouseId, capacity: 100, used: 0 },
      },
    });
    const states = await pool.query<{ s: string; a: string }>(
      `SELECT cs.state AS s, pa.state AS a FROM core.checkout_session cs JOIN core.payment_attempt pa ON pa.session_id = cs.id
        WHERE cs.id = $1`,
      [q.sessionId],
    );
    expect(states.rows).toEqual([{ s: "SUCCEEDED", a: "SUCCEEDED" }]);
    // the outbox row carries ids and amounts only
    const outbox = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit.outbox WHERE type = 'company_registered' AND aggregate_id = $1",
      [r.companyId],
    );
    expect(Object.keys(outbox.rows[0]?.payload ?? {}).sort()).toEqual(
      [
        "checkoutSessionId",
        "companyId",
        "configVersion",
        "feePaise",
        "journalId",
        "ownerUserId",
        "paidPaise",
        "paymentAttemptId",
        "registrationId",
        "sponsorshipPaise",
        "warehouseId",
      ].sort(),
    );
  });

  it("US-18: a replay returns the same company; refresh and concurrent different keys charge once", async () => {
    const u = await passportCreator(90n * LAKH);
    const q = await quote(u, handle());
    const attempts = await Promise.all(Array.from({ length: 5 }, () => attempt(u, q.sessionId)));
    const first = attempts[0];
    if (!first) throw new Error("fixture");
    const key = `k-${uuidv7()}`;
    const results = await Promise.all([
      ...attempts.map((a) => codeOf(register(u, q.sessionId, a.attemptId))),
      codeOf(register(u, q.sessionId, first.attemptId, key)),
      codeOf(register(u, q.sessionId, first.attemptId, key)),
    ]);
    expect(results.filter((r) => r === "ok").length).toBeGreaterThanOrEqual(1);
    expect(await companies(u)).toBe(1);
    expect(await registrationJournals(u)).toBe(1);
    expect(await wallet(pool, u.ledgerAccountId)).toBe(85n * LAKH);
    // a replay of a successful key
    const winner = (
      await pool.query<{ key: string; response: { companyId: string } }>(
        "SELECT key, response FROM core.idempotency_record WHERE user_id = $1 AND command = 'company.register' AND status = 200",
        [u.userId],
      )
    ).rows;
    expect(winner).toHaveLength(1);
    const w = winner[0];
    if (!w) throw new Error("no winner");
    const { rows } = await pool.query<{ payment_attempt_id: string }>(
      "SELECT payment_attempt_id FROM core.company_registration WHERE company_id = $1",
      [w.response.companyId],
    );
    const replay = await register(u, q.sessionId, rows[0]?.payment_attempt_id ?? "", w.key);
    expect(replay).toMatchObject({ companyId: w.response.companyId, replayed: true });
    expect(await registrationJournals(u)).toBe(1);
  });

  it("US-18: an expired quote takes no money, creates nothing and frees the handle", async () => {
    const u = await passportCreator(90n * LAKH);
    const other = await passportCreator();
    const h = handle();
    const q = await quote(u, h);
    const a = await attempt(u, q.sessionId);
    expect(await codeOf(quote(other, h))).toBe("HANDLE_RESERVED");
    await pool.query(
      "UPDATE core.checkout_session SET expires_at = now() - interval '1 second' WHERE id = $1",
      [q.sessionId],
    );
    expect(await codeOf(register(u, q.sessionId, a.attemptId))).toBe("CHECKOUT_EXPIRED");
    expect(await companies(u)).toBe(0);
    expect(await wallet(pool, u.ledgerAccountId)).toBe(90n * LAKH);
    // the handle is free again
    const q2 = await quote(other, h);
    expect((await register(other, q2.sessionId, (await attempt(other, q2.sessionId)).attemptId)).handle).toBe(
      h,
    );
  });

  it("US-18: a failed name or handle check creates no quote, company or debit", async () => {
    const u = await passportCreator(90n * LAKH);
    const sessions = () =>
      count(pool, "SELECT count(*) AS n FROM core.checkout_session WHERE user_id = $1", [u.userId]);
    const before = await sessions();
    for (const [h, name, desc, code] of [
      [handle(), "ab", "", "VALIDATION_FAILED"],
      [handle(), "x".repeat(41), "", "VALIDATION_FAILED"],
      [handle(), "Moon\u0001Lamps", "", "VALIDATION_FAILED"],
      [handle(), "Moon Lamps", "x".repeat(281), "VALIDATION_FAILED"],
      ["Moon", "Moon Lamps", "", "VALIDATION_FAILED"],
      ["-moon", "Moon Lamps", "", "VALIDATION_FAILED"],
      ["moon--lamp", "Moon Lamps", "", "VALIDATION_FAILED"],
      ["ab", "Moon Lamps", "", "VALIDATION_FAILED"],
      ["delulumart", "Moon Lamps", "", "HANDLE_TAKEN"],
      ["checkout", "Moon Lamps", "", "HANDLE_TAKEN"],
    ] as const) {
      expect(await codeOf(quote(u, h, name, desc)), `${h} ${name}`).toBe(code);
    }
    expect(await sessions()).toBe(before);
    expect(await companies(u)).toBe(0);
    expect(await wallet(pool, u.ledgerAccountId)).toBe(90n * LAKH);
    // names are trimmed; the description may be empty
    const q = await quote(u, handle(), "  Moon Lamps  ", "");
    expect(q).toMatchObject({ displayName: "Moon Lamps", description: "" });
  });

  it("US-18: insufficient funds without the quiz: no company, no debit, the attempt FAILED", async () => {
    const u = await spendCreator(2n * LAKH, false);
    const q = await quote(u, handle());
    expect(q).toMatchObject({ sponsorshipPaise: 0n, sufficient: false, balanceAfterPaise: null });
    const a = await attempt(u, q.sessionId);
    expect(await codeOf(register(u, q.sessionId, a.attemptId))).toBe("INSUFFICIENT_FUNDS");
    expect(await companies(u)).toBe(0);
    expect(await wallet(pool, u.ledgerAccountId)).toBe(2n * LAKH);
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.formation_sponsorship WHERE user_id = $1", [
        u.userId,
      ]),
    ).toBe(0);
    const { rows } = await pool.query<{ state: string; failure_code: string }>(
      "SELECT state, failure_code FROM core.payment_attempt WHERE id = $1",
      [a.attemptId],
    );
    expect(rows[0]).toEqual({ state: "FAILED", failure_code: "INSUFFICIENT_FUNDS" });
  });

  it("US-18: registration requires creator access; one company per person", async () => {
    const plain = await user(pool);
    expect(await codeOf(quote(plain, handle()))).toBe("CREATOR_LOCKED");
    const u = await passportCreator();
    await registered(u);
    expect(await codeOf(quote(u, handle()))).toBe("COMPANY_EXISTS");
  });

  it("US-18: from ₹100 crore by the passport: ₹99.95 crore after, and nothing else changes (no entitlement, order rows or spend route)", async () => {
    const u = await passportCreator();
    const before = await pool.query("SELECT * FROM core.creator_entitlement WHERE user_id = $1", [u.userId]);
    const { receipt } = await registered(u);
    expect(receipt.balanceAfterPaise).toBe(STARTING - FEE);
    expect(await wallet(pool, u.ledgerAccountId)).toBe((9995n * CRORE) / 100n);
    expect(
      (await pool.query("SELECT * FROM core.creator_entitlement WHERE user_id = $1", [u.userId])).rows,
    ).toEqual(before.rows);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM core.creator_route_evidence WHERE user_id = $1 AND route = 'SPEND'",
        [u.userId],
      ),
    ).toBe(0);
    for (const sql of [
      "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1",
      "SELECT count(*) AS n FROM core.seller_order WHERE buyer_user_id = $1",
      "SELECT count(*) AS n FROM core.ownership WHERE user_id = $1",
    ]) {
      expect(await count(pool, sql, [u.userId]), sql).toBe(0);
    }
    const access = await creatorAccess(pool, { authSessionId: u.authSessionId });
    expect(access).toMatchObject({
      unlocked: true,
      source: "ACHIEVEMENT",
      routes: { spend: { reached: false } },
    });
  });

  it("US-18: a CARD attempt needs its PIN step first (PAYMENT_PENDING), then registers", async () => {
    const u = await passportCreator(90n * LAKH);
    const q = await quote(u, handle());
    const a = await createPaymentAttempt(pool, {
      authSessionId: u.authSessionId,
      sessionId: q.sessionId,
      method: "CARD",
      cardId: u.cardId,
    });
    expect(a.authenticated).toBe(false);
    expect(await codeOf(register(u, q.sessionId, a.attemptId))).toBe("PAYMENT_PENDING");
    expect(await companies(u)).toBe(0);
    await authenticateCard(pool, u, a.attemptId);
    expect((await register(u, q.sessionId, a.attemptId)).paidPaise).toBe(FEE);
  });

  it("US-18: a purchase cannot pay a registration quote, and a registration cannot pay a product quote", async () => {
    const u = await passportCreator(90n * LAKH);
    const q = await quote(u, handle());
    const a = await attempt(u, q.sessionId);
    const { pay } = await import("../src/checkout");
    expect(
      await codeOf(
        pay(pool, {
          authSessionId: u.authSessionId,
          sessionId: q.sessionId,
          attemptId: a.attemptId,
          idempotencyKey: `k-${uuidv7()}`,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(await companies(u)).toBe(0);
  });

  // ------------------------------------------------------------------ US-19
  it("US-19: ₹2 lakh after the quiz: the owner pays ₹2 lakh and MINT ₹3 lakh in the same journal; the wallet ends at 0", async () => {
    const u = await spendCreator(2n * LAKH, true);
    const q = await quote(u, handle());
    expect(q).toMatchObject({
      sponsorshipPaise: 3n * LAKH,
      payablePaise: 2n * LAKH,
      balanceAfterPaise: 0n,
      sufficient: true,
    });
    // a quote alone mints nothing and records no sponsorship
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.formation_sponsorship WHERE user_id = $1", [
        u.userId,
      ]),
    ).toBe(0);
    const r = await register(u, q.sessionId, (await attempt(u, q.sessionId)).attemptId);
    expect(r).toMatchObject({ paidPaise: 2n * LAKH, sponsorshipPaise: 3n * LAKH, balanceAfterPaise: 0n });
    const journal = await journalOf(r.companyId);
    expect(await postingsOf(journal)).toEqual({
      [u.ledgerAccountId]: -2n * LAKH,
      [MINT]: -3n * LAKH,
      [SINK]: FEE,
    });
    expect(await wallet(pool, u.ledgerAccountId)).toBe(0n);
    const { rows } = await pool.query(
      "SELECT user_id, journal_id, amount_paise::text AS amount FROM core.formation_sponsorship WHERE user_id = $1",
      [u.userId],
    );
    expect(rows).toEqual([{ user_id: u.userId, journal_id: journal, amount: (3n * LAKH).toString() }]);
    // never credited to the wallet: the only MINT posting of the journal goes to SINK
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM ledger.posting WHERE journal_id = $1 AND amount > 0 AND account_id <> $2",
        [journal, SINK],
      ),
    ).toBe(0);
  });

  it("US-19: a zero-balance owner after the quiz pays nothing; MINT covers the whole fee", async () => {
    const u = await spendCreator(0n, true);
    const r = (await registered(u)).receipt;
    expect(r).toMatchObject({ paidPaise: 0n, sponsorshipPaise: FEE, balanceAfterPaise: 0n });
    expect(await postingsOf(await journalOf(r.companyId))).toEqual({ [MINT]: -FEE, [SINK]: FEE });
    expect(await wallet(pool, u.ledgerAccountId)).toBe(0n);
  });

  it("US-19: never without the quiz; once per lifetime (one row per person, refused a second time)", async () => {
    const noQuiz = await spendCreator(0n, false);
    const q = await quote(noQuiz, handle());
    expect(q).toMatchObject({ sponsorshipPaise: 0n, sufficient: false });
    expect(await codeOf(register(noQuiz, q.sessionId, (await attempt(noQuiz, q.sessionId)).attemptId))).toBe(
      "INSUFFICIENT_FUNDS",
    );
    const u = await spendCreator(0n, true);
    const r = (await registered(u)).receipt;
    expect(r.sponsorshipPaise).toBe(FEE);
    // a second sponsorship row for the same person, even in a fresh (unsealed) journal
    expect(
      await commitError(pool, {}, async (c) => {
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'COMPANY_REGISTRATION', 1)",
          [j],
        );
        await c.query(
          "INSERT INTO core.formation_sponsorship (id, user_id, journal_id, amount_paise) VALUES ($1, $2, $3, 1)",
          [uuidv7(), u.userId, j],
        );
      }),
    ).toMatch(/formation_sponsorship_user_id_key/);
  });

  // ------------------------------------------------------------------ handles
  it("US-18: two people, the same handle, concurrently: one reservation; the other is refused and never charged", async () => {
    const a = await passportCreator(90n * LAKH);
    const b = await passportCreator(90n * LAKH);
    const h = handle();
    const results = await Promise.all([codeOf(quote(a, h)), codeOf(quote(b, h))]);
    expect([...results].sort()).toEqual(["HANDLE_RESERVED", "ok"]);
    const winner = results[0] === "ok" ? a : b;
    const loser = winner === a ? b : a;
    const { rows } = await pool.query<{ session_id: string }>(
      "SELECT session_id FROM core.handle_reservation WHERE handle = $1",
      [h],
    );
    const sessionId = rows[0]?.session_id ?? "";
    await register(winner, sessionId, (await attempt(winner, sessionId)).attemptId);
    expect(await codeOf(quote(loser, h))).toBe("HANDLE_TAKEN");
    expect(await wallet(pool, loser.ledgerAccountId)).toBe(90n * LAKH);
    expect(await companies(loser)).toBe(0);
  });

  it("US-18: concurrent registrations of two people for one handle: one company (the reservation holder)", async () => {
    const a = await passportCreator(90n * LAKH);
    const b = await passportCreator(90n * LAKH);
    const h = handle();
    const qa = await quote(a, h);
    const qb = await quote(b, handle());
    // b cannot redirect their own quote to the handle; both register at once
    const [ra, rb] = await Promise.all([
      register(a, qa.sessionId, (await attempt(a, qa.sessionId)).attemptId),
      register(b, qb.sessionId, (await attempt(b, qb.sessionId)).attemptId),
    ]);
    expect(ra.handle).toBe(h);
    expect(rb.handle).not.toBe(h);
    expect(await count(pool, "SELECT count(*) AS n FROM core.company WHERE lower(handle) = $1", [h])).toBe(1);
  });

  it("E: a person holds one live quote: a new quote expires the earlier one and frees its handle", async () => {
    const a = await passportCreator();
    const b = await passportCreator();
    const h1 = handle();
    const first = await quote(a, h1);
    await quote(a, handle());
    const firstAttempt = (await attempt(b, (await quote(b, h1)).sessionId)).attemptId;
    expect(firstAttempt).toBeTruthy();
    expect(await codeOf(attempt(a, first.sessionId))).toBe("CONFLICT");
  });

  // ------------------------------------------------------------------ reading and editing
  it("E: the owner reads and edits their company; the handle never changes; B sees nothing of A's", async () => {
    const a = await passportCreator();
    const b = await user(pool);
    const h = handle();
    const { receipt } = await registered(a, h);
    expect(await myCompany(pool, { authSessionId: b.authSessionId })).toBeNull();
    expect(await codeOf(updateStore(pool, { authSessionId: b.authSessionId, displayName: "Stolen" }))).toBe(
      "NOT_FOUND",
    );
    const edited = await updateStore(pool, {
      authSessionId: a.authSessionId,
      description: "Now with more moon.",
    });
    expect(edited).toMatchObject({
      handle: h,
      displayName: "Moon Lamps",
      description: "Now with more moon.",
    });
    expect(await codeOf(updateStore(pool, { authSessionId: a.authSessionId, displayName: "x" }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(
      await commitError(pool, {}, (c) =>
        c.query("UPDATE core.company SET handle = 'other-handle' WHERE id = $1", [receipt.companyId]),
      ),
    ).toMatch(/never change/);
    for (const as of [
      { role: "app_web", userId: a.userId },
      { role: "app_pay", userId: a.userId },
    ]) {
      expect(
        await stateOf(pool, "UPDATE core.company SET name = 'Mine' WHERE id = $1", [receipt.companyId], as),
      ).toBe("42501");
    }
  });

  it("E: the public store lookup returns the storefront and no owner identity", async () => {
    const a = await passportCreator();
    const h = handle();
    await registered(a, h);
    const store = await storeByHandle(pool, h);
    expect(store).toEqual({
      handle: h,
      displayName: "Moon Lamps",
      description: "Lamps that are mostly moon.",
      tier: "SOLO",
    });
    expect(await storeByHandle(pool, "no-such-store")).toBeNull();
    expect(JSON.stringify(store)).not.toContain(a.userId);
  });

  // ------------------------------------------------------------------ structural rules
  describe("structural rules (second line)", () => {
    interface Forge {
      paid?: bigint;
      mint?: bigint;
      sink?: bigint;
      sponsorRow?: boolean;
      registration?: boolean;
      succeed?: boolean;
      debit?: string;
    }

    /** Writes a whole registration by hand (as the caller of commitError), varying one part. */
    async function forge(c: pg.PoolClient, u: TestUser, o: Forge = {}): Promise<void> {
      const paid = o.paid ?? FEE;
      const mint = o.mint ?? 0n;
      const sink = o.sink ?? paid + mint;
      const h = handle();
      const [session, att, company, wh, journal] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
      await c.query(
        `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
         VALUES ($1, $2, 'COMPANY_REGISTRATION', jsonb_build_object('handle', $3::text), $4, 1, now() + interval '5 minutes')`,
        [session, u.userId, h, sink.toString()],
      );
      await c.query(
        "INSERT INTO core.payment_attempt (id, session_id, user_id, method, reference) VALUES ($1, $2, $3, 'BALANCE', $4)",
        [att, session, u.userId, `DLP-${randomBytes(8).toString("hex")}`],
      );
      await c.query(
        "INSERT INTO core.company (id, owner_user_id, name, handle, tier) VALUES ($1, $2, 'Forged Shop', $3, 'SOLO')",
        [company, u.userId, h],
      );
      await c.query(
        "INSERT INTO core.warehouse (id, company_id, kind, capacity, used) VALUES ($1, $2, 'STARTER', 100, 0)",
        [wh, company],
      );
      await c.query(
        "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'COMPANY_REGISTRATION', 1)",
        [journal],
      );
      const debit = o.debit ?? u.ledgerAccountId;
      if (paid > 0n) {
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x')",
          [journal, debit, (-paid).toString()],
        );
      }
      if (mint > 0n) {
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x')",
          [journal, MINT, (-mint).toString()],
        );
      }
      await c.query(
        "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x')",
        [journal, SINK, sink.toString()],
      );
      if (o.sponsorRow ?? mint > 0n) {
        await c.query(
          "INSERT INTO core.formation_sponsorship (id, user_id, journal_id, amount_paise) VALUES ($1, $2, $3, $4)",
          [uuidv7(), u.userId, journal, (mint > 0n ? mint : 1n).toString()],
        );
      }
      if (o.registration ?? true) {
        await c.query(
          `INSERT INTO core.company_registration (id, company_id, user_id, session_id, payment_attempt_id, journal_id,
                                                  fee_paise, paid_paise, sponsorship_paise, config_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
          [
            uuidv7(),
            company,
            u.userId,
            session,
            att,
            journal,
            sink.toString(),
            paid.toString(),
            mint.toString(),
          ],
        );
      }
      await c.query(
        `UPDATE ledger.wallet w SET available_paise = (SELECT COALESCE(SUM(p.amount), 0) FROM ledger.posting p WHERE p.account_id = w.account_id)
          WHERE w.account_id = $1`,
        [debit],
      );
      if (o.succeed ?? true) {
        await c.query("UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = $1", [att]);
        await c.query("UPDATE core.checkout_session SET state = 'SUCCEEDED' WHERE id = $1", [session]);
      }
    }
    const owner = (u: TestUser): Actor => ({ userId: u.userId });

    it("control: a hand-written registration that keeps every rule commits (as the owner)", async () => {
      const u = await passportCreator();
      expect(await commitError(pool, owner(u), (c) => forge(c, u))).toBe("no error");
      const poor = await spendCreator(2n * LAKH, true);
      expect(
        await commitError(pool, owner(poor), (c) => forge(c, poor, { paid: 2n * LAKH, mint: 3n * LAKH })),
      ).toBe("no error");
    });

    it("only the owner's command path creates a COMPANY_REGISTRATION journal; application roles cannot insert any of it", async () => {
      const u = await passportCreator();
      expect(await commitError(pool, { role: RAW_WRITER, userId: u.userId }, (c) => forge(c, u))).toMatch(
        /created only by core.commit_company_registration/,
      );
      for (const role of ["app_web", "app_pay"]) {
        const as = { role, userId: u.userId };
        for (const sql of [
          "INSERT INTO ledger.journal (id, event_type, config_version) VALUES (gen_random_uuid(), 'COMPANY_REGISTRATION', 1)",
          "INSERT INTO core.company (id, owner_user_id, name) VALUES (gen_random_uuid(), core.actor_id(), 'Mine')",
          `INSERT INTO core.company_registration (id, company_id, user_id, session_id, payment_attempt_id, journal_id,
             fee_paise, paid_paise, sponsorship_paise, config_version)
           VALUES (gen_random_uuid(), gen_random_uuid(), core.actor_id(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 1, 0, 1)`,
          "INSERT INTO core.formation_sponsorship (id, user_id, journal_id, amount_paise) VALUES (gen_random_uuid(), core.actor_id(), gen_random_uuid(), 1)",
          "INSERT INTO core.handle_reservation (session_id, user_id, handle, expires_at) VALUES (gen_random_uuid(), core.actor_id(), 'abc', now())",
        ]) {
          expect(await stateOf(pool, sql, [], as), `${role}: ${sql.slice(0, 40)}`).toBe("42501");
        }
      }
      // the quote and the registration are money commands: the checkout role only
      for (const fn of [
        "core.commit_company_registration(uuid,uuid,text,bytea)",
        "core.company_quote(text,text,text)",
      ]) {
        const { rows } = await pool.query<{ web: boolean; pay: boolean; jobs: boolean }>(
          `SELECT has_function_privilege('app_web', $1, 'EXECUTE') AS web, has_function_privilege('app_pay', $1, 'EXECUTE') AS pay,
                  has_function_privilege('app_jobs', $1, 'EXECUTE') AS jobs`,
          [fn],
        );
        expect(rows[0], fn).toEqual({ web: false, pay: true, jobs: false });
      }
    });

    it("MINT via COMPANY_REGISTRATION without a sponsorship row is refused", async () => {
      const u = await spendCreator(2n * LAKH, true);
      expect(
        await commitError(pool, owner(u), (c) =>
          forge(c, u, { paid: 2n * LAKH, mint: 3n * LAKH, sponsorRow: false }),
        ),
      ).toMatch(/formation sponsorship of the owner/);
    });

    it("a wrong fee is refused", async () => {
      const u = await passportCreator();
      expect(await commitError(pool, owner(u), (c) => forge(c, u, { paid: FEE - RUPEE }))).toMatch(
        /exactly the configured fee/,
      );
      expect(await commitError(pool, owner(u), (c) => forge(c, u, { paid: FEE + RUPEE }))).toMatch(
        /exactly the configured fee/,
      );
    });

    it("a sponsorship that does not take the whole balance first, or without the quiz, is refused", async () => {
      const rich = await passportCreator(10n * LAKH);
      expect(
        await commitError(pool, owner(rich), (c) => forge(c, rich, { paid: 2n * LAKH, mint: 3n * LAKH })),
      ).toMatch(/exactly the shortfall/);
      const noQuiz = await spendCreator(2n * LAKH, false);
      expect(
        await commitError(pool, owner(noQuiz), (c) => forge(c, noQuiz, { paid: 2n * LAKH, mint: 3n * LAKH })),
      ).toMatch(/quiz/);
    });

    it("a journal without its registration record is refused", async () => {
      const u = await passportCreator();
      expect(
        await commitError(pool, owner(u), (c) => forge(c, u, { registration: false, succeed: false })),
      ).toMatch(/exactly one registration record/);
    });

    it("debiting someone else's account is refused", async () => {
      const u = await passportCreator();
      const victim = await user(pool);
      expect(
        await commitError(pool, owner(u), (c) => forge(c, u, { debit: victim.ledgerAccountId })),
      ).toMatch(/only the acting user/);
    });

    it("a second company for one person is refused", async () => {
      const u = await passportCreator();
      await registered(u);
      expect(await commitError(pool, owner(u), (c) => forge(c, u))).toMatch(
        /one_company_per_owner|duplicate key/,
      );
    });

    it("nothing joins a sealed registration journal", async () => {
      const u = await passportCreator();
      const { receipt } = await registered(u);
      const journal = await journalOf(receipt.companyId);
      expect(
        await commitError(pool, {}, (c) =>
          c.query(
            "INSERT INTO core.formation_sponsorship (id, user_id, journal_id, amount_paise) VALUES ($1, $2, $3, 1)",
            [uuidv7(), u.userId, journal],
          ),
        ),
      ).toMatch(/sealed/);
      expect(
        await commitError(pool, {}, (c) =>
          c.query("DELETE FROM core.company_registration WHERE journal_id = $1", [journal]),
        ),
      ).toMatch(/never deleted/);
    });
  });
});
