import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetCardPin, setCardFrozen, setCardPin, verifyCardPin } from "../src/card";
import { createCheckoutSession, createPaymentAttempt, pay } from "../src/checkout";
import {
  CLEAN,
  codeOf,
  key,
  type ProductFixture,
  product,
  RUPEE,
  reconcile,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import { createTestDatabase, stateOf, type TestDatabase, type TestUser } from "./helpers";

const PIN = Buffer.alloc(32, 1);
const WRONG = Buffer.alloc(32, 2);
const NEW_PIN = Buffer.alloc(32, 3);

describe("US-48: Delulu PIN inside the database", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let seed: ProductFixture;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  async function session(buyer: TestUser): Promise<string> {
    const s = await createCheckoutSession(pool, {
      authSessionId: buyer.authSessionId,
      lines: [{ productId: seed.id }],
      speedBySeller: standard("SEED"),
      idempotencyKey: key(),
    });
    return s.sessionId;
  }
  async function cardAttempt(
    buyer: TestUser,
    sessionId?: string,
  ): Promise<{ sessionId: string; attemptId: string }> {
    const sid = sessionId ?? (await session(buyer));
    const a = await createPaymentAttempt(pool, {
      authSessionId: buyer.authSessionId,
      sessionId: sid,
      method: "CARD",
      cardId: buyer.cardId,
    });
    return { sessionId: sid, attemptId: a.attemptId };
  }
  async function withPin(): Promise<TestUser> {
    const buyer = await user(pool);
    await setCardPin(pool, { authSessionId: buyer.authSessionId, cardId: buyer.cardId, pinMac: PIN });
    return buyer;
  }
  const verify = (buyer: TestUser, attemptId: string, pinMac: Buffer) =>
    verifyCardPin(pool, { authSessionId: buyer.authSessionId, attemptId, pinMac });
  const errorOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; details?: Record<string, unknown> }) => e,
    );
  async function card(buyer: TestUser) {
    const { rows } = await pool.query<{
      failed_pin_count: number;
      locked_for: number | null;
      pin_hash: string | null;
    }>(
      `SELECT failed_pin_count, pin_hash,
              round(extract(epoch FROM pin_locked_until - now()))::int AS locked_for
         FROM core.virtual_card WHERE id = $1`,
      [buyer.cardId],
    );
    const r = rows[0];
    if (!r) throw new Error("no card");
    return r;
  }
  async function attempt(attemptId: string) {
    const { rows } = await pool.query<{ state: string; failure_code: string | null; authenticated: boolean }>(
      "SELECT state, failure_code, authenticated_at IS NOT NULL AS authenticated FROM core.payment_attempt WHERE id = $1",
      [attemptId],
    );
    return rows[0];
  }
  const payWith = (buyer: TestUser, a: { sessionId: string; attemptId: string }) =>
    pay(pool, { authSessionId: buyer.authSessionId, ...a, idempotencyKey: key() });

  it("US-48: a card payment without a PIN set is PIN_NOT_SET, and counts nothing", async () => {
    const buyer = await user(pool);
    const a = await cardAttempt(buyer);
    expect(await codeOf(verify(buyer, a.attemptId, PIN))).toBe("PIN_NOT_SET");
    expect(await attempt(a.attemptId)).toEqual({
      state: "PENDING",
      failure_code: null,
      authenticated: false,
    });
    expect((await card(buyer)).failed_pin_count).toBe(0);
    expect(await codeOf(payWith(buyer, a))).toBe("PAYMENT_PENDING");
  });

  it("US-48: a correct PIN pays once", async () => {
    const buyer = await withPin();
    const a = await cardAttempt(buyer);
    await verify(buyer, a.attemptId, PIN);
    expect(await attempt(a.attemptId)).toMatchObject({ state: "PENDING", authenticated: true });
    const before = await wallet(pool, buyer.ledgerAccountId);
    const receipt = await payWith(buyer, a);
    expect(await wallet(pool, buyer.ledgerAccountId)).toBe(before - receipt.totalPaise);
    // the PIN step is not repeatable on a completed attempt
    expect(await codeOf(verify(buyer, a.attemptId, PIN))).toBe("CONFLICT");
  });

  it("US-48: three wrong PINs fail the payment (CHALLENGE_LOCKED) with no debit", async () => {
    const buyer = await withPin();
    const a = await cardAttempt(buyer);
    const before = await wallet(pool, buyer.ledgerAccountId);
    const first = await errorOf(verify(buyer, a.attemptId, WRONG));
    expect(first).toMatchObject({ code: "PIN_INCORRECT", details: { remainingTries: 2 } });
    expect(await errorOf(verify(buyer, a.attemptId, WRONG))).toMatchObject({
      code: "PIN_INCORRECT",
      details: { remainingTries: 1 },
    });
    expect(await codeOf(verify(buyer, a.attemptId, WRONG))).toBe("CHALLENGE_LOCKED");
    expect(await attempt(a.attemptId)).toEqual({
      state: "FAILED",
      failure_code: "CHALLENGE_LOCKED",
      authenticated: false,
    });
    // the failures persisted although the caller saw errors
    expect((await card(buyer)).failed_pin_count).toBe(3);
    // even the right PIN cannot revive the attempt, and pay debits nothing
    expect(await codeOf(verify(buyer, a.attemptId, PIN))).toBe("CONFLICT");
    expect(await codeOf(payWith(buyer, a))).not.toBe("ok");
    expect(await wallet(pool, buyer.ledgerAccountId)).toBe(before);
  });

  it("US-48: five consecutive wrong PINs lock the card for 15 minutes; other methods still work", async () => {
    const buyer = await withPin();
    const sid = await session(buyer);
    const a1 = await cardAttempt(buyer, sid);
    for (let i = 0; i < 3; i++) await codeOf(verify(buyer, a1.attemptId, WRONG));
    const a2 = await cardAttempt(buyer, sid);
    expect(await errorOf(verify(buyer, a2.attemptId, WRONG))).toMatchObject({
      code: "PIN_INCORRECT",
      details: { remainingTries: 1 },
    });
    expect(await codeOf(verify(buyer, a2.attemptId, WRONG))).toBe("PIN_LOCKED");
    const locked = await card(buyer);
    expect(locked.failed_pin_count).toBe(5);
    expect(locked.locked_for).toBeGreaterThan(14 * 60);
    expect(locked.locked_for).toBeLessThanOrEqual(15 * 60);
    // while locked, even the right PIN is refused, before any comparison
    const a3 = await cardAttempt(buyer, sid);
    expect(await codeOf(verify(buyer, a3.attemptId, PIN))).toBe("PIN_LOCKED");
    expect((await card(buyer)).failed_pin_count).toBe(5);
    // a balance payment still goes through
    const balance = await createPaymentAttempt(pool, {
      authSessionId: buyer.authSessionId,
      sessionId: sid,
      method: "BALANCE",
    });
    expect(balance.authenticated).toBe(true);
    expect(await codeOf(payWith(buyer, { sessionId: sid, attemptId: balance.attemptId }))).toBe("ok");
  });

  it("US-48: after the lock expires one more wrong PIN locks again; a correct PIN resets the counter", async () => {
    const buyer = await withPin();
    const sid = await session(buyer);
    const a1 = await cardAttempt(buyer, sid);
    await codeOf(verify(buyer, a1.attemptId, WRONG));
    await codeOf(verify(buyer, a1.attemptId, WRONG));
    expect((await card(buyer)).failed_pin_count).toBe(2);
    await verify(buyer, a1.attemptId, PIN);
    expect((await card(buyer)).failed_pin_count).toBe(0);

    // a lock that has expired: the next wrong guess is the sixth in a row
    await pool.query(
      "UPDATE core.virtual_card SET failed_pin_count = 5, pin_locked_until = now() - interval '1 second' WHERE id = $1",
      [buyer.cardId],
    );
    const a2 = await cardAttempt(buyer, sid);
    expect(await codeOf(verify(buyer, a2.attemptId, WRONG))).toBe("PIN_LOCKED");
    expect((await card(buyer)).locked_for).toBeGreaterThan(14 * 60);
  });

  it("US-48: parallel guesses cannot exceed the limits (10 concurrent wrong PINs)", async () => {
    // one attempt: exactly three guesses count, the attempt fails, the rest are refused
    const one = await withPin();
    const a = await cardAttempt(one);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => codeOf(verify(one, a.attemptId, WRONG))),
    );
    expect(outcomes.filter((o) => o === "PIN_INCORRECT")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "CHALLENGE_LOCKED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "CONFLICT")).toHaveLength(7);
    expect((await card(one)).failed_pin_count).toBe(3);
    const { rows } = await pool.query<{ used: number }>(
      "SELECT attempts_used AS used FROM core.payment_challenge WHERE attempt_id = $1",
      [a.attemptId],
    );
    expect(rows[0]?.used).toBe(3);
    expect(await attempt(a.attemptId)).toMatchObject({ state: "FAILED", failure_code: "CHALLENGE_LOCKED" });

    // four attempts on one card: exactly five guesses count, then the card is locked
    const many = await withPin();
    const sid = await session(many);
    const attempts: { sessionId: string; attemptId: string }[] = [];
    for (let i = 0; i < 4; i++) attempts.push(await cardAttempt(many, sid));
    const spread = await Promise.all(
      Array.from({ length: 10 }, (_, i) => codeOf(verify(many, attempts[i % 4]?.attemptId ?? "", WRONG))),
    );
    const counted = spread.filter((o) => ["PIN_INCORRECT", "CHALLENGE_LOCKED"].includes(o)).length;
    const locking = spread.filter((o) => o === "PIN_LOCKED").length;
    expect(
      spread.every((o) => ["PIN_INCORRECT", "CHALLENGE_LOCKED", "PIN_LOCKED", "CONFLICT"].includes(o)),
    ).toBe(true);
    expect(counted).toBe(4);
    expect(locking).toBeGreaterThanOrEqual(1);
    const c = await card(many);
    expect(c.failed_pin_count).toBe(5);
    expect(c.locked_for).toBeGreaterThan(14 * 60);
  });

  it("US-48: changing the PIN needs the current one; a wrong current PIN counts as a wrong PIN", async () => {
    const buyer = await withPin();
    const change = (currentPinMac: Buffer | null) =>
      setCardPin(pool, {
        authSessionId: buyer.authSessionId,
        cardId: buyer.cardId,
        pinMac: NEW_PIN,
        currentPinMac,
      });
    expect(await codeOf(change(null))).toBe("VALIDATION_FAILED");
    expect(await errorOf(change(WRONG))).toMatchObject({
      code: "PIN_INCORRECT",
      details: { remainingTries: 4 },
    });
    expect((await card(buyer)).failed_pin_count).toBe(1);
    await change(PIN);
    expect((await card(buyer)).failed_pin_count).toBe(0);
    const a = await cardAttempt(buyer);
    expect(await codeOf(verify(buyer, a.attemptId, PIN))).toBe("PIN_INCORRECT");
    expect(await codeOf(verify(buyer, a.attemptId, NEW_PIN))).toBe("ok");
    // guessing through the change path locks the card like any other guess
    for (let i = 0; i < 4; i++) await codeOf(change(WRONG));
    expect(await codeOf(change(WRONG))).toBe("PIN_LOCKED");
    expect(await codeOf(change(NEW_PIN))).toBe("PIN_LOCKED");
  });

  it("US-48: a reset needs a sign-in within five minutes, and clears a lock", async () => {
    const buyer = await withPin();
    await pool.query(
      "UPDATE core.virtual_card SET failed_pin_count = 5, pin_locked_until = now() + interval '15 minutes' WHERE id = $1",
      [buyer.cardId],
    );
    await pool.query("UPDATE auth.sessions SET created_at = now() - interval '6 minutes' WHERE id = $1", [
      buyer.authSessionId,
    ]);
    const reset = () =>
      resetCardPin(pool, { authSessionId: buyer.authSessionId, cardId: buyer.cardId, pinMac: NEW_PIN });
    expect(await codeOf(reset())).toBe("REAUTH_REQUIRED");
    await pool.query("UPDATE auth.sessions SET created_at = now() - interval '1 minute' WHERE id = $1", [
      buyer.authSessionId,
    ]);
    await reset();
    const c = await card(buyer);
    expect(c.failed_pin_count).toBe(0);
    expect(c.locked_for).toBeNull();
    const a = await cardAttempt(buyer);
    expect(await codeOf(verify(buyer, a.attemptId, NEW_PIN))).toBe("ok");
  });

  it("US-48: the stored hash is bcrypt of the mac, never the mac, and no application role can read it", async () => {
    const buyer = await withPin();
    const { pin_hash } = await card(buyer);
    expect(pin_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(pin_hash).not.toContain(PIN.toString("hex"));
    for (const role of ["app_web", "app_pay", "app_jobs"]) {
      const as = { role, userId: buyer.userId };
      for (const col of ["pin_hash", "pin_salt", "*"]) {
        expect(
          await stateOf(pool, `SELECT ${col} FROM core.virtual_card WHERE id = $1`, [buyer.cardId], as),
          `${role} ${col}`,
        ).toBe("42501");
      }
      expect(
        await stateOf(
          pool,
          "SELECT status, pin_set_at FROM core.virtual_card WHERE id = $1",
          [buyer.cardId],
          as,
        ),
        role,
        // sixth review (0047): app_jobs reads no table directly
      ).toBe(role === "app_jobs" ? "42501" : "no error");
      // nor can any of them move the PIN columns or counters
      expect(
        await stateOf(
          pool,
          "UPDATE core.virtual_card SET failed_pin_count = 0, pin_locked_until = NULL WHERE id = $1",
          [buyer.cardId],
          as,
        ),
        role,
      ).toBe("42501");
    }
  });

  it("US-15: a frozen card cannot pay; the owner unfreezes it", async () => {
    const buyer = await withPin();
    const a = await cardAttempt(buyer);
    await verify(buyer, a.attemptId, PIN);
    expect(
      await setCardFrozen(pool, { authSessionId: buyer.authSessionId, cardId: buyer.cardId, frozen: true }),
    ).toBe("FROZEN");
    const before = await wallet(pool, buyer.ledgerAccountId);
    expect(await codeOf(payWith(buyer, a))).toBe("CARD_FROZEN");
    expect(await wallet(pool, buyer.ledgerAccountId)).toBe(before);
    expect(
      await codeOf(
        createPaymentAttempt(pool, {
          authSessionId: buyer.authSessionId,
          sessionId: a.sessionId,
          method: "CARD",
          cardId: buyer.cardId,
        }),
      ),
    ).toBe("CARD_FROZEN");
    expect(
      await setCardFrozen(pool, { authSessionId: buyer.authSessionId, cardId: buyer.cardId, frozen: false }),
    ).toBe("ACTIVE");
    const b = await cardAttempt(buyer);
    await setCardFrozen(pool, { authSessionId: buyer.authSessionId, cardId: buyer.cardId, frozen: true });
    expect(await codeOf(verify(buyer, b.attemptId, PIN))).toBe("CARD_FROZEN");
    await setCardFrozen(pool, { authSessionId: buyer.authSessionId, cardId: buyer.cardId, frozen: false });
  });

  it("US-48: another user's card or attempt is refused by every card command", async () => {
    const owner = await withPin();
    const other = await user(pool);
    const a = await cardAttempt(owner);
    const as = other.authSessionId;
    expect(await codeOf(setCardPin(pool, { authSessionId: as, cardId: owner.cardId, pinMac: NEW_PIN }))).toBe(
      "CARD_NOT_OWNED",
    );
    expect(
      await codeOf(resetCardPin(pool, { authSessionId: as, cardId: owner.cardId, pinMac: NEW_PIN })),
    ).toBe("CARD_NOT_OWNED");
    expect(await codeOf(setCardFrozen(pool, { authSessionId: as, cardId: owner.cardId, frozen: true }))).toBe(
      "CARD_NOT_OWNED",
    );
    expect(
      await codeOf(verifyCardPin(pool, { authSessionId: as, attemptId: a.attemptId, pinMac: PIN })),
    ).toBe("NOT_FOUND");
    expect((await card(owner)).failed_pin_count).toBe(0);
    expect(await attempt(a.attemptId)).toMatchObject({ state: "PENDING", authenticated: false });
  });

  it("only core.verify_card_pin authenticates a CARD attempt; BALANCE attempts are authenticated at creation", async () => {
    const { rows } = await pool.query<{ f: string | null }>(
      "SELECT to_regprocedure('core.mark_attempt_authenticated(uuid)')::text AS f",
    );
    expect(rows[0]?.f).toBeNull();
    const buyer = await withPin();
    const sid = await session(buyer);
    const balance = await createPaymentAttempt(pool, {
      authSessionId: buyer.authSessionId,
      sessionId: sid,
      method: "BALANCE",
    });
    expect(balance.authenticated).toBe(true);
    expect(await codeOf(verify(buyer, balance.attemptId, PIN))).toBe("CONFLICT");
    // the application roles cannot stamp authentication themselves
    const a = await cardAttempt(buyer, sid);
    for (const role of ["app_web", "app_pay"]) {
      expect(
        await stateOf(
          pool,
          "UPDATE core.payment_attempt SET authenticated_at = now() WHERE id = $1",
          [a.attemptId],
          {
            role,
            userId: buyer.userId,
          },
        ),
        role,
      ).toBe("42501");
    }
  });

  it("the card commands refuse without a session and are app_pay's only", async () => {
    const buyer = await withPin();
    for (const [sql, params] of [
      ["SELECT * FROM core.set_card_pin($1, $2)", [buyer.cardId, NEW_PIN]],
      ["SELECT core.reset_card_pin($1, $2)", [buyer.cardId, NEW_PIN]],
      ["SELECT * FROM core.verify_card_pin($1, $2)", [buyer.cardId, NEW_PIN]],
      ["SELECT core.set_card_frozen($1, true)", [buyer.cardId]],
    ] as const) {
      expect(await stateOf(pool, sql, [...params], { role: "app_pay" }), sql).toBe("DM001");
      expect(await stateOf(pool, sql, [...params], { role: "app_web", userId: buyer.userId }), sql).toBe(
        "42501",
      );
    }
    expect(
      await codeOf(
        setCardPin(pool, {
          authSessionId: buyer.authSessionId,
          cardId: buyer.cardId,
          pinMac: Buffer.alloc(6),
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});
