import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIn } from "../src/server/identity";
import { startTestApp, type TestApp } from "./helpers/app";
import { str } from "./helpers/browser";
import { checkout, GOOD_PIN, onboard, player, R, signedIn, uniquePhone } from "./helpers/flows";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.stop();
});

/** A birthdate that turns 18 tomorrow (in the server's zone). */
function seventeenYearsOld(): string {
  const [y, m, d] = todayIn().split("-").map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y - 18, m - 1, d + 1));
  return tomorrow.toISOString().slice(0, 10);
}

async function walletBalance(b: Awaited<ReturnType<typeof signedIn>>): Promise<string> {
  return str((await b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise);
}

describe("onboarding and PIN rules through the API", () => {
  it("US-49: an invalid phone number is PHONE_INVALID", async () => {
    const b = await signedIn();
    for (const phone of ["12345", "+1 202 555 0100", "+91 12345 67890", "98765 43210"]) {
      const res = await b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone } });
      expect(res.status).toBe(422);
      expect(res.json.error?.code).toBe("PHONE_INVALID");
    }
  });

  it("US-49: a wrong phone code is PHONE_CODE_FAILED and records nothing", async () => {
    const b = await signedIn();
    await b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone: uniquePhone() } });
    const res = await b.call(R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", {
      body: { code: "123456" },
    });
    expect(res.status).toBe(422);
    expect(res.json.error?.code).toBe("PHONE_CODE_FAILED");
    const me = await b.call(R.me.GET, "GET", "/api/v1/me");
    expect(me.json.onboarding?.phoneVerified).toBe(false);
  });

  it("US-49: one phone number cannot verify two accounts (CONFLICT)", async () => {
    const phone = uniquePhone();
    expect((await onboard(await signedIn(), undefined, phone)).status).toBe(200);
    const b = await signedIn();
    await b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone } });
    const res = await b.call(R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", {
      body: { code: "000000" },
    });
    expect(res.status).toBe(409);
    expect(res.json.error?.code).toBe("CONFLICT");
  });

  it("US-01: the birthdate needs a verified phone first", async () => {
    const b = await signedIn();
    const res = await b.call(R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
      body: { birthdate: "1990-01-01" },
    });
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("PHONE_REQUIRED");
  });

  it("US-01: an under-18 birthdate is UNDERAGE and provisioning is refused; no second birthdate", async () => {
    const b = await signedIn();
    const minor = await onboard(b, seventeenYearsOld());
    expect(minor.status).toBe(403);
    expect(minor.json.error?.code).toBe("UNDERAGE");
    const opened = await b.call(R.provision.POST, "POST", "/api/v1/onboarding/provision");
    expect(opened.status).toBe(403);
    expect(opened.json.error?.code).toBe("UNDERAGE");
    const wallet = await b.call(R.wallet.GET, "GET", "/api/v1/wallet");
    expect(wallet.status).toBe(404);
    const retry = await b.call(R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
      body: { birthdate: "1980-01-01" },
    });
    expect(retry.status).toBe(409);
    expect(retry.json.error?.code).toBe("CONFLICT");
  });

  it("US-01: a malformed or impossible birthdate is VALIDATION_FAILED", async () => {
    const b = await signedIn();
    await b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone: uniquePhone() } });
    await b.call(R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", { body: { code: "000000" } });
    for (const birthdate of ["1990-02-30", "19/07/1994", "tomorrow"]) {
      const res = await b.call(R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
        body: { birthdate },
      });
      expect(res.status).toBe(422);
      expect(res.json.error?.code).toBe("VALIDATION_FAILED");
    }
  });

  it("US-01: a birthdate in the future or more than 120 years ago is VALIDATION_FAILED and nothing is stored", async () => {
    const b = await signedIn();
    await b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", { body: { phone: uniquePhone() } });
    await b.call(R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", { body: { code: "000000" } });
    const [y, m, d] = todayIn().split("-").map(Number) as [number, number, number];
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const tomorrow = iso(new Date(Date.UTC(y, m - 1, d + 1)));
    const nextYear = iso(new Date(Date.UTC(y + 1, m - 1, d)));
    const tooOld = iso(new Date(Date.UTC(y - 120, m - 1, d - 1)));
    for (const birthdate of [tomorrow, nextYear, "9999-12-31", tooOld, "1800-01-01", "0001-01-01"]) {
      const res = await b.call(R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
        body: { birthdate },
      });
      expect(res.status, birthdate).toBe(422);
      expect(res.json.error?.code, birthdate).toBe("VALIDATION_FAILED");
    }
    const me = await b.call(R.me.GET, "GET", "/api/v1/me");
    expect(me.json.onboarding?.hasBirthdate).toBe(false);
    // the limits themselves: born today is a (recorded) minor; exactly 120 years ago is an adult
    const born120 = iso(new Date(Date.UTC(y - 120, m - 1, d)));
    const ok = await b.call(R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
      body: { birthdate: born120 },
    });
    expect(ok.status).toBe(200);
    const baby = await signedIn();
    const minor = await onboard(baby, todayIn());
    expect(minor.status).toBe(403);
    expect(minor.json.error?.code).toBe("UNDERAGE");
  });

  it("US-01: repeating the same birthdate is answered from the stored one", async () => {
    const b = await signedIn();
    expect((await onboard(b, "1991-03-03")).status).toBe(200);
    const again = await b.call(R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", {
      body: { birthdate: "1991-03-03" },
    });
    expect(again.status).toBe(200);
    expect(again.json.onboarding?.hasBirthdate).toBe(true);
  });

  it("US-48: weak PINs and birthdate-derived PINs are PIN_WEAK, and the PIN is never echoed", async () => {
    const { b, cardId } = await player({ pin: false }); // birthdate 1994-07-19
    const cases: [string, string][] = [
      ["111111", "REPEATED"],
      ["123456", "SEQUENTIAL"],
      ["12345", "FORMAT"],
      ["190794", "BIRTHDATE"],
      ["199407", "BIRTHDATE"],
      ["071994", "BIRTHDATE"],
    ];
    for (const [pin, reason] of cases) {
      const res = await b.call(R.cardPin.POST, "POST", `/api/v1/cards/${cardId}/pin`, {
        params: { id: cardId },
        body: { pin },
      });
      expect(res.status).toBe(422);
      expect(res.json.error?.code).toBe("PIN_WEAK");
      expect(res.json.error?.details?.reason).toBe(reason);
      expect(res.text).not.toContain(pin);
    }
    const me = await b.call(R.me.GET, "GET", "/api/v1/me");
    expect(me.json.onboarding?.pinSet).toBe(false);
  });

  it("US-48: changing the PIN needs the current one", async () => {
    const { b, cardId } = await player();
    const call = (body: object) =>
      b.call(R.cardPin.POST, "POST", `/api/v1/cards/${cardId}/pin`, { params: { id: cardId }, body });
    const without = await call({ pin: "736152" });
    expect(without.status).toBeGreaterThanOrEqual(400);
    expect(without.status).toBeLessThan(500);
    const wrong = await call({ pin: "736152", currentPin: "999000" });
    expect(wrong.json.error?.code).toBe("PIN_INCORRECT");
    const right = await call({ pin: "736152", currentPin: GOOD_PIN });
    expect(right.status).toBe(200);
  });

  it("US-48: three wrong PINs fail the attempt with no debit", async () => {
    const product = app.products[0];
    if (!product) throw new Error("no seed product");
    const { b, cardId } = await player();
    const before = await walletBalance(b);
    const session = await checkout(b, product.id);
    const sessionId = str(session.json.id);
    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "CARD", cardId },
    });
    const attemptId = str(attempt.json.id);
    const codes: string[] = [];
    for (const pin of ["111222", "222333", "333444"]) {
      const res = await b.call(R.attemptPin.POST, "POST", `/api/v1/attempts/${attemptId}/pin`, {
        params: { id: attemptId },
        body: { pin },
      });
      codes.push(str(res.json.error?.code));
      expect(res.text).not.toContain(pin);
    }
    expect(codes.slice(0, 2)).toEqual(["PIN_INCORRECT", "PIN_INCORRECT"]);
    expect(codes[2]).toBe("CHALLENGE_LOCKED");
    const late = await b.call(R.attemptPin.POST, "POST", `/api/v1/attempts/${attemptId}/pin`, {
      params: { id: attemptId },
      body: { pin: GOOD_PIN },
    });
    expect(late.status).toBeGreaterThanOrEqual(400);
    const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId },
      idempotencyKey: true,
    });
    expect(paid.status).toBeGreaterThanOrEqual(400);
    expect(await walletBalance(b)).toBe(before);
    const orders = await b.call(R.orders.GET, "GET", "/api/v1/orders");
    expect(orders.json.items).toEqual([]);
  });

  it("US-15: a frozen card cannot start a CARD payment; unfreezing restores it", async () => {
    const product = app.products[0];
    if (!product) throw new Error("no seed product");
    const { b, cardId } = await player();
    const frozen = await b.call(R.cardFreeze.POST, "POST", `/api/v1/cards/${cardId}/freeze`, {
      params: { id: cardId },
      body: { frozen: true },
    });
    expect(frozen.json).toEqual({ status: "FROZEN" });
    const session = await checkout(b, product.id);
    const sessionId = str(session.json.id);
    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "CARD", cardId },
    });
    expect(attempt.json.error?.code).toBe("CARD_FROZEN");
    const thawed = await b.call(R.cardFreeze.POST, "POST", `/api/v1/cards/${cardId}/freeze`, {
      params: { id: cardId },
      body: { frozen: false },
    });
    expect(thawed.json).toEqual({ status: "ACTIVE" });
  });

  it("US-48: the PIN routes are rate limited per session", async () => {
    const { b, cardId } = await player({ pin: false });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await b.call(R.cardPin.POST, "POST", `/api/v1/cards/${cardId}/pin`, {
        params: { id: cardId },
        body: { pin: "111111" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
