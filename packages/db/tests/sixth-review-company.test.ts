import { randomBytes } from "node:crypto";
import { RESERVED_HANDLES } from "@delulu/core";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HANDLE_AGREEMENT_CASES } from "../../core/src/screening/handle-cases";
import { createPaymentAttempt, PayFailure } from "../src/checkout";
import { companyQuote, registerCompany } from "../src/company";
import { CLEAN, codeOf, count, type ProductFixture, reconcile, user, wallet } from "./checkout-fixtures";
import { createTestDatabase, plant, stateOf, type TestDatabase, type TestUser, uuidv7 } from "./helpers";
import { completePassport, passQuiz, published, spendTo } from "./selling-fixtures";

const handle = (): string => `lamps-${randomBytes(5).toString("hex")}`;

/** Sixth security review: store handles (minors 5, 6; migration 0049) and the sponsorship (minor 11). */
describe("sixth security review: store handles and the formation sponsorship", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    items = await published(pool, 3);
  }, 120_000);
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const creator = async (): Promise<TestUser> => {
    const u = await user(pool);
    await completePassport(pool, u, items);
    return u;
  };
  const quote = (u: TestUser, h: string) =>
    companyQuote(pool, {
      authSessionId: u.authSessionId,
      handle: h,
      displayName: "Moon Lamps",
      description: "",
    });
  /** Ends the user's reservations `minutes` ago, unpaid (as time passing would). */
  const lapse = (u: TestUser, minutes: number) =>
    plant(pool, async (x) => {
      await x.query(
        `UPDATE core.handle_reservation SET expires_at = now() - make_interval(mins => $2),
                released_at = CASE WHEN released_at IS NULL THEN NULL ELSE now() - make_interval(mins => $2) END
          WHERE user_id = $1`,
        [u.userId, minutes],
      );
      await x.query(
        "UPDATE core.checkout_session SET expires_at = now() - make_interval(mins => $2) WHERE user_id = $1 AND type = 'COMPANY_REGISTRATION'",
        [u.userId, minutes],
      );
    });

  // ------------------------------------------------------------------ minor 6
  it.each(HANDLE_AGREEMENT_CASES.map((c) => [c.handle, c.accepted] as const))(
    "minor 6 (shared table with packages/core): %s accepted=%s",
    async (h, accepted) => {
      const { rows } = await pool.query<{ p: string[] | null }>("SELECT core.store_handle_problem($1) AS p", [
        h,
      ]);
      expect(rows[0]?.p ?? null).toEqual(accepted ? null : ["HANDLE_TAKEN", "this handle is not available"]);
    },
  );

  it("minor 6: the database's reserved list is core's; a look-alike company is refused by the CHECK, whoever writes it", async () => {
    const { rows } = await pool.query<{ r: string[] }>("SELECT core.reserved_store_handles() AS r");
    expect([...(rows[0]?.r ?? [])].sort()).toEqual([...RESERVED_HANDLES].sort());
    const owner = await user(pool);
    for (const h of ["de1ulumart", "admin-team", "support-desk", "official-store"]) {
      expect(
        await stateOf(
          pool,
          "INSERT INTO core.company (id, owner_user_id, name, handle) VALUES ($1, $2, 'Look Alike', $3)",
          [uuidv7(), owner.userId, h],
        ),
        h,
      ).toBe("23514");
    }
    expect(
      await stateOf(
        pool,
        "INSERT INTO core.company (id, owner_user_id, name, handle) VALUES ($1, $2, 'Moon Lamps', $3)",
        [uuidv7(), owner.userId, handle()],
      ),
    ).toBe("no error");
  });

  it("minor 6: the reviewer's look-alikes are refused at the quote", async () => {
    const u = await creator();
    for (const h of ["de1ulumart", "deluiumart", "admin-team", "support-desk"]) {
      expect(await codeOf(quote(u, h)), h).toBe("HANDLE_TAKEN");
    }
  });

  // ------------------------------------------------------------------ minor 5
  it("minor 5: quoting the same handle again never extends its hold", async () => {
    const u = await creator();
    const h = handle();
    const first = await quote(u, h);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await quote(u, h);
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(again.expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });

  it("minor 5: after a hold lapses unpaid, the same person cannot reserve that handle for 30 minutes; anyone else can", async () => {
    const u = await creator();
    const h = handle();
    await quote(u, h);
    await lapse(u, 1);
    expect(await codeOf(quote(u, h))).toBe("HANDLE_RESERVED");
    const other = await creator();
    expect(await codeOf(quote(other, h))).toBe("ok");
    // the same person, half an hour later (and once the other's hold has lapsed too)
    const v = await creator();
    const h2 = handle();
    await quote(v, h2);
    await lapse(v, 29);
    expect(await codeOf(quote(v, h2))).toBe("HANDLE_RESERVED");
    await lapse(v, 31);
    expect(await codeOf(quote(v, h2))).toBe("ok");
  });

  it("minor 5: switching to another handle releases the first, which is then held back from the same person", async () => {
    const u = await creator();
    const [a, b] = [handle(), handle()];
    await quote(u, a);
    await quote(u, b);
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
          WHERE r.user_id = $1 AND r.released_at IS NULL AND cs.state = 'OPEN' AND r.expires_at > now()`,
        [u.userId],
      ),
    ).toBe(1);
    expect(await codeOf(quote(u, a))).toBe("HANDLE_RESERVED");
  });

  it("minor 5: at most five quotes per person per hour", async () => {
    const u = await creator();
    for (let i = 0; i < 5; i++) expect(await codeOf(quote(u, handle()))).toBe("ok");
    expect(await codeOf(quote(u, handle()))).toBe("RATE_LIMITED");
    await plant(pool, (x) =>
      x.query(
        "UPDATE core.checkout_session SET created_at = created_at - interval '61 minutes' WHERE user_id = $1 AND type = 'COMPANY_REGISTRATION'",
        [u.userId],
      ),
    );
    expect(await codeOf(quote(u, handle()))).toBe("ok");
  });

  it("minor 5: a second live reservation for one person is refused whoever writes it", async () => {
    const u = await creator();
    const q = await quote(u, handle());
    const sid = uuidv7();
    expect(
      await stateOf(
        pool,
        `WITH s AS (INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
                    VALUES ($1, $2, 'COMPANY_REGISTRATION', '{}'::jsonb, 1, 1, now() + interval '5 minutes') RETURNING id)
         INSERT INTO core.handle_reservation (session_id, user_id, handle, expires_at)
         SELECT id, $2, $3, now() + interval '5 minutes' FROM s`,
        [sid, u.userId, handle()],
      ),
    ).toBe("23514");
    expect(q.sessionId).toBeTruthy();
  });

  // ------------------------------------------------------------------ minor 11
  it("minor 11 (US-19): a person who already had a formation sponsorship gets no second one — the registration fails INSUFFICIENT_FUNDS and nothing is debited", async () => {
    const u = await user(pool);
    await spendTo(pool, u, 100_000n); // ₹1,000: well below the fee
    await passQuiz(pool, u);
    // a sponsorship this person already had (planted: one company per person means the commands
    // cannot give a second chance to reach this check)
    await plant(pool, (x) =>
      x.query(
        "INSERT INTO core.formation_sponsorship (id, user_id, journal_id, amount_paise) VALUES ($1, $2, $3, 1000)",
        [uuidv7(), u.userId, uuidv7()],
      ),
    );
    const before = await wallet(pool, u.ledgerAccountId);
    const q = await quote(u, handle());
    expect(q).toMatchObject({ sponsorshipPaise: 0n, sufficient: false });
    const a = await createPaymentAttempt(pool, {
      authSessionId: u.authSessionId,
      sessionId: q.sessionId,
      method: "BALANCE",
    });
    let refusal: unknown = null;
    try {
      await registerCompany(pool, {
        authSessionId: u.authSessionId,
        sessionId: q.sessionId,
        attemptId: a.attemptId,
        idempotencyKey: `k-${uuidv7()}`,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PayFailure);
    expect((refusal as PayFailure).code).toBe("INSUFFICIENT_FUNDS");
    expect(await wallet(pool, u.ledgerAccountId)).toBe(before);
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM ledger.journal j JOIN ledger.posting p ON p.journal_id = j.id
          WHERE j.event_type = 'COMPANY_REGISTRATION' AND p.account_id = $1`,
        [u.ledgerAccountId],
      ),
    ).toBe(0);
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.formation_sponsorship WHERE user_id = $1", [
        u.userId,
      ]),
    ).toBe(1);
  });
});
