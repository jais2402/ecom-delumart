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
  // cart (PRD R2.2): the cart already holds the configured maximum number of lines
  "CART_FULL",
  // selling side: onboarding not finished (no account yet)
  "ONBOARDING_REQUIRED",
  // creator access (US-04, US-05): the action needs the creator entitlement
  "CREATOR_LOCKED",
  // company registration (US-18): one company per person; a store handle in use or held by
  // another person's live registration quote
  "COMPANY_EXISTS",
  "HANDLE_TAKEN",
  "HANDLE_RESERVED",
  // relief grant: not claimable now (balance, already claimed today); lifetime cap reached
  "RELIEF_NOT_ELIGIBLE",
  "RELIEF_LIMIT",
  // player listings (US-08, US-29): the action needs a registered company; the studio's private
  // drafts or the store's published listings are at their cap; the warehouse has no room; the
  // listing is not in a state this change applies to; the store's submissions for the UTC day are
  // used up; publication is switched off
  "COMPANY_FEE_REQUIRED",
  "DRAFT_LIMIT",
  "PUBLISH_LIMIT",
  "CAPACITY_EXCEEDED",
  "NOT_EDITABLE",
  "SUBMISSION_LIMIT",
  "PUBLICATION_PAUSED",
  // trust and safety (§7.7): five reports per account per hour; one open report per reporter per
  // target; one appeal per moderation action; the listing has no moderation action to appeal
  "REPORT_LIMIT",
  "ALREADY_REPORTED",
  "APPEAL_EXISTS",
  "NOT_APPEALABLE",
  // merchant coupons (US-41): the company already has its maximum of active coupons
  "COUPON_LIMIT",
  // delivery addresses (PRD R5.2): not one of the actor's own saved addresses (another user's, a
  // deleted one or none); the actor already has the configured maximum of saved addresses
  "ADDRESS_NOT_FOUND",
  "ADDRESS_LIMIT",
  // bot protection (ninth review, major 2a): the Cloudflare Turnstile token was missing, already
  // used, for another action or host, or could not be checked (fail closed)
  "CAPTCHA_FAILED",
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
