import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as paymentsRoute from "../src/app/api/v1/account/payments/route";
import * as adminMethodsRoute from "../src/app/api/v1/admin/payment-methods/route";
import * as cancelRoute from "../src/app/api/v1/attempts/[id]/cancel/route";
import * as attemptRoute from "../src/app/api/v1/attempts/[id]/route";
import * as inboxRoute from "../src/app/api/v1/bank/inbox/route";
import * as challengeRoute from "../src/app/api/v1/checkout-sessions/[id]/challenge/route";
import * as verifyRoute from "../src/app/api/v1/checkout-sessions/[id]/challenge/verify/route";
import * as methodsRoute from "../src/app/api/v1/payment-methods/route";
import { settleTracking } from "../src/server/analytics";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, type Browser, type CallResult, str } from "./helpers/browser";
import { checkout, player, R } from "./helpers/flows";
import { makeAdmin, runJobs } from "./helpers/studio";

/**
 * DeluluPay through the routes (PRD R4, R10; US-34 to US-37): the bank inbox, the challenge, the
 * Payments page's data, the real-payment-data rules and the events.
 */
let app: TestApp;
const REASON = "Scheduled maintenance agreed with the team";

beforeAll(async () => {
  app = await startTestApp();
}, 120_000);

afterAll(async () => {
  await app.stop();
});

function expectError(res: CallResult, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.json.error?.code).toBe(code);
}

const product = (i: number) => {
  const p = app.products[i];
  if (!p) throw new Error("no seed product");
  return p;
};

const attempt = (b: Browser, sessionId: string, body: unknown) =>
  b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body,
  });
const challenge = (b: Browser, sessionId: string) =>
  b.call(challengeRoute.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/challenge`, {
    params: { id: sessionId },
  });
const verify = (b: Browser, sessionId: string, body: unknown) =>
  b.call(verifyRoute.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/challenge/verify`, {
    params: { id: sessionId },
    body,
  });
const pay = (b: Browser, sessionId: string, attemptId: string) =>
  b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId },
    idempotencyKey: true,
  });
const inbox = (b: Browser) => b.call(inboxRoute.GET, "GET", "/api/v1/bank/inbox");
const openCode = async (b: Browser): Promise<string> => {
  const res = await inbox(b);
  expect(res.status).toBe(200);
  const open = arr(res.json.items).find((m) => m.status === ("OPEN" as unknown) && m.code !== undefined);
  return str(open?.code);
};
const myDeluluPayId = async (b: Browser) =>
  str((await b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.delulupayId);
const payments = (b: Browser, query = "") =>
  b.call(paymentsRoute.GET, "GET", `/api/v1/account/payments${query}`);

describe("net banking and DeluluPay ID through the routes", () => {
  it("US-35 US-36: net banking: the code reaches only the inbox; the right code pays; the page lists it as Captured", async () => {
    const { b } = await player({ pin: false });
    const s = await checkout(b, product(0).id);
    expect(s.status).toBe(201);
    const sessionId = str(s.json.id);
    const a = await attempt(b, sessionId, { method: "NET_BANKING" });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ method: "NET_BANKING", authenticated: false });
    const attemptId = str(a.json.id);

    // paying before the bank step is the retryable "awaiting authentication"
    expectError(await pay(b, sessionId, attemptId), 409, "PAYMENT_PENDING");

    const view = await b.call(attemptRoute.GET, "GET", `/api/v1/attempts/${attemptId}`, {
      params: { id: attemptId },
    });
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ status: "CREATED", amountPaise: s.json.totalPaise });
    expect(view.json.bankAlias).toMatch(/^DM-ACCT-/);

    const issued = await challenge(b, sessionId);
    expect(issued.status).toBe(201);
    expect(issued.json).toMatchObject({ kind: "CODE", method: "NET_BANKING", resendAfterSeconds: 30 });
    const code = await openCode(b);
    expect(code).toMatch(/^\d{6}$/);
    // the code is in no response but the inbox
    expect(issued.text).not.toContain(code);
    expect(view.text).not.toContain(code);
    expect(
      (await b.call(attemptRoute.GET, "GET", `/api/v1/attempts/${attemptId}`, { params: { id: attemptId } }))
        .json.status,
    ).toBe("AUTHENTICATING");

    const ok = await verify(b, sessionId, { code });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: "AUTHENTICATED" });
    expect((await pay(b, sessionId, attemptId)).status).toBe(200);

    const list = await payments(b);
    expect(list.status).toBe(200);
    expect(arr(list.json.items)[0]).toMatchObject({
      id: attemptId,
      method: "NET_BANKING",
      status: "CAPTURED",
      amountPaise: s.json.totalPaise,
      failureCode: null,
    });
    // the used code is gone from the inbox
    expect(arr((await inbox(b)).json.items).every((m) => m.code === undefined)).toBe(true);
  });

  it("US-36: three wrong codes fail the payment, with no debit and wording that says so; the page shows the reason", async () => {
    const { b } = await player({ pin: false });
    const before = str((await b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise);
    const s = await checkout(b, product(0).id);
    const sessionId = str(s.json.id);
    const a = await attempt(b, sessionId, { method: "NET_BANKING" });
    await challenge(b, sessionId);
    const right = await openCode(b);
    const wrong = right === "000000" ? "111111" : "000000";
    const one = await verify(b, sessionId, { code: wrong });
    expectError(one, 422, "CHALLENGE_FAILED");
    expect(one.json.error?.details).toMatchObject({ remainingTries: 2 });
    expect(one.json.error?.message).toMatch(/No fictional money moved\./);
    expectError(await verify(b, sessionId, { code: wrong }), 422, "CHALLENGE_FAILED");
    const last = await verify(b, sessionId, { code: wrong });
    expectError(last, 409, "CHALLENGE_LOCKED");
    expect(last.json.error?.message).toMatch(/No fictional money moved\./);
    expect(str((await b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise)).toBe(before);

    const row = arr((await payments(b)).json.items).find((p) => p.id === (str(a.json.id) as unknown));
    expect(row).toMatchObject({
      status: "FAILED",
      failureCode: "CHALLENGE_LOCKED",
      failureTitle: "Too many attempts",
    });
    expect(str(row?.failureMessage)).toMatch(/No fictional money moved\./);
  });

  it("US-35: a DeluluPay ID payment: the request appears in the inbox and Approve pays; Decline is 'cancelled by you'", async () => {
    const { b } = await player({ pin: false });
    const id = await myDeluluPayId(b);
    const s = await checkout(b, product(1).id);
    const sessionId = str(s.json.id);
    const a = await attempt(b, sessionId, { method: "DELULUPAY_ID", delulupayId: id.toUpperCase() });
    expect(a.status).toBe(201);
    const issued = await challenge(b, sessionId);
    expect(issued.json).toMatchObject({ kind: "APPROVE" });
    const [msg] = arr((await inbox(b)).json.items);
    expect(msg).toMatchObject({ kind: "APPROVAL", status: "OPEN", amountPaise: s.json.totalPaise });
    expect(msg?.code).toBeUndefined();

    const declined = await verify(b, sessionId, { decision: "DECLINE" });
    expect(declined.json).toMatchObject({ status: "DECLINED" });
    expect(arr((await payments(b)).json.items)[0]).toMatchObject({
      status: "FAILED",
      failureCode: "CANCELLED",
    });

    // the same session is still open: try again and approve
    const a2 = await attempt(b, sessionId, { method: "DELULUPAY_ID", delulupayId: id });
    await challenge(b, sessionId);
    expect((await verify(b, sessionId, { decision: "APPROVE" })).json).toMatchObject({
      status: "AUTHENTICATED",
    });
    expect((await pay(b, sessionId, str(a2.json.id))).status).toBe(200);
    expect(arr((await payments(b)).json.items)[0]).toMatchObject({
      status: "CAPTURED",
      method: "DELULUPAY_ID",
    });
  });

  it("US-34: cancelling an attempt is 'cancelled by you'; nobody else can cancel it or see it", async () => {
    const { b } = await player({ pin: false });
    const other = (await player({ pin: false })).b;
    const s = await checkout(b, product(0).id);
    const a = await attempt(b, str(s.json.id), { method: "BALANCE" });
    const attemptId = str(a.json.id);
    expectError(
      await other.call(cancelRoute.POST, "POST", `/api/v1/attempts/${attemptId}/cancel`, {
        params: { id: attemptId },
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await other.call(attemptRoute.GET, "GET", `/api/v1/attempts/${attemptId}`, {
        params: { id: attemptId },
      }),
      404,
      "NOT_FOUND",
    );
    const res = await b.call(cancelRoute.POST, "POST", `/api/v1/attempts/${attemptId}/cancel`, {
      params: { id: attemptId },
    });
    expect(res.status).toBe(200);
    expect(arr((await payments(b)).json.items)[0]).toMatchObject({
      failureCode: "CANCELLED",
      status: "FAILED",
    });
    expect(arr((await payments(other)).json.items)).toEqual([]);
  });

  it("US-36: the new routes need a sign-in, and every answer is private", async () => {
    const { b } = await player({ pin: false });
    const s = await checkout(b, product(0).id);
    const sessionId = str(s.json.id);
    await attempt(b, sessionId, { method: "NET_BANKING" });
    const anon = (await player({ pin: false })).b;
    anon.jar.clear();
    // signed out: refused (a POST without its session fails the CSRF check first, a GET is AUTH_REQUIRED)
    expect([401, 403]).toContain((await challenge(anon, sessionId)).status);
    expect([401, 403]).toContain((await verify(anon, sessionId, { code: "123456" })).status);
    expectError(await inbox(anon), 401, "AUTH_REQUIRED");
    for (const res of [
      await inbox(b),
      await payments(b),
      await b.call(methodsRoute.GET, "GET", "/api/v1/payment-methods"),
      await challenge(b, sessionId),
      await verify(b, sessionId, { code: "000000" }),
    ]) {
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    // a stranger cannot answer someone else's challenge
    const stranger = (await player({ pin: false })).b;
    expectError(await verify(stranger, sessionId, { code: "123456" }), 404, "NOT_FOUND");
  });
});

describe("no real payment data anywhere (PRD R4.5; US-37)", () => {
  it("US-37: no payment route reads a card number, expiry, CVV, UPI PIN or password; pasting one is refused", async () => {
    const { b } = await player({ pin: false });
    const s = await checkout(b, product(0).id);
    const sessionId = str(s.json.id);
    for (const body of [
      { method: "NET_BANKING", cardNumber: "4111111111111111" },
      { method: "NET_BANKING", expiry: "12/29", cvv: "123" },
      { method: "NET_BANKING", password: "hunter2" },
      { method: "DELULUPAY_ID", delulupayId: "someone@okaxis" },
      { method: "DELULUPAY_ID", delulupayId: "9876543210@ybl" },
      { method: "DELULUPAY_ID", delulupayId: "4111 1111 1111 1111" },
      { method: "DELULUPAY_ID", delulupayId: "4111111111111111@delulu" },
      { method: "DELULUPAY_ID", delulupayId: "aarav@delulu", upiPin: "1234" },
      { method: "CARD", cardId: "4111111111111111" },
    ]) {
      const res = await attempt(b, sessionId, body);
      expect([400, 422], JSON.stringify(body)).toContain(res.status);
      expect(res.json.error?.code, JSON.stringify(body)).toBe("VALIDATION_FAILED");
      // the pasted value is never echoed back
      expect(res.text).not.toContain("4111111111111111");
      expect(res.text).not.toContain("okaxis");
    }
    expect(arr((await payments(b)).json.items)).toEqual([]);
    // the challenge answer is six digits and nothing else
    await attempt(b, sessionId, { method: "NET_BANKING" });
    await challenge(b, sessionId);
    for (const body of [
      { code: "4111111111111111" },
      { code: "12345" },
      { code: "12345a" },
      { code: "123456", cvv: "123" },
      { decision: "APPROVE", code: "123456" },
      { pin: "123456" },
      {},
    ]) {
      const res = await verify(b, sessionId, body);
      expect([400, 422], JSON.stringify(body)).toContain(res.status);
      expect(res.json.error?.code).toBe("VALIDATION_FAILED");
    }
  });

  it("US-37: the coupon code field refuses card numbers, UPI handles, CVVs and expiries before anything is looked up", async () => {
    const { b } = await player({ pin: false });
    for (const couponCode of [
      "4111 1111 1111 1111",
      "4111111111111111",
      "name@okaxis",
      "cvv 123",
      "exp 12/27",
    ]) {
      const res = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
        body: { lines: [{ productId: product(0).id }], speedBySeller: { SEED: "STANDARD" }, couponCode },
        idempotencyKey: true,
      });
      expect([400, 422], couponCode).toContain(res.status);
      expect(res.json.error?.code, couponCode).toBe("VALIDATION_FAILED");
      expect(res.text).not.toContain("4111");
      expect(res.text).not.toContain("okaxis");
    }
    // an ordinary (unknown) code reaches the coupon lookup as before
    const ok = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
      body: {
        lines: [{ productId: product(0).id }],
        speedBySeller: { SEED: "STANDARD" },
        couponCode: "SUMMER25",
      },
      idempotencyKey: true,
    });
    expect(ok.json.error?.code).toBe("COUPON_INVALID");
  });
});

describe("test scenarios are never reachable by a normal player (PRD R4.6)", () => {
  it("US-35: a reserved test ID or a scenario from a player is refused; the methods answer says scenarios are closed", async () => {
    const { b } = await player({ pin: false });
    const methods = await b.call(methodsRoute.GET, "GET", "/api/v1/payment-methods");
    expect(methods.json.scenariosAllowed).toBe(false);
    const s = await checkout(b, product(0).id);
    const sessionId = str(s.json.id);
    expectError(
      await attempt(b, sessionId, { method: "DELULUPAY_ID", delulupayId: "testpay.insufficient@delulu" }),
      422,
      "VALIDATION_FAILED",
    );
    expectError(
      await attempt(b, sessionId, { method: "NET_BANKING", scenario: "CODE_LOCKOUT" }),
      422,
      "VALIDATION_FAILED",
    );
    const unknown = await attempt(b, sessionId, { method: "NET_BANKING", scenario: "ANYTHING" });
    expect([400, 422]).toContain(unknown.status);
    expect(unknown.json.error?.code).toBe("VALIDATION_FAILED");
    expect(arr((await payments(b)).json.items)).toEqual([]);
  });
});

describe("method configuration through the console (R7)", () => {
  it("US-35: the Super Admin queues a method change; it waits, then applies; a disabled method cannot be used through the API", async () => {
    const admin = (await player({ pin: false })).b;
    await makeAdmin(app, admin);
    const { b } = await player({ pin: false });

    const before = await admin.call(adminMethodsRoute.GET, "GET", "/api/v1/admin/payment-methods");
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("private, no-store");
    expect(arr(before.json.methods).map((m) => m.method)).toEqual([
      "CARD",
      "DELULUPAY_ID",
      "NET_BANKING",
      "BALANCE",
    ]);
    // a player is refused
    expectError(
      await b.call(adminMethodsRoute.GET, "GET", "/api/v1/admin/payment-methods"),
      403,
      "FORBIDDEN",
    );

    const proposed = await admin.call(adminMethodsRoute.POST, "POST", "/api/v1/admin/payment-methods", {
      body: {
        method: "NET_BANKING",
        enabled: false,
        displayOrder: 3,
        perAttemptLimitPaise: null,
        perDayLimitPaise: null,
        maintenanceFrom: null,
        maintenanceUntil: null,
        reason: REASON,
      },
    });
    expect(proposed.status).toBe(201);
    expect(proposed.json.action).toMatchObject({
      kind: "payment_method.set",
      key: "payment_method.NET_BANKING",
      state: "QUEUED",
    });
    const id = str(proposed.json.action?.id);
    // not applied yet
    const s = await checkout(b, product(0).id);
    expect((await attempt(b, str(s.json.id), { method: "NET_BANKING" })).status).toBe(201);
    await app.db.pool.query(
      "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
      [id],
    );
    expect(await runJobs()).toBe(200);
    const s2 = await checkout(b, product(1).id);
    const refused = await attempt(b, str(s2.json.id), { method: "NET_BANKING" });
    expectError(refused, 422, "METHOD_UNAVAILABLE");
    expect(str(refused.json.error?.message)).toMatch(/No fictional money moved\./);
    const offered = await b.call(methodsRoute.GET, "GET", "/api/v1/payment-methods");
    expect(arr(offered.json.methods).find((m) => m.method === ("NET_BANKING" as unknown))).toMatchObject({
      available: false,
      reason: "OFF",
    });
    // a method limit refuses in the PRD's words
    const limit = await admin.call(adminMethodsRoute.POST, "POST", "/api/v1/admin/payment-methods", {
      body: {
        method: "BALANCE",
        enabled: true,
        displayOrder: 4,
        perAttemptLimitPaise: "100",
        perDayLimitPaise: null,
        maintenanceFrom: null,
        maintenanceUntil: null,
        reason: REASON,
      },
    });
    await app.db.pool.query(
      "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
      [str(limit.json.action?.id)],
    );
    expect(await runJobs()).toBe(200);
    const over = await attempt(b, str(s2.json.id), { method: "BALANCE" });
    expectError(over, 422, "METHOD_LIMIT_EXCEEDED");
    expect(str(over.json.error?.message)).toMatch(/No fictional money moved\./);

    // put both back, through the same queue, for the tests that follow
    for (const body of [
      { method: "NET_BANKING", enabled: true, displayOrder: 3, perAttemptLimitPaise: null },
      { method: "BALANCE", enabled: true, displayOrder: 4, perAttemptLimitPaise: null },
    ]) {
      const back = await admin.call(adminMethodsRoute.POST, "POST", "/api/v1/admin/payment-methods", {
        body: {
          perDayLimitPaise: null,
          maintenanceFrom: null,
          maintenanceUntil: null,
          reason: REASON,
          ...body,
        },
      });
      expect(back.status).toBe(201);
      await app.db.pool.query(
        "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
        [str(back.json.action?.id)],
      );
    }
    expect(await runJobs()).toBe(200);
    const again = await checkout(b, product(2).id);
    expect((await attempt(b, str(again.json.id), { method: "NET_BANKING" })).status).toBe(201);
  });
});

describe("events (R10): the method only, no user id, no code", () => {
  it("US-36: the challenge writes payment events with one `method` prop; no code or user id is stored anywhere", async () => {
    const { b } = await player({ pin: false });
    const s = await checkout(b, product(2).id);
    const sessionId = str(s.json.id);
    const made = await attempt(b, sessionId, { method: "NET_BANKING" });
    expect(made.status, made.text).toBe(201);
    const issued = await challenge(b, sessionId);
    expect(issued.status, issued.text).toBe(201);
    const code = await openCode(b);
    await verify(b, sessionId, { code });
    await settleTracking();
    const { rows } = await app.db.pool.query<{
      name: string;
      props: Record<string, unknown>;
      visitor_key: Buffer | null;
    }>("SELECT name, props, visitor_key FROM analytics.event WHERE name LIKE 'payment_%' ORDER BY id");
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "payment_method_selected",
        "payment_challenge_issued",
        "payment_challenge_passed",
      ]),
    );
    for (const r of rows) {
      expect(r.props).toEqual({ method: expect.stringMatching(/^(CARD|DELULUPAY_ID|NET_BANKING|BALANCE)$/) });
      expect(r.visitor_key).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain(code);
    const outbox = await app.db.pool.query(
      "SELECT count(*) AS n FROM audit.outbox WHERE payload::text LIKE $1",
      [`%"${code}"%`],
    );
    expect(Number(outbox.rows[0]?.n)).toBe(0);
  });
});
