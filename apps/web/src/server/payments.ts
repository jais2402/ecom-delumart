import "./server-only";
import {
  describeFailure,
  looksLikeRealPaymentData,
  PAYMENT_SCENARIOS,
  parseDeluluPayId,
  serializePaise,
} from "@delulu/core";
import type {
  AdminPaymentMethods,
  BankInboxMessage,
  CheckoutMethods,
  PaymentAttemptView,
  PaymentRow,
} from "@delulu/db/runtime";
import { z } from "zod";

/**
 * DeluluPay request schemas and response shapes (PRD R4, R10). Each view copies named fields only.
 * Money is a decimal string (invariant 1). The one view that carries a code is `inboxView` (the payer's
 * own bank inbox); no other response does. Request fields never take a card number, expiry, CVV, UPI PIN or
 * bank password (R4.5): the DeluluPay ID field refuses anything that looks like one, and a code is exactly
 * six digits.
 */

/** A typed DeluluPay ID: `name@delulu` only; anything that looks like real payment data is refused. */
export const delulupayIdSchema = z
  .string()
  .max(80)
  .refine((v) => !looksLikeRealPaymentData(v) && parseDeluluPayId(v).ok, {
    message: "DeluluPay IDs end in @delulu.",
  });

export const attemptBody = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("BALANCE"), scenario: z.enum(PAYMENT_SCENARIOS).optional() }),
  z.strictObject({
    method: z.literal("CARD"),
    cardId: z.uuid(),
    scenario: z.enum(PAYMENT_SCENARIOS).optional(),
  }),
  z.strictObject({ method: z.literal("NET_BANKING"), scenario: z.enum(PAYMENT_SCENARIOS).optional() }),
  z.strictObject({
    method: z.literal("DELULUPAY_ID"),
    delulupayId: delulupayIdSchema,
    scenario: z.enum(PAYMENT_SCENARIOS).optional(),
  }),
]);

/** A code is exactly six digits; a decision is approve or decline. Nothing else is read. */
export const verifyBody = z.union([
  z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
  z.strictObject({ decision: z.enum(["APPROVE", "DECLINE"]) }),
]);

export const paymentsQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]{8,15}Z\|[0-9a-f-]{36}$/)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional(),
});

export function attemptView(a: PaymentAttemptView) {
  const reason = a.failureCode === null ? null : describeFailure(a.failureCode);
  return {
    id: a.id,
    sessionId: a.sessionId,
    reference: a.reference,
    method: a.method,
    status: a.status,
    failureCode: a.failureCode,
    failureTitle: reason?.title ?? null,
    failureMessage: reason?.message ?? null,
    authenticated: a.authenticated,
    amountPaise: serializePaise(a.amountPaise),
    bankAlias: a.bankAlias,
    delulupayId: a.delulupayId,
    sessionExpiresAt: a.sessionExpiresAt,
    createdAt: a.createdAt,
    challenge: a.challenge ?? null,
  };
}

export function paymentRowView(p: PaymentRow) {
  const reason = p.failureCode === null ? null : describeFailure(p.failureCode);
  return {
    id: p.id,
    reference: p.reference,
    method: p.method,
    status: p.status,
    failureCode: p.failureCode,
    failureTitle: reason?.title ?? null,
    failureMessage: reason?.message ?? null,
    amountPaise: serializePaise(p.amountPaise),
    createdAt: p.createdAt,
    orderGroupId: p.orderGroupId,
  };
}

/** The bank inbox: the only view that carries a code, and only while the message is open. */
export function inboxView(m: BankInboxMessage) {
  return {
    id: m.id,
    kind: m.kind,
    attemptId: m.attemptId,
    sessionId: m.sessionId,
    reference: m.reference,
    amountPaise: serializePaise(m.amountPaise),
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    availableAt: m.availableAt,
    status: m.status,
    ...(m.code === undefined ? {} : { code: m.code }),
  };
}

export function methodsView(m: CheckoutMethods) {
  return {
    scenariosAllowed: m.scenariosAllowed,
    methods: m.methods.map((x) => ({
      method: x.method,
      displayOrder: x.displayOrder,
      available: x.available,
      reason: x.reason ?? null,
      maintenanceUntil: x.maintenanceUntil ?? null,
      perAttemptLimitPaise: x.perAttemptLimitPaise === null ? null : serializePaise(x.perAttemptLimitPaise),
      perDayLimitPaise: x.perDayLimitPaise === null ? null : serializePaise(x.perDayLimitPaise),
    })),
  };
}

export function adminMethodsView(m: AdminPaymentMethods) {
  return {
    serverNow: m.serverNow,
    delaySeconds: m.delaySeconds,
    methods: m.methods.map((x) => ({
      method: x.method,
      version: x.version,
      enabled: x.enabled,
      switchOn: x.switchOn,
      displayOrder: x.displayOrder,
      perAttemptLimitPaise: x.perAttemptLimitPaise,
      perDayLimitPaise: x.perDayLimitPaise,
      maintenanceFrom: x.maintenanceFrom,
      maintenanceUntil: x.maintenanceUntil,
      inMaintenance: x.inMaintenance,
      available: x.available,
      pendingActionId: x.pendingActionId,
    })),
  };
}

/** POST body of a payment method change (Super Admin). Limits are decimal paise strings or null. */
export const methodChangeBody = z.strictObject({
  method: z.enum(["CARD", "DELULUPAY_ID", "NET_BANKING", "BALANCE"]),
  enabled: z.boolean(),
  displayOrder: z.number().int().min(1).max(99),
  perAttemptLimitPaise: z
    .string()
    .regex(/^[1-9]\d{0,13}$/)
    .nullable(),
  perDayLimitPaise: z
    .string()
    .regex(/^[1-9]\d{0,13}$/)
    .nullable(),
  maintenanceFrom: z.iso.datetime({ offset: true }).nullable(),
  maintenanceUntil: z.iso.datetime({ offset: true }).nullable(),
  reason: z.string().max(1_000),
});
