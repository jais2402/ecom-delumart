/**
 * DeluluPay payment simulator rules (PRD R4, R10, R11 US-34 to US-37). Pure functions and
 * constants: the methods, the status model, the decline wording, the challenge numbers, the test
 * scenarios and the screening that keeps real payment data out of every field.
 *
 * The database (migrations 0100 to 0103) holds the same numbers as configuration keys with these
 * defaults, clamped, and enforces the same rules again; database tests check the two agree. Money
 * is never computed here: a payment's amount always comes from the pricing function.
 */

export const PAYMENT_METHODS = ["CARD", "DELULUPAY_ID", "NET_BANKING", "BALANCE"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/** Names shown to the player (no real bank, network or payment-app names, PRD R4.5). */
export const METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  CARD: "Delulu Card",
  DELULUPAY_ID: "DeluluPay ID",
  NET_BANKING: "Net banking (Delulu Bank)",
  BALANCE: "Bank balance",
};

/** Default display order (the back office changes it through the delayed queue). */
export const METHOD_DEFAULT_ORDER: Readonly<Record<PaymentMethod, number>> = {
  CARD: 1,
  DELULUPAY_ID: 2,
  NET_BANKING: 3,
  BALANCE: 4,
};

/**
 * The authentication step (PRD R4.4, LLD §11.2), each number a configuration key in the database
 * (`challenge_ttl_seconds`, `challenge_tries`, `challenge_resend_seconds`, `challenge_codes_per_hour`,
 * `challenge_slow_bank_seconds`) read with these defaults, clamped.
 */
export const CHALLENGE_RULES = {
  codeLength: 6,
  /** A code or an approval request is valid for three minutes. */
  ttlSeconds: 180,
  /** Wrong tries on one payment attempt before CHALLENGE_LOCKED. */
  tries: 3,
  /** A new code may be asked for this long after the last one. */
  resendSeconds: 30,
  /** Codes and approval requests issued per account per hour (counted together). */
  codesPerHour: 10,
  /** The SLOW_BANK test scenario answers this long after the request. */
  slowBankSeconds: 8,
} as const;

/** Test scenarios (PRD R4.6): forced outcomes for staff and staging, never random, never for players. */
export const PAYMENT_SCENARIOS = [
  "INSUFFICIENT_FUNDS",
  "BANK_UNAVAILABLE",
  "SLOW_BANK",
  "CODE_LOCKOUT",
  "CODE_EXPIRED",
] as const;
export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

/** Reserved test DeluluPay IDs: they contain a dot, which no player's ID can (handles are [a-z0-9-]). */
export const TEST_DELULUPAY_IDS: Readonly<Record<PaymentScenario, string>> = {
  INSUFFICIENT_FUNDS: "testpay.insufficient@delulu",
  BANK_UNAVAILABLE: "testpay.bankdown@delulu",
  SLOW_BANK: "testpay.slow@delulu",
  CODE_LOCKOUT: "testpay.lockout@delulu",
  CODE_EXPIRED: "testpay.expired@delulu",
};

export function isPaymentScenario(value: unknown): value is PaymentScenario {
  return typeof value === "string" && (PAYMENT_SCENARIOS as readonly string[]).includes(value);
}

/** The scenario a reserved test ID forces, or null for any other ID. */
export function reservedScenarioOf(id: string): PaymentScenario | null {
  const lower = id.trim().toLowerCase();
  for (const scenario of PAYMENT_SCENARIOS) {
    if (TEST_DELULUPAY_IDS[scenario] === lower) return scenario;
  }
  return null;
}

// ---------------------------------------------------------------------------- status model

export type PaymentDisplayStatus =
  | "CREATED"
  | "AUTHENTICATING"
  | "AUTHORISED"
  | "CAPTURED"
  | "FAILED"
  | "REFUNDED";

export const STATUS_LABELS: Readonly<Record<PaymentDisplayStatus, string>> = {
  CREATED: "Created",
  AUTHENTICATING: "Authenticating",
  AUTHORISED: "Authorised",
  CAPTURED: "Captured",
  FAILED: "Failed",
  REFUNDED: "Refunded",
};

export interface AttemptFacts {
  state: "PENDING" | "SUCCEEDED" | "FAILED";
  authenticated: boolean;
  /** A PIN step has started, or a code or approval request was issued. */
  challengeIssued: boolean;
  /** The checkout session is still open and unexpired. */
  sessionLive: boolean;
  /** The order was reversed by staff. */
  reversed: boolean;
}

/**
 * Created → Authenticating → Authorised → Captured, or Failed (later Refunded), over the stored
 * PENDING / SUCCEEDED / FAILED states (PRD R4.3). "Authorised" and "Captured" are stages of the
 * one atomic commit: nothing here is a ledger event. A pending attempt whose session ended shows
 * as Failed with the reason "session expired".
 */
export function displayStatus(a: AttemptFacts): PaymentDisplayStatus {
  if (a.state === "SUCCEEDED") return a.reversed ? "REFUNDED" : "CAPTURED";
  if (a.state === "FAILED") return "FAILED";
  if (!a.sessionLive) return "FAILED";
  if (a.authenticated) return "AUTHORISED";
  return a.challengeIssued ? "AUTHENTICATING" : "CREATED";
}

// ---------------------------------------------------------------------------- decline reasons

export interface DeclineReason {
  title: string;
  message: string;
}

const NO_MONEY = "No fictional money moved.";

/** PRD R4.3: each reason states that no fictional money moved. Keys are the stored failure codes. */
export const DECLINE_REASONS: Readonly<Record<string, DeclineReason>> = {
  INSUFFICIENT_FUNDS: {
    title: "Insufficient funds",
    message: `Your bank balance is lower than the amount. ${NO_MONEY}`,
  },
  CARD_FROZEN: { title: "Card frozen", message: `The Delulu Card is frozen. ${NO_MONEY}` },
  CARD_REPLACED: { title: "Card replaced", message: `That Delulu Card has been replaced. ${NO_MONEY}` },
  CHALLENGE_FAILED: { title: "Wrong code", message: `The code was not right. ${NO_MONEY}` },
  CHALLENGE_EXPIRED: { title: "Code expired", message: `The code ran out of time. ${NO_MONEY}` },
  CHALLENGE_LOCKED: {
    title: "Too many attempts",
    message: `Too many wrong tries for this payment. ${NO_MONEY}`,
  },
  CANCELLED: { title: "Cancelled by you", message: `You cancelled this payment. ${NO_MONEY}` },
  METHOD_UNAVAILABLE: {
    title: "Method unavailable",
    message: `That payment method is not available right now. ${NO_MONEY}`,
  },
  METHOD_LIMIT_EXCEEDED: {
    title: "Method limit exceeded",
    message: `This amount is over the limit for that payment method. ${NO_MONEY}`,
  },
  BANK_UNAVAILABLE: {
    title: "Bank temporarily unavailable",
    message: `Delulu Bank could not be reached. Try again soon. ${NO_MONEY}`,
  },
  CHECKOUT_EXPIRED: {
    title: "Session expired",
    message: `The checkout session ran out of time. ${NO_MONEY}`,
  },
  // a decline forced by a test scenario (PRD R4.6) is marked, so it never reads as a real reason
  TEST_INSUFFICIENT_FUNDS: {
    title: "Test scenario: insufficient funds",
    message: `This decline was forced by a test scenario, not by your balance. ${NO_MONEY}`,
  },
  PIN_LOCKED: { title: "Card locked", message: `The card is locked after wrong PINs. ${NO_MONEY}` },
  CART_CHANGED: { title: "Cart changed", message: `Something in the cart changed. ${NO_MONEY}` },
  PRICE_CHANGED: { title: "Price changed", message: `A price changed. ${NO_MONEY}` },
  SOLD_OUT: { title: "Sold out", message: `An item sold out. ${NO_MONEY}` },
  ALREADY_OWNED: { title: "Already owned", message: `You already own an item. ${NO_MONEY}` },
};

const GENERIC_DECLINE: DeclineReason = {
  title: "Payment failed",
  message: `The payment could not be completed. ${NO_MONEY}`,
};

/** The wording for a stored failure code; an unknown code gets the generic text and is never echoed. */
export function describeFailure(code: string | null | undefined): DeclineReason {
  if (code === null || code === undefined) return GENERIC_DECLINE;
  return Object.hasOwn(DECLINE_REASONS, code) ? (DECLINE_REASONS[code] as DeclineReason) : GENERIC_DECLINE;
}

// ---------------------------------------------------------------------------- DeluluPay IDs

const DELULUPAY_ID = /^[a-z0-9][a-z0-9._-]{1,40}@delulu$/;

export type DeluluPayIdCheck = { ok: true; id: string } | { ok: false; reason: "FORMAT" | "NOT_DELULU" };

/** A DeluluPay ID ends in @delulu (PRD R4.5); case and surrounding space are ignored. */
export function parseDeluluPayId(text: string): DeluluPayIdCheck {
  const id = text.trim().toLowerCase();
  if (DELULUPAY_ID.test(id)) return { ok: true, id };
  return { ok: false, reason: id.includes("@") && !id.endsWith("@delulu") ? "NOT_DELULU" : "FORMAT" };
}

// ---------------------------------------------------------------------------- real payment data

/**
 * Does this text look like real payment data: a card number (13 to 19 digits however separated), a
 * UPI handle that is not a DeluluPay ID, a CVV or expiry, a PIN or a password (PRD R4.5, US-37)?
 * Applied to every free-text field in checkout (the coupon code, the DeluluPay ID). A false
 * positive only asks the player to type something else; a false negative would let a real credential
 * through, so the check leans strict.
 */
export function looksLikeRealPaymentData(text: string): boolean {
  const s = text.normalize("NFKC");
  // a run of 13 to 19 digits, spaces, dots and dashes: a card number
  for (const run of s.match(/\d(?:[\s.-]{0,3}\d){12,18}/g) ?? []) {
    const n = run.replace(/\D/g, "").length;
    if (n >= 13 && n <= 19) return true;
  }
  // a handle at a provider: anything@something that is not @delulu
  for (const handle of s.match(/[^\s@]+@[^\s@]+/g) ?? []) {
    if (!/@delulu$/i.test(handle)) return true;
  }
  // an expiry date: MM/YY or MM/YYYY anywhere; MM-YY or MM-YYYY only as the whole text (so a code such as
  // SAVE-10-25 is not mistaken for one)
  if (/(?:^|\D)(?:0[1-9]|1[0-2])\s*\/\s*(?:\d{2}|\d{4})(?:\D|$)/.test(s)) return true;
  if (/^\s*(?:0[1-9]|1[0-2])\s*-\s*(?:\d{2}|\d{4})\s*$/.test(s)) return true;
  // words that introduce a secret, followed by anything
  if (/(?<![a-z])(?:cvv|cvc|cid|expiry|exp(?:ires?)?|pin|otp|passcode|password|passwd|pwd)(?![a-z])/i.test(s))
    return true;
  return false;
}
