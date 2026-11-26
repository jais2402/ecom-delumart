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
    /**
     * On Vercel (VERCEL=1) every function instance has its own pools, and many instances may run at
     * once against Supabase's transaction pooler: one or two connections each, released quickly.
     */
    serverless: { webMax: 2, payMax: 2, jobsMax: 1, idleTimeoutMs: 5_000 },
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
    /**
     * Sign-in emails requested per email address, counted only for requests that passed the
     * challenge (ninth review, major 2b): per (email, client network: IPv4 /24, IPv6 /64), and a
     * higher ceiling per email address from all networks together, so a stranger elsewhere cannot
     * cheaply use up the owner's own allowance.
     */
    signInEmailClient: { scope: "auth.sign_in.email.client", by: "email", limit: 5, windowSeconds: 3_600 },
    signInEmail: { scope: "auth.sign_in.email", by: "email", limit: 20, windowSeconds: 3_600 },
    /** Typed email sign-in codes checked: per (email, client network) and per email address. */
    signInCodeEmailClient: {
      scope: "auth.sign_in.code.email.client",
      by: "email",
      limit: 10,
      windowSeconds: 3_600,
    },
    signInCodeEmail: { scope: "auth.sign_in.code.email", by: "email", limit: 30, windowSeconds: 3_600 },
    /** Phone codes requested: per account (LLD: 5 / day / account) and per address. */
    phoneCodeActor: { scope: "phone.code.actor", by: "actor", limit: 5, windowSeconds: 86_400 },
    phoneCodeAddress: { scope: "phone.code.address", by: "address", limit: 30, windowSeconds: 3_600 },
    /**
     * New distinct numbers asked for from one client address per day (ninth review, major 1c; the
     * database also caps distinct numbers per account: 3 a day, 5 before onboarding completes). High
     * enough for many people behind one shared (carrier NAT) IPv4 address.
     */
    phoneNumberAddress: { scope: "phone.number.address", by: "address", limit: 100, windowSeconds: 86_400 },
    /**
     * Text messages to one destination number, across all accounts (ninth review, major 1d). The
     * subject is a keyed digest of the number, never the number.
     */
    phoneSmsDestinationHour: { scope: "phone.sms.dest.hour", by: "phone", limit: 3, windowSeconds: 3_600 },
    phoneSmsDestinationDay: { scope: "phone.sms.dest.day", by: "phone", limit: 5, windowSeconds: 86_400 },
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
    /**
     * Studio order and earnings reads per account (eighth review, minor 7): with minute-rounded
     * times and orders shown only once their minute has ended, polling learns nothing finer, and
     * this keeps a script from hammering the reads anyway. One budget for the list, the detail and
     * earnings.
     */
    studioReadActor: { scope: "studio.read.actor", by: "actor", limit: 30, windowSeconds: 60 },
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
    /** Review writes (create, edit, delete) per account (decisions.md #14). */
    reviewWriteActor: { scope: "reviews.write.actor", by: "actor", limit: 10, windowSeconds: 3_600 },
    /** The signed-in player's own review reads per account (the product page's private overlay). */
    reviewReadActor: { scope: "reviews.read.actor", by: "actor", limit: 120, windowSeconds: 60 },
    /** Blocks and unblocks per account. */
    blockActor: { scope: "blocks.write.actor", by: "actor", limit: 30, windowSeconds: 60 },
    /** Browser analytics events per client address (beyond it events are dropped, still 204). */
    eventsAddress: { scope: "analytics.events.address", by: "address", limit: 120, windowSeconds: 60 },
    /** Super Admin analytics reads per account (a dashboard makes several per view). */
    analyticsReadActor: { scope: "admin.analytics.actor", by: "actor", limit: 300, windowSeconds: 60 },
  },
  /** Supabase Auth (apps/web/src/server/auth/supabase.ts). */
  auth: {
    /** Lifetime of the sign-in flow cookie (state, PKCE verifier, return path): the email link's. */
    flowTtlSeconds: 15 * 60,
    /** Signing keys are re-read from the JWKS at least this often (a removed key stops working). */
    jwksTtlMs: 10 * 60 * 1000,
    /** An unknown key id triggers a re-read at most this often. */
    jwksMinRefetchMs: 30 * 1000,
    /** Every call to Supabase gives up after this long. */
    httpTimeoutMs: 5_000,
    /** Largest JWKS or Auth response body read. */
    maxResponseBytes: 64 * 1024,
    /** Largest access token accepted. */
    maxTokenBytes: 8 * 1024,
    /** Clock difference tolerated for exp, nbf and iat. */
    clockSkewSeconds: 30,
    /** Typed email sign-in codes: 6 to this many digits (Supabase's OTP length setting). */
    emailCodeMaxDigits: 10,
  },
  /** Cloudflare Turnstile (ninth review, major 2a; captcha.ts). */
  captcha: {
    /** The siteverify call gives up after this long (and the request is refused: fail closed). */
    timeoutMs: 5_000,
    /** Largest siteverify response read. */
    maxResponseBytes: 16 * 1024,
    /** Longest token accepted (Cloudflare documents at most 2048 characters). */
    tokenMaxChars: 2_048,
    /** A token older than this (challenge_ts) is refused; Cloudflare's own validity is 300 s. */
    tokenMaxAgeSeconds: 300,
    /** Tokens already presented are remembered (hashed, in core.rate_counter) for this long. */
    spentWindowSeconds: 600,
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
    /** Expired phone holds released per run (each is two or three Auth admin calls). */
    phoneHoldBatch: 20,
    /** The development-only inline run after a submission. */
    inlineBudgetMs: 5_000,
  },
  analytics: {
    /** Largest body POST /api/v1/events reads. */
    maxEventBytes: 1_024,
    /** Bytes of the HMAC kept as the visitor key (the database stores exactly 16). */
    visitorKeyBytes: 16,
    /** Bytes of the HMAC kept as the place key (address prefix only; the database stores exactly 8). */
    placeKeyBytes: 8,
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
