import {
  CHALLENGE_RULES,
  DomainError,
  describeFailure,
  displayStatus,
  METHOD_DEFAULT_ORDER,
  PAYMENT_METHODS,
  PAYMENT_SCENARIOS,
  TEST_DELULUPAY_IDS,
} from "@delulu/core";
import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { myOrders, myStatement } from "../src/account";
import { executeDueAdminActions } from "../src/admin-actions";
import { recordEvent } from "../src/analytics";
import { createCheckoutSession, createPaymentAttempt, pay } from "../src/checkout";
import {
  adminPaymentMethods,
  cancelPaymentAttempt,
  checkoutPaymentMethods,
  issuePaymentChallenge,
  myBankInbox,
  myPaymentAttempt,
  myPayments,
  proposePaymentMethodChange,
  verifyPaymentChallenge,
} from "../src/payment";
import {
  CLEAN,
  checkout,
  count,
  journalPostings,
  key,
  type ProductFixture,
  product,
  RUPEE,
  reconcile,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import { asActor, createTestDatabase, stateOf, type TestDatabase, type TestUser } from "./helpers";

/**
 * DeluluPay (migrations 0100-0103; PRD R4, R10; US-34 to US-37): the new methods, the authentication
 * step and the in-app bank inbox, the method configuration through the delayed queue, the test
 * scenarios and the Payments list.
 */
const REASON = "Scheduled change agreed with the team";

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    return `${(e as { code?: string }).code ?? "unexpected"}`;
  }
  return "ok";
}

describe("DeluluPay methods, challenge and configuration", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;
  let lamp: ProductFixture;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
    lamp = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 5_000n * RUPEE });
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  const newBuyer = () => user(pool);
  const quote = (buyer: TestUser, p: ProductFixture = lamp) =>
    createCheckoutSession(pool, {
      authSessionId: buyer.authSessionId,
      lines: [{ productId: p.id }],
      speedBySeller: standard("SEED"),
      idempotencyKey: key(),
    });
  const idOf = async (buyer: TestUser) =>
    (
      await pool.query<{ id: string }>(
        "SELECT upi_style_id AS id FROM core.bank_account WHERE user_id = $1",
        [buyer.userId],
      )
    ).rows[0]?.id as string;
  const attempt = (
    buyer: TestUser,
    sessionId: string,
    method: (typeof PAYMENT_METHODS)[number],
    extra = {},
  ) => createPaymentAttempt(pool, { authSessionId: buyer.authSessionId, sessionId, method, ...extra });
  const issue = (buyer: TestUser, sessionId: string) =>
    issuePaymentChallenge(pool, { authSessionId: buyer.authSessionId, sessionId });
  const verify = (
    buyer: TestUser,
    sessionId: string,
    v: { code?: string; decision?: "APPROVE" | "DECLINE" },
  ) => verifyPaymentChallenge(pool, { authSessionId: buyer.authSessionId, sessionId, ...v });
  const inbox = (buyer: TestUser) => myBankInbox(pool, { authSessionId: buyer.authSessionId });
  const openCode = async (buyer: TestUser): Promise<string> => {
    const m = (await inbox(buyer)).find((x) => x.status === "OPEN" && x.code !== undefined);
    if (!m?.code) throw new Error("no open code in the inbox");
    return m.code;
  };
  const payWith = (buyer: TestUser, sessionId: string, attemptId: string) =>
    pay(pool, { authSessionId: buyer.authSessionId, sessionId, attemptId, idempotencyKey: key() });
  const stateRow = async (attemptId: string) =>
    (
      await pool.query<{ state: string; failure_code: string | null; authenticated_at: Date | null }>(
        "SELECT state, failure_code, authenticated_at FROM core.payment_attempt WHERE id = $1",
        [attemptId],
      )
    ).rows[0];
  /** Pays with DeluluPay ID, approved in the inbox. */
  const approvedPurchase = async (buyer: TestUser) => {
    const q = await quote(buyer);
    const a = await attempt(buyer, q.sessionId, "DELULUPAY_ID", { delulupayId: await idOf(buyer) });
    await issue(buyer, q.sessionId);
    await verify(buyer, q.sessionId, { decision: "APPROVE" });
    return { q, a, receipt: await payWith(buyer, q.sessionId, a.attemptId) };
  };
  /** Moves a challenge (and its inbox message) back in time, as the clock passing would. Owner only. */
  const backdateChallenge = async (attemptId: string, seconds: number) => {
    await pool.query(
      `UPDATE core.payment_challenge
          SET issued_at = issued_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2)
        WHERE attempt_id = $1`,
      [attemptId, seconds],
    );
    await pool.query(
      `UPDATE core.bank_inbox_message
          SET created_at = created_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2)
        WHERE attempt_id = $1 AND cleared_at IS NULL`,
      [attemptId, seconds],
    );
  };
  const fresh = () => product(pool, { mode: "UNLIMITED_SEED", pricePaise: 5_000n * RUPEE });
  /** Queues a method change as the Super Admin, makes it due and runs the executor (as the jobs run would). */
  const changeMethod = async (
    method: (typeof PAYMENT_METHODS)[number],
    over: Partial<Parameters<typeof proposePaymentMethodChange>[1]["change"]> = {},
  ) => {
    const current = (await adminPaymentMethods(pool, { authSessionId: admin.authSessionId })).methods.find(
      (m) => m.method === method,
    );
    if (!current) throw new Error("no such method");
    const action = (await proposePaymentMethodChange(pool, {
      authSessionId: admin.authSessionId,
      reason: REASON,
      change: {
        method,
        enabled: current.enabled,
        displayOrder: current.displayOrder,
        perAttemptLimitPaise: current.perAttemptLimitPaise,
        perDayLimitPaise: current.perDayLimitPaise,
        maintenanceFrom: current.maintenanceFrom,
        maintenanceUntil: current.maintenanceUntil,
        ...over,
      },
    })) as { id: string };
    await pool.query(
      "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
      [action.id],
    );
    const run = await executeDueAdminActions(pool);
    expect(run.failed).toBe(0);
    return action.id;
  };

  describe("methods (US-35)", () => {
    it("US-35: a DeluluPay ID payment is approved in the bank inbox and gives the same ledger result as a balance payment", async () => {
      const a = await newBuyer();
      const b = await newBuyer();
      const viaBalance = await (async () => {
        const co = await checkout(pool, b, [lamp], standard("SEED"));
        return payWith(b, co.sessionId, co.attemptId);
      })();
      const before = await wallet(pool, a.ledgerAccountId);
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "DELULUPAY_ID", { delulupayId: await idOf(a) });
      expect(at.authenticated).toBe(false);
      // not authenticated yet: the pay step waits for the approval
      expect(await codeOf(payWith(a, q.sessionId, at.attemptId))).toBe("PAYMENT_PENDING");
      await issue(a, q.sessionId);
      const [msg] = await inbox(a);
      expect(msg).toMatchObject({ kind: "APPROVAL", status: "OPEN", amountPaise: q.totalPaise });
      expect(msg?.code).toBeUndefined();
      expect((await verify(a, q.sessionId, { decision: "APPROVE" })).status).toBe("AUTHENTICATED");
      const receipt = await payWith(a, q.sessionId, at.attemptId);
      expect(receipt.totalPaise).toBe(viaBalance.totalPaise);
      expect(before - (await wallet(pool, a.ledgerAccountId))).toBe(q.totalPaise);
      const postings = await journalPostings(pool, receipt.orderGroupId);
      expect([...postings.values()].reduce((x, y) => x + y, 0n)).toBe(0n);
      expect(postings.get(a.ledgerAccountId)).toBe(-q.totalPaise);
      expect(await reconcile(pool)).toEqual(CLEAN);
    });

    it("US-35 and US-36: net banking shows a bank page, sends a code to the inbox and pays after the right code", async () => {
      const a = await newBuyer();
      const before = await wallet(pool, a.ledgerAccountId);
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      const view = await myPaymentAttempt(pool, { authSessionId: a.authSessionId, attemptId: at.attemptId });
      expect(view).toMatchObject({ method: "NET_BANKING", status: "CREATED", amountPaise: q.totalPaise });
      expect(view.bankAlias).toBeTruthy();
      const issued = await issue(a, q.sessionId);
      expect(issued).toMatchObject({ kind: "CODE", resendAfterSeconds: CHALLENGE_RULES.resendSeconds });
      expect(JSON.stringify(issued)).not.toMatch(/"code"/);
      expect(
        (await myPaymentAttempt(pool, { authSessionId: a.authSessionId, attemptId: at.attemptId })).status,
      ).toBe("AUTHENTICATING");
      const code = await openCode(a);
      expect(code).toMatch(/^\d{6}$/);
      expect((await verify(a, q.sessionId, { code })).status).toBe("AUTHENTICATED");
      expect(
        (await myPaymentAttempt(pool, { authSessionId: a.authSessionId, attemptId: at.attemptId })).status,
      ).toBe("AUTHORISED");
      await payWith(a, q.sessionId, at.attemptId);
      expect(before - (await wallet(pool, a.ledgerAccountId))).toBe(q.totalPaise);
      // the code is scrubbed once used
      expect((await inbox(a)).every((m) => m.code === undefined)).toBe(true);
      expect(await reconcile(pool)).toEqual(CLEAN);
    });

    it("US-37 and US-35: a DeluluPay ID must be the payer's own and end in @delulu; nothing is created otherwise", async () => {
      const a = await newBuyer();
      const other = await newBuyer();
      const q = await quote(a);
      const attemptsBefore = await count(
        pool,
        "SELECT count(*) AS n FROM core.payment_attempt WHERE user_id = $1",
        [a.userId],
      );
      for (const id of [
        await idOf(other),
        "someone@okaxis",
        "9876543210@ybl",
        "4111111111111111",
        "x@delulu",
      ]) {
        expect(await codeOf(attempt(a, q.sessionId, "DELULUPAY_ID", { delulupayId: id })), id).toBe(
          "VALIDATION_FAILED",
        );
      }
      // straight to the database: the same refusals
      for (const id of ["someone@okaxis", "4111 1111 1111 1111", await idOf(other)]) {
        expect(
          await stateOf(
            pool,
            "SELECT core.start_payment_attempt($1, 'DELULUPAY_ID', NULL, $2, NULL)",
            [q.sessionId, id],
            {
              role: "app_pay",
              sessionId: a.authSessionId,
            },
          ),
          id,
        ).toBe("DM001");
      }
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.payment_attempt WHERE user_id = $1", [a.userId]),
      ).toBe(attemptsBefore);
    });

    it("US-35: a company registration still takes BALANCE or CARD only (decisions.md #17)", async () => {
      const a = await newBuyer();
      const sessionId = (await import("../src/uuid")).uuidv7();
      await pool.query(
        `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
         VALUES ($1, $2, 'COMPANY_REGISTRATION', '{}'::jsonb, 50000000, core.current_config_id(), now() + interval '5 minutes')`,
        [sessionId, a.userId],
      );
      expect(await codeOf(attempt(a, sessionId, "NET_BANKING"))).toBe("METHOD_UNAVAILABLE");
      expect(await codeOf(attempt(a, sessionId, "DELULUPAY_ID", { delulupayId: await idOf(a) }))).toBe(
        "METHOD_UNAVAILABLE",
      );
      expect(await codeOf(attempt(a, sessionId, "BALANCE"))).toBe("ok");
    });
  });

  describe("the authentication step (US-36)", () => {
    it("US-36: three wrong codes fail the attempt with no debit; the code is then gone from the inbox", async () => {
      const a = await newBuyer();
      const before = await wallet(pool, a.ledgerAccountId);
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      await issue(a, q.sessionId);
      const right = await openCode(a);
      const wrong = right === "000000" ? "111111" : "000000";
      const first = verify(a, q.sessionId, { code: wrong });
      await expect(first).rejects.toMatchObject({ code: "CHALLENGE_FAILED", details: { remainingTries: 2 } });
      await expect(verify(a, q.sessionId, { code: wrong })).rejects.toMatchObject({
        code: "CHALLENGE_FAILED",
        details: { remainingTries: 1 },
      });
      await expect(verify(a, q.sessionId, { code: wrong })).rejects.toMatchObject({
        code: "CHALLENGE_LOCKED",
      });
      expect(await stateRow(at.attemptId)).toMatchObject({
        state: "FAILED",
        failure_code: "CHALLENGE_LOCKED",
      });
      // the right code no longer works: the attempt is over
      expect(await codeOf(verify(a, q.sessionId, { code: right }))).toBe("NOT_FOUND");
      expect((await inbox(a)).every((m) => m.code === undefined)).toBe(true);
      expect(await wallet(pool, a.ledgerAccountId)).toBe(before);
      expect(await codeOf(payWith(a, q.sessionId, at.attemptId))).not.toBe("ok");
    });

    it("US-36: an expired code cannot be used; the attempt fails as 'code expired' and nothing is debited", async () => {
      const a = await newBuyer();
      const before = await wallet(pool, a.ledgerAccountId);
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      await issue(a, q.sessionId);
      const code = await openCode(a);
      await backdateChallenge(at.attemptId, CHALLENGE_RULES.ttlSeconds + 1);
      expect((await inbox(a))[0]?.status).toBe("EXPIRED");
      expect((await inbox(a))[0]?.code).toBeUndefined();
      await expect(verify(a, q.sessionId, { code })).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
      expect(await stateRow(at.attemptId)).toMatchObject({
        state: "FAILED",
        failure_code: "CHALLENGE_EXPIRED",
      });
      expect(await wallet(pool, a.ledgerAccountId)).toBe(before);
    });

    it("US-36: a code works once and only on its own attempt", async () => {
      const a = await newBuyer();
      const q1 = await quote(a);
      const at1 = await attempt(a, q1.sessionId, "NET_BANKING");
      await issue(a, q1.sessionId);
      const code1 = await openCode(a);
      // a second checkout of the same buyer: the first code is not valid there
      const q2 = await quote(a);
      await attempt(a, q2.sessionId, "NET_BANKING");
      await issue(a, q2.sessionId);
      const code2 = await openCode(a);
      if (code2 !== code1) {
        await expect(verify(a, q2.sessionId, { code: code1 })).rejects.toMatchObject({
          code: "CHALLENGE_FAILED",
        });
      }
      expect((await verify(a, q1.sessionId, { code: code1 })).status).toBe("AUTHENTICATED");
      // single use: a second verify on the same attempt is refused, and the attempt is authenticated only once
      expect(await codeOf(verify(a, q1.sessionId, { code: code1 }))).toBe("CONFLICT");
      await payWith(a, q1.sessionId, at1.attemptId);
      // another player cannot use it either
      const b = await newBuyer();
      expect(await codeOf(verify(b, q1.sessionId, { code: code1 }))).toBe("NOT_FOUND");
    });

    it("US-36: a code that ran out of time unused is scrubbed from the database by the daily purge, and by the player's next request", async () => {
      const a = await newBuyer();
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      await issue(a, q.sessionId);
      const stored = () =>
        pool.query<{ code: string | null }>(
          "SELECT code FROM core.bank_inbox_message WHERE attempt_id = $1",
          [at.attemptId],
        );
      expect((await stored()).rows[0]?.code).toMatch(/^\d{6}$/);
      await backdateChallenge(at.attemptId, CHALLENGE_RULES.ttlSeconds + 1);
      // expired but not yet scrubbed: the inbox already hides it
      expect((await inbox(a))[0]?.code).toBeUndefined();
      await pool.query("SELECT core.purge_idempotency_records()");
      expect((await stored()).rows[0]?.code).toBeNull();

      const b = await newBuyer();
      const q2 = await quote(b);
      const at2 = await attempt(b, q2.sessionId, "NET_BANKING");
      await issue(b, q2.sessionId);
      await backdateChallenge(at2.attemptId, CHALLENGE_RULES.ttlSeconds + 1);
      // the next code asked for by the same player scrubs the old one first
      await issue(b, q2.sessionId);
      const codes = await pool.query<{ code: string | null }>(
        "SELECT code FROM core.bank_inbox_message WHERE attempt_id = $1 ORDER BY created_at",
        [at2.attemptId],
      );
      expect(codes.rows.map((r) => r.code !== null)).toEqual([false, true]);
    });

    it("US-36: a code is asked for again only after 30 seconds, replaces the old one, and at most five a hour", async () => {
      const a = await newBuyer();
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      await issue(a, q.sessionId);
      const first = await openCode(a);
      expect(await codeOf(issue(a, q.sessionId))).toBe("RATE_LIMITED");
      await backdateChallenge(at.attemptId, CHALLENGE_RULES.resendSeconds + 1);
      await issue(a, q.sessionId);
      const open = (await inbox(a)).filter((m) => m.status === "OPEN");
      expect(open).toHaveLength(1);
      const second = open[0]?.code as string;
      if (second !== first) {
        await expect(verify(a, q.sessionId, { code: first })).rejects.toMatchObject({
          code: "CHALLENGE_FAILED",
        });
      }
      // two codes so far: issues 3, 4 and 5 are allowed, the sixth of the hour is refused
      for (let i = 0; i < CHALLENGE_RULES.codesPerHour - 2; i++) {
        await backdateChallenge(at.attemptId, CHALLENGE_RULES.resendSeconds + 1);
        await issue(a, q.sessionId);
      }
      await backdateChallenge(at.attemptId, CHALLENGE_RULES.resendSeconds + 1);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.bank_inbox_message WHERE user_id = $1", [a.userId]),
      ).toBe(CHALLENGE_RULES.codesPerHour);
      expect(await codeOf(issue(a, q.sessionId))).toBe("RATE_LIMITED");
    });

    it("US-36: the hourly allowance is the payer's own: a stranger cannot use it up", async () => {
      const a = await newBuyer();
      const stranger = await newBuyer();
      const sq = await quote(stranger);
      const sat = await attempt(stranger, sq.sessionId, "NET_BANKING");
      await issue(stranger, sq.sessionId);
      for (let i = 1; i < CHALLENGE_RULES.codesPerHour; i++) {
        await backdateChallenge(sat.attemptId, CHALLENGE_RULES.resendSeconds + 1);
        await issue(stranger, sq.sessionId);
      }
      await backdateChallenge(sat.attemptId, CHALLENGE_RULES.resendSeconds + 1);
      expect(await codeOf(issue(stranger, sq.sessionId))).toBe("RATE_LIMITED");
      const q = await quote(a);
      await attempt(a, q.sessionId, "NET_BANKING");
      expect((await issue(a, q.sessionId)).kind).toBe("CODE");
    });

    it("US-36: no code is ever sent outside the app: not in the outbox, analytics, audit, idempotency records, or any command result", async () => {
      const a = await newBuyer();
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      const issued = await issue(a, q.sessionId);
      const code = await openCode(a);
      const view = await myPaymentAttempt(pool, { authSessionId: a.authSessionId, attemptId: at.attemptId });
      const quoted = `"${code}"`;
      expect(JSON.stringify(issued, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(
        code,
      );
      expect(JSON.stringify(view, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(
        quoted,
      );
      for (const sql of [
        "SELECT count(*) AS n FROM audit.outbox WHERE payload::text LIKE $1",
        "SELECT count(*) AS n FROM analytics.event WHERE props::text LIKE $1",
        "SELECT count(*) AS n FROM audit.audit_log WHERE detail::text LIKE $1 OR reason LIKE $1",
        "SELECT count(*) AS n FROM core.idempotency_record WHERE response::text LIKE $1",
      ]) {
        expect(await count(pool, sql, [`%${quoted}%`]), sql).toBe(0);
      }
      // the stored challenge keeps only a hash, and no application role can read even that
      for (const role of ["app_pay", "app_web", "app_jobs"]) {
        expect(await stateOf(pool, "SELECT code_hash FROM core.payment_challenge", [], { role }), role).toBe(
          "42501",
        );
        expect(await stateOf(pool, "SELECT code FROM core.bank_inbox_message", [], { role }), role).toBe(
          "42501",
        );
      }
      const stored = await pool.query<{ code_hash: Buffer }>(
        "SELECT code_hash FROM core.payment_challenge WHERE attempt_id = $1",
        [at.attemptId],
      );
      expect(stored.rows[0]?.code_hash.toString("utf8")).not.toContain(code);
      // the inbox is the payer's own
      const b = await newBuyer();
      expect(await inbox(b)).toEqual([]);
    });
  });

  describe("decline reasons and the status model (US-34)", () => {
    it("US-34: declining an approval, or cancelling, ends the attempt as 'cancelled by you' with no debit", async () => {
      const a = await newBuyer();
      const before = await wallet(pool, a.ledgerAccountId);
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "DELULUPAY_ID", { delulupayId: await idOf(a) });
      await issue(a, q.sessionId);
      expect((await verify(a, q.sessionId, { decision: "DECLINE" })).status).toBe("DECLINED");
      expect(await stateRow(at.attemptId)).toMatchObject({ state: "FAILED", failure_code: "CANCELLED" });
      // a later attempt on the same session can still succeed
      const at2 = await attempt(a, q.sessionId, "BALANCE");
      await payWith(a, q.sessionId, at2.attemptId);
      expect(before - (await wallet(pool, a.ledgerAccountId))).toBe(q.totalPaise);

      const q2 = await quote(a, await fresh());
      const at3 = await attempt(a, q2.sessionId, "BALANCE");
      await cancelPaymentAttempt(pool, { authSessionId: a.authSessionId, attemptId: at3.attemptId });
      expect(await stateRow(at3.attemptId)).toMatchObject({ state: "FAILED", failure_code: "CANCELLED" });
      expect(
        await codeOf(
          cancelPaymentAttempt(pool, { authSessionId: a.authSessionId, attemptId: at3.attemptId }),
        ),
      ).toBe("CONFLICT");
      const stranger = await newBuyer();
      expect(
        await codeOf(
          cancelPaymentAttempt(pool, { authSessionId: stranger.authSessionId, attemptId: at3.attemptId }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("US-34: the displayed status in the database equals the status function of @delulu/core (every combination)", async () => {
      for (const state of ["PENDING", "SUCCEEDED", "FAILED"] as const)
        for (const authenticated of [false, true])
          for (const challengeIssued of [false, true])
            for (const sessionLive of [false, true])
              for (const reversed of [false, true]) {
                const { rows } = await pool.query<{ s: string }>(
                  "SELECT core.payment_display_status($1, $2, $3, $4, $5) AS s",
                  [state, authenticated, challengeIssued, sessionLive, reversed],
                );
                expect(
                  rows[0]?.s,
                  JSON.stringify({ state, authenticated, challengeIssued, sessionLive, reversed }),
                ).toBe(displayStatus({ state, authenticated, challengeIssued, sessionLive, reversed }));
              }
    });

    it("US-34: orders, payments and the statement agree; a failed attempt shows in Payments with a reason and not in the statement", async () => {
      const a = await newBuyer();
      const { q, a: at, receipt } = await approvedPurchase(a);
      // a failed attempt: a wrong-code lockout on another checkout
      const q2 = await quote(a, await fresh());
      const failed = await attempt(a, q2.sessionId, "NET_BANKING");
      await issue(a, q2.sessionId);
      const wrong = (await openCode(a)) === "000000" ? "111111" : "000000";
      for (let i = 0; i < CHALLENGE_RULES.tries; i++)
        await verify(a, q2.sessionId, { code: wrong }).catch(() => undefined);

      const orders = await myOrders(pool, { authSessionId: a.authSessionId });
      const payments = await myPayments(pool, { authSessionId: a.authSessionId });
      const statement = await myStatement(pool, { authSessionId: a.authSessionId });

      const order = orders.items.find((o) => o.orderGroupId === receipt.orderGroupId);
      expect(order).toBeDefined();
      const paid = payments.items.filter(
        (p) => p.status === "CAPTURED" && p.orderGroupId === receipt.orderGroupId,
      );
      expect(paid).toHaveLength(1);
      expect(paid[0]).toMatchObject({
        id: at.attemptId,
        reference: receipt.paymentReference,
        method: "DELULUPAY_ID",
      });
      expect(paid[0]?.amountPaise).toBe(q.totalPaise);
      const rows = statement.items.filter((r) => r.orderGroupId === receipt.orderGroupId);
      expect(rows.reduce((s, r) => s + r.amountPaise, 0n)).toBe(-(paid[0]?.amountPaise ?? 0n));

      const failedRow = payments.items.find((p) => p.id === failed.attemptId);
      expect(failedRow).toMatchObject({
        status: "FAILED",
        failureCode: "CHALLENGE_LOCKED",
        orderGroupId: null,
      });
      expect(describeFailure(failedRow?.failureCode).message).toMatch(/No fictional money moved\./);
      expect(statement.items.some((r) => r.orderGroupId === null && r.eventType === "PURCHASE")).toBe(false);
      expect(await reconcile(pool)).toEqual(CLEAN);
    });

    it("US-34: an abandoned attempt whose session ended shows as Failed (session expired); the list is the payer's own and pages", async () => {
      const a = await newBuyer();
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "BALANCE");
      await pool.query(
        "UPDATE core.checkout_session SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [q.sessionId],
      );
      const page = await myPayments(pool, { authSessionId: a.authSessionId });
      expect(page.items.find((p) => p.id === at.attemptId)).toMatchObject({
        status: "FAILED",
        failureCode: "CHECKOUT_EXPIRED",
      });
      const stranger = await newBuyer();
      expect((await myPayments(pool, { authSessionId: stranger.authSessionId })).items).toEqual([]);
      // paging by cursor: one at a time, newest first, no duplicates
      for (let i = 0; i < 2; i++) await attempt(a, (await quote(a)).sessionId, "BALANCE");
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const p: Awaited<ReturnType<typeof myPayments>> = await myPayments(pool, {
          authSessionId: a.authSessionId,
          cursor,
          limit: 1,
        });
        seen.push(...p.items.map((i) => i.id));
        cursor = p.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(3);
      expect(
        await codeOf(
          myPayments(pool, {
            authSessionId: a.authSessionId,
            cursor: "x'; DROP TABLE core.user_profile; --",
          }),
        ),
      ).toBe("VALIDATION_FAILED");
    });
  });

  describe("test scenarios (R4.6)", () => {
    it("US-35: a normal player in production cannot use a reserved test ID or a scenario; nothing is created", async () => {
      const a = await newBuyer();
      const q = await quote(a);
      expect((await checkoutPaymentMethods(pool, { authSessionId: a.authSessionId })).scenariosAllowed).toBe(
        false,
      );
      const before = await count(pool, "SELECT count(*) AS n FROM core.payment_attempt WHERE user_id = $1", [
        a.userId,
      ]);
      for (const scenario of PAYMENT_SCENARIOS) {
        expect(
          await codeOf(
            attempt(a, q.sessionId, "DELULUPAY_ID", { delulupayId: TEST_DELULUPAY_IDS[scenario] }),
          ),
          scenario,
        ).toBe("VALIDATION_FAILED");
        expect(await codeOf(attempt(a, q.sessionId, "NET_BANKING", { scenario })), scenario).toBe(
          "VALIDATION_FAILED",
        );
      }
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.payment_attempt WHERE user_id = $1", [a.userId]),
      ).toBe(before);
    });

    describe("allowed for a staff test account (or when the owner switches them on)", () => {
      let staff: TestUser;
      beforeAll(async () => {
        staff = await newBuyer();
        await pool.query("UPDATE core.user_profile SET is_test_account = true WHERE id = $1", [staff.userId]);
      });

      it("US-35: a test account sees scenarios open", async () => {
        expect(
          (await checkoutPaymentMethods(pool, { authSessionId: staff.authSessionId })).scenariosAllowed,
        ).toBe(true);
      });

      it("R4.6: INSUFFICIENT_FUNDS declines on approval with no debit", async () => {
        const before = await wallet(pool, staff.ledgerAccountId);
        const q = await quote(staff);
        const at = await attempt(staff, q.sessionId, "DELULUPAY_ID", {
          delulupayId: TEST_DELULUPAY_IDS.INSUFFICIENT_FUNDS,
        });
        await issue(staff, q.sessionId);
        await expect(verify(staff, q.sessionId, { decision: "APPROVE" })).rejects.toMatchObject({
          code: "INSUFFICIENT_FUNDS",
        });
        expect(await stateRow(at.attemptId)).toMatchObject({
          state: "FAILED",
          failure_code: "TEST_INSUFFICIENT_FUNDS",
        });
        expect(await wallet(pool, staff.ledgerAccountId)).toBe(before);
      });

      it("R4.6: BANK_UNAVAILABLE fails when the bank is asked", async () => {
        const q = await quote(staff);
        const at = await attempt(staff, q.sessionId, "NET_BANKING", { scenario: "BANK_UNAVAILABLE" });
        await expect(issue(staff, q.sessionId)).rejects.toMatchObject({ code: "BANK_UNAVAILABLE" });
        expect(await stateRow(at.attemptId)).toMatchObject({ failure_code: "BANK_UNAVAILABLE" });
      });

      it("R4.6: SLOW_BANK answers only after a delay; CODE_EXPIRED expires at once; CODE_LOCKOUT never accepts the code", async () => {
        const q = await quote(staff);
        const at = await attempt(staff, q.sessionId, "DELULUPAY_ID", {
          delulupayId: TEST_DELULUPAY_IDS.SLOW_BANK,
        });
        await issue(staff, q.sessionId);
        const waiting = await verify(staff, q.sessionId, { decision: "APPROVE" });
        expect(waiting.status).toBe("WAITING");
        await pool.query(
          "UPDATE core.payment_challenge SET available_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1",
          [at.attemptId],
        );
        expect((await verify(staff, q.sessionId, { decision: "APPROVE" })).status).toBe("AUTHENTICATED");

        const q2 = await quote(staff);
        await attempt(staff, q2.sessionId, "NET_BANKING", { scenario: "CODE_EXPIRED" });
        await issue(staff, q2.sessionId);
        await expect(verify(staff, q2.sessionId, { code: "123456" })).rejects.toMatchObject({
          code: "CHALLENGE_EXPIRED",
        });

        const q3 = await quote(staff);
        await attempt(staff, q3.sessionId, "NET_BANKING", { scenario: "CODE_LOCKOUT" });
        await issue(staff, q3.sessionId);
        const right = await openCode(staff);
        await expect(verify(staff, q3.sessionId, { code: right })).rejects.toMatchObject({
          code: "CHALLENGE_FAILED",
        });
        await expect(verify(staff, q3.sessionId, { code: right })).rejects.toMatchObject({
          code: "CHALLENGE_FAILED",
        });
        await expect(verify(staff, q3.sessionId, { code: right })).rejects.toMatchObject({
          code: "CHALLENGE_LOCKED",
        });
      });

      it("R4.6: a test ID that is not reserved, or a scenario name that does not exist, is refused even for staff", async () => {
        const q = await quote(staff);
        expect(
          await codeOf(
            attempt(staff, q.sessionId, "DELULUPAY_ID", { delulupayId: "testpay.nothing@delulu" }),
          ),
        ).toBe("VALIDATION_FAILED");
        expect(
          await stateOf(
            pool,
            "SELECT core.start_payment_attempt($1, 'BALANCE', NULL, NULL, 'NOPE')",
            [q.sessionId],
            {
              role: "app_pay",
              sessionId: staff.authSessionId,
            },
          ),
        ).toBe("DM001");
      });
    });

    it("R4.6: with the owner's staging switch on, a normal player may use a scenario; it is off by default and a player's own ID can never be a test ID", async () => {
      const a = await newBuyer();
      expect(
        (
          await pool.query<{ value: string }>(
            "SELECT value FROM core.deployment_setting WHERE key = 'payments.test_scenarios'",
          )
        ).rows[0]?.value,
      ).toBe("off");
      expect(
        await stateOf(
          pool,
          "UPDATE core.bank_account SET upi_style_id = 'testpay.slow@delulu' WHERE user_id = $1",
          [a.userId],
        ),
      ).toBe("23514");
      await pool.query(
        "UPDATE core.deployment_setting SET value = 'on' WHERE key = 'payments.test_scenarios'",
      );
      try {
        expect(
          (await checkoutPaymentMethods(pool, { authSessionId: a.authSessionId })).scenariosAllowed,
        ).toBe(true);
        const q = await quote(a);
        expect((await attempt(a, q.sessionId, "NET_BANKING", { scenario: "SLOW_BANK" })).method).toBe(
          "NET_BANKING",
        );
      } finally {
        await pool.query(
          "UPDATE core.deployment_setting SET value = 'off' WHERE key = 'payments.test_scenarios'",
        );
      }
    });

    it("R4.6: the application roles cannot switch scenarios on", async () => {
      for (const role of ["app_web", "app_pay", "app_jobs"]) {
        expect(
          await stateOf(
            pool,
            "UPDATE core.deployment_setting SET value = 'on' WHERE key = 'payments.test_scenarios'",
            [],
            { role },
          ),
          role,
        ).toBe("42501");
      }
    });
  });

  describe("method configuration through the delayed queue (R4.2, R7; US-35)", () => {
    it("US-35: a method change is a queued, delayed action: nothing changes until the executor runs it, then a new version applies", async () => {
      const queued = await proposePaymentMethodChange(pool, {
        authSessionId: admin.authSessionId,
        reason: REASON,
        change: {
          method: "NET_BANKING",
          enabled: false,
          displayOrder: 3,
          perAttemptLimitPaise: null,
          perDayLimitPaise: null,
          maintenanceFrom: null,
          maintenanceUntil: null,
        },
      });
      expect(queued).toMatchObject({
        kind: "payment_method.set",
        key: "payment_method.NET_BANKING",
        state: "QUEUED",
      });
      const a = await newBuyer();
      const q = await quote(a);
      // still on: the delay has not passed
      expect((await attempt(a, q.sessionId, "NET_BANKING")).method).toBe("NET_BANKING");
      expect(await executeDueAdminActions(pool)).toMatchObject({ executed: 0 });
      // a second proposal for the same method while one waits is a conflict
      expect(
        await codeOf(
          proposePaymentMethodChange(pool, {
            authSessionId: admin.authSessionId,
            reason: REASON,
            change: {
              method: "NET_BANKING",
              enabled: true,
              displayOrder: 5,
              perAttemptLimitPaise: null,
              perDayLimitPaise: null,
              maintenanceFrom: null,
              maintenanceUntil: null,
            },
          }),
        ),
      ).toBe("CONFLICT");
      const id = (queued as { id: string }).id;
      await pool.query(
        "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
        [id],
      );
      expect(await executeDueAdminActions(pool)).toMatchObject({ executed: 1, failed: 0 });
      const q2 = await quote(a);
      expect(await codeOf(attempt(a, q2.sessionId, "NET_BANKING"))).toBe("METHOD_UNAVAILABLE");
      const offered = await checkoutPaymentMethods(pool, { authSessionId: a.authSessionId });
      expect(offered.methods.find((m) => m.method === "NET_BANKING")).toMatchObject({
        available: false,
        reason: "OFF",
      });
      // an old version is never updated: the table is append-only and no application role touches it
      expect(await stateOf(pool, "UPDATE core.payment_method_config SET enabled = true")).toBe("42501");
      const versions = await count(
        pool,
        "SELECT count(*) AS n FROM core.payment_method_config WHERE method = 'NET_BANKING'",
      );
      expect(versions).toBe(1);
      for (const role of ["app_web", "app_pay", "app_jobs"]) {
        expect(
          await stateOf(pool, "INSERT INTO core.payment_method_config (id) VALUES (gen_random_uuid())", [], {
            role,
          }),
          role,
        ).toBe("42501");
        expect(await stateOf(pool, "SELECT 1 FROM core.payment_method_config", [], { role }), role).toBe(
          "42501",
        );
      }
      // back on, for the tests that follow
      await changeMethod("NET_BANKING", { enabled: true });
      expect(await codeOf(attempt(a, (await quote(a)).sessionId, "NET_BANKING"))).toBe("ok");
    });

    it("US-35: only the Super Admin proposes, and a change must be well formed", async () => {
      const a = await newBuyer();
      const change = {
        method: "BALANCE" as const,
        enabled: true,
        displayOrder: 4,
        perAttemptLimitPaise: "100",
        perDayLimitPaise: null,
        maintenanceFrom: null,
        maintenanceUntil: null,
      };
      expect(
        await codeOf(
          proposePaymentMethodChange(pool, { authSessionId: a.authSessionId, reason: REASON, change }),
        ),
      ).toBe("FORBIDDEN");
      for (const bad of [
        { perAttemptLimitPaise: "0" },
        { perAttemptLimitPaise: "-5" },
        { perAttemptLimitPaise: "1.5" },
        { perAttemptLimitPaise: "500", perDayLimitPaise: "100" },
        { displayOrder: 0 },
        { displayOrder: 100 },
        { maintenanceFrom: "2030-01-01T00:00:00Z", maintenanceUntil: null },
        { maintenanceFrom: "2030-01-02T00:00:00Z", maintenanceUntil: "2030-01-01T00:00:00Z" },
        { maintenanceFrom: "2030-01-01T00:00:00Z", maintenanceUntil: "2031-01-01T00:00:00Z" },
        { maintenanceFrom: "not a date", maintenanceUntil: "2030-01-01T00:00:00Z" },
      ] as Partial<typeof change>[]) {
        const code = await codeOf(
          proposePaymentMethodChange(pool, {
            authSessionId: admin.authSessionId,
            reason: REASON,
            change: { ...change, ...bad },
          }),
        );
        expect(["CONFIG_VALUE_INVALID", "VALIDATION_FAILED"], JSON.stringify(bad)).toContain(code);
      }
      // a method that does not exist, and a change that changes nothing
      expect(
        await stateOf(
          pool,
          "SELECT core.admin_action_propose('payment_method.set', $1::jsonb, $2)",
          [JSON.stringify({ ...change, key: "payment_method.PAYPAL", method: "PAYPAL" }), REASON],
          { role: "app_web", sessionId: admin.authSessionId },
        ),
      ).toBe("DM001");
      expect(
        await codeOf(
          proposePaymentMethodChange(pool, {
            authSessionId: admin.authSessionId,
            reason: REASON,
            change: { ...change, perAttemptLimitPaise: null },
          }),
        ),
      ).toBe("CONFLICT");
    });

    it("US-35: the queue cannot be used to switch every payment method off", async () => {
      const current = (await adminPaymentMethods(pool, { authSessionId: admin.authSessionId })).methods;
      const others = current.filter((m) => m.method !== "BALANCE");
      for (const m of others) await changeMethod(m.method, { enabled: false });
      try {
        expect(
          await codeOf(
            proposePaymentMethodChange(pool, {
              authSessionId: admin.authSessionId,
              reason: REASON,
              change: {
                method: "BALANCE",
                enabled: false,
                displayOrder: 4,
                perAttemptLimitPaise: null,
                perDayLimitPaise: null,
                maintenanceFrom: null,
                maintenanceUntil: null,
              },
            }),
          ),
        ).toBe("CONFIG_VALUE_INVALID");
      } finally {
        for (const m of others) await changeMethod(m.method, { enabled: true });
      }
    });

    it("US-35: exceeding a per-payment limit declines with no debit, in the PRD's wording; a lower amount still pays", async () => {
      const cheap = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 200n * RUPEE });
      const a = await newBuyer();
      await changeMethod("BALANCE", { perAttemptLimitPaise: (3_000n * RUPEE).toString() });
      try {
        const before = await wallet(pool, a.ledgerAccountId);
        const q = await quote(a);
        const err = await attempt(a, q.sessionId, "BALANCE").catch((e: DomainError) => e);
        expect(err).toMatchObject({ code: "METHOD_LIMIT_EXCEEDED" });
        expect((err as DomainError).message).toMatch(/No fictional money moved\./);
        // the other methods are unaffected
        expect((await attempt(a, q.sessionId, "NET_BANKING")).method).toBe("NET_BANKING");
        // a purchase under the limit pays
        const q2 = await quote(a, cheap);
        const ok = await attempt(a, q2.sessionId, "BALANCE");
        await payWith(a, q2.sessionId, ok.attemptId);
        expect(before - (await wallet(pool, a.ledgerAccountId))).toBe(q2.totalPaise);
      } finally {
        await changeMethod("BALANCE", { perAttemptLimitPaise: null });
      }
      expect(await reconcile(pool)).toEqual(CLEAN);
    });

    it("US-35: a per-day limit counts the payer's own captured payments of that method; concurrent payments cannot both pass", async () => {
      const cheap = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 200n * RUPEE });
      const cheap2 = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 300n * RUPEE });
      const a = await newBuyer();
      const b = await newBuyer();
      // one ₹200 order is ₹200 + ₹1,000 delivery = ₹1,200; the day allows ₹1,500
      await changeMethod("NET_BANKING", { perDayLimitPaise: (1_500n * RUPEE).toString() });
      try {
        const sessions = [await quote(a, cheap), await quote(a, cheap2)];
        const attempts: string[] = [];
        for (const s of sessions) {
          const at = await attempt(a, s.sessionId, "NET_BANKING");
          await issue(a, s.sessionId);
          await verify(a, s.sessionId, { code: await openCode(a) });
          attempts.push(at.attemptId);
        }
        const results = await Promise.all(
          sessions.map((s, i) => codeOf(payWith(a, s.sessionId, attempts[i] as string))),
        );
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === "METHOD_LIMIT_EXCEEDED")).toHaveLength(1);
        const failedAt = await pool.query<{ failure_code: string }>(
          "SELECT failure_code FROM core.payment_attempt WHERE user_id = $1 AND state = 'FAILED'",
          [a.userId],
        );
        expect(failedAt.rows.map((r) => r.failure_code)).toEqual(["METHOD_LIMIT_EXCEEDED"]);
        // another player's day is their own
        const qb = await quote(b, cheap);
        const ab = await attempt(b, qb.sessionId, "NET_BANKING");
        expect(ab.method).toBe("NET_BANKING");
      } finally {
        await changeMethod("NET_BANKING", { perDayLimitPaise: null });
      }
      expect(await reconcile(pool)).toEqual(CLEAN);
    });

    it("US-35: turning a method off after the attempt exists stops it at the pay step: the attempt fails, nothing is debited", async () => {
      const a = await newBuyer();
      const before = await wallet(pool, a.ledgerAccountId);
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "DELULUPAY_ID", { delulupayId: await idOf(a) });
      await issue(a, q.sessionId);
      await verify(a, q.sessionId, { decision: "APPROVE" });
      await changeMethod("DELULUPAY_ID", { enabled: false });
      try {
        await expect(payWith(a, q.sessionId, at.attemptId)).rejects.toMatchObject({
          code: "METHOD_UNAVAILABLE",
        });
        expect(await stateRow(at.attemptId)).toMatchObject({
          state: "FAILED",
          failure_code: "METHOD_UNAVAILABLE",
        });
        expect(await wallet(pool, a.ledgerAccountId)).toBe(before);
      } finally {
        await changeMethod("DELULUPAY_ID", { enabled: true });
      }
      expect(await reconcile(pool)).toEqual(CLEAN);
    });

    it("US-35: the kill switches still gate their method, including the new one for DeluluPay IDs", async () => {
      const a = await newBuyer();
      for (const [name, method, extra] of [
        ["payments_netbanking", "NET_BANKING", {}],
        ["payments_delulupay_id", "DELULUPAY_ID", { delulupayId: await idOf(a) }],
        ["payments_card", "CARD", { cardId: a.cardId }],
      ] as const) {
        await pool.query("UPDATE core.system_switch SET enabled = false WHERE name = $1", [name]);
        try {
          expect(await codeOf(attempt(a, (await quote(a)).sessionId, method, extra)), name).toBe(
            "METHOD_UNAVAILABLE",
          );
        } finally {
          await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = $1", [name]);
        }
      }
    });

    it("R4.6: a scheduled maintenance window is an honest unavailable state with its end time, and ends by itself", async () => {
      const a = await newBuyer();
      const from = new Date(Date.now() - 60_000).toISOString();
      const until = new Date(Date.now() + 3_600_000).toISOString();
      await changeMethod("NET_BANKING", { maintenanceFrom: from, maintenanceUntil: until });
      try {
        const offered = await checkoutPaymentMethods(pool, { authSessionId: a.authSessionId });
        const nb = offered.methods.find((m) => m.method === "NET_BANKING");
        expect(nb).toMatchObject({ available: false, reason: "MAINTENANCE" });
        expect(nb?.maintenanceUntil).toBeTruthy();
        const err = await attempt(a, (await quote(a)).sessionId, "NET_BANKING").catch((e: DomainError) => e);
        expect(err).toMatchObject({ code: "METHOD_UNAVAILABLE" });
        expect((err as DomainError).message).toMatch(/maintenance/i);
        expect((err as DomainError).message).toMatch(/No fictional money moved\./);
      } finally {
        await changeMethod("NET_BANKING", { maintenanceFrom: null, maintenanceUntil: null });
      }
      expect(await codeOf(attempt(a, (await quote(a)).sessionId, "NET_BANKING"))).toBe("ok");
    });

    it("R7: the display order is configurable and checkout lists the methods in it", async () => {
      const a = await newBuyer();
      const order = (await checkoutPaymentMethods(pool, { authSessionId: a.authSessionId })).methods.map(
        (m) => m.method,
      );
      expect(order).toEqual(
        [...PAYMENT_METHODS].sort((x, y) => METHOD_DEFAULT_ORDER[x] - METHOD_DEFAULT_ORDER[y]),
      );
      await changeMethod("BALANCE", { displayOrder: 1 });
      try {
        const next = (await checkoutPaymentMethods(pool, { authSessionId: a.authSessionId })).methods.map(
          (m) => m.method,
        );
        expect(next[0]).toBe("BALANCE");
      } finally {
        await changeMethod("BALANCE", { displayOrder: 4 });
      }
    });
  });

  describe("invariants over random sequences of bank-step operations (property)", () => {
    type Op =
      | "issue"
      | "wrong"
      | "right"
      | "approve"
      | "decline"
      | "cancel"
      | "pay"
      | "resendWindow"
      | "expire";
    const OPS: Op[] = [
      "issue",
      "wrong",
      "right",
      "approve",
      "decline",
      "cancel",
      "pay",
      "resendWindow",
      "expire",
    ];

    it("US-35 US-36: whatever the order of calls, money moves only after authentication, only once, and never on a failed attempt", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("NET_BANKING", "DELULUPAY_ID"),
          fc.array(fc.constantFrom(...OPS), { minLength: 1, maxLength: 12 }),
          async (method, ops) => {
            const buyer = await newBuyer();
            const before = await wallet(pool, buyer.ledgerAccountId);
            const q = await quote(buyer, await fresh());
            const at = await attempt(
              buyer,
              q.sessionId,
              method,
              method === "DELULUPAY_ID" ? { delulupayId: await idOf(buyer) } : {},
            );
            let paid = false;
            for (const op of ops) {
              try {
                if (op === "issue") await issue(buyer, q.sessionId);
                else if (op === "wrong") {
                  const open = (await inbox(buyer)).find((m) => m.code !== undefined)?.code;
                  await verify(buyer, q.sessionId, { code: open === "000000" ? "111111" : "000000" });
                } else if (op === "right") {
                  const open = (await inbox(buyer)).find((m) => m.code !== undefined)?.code;
                  if (open) await verify(buyer, q.sessionId, { code: open });
                } else if (op === "approve") await verify(buyer, q.sessionId, { decision: "APPROVE" });
                else if (op === "decline") await verify(buyer, q.sessionId, { decision: "DECLINE" });
                else if (op === "cancel")
                  await cancelPaymentAttempt(pool, {
                    authSessionId: buyer.authSessionId,
                    attemptId: at.attemptId,
                  });
                else if (op === "pay") {
                  await payWith(buyer, q.sessionId, at.attemptId);
                  paid = true;
                } else if (op === "resendWindow")
                  await backdateChallenge(at.attemptId, CHALLENGE_RULES.resendSeconds + 1);
                else if (op === "expire")
                  await backdateChallenge(at.attemptId, CHALLENGE_RULES.ttlSeconds + 1);
              } catch (error) {
                // refusals are expected; only an unexpected fault fails the property
                const code = error instanceof DomainError ? error.code : (error as { code?: string }).code;
                expect(typeof code, String(error)).toBe("string");
                expect(code, String(error)).not.toBe("XX000");
              }
            }
            const row = await stateRow(at.attemptId);
            const after = await wallet(pool, buyer.ledgerAccountId);
            const used = await count(
              pool,
              "SELECT COALESCE(max(attempts_used), 0) AS n FROM core.payment_challenge WHERE attempt_id = $1",
              [at.attemptId],
            );
            // money moves exactly when the attempt succeeded, by exactly the quoted total
            expect(before - after).toBe(row?.state === "SUCCEEDED" ? q.totalPaise : 0n);
            expect(paid || row?.state !== "SUCCEEDED").toBe(true);
            if (row?.state === "SUCCEEDED") expect(row.authenticated_at).not.toBeNull();
            if (row?.state === "FAILED") expect(row.failure_code).not.toBeNull();
            if (row?.state === "PENDING" && row.authenticated_at === null) expect(after).toBe(before);
            expect(used).toBeLessThanOrEqual(CHALLENGE_RULES.tries);
            // an open code exists only while the attempt is pending and unauthenticated
            const stillOpen = (await inbox(buyer)).filter((m) => m.code !== undefined);
            if (row?.state !== "PENDING" || row.authenticated_at !== null) expect(stillOpen).toEqual([]);
            expect(stillOpen.length).toBeLessThanOrEqual(1);
          },
        ),
        { numRuns: 40 },
      );
      expect(await reconcile(pool)).toEqual(CLEAN);
    }, 120_000);
  });

  describe("agreement with @delulu/core", () => {
    it("the database's challenge numbers, test IDs and method order equal the TypeScript constants", async () => {
      const { rows } = await pool.query<{ r: Record<string, number> }>("SELECT core.payment_rules() AS r");
      expect(rows[0]?.r).toEqual({
        ttlSeconds: CHALLENGE_RULES.ttlSeconds,
        tries: CHALLENGE_RULES.tries,
        resendSeconds: CHALLENGE_RULES.resendSeconds,
        codesPerHour: CHALLENGE_RULES.codesPerHour,
        slowBankSeconds: CHALLENGE_RULES.slowBankSeconds,
      });
      for (const scenario of PAYMENT_SCENARIOS) {
        const { rows: r } = await pool.query<{ s: string }>(
          "SELECT core.payment_scenario_of_test_id($1) AS s",
          [TEST_DELULUPAY_IDS[scenario]],
        );
        expect(r[0]?.s).toBe(scenario);
      }
      const names = await pool.query<{ n: string[] }>("SELECT core.payment_scenario_names() AS n");
      expect([...(names.rows[0]?.n ?? [])].sort()).toEqual([...PAYMENT_SCENARIOS].sort());
      const defaults = await pool.query<{ method: string; display_order: number }>(
        "SELECT * FROM core.payment_method_defaults() ORDER BY display_order",
      );
      expect(defaults.rows.map((r) => [r.method, r.display_order])).toEqual(
        Object.entries(METHOD_DEFAULT_ORDER).sort((x, y) => x[1] - y[1]),
      );
    });

    it("the tunables are configuration: a new configuration version changes them, clamped", async () => {
      const { rows } = await pool.query<{ v: number }>("SELECT core.payment_setting('challenge_tries') AS v");
      expect(rows[0]?.v).toBe(CHALLENGE_RULES.tries);
      await pool.query(
        "INSERT INTO core.config_version (values, effective_from, note) SELECT values || '{\"challenge_tries\": 0, \"challenge_ttl_seconds\": 99999}'::jsonb, now() + interval '1 microsecond', 'test' FROM core.config_version ORDER BY id DESC LIMIT 1",
      );
      await new Promise((r) => setTimeout(r, 5));
      const clamped = await pool.query<{ a: number; b: number }>(
        "SELECT core.payment_setting('challenge_tries') AS a, core.payment_setting('challenge_ttl_seconds') AS b",
      );
      expect(clamped.rows[0]).toEqual({ a: 1, b: 900 });
      await pool.query("DELETE FROM core.config_version WHERE note = 'test'");
    });
  });

  describe("events (R10)", () => {
    it("the four payment events are server events with one `method` prop, no visitor and no user id", async () => {
      const a = await newBuyer();
      for (const name of [
        "payment_method_selected",
        "payment_challenge_issued",
        "payment_challenge_passed",
        "payment_challenge_failed",
      ]) {
        const ok = await recordEvent(pool, {
          authSessionId: a.authSessionId,
          name,
          surface: "checkout",
          visitorKey: null,
          placeKey: null,
          country: "IN",
          region: null,
          city: null,
          deviceClass: "mobile",
          props: { method: "NET_BANKING" },
        });
        expect(ok, name).toBe(true);
      }
      const rows = await pool.query(
        "SELECT name, props, visitor_key, place_key FROM analytics.event WHERE name LIKE 'payment_%'",
      );
      expect(rows.rows).toHaveLength(4);
      for (const r of rows.rows) {
        expect(r.props).toEqual({ method: "NET_BANKING" });
        expect(r.visitor_key).toBeNull();
        expect(JSON.stringify(r)).not.toContain(a.userId);
      }
      // nothing else rides along: no code, no amount, no unknown method
      const refused: Record<string, string>[] = [
        { method: "NET_BANKING", code: "123456" },
        { method: "PAYPAL" },
        { amount_bucket: "lt_1k" },
        { method: "CARD", user_id: a.userId },
      ];
      for (const props of refused) {
        await expect(
          recordEvent(pool, {
            authSessionId: a.authSessionId,
            name: "payment_challenge_issued",
            surface: "checkout",
            visitorKey: null,
            placeKey: null,
            country: "IN",
            region: null,
            city: null,
            deviceClass: "mobile",
            props,
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }
    });
  });

  describe("privileges", () => {
    it("application roles hold only the commands and reads of the payment flow; the player cannot read another's inbox or attempts", async () => {
      const a = await newBuyer();
      const b = await newBuyer();
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      await issue(a, q.sessionId);
      const aCode = await openCode(a);
      expect(
        await codeOf(myPaymentAttempt(pool, { authSessionId: b.authSessionId, attemptId: at.attemptId })),
      ).toBe("NOT_FOUND");
      expect((await inbox(b)).some((m) => m.attemptId === at.attemptId)).toBe(false);
      // straight SQL as B: the inbox table and the code are out of reach
      const asB = await asActor(pool, { role: "app_web", userId: b.userId }, async (c) => {
        const r = await c.query("SELECT core.my_bank_inbox() AS r");
        return JSON.stringify(r.rows[0]);
      });
      expect(asB).not.toContain(aCode);
      for (const [fn, params] of [
        ["core.payment_attempt_fail($1, 'X')", [at.attemptId]],
        ["core.payment_method_gate($1, 'CARD', 1)", [a.userId]],
        ["core.payment_new_code()", []],
      ] as const) {
        expect(
          await stateOf(pool, `SELECT ${fn}`, [...params], { role: "app_pay", userId: a.userId }),
          fn,
        ).toBe("42501");
      }
      // the web role cannot run the money commands
      for (const fn of ["core.issue_payment_challenge($1)", "core.cancel_payment_attempt($1)"]) {
        expect(
          await stateOf(pool, `SELECT ${fn}`, [q.sessionId], { role: "app_web", userId: a.userId }),
          fn,
        ).toBe("42501");
      }
      // a signed-out caller is refused by every command and read
      for (const fn of [
        "core.issue_payment_challenge($1)",
        "core.verify_payment_challenge($1, NULL, 'APPROVE')",
        "core.cancel_payment_attempt($1)",
      ]) {
        expect(
          await stateOf(pool, `SELECT ${fn}`, [q.sessionId], {
            role: "app_pay",
            sessionId: "00000000-0000-7000-8000-00000000dead",
          }),
          fn,
        ).toBe("DM001");
      }
      for (const fn of [
        "core.my_bank_inbox()",
        "core.my_payments(NULL, NULL)",
        "core.checkout_payment_methods()",
      ]) {
        expect(
          await stateOf(pool, `SELECT ${fn}`, [], {
            role: "app_web",
            sessionId: "00000000-0000-7000-8000-00000000dead",
          }),
          fn,
        ).toBe("DM001");
      }
    });

    it("a DELULUPAY_ID or NET_BANKING attempt can be authenticated only by its challenge: no direct write by an application role", async () => {
      const a = await newBuyer();
      const q = await quote(a);
      const at = await attempt(a, q.sessionId, "NET_BANKING");
      for (const role of ["app_web", "app_pay"]) {
        expect(
          await stateOf(
            pool,
            "UPDATE core.payment_attempt SET authenticated_at = now() WHERE id = $1",
            [at.attemptId],
            { role, userId: a.userId },
          ),
          role,
        ).toBe("42501");
      }
      expect(await codeOf(payWith(a, q.sessionId, at.attemptId))).toBe("PAYMENT_PENDING");
    });
  });
});
