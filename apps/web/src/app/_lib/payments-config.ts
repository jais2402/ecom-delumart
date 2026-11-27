/**
 * Tunable numbers of the payment screens (CLAUDE.md invariant 10: no literals in feature code).
 * Presentation only: none of these is money or an authorisation. Client-safe (no server-only import).
 */
export const PAYMENT_UI_CONFIG = {
  /** How often the checkout re-reads the bank inbox while a bank step waits. */
  inboxPollMs: 2_500,
  /** The same on the Bank inbox page. */
  accountInboxPollMs: 4_000,
  /** The countdowns on the bank step tick this often. */
  tickMs: 1_000,
  /** Rows of the Payments list per page. */
  paymentsPageSize: 10,
  /** Asked to wait this long again when the server gives no time (a slow bank). */
  slowBankRetrySeconds: 5,
} as const;
