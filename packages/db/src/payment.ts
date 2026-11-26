/**
 * DeluluPay: the authentication step, the bank inbox, the payments list and the method
 * configuration (migrations 0100 to 0103; PRD R4, R10; US-34 to US-37).
 *
 * Commands (issue a code, verify, cancel) run as app_pay for the caller's sign-in session; the
 * database derives the payer from it. A failure that must leave a trace (the third wrong code, an
 * expired code, a declined approval) is committed by the database and returned as a status, and
 * these wrappers then throw the matching DomainError, so the counters and the FAILED attempt stay
 * written. No function here ever returns, logs or echoes a code except `myBankInbox`, which is the
 * payer's own private read.
 */
import {
  DomainError,
  describeFailure,
  type PaymentDisplayStatus,
  type PaymentMethod,
  type PaymentScenario,
} from "@delulu/core";
import type { Pool } from "pg";
import { asPay, asWeb, domainErrorOf, one, requireUuid } from "./command";

// ---------------------------------------------------------------------------- challenge

export interface IssuedChallenge {
  attemptId: string;
  reference: string;
  method: Extract<PaymentMethod, "DELULUPAY_ID" | "NET_BANKING">;
  kind: "CODE" | "APPROVE";
  expiresAt: string;
  resendAfterSeconds: number;
  /** Set while a (test) slow bank has not answered yet. */
  availableAt: string | null;
}

type IssueRow =
  | ({ status: "ISSUED" } & IssuedChallenge)
  | { status: "FAILED"; code: string; attemptId: string; method: PaymentMethod };

/** The code or approval request for the session's pending attempt. The code is NOT returned: it is in the bank inbox. */
export async function issuePaymentChallenge(
  pool: Pool,
  input: { authSessionId: string; sessionId: string },
): Promise<IssuedChallenge> {
  requireUuid(input.sessionId, "sessionId");
  const row = await asPay(pool, input.authSessionId, (c) =>
    one<IssueRow>(c, "SELECT core.issue_payment_challenge($1) AS r", [input.sessionId]),
  );
  if (row.status === "FAILED") throw failureOf(row.code, row.method);
  return {
    attemptId: row.attemptId,
    reference: row.reference,
    method: row.method,
    kind: row.kind,
    expiresAt: row.expiresAt,
    resendAfterSeconds: row.resendAfterSeconds,
    availableAt: row.availableAt ?? null,
  };
}

export type VerifyOutcome =
  | { status: "AUTHENTICATED"; attemptId: string; method: PaymentMethod }
  /** A slow bank (test scenario) has not answered; ask again after this many seconds. */
  | { status: "WAITING"; attemptId: string; method: PaymentMethod; retryAfterSeconds: number }
  /** The player declined the approval request: the attempt ended, no money moved. */
  | { status: "DECLINED"; attemptId: string; method: PaymentMethod };

type VerifyRow =
  | { status: "AUTHENTICATED"; attemptId: string; method: PaymentMethod }
  | { status: "WAITING"; attemptId: string; method: PaymentMethod; retryAfterSeconds: number }
  | { status: "INCORRECT"; attemptId: string; method: PaymentMethod; remainingTries: number }
  | { status: "FAILED"; attemptId: string; method: PaymentMethod; code: string };

/**
 * Checks the code (net banking) or applies the decision (DeluluPay ID approval). Throws
 * CHALLENGE_FAILED (with details.remainingTries) for a wrong code, and CHALLENGE_LOCKED,
 * CHALLENGE_EXPIRED, INSUFFICIENT_FUNDS, METHOD_UNAVAILABLE, CHECKOUT_EXPIRED when the attempt ended.
 */
export async function verifyPaymentChallenge(
  pool: Pool,
  input: { authSessionId: string; sessionId: string; code?: string; decision?: "APPROVE" | "DECLINE" },
): Promise<VerifyOutcome> {
  requireUuid(input.sessionId, "sessionId");
  if ((input.code === undefined) === (input.decision === undefined)) {
    throw new DomainError("VALIDATION_FAILED", "give a code or a decision");
  }
  const row = await asPay(pool, input.authSessionId, (c) =>
    one<VerifyRow>(c, "SELECT core.verify_payment_challenge($1, $2, $3) AS r", [
      input.sessionId,
      input.code ?? null,
      input.decision ?? null,
    ]),
  );
  switch (row.status) {
    case "AUTHENTICATED":
    case "WAITING":
      return row;
    case "INCORRECT":
      throw new DomainError("CHALLENGE_FAILED", describeFailure("CHALLENGE_FAILED").message, {
        remainingTries: row.remainingTries,
        method: row.method,
      });
    case "FAILED":
      if (row.code === "CANCELLED")
        return { status: "DECLINED", attemptId: row.attemptId, method: row.method };
      throw failureOf(row.code, row.method);
  }
}

/** "Cancelled by you": ends the caller's own pending attempt. No money moved. */
export async function cancelPaymentAttempt(
  pool: Pool,
  input: { authSessionId: string; attemptId: string },
): Promise<{ attemptId: string }> {
  requireUuid(input.attemptId, "attemptId");
  const row = await asPay(pool, input.authSessionId, (c) =>
    one<{ attemptId: string }>(c, "SELECT core.cancel_payment_attempt($1) AS r", [input.attemptId]),
  );
  return { attemptId: row.attemptId };
}

/** A stored failure code as the DomainError the API answers with; the wording says no money moved. */
function failureOf(code: string, method: PaymentMethod): DomainError {
  // a forced test decline is answered as the error it imitates, with its own marked wording
  const known = domainErrorOf({
    code: code === "TEST_INSUFFICIENT_FUNDS" ? "INSUFFICIENT_FUNDS" : code,
    message: describeFailure(code).message,
  });
  return new DomainError(known.code, describeFailure(code).message, { method });
}

// ---------------------------------------------------------------------------- reads

export interface PaymentRow {
  id: string;
  reference: string;
  method: PaymentMethod;
  status: PaymentDisplayStatus;
  /** The stored decline code of a Failed payment; wording in @delulu/core describeFailure. */
  failureCode: string | null;
  amountPaise: bigint;
  createdAt: string;
  orderGroupId: string | null;
}

export interface PaymentsPage {
  items: PaymentRow[];
  nextCursor: string | null;
}

interface PaymentRowJson extends Omit<PaymentRow, "amountPaise"> {
  amountPaise: string;
}

/** The caller's own payment attempts, newest first (R3 Payments; US-34). */
export async function myPayments(
  pool: Pool,
  input: { authSessionId: string; cursor?: string | null; limit?: number },
): Promise<PaymentsPage> {
  const page = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: PaymentRowJson[]; nextCursor: string | null }>(c, "SELECT core.my_payments($1, $2) AS r", [
      input.cursor ?? null,
      input.limit ?? null,
    ]),
  );
  return {
    items: page.items.map((i) => ({ ...i, amountPaise: BigInt(i.amountPaise) })),
    nextCursor: page.nextCursor,
  };
}

export interface PaymentAttemptView {
  id: string;
  sessionId: string;
  reference: string;
  method: PaymentMethod;
  status: PaymentDisplayStatus;
  failureCode: string | null;
  authenticated: boolean;
  amountPaise: bigint;
  /** The payer's bank alias (never a number). */
  bankAlias: string | null;
  delulupayId: string | null;
  sessionExpiresAt: string;
  createdAt: string;
  challenge?: {
    kind: "CODE" | "APPROVE";
    issuedAt: string;
    expiresAt: string;
    availableAt: string | null;
    triesLeft: number;
    resendAfterSeconds: number;
  };
}

export async function myPaymentAttempt(
  pool: Pool,
  input: { authSessionId: string; attemptId: string },
): Promise<PaymentAttemptView> {
  requireUuid(input.attemptId, "attemptId");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Omit<PaymentAttemptView, "amountPaise"> & { amountPaise: string }>(
      c,
      "SELECT core.my_payment_attempt($1) AS r",
      [input.attemptId],
    ),
  );
  return { ...r, amountPaise: BigInt(r.amountPaise) };
}

export interface BankInboxMessage {
  id: string;
  kind: "CODE" | "APPROVAL";
  attemptId: string;
  sessionId: string;
  reference: string;
  amountPaise: bigint;
  createdAt: string;
  expiresAt: string;
  availableAt: string | null;
  status: "OPEN" | "USED" | "EXPIRED" | "CLOSED";
  /** The six-digit code, only while the message is open; the one place a code is ever readable. */
  code?: string;
}

/** The caller's own bank inbox, newest first. Private: the response must be `private, no-store`. */
export async function myBankInbox(pool: Pool, input: { authSessionId: string }): Promise<BankInboxMessage[]> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{
      items: (Omit<BankInboxMessage, "amountPaise" | "code"> & {
        amountPaise: string;
        code: string | null;
      })[];
    }>(c, "SELECT core.my_bank_inbox() AS r", []),
  );
  return r.items.map((m) => {
    const { code, ...rest } = m;
    return { ...rest, amountPaise: BigInt(m.amountPaise), ...(typeof code === "string" ? { code } : {}) };
  });
}

export interface CheckoutMethod {
  method: PaymentMethod;
  displayOrder: number;
  available: boolean;
  reason?: "OFF" | "MAINTENANCE";
  maintenanceUntil?: string;
  perAttemptLimitPaise: bigint | null;
  perDayLimitPaise: bigint | null;
}

export interface CheckoutMethods {
  /** Test scenarios (PRD R4.6) are open to this caller: staff, or staging with the owner's switch on. */
  scenariosAllowed: boolean;
  methods: CheckoutMethod[];
}

export async function checkoutPaymentMethods(
  pool: Pool,
  input: { authSessionId: string },
): Promise<CheckoutMethods> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{
      scenariosAllowed: boolean;
      methods: (Omit<CheckoutMethod, "perAttemptLimitPaise" | "perDayLimitPaise"> & {
        perAttemptLimitPaise: string | null;
        perDayLimitPaise: string | null;
      })[];
    }>(c, "SELECT core.checkout_payment_methods() AS r", []),
  );
  return {
    scenariosAllowed: r.scenariosAllowed,
    methods: r.methods.map((m) => ({
      ...m,
      reason: m.reason ?? undefined,
      maintenanceUntil: m.maintenanceUntil ?? undefined,
      perAttemptLimitPaise: m.perAttemptLimitPaise === null ? null : BigInt(m.perAttemptLimitPaise),
      perDayLimitPaise: m.perDayLimitPaise === null ? null : BigInt(m.perDayLimitPaise),
    })),
  };
}

// ---------------------------------------------------------------------------- the console

export interface AdminPaymentMethod {
  method: PaymentMethod;
  version: number;
  enabled: boolean;
  switchOn: boolean;
  displayOrder: number;
  perAttemptLimitPaise: string | null;
  perDayLimitPaise: string | null;
  maintenanceFrom: string | null;
  maintenanceUntil: string | null;
  inMaintenance: boolean;
  available: boolean;
  pendingActionId: string | null;
}

export interface AdminPaymentMethods {
  serverNow: string;
  delaySeconds: number;
  methods: AdminPaymentMethod[];
}

export function adminPaymentMethods(
  pool: Pool,
  input: { authSessionId: string },
): Promise<AdminPaymentMethods> {
  return asWeb(pool, input.authSessionId, (c) =>
    one<AdminPaymentMethods>(c, "SELECT core.admin_payment_methods() AS r", []),
  );
}

export interface PaymentMethodChange {
  method: PaymentMethod;
  enabled: boolean;
  displayOrder: number;
  /** Paise as a decimal string, or null for no limit. */
  perAttemptLimitPaise: string | null;
  perDayLimitPaise: string | null;
  /** ISO times with a zone, both or neither. */
  maintenanceFrom: string | null;
  maintenanceUntil: string | null;
}

/** Proposes a payment method change; it joins the 24-hour delayed queue (decisions.md #16). */
export async function proposePaymentMethodChange(
  pool: Pool,
  input: { authSessionId: string; change: PaymentMethodChange; reason: string },
): Promise<unknown> {
  const c = input.change;
  return asWeb(pool, input.authSessionId, (client) =>
    one<unknown>(client, "SELECT core.admin_action_propose($1, $2::jsonb, $3) AS r", [
      "payment_method.set",
      JSON.stringify({
        key: `payment_method.${c.method}`,
        method: c.method,
        enabled: c.enabled,
        displayOrder: c.displayOrder,
        perAttemptLimitPaise: c.perAttemptLimitPaise,
        perDayLimitPaise: c.perDayLimitPaise,
        maintenanceFrom: c.maintenanceFrom,
        maintenanceUntil: c.maintenanceUntil,
      }),
      input.reason,
    ]),
  );
}

export type { PaymentScenario };
