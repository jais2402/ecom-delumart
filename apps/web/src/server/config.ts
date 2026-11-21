import "./server-only";

/**
 * Tunable numbers of the web server (CLAUDE.md invariant 10: no literals in feature code). Money
 * and pricing configuration lives in the database (core.config_version) and @delulu/core, not here.
 */
export const SERVER_CONFIG = {
  pools: {
    /** app_web pool: read models and the session check. */
    webMax: 5,
    /** app_pay pool: money commands. */
    payMax: 5,
    /** Owner pool of the dev sign-in provider only. */
    ownerMax: 2,
    idleTimeoutMs: 10_000,
    connectionTimeoutMs: 5_000,
  },
  session: {
    /** Lifetime of a dev sign-in session (auth.sessions.not_after) and of the cookie. */
    ttlSeconds: 7 * 24 * 60 * 60,
  },
  csrf: {
    tokenBytes: 32,
  },
  rateLimit: {
    /** Per client IP. */
    devSignIn: { limit: 20, windowMs: 60_000 },
    /** Per session: PIN set, change, reset and payment PIN entry. */
    pin: { limit: 10, windowMs: 60_000 },
    /** Per session: dev phone codes requested. */
    phoneCode: { limit: 5, windowMs: 10 * 60_000 },
    /** Entries kept before expired windows are swept. */
    sweepAbove: 10_000,
  },
  phone: {
    /** The only code the dev provider accepts (there is no SMS in development). */
    devCode: "000000",
    /** Wrong codes before the pending number is discarded and a new code must be requested. */
    maxWrongCodes: 5,
  },
  identity: {
    /** "Today" for the adult check is the date in this zone. */
    timeZone: "Asia/Kolkata",
  },
  card: {
    /** Six digits beginning with 0 (LLD §5.4). */
    prefix: "042000",
    /** Candidate sequences offered to provisioning: 1..5. */
    firstSequence: 1,
    candidates: 5,
  },
  provision: {
    /** Tries with a fresh alias and DeluluPay id when the database answers BUSY. */
    attempts: 3,
  },
  http: {
    maxBodyBytes: 16 * 1024,
    pageSizeMax: 50,
    maxCartLines: 20,
    maxOverlayProducts: 100,
  },
  fieldEncryption: {
    /** Key id written in front of every ciphertext (LLD §5.6); FIELD_KEY is key 1. */
    currentKeyId: 1,
  },
} as const;
