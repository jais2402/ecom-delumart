/**
 * Text screening (D): pure, deterministic checks the web server runs on user text before it is
 * stored (invention concepts, store names, handles and descriptions). The database never sees the
 * text's screening detail, only the verdict the server passes on (see the passport and company
 * functions), and enforces formats and lengths itself.
 *
 *   REJECT        links or domains, email addresses, phone-number-like digit runs, payment
 *                 solicitation, blocked terms;
 *   NEEDS_REVIEW  official-sounding or real-brand-like words, excessive capitals, the watch list;
 *   OK            otherwise.
 *
 * Matching runs on a normalised form: Unicode compatibility forms (full-width letters and
 * digits), case, accents, Cyrillic and Greek look-alikes, digit and symbol substitutions
 * (0→o, 1→i, @→a, ...), repeated characters ("paaay" → "pay") and spaced-out letters
 * ("u p i", "u.p.i", "g-pay").
 */
import {
  BLOCKED_TERMS,
  BRAND_TERMS,
  GENERIC_HANDLE_WORDS,
  OFFICIAL_TERMS,
  PAYMENT_TERMS,
  PROTECTED_HANDLE_WORDS,
  type Term,
  WATCH_TERMS,
} from "./terms";

export { GENERIC_HANDLE_WORDS, PROTECTED_HANDLE_WORDS, RESERVED_HANDLES } from "./terms";

export type ScreenVerdict = "OK" | "NEEDS_REVIEW" | "REJECT";
export type ScreenCode =
  | "LINK"
  | "EMAIL"
  | "PHONE"
  | "PAYMENT"
  | "BLOCKED_TERM"
  | "OFFICIAL"
  | "BRAND"
  | "CAPS"
  | "WATCH";

export interface ScreenReason {
  field: string;
  code: ScreenCode;
}

export interface ScreenResult {
  verdict: ScreenVerdict;
  reasons: ScreenReason[];
}

const REJECT_CODES: ReadonlySet<ScreenCode> = new Set(["LINK", "EMAIL", "PHONE", "PAYMENT", "BLOCKED_TERM"]);

/** Tunables of the screening rules (CLAUDE.md invariant 10). */
export const SCREENING_CONFIG = {
  /** Digits (with separators between them) that make a run phone-number-like. */
  phoneDigitsMin: 10,
  /** Excessive capitals: at least this many letters, of which at least this share upper case. */
  capsMinLetters: 8,
  capsShareTenths: 7,
  /** Most masked characters ("f*ck") expanded per word. */
  maxWildcards: 2,
} as const;

// ------------------------------------------------------------------ normalisation

/** Cyrillic and Greek letters that look like Latin ones (lower case). */
const LOOKALIKES: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ɡ: "g",
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  ς: "s",
  σ: "s",
};

/** Digit and symbol substitutions, and letters merged with their look-alikes, for matching only. */
const SUBSTITUTIONS: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
  l: "i",
};

function mapChars(s: string, table: Readonly<Record<string, string>>): string {
  let out = "";
  for (const ch of s) out += table[ch] ?? ch;
  return out;
}

/** Compatibility forms, lower case, no accents, Latin look-alikes. Repeats kept. */
function baseForm(text: string): string {
  const lower = text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return mapChars(lower, LOOKALIKES);
}

const collapseRepeats = (s: string): string => s.replace(/(.)\1+/gu, "$1");

/** The normalised text: compatibility forms, case, accents, look-alikes and repeated characters. */
export function normaliseForScreening(text: string): string {
  return collapseRepeats(baseForm(text));
}

/** The matching form: the normalised text with digit and symbol substitutions applied too. */
function skeleton(text: string): string {
  return collapseRepeats(mapChars(baseForm(text), SUBSTITUTIONS));
}

interface Tokens {
  /** Every candidate word: split on punctuation, joined across inner punctuation, spaced-out letters merged. */
  words: Set<string>;
  /** The words split on anything but letters and digits, space separated, padded: " pay me ". */
  phrase: string;
}

function tokens(text: string): Tokens {
  const sk = skeleton(text);
  const split = sk.split(/[^\p{L}\p{N}*]+/u).filter((w) => w.length > 0);
  const joined = sk
    .split(/\s+/u)
    .map((w) => w.replace(/[^\p{L}\p{N}*]+/gu, ""))
    .filter((w) => w.length > 0);
  // runs of two or more single characters ("u p i", "f u c k") read as one word
  const merged: string[] = [];
  let run = "";
  for (const w of split) {
    if (w.length === 1) run += w;
    else {
      if (run.length >= 2) merged.push(collapseRepeats(run));
      run = "";
    }
  }
  if (run.length >= 2) merged.push(collapseRepeats(run));
  const words = new Set<string>();
  for (const w of [...split, ...joined, ...merged]) for (const v of expandWildcards(w)) words.add(v);
  return { words, phrase: ` ${split.join(" ")} ` };
}

/** "f*ck" → the word with each '*' (at most a few) replaced by each vowel. */
function expandWildcards(word: string): string[] {
  const stars = [...word].filter((c) => c === "*").length;
  if (stars === 0) return [word];
  if (stars > SCREENING_CONFIG.maxWildcards) return [word.replaceAll("*", "")];
  let out = [word];
  for (let i = 0; i < stars; i++) {
    out = out.flatMap((w) => ["a", "e", "i", "o", "u"].map((v) => w.replace("*", v)));
  }
  return out;
}

interface PreparedTerm {
  term: string;
  match: Term["match"];
  phrase: boolean;
}

function prepare(list: readonly Term[]): PreparedTerm[] {
  return list.map((t) => {
    const term = skeleton(t.term);
    return { term, match: t.match, phrase: term.includes(" ") };
  });
}

const PAYMENT = prepare(PAYMENT_TERMS);
const BLOCKED = prepare(BLOCKED_TERMS);
const OFFICIAL = prepare(OFFICIAL_TERMS);
const BRAND = prepare(BRAND_TERMS);
const WATCH = prepare(WATCH_TERMS);

function matchesAny(t: Tokens, list: readonly PreparedTerm[]): boolean {
  return list.some((p) => {
    if (p.phrase) return t.phrase.includes(` ${p.term} `);
    for (const w of t.words) {
      if (
        p.match === "word" ? w === p.term : p.match === "prefix" ? w.startsWith(p.term) : w.includes(p.term)
      )
        return true;
    }
    return false;
  });
}

// ------------------------------------------------------------------ structural detectors

const TLD = "(?:com|in|net|org|io|co|xyz|app|me|ly|gg|shop|store|info|biz|online|site|link)";
const LINK_PATTERNS: readonly RegExp[] = [
  /https?:\/\//u,
  /\bwww\s*\./u,
  new RegExp(`[a-z0-9-]+\\.${TLD}\\b`, "u"),
  new RegExp(`[a-z0-9-]+\\s*(?:\\(dot\\)|\\[dot\\]|\\{dot\\}|\\sdot\\s)\\s*${TLD}\\b`, "u"),
];

const EMAIL_PATTERNS: readonly RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/u,
  /[a-z0-9._%+-]+\s*@\s*(?:gmail|yahoo|outlook|hotmail|proton|rediff)/u,
  /[a-z0-9._%+-]+\s*(?:\(at\)|\[at\]|\{at\})\s*[a-z0-9-]{2,}/u,
];

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

function phoneLike(base: string): boolean {
  const digitsOnly = base.replace(/\p{L}+/gu, (w) => DIGIT_WORDS[w] ?? "|");
  for (const m of digitsOnly.matchAll(/\d[\d\s\-().+/]*/gu)) {
    if (m[0].replace(/\D/gu, "").length >= SCREENING_CONFIG.phoneDigitsMin) return true;
  }
  return false;
}

function excessiveCaps(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const upper = text.match(/\p{Lu}/gu)?.length ?? 0;
  return (
    letters >= SCREENING_CONFIG.capsMinLetters && upper * 10 >= letters * SCREENING_CONFIG.capsShareTenths
  );
}

/** The codes one piece of text triggers, in a fixed order. */
function screenOne(text: string): ScreenCode[] {
  if (text.trim() === "") return [];
  const base = baseForm(text);
  const t = tokens(text);
  const codes: ScreenCode[] = [];
  if (LINK_PATTERNS.some((r) => r.test(base))) codes.push("LINK");
  if (EMAIL_PATTERNS.some((r) => r.test(base))) codes.push("EMAIL");
  if (phoneLike(base)) codes.push("PHONE");
  if (matchesAny(t, PAYMENT)) codes.push("PAYMENT");
  if (matchesAny(t, BLOCKED)) codes.push("BLOCKED_TERM");
  if (matchesAny(t, OFFICIAL)) codes.push("OFFICIAL");
  if (matchesAny(t, BRAND)) codes.push("BRAND");
  if (excessiveCaps(text)) codes.push("CAPS");
  if (matchesAny(t, WATCH)) codes.push("WATCH");
  return codes;
}

/**
 * Screens every field. REJECT if any field triggers a reject rule, NEEDS_REVIEW if any triggers a
 * review rule, OK otherwise; `reasons` lists each (field, code) once.
 */
export function screenText(fields: Readonly<Record<string, string>>): ScreenResult {
  const reasons: ScreenReason[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (typeof text !== "string") continue;
    for (const code of screenOne(text)) reasons.push({ field, code });
  }
  const verdict: ScreenVerdict = reasons.some((r) => REJECT_CODES.has(r.code))
    ? "REJECT"
    : reasons.length > 0
      ? "NEEDS_REVIEW"
      : "OK";
  return { verdict, reasons };
}

// ------------------------------------------------------------------ handles and names

export type HandleProblem =
  | "TOO_SHORT"
  | "TOO_LONG"
  | "BAD_CHARACTERS"
  | "HYPHEN_EDGE"
  | "DOUBLE_HYPHEN"
  | "RESERVED";

export const HANDLE_RULES = { minChars: 3, maxChars: 24 } as const;
export const STORE_NAME_RULES = { minChars: 3, maxChars: 40 } as const;
export const STORE_DESCRIPTION_MAX_CHARS = 280;

/** Look-alike characters folded to the letter they imitate (sixth security review, minor 6). */
const HANDLE_FOLD: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "l",
  i: "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
};

function foldWith(handle: string, rnAsM: boolean): string {
  let s = handle.toLowerCase().replaceAll("-", "");
  if (rnAsM) s = s.replaceAll("rn", "m");
  let out = "";
  for (const ch of s) out += HANDLE_FOLD[ch] ?? ch;
  return out.replace(/(.)\1+/gu, "$1");
}

/**
 * The confusable-folded form of a handle: lower case, hyphens removed, `rn` read as `m`, then
 * 0→o, 1/i/l→l, 3→e, 4→a, 5→s, 7→t, 8→b, and runs of one letter collapsed to one (`dellulu` →
 * `delulu`). Mirrored by core.handle_fold in the database (0056).
 */
export function foldHandle(handle: string): string {
  return foldWith(handle, true);
}

const folded = (words: readonly string[], rnAsM: boolean) => words.map((w) => foldWith(w, rnAsM));
const FOLDS = [true, false].map((rnAsM) => ({
  rnAsM,
  protectedWords: folded(PROTECTED_HANDLE_WORDS, rnAsM),
  genericWords: new Set(folded(GENERIC_HANDLE_WORDS, rnAsM)),
}));

/** Whether a protected (brand or authority) word appears anywhere in the handle, in any spelling. */
export function hasProtectedHandleWord(handle: string): boolean {
  return FOLDS.some((f) => {
    const h = foldWith(handle, f.rnAsM);
    return f.protectedWords.some((w) => h.includes(w));
  });
}

/**
 * Whether a handle imitates a reserved one (seventh security review, minor 4): a protected word
 * appears anywhere in its folded form (`deluluofficial`, `adrnin`, `admin1`), or its folded form,
 * without any number of its leading and trailing digits, is a generic word (`5h0p`, `shop1`). `rn` is read
 * both as `m` and as itself, so neither reading can hide a word. Mirrored by core.handle_lookalike.
 */
export function isLookalikeHandle(handle: string): boolean {
  if (hasProtectedHandleWord(handle)) return true;
  // the handle without any number of its leading and of its trailing digits (a digit may itself
  // spell a letter: `roo7` is `root`, so `roo70` is tried as `roo7` too)
  const lead = /^[0-9-]*/.exec(handle)?.[0].length ?? 0;
  const trail = /[0-9-]*$/.exec(handle)?.[0].length ?? 0;
  for (let i = 0; i <= lead; i++) {
    for (let j = 0; j <= trail && i + j <= handle.length; j++) {
      const core = handle.slice(i, handle.length - j);
      if (FOLDS.some((f) => f.genericWords.has(foldWith(core, f.rnAsM)))) return true;
    }
  }
  return false;
}

/**
 * A store handle: 3–24 of a–z, 0–9 and hyphen; no leading, trailing or double hyphen; not reserved
 * and not a look-alike of a reserved handle (isLookalikeHandle). User handles follow the same
 * look-alike rule (core.update_profile).
 */
export function validateHandle(
  handle: string,
): { ok: true; value: string } | { ok: false; code: HandleProblem } {
  const n = [...handle].length;
  if (n < HANDLE_RULES.minChars) return { ok: false, code: "TOO_SHORT" };
  if (n > HANDLE_RULES.maxChars) return { ok: false, code: "TOO_LONG" };
  if (!/^[a-z0-9-]+$/.test(handle)) return { ok: false, code: "BAD_CHARACTERS" };
  if (handle.startsWith("-") || handle.endsWith("-")) return { ok: false, code: "HYPHEN_EDGE" };
  if (handle.includes("--")) return { ok: false, code: "DOUBLE_HYPHEN" };
  if (isLookalikeHandle(handle)) return { ok: false, code: "RESERVED" };
  return { ok: true, value: handle };
}

export type NameProblem = "TOO_SHORT" | "TOO_LONG" | "CONTROL_CHARACTERS";

/** A store's display name: 3–40 characters after trimming, no control characters. */
export function validateStoreName(
  name: string,
): { ok: true; value: string } | { ok: false; code: NameProblem } {
  const value = name.trim();
  if (/\p{Cc}/u.test(value)) return { ok: false, code: "CONTROL_CHARACTERS" };
  const n = [...value].length;
  if (n < STORE_NAME_RULES.minChars) return { ok: false, code: "TOO_SHORT" };
  if (n > STORE_NAME_RULES.maxChars) return { ok: false, code: "TOO_LONG" };
  return { ok: true, value };
}
