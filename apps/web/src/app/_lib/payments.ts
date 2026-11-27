/**
 * DeluluPay in the browser: the shapes of the payment API answers and the small pure helpers the
 * checkout and the Payments page share (PRD R4, R3). Money is a decimal string until it is shown.
 * Nothing here stores a code: the bank inbox is read from the server and kept in memory only.
 */
import { describeFailure, METHOD_LABELS, type PaymentDisplayStatus, type PaymentMethod } from "@delulu/core";
import { ApiError } from "./api";

export interface InboxMessage {
  id: string;
  kind: "CODE" | "APPROVAL";
  attemptId: string;
  sessionId: string;
  reference: string;
  amountPaise: string;
  createdAt: string;
  expiresAt: string;
  availableAt: string | null;
  status: "OPEN" | "USED" | "EXPIRED" | "CLOSED";
  /** Present only while a CODE message is open. */
  code?: string;
}

export interface PaymentRowResponse {
  id: string;
  reference: string;
  method: PaymentMethod;
  status: PaymentDisplayStatus;
  failureCode: string | null;
  failureTitle: string | null;
  failureMessage: string | null;
  amountPaise: string;
  createdAt: string;
  orderGroupId: string | null;
}

export interface PaymentMethodOffer {
  method: PaymentMethod;
  displayOrder: number;
  available: boolean;
  reason: "OFF" | "MAINTENANCE" | null;
  maintenanceUntil: string | null;
  perAttemptLimitPaise: string | null;
  perDayLimitPaise: string | null;
}

export interface PaymentMethodsResponse {
  scenariosAllowed: boolean;
  methods: PaymentMethodOffer[];
}

export const methodLabel = (method: string): string =>
  (METHOD_LABELS as Record<string, string>)[method] ?? "Payment";

/** Badge tone of a displayed status. */
export function statusTone(status: PaymentDisplayStatus): "success" | "danger" | "info" | "warning" {
  switch (status) {
    case "CAPTURED":
      return "success";
    case "FAILED":
      return "danger";
    case "REFUNDED":
      return "info";
    default:
      return "warning";
  }
}

/** Why a method cannot be picked right now, in words the player can act on. */
export function unavailableText(offer: PaymentMethodOffer, formatTime: (iso: string) => string): string {
  if (offer.reason === "MAINTENANCE") {
    return offer.maintenanceUntil
      ? `Bank maintenance until ${formatTime(offer.maintenanceUntil)}. Try another method.`
      : "Bank maintenance. Try another method.";
  }
  return "Switched off for now. Try another method.";
}

/** The wording for a stored failure code (the Payments page and the checkout notices). */
export const failureText = (code: string | null): { title: string; message: string } => describeFailure(code);

/** Text under the code field after a wrong code; says how many tries are left and that nothing moved. */
export function wrongCodeText(err: unknown): string {
  const left = err instanceof ApiError ? err.details.remainingTries : undefined;
  if (typeof left === "number") {
    return `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left. No fictional money moved.`;
  }
  return "That code is not right. No fictional money moved.";
}

/** Whole seconds from now until `iso` (never negative). */
export function secondsUntil(iso: string | number, now: number): number {
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** `m:ss` for a countdown. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
