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
    /** app_jobs pool: the job runner. */
    jobsMax: 2,
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
  /**
   * Database fixed-window limits (LLD §11.2, migration 0031), each `limit` hits per `windowSeconds`
   * per subject: the client address ("address", see client-address.ts) or the signed-in user
   * ("actor"). Tests and local development may scale every limit with RATE_LIMIT_MULTIPLIER
   * (refused in production); these defaults are the production values.
   */
  rateLimit: {
    /** Sign-in attempts per client address. */
    signInAddress: { scope: "auth.sign_in.address", by: "address", limit: 20, windowSeconds: 60 },
    /** Phone codes requested: per account (LLD: 5 / day / account) and per address. */
    phoneCodeActor: { scope: "phone.code.actor", by: "actor", limit: 5, windowSeconds: 86_400 },
    phoneCodeAddress: { scope: "phone.code.address", by: "address", limit: 30, windowSeconds: 3_600 },
    /** Phone code verifications: per account and per address. */
    phoneVerifyActor: { scope: "phone.verify.actor", by: "actor", limit: 10, windowSeconds: 3_600 },
    phoneVerifyAddress: { scope: "phone.verify.address", by: "address", limit: 60, windowSeconds: 3_600 },
    /** PIN set, change, reset and payment PIN entry per account (the database also counts per card). */
    pinActor: { scope: "pin.actor", by: "actor", limit: 10, windowSeconds: 60 },
    /** Coupon code previews and applications per account (LLD: 10 / hour / account). */
    couponActor: { scope: "coupon.actor", by: "actor", limit: 10, windowSeconds: 3_600 },
    /** Cart additions, removals, clears and merges per account. */
    cartWriteActor: { scope: "cart.write.actor", by: "actor", limit: 60, windowSeconds: 60 },
    /** Checkout sessions created per account (LLD: purchase attempts 10 / minute / account). */
    checkoutActor: { scope: "checkout.create.actor", by: "actor", limit: 10, windowSeconds: 60 },
    /** Pay calls per account (LLD: purchase attempts 10 / minute / account). */
    payActor: { scope: "checkout.pay.actor", by: "actor", limit: 10, windowSeconds: 60 },
    /** Saves and unsaves per account. */
    saveWriteActor: { scope: "saves.write.actor", by: "actor", limit: 60, windowSeconds: 60 },
    /** Passport quiz answers and concept submissions per account. */
    passportActor: { scope: "passport.write.actor", by: "actor", limit: 20, windowSeconds: 60 },
    /** Relief claims per account (one succeeds per UTC day). */
    reliefActor: { scope: "relief.claim.actor", by: "actor", limit: 10, windowSeconds: 60 },
    /** Company quotes, registrations and store edits per account. */
    companyActor: { scope: "company.write.actor", by: "actor", limit: 10, windowSeconds: 60 },
    /** Company registration quotes per account (sixth review: 5 / hour; the database counts them too). */
    companyQuoteActor: { scope: "company.quote.actor", by: "actor", limit: 5, windowSeconds: 3_600 },
    /** Studio writes (drafts, submissions, prices, stock, shipping, Zap hub) per account. */
    studioActor: { scope: "studio.write.actor", by: "actor", limit: 30, windowSeconds: 60 },
    /** Super Admin moderation calls per account. */
    adminActor: { scope: "admin.write.actor", by: "actor", limit: 60, windowSeconds: 60 },
    /** Reports per account (LLD §11.2: 5 / hour / account; the database also counts committed reports). */
    reportActor: { scope: "reports.write.actor", by: "actor", limit: 5, windowSeconds: 3_600 },
    /** Address-book writes (add, edit, delete, default) per account (PRD R5.2). */
    addressWriteActor: { scope: "addresses.write.actor", by: "actor", limit: 30, windowSeconds: 60 },
    /** Address-book reads per account (each read decrypts on the server). */
    addressReadActor: { scope: "addresses.read.actor", by: "actor", limit: 120, windowSeconds: 60 },
    /** Checkout destination changes per account. */
    checkoutDestinationActor: {
      scope: "checkout.destination.actor",
      by: "actor",
      limit: 30,
      windowSeconds: 60,
    },
    /** Blocks and unblocks per account. */
    blockActor: { scope: "blocks.write.actor", by: "actor", limit: 30, windowSeconds: 60 },
    /** Browser analytics events per client address (beyond it events are dropped, still 204). */
    eventsAddress: { scope: "analytics.events.address", by: "address", limit: 120, windowSeconds: 60 },
    /** Super Admin analytics reads per account (a dashboard makes several per view). */
    analyticsReadActor: { scope: "admin.analytics.actor", by: "actor", limit: 300, windowSeconds: 60 },
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
    /** Birthdates more than this many years ago are refused as mistyped. */
    maxAgeYears: 120,
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
  jobs: {
    /** A signed jobs request is accepted for this long after its timestamp (and as far ahead). */
    signatureMaxAgeSeconds: 60,
    /** Default and largest time one run may spend (LLD §9: 45 s). */
    defaultBudgetMs: 45_000,
    maxBudgetMs: 45_000,
    /** Screenings read per batch. */
    screeningBatch: 20,
    /** The development-only inline run after a submission. */
    inlineBudgetMs: 5_000,
  },
  analytics: {
    /** Largest body POST /api/v1/events reads. */
    maxEventBytes: 1_024,
    /** Bytes of the HMAC kept as the visitor key (the database stores exactly 16). */
    visitorKeyBytes: 16,
    /** The longest user agent hashed into the visitor key. */
    maxUserAgentChars: 512,
    /** Rows of a top-N read when the request names no limit, and the most it may ask for. */
    topDefaultLimit: 10,
    topMaxLimit: 50,
  },
  fieldEncryption: {
    /** Key id written in front of every ciphertext (LLD §5.6); FIELD_KEY is key 1. */
    currentKeyId: 1,
  },
} as const;
