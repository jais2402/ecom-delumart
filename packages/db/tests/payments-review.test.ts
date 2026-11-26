import { randomBytes } from "node:crypto";
import { describeFailure, PAYMENT_METHODS, TEST_DELULUPAY_IDS } from "@delulu/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeDueAdminActions } from "../src/admin-actions";
import { createCheckoutSession, createPaymentAttempt, pay } from "../src/checkout";
import { companyQuote, registerCompany } from "../src/company";
import {
  adminPaymentMethods,
  issuePaymentChallenge,
  myBankInbox,
  myPayments,
  type PaymentMethodChange,
  proposePaymentMethodChange,
  verifyPaymentChallenge,
} from "../src/payment";
import {
  CLEAN,
  count,
  key,
  type ProductFixture,
  product,
  RUPEE,
  reconcile,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import { createTestDatabase, plant, type TestDatabase, type TestUser } from "./helpers";
import { completePassport, published } from "./selling-fixtures";

/** Review fixes of the DeluluPay series (migration 0104; decisions.md #17). */
const REASON = "Scheduled change agreed with the team";
const WINDOW_MS = 7 * 86_400_000;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return `${(e as { code?: string }).code ?? "unexpected"}`;
  }
  return "ok";
}

describe("DeluluPay review fixes", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  const fresh = (price = 200n) => product(pool, { mode: "UNLIMITED_SEED", pricePaise: price * RUPEE });
  const quote = (u: TestUser, p: ProductFixture) =>
    createCheckoutSession(pool, {
      authSessionId: u.authSessionId,
      lines: [{ productId: p.id }],
      speedBySeller: standard("SEED"),
      idempotencyKey: key(),
    });
  const attempt = (u: TestUser, sessionId: string, method: (typeof PAYMENT_METHODS)[number], extra = {}) =>
    createPaymentAttempt(pool, { authSessionId: u.authSessionId, sessionId, method, ...extra });
  const payWith = (u: TestUser, sessionId: string, attemptId: string) =>
    pay(pool, { authSessionId: u.authSessionId, sessionId, attemptId, idempotencyKey: key() });

  const NONE: Omit<PaymentMethodChange, "method"> = {
    enabled: true,
    displayOrder: 1,
    perAttemptLimitPaise: null,
    perDayLimitPaise: null,
    maintenanceFrom: null,
    maintenanceUntil: null,
  };
  const current = async (method: (typeof PAYMENT_METHODS)[number]) => {
    const m = (await adminPaymentMethods(pool, { authSessionId: admin.authSessionId })).methods.find(
      (x) => x.method === method,
    );
    if (!m) throw new Error("no such method");
    return {
      enabled: m.enabled,
      displayOrder: m.displayOrder,
      perAttemptLimitPaise: m.perAttemptLimitPaise,
      perDayLimitPaise: m.perDayLimitPaise,
      maintenanceFrom: m.maintenanceFrom,
      maintenanceUntil: m.maintenanceUntil,
    };
  };
  const propose = async (method: (typeof PAYMENT_METHODS)[number], over: Partial<PaymentMethodChange>) =>
    (await proposePaymentMethodChange(pool, {
      authSessionId: admin.authSessionId,
      reason: REASON,
      change: { method, ...(await current(method)), ...over },
    })) as { id: string };
  const due = (id: string) =>
    pool.query(
      "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
      [id],
    );
  const change = async (method: (typeof PAYMENT_METHODS)[number], over: Partial<PaymentMethodChange>) => {
    const a = await propose(method, over);
    await due(a.id);
    expect(await executeDueAdminActions(pool)).toMatchObject({ failed: 0 });
  };
  const stateOfAction = async (id: string) =>
    (
      await pool.query<{ state: string; outcome: { code?: string } | null }>(
        "SELECT state, outcome FROM audit.pending_action WHERE id = $1",
        [id],
      )
    ).rows[0];
  const longWindow = () => ({
    maintenanceFrom: new Date(Date.now() - 60_000).toISOString(),
    maintenanceUntil: new Date(Date.now() + WINDOW_MS).toISOString(),
  });
  const restoreAll = async () => {
    for (const method of PAYMENT_METHODS) {
      const c = await current(method);
      if (!c.enabled || c.perAttemptLimitPaise || c.perDayLimitPaise || c.maintenanceFrom) {
        await change(method, { ...NONE, displayOrder: c.displayOrder });
      }
    }
  };

  describe("the queue cannot stop all payments (major 2)", () => {
    it("US-35: four queued windows with 1-paise limits: the proposal that would leave nothing usable is refused, and the run re-checks the last", async () => {
      try {
        // each proposal alone leaves the other three usable, so all four are accepted into the queue
        const ids: string[] = [];
        for (const method of PAYMENT_METHODS) {
          ids.push(
            (await propose(method, { ...longWindow(), perAttemptLimitPaise: "1", perDayLimitPaise: "1" })).id,
          );
        }
        for (const id of ids) await due(id);
        const run = await executeDueAdminActions(pool);
        expect(run).toMatchObject({ executed: 3, failed: 1 });
        const states = await Promise.all(ids.map(stateOfAction));
        expect(states.filter((s) => s?.state === "EXECUTED")).toHaveLength(3);
        const failed = states.find((s) => s?.state === "FAILED");
        expect(failed?.outcome?.code).toBe("CONFIG_VALUE_INVALID");
        // one method is still usable now: checkout works
        const usable = (
          await adminPaymentMethods(pool, { authSessionId: admin.authSessionId })
        ).methods.filter((m) => m.available && m.perAttemptLimitPaise === null);
        expect(usable).toHaveLength(1);
        const buyer = await user(pool);
        const q = await quote(buyer, await fresh());
        const method = usable[0]?.method as (typeof PAYMENT_METHODS)[number];
        const a = await attempt(buyer, q.sessionId, method === "CARD" ? "BALANCE" : method, {
          ...(method === "DELULUPAY_ID"
            ? {
                delulupayId: (
                  await pool.query("SELECT upi_style_id AS i FROM core.bank_account WHERE user_id = $1", [
                    buyer.userId,
                  ])
                ).rows[0].i,
              }
            : {}),
        }).catch((e: { code: string }) => e);
        expect(a).not.toMatchObject({ code: "METHOD_UNAVAILABLE" });
        // and a proposal that alone would leave nothing usable is refused at once
        const last = usable[0]?.method as (typeof PAYMENT_METHODS)[number];
        expect(await codeOf(propose(last, { perAttemptLimitPaise: "1" }))).toBe("CONFIG_VALUE_INVALID");
        expect(await codeOf(propose(last, { enabled: false }))).toBe("CONFIG_VALUE_INVALID");
        expect(await codeOf(propose(last, longWindow()))).toBe("CONFIG_VALUE_INVALID");
      } finally {
        await restoreAll();
      }
      expect(
        (await adminPaymentMethods(pool, { authSessionId: admin.authSessionId })).methods.every(
          (m) => m.available,
        ),
      ).toBe(true);
    });

    it("US-35: limits below the floors do not count as usable, limits at the floors do", async () => {
      try {
        const floor = (
          await pool.query<{ a: string; d: string }>(
            "SELECT per_attempt::text AS a, per_day::text AS d FROM core.payment_limit_floors()",
          )
        ).rows[0];
        expect(floor).toBeDefined();
        for (const m of ["CARD", "DELULUPAY_ID", "NET_BANKING"] as const) await change(m, { enabled: false });
        // BALANCE is the only one left: it may not be pushed below the floors
        expect(
          await codeOf(propose("BALANCE", { perAttemptLimitPaise: String(BigInt(floor?.a ?? "1") - 1n) })),
        ).toBe("CONFIG_VALUE_INVALID");
        expect(
          await codeOf(propose("BALANCE", { perDayLimitPaise: String(BigInt(floor?.d ?? "1") - 1n) })),
        ).toBe("CONFIG_VALUE_INVALID");
        await change("BALANCE", {
          perAttemptLimitPaise: floor?.a ?? null,
          perDayLimitPaise: floor?.d ?? null,
        });
      } finally {
        await restoreAll();
      }
    });

    it("the proposal's audit row carries the full proposed values (no person)", async () => {
      const w = longWindow();
      const a = await propose("NET_BANKING", {
        ...w,
        perAttemptLimitPaise: "20000000",
        perDayLimitPaise: "30000000",
        displayOrder: 7,
      });
      const { rows } = await pool.query<{ detail: Record<string, unknown> }>(
        "SELECT detail FROM audit.audit_log WHERE action = 'admin_action.propose' AND target_id = $1",
        [a.id],
      );
      expect(rows[0]?.detail.proposed).toMatchObject({
        method: "NET_BANKING",
        enabled: true,
        displayOrder: 7,
        perAttemptLimitPaise: "20000000",
        perDayLimitPaise: "30000000",
      });
      expect(JSON.stringify(rows[0]?.detail)).not.toContain(admin.userId);
      await pool.query(
        "UPDATE audit.pending_action SET state = 'CANCELLED', cancelled_at = now(), cancel_reason = 'test' WHERE id = $1",
        [a.id],
      );
    });
  });

  describe("the daily limit counts the day of payment", () => {
    it("US-35: an attempt created before midnight and paid after it counts toward the day of payment, and yesterday's payments do not", async () => {
      await change("BALANCE", { perDayLimitPaise: String(1_500n * RUPEE) });
      try {
        const buyer = await user(pool);
        // ₹200 + ₹1,000 delivery = ₹1,200 each; the day allows ₹1,500
        const q1 = await quote(buyer, await fresh());
        const a1 = await attempt(buyer, q1.sessionId, "BALANCE");
        await plant(pool, (c) =>
          c.query(
            "UPDATE core.payment_attempt SET created_at = created_at - interval '2 days' WHERE id = $1",
            [a1.attemptId],
          ),
        );
        await payWith(buyer, q1.sessionId, a1.attemptId);
        const q2 = await quote(buyer, await fresh());
        expect(await codeOf(attempt(buyer, q2.sessionId, "BALANCE"))).toBe("METHOD_LIMIT_EXCEEDED");

        // a payment made on an earlier day does not count
        const other = await user(pool);
        const o1 = await quote(other, await fresh());
        const oa = await attempt(other, o1.sessionId, "BALANCE");
        const receipt = await payWith(other, o1.sessionId, oa.attemptId);
        await plant(pool, async (c) => {
          await c.query(
            "UPDATE core.order_group SET created_at = created_at - interval '2 days' WHERE id = $1",
            [receipt.orderGroupId],
          );
        });
        const o2 = await quote(other, await fresh());
        expect(await codeOf(attempt(other, o2.sessionId, "BALANCE"))).toBe("ok");
      } finally {
        await change("BALANCE", { perDayLimitPaise: null });
      }
      expect(await reconcile(pool)).toEqual(CLEAN);
    });
  });

  describe("a company registration is gated at pay (minor)", () => {
    it("US-35: a method turned off after the attempt exists fails the registration with nothing debited", async () => {
      const items = await published(pool, 3);
      const u = await user(pool);
      await completePassport(pool, u, items);
      const handle = `lamps-${Array.from(randomBytes(10), (b) => "bcdfghjkqvwxz"[b % 13]).join("")}`;
      const q = await companyQuote(pool, {
        authSessionId: u.authSessionId,
        handle,
        displayName: "Moon Lamps",
        description: "Lamps that are mostly moon.",
      });
      const a = await attempt(u, q.sessionId, "BALANCE");
      const before = await wallet(pool, u.ledgerAccountId);
      await change("BALANCE", { enabled: false });
      try {
        const err = await registerCompany(pool, {
          authSessionId: u.authSessionId,
          sessionId: q.sessionId,
          attemptId: a.attemptId,
          idempotencyKey: key(),
        }).catch((e: { code?: string; message?: string }) => e);
        expect(err).toMatchObject({ code: "METHOD_UNAVAILABLE" });
        expect(await wallet(pool, u.ledgerAccountId)).toBe(before);
        expect(
          await count(pool, "SELECT count(*) AS n FROM core.company WHERE owner_user_id = $1", [u.userId]),
        ).toBe(0);
        expect(
          (
            await pool.query<{ failure_code: string }>(
              "SELECT failure_code FROM core.payment_attempt WHERE id = $1",
              [a.attemptId],
            )
          ).rows[0]?.failure_code,
        ).toBe("METHOD_UNAVAILABLE");
      } finally {
        await change("BALANCE", { enabled: true });
      }
      expect(await reconcile(pool)).toEqual(CLEAN);
    });
  });

  describe("test scenarios and the inbox (minors)", () => {
    let staff: TestUser;
    beforeAll(async () => {
      staff = await user(pool);
      await pool.query("UPDATE core.user_profile SET is_test_account = true WHERE id = $1", [staff.userId]);
    });

    it("R4.6: a forced INSUFFICIENT_FUNDS decline is stored and shown as a test-scenario decline, never as a real reason", async () => {
      const q = await quote(staff, await fresh());
      const at = await attempt(staff, q.sessionId, "DELULUPAY_ID", {
        delulupayId: TEST_DELULUPAY_IDS.INSUFFICIENT_FUNDS,
      });
      await issuePaymentChallenge(pool, { authSessionId: staff.authSessionId, sessionId: q.sessionId });
      await expect(
        verifyPaymentChallenge(pool, {
          authSessionId: staff.authSessionId,
          sessionId: q.sessionId,
          decision: "APPROVE",
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
      const row = (await myPayments(pool, { authSessionId: staff.authSessionId })).items.find(
        (p) => p.id === at.attemptId,
      );
      expect(row).toMatchObject({ status: "FAILED", failureCode: "TEST_INSUFFICIENT_FUNDS" });
      expect(describeFailure(row?.failureCode).title).toMatch(/^Test scenario/);
      expect(describeFailure(row?.failureCode).message).toMatch(/No fictional money moved\./);
    });

    it("R4.6: a slow bank's code is not in the inbox before it answers", async () => {
      const q = await quote(staff, await fresh());
      const at = await attempt(staff, q.sessionId, "NET_BANKING", { scenario: "SLOW_BANK" });
      await issuePaymentChallenge(pool, { authSessionId: staff.authSessionId, sessionId: q.sessionId });
      const shown = async () =>
        (await myBankInbox(pool, { authSessionId: staff.authSessionId })).find(
          (m) => m.attemptId === at.attemptId,
        );
      expect((await shown())?.code).toBeUndefined();
      await pool.query(
        "UPDATE core.bank_inbox_message SET available_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1",
        [at.attemptId],
      );
      expect((await shown())?.code).toMatch(/^\d{6}$/);
    });

    it("the daily purge deletes closed inbox messages older than the retention and keeps recent ones", async () => {
      const q = await quote(staff, await fresh());
      const at = await attempt(staff, q.sessionId, "NET_BANKING");
      await issuePaymentChallenge(pool, { authSessionId: staff.authSessionId, sessionId: q.sessionId });
      await pool.query(
        "UPDATE core.bank_inbox_message SET code = NULL, cleared_at = now() WHERE attempt_id = $1",
        [at.attemptId],
      );
      const rows = () =>
        count(pool, "SELECT count(*) AS n FROM core.bank_inbox_message WHERE attempt_id = $1", [
          at.attemptId,
        ]);
      await pool.query("SELECT core.purge_idempotency_records()");
      expect(await rows()).toBe(1);
      await pool.query(
        "UPDATE core.bank_inbox_message SET created_at = created_at - interval '31 days' WHERE attempt_id = $1",
        [at.attemptId],
      );
      await pool.query("SELECT core.purge_idempotency_records()");
      expect(await rows()).toBe(0);
    });

    it("the hourly allowance for codes and approvals together defaults to 10", async () => {
      const { rows } = await pool.query<{ v: number }>(
        "SELECT core.payment_setting('challenge_codes_per_hour') AS v",
      );
      expect(rows[0]?.v).toBe(10);
    });
  });
});
