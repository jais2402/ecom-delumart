import { randomInt } from "node:crypto";
import { expect } from "vitest";
import * as attemptPin from "../../src/app/api/v1/attempts/[id]/pin/route";
import * as csrf from "../../src/app/api/v1/auth/csrf/route";
import * as devSignIn from "../../src/app/api/v1/auth/dev/sign-in/route";
import * as signOut from "../../src/app/api/v1/auth/sign-out/route";
import * as cardFreeze from "../../src/app/api/v1/cards/[id]/freeze/route";
import * as cardPinReset from "../../src/app/api/v1/cards/[id]/pin/reset/route";
import * as cardPin from "../../src/app/api/v1/cards/[id]/pin/route";
import * as cardReveal from "../../src/app/api/v1/cards/[id]/reveal/route";
import * as catalog from "../../src/app/api/v1/catalog/route";
import * as attempts from "../../src/app/api/v1/checkout-sessions/[id]/attempts/route";
import * as payRoute from "../../src/app/api/v1/checkout-sessions/[id]/pay/route";
import * as checkoutSessions from "../../src/app/api/v1/checkout-sessions/route";
import * as collection from "../../src/app/api/v1/collection/route";
import * as overlay from "../../src/app/api/v1/me/overlay/route";
import * as me from "../../src/app/api/v1/me/route";
import * as birthdate from "../../src/app/api/v1/onboarding/birthdate/route";
import * as phone from "../../src/app/api/v1/onboarding/phone/route";
import * as phoneVerify from "../../src/app/api/v1/onboarding/phone/verify/route";
import * as provision from "../../src/app/api/v1/onboarding/provision/route";
import * as order from "../../src/app/api/v1/orders/[id]/route";
import * as orders from "../../src/app/api/v1/orders/route";
import * as product from "../../src/app/api/v1/products/[id]/route";
import * as statement from "../../src/app/api/v1/statement/route";
import * as wallet from "../../src/app/api/v1/wallet/route";
import { Browser, str } from "./browser";

export const R = {
  attemptPin,
  csrf,
  devSignIn,
  signOut,
  cardFreeze,
  cardPinReset,
  cardPin,
  cardReveal,
  catalog,
  attempts,
  pay: payRoute,
  checkoutSessions,
  collection,
  overlay,
  me,
  birthdate,
  phone,
  phoneVerify,
  provision,
  order,
  orders,
  product,
  statement,
  wallet,
};

export const ADULT_BIRTHDATE = "1994-07-19";
/** A PIN that passes every rule for ADULT_BIRTHDATE. */
export const GOOD_PIN = "482913";

export function uniqueEmail(): string {
  return `player.${Date.now()}.${randomInt(1e9)}@example.test`;
}

export function uniquePhone(): string {
  return `+91 9${String(randomInt(1e9)).padStart(9, "0")}`;
}

/** A new browser with a CSRF token, signed in with the dev provider. */
export async function signedIn(email: string = uniqueEmail()): Promise<Browser> {
  const b = new Browser();
  const token = await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
  expect(token.status).toBe(200);
  b.csrfToken = str(token.json.csrfToken);
  const res = await b.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", { body: { email } });
  expect(res.status).toBe(200);
  return b;
}

/** Phone and birthdate steps for a signed-in browser. */
export async function onboard(b: Browser, birth: string = ADULT_BIRTHDATE, phoneNumber = uniquePhone()) {
  const sent = await b.call(R.phone.POST, "POST", "/api/v1/onboarding/phone", {
    body: { phone: phoneNumber },
  });
  expect(sent.status).toBe(200);
  const verified = await b.call(R.phoneVerify.POST, "POST", "/api/v1/onboarding/phone/verify", {
    body: { code: str(sent.json.devCode) },
  });
  expect(verified.status).toBe(200);
  return b.call(R.birthdate.POST, "POST", "/api/v1/onboarding/birthdate", { body: { birthdate: birth } });
}

/** A provisioned player with a PIN set; returns the browser and card id. */
export async function player(options: { pin?: boolean } = {}): Promise<{ b: Browser; cardId: string }> {
  const b = await signedIn();
  expect((await onboard(b)).status).toBe(200);
  const opened = await b.call(R.provision.POST, "POST", "/api/v1/onboarding/provision");
  expect(opened.status).toBe(201);
  const cardId = str(opened.json.card?.id);
  if (options.pin !== false) {
    const pin = await b.call(R.cardPin.POST, "POST", `/api/v1/cards/${cardId}/pin`, {
      params: { id: cardId },
      body: { pin: GOOD_PIN },
    });
    expect(pin.status).toBe(200);
  }
  return { b, cardId };
}

/** A checkout session for one product at standard delivery. */
export async function checkout(b: Browser, productId: string, key: string | boolean = true) {
  return b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
    body: { lines: [{ productId }], speedBySeller: { SEED: "STANDARD" } },
    idempotencyKey: key,
  });
}
