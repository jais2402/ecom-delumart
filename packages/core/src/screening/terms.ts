/**
 * Word lists for text screening (D). A STARTING LIST: short, obviously-bad or obviously-risky
 * terms only, to be extended by moderation. Every term is matched after the same normalisation
 * as the text (case, Unicode look-alikes, digit and symbol substitutions, repeated characters),
 * so write each term once, plainly, in lowercase.
 *
 * Match modes:
 *  - "word":      a whole word (or, for several words, the whole phrase), e.g. "upi";
 *  - "prefix":    a word that starts with the term, e.g. "rape" also catches "raped";
 *  - "substring": anywhere inside a word, e.g. "fuck" also catches "fucking".
 */
export type MatchMode = "word" | "prefix" | "substring";

export interface Term {
  term: string;
  match: MatchMode;
}

/** REJECT: asking to be paid outside DeluluMart. */
export const PAYMENT_TERMS: readonly Term[] = [
  { term: "upi", match: "word" },
  { term: "paytm", match: "substring" },
  { term: "gpay", match: "prefix" },
  { term: "google pay", match: "word" },
  { term: "phonepe", match: "substring" },
  { term: "bhim", match: "word" },
  { term: "neft", match: "word" },
  { term: "imps", match: "word" },
  { term: "rtgs", match: "word" },
  { term: "ifsc", match: "word" },
  { term: "bank transfer", match: "word" },
  { term: "pay me", match: "word" },
  { term: "send money", match: "word" },
  { term: "account number", match: "word" },
];

/** REJECT: slurs, sexual and violent terms. Deliberately short; obviously bad only. */
export const BLOCKED_TERMS: readonly Term[] = [
  { term: "fuck", match: "substring" },
  { term: "cunt", match: "substring" },
  { term: "nigger", match: "substring" },
  { term: "faggot", match: "substring" },
  { term: "porn", match: "substring" },
  { term: "rape", match: "prefix" },
  { term: "rapist", match: "word" },
  { term: "whore", match: "prefix" },
  { term: "slut", match: "prefix" },
  { term: "pedo", match: "word" },
  { term: "kill yourself", match: "word" },
  { term: "kys", match: "word" },
  { term: "chutiya", match: "prefix" },
  { term: "madarchod", match: "prefix" },
  { term: "behenchod", match: "prefix" },
];

/** NEEDS_REVIEW: words that make a listing sound official or institutional. */
export const OFFICIAL_TERMS: readonly Term[] = [
  { term: "official", match: "prefix" },
  { term: "verified", match: "word" },
  { term: "government", match: "prefix" },
  { term: "govt", match: "word" },
  { term: "ministry", match: "word" },
  { term: "bank", match: "word" },
  { term: "police", match: "word" },
  { term: "customer care", match: "word" },
  { term: "helpline", match: "word" },
  { term: "authorised", match: "word" },
  { term: "authorized", match: "word" },
  { term: "rbi", match: "word" },
];

/** NEEDS_REVIEW: real-brand-like names. */
export const BRAND_TERMS: readonly Term[] = [
  { term: "apple", match: "word" },
  { term: "iphone", match: "word" },
  { term: "google", match: "word" },
  { term: "amazon", match: "word" },
  { term: "flipkart", match: "word" },
  { term: "myntra", match: "word" },
  { term: "nike", match: "word" },
  { term: "adidas", match: "word" },
  { term: "samsung", match: "word" },
  { term: "sony", match: "word" },
  { term: "disney", match: "word" },
  { term: "netflix", match: "word" },
  { term: "gucci", match: "word" },
  { term: "zomato", match: "word" },
  { term: "swiggy", match: "word" },
  { term: "microsoft", match: "word" },
];

/** NEEDS_REVIEW: the softer watch list (scams, off-platform contact). */
export const WATCH_TERMS: readonly Term[] = [
  { term: "free money", match: "word" },
  { term: "giveaway", match: "word" },
  { term: "lottery", match: "word" },
  { term: "jackpot", match: "word" },
  { term: "crypto", match: "prefix" },
  { term: "bitcoin", match: "word" },
  { term: "guaranteed returns", match: "word" },
  { term: "investment", match: "word" },
  { term: "dm me", match: "word" },
  { term: "whatsapp", match: "word" },
  { term: "telegram", match: "word" },
  { term: "instagram", match: "word" },
  { term: "click here", match: "word" },
];

/** Store handles nobody may register (validateHandle; mirrored in the database). */
export const RESERVED_HANDLES: readonly string[] = [
  "admin",
  "support",
  "delulumart",
  "delulu",
  "staff",
  "official",
  "help",
  "system",
  "root",
  "moderator",
  "bank",
  "pay",
  "originals",
  "store",
  "shop",
  "www",
  "api",
  "account",
  "cart",
  "checkout",
  "orders",
  "console",
  "partner",
];

/**
 * Handle words (seventh security review, minor 4; eighth review, minor 4), for store and user
 * handles alike. Mirrored by core.handle_long_words(), core.handle_short_words(),
 * core.handle_adjacent_words() and core.handle_generic_words() (migration 0063).
 *
 * LONG protected words (the brand and authority words of six letters or more) are refused anywhere
 * in a handle in any confusable spelling, and also within one edit (or missing up to two final
 * letters) as the whole handle or a hyphen-separated part.
 */
export const LONG_PROTECTED_HANDLE_WORDS: readonly string[] = [
  "delulumart",
  "delulu",
  "official",
  "verified",
  "moderator",
  "superadmin",
  "administrator",
  "support",
  "security",
];

/**
 * SHORT protected words match only as a whole hyphen-separated part or the whole handle (a plural
 * `s` included), with digits before or after, or joined to another protected, generic or
 * ADJACENT word (`adminteam`, `staffsupport`) — never as an arbitrary substring, so `badminton`,
 * `mustafa` and `ecosystem` are ordinary handles.
 */
export const SHORT_PROTECTED_HANDLE_WORDS: readonly string[] = ["admin", "staff", "mod", "system"];

/** Every protected word (LONG and SHORT). */
export const PROTECTED_HANDLE_WORDS: readonly string[] = [
  ...LONG_PROTECTED_HANDLE_WORDS,
  ...SHORT_PROTECTED_HANDLE_WORDS,
];

/** GENERIC words: only refused as the whole handle (leading and trailing digits ignored). */
export const GENERIC_HANDLE_WORDS: readonly string[] = [
  "help",
  "root",
  "bank",
  "pay",
  "originals",
  "store",
  "shop",
  "www",
  "api",
  "account",
  "cart",
  "checkout",
  "orders",
  "console",
  "partner",
];

/**
 * Words that make a SHORT protected word next to them read as an authority name (`adminteam`,
 * `mysystem`, `staffpicks`), besides the protected and generic words themselves.
 */
export const ADJACENT_HANDLE_WORDS: readonly string[] = [
  "team",
  "desk",
  "crew",
  "hq",
  "ops",
  "info",
  "real",
  "the",
  "my",
  "care",
  "service",
  "office",
  "pick",
  "picks",
  "news",
];
