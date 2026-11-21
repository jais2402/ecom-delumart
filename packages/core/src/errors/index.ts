/** Stable error codes shared by API, tests and UI. Extend the list here only. */
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "CONFLICT",
  "NOT_FOUND",
  "FORBIDDEN",
  "RATE_LIMITED",
  "BUSY",
  "INSUFFICIENT_FUNDS",
  "CART_CHANGED",
  "PRICE_CHANGED",
  "SOLD_OUT",
  "ALREADY_OWNED",
  "SELF_PURCHASE",
  "COUPON_INVALID",
  "COUPON_NOT_APPLICABLE",
  "DELIVERY_UNAVAILABLE",
  "PIN_WEAK",
  "PIN_INCORRECT",
  "PIN_LOCKED",
  "PIN_NOT_SET",
  "CHALLENGE_LOCKED",
  "REAUTH_REQUIRED",
  "PHONE_REQUIRED",
  "UNDERAGE",
  "PHONE_INVALID",
  "PRODUCT_UNAVAILABLE",
  "CHECKOUT_EXPIRED",
  "PAYMENT_PENDING",
  "METHOD_UNAVAILABLE",
  "CARD_FROZEN",
  "CARD_REPLACED",
  "CARD_NOT_OWNED",
  "MERCHANT_NOT_ALLOWED",
  "MAINTENANCE",
  // API access (LLD §8.3): no live sign-in session; a phone code that did not verify
  "AUTH_REQUIRED",
  "PHONE_CODE_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
